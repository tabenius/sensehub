# A channel-first lab

Implemented checkpoint: the browser accepts multiple digital/numeric channels;
the firmware has a new portable channel core plus Arduino integration for
polled digital inputs, inversion/debounce, digital outputs and one PWM output.
The core is host-tested. The Arduino integration is **not board-compiled or
hardware-tested**. The browser does not yet connect to ESP32 transport.

## Simple first, depth on demand

The first action is **Add channel**: name, HIGH/LOW or numeric input, timing,
and data. A channel strip gives a trace, visibility, raw overlay, edge counts
and HIGH-time fraction. **Condition / detect** unfolds processing parameters;
**Timing and provenance** unfolds source-stage and timestamp details; device
setup is a separate drawer. Terminology stays task-oriented across audiences:
observe → condition → detect → decode → generate. A preset should change a
declared pipeline, not silently rename data or hide a filtering decision.

Useful future workspace presets reuse the same model: studio/audio, logic and
protocol inspection, repair bench, voice/formants, optical link, and image/motion.
They select tools and explanations rather than pretending their measurements
have interchangeable meaning. Existing spectral and digital tools remain usable
together. Acquisition clocks must be synchronized explicitly before cross-source
phase/delay measurements are meaningful.

## The channel contract

Each channel needs:

- Stable source/device identity and channel ID; a user-visible name.
- Direction: input, derived or output. An output command is not proof that the
  physical output occurred; loopback is a separate input channel.
- Kind: numeric, digital, timed edges, decoded events/bytes, audio, image/frame,
  vector or spectrum. GPIO is a source binding, not the channel's data type.
- Encoding: bit chars, packed bits, scalar samples, timestamped edges or frames.
- Unit/calibration, source clock, sample interval or timestamps, configuration
  revision, sequence numbers, valid/unknown/lost flags and processing latency.
- Processing stage: raw, conditioned, detected or decoded, plus ordered steps
  with parameters, algorithm versions, placement (device/host) and source links.

No logical channel claims a sensor identity merely because a GPIO can be read.
Discovered bus-device identity, user-assigned sensor role and available hardware
capabilities are distinct facts. Capabilities describe support; configured
channels describe bindings; observations describe what was actually measured.

### Browser formats available now

Simple inputs:

```text
001101?001
```

```json
["0", "0", "1", "1", null, "0"]
```

Provide a sample interval in µs. Bit position alone does not establish time.
For explicit timing and source-stage information:

```json
{
  "schemaVersion": 1,
  "name": "Greenhouse optical trigger",
  "kind": "digital",
  "stage": "detected",
  "data": {
    "encoding": "edges",
    "points": [
      {"tUs": 0, "value": 0},
      {"tUs": 12000, "value": 1},
      {"tUs": 28000, "value": null},
      {"tUs": 35000, "value": 0}
    ],
    "endUs": 50000
  }
}
```

`bits` uses string `values` plus `intervalUs`; `samples` uses an array of
`values` plus `intervalUs`. Numeric channels use `kind: "numeric"` and finite
number values. Timestamps are strictly increasing integer microseconds. `null`
or `?` means unknown, never LOW. Intervals are sample-and-hold; an edge list
requires an explicit end time in the full envelope. A bare timestamped array
uses the supplied interval as its final observation duration.

The browser supports 32 channels and 100000 points per channel in a session.
Sources are aligned to a shared display origin but retain a source-local clock
label; this is visual alignment, not device synchronization. File samples are
not saved in local storage. Raw observations are retained when a derived trace
is produced. Export includes source stage and processing parameters.

An embedding/transport adapter can call:

```js
window.sensehubLab.receiveChannel(channelEnvelope);
window.sensehubLab.receiveCapabilities(deviceCapabilities);
window.sensehubLab.channels(); // exported derived envelopes
```

This is batch ingestion, not a live TCP/WebSocket connection or continuous
stream assembler. A future live adapter must handle revision changes, dropped
packets, bounded buffering, reconnects, and device-clock mapping explicitly.

## Processing catalog

The key distinction is **what operation acts on which representation**. A
digital PIR module already has an internal detector; its logic pin cannot
reveal the original thermal waveform or change the module's analog sensitivity.
A bare photodiode instead needs an appropriate analog front-end before ADC
sampling and software thresholding.

| Source / task | Useful processing | Suitable placement | Checkpoint |
|---|---|---|---|
| Button, reed, relay-contact input | Polarity, pull configuration, stable-time debounce, rising/falling events | Device; host for replay | Device inversion/debounce core; browser debounce/stats |
| Comparator or PIR logic output | Minimum active/inactive durations, refractory time, occupancy/windowed counts | Device for triggers; host for summaries | Debounce and HIGH-time summary now; separate refractory/event modes planned |
| Photodiode, LDR, pressure, potentiometer | Calibration, clipping flags, causal median, EMA, Schmitt hysteresis, adaptive background/noise | Small causal steps on device; inspect on host | Browser median/EMA/hysteresis now; analog device pipeline planned |
| Photodiode receiving a strobe | DC/ambient rejection, bandpass/notch, automatic gain, timing recovery, OOK/FSK decoding, CRC and packet loss | Front-end + dedicated ADC/capture; host prototype | Planned; current GPIO polling is not an optical modem |
| Pulse/PWM input, tachometer, flow meter | Edge timestamps, glitch rejection, period/frequency/duty, pulse width, timeout | RMT/PCNT/timer capture on device | Planned capture backend; browser imported edge/time summaries now |
| Quadrature encoder | Transition table, invalid-transition count, signed position, velocity | PCNT/GPIO capture on device | Planned |
| Temperature/humidity/distance | Range/checksum validation, median outlier rejection, calibration, staleness, unit conversion, EMA | Device at sensor cadence | Existing sensor slots; richer typed/calibrated pipeline planned |
| IMU/vibration | Bias/scale calibration, resampling, low/high/bandpass, RMS, peak, orientation/fusion | Device for reduced features; host for spectral/fusion review | Planned sensor pipeline |
| Audio/speech | DC removal, gain, filters, envelope/RMS, FFT/STFT, pitch, formants, event detection | Dedicated ADC/I2S; host for heavier inference | Browser spectrum/cepstrum; Rust filters/LPC; rest pending |
| Thermal array / IR camera | Sensor calibration and bad-pixel replacement, temporal/spatial denoise, background model, ROI, hysteretic motion scores, connected regions | Device for tiny arrays/ROIs; host for larger frames | Planned image channel and drivers |
| Camera image boundaries | Gaussian smoothing, gradient, nonmaximum suppression, double-threshold connectivity (Canny) | Host first; only advertise device implementation when budgeted | Planned; Canny detects boundaries, not motion by itself |
| Video motion/statistical analysis | Frame differencing/background subtraction, optical flow, tracking, uncertainty and frame loss | Host, with negotiated low-resolution device features | Planned |
| Digital buses/protocol audit | Edge capture, clock recovery, UART/SPI/I2C/IR decoding, timestamps, framing/parity/checksum, anomaly events | Device capture + host decoders | Planned; never filter away timing evidence by default |
| Output actuation | Static level, PWM frequency/duty, later pulse trains/arbitrary waveforms, initial/stop state and resource ownership | Device hardware peripherals | Static digital / one PWM integration now; rest pending |

### Noise-aware detection recipe (planned)

For analog inputs, expose a simple preset **Quiet / normal / sensitive** that
expands to concrete thresholds and time constants. Keep raw units visible.
An adaptive detector can estimate background `b` and scale `s` from a quiet
calibration interval, using a median/MAD scale or a declared running model.
Then use `HIGH = b + k_high*s` and `LOW = b + k_low*s`, with
`k_low < k_high`, plus minimum dwell and refractory intervals. MAD is a robust
scale estimate, not automatically a calibrated noise standard deviation for
every distribution. Calibration must account for correlated noise, drift and
the actual false-trigger requirement.

Do not adapt the background through an active event in a way that absorbs the
signal being detected. Show baseline/noise estimates and a calibration/reset
control in the advanced drawer. A fixed threshold detector, adaptive detector,
and sensor-internal comparator are separate capabilities. Event records should
retain onset/confirmation timestamps and decision latency, not just HIGH/LOW.
For binary inputs, temporal stability/refractory models are meaningful, but an
analog amplitude-noise model cannot be reconstructed from the logic pin.

### L1 and strobing signals

First-difference L1/TV, `min_z Σ loss(x_i,z_i) + λ Σ |z_i-z_(i-1)|`, is useful
for piecewise-constant denoising. It can erase the very pulses or modulation
carrying optical data. Offer it as a separately labeled **offline host** recipe
with raw comparison and a stated block/lookahead latency; it is not yet
implemented for these channels. EMA/median can also distort symbol timing.
An optical receiver should keep an unfiltered capture branch for timing recovery
and bit-error tests rather than passing every use case through a generic denoiser.

For greenhouse audio, choose the link task first: analog intensity modulation
with ambient rejection and suitable receiver bandwidth, or framed digital audio
with codec/bitrate, synchronization, CRC/FEC, buffering and measured loss.
Lossless recovery depends on the actual link budget, bandwidth and error rate;
it does not follow from choosing a norm. PWM audio also requires the appropriate
receiver/filter path; the current configurable PWM is a test/actuation output,
not a music broadcast pipeline.

## ESP32 API implemented in source

Uses the existing SH framing, maximum 4096-byte payload and CRC. All integers
below are big-endian. New typed channel IDs are 8–15, separate from legacy
scope/sensor IDs. Channels boot disabled and are not persisted yet.

| Type | Direction | Meaning |
|---|---|---|
| `0x20 DESCRIBE` | Host → device | Empty read-only request; response is capabilities |
| `0x08 CAPABILITIES` | Device → host | UTF-8 JSON profile, modes, pins, limits, processing names and configured channel summaries |
| `0x21 CHANNEL_CONFIG` | Host → device | 16-byte configuration; privileged over radio, available via explicit USB command |
| `0x06 ACK` | Device → host | Request type `0x21`, result code |
| `0x0A CHANNEL_STATE` | Device → host | Applied 16-byte config plus `u32 revision`; sent also on valid-ID config rejection so the client sees the retained state |
| `0x09 DIGITAL_OBSERVATION` | Device → host | 20-byte timed observation described below |

Config bytes:

```text
u8 id, mode, gpio, pull, invert
u16 poll_ms, debounce_ms
u8 output_level
u32 pwm_frequency_hz
u16 pwm_duty_10bit
```

Mode: 0 disabled, 1 input, 2 static output, 3 PWM. Pull: 0 none, 1 up,
2 down. Input inversion is applied before debounce. Output modes require
pull/invert/debounce to be zero. Non-PWM modes require frequency/duty zero.
Debounce and polling are bounded at 60000 ms; poll cannot be zero. One PWM
slot uses LEDC channel 0, 10-bit duty 0–1023; requested frequency is 1–20000 Hz,
but hardware may reject an unachievable frequency/resolution combination.
Reported frequency is requested, not a calibrated physical measurement.

Observation:

```text
u8 channel
u64 observed_device_time_us
u8 raw_level, conditioned_level, quality_flags
u32 sequence, config_revision
```

Quality bit 0: conditioned state unknown/not yet confirmed. Bit 1: polling
continuity lost (delay > twice the configured interval). The raw observation
is valid at its timestamp; the period since the previous observation is not
thereby reconstructed. Receivers must show a gap on missing sequences or bit 1;
never carry a stable level across that gap without a declared prediction model.
Sequence resets with revision; timestamps are monotonic `esp_timer` microseconds
since boot and need a separate boot/session identity in a future live adapter.

See [multi-board support](multi-board.md) for board selection, capability-driven
UI behavior, USB framing and custom pin masks. The explicitly selected classic
bench profile allows GPIO 25/26/27/32/33 for input/output,
and 35/36/39 for input only with no internal pull. Scope GPIO34, UART,
boot/flash pins and configured buses are excluded. This is a conservative
software profile, not an inventory of attached wiring. The AI-Thinker ESP32-CAM
profile instead exposes GPIO13/14 and initializes neither camera nor SD. Other
boards use explicit masks intersected with SoC GPIO capabilities. Legacy sensor bindings and
typed channels cannot claim the same pin. Only one PWM channel is admitted.

Result codes: 0 OK, 1 invalid configuration, 2 unsupported pin/profile,
3 pin busy, 4 resource busy, 5 hardware failure. Validations precede rebinding;
failed PWM attachment attempts restore the old binding, or disclose disabled
state if restoration also fails. Core 2.x/3.x LEDC paths are selected at compile
time, but require actual board compilation and loopback verification.

USB examples for Tobias's AI-Thinker profile (GPIO13/14, no SD initialized):

```sh
CAPABILITIES
# channel 8: input GPIO13, pull-up, active-low, poll 10 ms, debounce 20 ms
CHANNEL 8 1 13 1 1 10 20 0 0 0
# channel 9: static HIGH on GPIO14
CHANNEL 9 2 14 0 0 10 0 1 0 0
# reconfigure the same channel/pin as PWM, 1 kHz, 512/1023 duty
CHANNEL 9 3 14 0 0 10 0 0 1000 512
# disable channel 9
CHANNEL 9 0 14 0 0 10 0 0 0 0
```

The UI prepares these commands; it does not send them. Radio configuration
uses the existing signed-envelope hook, which is still unimplemented/fail-closed.
DESCRIBE replies over the requesting transport. Digital observations use the
selected streaming transport. Polling has jitter and blocking sensor routines
can delay it: **this is not a high-speed logic analyzer**. RMT/PCNT/DMA/I2S
capabilities must be negotiated separately when implemented.

## Verification and next increments

`npm --prefix ui test` covers import timing, unknowns, hysteresis, filters,
debounce, provenance and edge/duty statistics. The headless UI check exercises
multiple channels, processing, device-request preparation and existing spectral
controls. The portable firmware core can be checked without Arduino:

```sh
g++ -std=c++11 -Wall -Wextra -Werror firmware/tests/channel_core_test.cpp \
  -o /tmp/opencode/sensehub-channel-core-test
/tmp/opencode/sensehub-channel-core-test
```

Next: pin the actual board/core and compile the Arduino integration; loop back
digital/PWM outputs to capture inputs; implement the live transport adapter and
revision-aware buffering; add time zoom and hardware pulse capture; then build
optical and camera pipelines against measured acquisition requirements.
