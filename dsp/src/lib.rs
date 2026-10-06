//! Host-side DSP for the SenseHub companion app.
//!
//! Zero dependencies by design: this crate must build offline and stay
//! auditable by a reader with no ecosystem access. It implements the app side
//! of `docs/protocol.md` plus the analysis chain: bandpass → smoothing →
//! level/trend analysis → formants. Nothing here sends, stores, or publishes;
//! it transforms sample blocks handed to it.

pub mod framing;
pub mod filter;
pub mod tv;
pub mod lpc;
