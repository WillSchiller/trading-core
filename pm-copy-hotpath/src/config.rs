//! TOML (optional `config.toml`, `pm-hotpath.toml`, `config/pm-hotpath.toml`) + environment (`PM_HOTPATH_`, `__` for nesting).

use std::path::{Path, PathBuf};

use figment::{Figment, providers::{Env, Format, Toml}};
use serde::Deserialize;

use crate::types::{FeedMode, HotPathError};

#[derive(Debug, Clone, Deserialize)]
pub struct AppConfig {
    /// `rtds_activity` | `clob_market_telemetry`
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
    /// Minimum score from trader JSON to copy (inclusive).
    #[serde(default = "default_threshold")]
    pub score_threshold: f64,
    /// USDC notional per copied BUY (before FAK).
    #[serde(default = "default_size_usd")]
    pub copy_size_usd: f64,
    #[serde(default = "default_min_entry")]
    pub min_entry_price: f64,
    #[serde(default = "default_max_entry")]
    pub max_entry_price: f64,
    /// Path to JSON map: `"0xabc...": 0.86`
    #[serde(default = "default_traders_json")]
    pub traders_json_path: PathBuf,
    /// CLOB asset ids (decimal strings) when `feed_mode = clob_market_telemetry`.
    #[serde(default)]
    pub asset_ids: Vec<String>,
    #[serde(default)]
    pub custom_feature_enabled: bool,
    /// If true, parse signals but never POST orders.
    #[serde(default)]
    pub dry_run: bool,
    /// EOA signature type (0) unless you use Polymarket proxy workflow.
    #[serde(default = "default_sig_type")]
    pub signature_type: u8,
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

fn default_threshold() -> f64 {
    0.5
}

fn default_size_usd() -> f64 {
    25.0
}

fn default_min_entry() -> f64 {
    0.15
}

fn default_max_entry() -> f64 {
    0.85
}

fn default_sig_type() -> u8 {
    0
}

fn default_traders_json() -> PathBuf {
    PathBuf::from("traders.json")
}

impl AppConfig {
    pub fn load() -> Result<Self, HotPathError> {
        let mut figment = Figment::new();
        if Path::new("config.toml").exists() {
            figment = figment.merge(Toml::file("config.toml"));
        }
        if Path::new("pm-hotpath.toml").exists() {
            figment = figment.merge(Toml::file("pm-hotpath.toml"));
        }
        if Path::new("config/pm-hotpath.toml").exists() {
            figment = figment.merge(Toml::file("config/pm-hotpath.toml"));
        }
        figment = figment.merge(Env::prefixed("PM_HOTPATH_").split("__"));

        figment.extract().map_err(|e| HotPathError::Config(e.to_string()))
    }

    pub fn feed_mode(&self) -> FeedMode {
        match self.feed_mode.to_lowercase().as_str() {
            "clob_market_telemetry" | "clob" => FeedMode::ClobMarketTelemetry,
            _ => FeedMode::RtdsActivity,
        }
    }
}
