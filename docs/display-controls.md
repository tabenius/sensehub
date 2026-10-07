# Spectrum and cepstrum display controls

Status: implemented in the standalone [browser prototype](../ui/README.md).
The desktop app shell and device transport are pending. The prototype uses
measured cepstral-envelope −3 dB edges for bandwidth, not LPC pole widths.

## Requested controls

- Show/hide formant center markers.
- Show/hide formant edge markers, independently of centers.
- Show/hide musical note names.
- Show/hide octave labels, independently of note names.
- Enable/disable hover information and select which information fields appear.

## Proposed spectrum presentation

For each tracked formant, show a center tick/line and two edge ticks/lines;
optionally shade the interval. Label the formant identity (F1, F2, etc.).
Retain separate fields for the observed evidence ridge center and the modeled
resonance frequency, as defined in `formant-ridge-research.md`.

Decision: Tobias requested **both search-range edges and estimated bandwidth
edges**, with separate visibility controls. Offer separately named overlays rather
than silently treating these quantities as interchangeable:

1. **Search range:** configured `[f_bottom, f_top]` limits. These constrain the
   tracker and need not move with its center.
2. **Estimated bandwidth:** model-derived resonance bandwidth, or a declared
   spectral-width criterion. A pole-based bandwidth is not automatically the
   exact half-power interval of a composite spectrum.

Use distinct marker styles and explicit legend/hover labels for both. Do not impose
symmetry around the center on measured spectral edges or use a confidence
interval as if it were resonance bandwidth.

Note and octave labels annotate frequencies, not detected musical content.
Proposed initial mapping: equal temperament with configurable reference pitch
(A4 = 440 Hz by default). Octave labels remain independently usable if note
names are hidden. These are display preferences, not DSP configuration.

## Cepstrum coordinate handling

A cepstrum uses quefrency (seconds or milliseconds), not frequency (Hz).
Consequently, spectrum center/edge frequencies cannot be drawn directly at
the same horizontal positions on a cepstrum. The reciprocal `1/f` is not a
general formant-marker transformation.

Proposed linked presentation: show the selected formant's center and edges in
a clearly labeled frequency readout alongside the cepstrum. If a spectral
envelope is reconstructed from a liftered cepstrum and plotted against Hz,
that frequency-axis view can carry the spectrum markers normally.
Actual cepstral peaks receive quefrency markers and labels.

## Selectable hover fields

Provide a master hover toggle and individually selectable fields:

| Field | Spectrum | Cepstrum |
|---|---|---|
| Position | Hz | Quefrency in ms |
| Value | Declared magnitude/power/dB convention | Declared cepstral coefficient convention |
| Frame/time | Timestamp and frame index | Timestamp and frame index |
| Musical annotation | Nearest note, octave, cents offset | Only for an explicitly defined pitch-period interpretation |
| Formant detail | Identity, ridge/resonance center, search limits, estimated bandwidth | Linked frequency readout, not axis-position inference |
| Evidence/status | Noise-relative evidence, uncertainty when available; observed/predicted/missing | Corresponding linked estimate status |
| Analysis settings | FFT/window/hop and smoothing | Cepstrum type, log convention and liftering settings |

Hide unavailable fields rather than fabricating values. A predicted/coasted
marker should be visually distinguishable from an observed one; missing
estimates should not produce a false center. Keep tooltip selection separate
from marker visibility, so labels can be hidden while details remain inspectable.
Touch/keyboard inspection should expose the same selected information as hover.

## Implementation checkpoint

The prototype has spectrum overlays, saved display preferences, and a linked
frequency-valued readout alongside the real cepstrum. Both search-range and
measured-bandwidth edges are available. Future production work should connect
the Rust analysis pipeline and add validated resonance/trajectory estimates.
