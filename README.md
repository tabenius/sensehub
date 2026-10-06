# SenseHub

Companion artifact for bench sensing: ESP32 firmware plus host-side analysis.

- `firmware/` — Arduino sketch: timer-sampled ADC1 ring buffer, Bluetooth SPP
  and WiFi TCP streaming, slow sensor hub, I2C/SPI auto-detect, AP-first boot
  with minisign-shaped pairing. See `docs/protocol.md` for the wire contract.
- `dsp/` — zero-dependency Rust: framing, bandpass, smoothing, level/trend
  analysis, LPC formants. `cargo test` is the verification.
- `docs/` — protocol, 37-module kit mapping, sensing-hub chapter outline.

Status: proposal. Firmware is untested on hardware; DSP is host-tested only.
The Tauri shell, output actuator kinds, and OneWire/SPI-output drivers are
explicit gaps, not silent omissions. See each directory's notes.
