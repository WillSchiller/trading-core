use crate::types::RegimeState;

pub struct RegimeDetector {
    ewma_mean: f64,
    ewma_var: f64,
    alpha: f64,
    threshold: f64,
    state: RegimeState,
    candidate: RegimeState,
    candidate_ticks: usize,
    hysteresis: usize,
}

impl RegimeDetector {
    pub fn new(ewma_span: usize, threshold: f64, hysteresis: usize) -> Self {
        let alpha = 2.0 / (ewma_span as f64 + 1.0);
        Self {
            ewma_mean: 0.0,
            ewma_var: 0.0,
            alpha,
            threshold,
            state: RegimeState::Neutral,
            candidate: RegimeState::Neutral,
            candidate_ticks: 0,
            hysteresis,
        }
    }

    pub fn update(&mut self, pc1_return: f64) -> RegimeState {
        self.ewma_mean = self.alpha * pc1_return + (1.0 - self.alpha) * self.ewma_mean;
        self.ewma_var = self.alpha * pc1_return * pc1_return + (1.0 - self.alpha) * self.ewma_var;
        let vol = (self.ewma_var - self.ewma_mean * self.ewma_mean)
            .max(1e-10)
            .sqrt();
        let momentum = self.ewma_mean / vol;

        let raw = if momentum > self.threshold {
            RegimeState::Bullish
        } else if momentum < -self.threshold {
            RegimeState::Bearish
        } else {
            RegimeState::Neutral
        };

        if raw == self.candidate {
            self.candidate_ticks += 1;
        } else {
            self.candidate = raw;
            self.candidate_ticks = 1;
        }

        if self.candidate_ticks >= self.hysteresis && self.candidate != self.state {
            self.state = self.candidate;
        }

        self.state
    }

    pub fn state(&self) -> RegimeState {
        self.state
    }
}
