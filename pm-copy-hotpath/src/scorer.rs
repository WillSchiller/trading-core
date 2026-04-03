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

struct ModelInstance {
    name: String,
    session: ort::session::Session,
    calibration: Option<Calibration>,
    features: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ModelScore {
    pub raw_prob: f64,
    pub cal_prob: f64,
    pub kelly_size: f64,
    pub pass: bool,
}

pub struct Scorer {
    models: Vec<ModelInstance>,
    trader_stats: AHashMap<String, TraderRollingStats>,
    market_counts: AHashMap<String, usize>,
    max_kelly_frac: f64,
    bankroll: f64,
    min_bet: f64,
    primary_model: usize,
}

impl Scorer {
    pub fn new(config: &AppConfig) -> Self {
        Self {
            models: Vec::new(),
            trader_stats: AHashMap::new(),
            market_counts: AHashMap::new(),
            max_kelly_frac: config.max_kelly_fraction,
            bankroll: config.bankroll_usd,
            min_bet: config.min_bet_usd,
            primary_model: 0,
        }
    }

    pub fn start(&mut self, config: &AppConfig) -> Result<(), String> {
        let model_defs = [
            (
                "v2",
                "/app/models/pm_scorer_v2.onnx",
                "/app/models/pm_v2_calibration.json",
                "/app/models/pm_v2_features.json",
            ),
            (
                "v3",
                "/app/models/pm_scorer_v3.onnx",
                "/app/models/pm_v3_calibration.json",
                "/app/models/pm_v3_features.json",
            ),
            (
                "v4",
                "/app/models/pm_scorer_v4.onnx",
                "/app/models/pm_v4_calibration.json",
                "/app/models/pm_v4_features.json",
            ),
        ];

        for (name, model_path, cal_path, feat_path) in &model_defs {
            if !Path::new(model_path).exists() {
                info!(model = name, "model file not found, skipping");
                continue;
            }
            let session = ort::session::Session::builder()
                .map_err(|e| e.to_string())?
                .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
                .map_err(|e| e.to_string())?
                .commit_from_file(model_path)
                .map_err(|e| e.to_string())?;

            let calibration = if Path::new(cal_path).exists() {
                let data = std::fs::read_to_string(cal_path).map_err(|e| e.to_string())?;
                #[derive(serde::Deserialize)]
                struct CalData {
                    x: Vec<f64>,
                    y: Vec<f64>,
                }
                let cal: CalData = serde_json::from_str(&data).map_err(|e| e.to_string())?;
                Some(Calibration { x: cal.x, y: cal.y })
            } else {
                None
            };

            let features: Vec<String> = if Path::new(feat_path).exists() {
                let data = std::fs::read_to_string(feat_path).map_err(|e| e.to_string())?;
                serde_json::from_str(&data).map_err(|e| e.to_string())?
            } else {
                vec![]
            };

            info!(model = name, n_features = features.len(), "loaded");
            self.models.push(ModelInstance {
                name: name.to_string(),
                session,
                calibration,
                features,
            });
        }

        // Primary model is the last one loaded (v4 preferred)
        if !self.models.is_empty() {
            self.primary_model = self.models.len() - 1;
            // Also try loading from config path for backwards compat
        }

        if self.models.is_empty() && !config.onnx_model_path.is_empty() {
            let p = Path::new(&config.onnx_model_path);
            if p.exists() {
                let session = ort::session::Session::builder()
                    .map_err(|e| e.to_string())?
                    .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
                    .map_err(|e| e.to_string())?
                    .commit_from_file(p)
                    .map_err(|e| e.to_string())?;
                let calibration = if !config.calibration_path.is_empty()
                    && Path::new(&config.calibration_path).exists()
                {
                    let data = std::fs::read_to_string(&config.calibration_path)
                        .map_err(|e| e.to_string())?;
                    #[derive(serde::Deserialize)]
                    struct CalData {
                        x: Vec<f64>,
                        y: Vec<f64>,
                    }
                    let cal: CalData = serde_json::from_str(&data).map_err(|e| e.to_string())?;
                    Some(Calibration { x: cal.x, y: cal.y })
                } else {
                    None
                };
                info!(model = %config.onnx_model_path, "fallback model loaded");
                self.models.push(ModelInstance {
                    name: "config".to_string(),
                    session,
                    calibration,
                    features: vec![],
                });
            }
        }

        info!(count = self.models.len(), "scorer ready");
        Ok(())
    }

    pub fn is_enabled(&self) -> bool {
        !self.models.is_empty()
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
        category: &str,
        outcome_name: &str,
        market_slug: &str,
    ) -> ScoreResult {
        if self.models.is_empty() {
            return ScoreResult {
                win_score: 1.0,
                cal_prob: 0.5,
                kelly_size: 0.0,
                pass: true,
            };
        }

        let stats = self.trader_stats.get(&signal.trader);
        let all_features = build_all_features(
            signal,
            category,
            outcome_name,
            market_slug,
            stats,
            &mut self.market_counts,
        );

        let mut all_scores: std::collections::HashMap<String, ModelScore> =
            std::collections::HashMap::new();
        let mut primary_result = ScoreResult {
            win_score: 0.5,
            cal_prob: 0.5,
            kelly_size: 0.0,
            pass: false,
        };

        for (i, model) in self.models.iter_mut().enumerate() {
            let features = select_features(&all_features, &model.features);
            let n = features.len();
            if n == 0 {
                continue;
            }

            let input = match ort::value::Tensor::from_array(([1usize, n], features)) {
                Ok(t) => t,
                Err(e) => {
                    warn!(model = %model.name, error = %e, "tensor creation failed");
                    continue;
                }
            };
            let outputs = match model.session.run(ort::inputs![input]) {
                Ok(o) => o,
                Err(e) => {
                    warn!(model = %model.name, error = %e, "inference error");
                    continue;
                }
            };

            let raw_prob = extract_prob(&outputs);
            let cal_prob = match &model.calibration {
                Some(cal) => cal.interpolate(raw_prob),
                None => raw_prob,
            };
            let payoff = (1.0 / signal.price.max(0.01)) - 1.0;
            let raw_f = (cal_prob - (1.0 - cal_prob) / payoff).clamp(0.0, 0.25);
            let kelly_f = (raw_f.powi(3) / (0.25_f64.powi(2))).min(self.max_kelly_frac);
            let kelly_size = (self.bankroll * kelly_f * 100.0).round() / 100.0;
            let pass = kelly_size >= self.min_bet;

            let score = ModelScore {
                raw_prob,
                cal_prob,
                kelly_size,
                pass,
            };
            if i == self.primary_model {
                primary_result = ScoreResult {
                    win_score: raw_prob,
                    cal_prob,
                    kelly_size,
                    pass,
                };
            }
            all_scores.insert(model.name.clone(), score);
        }

        if let Ok(json) = serde_json::to_string(&all_scores) {
            debug!(
                trader = %signal.trader,
                scores = %json,
                "multi-model scored"
            );
        }

        primary_result
    }

    pub fn score_all_json(
        &mut self,
        signal: &TradeSignal,
        category: &str,
        outcome_name: &str,
        market_slug: &str,
    ) -> (ScoreResult, String) {
        if self.models.is_empty() || self.primary_model >= self.models.len() {
            return (
                ScoreResult {
                    win_score: 1.0,
                    cal_prob: 0.5,
                    kelly_size: 0.0,
                    pass: true,
                },
                "{}".to_string(),
            );
        }

        let stats = self.trader_stats.get(&signal.trader);
        let all_features = build_all_features(
            signal,
            category,
            outcome_name,
            market_slug,
            stats,
            &mut self.market_counts,
        );

        let model = &mut self.models[self.primary_model];
        let features = select_features(&all_features, &model.features);
        let n = features.len();
        if n == 0 {
            return (
                ScoreResult {
                    win_score: 0.5,
                    cal_prob: 0.5,
                    kelly_size: 0.0,
                    pass: false,
                },
                "{}".to_string(),
            );
        }

        let input = match ort::value::Tensor::from_array(([1usize, n], features)) {
            Ok(t) => t,
            Err(e) => {
                warn!(model = %model.name, error = %e, "tensor creation failed");
                return (
                    ScoreResult {
                        win_score: 0.5,
                        cal_prob: 0.5,
                        kelly_size: 0.0,
                        pass: false,
                    },
                    "{}".to_string(),
                );
            }
        };
        let outputs = match model.session.run(ort::inputs![input]) {
            Ok(o) => o,
            Err(e) => {
                warn!(model = %model.name, error = %e, "inference error");
                return (
                    ScoreResult {
                        win_score: 0.5,
                        cal_prob: 0.5,
                        kelly_size: 0.0,
                        pass: false,
                    },
                    "{}".to_string(),
                );
            }
        };

        let raw_prob = extract_prob(&outputs);
        let cal_prob = match &model.calibration {
            Some(cal) => cal.interpolate(raw_prob),
            None => raw_prob,
        };
        let payoff = (1.0 / signal.price.max(0.01)) - 1.0;
        let raw_f = (cal_prob - (1.0 - cal_prob) / payoff).clamp(0.0, 0.25);
        let kelly_f = (raw_f.powi(3) / (0.25_f64.powi(2))).min(self.max_kelly_frac);
        let kelly_size = (self.bankroll * kelly_f * 100.0).round() / 100.0;
        let pass = kelly_size >= self.min_bet;

        let mut scores = std::collections::HashMap::new();
        scores.insert(
            model.name.clone(),
            ModelScore {
                raw_prob,
                cal_prob,
                kelly_size,
                pass,
            },
        );
        let json = serde_json::to_string(&scores).unwrap_or_else(|_| "{}".to_string());

        (
            ScoreResult {
                win_score: raw_prob,
                cal_prob,
                kelly_size,
                pass,
            },
            json,
        )
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

fn build_all_features(
    signal: &TradeSignal,
    category: &str,
    outcome_name: &str,
    market_slug: &str,
    stats: Option<&TraderRollingStats>,
    market_counts: &mut AHashMap<String, usize>,
) -> AHashMap<String, f32> {
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

    let o = outcome_name.to_lowercase();
    let is_no = (o == "no" || o == "under" || o == "draw" || o == "down") as u8 as f32;
    let is_favourite = if p >= 0.5 { 1.0f32 } else { 0.0 };

    let mut m = AHashMap::new();
    m.insert("entry_price".to_string(), p as f32);
    m.insert("price_dist_from_half".to_string(), (p - 0.5).abs() as f32);
    m.insert(
        "implied_edge".to_string(),
        if p < 0.5 { 1.0 - p as f32 } else { p as f32 },
    );
    m.insert("payoff_ratio".to_string(), (1.0 / p.max(0.01) - 1.0) as f32);
    m.insert("is_no".to_string(), is_no);
    m.insert("is_favourite".to_string(), is_favourite);
    m.insert(
        "is_no_underdog".to_string(),
        if is_no > 0.5 && p < 0.5 { 1.0 } else { 0.0 },
    );
    m.insert(
        "is_no_favourite".to_string(),
        if is_no > 0.5 && p >= 0.5 { 1.0 } else { 0.0 },
    );
    m.insert(
        "is_yes_underdog".to_string(),
        if is_no < 0.5 && p < 0.5 { 1.0 } else { 0.0 },
    );
    m.insert(
        "is_yes_favourite".to_string(),
        if is_no < 0.5 && p >= 0.5 { 1.0 } else { 0.0 },
    );
    m.insert(
        "cat_sports".to_string(),
        if category == "SPORTS" { 1.0 } else { 0.0 },
    );
    m.insert(
        "cat_crypto".to_string(),
        if category == "CRYPTO" { 1.0 } else { 0.0 },
    );
    m.insert(
        "cat_politics".to_string(),
        if category == "POLITICS" { 1.0 } else { 0.0 },
    );
    m.insert("hour".to_string(), hour);
    m.insert("dow".to_string(), dow);
    m.insert("size_vs_median".to_string(), size_vs_median as f32);
    m.insert("roll_wr_20".to_string(), roll_wr_20 as f32);
    m.insert("roll_pf_20".to_string(), roll_pf_20 as f32);
    m.insert("roll_wr_50".to_string(), roll_wr_50 as f32);
    m.insert("roll_pf_50".to_string(), roll_pf_50 as f32);
    m.insert("roll_avg_pnl_20".to_string(), roll_avg_pnl_20 as f32);
    m.insert("roll_streak".to_string(), roll_streak as f32);
    m.insert("lifetime_wr".to_string(), lifetime_wr as f32);
    m.insert("lifetime_pf".to_string(), lifetime_pf as f32);
    m.insert("trade_num".to_string(), total_trades as f32);
    m.insert("market_trader_count".to_string(), market_count as f32);
    // v2-specific
    m.insert("is_5min".to_string(), 0.0); // we filter these out
    // v3-specific (defaults when not available)
    m.insert("is_binary_market".to_string(), 1.0);
    m.insert(
        "neg_risk".to_string(),
        if signal.neg_risk { 1.0 } else { 0.0 },
    );
    // Time to resolution: extract date from market slug
    let time_to_res = extract_hours_from_slug(market_slug) as f32;
    let time_to_res_log = (1.0 + time_to_res).ln();
    let implied_edge = if p < 0.5 { 1.0 - p as f32 } else { p as f32 };

    m.insert("time_to_resolution".to_string(), time_to_res);
    m.insert("time_to_resolution_log".to_string(), time_to_res_log);
    m.insert("price_x_time".to_string(), p as f32 * time_to_res_log);
    m.insert("edge_x_time".to_string(), implied_edge * time_to_res_log);
    m.insert("price_momentum".to_string(), 0.0);
    m.insert("trader_category_wr".to_string(), lifetime_wr as f32);
    m
}

fn extract_hours_from_slug(slug: &str) -> f64 {
    if let Ok(re) = regex::Regex::new(r"(\d{4}-\d{2}-\d{2})")
        && let Some(caps) = re.captures(slug)
        && let Ok(date) = chrono::NaiveDate::parse_from_str(&caps[1], "%Y-%m-%d")
    {
        let now = chrono::Utc::now().naive_utc().date();
        let days = (date - now).num_days();
        if days > 0 {
            return days as f64 * 24.0;
        }
    }
    24.0
}

fn select_features(all: &AHashMap<String, f32>, feature_list: &[String]) -> Vec<f32> {
    feature_list
        .iter()
        .map(|f| *all.get(f).unwrap_or(&0.0))
        .collect()
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
