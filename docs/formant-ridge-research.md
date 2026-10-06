# Track Formants Without Mistaking Harmonic Ridges

**Use bounded-band Gaussian evidence with global multi-candidate decoding, but use spectral-envelope or resonance-model evidence before labelling the result a formant.** Raw STFT power maxima can track excitation harmonics while the vocal tract remains unchanged. The requested estimator has a rigorous discrete formulation, including center argmax, epsilon rejection, temporal continuity, slides, jumps and gaps; the complete construction below is a **SenseHub implementation proposal**, not a published validated algorithm. First-difference L1 regularization permits jumps but does not guarantee smooth slides, so compare Huber motion and second-order continuity with an explicit jump mixture. Missing observations must remain distinct from unvoiced speech, and overlapping formant bands require joint ordering and candidate identity constraints. Primary literature supports classical, neural and hybrid alternatives, but incompatible evaluation protocols prevent a universal state-of-the-art ranking.

Scope: synthesis of all three supplied notes, with no earlier research. Evidence cutoff is **6 October 2026**; key publication dates were rechecked against primary proceedings and arXiv records. No models, local experiments or latency benchmarks were run.

## Gaussian evidence locates a spectral maximum, not necessarily a resonance

Let real samples \(x[n]\) have sample rate \(F_s\). Choose hop \(H\), real nonzero window \(w[r]\), length \(L\), FFT length \(N\ge L\), and \(U=\sum_r w[r]^2\). For full valid frames, define the unnormalized forward STFT and center timestamp by

\[
X_{m,k}=\sum_{r=0}^{L-1}x[mH+r]w[r]e^{-2\pi i kr/N},
\qquad t_m=\frac{mH+(L-1)/2}{F_s}.
\]

Use one-sided bins \(k=0,\ldots,\lfloor N/2\rfloor\), frequencies \(f_k=kF_s/N\), \(\Delta f=F_s/N\), and \(\Delta t=H/F_s\). Let \(d_k=2\) except at DC and, for even \(N\), Nyquist, where \(d_k=1\). Define

\[
P_{m,k}=\frac{d_k|X_{m,k}|^2}{F_sU},\qquad A_{m,k}=\sqrt{P_{m,k}}.
\]

Here \(P\) is a periodogram-like power density, in sample-amplitude-squared/Hz; \(A\) is square-root density, not calibrated sinusoidal amplitude. Parseval gives

\[
\sum_k P_{m,k}\Delta f
=\frac{\sum_r|x[mH+r]w[r]|^2}{U}.
\]

Thus band-integrated power measures a mean-square contribution, whereas the normalized Gaussian statistic below remains a density. FFT zero-padding refines the sampling grid without extending the observation. Recording-edge padding needs a declared extension rule and validity mask; invented zeros are not observed silence.

For track \(j\), declare a bounded band \(B_j=[b_j,u_j]\subset(0,F_s/2]\), center grid \(\mathcal F_j\subset B_j\), and width \(\sigma_j>0\). Write \(M_j(k)=\mathbf1\{f_k\in B_j\}\) and \(G_j(f_k-c)=\exp[-(f_k-c)^2/(2\sigma_j^2)]\). With observed-frame validity \(V_q\) and temporal weights \(T_m(q)\ge0\), set

\[
W_{j,m,c}(q,k)=V_qT_m(q)M_j(k)G_j(f_k-c)\Delta t\Delta f,
\quad Z_{j,m}(c)=\sum_{q,k}W_{j,m,c}(q,k),
\quad \alpha=\frac{W}{Z}.
\]

Only \(Z>0\) defines evidence. Initially use \(T_m(q)=\mathbf1\{q=m\}\); a temporal Gaussian alternative is \(T_m(q)=\exp[-(t_q-t_m)^2/(2\sigma_t^2)]\mathbf1\{|q-m|\le R\}\), with \(\sigma_t>0\) and declared finite support \(R\). Define power and magnitude alternatives by

\[
E^{(2)}_{j,m}(c)=\sum_{q,k}\alpha_{j,m,c}(q,k)P_{q,k},
\qquad E^{(1)}_{j,m}(c)=\sum_{q,k}\alpha_{j,m,c}(q,k)A_{q,k}.
\]

**Normalize after masking.** This preserves constant fields at band edges rather than penalizing centers with truncated kernels. It neither reconstructs excluded frequencies nor guarantees unbiased peak positions; reduced edge support affects uncertainty. For stationary kernels on uniform grids this is normalized convolution/correlation of the masked power field, schematically \((G*(MP))/(G*M)\), not convolution of the complex FFT followed by squaring.

More precisely, with \(z_{q,k}=\sqrt{d_k/(F_sU)}X_{q,k}\),

\[
E^{(2)}=\|\sqrt\alpha\,z\|_2^2,
\qquad E^{(1)}=\|\alpha z\|_1.
\]

**To obtain Gaussian power weights \(G\), multiply FFT coefficients by \(\sqrt G\), not \(G\):** \(\|GX\|_2^2=\sum G^2|X|^2\). A complex dot product \(\sum GX\) permits phase cancellation and is a different observable. Also \(E^{(1)}\le\sqrt{E^{(2)}}\), generally strictly: averaging magnitude is not taking the square root of averaged power. Norm and squared norm share the argmax but require different threshold units. Averaged log power defines yet another statistic.

The literal local estimator is

\[
\widehat c^{\rm local}_{j,m}\in\operatorname*{argmax}_{c\in\mathcal F_j}E^{(p)}_{j,m}(c),\qquad p\in\{1,2\}.
\]

Choose a deterministic tie rule or retain a plateau interval. This estimates a **mode of a smoothed statistic**, not the band centroid. Hz Gaussian width, log-frequency width and plotting coordinates are separate choices. A log-shaped kernel integrated over Hz still uses \(\Delta f\); integration over \(v=\log(f/f_*)\) uses log-bin widths. A density transformed to that coordinate requires \(P_v=fP_f\) to conserve power.

Speech spectra combine excitation, vocal-tract response and radiation/recording effects. High F0 sparsely samples the envelope at harmonics; no smoothing width or longer FFT creates excitation between them. CheapTrick provides an F0-adaptive envelope candidate, while LPC/ARMA or source-aware methods target resonance parameters. Envelope maxima and pole-angle frequencies are themselves distinct targets. A Gaussian waveform window, Gaussian spectrogram averaging, Gaussian-derivative peak localization and Gaussian probability labels are four different operations ([source–filter account](https://newt.phys.unsw.edu.au/jw/voice.html); [CheapTrick, 2015](https://doi.org/10.1016/j.specom.2014.09.003); [KARMA](https://arxiv.org/html/1107.0076)).

## Global continuity needs calibrated rejection, slide priors and explicit resets

An absolute gate \(\max_c E^{(p)}(c)>\epsilon_{\rm abs}\) is well-defined only with the selected statistic's units and gain convention; otherwise return missing. Prefer a noise-relative gate as well. For power evidence, let \(b_m(c)\) be independently estimated noise density averaged with the **same** \(\alpha\), and \(\eta>0\) a numerical floor in density units. Define

\[
Q_m(c)=\frac{E^{(2)}_m(c)+\eta}{b_m(c)+\eta},\qquad
\mathcal C_m=\{c\in\mathcal F_j:\ c\text{ is a local maximum},\ Q_m(c)\ge1+\epsilon_{\rm snr},\ E^{(2)}_m(c)\ge E_{\min}\}.
\]

Here \(\epsilon_{\rm snr}>0\) is dimensionless; \(E_{\min}\) rejects silence artifacts. Sideband medians can instead provide background **contrast**, but do not then interpret \(Q-1\) as physical SNR. Calibrate false detections after maximizing across the band, including correlated frames and boundary kernels. No universal epsilon follows from the literature. A hard gate excludes weak true candidates; soft evidence plus absence is preferable when retaining low-SNR hypotheses matters.

Retain multiple candidates rather than only the framewise argmax. One proposed emission is \(D_m(c)=-\operatorname{clip}(\log Q_m(c)-\tau,-r_-,r_+)\), with validation-tuned constants and absence cost \(D_m(\varnothing)=g_m\). Clipping limits domination by isolated bursts. For finite states \(\mathcal S_m=\mathcal C_m\cup\{\varnothing\}\), minimize

\[
J(s)=\pi(s_1)+\sum_mD_m(s_m)+\sum_{m\ge2}C_m(s_{m-1},s_m).
\]

Initialization \(V_1(s)=\pi(s)+D_1(s)\), recursion

\[
V_m(s)=D_m(s)+\min_{a\in\mathcal S_{m-1}}[V_{m-1}(a)+C_m(a,s)],
\]

and backtracking produce a **global minimizer of the declared discrete objective**. Generic complexity is \(O(MK^2)\) for \(K\) states per frame. This does not establish physical correctness, continuous-frequency optimality or calibrated probabilities. Restricting states to maxima can exclude a weak ridge entirely; a full-grid ablation tests that restriction. Whole-path ridge optimization has direct published precedent ([Iatsenko et al., manuscript 2013, revision 2015](https://arxiv.org/html/1310.7276v3)).

Choose \(u(f)=f\) or \(\log_2(f/f_*)\), declare scale \(s_u\), and let \(d=(u(c)-u(a))/s_u\). L1 motion \(C=\lambda|d|\) allows jumps but **cannot prefer a gradual monotone slide to a single jump with the same endpoints**: both have total variation \(|u_{\mathrm{end}}-u_{\mathrm{start}}|\). Scalar TV often produces plateaus. Huber motion \(\lambda h_\delta(d)\), with \(h_\delta(d)=d^2/2\) for \(|d|\le\delta\) and \(\delta(|d|-\delta/2)\) otherwise, better distinguishes small distributed motion from concentrated changes. For sustained slides, compare a velocity state or second-order penalty on \(u_m-2u_{m-1}+u_{m-2}\); L1 second differences encourage piecewise-linear trends. This requires augmented DP history, and acceleration penalties must reset at jumps/gaps ([L1 trend filtering, 2009](https://web.stanford.edu/~boyd/papers/l1_trend_filter.html)).

Make jumps explicit rather than weakening continuity everywhere. A normalized discrete transition proposal is

\[
p(c\mid a)=(1-\rho_m)\frac{\exp[-\lambda h_\delta(d)]}{\sum_{v\in\mathcal F_j}\exp[-\lambda h_\delta((u(v)-u(a))/s_u)]}
+\rho_m q_m(c),\qquad C_m(a,c)=-\log p(c\mid a),
\]

where \(q_m\) is a broad normalized restart distribution. A second-order variant conditions the ordinary component on predicted velocity. Marginalizing jump identity uses this mixture; joint MAP over an explicit event takes a minimum of component negative-log costs, a different estimator. Capped L1 is a simpler alternative, but can encourage component switching. For hazard \(h\) per second, use \(\rho_m=1-e^{-h\Delta t}\). Finite-band transition normalization depends on predecessor location; dropping it changes probabilistic MAP. Handcrafted contrast emissions remain scores unless an observation model is calibrated.

Fix hop-size conventions too: discretizing \(\int\ell(t,u(t))dt+\lambda\operatorname{TV}(u)\) gives \(\Delta t\sum_m\ell_m+\lambda\sum_m|\Delta u_m|\), not TV divided by \(\Delta t\). Integrated squared velocity instead gives \(\sum_m(\Delta u_m)^2/\Delta t\). Innovation-model scales require their own time dependence. Temporal L1, spectral-magnitude L1 and prediction-residual L1 penalize different objects.

Give gaps separate entry, duration and exit costs. Tune their balance against emissions so neither filling silence nor abstaining everywhere is optimal by construction. One null state forgets frequency, potentially allowing a cheap jump via absence. To preserve identity across short losses, retain last frequency, velocity if used, and elapsed gap duration, with widening reconnection uncertainty and a maximum memory horizon; after that, restart. Show **observed estimate, predicted/coasted state and unsupported absence differently**. Voicing cannot supply this decision alone: whispered vowels retain envelope structure, while silence does not; fricative peaks need different interpretation. KARMA explicitly discusses coasting, absent states and reinitialization ([KARMA, observability discussion](https://arxiv.org/html/1107.0076)).

For F1–F3, use joint ordered states and common candidate-region identities. Enforce ascending frequencies among all visible labels, including nonadjacent labels when an intermediate formant is missing, and prohibit duplicate use of one unresolved spectral blob. Any positive separation margin is a tunable prior, not physiology. Merged peaks should produce ambiguity or missingness rather than forced separation. Joint states increase combinatorial cost but prevent independent band trackers selecting the same peak ([Praat combination-state tracking](https://www.fon.hum.uva.nl/praat/manual/Formant__Track___.html); [conditional heatmap masking](https://arxiv.org/html/2206.11632)).

## Formant advances improve different parts of the inference problem

**Burg/LPC plus temporal decoding remains the essential reproducible baseline.** Praat's Burg command estimates candidates; its separate tracking command uses reference-frequency, relative-bandwidth and absolute log-frequency transition costs. Tracking requires sufficient candidates in every frame and lacks an explicit gap state. Report ceiling, pre-emphasis, order and actual window support: Praat's 25 ms effective setting uses a 50 ms Gaussian-like window. Robust LPC uses selective sample weighting; covariance LPC and QCP offer different source/noise assumptions, rather than a universal robustness guarantee ([Burg documentation](https://www.fon.hum.uva.nl/praat/manual/Sound__To_Formant__burg____.html); [tracking](https://www.fon.hum.uva.nl/praat/manual/Formant__Track___.html); [robust LPC](https://www.fon.hum.uva.nl/praat/manual/Sound__To_Formant__robust____.html)).

KARMA observes ARMA cepstra and tracks resonance/antiresonance frequencies and bandwidths with extended Kalman filtering/smoothing and model-conditional covariance. Its journal publication is **2012**, preprint 2011. TVQCP, journal **2020** but uploaded to arXiv in 2023, combines quasi-closed-phase weighting, sparse prediction residuals and polynomial time-varying LP over longer windows. Its L1 acts on **sample prediction residuals**, not trajectory increments. It tests synthetic and natural speech, including high-F0 conditions; no uniform superiority of L1 over L2 follows ([KARMA record](https://arxiv.org/abs/1107.0076); [TVQCP record and manuscript](https://arxiv.org/abs/2308.16540)).

The verified neural progression includes supervised feed-forward/recurrent estimation in **2016**, noncausal gated/dilated TCNs in **2020**, unsupervised FormantNet spectral reconstruction in **2021**, and conditional probability heatmaps in **2022**. FormantNet predicts poles/zeros and associated parameters from source-reduced envelopes; unsupervised training still imposes preprocessing and model assumptions. Heatmaps retain alternate frequency hypotheses, making them particularly suitable as proposed decoder evidence, but the paper's inference uses bin maxima, not the Gaussian/jump/gap objective above ([Deep learning](https://www.isca-archive.org/interspeech_2016/dissen16_interspeech.html); [TCN](https://www.isca-archive.org/interspeech_2020/dai20_interspeech.html); [FormantNet](https://www.isca-archive.org/interspeech_2021/lilley21_interspeech.html); [heatmaps](https://www.isca-archive.org/interspeech_2022/shrem22_interspeech.html)).

A **2023** hybrid refines DeepFormants outputs by snapping to nearby covariance-LP/QCP-FB spectral peaks without retraining. Its Gaussian derivative operates on an all-pole spectrum, not raw STFT energy integration. The verified **Interspeech 2026** LP-DDSP/SMELP paper optimizes or predicts interpretable log-area ratios with differentiable LP; its temporal coefficient regularization is squared L2. Utterance-level LP-DDSP optimization does not establish interactive latency ([2023 refinement](https://arxiv.org/abs/2308.09051); [2026 proceedings](https://www.isca-archive.org/interspeech_2026/luisi26_interspeech.html)).

| Primary evaluation | Reported F1/F2/F3 errors, Hz | Interpretation |
|---|---|---|
| 2022 heatmaps, framewise VTR vowels | MAE **57/75/95**, DeepFormants 54/81/112 | Heatmaps do not win F1; vowel-segment averaging is a separate task ([Table 1](https://arxiv.org/html/2206.11632)). |
| 2023 refinement, VTR vowels+diphthongs+semivowels | MAE **60/103/119** with QCP-FB, DeepFormants 85/120/143 | Matched-subset acoustic refinement evidence; gains do not hold for every phonetic class/noise condition ([Tables 1–3](https://arxiv.org/html/2308.09051)). |
| 2026 SMELP, selected VTR phonemes, 192 test utterances | RMSE **100/141/195**, LP-LSTM 107/145/183 | SMELP does not win F3; the paper's overall metric includes less securely annotated F4 ([Table 1](https://www.isca-archive.org/interspeech_2026/luisi26_interspeech.pdf)). |

These are **not commensurate leaderboard scores**. MAE, RMSE, MAPE, frame masks and segment averaging differ. VTR counts also differ: its original record describes 538 sentences, while several studies use 516 and a 324/192 split; the heatmap study reports 346/192. Pin release and manifests, not a silently harmonized count. Natural annotations are corrected estimates, not anatomical ground truth. Recent synthesis/source–filter preprints and citation-only 2025 leads do not supply verified tracking superiority; the bounded review establishes no universal latest winner ([original VTR record](https://www.microsoft.com/en-us/research/publication/a-database-of-vocal-tract-resonance-trajectories-for-research-in-speech-processing/); [2022 protocol](https://arxiv.org/html/2206.11632); [2023 protocol](https://arxiv.org/html/2308.09051)).

## Pitch and sharpened ridges answer complementary questions

For F0, compare **pYIN (2014), CREPE (2018) and PENN/FCNF0++** for isolated speech/singing; YIN (2002) is an interpretable lightweight baseline. pYIN adds candidate probabilities and sequence decoding; identify the implementation because maintained software differs from the original paper. CREPE uses waveform CNN inference. PENN is the package, with cross-domain pitch and entropy-based periodicity estimation; its paper record starts in January 2023 and was revised in August 2024. Hardware throughput is not input-to-display latency ([pYIN](https://doi.org/10.1109/ICASSP.2014.6853678); [implementation](https://raw.githubusercontent.com/librosa/librosa/main/librosa/core/pitch.py); [CREPE](https://arxiv.org/abs/1802.06182); [PENN](https://arxiv.org/abs/2301.12258)).

RMVPE (**Interspeech 2023**) targets one lead-vocal pitch per frame in accompaniment, not general multipitch. It uses a bidirectional recurrent layer; its comparisons against separated-vocal pipelines are not identical-input estimator comparisons. Relative Interval Networks, submitted **30 September 2026**, remain a preprint **submitted to ICASSP 2027**, not an accepted 2027 publication. RIN fits absolute F0 and measured nonzero multi-hop intervals using weighted L1/network-flow optimization. It offers a useful contrast to penalizing every change toward zero, but strong estimators do not benefit consistently and low-SNR babble can corrupt relative evidence ([RMVPE](https://arxiv.org/html/2306.15412v2); [RIN status](https://arxiv.org/abs/2609.39852); [RIN method](https://arxiv.org/html/2609.39852v1)).

For oscillatory ridges, Iatsenko Scheme I combines log-amplitude evidence with absolute frequency-change cost; Scheme II adapts robust frequency/increment statistics. DP is exact conditional on those statistics, not a proof of global convergence of the outer fixed-point iteration. Reassignment and synchrosqueezing use phase-derived localization rather than magnitude alone. The original SST theorem assumes separated, slowly varying AM/FM components; arbitrary crossings, jumps and tract-envelope resonances are outside that guarantee. Sharper harmonic pictures do not prove better formant inference ([Iatsenko dates](https://arxiv.org/abs/1310.7276); [reassignment, 1995](https://doi.org/10.1109/78.382394); [SST manuscript, December 2009](https://arxiv.org/html/0912.2437v1)).

## A matched-evidence SenseHub experiment can separate accuracy from appearance

**First compare evidence fields under the same decoder:** raw power, magnitude, cepstral/Burg envelopes, QCP candidates and learned heatmaps. Then hold evidence fixed and compare local argmax, L1 DP, Huber/second-order motion and jump-mixture/gap decoding. Ablate Gaussian widths, thresholds, band edges, gap memory and joint identity constraints. Use known-resonance source–filter synthesis with independently varied F0, phonation, slides, jumps, merged peaks and missing excitation, followed by a pinned VTR test manifest and representative SenseHub recordings. Keep speaker-disjoint validation; synthetic resonance truth and natural label agreement answer different questions.

Report per-formant MAE/RMSE, explicit thresholded detection criteria, coverage, false tracks, identity swaps, false gap bridging, boundary timing and errors stratified by F0, phonetic class and noise. For pitch include cents and octave errors plus voicing precision/recall; chroma accuracy hides octave mistakes. Inspect uncertainty calibration separately from entropy/path margins. Keep measured power, F0/voicing and model-derived formants as distinct display layers.

At center timestamps, the STFT plus a temporal kernel extending \(R\) future hops needs at least

\[
\frac{L-1}{2F_s}+R\frac{H}{F_s}
\]

of lookahead before compute/buffering; add decoder commitment lag and neural context requirements, accounting for overlapping dependencies. Frequency-only smoothing has no extra future-frame dependency. Full-record backtracking is offline; fixed-lag output changes the estimator. Benchmark causal and bounded-lookahead versions separately, measuring median/tail input-to-display delay on deployment hardware. No numerical latency target is justified without SenseHub's budget.

## Conclusion

The decisive test is whether a contour remains tied to a known tract resonance when excitation harmonics move independently. That intervention distinguishes resonance recovery from visually convincing ridge following more directly than increasing display resolution or regularization strength. SenseHub should preserve alternative candidates and explicit unsupported intervals so that this test remains inspectable; smoothness is then a controlled inference assumption rather than evidence of correctness.

Provenance: research notes at `/srv/users/xyzzy/AGENTS/research_notes/Formant ridge tracking methods/`; evidence cutoff `2026-10-06`.
