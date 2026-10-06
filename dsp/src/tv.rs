//! Level analysis: total-variation denoising plus a hysteresis detector.
//!
//! The denoiser solves `min_x 1/2||x - y||^2 + lambda * TV(x)` with Chambolle's
//! projected-gradient dual iteration (fixed step, bounded memory, no tuning
//! beyond `lambda` and an iteration budget). It is iterative, not exact: the
//! doc comment says so, and the tests assert qualitative properties rather
//! than a closed form.
//!
//! The detector turns a (usually denoised) trace into timestamped crossings
//! between voltage bands with hysteresis, which is the entire "logic mode":
//! explicit thresholds, explicit dead zone, no hidden debouncing.

/// Denoise `signal` with total-variation weight `lambda`.
///
/// Larger `lambda` means fewer, flatter plateaus. `iterations` of 2000 is
/// plenty for the few-hundred-sample blocks the app handles; the cost is
/// linear per iteration.
pub fn tv_denoise(signal: &[f64], lambda: f64, iterations: usize) -> Vec<f64> {
    let n = signal.len();
    if n == 0 || lambda <= 0.0 {
        return signal.to_vec();
    }
    // Dual variables live on the n-1 interior edges; p[n-1] stays 0.
    let mut p = vec![0.0; n];
    let tau = 0.2; // <= 1/4 for the 1D divergence operator norm
    let scaled: Vec<f64> = signal.iter().map(|v| v / lambda).collect();
    // Simultaneous (Jacobi) sweeps, as published: every update reads the
    // previous sweep only. Sequential updates converge in practice but are a
    // different iteration, so the textbook form is kept for reviewability.
    let mut next = vec![0.0; n];
    for _ in 0..iterations {
        // g = grad(div(p) - y/lambda), then project p + tau*g onto [-1, 1].
        // div(p)_i = p_i - p_{i-1} with p[-1] = p[n-1] = 0.
        for i in 0..n - 1 {
            let pi = p[i];
            let pim = if i == 0 { 0.0 } else { p[i - 1] };
            let pip = if i + 1 < n - 1 { p[i + 1] } else { 0.0 };
            let d_i = pi - pim - scaled[i];
            let d_next = pip - pi - scaled[i + 1];
            next[i] = (pi + tau * (d_next - d_i)).clamp(-1.0, 1.0);
        }
        p[..n - 1].copy_from_slice(&next[..n - 1]);
    }
    // x = y - lambda * div(p)
    let mut x = vec![0.0; n];
    for i in 0..n {
        let pi = if i < n - 1 { p[i] } else { 0.0 };
        let pim = if i == 0 { 0.0 } else { p[i - 1] };
        x[i] = signal[i] - lambda * (pi - pim);
    }
    x
}

/// Count sign changes of successive differences (a staircase measure).
pub fn transition_count(signal: &[f64], epsilon: f64) -> usize {
    signal
        .windows(2)
        .filter(|w| (w[1] - w[0]).abs() > epsilon)
        .count()
}

#[derive(Debug, Clone, PartialEq)]
pub struct LogicEvent {
    /// Sample index of the crossing.
    pub index: usize,
    /// Level after the crossing: false = low band, true = high band.
    pub high: bool,
}

/// Hysteresis detector between two voltage bands.
///
/// The signal must cross fully into the opposite band before an event fires,
/// so noise loitering near one threshold cannot chatter. Thresholds are
/// caller-supplied and reported back: there is no auto-calibration hiding
/// the decision boundary.
pub struct LevelDetector {
    low_enter: f64,
    high_enter: f64,
    high: bool,
    armed: bool,
}

impl LevelDetector {
    /// `low_enter` must be below `high_enter`; the gap is the hysteresis.
    pub fn new(low_enter: f64, high_enter: f64) -> Self {
        assert!(low_enter < high_enter, "dead zone must be positive");
        Self { low_enter, high_enter, high: false, armed: false }
    }

    /// Feed one sample with its index. Returns an event on crossings only.
    /// The first sample arms the detector without firing.
    pub fn step(&mut self, index: usize, value: f64) -> Option<LogicEvent> {
        if !self.armed {
            self.high = value >= self.high_enter;
            self.armed = true;
            return None;
        }
        if !self.high && value >= self.high_enter {
            self.high = true;
            return Some(LogicEvent { index, high: true });
        }
        if self.high && value <= self.low_enter {
            self.high = false;
            return Some(LogicEvent { index, high: false });
        }
        None
    }

    pub fn reset(&mut self) {
        self.high = false;
        self.armed = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noisy_steps() -> Vec<f64> {
        // Deterministic pseudo-noise so the test is reproducible anywhere.
        let mut x = 0x12345678u32;
        let mut rand = move || {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            (x as f64) / (u32::MAX as f64) - 0.5
        };
        (0..240)
            .map(|i| {
                let level = if i < 80 {
                    0.2
                } else if i < 160 {
                    2.8
                } else {
                    0.2
                };
                level + rand() * 0.6
            })
            .collect()
    }

    #[test]
    fn tv_denoise_collapses_noise_into_two_plateaus() {
        let noisy = noisy_steps();
        assert!(transition_count(&noisy, 0.05) > 20);
        let clean = tv_denoise(&noisy, 0.6, 2000);
        assert_eq!(clean.len(), noisy.len());
        assert!(transition_count(&clean, 0.05) <= 4, "expected ~2 jumps");
        let lo: f64 = clean[10..70].iter().sum::<f64>() / 60.0;
        let hi: f64 = clean[90..150].iter().sum::<f64>() / 60.0;
        assert!((lo - 0.2).abs() < 0.15, "low plateau at {lo}");
        assert!((hi - 2.8).abs() < 0.15, "high plateau at {hi}");
    }

    #[test]
    fn tv_denoise_empty_and_trivial() {
        assert!(tv_denoise(&[], 1.0, 10).is_empty());
        assert_eq!(tv_denoise(&[1.0, 1.0], 0.0, 10), vec![1.0, 1.0]);
    }

    #[test]
    fn detector_fires_once_per_crossing_with_dead_zone() {
        let mut det = LevelDetector::new(1.0, 2.0);
        // Chatter inside the dead zone must not fire.
        let mut events = Vec::new();
        for (i, v) in [0.2, 0.5, 1.5, 1.9, 1.5, 1.9, 1.2, 2.5].iter().enumerate() {
            if let Some(e) = det.step(i, *v) {
                events.push(e);
            }
        }
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], LogicEvent { index: 7, high: true });
        // Falling back through the zone without reaching low: silence.
        assert!(det.step(8, 1.5).is_none());
        let down = det.step(9, 0.5);
        assert_eq!(down, Some(LogicEvent { index: 9, high: false }));
    }

    #[test]
    fn denoised_steps_drive_clean_logic_events() {
        let noisy = noisy_steps();
        let clean = tv_denoise(&noisy, 0.6, 2000);
        let mut det = LevelDetector::new(1.0, 2.0);
        let events: Vec<_> = clean.iter().enumerate().filter_map(|(i, &v)| det.step(i, v)).collect();
        assert_eq!(events.len(), 2, "one rise and one fall, got {events:?}");
        assert!(events[0].high && !events[1].high);
    }
}
