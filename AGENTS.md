# SenseHub working instructions

Read the parent workspace's `AGENTS.md` for coordination conventions. Claim a
Frog task and lock before editing; preserve unrelated work. Discover the DSP as
a nested unit, not a separate Git repository.

## Verification

- DSP tests: `cargo test --offline --manifest-path dsp/Cargo.toml`
- DSP compilation: `cargo check --offline --manifest-path dsp/Cargo.toml`
- Formatting: `cargo fmt --manifest-path dsp/Cargo.toml --all --check`
- Frog equivalents: `frog repo check sensehub`, `frog repo test sensehub`,
  `frog repo lint sensehub`.

Keep generated Cargo output ignored. Firmware has no pinned board/core or
validated compilation target yet. Host DSP checks do not verify firmware.

## Evidence and semantics

`docs/formant-ridge-research.md` records the sourced research and proposed
mathematics. Distinguish raw spectral ridges, envelope maxima, resonance model
parameters, and fundamental frequency. Label proposed algorithms and untested
features explicitly. Report missing observations separately from voicing and
predicted states. Keep citations and publication dates traceable.

Authentication is incomplete: `verifyEd25519()` currently fails closed. Do not
describe pairing, replay resistance, or credential transport as operational.
