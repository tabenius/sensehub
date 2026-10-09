# SenseHub ↔ remote-android — audio capture and a signal projection adapter

Status: **proposal**, low priority. Nothing here is implemented. The
coordinating tasks are in frog: `sensehub-dsp-spec-reconciliation` (p2),
`sensehub-audio-projection-adapter`, `remote-android-mic-capture`,
`remote-android-audio-decode-path`, and `sensehub-live-mic-streaming` (all p3).

## The idea

Capture microphone (and camera) on an Android device through `remote-android`,
then tie that capture to SenseHub so real signals can be inspected in the DSP
surface, with SenseHub as the analysis and channel-lab view.

Two halves already exist and are close to connecting.

**Capture — `remote-android`.** `src/remote_android/core/recorder.py` already
writes sessions to disk with a manifest (`session.json`: sources, codec, timing,
log `seq` range) alongside `video.mp4` and `frames/`. `models.py` already
declares `Source.AUDIO` and carries a `mic` flag on device and stream state, and
`recorder.py` already maps audio codecs to containers (`aac`→`m4a`, `opus`,
`flac`, `raw`→`wav`).

**Analysis — SenseHub.** `ui/signal.js` does dependency-free FFT, cepstrum,
envelope peaks and formant marking over decoded audio; `dsp/` is the real Rust
crate (framing, bandpass, LPC, TV); `proxy/server.mjs` re-exports channel blocks
over HTTP and SSE at `/api/channels` and `/api/events`.

**The seam exists.** `ui/app.js` exposes a frozen host hook:

```js
window.sensehubAudio = Object.freeze({ setVirtualSamples: (data, rate, name) => { … } });
```

It was written for injecting a synthetic signal, and it is already the interface
a capture feed needs.

## Shape

```
Android mic ──record──▶ session dir (audio.m4a / .wav)
                          │ session.json  ← the join key
                          ▼
              projection adapter (decode → Float32Array + rate)
                          ▼
        window.sensehubAudio.setVirtualSamples(…)
                          ▼
   ┌──────────────────────┴───────────────────────┐
   ▼                                              ▼
spectrum / cepstrum bench              proxy /api/channels
   ▼                                              ▼
            sensehub/dsp/ crate, session scripts, channel lab
```

Three things to settle before writing it:

**Push or pull.** `setVirtualSamples` is push-shaped and takes a whole buffer,
which suits replaying a file but not a live mic. Live capture wants a streaming
path with a rolling window. Likely: files push once, live capture needs a second
entry point (`sensehub-live-mic-streaming`).

**Where decoding happens.** Nothing in the workspace decodes AAC or Opus to PCM.
If `ffmpeg` is not assumed on the host, decoding has to happen on the device and
ship as raw/wav — which changes the capture configuration, because `audio_codec`
is already a config knob. This is `remote-android-audio-decode-path`, and it
blocks the adapter.

**The manifest is the join key.** `session.json` records device identity, argv
and the log `seq` range — the natural correlation key between a capture and a
SenseHub channel record. `remote-android`'s own README calls the manifest "the
point". Do not invent a second correlation scheme.

## Reconcile the DSP before extending it

`doc.ragbaz` holds `src/pages/drafts/spec-phoneme-app.mdx`, a 263-line
specification for a **Tauri 2 offline audio-analysis app** — and it specifies
the pipeline `dsp/` implements:

| | Phoneme spec | SenseHub `dsp/` |
|---|---|---|
| sample rate | 16 kHz (44.1/48 kHz downsampled) | — |
| frame / hop | 25 ms (400) / 10 ms (160) | framing |
| window | Hamming | — |
| formants | LPC order 18 → Durbin–Levinson → roots → Hz | `dsp/src/lpc.rs` |
| source | live microphone (cpal/WASAPI) | `Source.AUDIO` upstream |

It also specifies MFCC (39-dim), YIN F0, voiced/unvoiced, an `AnalysisFrame` IPC
payload at 100 Hz, and a `StreamSinkRouter` for Icecast/RTMP/HLS. `spec-audio-sink.mdx`
(podcast/RSS publication) sits on the same draft shelf.

Two specifications of one DSP is how the same analysis gets written twice with
subtly different semantics. `sensehub-dsp-spec-reconciliation` is p2 for that
reason: the other four tasks may change shape depending on how it resolves.

## Dependencies as recorded in frog

```
remote-android-audio-decode-path ──┐
remote-android-mic-capture ────────┼─▶ sensehub-audio-projection-adapter ──▶ sensehub-live-mic-streaming
                                   │                                              ▲
                                   └──────────────────────────────────────────────┘
                                        (also depends on transport-mux-session)
```

`transport-mux-session` is an existing open `remote-android` task; the transport
stack is a prerequisite for streaming live audio.

## Deliberately not decided here

- Whether the Phoneme Tauri app is meant to become real. If it is, SenseHub's
  `dsp/` and the Tauri app should share one implementation rather than diverge.
- Whether the adapter belongs in SenseHub or in `remote-android`. It reads
  SenseHub's formats, so SenseHub is the more natural home, but it is driven by a
  capture concern.
- Live mic versus file replay as the first supported case.