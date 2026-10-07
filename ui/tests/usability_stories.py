"""Simulated user-story walkthroughs; no visible windows or human-study claims.

Requires a running proxy (`node proxy/server.mjs`) and Python Playwright.
Optional URL argument defaults to http://127.0.0.1:8903/.
"""
import json
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8903/"
root = Path(__file__).resolve().parents[1]
output = Path("/tmp/opencode/sensehub-usability")
output.mkdir(exist_ok=True)
findings = []

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=True)
    try:
        desktop = browser.new_context(viewport={"width": 1440, "height": 1100}, accept_downloads=True)
        page = desktop.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(url)
        page.wait_for_function("!!window.sensehubLab")
        # Story 1: keyboard-only bit/char import, explicit units and unknowns.
        page.keyboard.press("Alt+a")
        assert page.evaluate("document.activeElement.id") == "channel-name"
        page.keyboard.press("Control+a"); page.keyboard.type("Keyboard trigger")
        page.keyboard.press("Tab")
        assert page.evaluate("document.activeElement.id") == "channel-kind"
        page.keyboard.press("Tab"); page.keyboard.press("Control+a"); page.keyboard.type("1000")
        page.keyboard.press("Tab"); page.keyboard.press("Control+a"); page.keyboard.type('["0","1",null,"0"]')
        page.keyboard.press("Tab"); page.keyboard.press("Tab")
        assert page.evaluate("document.activeElement.textContent") == "Add channel"
        page.keyboard.press("Enter")
        assert page.locator(".channel-card").count() == 1
        assert "75.0% coverage" in page.locator(".channel-meta").inner_text()
        findings.append({"story":"Keyboard-only char import", "result":"passed", "evidence":"Alt+A, Tab traversal, Enter submission; unknown excluded from coverage"})
        # Story 2: reproducible script loaded from file, retained sources and synced controls.
        page.locator("#session-file").set_input_files(str(root / "examples/optical-bench.sensehub"))
        assert page.locator(".channel-card").count() == 3
        contact = page.locator('[data-channel="contact"]')
        contact.locator("summary").click()
        assert contact.locator('input[type="number"]').input_value() == "2"
        assert "2 rising / 2 falling" in contact.locator(".channel-meta").inner_text()
        page.locator("#command-console summary").click()
        page.locator(".channel-lab").screenshot(path=str(output / "desktop-channel-lab.png"))
        contact.screenshot(path=str(output / "debounced-contact.png"))
        optical = page.locator('[data-channel="optical"]')
        optical.screenshot(path=str(output / "numeric-original-and-derived.png"))
        findings.append({"story":"Load optical/contact script", "result":"passed", "evidence":"Both channels loaded; 2 ms debounce restored; numeric source retained separately"})
        # Story 3: common zoom, mouse inspection and keyboard stepping.
        page.locator("#time-window").select_option("10000")
        contact.locator("canvas").hover(position={"x": 220, "y": 40})
        assert "derived" in contact.locator(".channel-inspect").inner_text()
        contact.locator("canvas").focus(); page.keyboard.press("End")
        assert "9.999 ms" in contact.locator(".channel-inspect").inner_text()
        contact.screenshot(path=str(output / "zoomed-contact.png"))
        # Hidden trace really disappears; HTML hidden must beat canvas CSS.
        contact.locator('.channel-card-header input[type="checkbox"]').first.uncheck()
        assert not contact.locator("canvas").is_visible()
        contact.locator('.channel-card-header input[type="checkbox"]').first.check()
        findings.append({"story":"Mouse and keyboard time inspection", "result":"passed", "evidence":"10 ms view, precise End position, hide/show affects rendered canvas"})
        # Story 4: invalid scripts do not mutate earlier channels.
        before = page.locator(".channel-card").count()
        page.keyboard.press("Control+k")
        page.keyboard.press("Control+a")
        page.keyboard.type('add {"schemaVersion":1,"id":"should-not-exist","name":"X","kind":"digital","stage":"raw","data":{"encoding":"bits","intervalUs":1,"values":"01"}}\nprocess missing {"invert":true}')
        page.keyboard.press("Control+Enter")
        assert page.locator(".channel-card").count() == before
        assert "Unknown channel missing" in page.locator("#console-output").inner_text()
        findings.append({"story":"Bad script recovery", "result":"passed", "evidence":"Validation prevents partial import; source session remains intact"})
        # Story 5: saved digital session restores recipe and original observations.
        with page.expect_download() as download_event:
            page.locator("#save-session").click()
        download = download_event.value
        session_path = output / "saved-session.json"; download.save_as(str(session_path))
        session = json.loads(session_path.read_text())
        assert len(session["channels"]) == 3
        assert session["channels"][1]["processing"]["debounceUs"] == 2000
        assert len(session["channels"][1]["source"]["data"]["points"]) == 31
        restored = desktop.new_page(); restored.goto(url)
        restored.locator("#session-file").set_input_files(str(session_path))
        assert restored.locator(".channel-card").count() == 3
        findings.append({"story":"Session save/reopen", "result":"passed", "evidence":"Original 31 observations and debounce recipe restored, not just the processed trace"})
        # Story 6: generic capabilities, mode-relevant fields and no physical-connection claim.
        page.locator(".device-setup summary").click()
        assert page.locator("#device-pin option").count() == 2
        page.locator("#device-mode").select_option("pwm")
        assert not page.locator("#device-debounce").is_visible()
        assert page.locator("#device-frequency").is_visible()
        page.evaluate('''() => sensehubLab.receiveCapabilities({schemaVersion:1,profile:"S3 simulated capability fixture",soc:"ESP32-S3",channelIds:[8,9],availablePins:[4,38],outputPins:[38],noPullPins:[],modes:["digital-input","digital-output"],transportSupport:{wifi:true,bluetoothSpp:false}})''')
        page.locator("#device-mode").select_option("output")
        assert page.locator("#device-pin").input_value() == "38"
        assert page.locator('#device-mode option[value="pwm"]').evaluate("option => option.disabled")
        page.locator(".device-setup").screenshot(path=str(output / "capability-driven-device-controls.png"))
        findings.append({"story":"Different board capability fixture", "result":"passed", "evidence":"GPIO38 output offered; unavailable PWM disabled; no live connection implied"})
        # Story 7: proxy branches publish; independent consumer reads unmodified originals.
        page.locator("#proxy-drawer summary").click()
        page.locator("#proxy-url").fill(url.rstrip('/'))
        page.locator("#proxy-publish").click()
        page.wait_for_function("document.querySelector('#proxy-status').textContent.startsWith('Published')")
        original = page.request.get(url.rstrip('/') + "/api/channels/contact?branch=raw").json()
        derived = page.request.get(url.rstrip('/') + "/api/channels/contact?branch=processed").json()
        assert len(original["raw"]["data"]["points"]) == 31
        assert len(derived["processed"]["data"]["points"]) < 31
        subscriber = desktop.new_page(); subscriber.goto(url)
        subscriber.locator("#proxy-drawer summary").click()
        subscriber.locator("#proxy-url").fill(url.rstrip('/'))
        subscriber.locator("#proxy-subscribe").click()
        subscriber.wait_for_function("document.querySelectorAll('.channel-card').length === 6")
        subscriber.locator("#proxy-disconnect").click()
        page.locator("#proxy-drawer").screenshot(path=str(output / "proxy-publish-controls.png"))
        findings.append({"story":"Proxy original + processed, independent subscriber", "result":"passed", "evidence":"Original observations preserved; separate processed branch; another page receives both"})
        # Story 8: tablet touch and narrow viewport. No mouse emulation for tap actions.
        tablet = browser.new_context(viewport={"width": 768, "height": 1024}, has_touch=True, is_mobile=True, device_scale_factor=1)
        touch = tablet.new_page(); touch.goto(url)
        touch.locator("#channel-demo").tap()
        assert touch.locator(".channel-card").count() == 2
        touch.locator(".channel-card").first.locator("summary").tap()
        touch.locator(".channel-card").first.locator('input[type="number"]').fill("2")
        touch.locator(".channel-card").first.get_by_role("button", name="Apply to derived trace").tap()
        touch.locator(".channel-card").first.locator("canvas").tap(position={"x":200,"y":35})
        assert "derived" in touch.locator(".channel-inspect").first.inner_text()
        assert touch.evaluate("document.documentElement.scrollWidth <= innerWidth")
        touch.locator(".channel-lab").screenshot(path=str(output / "tablet-touch-channel-lab.png"))
        sizes = touch.locator("button, .file, select").evaluate_all("elements => elements.filter(e => e.getBoundingClientRect().height > 0).map(e => ({label:e.textContent.trim().slice(0,45),height:e.getBoundingClientRect().height}))")
        assert all(size["height"] >= 44 for size in sizes), sizes
        touch.set_viewport_size({"width":390,"height":844})
        assert touch.evaluate("document.documentElement.scrollWidth <= innerWidth")
        touch.locator(".channel-lab").screenshot(path=str(output / "phone-390-channel-lab.png"))
        findings.append({"story":"Tablet touch and phone layout", "result":"passed", "evidence":"Tap add/process/inspect, no horizontal overflow at 768/390 px; visible button/select/file targets ≥44 px"})
        assert not errors, errors
        (output / "findings.json").write_text(json.dumps({"method":"Simulated tasks + heuristic interpretation review, not a human usability study", "stories":findings}, indent=2))
        print(f"{len(findings)} user-story walkthroughs passed. Screenshots and findings: {output}")
    finally:
        browser.close()
