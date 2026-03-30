use std::path::Path;

use ahash::AHashMap;
use tracing::{debug, info, warn};

use crate::config::AppConfig;
use crate::db::{FillDb, TraderRollingStats};
use crate::types::{ScoreResult, TradeSignal};

struct Calibration {
    x: Vec<f64>,
    y: Vec<f64>,
}

impl Calibration {
    fn interpolate(&self, raw: f64) -> f64 {
        if raw <= self.x[0] {
            return self.y[0];
        }
        if raw >= *self.x.last().unwrap() {
            return *self.y.last().unwrap();
        }
        for i in 0..self.x.len() - 1 {
            if raw >= self.x[i] && raw <= self.x[i + 1] {
                let t = (raw - self.x[i]) / (self.x[i + 1] - self.x[i]);
                return self.y[i] + t * (self.y[i + 1] - self.y[i]);
            }
        }
        raw
    }
}

pub struct Scorer {
    session: Option<ort::session::Session>,
    calibration: Option<Calibration>,
    trader_stats: AHashMap<String, TraderRollingStats>,
    market_counts: AHashMap<String, usize>,
    kelly_mult: f64,
    max_kelly_frac: f64,
    bankroll: f64,
    min_bet: f64,
}

impl Scorer {
    pub fn new(config: &AppConfig) -> Self {
        Self {
            session: None,
            calibration: None,
            trader_stats: AHashMap::new(),
            market_counts: AHashMap::new(),
            kelly_mult: config.kelly_half_multiplier,
            max_kelly_frac: config.max_kelly_fraction,
            bankroll: config.bankroll_usd,
            min_bet: config.min_bet_usd,
        }
    }

    pub fn start(&mut self, config: &AppConfig) -> Result<(), String> {
        if config.onnx_model_path.is_empty() {
            info!("no onnx_model_path configured — scoring disabled");
            return Ok(());
        }

        let model_path = Path::new(&config.onnx_model_path);
        if !model_path.exists() {
            warn!(path = %config.onnx_model_path, "ONNX model file not found — scoring disabled");
            return Ok(());
        }

        let session = ort::session::Session::builder()
            .map_err(|e| e.to_string())?
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
            .map_err(|e| e.to_string())?
            .commit_from_file(model_path)
            .map_err(|e| e.to_string())?;
        self.session = Some(session);

        if !config.calibration_path.is_empty() {
            let cal_path = Path::new(&config.calibration_path);
            if cal_path.exists() {
                let data = std::fs::read_to_string(cal_path).map_err(|e| e.to_string())?;
                #[derive(serde::Deserialize)]
                struct CalData {
                    x: Vec<f64>,
                    y: Vec<f64>,
                }
                let cal: CalData = serde_json::from_str(&data).map_err(|e| e.to_string())?;
                self.calibration = Some(Calibration { x: cal.x, y: cal.y });
                info!("calibration loaded");
            }
        }

        info!(model = %config.onnx_model_path, "ONNX scorer loaded");
        Ok(())
    }

    pub fn is_enabled(&self) -> bool {
        self.session.is_some()
    }

    pub async fn preload_trader_stats(&mut self, db: &FillDb, addresses: &[String]) {
        for addr in addresses {
            if self.trader_stats.contains_key(addr) {
                continue;
            }
            match db.get_trader_rolling_stats(addr).await {
                Ok(stats) => {
                    self.trader_stats.insert(addr.clone(), stats);
                }
                Err(e) => debug!(trader = addr, error = %e, "failed to load trader stats"),
            }
        }
    }

    pub fn score(
        &mut self,
        signal: &TradeSignal,
        trader_category: &str,
        outcome_name: &str,
    ) -> ScoreResult {
        let session = match &mut self.session {
            Some(s) => s,
            None => {
                return ScoreResult {
                    win_score: 1.0,
                    cal_prob: 0.5,
                    kelly_size: 0.0,
                    pass: true,
                };
            }
        };

        let stats = self.trader_stats.get(&signal.trader);
        let features = build_features(
            signal,
            trader_category,
            outcome_name,
            stats,
            &mut self.market_counts,
        );
        let n_features = features.len();

        let input = ort::value::Tensor::from_array(([1usize, n_features], features))
            .expect("ort tensor creation");

        let outputs = match session.run(ort::inputs![input]) {
            Ok(o) => o,
            Err(e) => {
                warn!(error = %e, "ONNX inference error — allowing trade");
                return ScoreResult {
                    win_score: 1.0,
                    cal_prob: 0.5,
                    kelly_size: 0.0,
                    pass: true,
                };
            }
        };

        let raw_prob = extract_prob(&outputs);

        let cal_prob = match &self.calibration {
            Some(cal) => cal.interpolate(raw_prob),
            None => raw_prob,
        };

        let entry_price = signal.price;
        let payoff = (1.0 / entry_price.max(0.01)) - 1.0;
        let kelly_f = (cal_prob - (1.0 - cal_prob) / payoff)
            .max(0.0)
            .min(self.max_kelly_frac)
            * self.kelly_mult;
        let kelly_size = (self.bankroll * kelly_f * 100.0).round() / 100.0;

        let pass = kelly_size >= self.min_bet;

        debug!(
            trader = %signal.trader,
            raw_prob = format!("{:.3}", raw_prob),
            cal_prob = format!("{:.3}", cal_prob),
            kelly_size = format!("{:.2}", kelly_size),
            pass,
            "scored"
        );

        ScoreResult {
            win_score: raw_prob,
            cal_prob,
            kelly_size,
            pass,
        }
    }

    pub fn update_trader_pnl(&mut self, trader: &str, pnl: f64) {
        if let Some(stats) = self.trader_stats.get_mut(trader) {
            stats.pnls.push(pnl);
            stats.total_trades += 1;
        }
    }
}

fn extract_prob(outputs: &ort::session::SessionOutputs<'_>) -> f64 {
    for name in &["probabilities", "output_probability"] {
        if let Some(val) = outputs.get(*name)
            && let Ok((_shape, data)) = val.try_extract_tensor::<f32>()
            && data.len() >= 2
        {
            return data[1] as f64;
        }
    }
    if let Some((_name, val)) = outputs.iter().next()
        && let Ok((_shape, data)) = val.try_extract_tensor::<f32>()
        && data.len() >= 2
    {
        return data[1] as f64;
    }
    0.5
}

use chrono::{Datelike, Timelike};

fn build_features(
    signal: &TradeSignal,
    category: &str,
    outcome_name: &str,
    stats: Option<&TraderRollingStats>,
    market_counts: &mut AHashMap<String, usize>,
) -> Vec<f32> {
    let p = signal.price;
    let mc = market_counts
        .entry(signal.condition_id.clone())
        .or_insert(0);
    *mc += 1;
    let market_count = *mc;

    let (
        roll_wr_20,
        roll_pf_20,
        roll_wr_50,
        roll_pf_50,
        roll_avg_pnl_20,
        roll_streak,
        lifetime_wr,
        lifetime_pf,
        total_trades,
        size_vs_median,
    ) = match stats {
        Some(s) => compute_rolling_stats(s, signal.size),
        None => (0.5, 1.0, 0.5, 1.0, 0.0, 0.0, 0.5, 1.0, 0.0, 1.0),
    };

    let now = chrono::Utc::now();
    let hour = now.hour() as f32;
    let dow = now.weekday().num_days_from_sunday() as f32;

    let is_no = {
        let o = outcome_name.to_lowercase();
        (o == "no" || o == "under" || o == "draw" || o == "down") as u8 as f32
    };
    let is_favourite = if p >= 0.5 { 1.0f32 } else { 0.0 };
    let is_no_underdog = if is_no > 0.5 && p < 0.5 { 1.0 } else { 0.0 };
    let is_no_favourite = if is_no > 0.5 && p >= 0.5 { 1.0 } else { 0.0 };
    let is_yes_underdog = if is_no < 0.5 && p < 0.5 { 1.0 } else { 0.0 };
    let is_yes_favourite = if is_no < 0.5 && p >= 0.5 { 1.0 } else { 0.0 };

    // Must match FEATURES order in train.py v4
    vec![
        p as f32,                                        // entry_price
        (p - 0.5).abs() as f32,                          // price_dist_from_half
        if p < 0.5 { 1.0 - p as f32 } else { p as f32 }, // implied_edge
        (1.0 / p.max(0.01) - 1.0) as f32,                // payoff_ratio
        is_no,
        is_favourite,
        is_no_underdog,
        is_no_favourite,
        is_yes_underdog,
        is_yes_favourite,
        if category == "SPORTS" { 1.0 } else { 0.0 }, // cat_sports
        if category == "CRYPTO" { 1.0 } else { 0.0 }, // cat_crypto
        if category == "POLITICS" { 1.0 } else { 0.0 }, // cat_politics
        hour,
        dow,
        size_vs_median as f32,
        roll_wr_20 as f32,
        roll_pf_20 as f32,
        roll_wr_50 as f32,
        roll_pf_50 as f32,
        roll_avg_pnl_20 as f32,
        roll_streak as f32,
        lifetime_wr as f32,
        lifetime_pf as f32,
        total_trades as f32,
        market_count as f32,
    ]
}

fn compute_rolling_stats(
    stats: &TraderRollingStats,
    trade_size: f64,
) -> (f64, f64, f64, f64, f64, f64, f64, f64, f64, f64) {
    let pnls = &stats.pnls;
    let n = pnls.len();

    let mut roll_wr_20 = 0.5;
    let mut roll_pf_20 = 1.0;
    let mut roll_wr_50 = 0.5;
    let mut roll_pf_50 = 1.0;
    let mut roll_avg_pnl_20 = 0.0;
    let mut roll_streak = 0.0;
    let mut lifetime_wr = 0.5;
    let mut lifetime_pf = 1.0;

    fn pf(pnls: &[f64]) -> f64 {
        let gw: f64 = pnls.iter().filter(|&&p| p > 0.0).sum();
        let gl: f64 = pnls.iter().filter(|&&p| p < 0.0).map(|p| p.abs()).sum();
        if gl > 0.0 {
            (gw / gl).min(10.0)
        } else if gw > 0.0 {
            10.0
        } else {
            0.0
        }
    }

    if n >= 20 {
        let recent = &pnls[n - 20..];
        roll_wr_20 = recent.iter().filter(|&&p| p > 0.0).count() as f64 / 20.0;
        roll_pf_20 = pf(recent);
        roll_avg_pnl_20 = recent.iter().sum::<f64>() / 20.0;
    }

    if n >= 50 {
        let recent = &pnls[n - 50..];
        roll_wr_50 = recent.iter().filter(|&&p| p > 0.0).count() as f64 / 50.0;
        roll_pf_50 = pf(recent);
    }

    if n > 0 {
        lifetime_wr = pnls.iter().filter(|&&p| p > 0.0).count() as f64 / n as f64;
        lifetime_pf = pf(pnls);

        let last_win = *pnls.last().unwrap() > 0.0;
        let mut streak = 0i32;
        for &p in pnls.iter().rev() {
            if (p > 0.0) == last_win {
                streak += 1;
            } else {
                break;
            }
        }
        roll_streak = if last_win {
            streak as f64
        } else {
            -(streak as f64)
        };
    }

    let size_vs_median = if stats.median_size > 0.0 {
        trade_size / stats.median_size
    } else {
        1.0
    };

    (
        roll_wr_20,
        roll_pf_20,
        roll_wr_50,
        roll_pf_50,
        roll_avg_pnl_20,
        roll_streak,
        lifetime_wr,
        lifetime_pf,
        n as f64,
        size_vs_median,
    )
}
