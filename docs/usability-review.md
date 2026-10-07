# Simulated user stories and interpretation review

Method: scripted headless Chromium task walkthroughs, real pointer/keyboard
events, touch emulation and visual screenshot inspection. This is an engineering
usability review, **not a human participant study** or a claim about measured
comprehension. Audio DSP, portable firmware policy and proxy semantics have
separate tests; hardware behavior remains unverified.

## Stories exercised

| Story / audience | Simulated task | Result / interpretation check |
|---|---|---|
| New user / repair bench | Alt+A, Tab through name/type/timing/data, Enter to add a char-array signal | Passed; sample interval explicit; unknown observations excluded from known-time statistics |
| Electronics / motion-trigger work | Load contact/optical script; debounce contact and threshold numeric input | Passed; original observations retained; recipe and visible controls agree |
| Protocol inspection | Zoom to 10 ms, hover, focus and step with arrow/Home/End | Passed; timing inspected without pretending polled observations are high-rate hardware capture |
| Reproducibility / research | Save digital session, reopen in an independent page | Passed; 31 original contact observations plus effective processing parameters restored |
| Script recovery | Valid first command followed by invalid missing-channel processing | Passed; whole-script validation prevents partial import |
| Different-board configuration | Simulated S3 capability descriptor admits GPIO38 output, no PWM | Passed; pins/modes derive from capabilities, irrelevant controls hidden, no device-connection claim |
| Studio-style routing / downstream analysis | Publish both branches, read originals through HTTP, subscribe in another page | Passed; original branch preserves observations, processed branch is distinct, subscriber receives both |
| Tablet / touch and small screens | Tap examples, open processing, apply settings and inspect timeline at 768 px; check 390 px layout | Passed; no horizontal overflow, visible button/select/file targets at least 44 px |

These tasks are tested by `ui/tests/usability_stories.py`; compact regression
checks are in `ui/tests/browser_smoke.py`. Scripts use local demo data, not sensors
or live patient/camera measurements. Simulated board descriptions do not verify
physical board support.

## Findings and changes

1. **Original numeric samples shared a logic axis.** A newcomer could read a
   normalized analog trace as a HIGH/LOW decision. Numeric originals now have a
   separate lane and displayed range; orange remains the derived logic trace.
   Source units are preserved when supplied, without inventing calibration.
2. **Empty regions could look like LOW.** Unknown, debounce-unconfirmed and
   unrecorded intervals are shaded; cursor readout explicitly says unknown.
   Coverage and HIGH fraction use known time, not missing observations.
3. **Short pulses were hard to inspect.** Added shared zoom/pan, retaining
   precise cursor times and all original points. Dense subpixel pulses still
   require zoom; no unannounced pulse-destroying decimation is applied.
4. **Export lacked a branch name.** Renamed the channel action **Export processed**;
   session files retain originals plus processing recipes; proxy controls choose
   original, processed or both explicitly.
5. **Some file controls were inaccessible from the keyboard.** File labels now
   have focus and Enter/Space activation. Alt+A focuses channel creation; Ctrl+K
   opens the console; Ctrl+Enter runs commands. Plots retain keyboard inspection.
6. **Touch targets were too small.** Buttons/selects/file controls now have a
   minimum 44 px height; checkbox labels have larger hit areas. Tablet taps were
   exercised instead of substituting mouse clicks.
7. **Hidden canvases/fields could still render because author CSS overrode the
   HTML hidden attribute.** Added an explicit hidden rule and a rendered-visibility
   test. Mode-specific controls now actually disappear.
8. **Repeated benches were hard to reconstruct.** Added versioned digital sessions
   and a small declarative DSL loaded from file. Effective defaults are saved as
   concrete processing parameters, so later default changes won't silently alter
   a restored recipe. Invalid scripts are rejected before mutation.

## Interpretation across audiences

- **Studio mixing:** original/derived lanes and explicit routing are familiar;
  device acquisition timing is separate from the UI/audio clock. The current
  proxy is block redistribution, not low-latency audio routing.
- **Electrical engineering / repair / protocol audit:** units, sequence/gap
  semantics and resource ownership matter more than smooth-looking lines.
  GPIO capability does not prove an attached sensor, and filtering can erase
  protocol evidence. Preserve the original branch.
- **Singing / hearing technology:** pitch, spectral-envelope peaks, resonance
  parameters and cepstral quefrency remain distinct. This review does not validate
  the prototype for diagnostic measurements or calibrated hearing tests.
- **Statistical image analysis:** image/frame clocks, calibration, ROI processing
  and detector uncertainty need their own representations. Camera processing is
  still catalogued/planned; no image task was simulated as if it were implemented.

## Screenshots and repeatability

Latest screenshots and machine-readable findings live in
`/tmp/opencode/sensehub-usability/`:

- `desktop-channel-lab.png`
- `debounced-contact.png`
- `numeric-original-and-derived.png`
- `zoomed-contact.png`
- `capability-driven-device-controls.png`
- `proxy-publish-controls.png`
- `tablet-touch-channel-lab.png`
- `phone-390-channel-lab.png`
- `findings.json`

Run a proxy, then the walkthrough with an isolated Python Playwright environment:

```sh
node proxy/server.mjs --port 8903
python3 ui/tests/usability_stories.py http://127.0.0.1:8903/
```

The test creates its screenshot directory under `/tmp/opencode` and uses only
headless browsers. It publishes simulated channels into the selected proxy;
use a dedicated test instance when preserving another session's proxy data matters.

## Remaining usability work

Sessions currently save digital/numeric channels and recipes, not audio files,
all view preferences or a persistent recording history. Explicit replace/merge
choices, multi-channel bus grouping, dense-trace aggregation, screen-reader
alternatives to canvas and real participant feedback remain useful follow-ups.
The next hardware story is an AI-Thinker input/output loopback with measured
sampling jitter, gaps and applied PWM settings.
