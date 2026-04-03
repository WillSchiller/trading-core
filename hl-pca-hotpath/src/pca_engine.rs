use ahash::AHashMap;
use nalgebra::{DMatrix, SymmetricEigen};
use tracing::{debug, info};

pub struct FactorModel {
    pub eigenvectors: Vec<Vec<f64>>,
    pub eigenvalues: Vec<f64>,
    pub variance_explained: Vec<f64>,
    pub asset_order: Vec<String>,
}

pub struct PcaEngine {
    num_factors: usize,
    lookback: usize,
    return_window_ms: u64,
    refresh_interval: usize,
    tick_count: usize,
    return_history: AHashMap<String, Vec<f64>>,
    residual_history: AHashMap<String, Vec<f64>>,
    ewma_mean: AHashMap<String, f64>,
    ewma_var: AHashMap<String, f64>,
    factor_model: Option<FactorModel>,
}

impl PcaEngine {
    pub fn new(
        num_factors: usize,
        lookback: usize,
        return_window_ms: u64,
        refresh_interval: usize,
    ) -> Self {
        Self {
            num_factors,
            lookback,
            return_window_ms,
            refresh_interval,
            tick_count: 0,
            return_history: AHashMap::new(),
            residual_history: AHashMap::new(),
            ewma_mean: AHashMap::new(),
            ewma_var: AHashMap::new(),
            factor_model: None,
        }
    }

    pub fn tick(
        &mut self,
        assets: &[String],
        price_history: &AHashMap<String, Vec<(f64, i64)>>,
    ) -> Option<AHashMap<String, AssetSignal>> {
        self.tick_count += 1;
        let now_ms = chrono::Utc::now().timestamp_millis();

        // Compute returns
        let mut returns: AHashMap<String, f64> = AHashMap::new();
        for asset in assets {
            if let Some(ret) = self.compute_return(asset, price_history, now_ms) {
                returns.insert(asset.clone(), ret);
            }
        }

        if returns.len() < assets.len() * 80 / 100 {
            debug!(
                have = returns.len(),
                need = assets.len() * 80 / 100,
                "not enough returns"
            );
            return None;
        }

        // Update return history
        for (asset, ret) in &returns {
            let hist = self.return_history.entry(asset.clone()).or_default();
            hist.push(*ret);
            if hist.len() > self.lookback {
                hist.drain(..hist.len() - self.lookback);
            }
        }

        // Refresh factor model periodically
        if self.factor_model.is_none() || self.tick_count % self.refresh_interval == 0 {
            let ordered_assets: Vec<String> = assets
                .iter()
                .filter(|a| {
                    self.return_history
                        .get(*a)
                        .is_some_and(|h| h.len() >= self.lookback * 80 / 100)
                })
                .cloned()
                .collect();

            if ordered_assets.len() >= 3 {
                if let Some(model) = self.fit_pca(&ordered_assets) {
                    info!(
                        assets = ordered_assets.len(),
                        var_explained = ?model.variance_explained,
                        "factor model updated"
                    );
                    self.factor_model = Some(model);
                }
            }
        }

        let model = self.factor_model.as_ref()?;

        // Compute factor returns and residuals
        let mut signals = AHashMap::new();
        let factor_returns = self.compute_factor_returns(model, &returns);

        for (i, asset) in model.asset_order.iter().enumerate() {
            let actual_ret = match returns.get(asset) {
                Some(r) => *r,
                None => continue,
            };

            let mut expected = 0.0;
            for (f, fr) in factor_returns.iter().enumerate() {
                expected += model.eigenvectors[f][i] * fr;
            }
            let residual = actual_ret - expected;

            // Update residual EWMA
            let alpha = 0.06;
            let mean = self.ewma_mean.entry(asset.clone()).or_insert(0.0);
            let var = self.ewma_var.entry(asset.clone()).or_insert(0.0);
            *mean = alpha * residual + (1.0 - alpha) * *mean;
            *var = alpha * residual * residual + (1.0 - alpha) * *var;
            let std = (*var - *mean * *mean).max(1e-10).sqrt();

            let z_score = if std > 1e-8 {
                (residual - *mean) / std
            } else {
                0.0
            };
            let ewma_vol_bps = std * 10000.0;

            signals.insert(
                asset.clone(),
                AssetSignal {
                    z_score,
                    residual,
                    ewma_vol_bps,
                    pc1_return: factor_returns.first().copied().unwrap_or(0.0),
                    pc2_return: factor_returns.get(1).copied().unwrap_or(0.0),
                },
            );
        }

        Some(signals)
    }

    fn compute_return(
        &self,
        asset: &str,
        history: &AHashMap<String, Vec<(f64, i64)>>,
        now_ms: i64,
    ) -> Option<f64> {
        let prices = history.get(asset)?;
        if prices.is_empty() {
            return None;
        }

        let target_ts = now_ms - self.return_window_ms as i64;
        let current = prices.last()?.0;

        // Find price closest to target_ts (binary search backward)
        let mut prev_price = None;
        for &(price, ts) in prices.iter().rev() {
            if ts <= target_ts {
                prev_price = Some(price);
                break;
            }
        }
        let prev = prev_price?;
        if prev <= 0.0 {
            return None;
        }

        Some((current - prev) / prev)
    }

    fn fit_pca(&self, assets: &[String]) -> Option<FactorModel> {
        let n = assets.len();
        let min_periods = self.lookback * 80 / 100;

        // Build return matrix
        let t = assets
            .iter()
            .filter_map(|a| self.return_history.get(a).map(|h| h.len()))
            .min()?;
        if t < min_periods {
            return None;
        }

        let mut matrix: Vec<f64> = Vec::with_capacity(t * n);
        let mut col_means = vec![0.0; n];

        for (j, asset) in assets.iter().enumerate() {
            let hist = self.return_history.get(asset)?;
            let start = hist.len().saturating_sub(t);
            for i in 0..t {
                let val = hist[start + i];
                col_means[j] += val;
            }
            col_means[j] /= t as f64;
        }

        // Build centered matrix and covariance
        let mut cov = vec![0.0; n * n];
        for i in 0..n {
            let hist_i = self.return_history.get(&assets[i])?;
            let start_i = hist_i.len().saturating_sub(t);
            for j in i..n {
                let hist_j = self.return_history.get(&assets[j])?;
                let start_j = hist_j.len().saturating_sub(t);
                let mut sum = 0.0;
                for k in 0..t {
                    sum +=
                        (hist_i[start_i + k] - col_means[i]) * (hist_j[start_j + k] - col_means[j]);
                }
                let val = sum / t as f64;
                cov[i * n + j] = val;
                cov[j * n + i] = val;
            }
        }

        let cov_matrix = DMatrix::from_row_slice(n, n, &cov);
        let eigen = SymmetricEigen::new(cov_matrix);

        // Sort eigenvalues descending
        let mut indices: Vec<usize> = (0..n).collect();
        indices.sort_by(|&a, &b| {
            eigen.eigenvalues[b]
                .partial_cmp(&eigen.eigenvalues[a])
                .unwrap()
        });

        let total_var: f64 = eigen.eigenvalues.iter().sum();
        let num_factors = self.num_factors.min(n);

        let mut eigenvectors = Vec::with_capacity(num_factors);
        let mut eigenvalues = Vec::with_capacity(num_factors);
        let mut var_explained = Vec::with_capacity(num_factors);

        for &idx in indices.iter().take(num_factors) {
            let ev: Vec<f64> = (0..n).map(|i| eigen.eigenvectors[(i, idx)]).collect();
            eigenvectors.push(ev);
            eigenvalues.push(eigen.eigenvalues[idx]);
            var_explained.push(eigen.eigenvalues[idx] / total_var * 100.0);
        }

        Some(FactorModel {
            eigenvectors,
            eigenvalues,
            variance_explained: var_explained,
            asset_order: assets.to_vec(),
        })
    }

    fn compute_factor_returns(
        &self,
        model: &FactorModel,
        returns: &AHashMap<String, f64>,
    ) -> Vec<f64> {
        let mut factor_returns = vec![0.0; model.eigenvectors.len()];
        for (f, ev) in model.eigenvectors.iter().enumerate() {
            for (i, asset) in model.asset_order.iter().enumerate() {
                if let Some(&ret) = returns.get(asset) {
                    factor_returns[f] += ev[i] * ret;
                }
            }
        }
        factor_returns
    }
}

#[derive(Debug, Clone)]
pub struct AssetSignal {
    pub z_score: f64,
    pub residual: f64,
    pub ewma_vol_bps: f64,
    pub pc1_return: f64,
    pub pc2_return: f64,
}
