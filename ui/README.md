# Spectral bench prototype

Dependency-free browser UI for exercising SenseHub display controls with a
synthetic vowel or a local audio file. Audio is decoded locally; no upload,
microphone permission or device connection is involved.

## Run

From the repository root:

```sh
python3 -m http.server 8902 --bind 127.0.0.1 --directory ui
```

Open `http://127.0.0.1:8902/` in your browser. Serving through HTTP is required
for ES modules. The command runs in the foreground; Ctrl-C stops that server.
It does not open a window automatically.

## Controls

The digital channel lab accepts bit strings, JSON char/level arrays, numeric
samples and timestamped channel envelopes. Add, hide, process, export or remove
up to 32 channels. Expand **Condition / detect** for inversion, stable-time
debounce, numeric median/EMA and LOW/HIGH hysteresis. Unknowns remain explicit.
Raw source observations stay available as an overlay. See
[channel lab](../docs/channel-lab.md) for formats, device API and processing recipes.

The ESP32 drawer prepares USB configuration commands, including digital input,
static output and PWM; it does not connect or send to hardware. Sensor examples
are local demonstrations. The embedding API `window.sensehubLab` accepts batch
channel envelopes and capabilities for future transport adapters.

The device drawer loads capability JSON to populate permitted pins/modes. Its
AI-Thinker default is explicitly a preview, not an actual connected-device report.
Shared time zoom/pan and keyboard stepping help inspect narrow pulses. Numeric
originals have a separate lane; unknown/unrecorded intervals are shaded.

**Save session**, **Open session / script**, and the command console preserve
original observations plus effective processing recipes. See
[sessions/scripts](../docs/session-scripts.md). **Share / subscribe** connects to
the independent [HTTP/SSE channel proxy](../proxy/README.md), choosing original,
processed or both branches. Run `node proxy/server.mjs` from the repository root
to serve the UI with its API at `http://127.0.0.1:8903/`.

- Independent center, search-range and measured-bandwidth edge toggles.
- Independent note and octave labels; configurable A4 reference (400–480 Hz).
  Musical ticks are thinned to fit the display. These are coordinate labels,
  not detected pitch or musical content.
- Master inspection toggle and individual position, value, time, musical,
  selected-formant, evidence and analysis-settings fields.
- Mouse/pointer and touch inspection, plus arrow keys on a focused plot.
  Shift-arrow advances ten bins; Home/End reach the displayed bounds.
- Formant rows select the linked estimate in both views. Marker visibility does
  not disable its selectable inspection fields.
- Saved display preferences, when browser local storage is available.
- Frame slider with 256-sample steps and audio-file input. Multiple channels
  are averaged to mono; anti-phase channels can cancel. Web Audio may resample
  to the context rate, which is displayed as the analysis sample rate.

## Analysis semantics

The prototype uses a 2048-sample Hamming window and mean removal. Spectrum
values are one-sided power density, in dB relative to 1 amplitude²/Hz. The
real cepstrum is the normalized IFFT of natural-log FFT magnitude, floored at
1e-12 before taking the logarithm. Its x-axis is quefrency in milliseconds;
the zero-quefrency coefficient is excluded from plotting and scaling.

An envelope is reconstructed with a symmetric, rectangular low-quefrency
lifter of 2 ms. Centers are its local maxima within illustrative F1–F3 search
bands, gated by an RMS floor and 3 dB band-median contrast. Contrast is not a
noise-calibrated SNR or probability. These are formant **candidates**, not
validated resonance estimates. No temporal ridge tracking or voice detector
is implemented.

Bandwidth edges are interpolated −3 dB crossings of this envelope inside the
search band; no symmetry is imposed. An unresolved edge is omitted. This
criterion is distinct from the bandwidth computed from LPC poles. The
synthetic source has known 730/1090/2440 Hz resonators; envelope maxima can
deviate from those parameters.

The cepstrum shares a frequency-valued formant readout with the spectrum.
Formant frequencies are not converted into reciprocal quefrency markers.
Musical hover information is offered only on the frequency-axis view.

`signal.js` is a prototype analysis adapter. The production Rust DSP,
device transport and Tauri shell are not connected yet.

## Verification

```sh
npm --prefix ui test
npm --prefix ui run check
```

Optional headless browser checks require Python Playwright and Chromium at
`/usr/bin/chromium`:

```sh
python3 ui/tests/browser_smoke.py
```

The browser test serves the UI from an in-process loopback HTTP server on a
temporary port and closes only its own browser/server. It checks independent
overlay controls, saved preferences, keyboard inspection, cepstral coordinate
semantics, a 390 px layout, WAV decoding and missing estimates on silence.
Screenshots are written to `/tmp/opencode/sensehub-spectrum-{1440,390}.png`;
that directory must exist. Use an isolated Python environment if the host's
Playwright driver is incomplete.

For fuller simulated keyboard/mouse/touch, session and proxy stories:

```sh
python3 ui/tests/usability_stories.py http://127.0.0.1:8903/
```

This requires a dedicated running proxy and publishes simulated channels to it.
See [usability findings](../docs/usability-review.md) for screenshot paths and scope.
