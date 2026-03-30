use std::path::PathBuf;

use figment::{
    Figment,
    providers::{Env, Format, Toml},
};
use serde::Deserialize;

use crate::types::{FeedMode, HotPathError};

#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub feed_mode: String,
    #[serde(default = "default_rtds_url")]
    pub rtds_ws_url: String,
    #[serde(default = "default_clob_ws_base")]
    pub clob_ws_base_url: String,
    #[serde(default = "default_clob_http")]
    pub clob_http_url: String,
    #[serde(default = "default_gamma")]
    pub gamma_http_url: String,

    #[serde(default)]
    pub score_threshold: f64,
    #[serde(default = "default_size_usd")]
    pub copy_size_usd: f64,
    #[serde(default = "default_min_entry")]
    pub min_entry_price: f64,
    #[serde(default = "default_max_entry")]
    pub max_entry_price: f64,
    #[serde(default = "default_traders_json")]
    pub traders_json_path: PathBuf,
    #[serde(default)]
    pub asset_ids: Vec<String>,
    #[serde(default)]
    pub custom_feature_enabled: bool,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub signature_type: u8,
    #[serde(default)]
    pub database_url: String,

    #[serde(default = "default_execution_mode")]
    pub execution_mode: String,

    #[serde(default)]
    pub onnx_model_path: String,
    #[serde(default)]
    pub calibration_path: String,
    #[serde(default = "default_kelly_mult")]
    pub kelly_half_multiplier: f64,
    #[serde(default = "default_min_bet")]
    pub min_bet_usd: f64,
    #[serde(default = "default_max_kelly")]
    pub max_kelly_fraction: f64,
    #[serde(default = "default_bankroll")]
    pub bankroll_usd: f64,

    #[serde(default = "default_max_position")]
    pub max_position_usd: f64,
    #[serde(default = "default_max_exposure")]
    pub max_total_exposure_usd: f64,
    #[serde(default = "default_daily_loss")]
    pub daily_loss_limit_usd: f64,
    #[serde(default = "default_max_markets")]
    pub max_markets_open: usize,
    #[serde(default = "default_max_trades_per_market")]
    pub max_trades_per_market: usize,
    #[serde(default = "default_market_dedup_secs")]
    pub market_dedup_seconds: u64,

    #[serde(default = "default_resolution_poll")]
    pub resolution_poll_seconds: u64,
    #[serde(default = "default_auto_sell")]
    pub auto_sell_threshold: f64,
    #[serde(default = "default_stale_gtc")]
    pub stale_gtc_cancel_minutes: u64,
}

fn default_rtds_url() -> String {
    "wss://ws-live-data.polymarket.com".to_owned()
}
fn default_clob_ws_base() -> String {
    "wss://ws-subscriptions-clob.polymarket.com".to_owned()
}
fn default_clob_http() -> String {
    "https://clob.polymarket.com".to_owned()
}
fn default_gamma() -> String {
    "https://gamma-api.polymarket.com".to_owned()
}
fn default_size_usd() -> f64 {
    1.0
}
fn default_min_entry() -> f64 {
    0.15
}
fn default_max_entry() -> f64 {
    0.85
}
fn default_traders_json() -> PathBuf {
    PathBuf::from("traders.json")
}
fn default_execution_mode() -> String {
    "control".to_owned()
}
fn default_kelly_mult() -> f64 {
    0.5
}
fn default_min_bet() -> f64 {
    1.0
}
fn default_max_kelly() -> f64 {
    0.125
}
fn default_bankroll() -> f64 {
    60.0
}
fn default_max_position() -> f64 {
    25.0
}
fn default_max_exposure() -> f64 {
    250.0
}
fn default_daily_loss() -> f64 {
    30.0
}
fn default_max_markets() -> usize {
    999
}
fn default_max_trades_per_market() -> usize {
    3
}
fn default_market_dedup_secs() -> u64 {
    600
}
fn default_resolution_poll() -> u64 {
    60
}
fn default_auto_sell() -> f64 {
    0.995
}
fn default_stale_gtc() -> u64 {
    30
}

impl AppConfig {
    pub fn load() -> Result<Self, HotPathError> {
        let path =
            std::env::var("PM_HOTPATH_CONFIG").unwrap_or_else(|_| "pm-hotpath.toml".to_owned());

        let figment = Figment::new().merge(Toml::file(&path)).merge(
            Env::raw()
                .only(&["PM_HOTPATH_DATABASE_URL"])
                .map(|_| "database_url".into()),
        );

        let config: Self = figment
            .extract()
            .map_err(|e| HotPathError::Config(e.to_string()))?;

        config.log_summary();
        Ok(config)
    }

    pub fn feed_mode(&self) -> FeedMode {
        match self.feed_mode.to_lowercase().as_str() {
            "clob_market_telemetry" | "clob" => FeedMode::ClobMarketTelemetry,
            _ => FeedMode::RtdsActivity,
        }
    }

    fn log_summary(&self) {
        tracing::info!(
            mode = %self.execution_mode,
            copy_size = self.copy_size_usd,
            bankroll = self.bankroll_usd,
            max_position = self.max_position_usd,
            max_exposure = self.max_total_exposure_usd,
            daily_loss_limit = self.daily_loss_limit_usd,
            score_threshold = self.score_threshold,
            entry_range = %format!("{:.2}-{:.2}", self.min_entry_price, self.max_entry_price),
            dry_run = self.dry_run,
            "config loaded"
        );
    }
}
