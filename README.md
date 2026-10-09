# SenseHub

Companion artifact for bench sensing: ESP32 firmware plus host-side analysis.

- `firmware/` — Arduino sketch: timer-sampled ADC1 ring buffer, Bluetooth SPP
  and WiFi TCP streaming, slow sensor hub, I2C/SPI auto-detect, AP-first boot
  with a proposed Ed25519 pairing flow. The verification hook is unimplemented
  and fails closed. See `docs/protocol.md` for the draft wire contract.
- `dsp/` — zero-dependency Rust: framing, bandpass, smoothing, level/trend
  analysis, LPC formants. `cargo test` is the verification.
- `docs/` — protocol, 37-module kit mapping, sensing-hub chapter outline, and
  [formant ridge tracking research](docs/formant-ridge-research.md).

Spectrum/cepstrum marker toggles, musical labels, and selectable hover details
are captured in [display controls](docs/display-controls.md).

An interactive [spectral bench prototype](ui/README.md) implements these
controls for synthetic and local-file audio, with spectrum markers and a
frequency-valued formant readout linked to the real cepstrum.

The [channel lab](docs/channel-lab.md) adds multiple digital/numeric input
timelines, raw/derived comparisons, processing controls, and an ESP32
capability/configuration extension for polled digital inputs and digital/PWM
outputs. The document maps sensor-cleanup and decoding recipes to device/host
placement, distinguishing implemented operations from planned backends.

[Multi-board capabilities](docs/multi-board.md) separate SoC support from board
pin ownership. [Sessions and scripts](docs/session-scripts.md) make digital
benches repeatable. The [channel proxy](proxy/README.md) serves the UI and
re-exports original/processed blocks through HTTP and SSE independently of the
ESP32 network. [Simulated usability stories](docs/usability-review.md) record
keyboard, mouse, touch, screenshots and interpretation-driven changes.

Status: proposal. Firmware is untested on hardware; DSP is host-tested only.
The Tauri shell, output actuator kinds, and OneWire/SPI-output drivers are
explicit gaps, not silent omissions. See each directory's notes.

A proposed integration with `remote-android` — microphone and camera capture
feeding the bench through the existing `window.sensehubAudio` host hook — is
written up in [remote-android audio integration](docs/remote-android-audio-integration.md).
It is a proposal, and it is deliberately blocked on reconciling this crate's DSP
with the separate Phoneme Tauri specification, which describes the same
pipeline.

## Local verification

```sh
cargo check --offline --manifest-path dsp/Cargo.toml
cargo test --offline --manifest-path dsp/Cargo.toml
cargo fmt --manifest-path dsp/Cargo.toml --all --check
npm --prefix ui test
npm --prefix ui run check
npm --prefix proxy test
npm --prefix proxy run check
```

Frog discovers `dsp` as the nested Rust unit and exposes repository-level
`check`, `test`, and `lint` actions. The Arduino sketch needs a pinned board/core
and a separate compile/hardware verification ceremony.

## Research direction

The current proposal is bounded-band local evidence followed by gap-aware
trajectory decoding. Gaussian power and magnitude scores, L1/Huber continuity,
explicit jumps, and joint formant identity are specified in the research note.
The note compares published alternatives; no ridge decoder or FFT/STFT pipeline
has been implemented yet. Model choice and latency budget remain open decisions.
