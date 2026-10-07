"""Optional headless integration checks. Requires Python Playwright + Chromium.

Run: python3 ui/tests/browser_smoke.py
No visible windows; HTTP server is an in-process thread on loopback port 0.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import io
import wave

from playwright.sync_api import sync_playwright


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


root = Path(__file__).resolve().parents[1]
server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(root)))
thread = Thread(target=server.serve_forever, daemon=True)
thread.start()
errors = []
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=True)
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 1200})
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(f"http://127.0.0.1:{server.server_port}/")
            page.wait_for_function("document.querySelector('#source-name').textContent.includes('Synthetic')")
            readout = page.locator("#formants")
            assert "Center:" in readout.inner_text()
            assert "Search:" in readout.inner_text()
            assert "−3 dB:" in readout.inner_text()
            original = page.locator("#spectrum").screenshot()
            page.locator('[data-pref="centers"]').uncheck()
            assert "Center:" not in readout.inner_text()
            assert "Search:" in readout.inner_text() and "−3 dB:" in readout.inner_text()
            assert original != page.locator("#spectrum").screenshot()
            page.locator('[data-pref="ranges"]').uncheck()
            assert "Search:" not in readout.inner_text()
            assert "−3 dB:" in readout.inner_text()
            page.locator('[data-pref="bandwidth"]').uncheck()
            assert "−3 dB:" not in readout.inner_text()
            # Preferences survive reload; all can be restored separately.
            page.reload()
            page.wait_for_function("document.querySelector('#formants').children.length === 3")
            for key in ("centers", "ranges", "bandwidth"):
                assert not page.locator(f'[data-pref="{key}"]').is_checked()
                page.locator(f'[data-pref="{key}"]').check()
            page.locator('[data-pref="octaves"]').check()
            assert not page.locator('[data-pref="notes"]').is_checked()
            page.locator('[data-field="music"]').check()
            page.locator("#spectrum").focus()
            page.keyboard.press("ArrowRight")
            assert "Frequency:" in page.locator("#inspection").inner_text()
            assert "Musical coordinate:" in page.locator("#inspection").inner_text()
            page.locator("#cepstrum").focus()
            page.keyboard.press("ArrowRight")
            assert "Quefrency:" in page.locator("#inspection").inner_text()
            assert "Musical coordinate:" not in page.locator("#inspection").inner_text()
            assert "linked frequency estimate:" in page.locator("#inspection").inner_text()
            page.locator("#formants button").nth(2).click()
            page.locator("#cepstrum").focus()
            assert "F3 linked frequency estimate:" in page.locator("#inspection").inner_text()
            page.locator('[data-pref="hover"]').uncheck()
            assert page.locator("#inspection").inner_text() == "Inspection disabled."
            page.locator('[data-pref="hover"]').check()
            for checkbox in page.locator("[data-field]").all():
                checkbox.uncheck()
            assert "No inspection fields" in page.locator("#inspection").inner_text()
            for name in ("position", "value", "time", "formant", "evidence"):
                page.locator(f'[data-field="{name}"]').check()
            # Multiple digital channels, source provenance and derived processing.
            page.locator("#channel-demo").click()
            assert page.locator(".channel-card").count() == 2
            contact = page.locator(".channel-card").nth(0)
            contact.locator("summary").click()
            contact.locator('input[type="number"]').fill("2")
            contact.get_by_role("button", name="Apply to derived trace").click()
            assert "conditioned digital" in contact.locator(".channel-meta").inner_text()
            optical = page.locator(".channel-card").nth(1)
            assert "detected digital" in optical.locator(".channel-meta").inner_text()
            page.locator("#channel-name").fill("IR trigger")
            page.locator("#channel-data").fill('["0","1",null,"0"]')
            page.locator("#add-channel").get_by_role("button", name="Add channel", exact=True).click()
            assert page.locator(".channel-card").count() == 3
            imported = page.evaluate('''() => sensehubLab.receiveChannel({schemaVersion:1,name:"Imported edges",kind:"digital",stage:"detected",data:{encoding:"edges",points:[{tUs:0,value:0},{tUs:10000,value:1}],endUs:30000}})''')
            assert imported.startswith("logic-")
            assert page.locator(".channel-card").count() == 4
            page.locator(".channel-card").nth(2).locator("canvas").focus()
            page.keyboard.press("End")
            assert "derived unknown" in page.locator(".channel-card").nth(2).locator(".channel-inspect").inner_text()
            page.locator(".device-setup summary").click()
            page.locator("#device-mode").select_option("pwm")
            page.locator("#device-config").get_by_role("button", name="Prepare request").click()
            assert "CHANNEL 8 3 13 0 0 10 0 0 1000 512" in page.locator("#device-request").inner_text()
            page.locator(".device-setup summary").click()
            page.locator(".channel-card").nth(3).get_by_role("button", name="Remove", exact=True).click()
            assert page.locator(".channel-card").count() == 3
            page.screenshot(path="/tmp/opencode/sensehub-spectrum-1440.png", full_page=True)
            page.set_viewport_size({"width": 390, "height": 900})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            page.screenshot(path="/tmp/opencode/sensehub-spectrum-390.png", full_page=True)
            # Exercise native audio decoding; silence must not fabricate estimates.
            buffer = io.BytesIO()
            with wave.open(buffer, "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(bytes(16000 * 2))
            page.locator("#file").set_input_files({"name": "silence.wav", "mimeType": "audio/wav", "buffer": buffer.getvalue()})
            page.wait_for_function("document.querySelector('#source-name').textContent.includes('silence.wav ·')")
            assert "Center: unresolved" in readout.inner_text()
            assert readout.inner_text().count("missing") == 3
            # Return to the demo after an imported source.
            page.locator("#demo").click()
            assert "Synthetic" in page.locator("#source-name").inner_text()
            assert not errors, errors
            print("Browser checks passed: multiple digital channels and processing, device requests, overlays, persistence, keyboard/cepstrum inspection, narrow layout, audio decoding and silence.")
        finally:
            browser.close()
finally:
    server.shutdown()
    server.server_close()
    thread.join()
