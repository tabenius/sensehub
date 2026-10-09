"""Headless interaction and adapter simulations. No actual MIDI/serial permissions."""
import binascii
import json
from pathlib import Path
import struct
import sys
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8903/"
output = Path("/tmp/opencode/sensehub-controllers")
output.mkdir(exist_ok=True)


def frame(kind, payload=b""):
    body = bytes([kind]) + struct.pack(">H", len(payload)) + payload
    return b"SH" + body + struct.pack(">H", binascii.crc_hqx(body, 0xFFFF))


def digital(channel, timestamp, raw, conditioned, flags, sequence, revision=1):
    return frame(0x09, struct.pack(">BQBBBII", channel, timestamp, raw, conditioned, flags, sequence, revision))


capabilities = {"schemaVersion": 1, "profile": "Simulated AI-Thinker ESP32-CAM", "soc": "ESP32", "deviceId": "AABBCCDDEEFF0011",
                "channelIds": list(range(8, 16)), "availablePins": [13, 14], "outputPins": [13, 14], "noPullPins": [],
                "modes": ["digital-input", "digital-output", "pwm-output"], "pwmResolutionBits": 10, "pwmMaxHz": 20000}
cap_frame = list(frame(0x08, json.dumps(capabilities).encode()))
config_body = bytes([8, 1, 13, 1, 1]) + struct.pack(">HHBIH", 10, 20, 0, 0, 0)
state_frame = list(frame(0x0A, config_body + struct.pack(">I", 1)))
ack_frame = list(frame(0x06, bytes([0x21, 0])))
mock = """
window.hardwareRequests={midi:0,serial:0};
window.fixtureMidiInput={id:'fixture-umx',name:'UMX610 simulated input',state:'connected',onmidimessage:null};
window.fixtureMidiAccess={inputs:new Map([['fixture-umx',window.fixtureMidiInput]]),onstatechange:null};
Object.defineProperty(navigator,'requestMIDIAccess',{configurable:true,value:async options=>{window.hardwareRequests.midi++;window.midiOptions=options;return window.fixtureMidiAccess;}});
window.midiEmit=bytes=>window.fixtureMidiInput.onmidimessage({data:Uint8Array.from(bytes)});
window.serialWrites=[];
window.fixtureSerial={
  getInfo:()=>({usbVendorId:6790,usbProductId:29987}),
  open:async options=>{
    window.serialOptions=options;
    window.fixtureSerial.readable=new ReadableStream({start:controller=>{window.serialController=controller;}});
    window.fixtureSerial.writable=new WritableStream({write:async bytes=>{
      window.serialWrites.push(Array.from(bytes));
      if(bytes[0]===83&&bytes[1]===72&&bytes[2]===32){window.serialController.enqueue(Uint8Array.from(CAP_FRAME));}
      if(bytes[0]===83&&bytes[1]===72&&bytes[2]===33){window.serialController.enqueue(Uint8Array.from(ACK_FRAME));window.serialController.enqueue(Uint8Array.from(STATE_FRAME));}
    }});
  },close:async()=>{window.serialClosed=true;}
};
Object.defineProperty(navigator,'serial',{configurable:true,value:{requestPort:async()=>{window.hardwareRequests.serial++;return window.fixtureSerial;}}});
""".replace("CAP_FRAME", json.dumps(cap_frame)).replace("ACK_FRAME", json.dumps(ack_frame)).replace("STATE_FRAME", json.dumps(state_frame))

stories = []
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=True)
    try:
        context = browser.new_context(viewport={"width": 1440, "height": 1100}, accept_downloads=True)
        context.add_init_script(mock)
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(url)
        page.wait_for_function("!!window.sensehubControls && !!window.sensehubAudio")
        assert page.evaluate("hardwareRequests.midi+hardwareRequests.serial") == 0
        assert page.locator("#virtual-plot .uplot").count() == 1
        knob = page.locator('[data-control="mix-0"]')
        knob.focus()
        initial = page.evaluate("sensehubControls.bank.oscillators[0].frequency")
        page.keyboard.press("ArrowRight")
        assert page.evaluate("sensehubControls.bank.oscillators[0].frequency") > initial
        knob.hover()
        assert "Frequency" in page.locator("#control-tooltip").inner_text()
        stories.append("SVG keyboard adjustment and hover binding inspection")

        # uPlot gives usable capture zoom that survives animated frames.
        overlay = page.locator("#virtual-plot .u-over")
        box = overlay.bounding_box()
        page.mouse.move(box["x"] + box["width"] * 0.2, box["y"] + 60)
        page.mouse.down(); page.mouse.move(box["x"] + box["width"] * 0.6, box["y"] + 60, steps=8); page.mouse.up()
        zoom = page.evaluate("sensehubControls.plotState().x")
        assert zoom["max"] - zoom["min"] < 0.1
        page.locator("#oscillator-play").click()
        before = page.evaluate("sensehubControls.plotState().samples")
        page.wait_for_function(f"sensehubControls.plotState().samples > {before}")
        assert page.evaluate("sensehubControls.plotState().x") == zoom
        page.locator("#oscillator-play").click()
        overlay.dblclick()
        assert page.evaluate("sensehubControls.plotState().x.max") > 0.12
        overlay.focus(); page.keyboard.press("End")
        page.locator("#controller-workbench").screenshot(path=str(output / "hercules-concept.png"))
        stories.append("Live uPlot animation, persistent drag zoom, reset and keyboard inspection")

        # Real Web MIDI adapter interface, replaced with an explicit simulated port.
        page.locator("#hardware-inputs summary").click()
        page.locator("#connect-midi").click()
        assert page.evaluate("hardwareRequests.midi") == 1
        assert page.evaluate("midiOptions.sysex") is False
        knob.focus(); page.locator("#midi-learn").click()
        page.evaluate("midiEmit([0xb2,21,127])")
        assert page.locator("#binding-source").input_value() == "midi"
        assert page.locator("#binding-channel").input_value() == "3"
        assert page.locator("#binding-number").input_value() == "21"
        assert page.evaluate("sensehubControls.bank.oscillators[0].frequency") == 4000
        page.evaluate("sensehubControls.receiveMidi([0xb2,21,0],'wrong-port')")
        assert page.evaluate("sensehubControls.bank.oscillators[0].frequency") == 4000
        page.locator("#mapped-channel").click()
        assert "Mapped hercules:mix-0" in page.locator("#channel-list").inner_text()
        assert "conditioned numeric" in page.locator("#channel-list").inner_text()
        page.locator("#proxy-drawer summary").click()
        page.locator("#proxy-url").fill(url.rstrip('/'))
        page.locator("#proxy-live").check(); page.locator("#proxy-publish").click()
        page.wait_for_function("document.querySelector('#proxy-status').textContent.includes('Live forwarding active')")
        page.evaluate("midiEmit([0xb2,21,0])")
        page.wait_for_function("async () => { const r=await fetch('/api/channels/control-hercules_mix-0?branch=processed'); if(!r.ok)return false;const d=await r.json();return d.processed.data.points.at(-1).value===20; }")
        page.locator("#proxy-live").uncheck()
        page.evaluate("midiEmit([0xb2,21,127])")
        stories.append("Linked mapped Float channel and automatic proxy forwarding without another Publish click")
        page.locator("#oscillator-spectrum").click()
        assert "Virtual oscillator mix" in page.locator("#source-name").inner_text()
        assert page.locator("#spectrum-range").input_value() == "nyquist"
        page.locator("#controller-workbench").screenshot(path=str(output / "midi-learn-and-routing.png"))
        stories.append("USB MIDI port discovery, learn CC/channel/port, port isolation and waveform routing")

        # 61-key note mapping, last-note priority, no stuck notes on overlap or All Notes Off.
        page.locator("#controller-profile").select_option("umx")
        assert page.locator(".device-control.key").count() == 61
        page.locator('[data-control="key-69"]').focus()
        page.locator("#midi-learn").click(); page.evaluate("midiEmit([0x90,69,100])")
        assert page.locator("#binding-number").input_value() == ""
        assert page.evaluate("sensehubControls.bank.oscillators[0].frequency") == 440
        page.evaluate("midiEmit([0x90,72,100]);midiEmit([0x80,69,0])")
        assert page.evaluate("sensehubControls.bank.oscillators[0].gate") is True
        assert abs(page.evaluate("sensehubControls.bank.oscillators[0].frequency") - 523.2511306) < 0.001
        page.evaluate("midiEmit([0x90,72,0])")
        assert page.evaluate("sensehubControls.bank.oscillators[0].gate") is False
        page.evaluate("midiEmit([0x90,69,127]);midiEmit([0xb0,123,0])")
        assert page.evaluate("sensehubControls.bank.oscillators[0].gate") is False
        page.locator('[data-control="key-36"]').focus(); page.keyboard.press("ArrowRight")
        assert page.evaluate("document.activeElement.dataset.control") == "key-37"
        page.keyboard.down("Space")
        assert page.evaluate("sensehubControls.bank.oscillators[0].gate") is True
        page.keyboard.up("Space")
        assert page.evaluate("sensehubControls.bank.oscillators[0].gate") is False
        page.locator(".device-scroll").screenshot(path=str(output / "umx610-keyboard.png"))
        stories.append("61-key view, overlapping notes, zero-velocity note-off, All Notes Off and keyboard navigation")

        # Custom controls and unbounded numerical output, saved/reopened locally.
        page.locator("#custom-device summary").click()
        page.locator("#custom-device-name").fill("My laboratory controller")
        page.locator("#custom-control-name").fill("Lens intensity")
        page.locator("#custom-control-kind").select_option("knob")
        page.locator("#custom-control-form").get_by_role("button", name="Add visual control").click()
        assert page.locator("#controller-profile").input_value() == "custom"
        page.locator("#binding-form details summary").click()
        page.locator("#binding-bounded").uncheck()
        page.locator("#binding-scale").fill("0.5"); page.locator("#binding-offset").fill("1")
        page.locator("#binding-target").select_option("channel")
        page.locator("#binding-form").get_by_role("button", name="Apply binding").click()
        page.locator("#selected-value").focus(); page.keyboard.press("End")
        assert page.evaluate("sensehubControls.events()[0].output") == 64.5
        page.locator("#mapped-channel").click()
        with page.expect_download() as downloaded:
            page.locator("#save-controls").click()
        mapping_path = output / "control-map.json"; downloaded.value.save_as(str(mapping_path))
        page.locator("#controls-file").set_input_files(str(mapping_path))
        page.wait_for_function("document.querySelector('#binding-status').textContent.startsWith('Control map loaded')")
        page.locator("#controller-workbench").screenshot(path=str(output / "custom-control-kit.png"))
        stories.append("Custom device/control creation, unbounded Float mapping and control-map file roundtrip")

        # Native Web Serial adapter mock sends actual framed capabilities/config/observations.
        page.locator("#controller-profile").select_option("gpio")
        page.locator("#connect-serial").click()
        page.wait_for_function("document.querySelector('#hardware-status').textContent.includes('Simulated AI-Thinker')")
        assert page.evaluate("serialOptions.baudRate") == 115200
        page.locator("#gpio-button-form").get_by_role("button", name="Configure button input").click()
        page.wait_for_function("serialWrites.some(bytes=>bytes[2]===33)")
        written = page.evaluate("serialWrites.find(bytes=>bytes[2]===33)")
        assert written[5:14] == [8,1,13,1,1,0,10,0,20]
        page.evaluate("bytes=>serialController.enqueue(Uint8Array.from(bytes))", list(digital(8,1000000,1,0,1,0)))
        page.wait_for_function("sensehubLab.session().channels.some(c=>c.source.name.startsWith('ESP32 input 8'))")
        assert page.locator('[data-control="gpio-0"]').evaluate("g=>g.classList.contains('unknown')")
        page.evaluate("bytes=>serialController.enqueue(Uint8Array.from(bytes))", list(digital(8,1030000,1,0,0,1)+digital(8,1060000,0,1,0,2)))
        page.wait_for_function("sensehubControls.bank.oscillators[0].gate")
        assert "ESP32 raw input 8" in page.locator("#channel-list").inner_text()
        assert "ESP32 input 8" in page.locator("#channel-list").inner_text()
        assert page.locator('[data-control="gpio-0"]').evaluate("g=>g.classList.contains('active')")
        assert "Receiving GPIO channel 8" in page.locator("#hardware-status").inner_text()
        page.locator("#controller-workbench").screenshot(path=str(output / "gpio-button-protocol.png"))
        page.locator("#disconnect-serial").click()
        page.wait_for_function("window.serialClosed===true")
        stories.append("Web Serial handshake/configuration, GPIO discovery, raw/conditioned channel pairs and unknown input states")

        # A software toggle counts fresh transitions per sender, not polls or gaps.
        page.locator('[data-control="gpio-1"]').focus()
        if not page.locator("#binding-form details").evaluate("e=>e.open"):
            page.locator("#binding-form details summary").click()
        page.locator("#binding-behavior").select_option("toggle")
        page.locator("#binding-form").get_by_role("button",name="Apply binding").click()

        def inject(source, timestamp, value, flags, sequence):
            packet = digital(9,timestamp,1-value,value,flags,sequence)
            page.evaluate("arg=>sensehubControls.receiveDigital(Uint8Array.from(arg.payload),arg.source)", {"payload":list(packet[5:-2]),"source":source})

        inject("fixture-gpio-one",2000000,0,0,0)
        inject("fixture-gpio-one",2030000,1,0,1)
        inject("fixture-gpio-one",2060000,1,0,2)
        assert page.evaluate("sensehubControls.bank.oscillators[0].gate") is True
        inject("fixture-gpio-one",2090000,1,1,3)
        assert page.locator('[data-control="gpio-1"]').evaluate("g=>g.classList.contains('unknown')")
        inject("fixture-gpio-one",2120000,1,0,4)
        assert page.evaluate("sensehubControls.bank.oscillators[0].gate") is True
        inject("fixture-gpio-one",2150000,0,0,5)
        inject("fixture-gpio-one",2180000,1,0,6)
        assert page.evaluate("sensehubControls.bank.oscillators[0].gate") is False
        inject("fixture-gpio-two",1000000,0,0,0)
        inject("fixture-gpio-one",2210000,1,0,7)
        assert page.evaluate("sensehubControls.bank.oscillators[0].gate") is False
        inject("fixture-gpio-two",1030000,1,0,1)
        assert page.evaluate("sensehubControls.bank.oscillators[0].gate") is True
        inputs=page.evaluate("sensehubLab.session().channels.filter(c=>c.source.name.startsWith('ESP32 input 9')).map(c=>c.id)")
        assert len(inputs)==2 and inputs[0]!=inputs[1]
        stories.append("Fresh-press toggles survive unknown intervals and distinguish concurrent GPIO senders")

        # USB-over-IP setup is prepared, not executed against the host.
        page.locator("#usbip-setup summary").click()
        page.locator("#usbip-host").fill("usb.example"); page.locator("#usbip-ssh").fill("user@usb.example")
        page.locator("#usbip-form").get_by_role("button", name="Prepare USB/IP commands").click()
        assert "ssh -N -L 3240:127.0.0.1:3240" in page.locator("#usbip-commands").inner_text()
        page.locator("#usbip-setup").screenshot(path=str(output / "usbip-configuration.png"))
        stories.append("USB/IP and SSH-tunnel command preparation without host/device mutation")

        # Tablet taps and touch drag on a real browser touch input path.
        tablet = browser.new_context(viewport={"width":768,"height":1024}, has_touch=True, is_mobile=True)
        touch = tablet.new_page(); touch.goto(url)
        touch.wait_for_function("!!window.sensehubControls")
        touch.locator('[data-control="mix-0"]').scroll_into_view_if_needed()
        target = touch.locator('[data-control="mix-0"] .body').bounding_box()
        x,y = target["x"]+target["width"]/2,target["y"]+target["height"]/2
        cdp = tablet.new_cdp_session(touch)
        initial = touch.evaluate("sensehubControls.bank.oscillators[0].frequency")
        cdp.send("Input.dispatchTouchEvent", {"type":"touchStart","touchPoints":[{"x":x,"y":y}]})
        cdp.send("Input.dispatchTouchEvent", {"type":"touchMove","touchPoints":[{"x":x,"y":y-20}]})
        cdp.send("Input.dispatchTouchEvent", {"type":"touchEnd","touchPoints":[]})
        assert touch.evaluate("sensehubControls.bank.oscillators[0].frequency") > initial
        touch.locator("#controller-profile").select_option("umx")
        assert touch.locator("#controller-zoom").input_value() == "3"
        touch.locator('[data-control="key-69"]').tap()
        assert touch.evaluate("sensehubControls.bank.oscillators[0].gate") is False
        assert touch.evaluate("document.documentElement.scrollWidth<=innerWidth")
        touch.locator("#controller-workbench").screenshot(path=str(output / "tablet-umx-touch.png"))
        touch.set_viewport_size({"width":390,"height":844})
        assert touch.evaluate("document.documentElement.scrollWidth<=innerWidth")
        touch.locator("#controller-workbench").screenshot(path=str(output / "phone-control-kit.png"))
        stories.append("Native touch drag, piano-key tap/release, tablet zoom/pan and 390 px layout")
        assert not errors, errors
        (output / "findings.json").write_text(json.dumps({"method":"Headless simulated adapters and user stories; no real devices or human participants", "passed":stories},indent=2))
        print(f"{len(stories)} controller stories passed. Screenshots: {output}")
    finally:
        browser.close()
