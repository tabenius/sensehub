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

Status: proposal. Firmware is untested on hardware; DSP is host-tested only.
The Tauri shell, output actuator kinds, and OneWire/SPI-output drivers are
explicit gaps, not silent omissions. See each directory's notes.

## Local verification

```sh
cargo check --offline --manifest-path dsp/Cargo.toml
cargo test --offline --manifest-path dsp/Cargo.toml
cargo fmt --manifest-path dsp/Cargo.toml --all --check
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
