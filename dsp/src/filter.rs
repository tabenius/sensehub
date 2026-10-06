//! Frequency selection and smoothing.
//!
//! Bandpass follows the RBJ cookbook (constant 0 dB peak gain). Smoothing is
//! a one-pole lowpass plus a plain moving average. Both are deliberately
//! boring: textbook recurrences, no hidden state across blocks except the
//! documented filter memory.

use std::f64::consts::PI;

/// Second-order bandpass, RBJ constant-peak-gain form.
/// `center_hz` and `bandwidth_hz` describe the -3 dB points approximately.
pub struct Bandpass {
    b0: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl Bandpass {
    pub fn new(sample_rate: f64, center_hz: f64, bandwidth_hz: f64) -> Self {
        assert!(sample_rate > 0.0 && center_hz > 0.0 && bandwidth_hz > 0.0);
        assert!(center_hz < sample_rate / 2.0, "center above Nyquist");
        let w0 = 2.0 * PI * center_hz / sample_rate;
        let alpha = (PI * bandwidth_hz / sample_rate).sin();
        let a0 = 1.0 + alpha;
        Self {
            b0: alpha / a0,
            b2: -alpha / a0,
            a1: -2.0 * w0.cos() / a0,
            a2: (1.0 - alpha) / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    pub fn reset(&mut self) {
        self.x1 = 0.0;
        self.x2 = 0.0;
        self.y1 = 0.0;
        self.y2 = 0.0;
    }

    #[inline]
    pub fn step(&mut self, x0: f64) -> f64 {
        let y0 = self.b0 * x0 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x0;
        self.y2 = self.y1;
        self.y1 = y0;
        y0
    }

    pub fn process(&mut self, input: &[f64], output: &mut [f64]) {
        assert_eq!(input.len(), output.len());
        for (i, &x) in input.iter().enumerate() {
            output[i] = self.step(x);
        }
    }
}

/// One-pole lowpass smoother. `cutoff_hz` is the -3 dB point, approximately.
pub struct OnePole {
    alpha: f64,
    state: f64,
    init: bool,
}

impl OnePole {
    pub fn new(sample_rate: f64, cutoff_hz: f64) -> Self {
        assert!(sample_rate > 0.0 && cutoff_hz > 0.0);
        let rc = 1.0 / (2.0 * PI * cutoff_hz);
        let dt = 1.0 / sample_rate;
        Self { alpha: dt / (rc + dt), state: 0.0, init: false }
    }

    pub fn reset(&mut self) {
        self.init = false;
        self.state = 0.0;
    }

    #[inline]
    pub fn step(&mut self, x: f64) -> f64 {
        if !self.init {
            self.state = x;
            self.init = true;
        } else {
            self.state += self.alpha * (x - self.state);
        }
        self.state
    }
}

/// Causal moving average over the last `window` samples.
pub struct MovingAverage {
    window: Vec<f64>,
    sum: f64,
    pos: usize,
    filled: usize,
}

impl MovingAverage {
    pub fn new(window: usize) -> Self {
        assert!(window > 0);
        Self { window: vec![0.0; window], sum: 0.0, pos: 0, filled: 0 }
    }

    pub fn step(&mut self, x: f64) -> f64 {
        let n = self.window.len();
        self.sum -= self.window[self.pos];
        self.window[self.pos] = x;
        self.sum += x;
        self.pos = (self.pos + 1) % n;
        if self.filled < n {
            self.filled += 1;
        }
        self.sum / self.filled as f64
    }

    pub fn reset(&mut self) {
        self.window.iter_mut().for_each(|v| *v = 0.0);
        self.sum = 0.0;
        self.pos = 0;
        self.filled = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn energy(signal: &[f64]) -> f64 {
        signal.iter().map(|v| v * v).sum::<f64>() / signal.len() as f64
    }

    fn sine(freq: f64, rate: f64, n: usize) -> Vec<f64> {
        (0..n).map(|i| (2.0 * PI * freq * i as f64 / rate).sin()).collect()
    }

    #[test]
    fn bandpass_keeps_center_and_rejects_edges() {
        let rate = 8000.0;
        let n = 4096;
        let center = sine(1000.0, rate, n);
        let low = sine(100.0, rate, n);
        let high = sine(3900.0, rate, n);
        let mut out = vec![0.0; n];
        let mut bp = Bandpass::new(rate, 1000.0, 400.0);
        bp.process(&center, &mut out);
        let e_center = energy(&out[1024..]);
        bp.reset();
        bp.process(&low, &mut out);
        let e_low = energy(&out[1024..]);
        bp.reset();
        bp.process(&high, &mut out);
        let e_high = energy(&out[1024..]);
        assert!(e_center > 0.25, "center should pass substantially, got {e_center}");
        assert!(e_low < e_center / 20.0, "100 Hz should be rejected, got {e_low}");
        assert!(e_high < e_center / 20.0, "3900 Hz should be rejected, got {e_high}");
    }

    #[test]
    fn smoothers_track_a_step_without_overshoot() {
        let mut one = OnePole::new(1000.0, 10.0);
        let mut ma = MovingAverage::new(16);
        let mut y1 = 0.0;
        let mut y2 = 0.0;
        for i in 0..400 {
            let x = if i < 100 { 0.0 } else { 1.0 };
            y1 = one.step(x);
            y2 = ma.step(x);
        }
        for (y, name) in [(y1, "one-pole"), (y2, "moving-average")] {
            assert!(y > 0.9 && y <= 1.0, "{name} settled at {y}");
        }
        // Step onset must not overshoot: check the transient peak.
        let mut one = OnePole::new(1000.0, 10.0);
        let peak = (0..400).map(|i| one.step(if i < 100 { 0.0 } else { 1.0 })).fold(0.0_f64, f64::max);
        assert!(peak <= 1.0, "one-pole overshot to {peak}");
    }

    #[test]
    fn moving_average_rejects_stale_data_after_reset() {
        let mut ma = MovingAverage::new(4);
        for _ in 0..10 {
            ma.step(5.0);
        }
        ma.reset();
        assert_eq!(ma.step(2.0), 2.0);
    }
}
