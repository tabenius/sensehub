//! Voice formants via linear prediction.
//!
//! Pipeline: windowed autocorrelation → Levinson-Durbin → all-pole model →
//! complex roots (Durand-Kerner) → resonances with plausible bandwidths.
//! Formants are reported as (frequency_hz, bandwidth_hz) pairs sorted by
//! frequency. This is analysis, not recognition: it says where spectral
//! energy concentrates, not which vowel anyone uttered.

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Complex {
    pub re: f64,
    pub im: f64,
}

impl Complex {
    fn norm2(self) -> f64 {
        self.re * self.re + self.im * self.im
    }
}

impl std::ops::Add for Complex {
    type Output = Self;
    fn add(self, o: Self) -> Self {
        Self { re: self.re + o.re, im: self.im + o.im }
    }
}

impl std::ops::Sub for Complex {
    type Output = Self;
    fn sub(self, o: Self) -> Self {
        Self { re: self.re - o.re, im: self.im - o.im }
    }
}

impl std::ops::Mul for Complex {
    type Output = Self;
    fn mul(self, o: Self) -> Self {
        Self { re: self.re * o.re - self.im * o.im, im: self.re * o.im + self.im * o.re }
    }
}

impl std::ops::Div for Complex {
    type Output = Self;
    fn div(self, o: Self) -> Self {
        let d = o.norm2().max(1e-300);
        Self { re: (self.re * o.re + self.im * o.im) / d, im: (self.im * o.re - self.re * o.im) / d }
    }
}

/// Biased autocorrelation lags 0..=order of a Hamming-windowed frame.
pub fn autocorrelation(frame: &[f64], order: usize) -> Vec<f64> {
    let n = frame.len();
    let mut windowed = vec![0.0; n];
    for (i, &v) in frame.iter().enumerate() {
        let w = 0.54 - 0.46 * (2.0 * std::f64::consts::PI * i as f64 / (n - 1).max(1) as f64).cos();
        windowed[i] = v * w;
    }
    (0..=order)
        .map(|lag| {
            let mut acc = 0.0;
            for i in 0..n.saturating_sub(lag) {
                acc += windowed[i] * windowed[i + lag];
            }
            acc / n.max(1) as f64
        })
        .collect()
}

/// Levinson-Durbin: autocorrelation lags into LPC coefficients a[1..=order].
/// Returns None on a degenerate (silent) frame rather than dividing by zero.
pub fn levinson_durbin(r: &[f64], order: usize) -> Option<Vec<f64>> {
    if r.is_empty() || r[0] <= 0.0 {
        return None;
    }
    let mut a = vec![0.0; order + 1];
    let mut prev = vec![0.0; order + 1];
    let mut e = r[0];
    for i in 1..=order {
        let mut acc = 0.0;
        for j in 1..i {
            acc += a[j] * r[i - j];
        }
        let k = (r[i] - acc) / e;
        if !k.is_finite() {
            return None;
        }
        // The update must read the previous order throughout: an in-place
        // ascending loop would reuse already-updated entries for j > i/2.
        prev.copy_from_slice(&a);
        a[i] = k;
        for j in 1..i {
            a[j] -= k * prev[i - j];
        }
        e *= 1.0 - k * k;
        if e <= 0.0 {
            return None;
        }
    }
    Some(a[1..].to_vec())
}

/// Durand-Kerner roots of 1 + a1 z^-1 + ... + aN z^-N, found as roots of
/// z^N + a1 z^{N-1} + ... + aN. Deterministic start, fixed iterations.
fn durand_kerner(coeffs: &[f64], iterations: usize) -> Vec<Complex> {
    let n = coeffs.len();
    if n == 0 {
        return vec![];
    }
    // Reversed polynomial: z^n - a1 z^{n-1} - ... - an. The minus signs are
    // load-bearing: prediction coefficients add past samples, so the pole
    // polynomial subtracts them.
    let mut poly = vec![0.0; n + 1];
    poly[0] = 1.0;
    for (i, &c) in coeffs.iter().enumerate() {
        poly[i + 1] = -c;
    }
    let eval_fwd = |z: Complex| {
        let mut acc = Complex { re: poly[0], im: 0.0 };
        for &c in &poly[1..] {
            acc = acc * z + Complex { re: c, im: 0.0 };
        }
        acc
    };
    let mut roots: Vec<Complex> = (0..n)
        .map(|i| {
            let angle = 2.0 * std::f64::consts::PI * (i as f64 + 0.5) / n as f64;
            Complex { re: 0.4 * angle.cos(), im: 0.4 * angle.sin() }
        })
        .collect();
    for _ in 0..iterations {
        for i in 0..n {
            let mut denom = Complex { re: 1.0, im: 0.0 };
            for (j, r) in roots.iter().enumerate() {
                if i != j {
                    denom = denom * (roots[i] - *r);
                }
            }
            if denom.norm2() > 1e-300 {
                roots[i] = roots[i] - eval_fwd(roots[i]) / denom;
            }
        }
    }
    roots
}

/// Resonances from LPC coefficients: (frequency_hz, bandwidth_hz).
///
/// Keeps upper-half-plane roots with radius in (0.5, 1.5) and frequencies in
/// 90..4000 Hz, bandwidth under 600 Hz. A root exactly on the unit circle is
/// measurement, not resonance; roots far inside are broad slopes.
pub fn formants(lpc: &[f64], sample_rate: f64) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    for r in durand_kerner(lpc, 400) {
        if r.im <= 1e-9 {
            continue;
        }
        let radius = r.norm2().sqrt();
        if !(0.5..1.5).contains(&radius) {
            continue;
        }
        let freq = r.im.atan2(r.re).abs() * sample_rate / (2.0 * std::f64::consts::PI);
        // Estimated roots can land a hair outside the unit circle; mirror
        // them rather than discarding a genuine resonance as "negative width".
        let bw = radius.ln().abs() * sample_rate / std::f64::consts::PI;
        if freq >= 90.0 && freq <= 4000.0 && bw > 0.0 && bw < 600.0 {
            out.push((freq, bw));
        }
    }
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    out
}

/// Convenience: frame → LPC order → formants. None on silence/degeneracy.
///
/// Model order adapts down (by twos, to a floor of 4) when a frame is nearly
/// singular at the requested order — strong resonances on a short frame can
/// drive the prediction error to zero before the order is reached. Adapting is
/// preferable to returning garbage coefficients; a degenerate frame still
/// returns None rather than a fabricated spectrum.
pub fn analyze(frame: &[f64], sample_rate: f64, order: usize) -> Option<Vec<(f64, f64)>> {
    let mut o = order.max(4);
    loop {
        let r = autocorrelation(frame, o);
        if let Some(a) = levinson_durbin(&r, o) {
            return Some(formants(&a, sample_rate));
        }
        if o <= 4 {
            return None;
        }
        o -= 2;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Synthesize an AR signal with known resonances: white-noise drive
    /// through a bank of two-pole resonators, then verify recovery.
    ///
    /// The drive must be white. A sparse impulse train makes the output
    /// perfectly periodic, concentrating all energy at harmonics of the
    /// repetition rate — a line spectrum that hides the resonances from any
    /// bin-based check and starves the autocorrelation of what it needs.
    fn white_noise(n: usize, seed: u32) -> Vec<f64> {
        let mut x = seed.max(1);
        (0..n)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (x as f64) / (u32::MAX as f64) * 2.0 - 1.0
            })
            .collect()
    }

    fn synth_resonances(fs: f64, n: usize, poles: &[(f64, f64)]) -> Vec<f64> {
        let drive = white_noise(n, 0xC0FFEE);
        let mut y = vec![0.0; n];
        let mut states: Vec<(f64, f64)> = poles.iter().map(|_| (0.0, 0.0)).collect();
        let coeffs: Vec<(f64, f64)> = poles
            .iter()
            .map(|&(f, bw)| {
                let r = (-std::f64::consts::PI * bw / fs).exp();
                let theta = 2.0 * std::f64::consts::PI * f / fs;
                (2.0 * r * theta.cos(), r * r)
            })
            .collect();
        for (i, &x) in drive.iter().enumerate() {
            let mut s = 0.0;
            for (k, (b1, b2)) in coeffs.iter().enumerate() {
                let (s1, s2) = states[k];
                let v = x + b1 * s1 - b2 * s2;
                states[k] = (v, s1);
                s += v;
            }
            y[i] = s;
        }
        y
    }

    #[test]
    fn recovers_synthetic_vowel_formants() {
        let fs = 8000.0;
        // Rough /a/: F1 730, F2 1090, F3 2440, bandwidths ~100 Hz.
        let signal = synth_resonances(fs, 2048, &[(730.0, 100.0), (1090.0, 110.0), (2440.0, 140.0)]);
        let found = analyze(&signal, fs, 12).expect("analysis failed");
        assert!(found.len() >= 2, "expected formants, got {found:?}");
        for &target in &[730.0, 1090.0] {
            let near = found.iter().any(|(f, _)| (f - target).abs() < 150.0);
            assert!(near, "missing formant near {target} in {found:?}");
        }
    }

    #[test]
    fn silence_yields_none_not_garbage() {
        assert!(analyze(&vec![0.0; 512], 8000.0, 10).is_none());
        assert!(analyze(&[], 8000.0, 10).is_none());
    }

    #[test]
    fn levinson_durbin_agrees_with_known_ar2() {
        // x[n] = 0.5 x[n-1] - 0.3 x[n-2] + e; autocorrelations are exact.
        let (a1, a2) = (0.5, -0.3);
        // Theoretical lags: r0 = 1 (normalized below), solve Yule-Walker directly.
        let r = vec![1.0, a1 / (1.0 - a2), a1 * a1 / (1.0 - a2) + a2];
        let a = levinson_durbin(&r, 2).expect("ld failed");
        assert!((a[0] - a1).abs() < 1e-9, "got {a:?}");
        assert!((a[1] - a2).abs() < 1e-9, "got {a:?}");
    }
}
