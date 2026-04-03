use std::path::Path;

use figment::{
    Figment,
    providers::{Env, Format, Toml},
};
use serde::Deserialize;

use crate::types::HotPathError;

#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub paper_mode: bool,
    #[serde(default = "default_ws")]
    pub ws_url: String,
    #[serde(default = "default_info")]
    pub info_url: String,
    #[serde(default = "default_exchange")]
    pub exchange_url: String,

    #[serde(default)]
    pub assets: Vec<String>,
    #[serde(default)]
    pub allowlist: Vec<String>,

    #[serde(default = "default_return_window")]
    pub return_window_ms: u64,
    #[serde(default = "default_lookback")]
    pub pca_lookback_periods: usize,
    #[serde(default = "default_factors")]
    pub num_factors: usize,
    #[serde(default = "default_tick")]
    pub tick_interval_ms: u64,
    #[serde(default = "default_refresh")]
    pub pca_refresh_periods: usize,

    #[serde(default = "default_entry_z")]
    pub entry_z_score: f64,
    #[serde(default = "default_stop_loss")]
    pub stop_loss_bps: f64,
    #[serde(default = "default_max_hold")]
    pub max_hold_ms: u64,
    #[serde(default = "default_min_vol")]
    pub min_volatility_bps: f64,
    #[serde(default = "default_min_pc1")]
    pub min_pc1_return_bps: f64,

    #[serde(default = "default_base_size")]
    pub base_notional_usd: f64,
    #[serde(default = "default_max_positions")]
    pub max_positions: usize,
    #[serde(default = "default_leverage")]
    pub leverage: u32,

    #[serde(default)]
    pub database_url: String,
    #[serde(default)]
    pub private_key: String,
}

fn default_ws() -> String {
    "wss://api.hyperliquid.xyz/ws".to_owned()
}
fn default_info() -> String {
    "https://api.hyperliquid.xyz/info".to_owned()
}
fn default_exchange() -> String {
    "https://api.hyperliquid.xyz/exchange".to_owned()
}
fn default_return_window() -> u64 {
    60000
}
fn default_lookback() -> usize {
    60
}
fn default_factors() -> usize {
    2
}
fn default_tick() -> u64 {
    60000
}
fn default_refresh() -> usize {
    15
}
fn default_entry_z() -> f64 {
    2.75
}
fn default_stop_loss() -> f64 {
    150.0
}
fn default_max_hold() -> u64 {
    3600000
}
fn default_min_vol() -> f64 {
    125.0
}
fn default_min_pc1() -> f64 {
    25.0
}
fn default_base_size() -> f64 {
    200.0
}
fn default_max_positions() -> usize {
    3
}
fn default_leverage() -> u32 {
    3
}

impl AppConfig {
    pub fn load() -> Result<Self, HotPathError> {
        let path = std::env::var("HL_PCA_CONFIG").unwrap_or_else(|_| "hl-pca.toml".to_owned());

        let mut figment = Figment::new();
        if Path::new(&path).exists() {
            figment = figment.merge(Toml::file(&path));
        }
        figment = figment.merge(
            Env::raw()
                .only(&["HL_PCA_DATABASE_URL"])
                .map(|_| "database_url".into()),
        );

        let config: Self = figment
            .extract()
            .map_err(|e| HotPathError::Config(e.to_string()))?;

        tracing::info!(
            paper = config.paper_mode,
            assets = config.assets.len(),
            allowlist = config.allowlist.len(),
            entry_z = config.entry_z_score,
            min_vol = config.min_volatility_bps,
            "config loaded"
        );
        Ok(config)
    }
}
