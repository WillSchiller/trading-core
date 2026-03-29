//! Shared types and errors for the hot path.

use thiserror::Error;

/// Normalized signal used after WebSocket parse + optional filters (before order execution).
#[derive(Debug, Clone)]
pub struct TradeSignal {
    /// Lowercase `0x` proxy wallet (RTDS `proxyWallet`).
    pub trader: String,
    pub token_id: String,
    pub side: CopySide,
    pub price: f64,
    pub size: f64,
    pub condition_id: String,
    pub neg_risk: bool,
    pub dedup_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopySide {
    Buy,
    Sell,
}

#[derive(Debug, Error)]
pub enum HotPathError {
    #[error("config: {0}")]
    Config(String),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid address: {0}")]
    BadAddress(String),
    #[error("CLOB / auth: {0}")]
    Clob(String),
    #[error("DB: {0}")]
    Db(String),
}

impl From<polymarket_client_sdk::error::Error> for HotPathError {
    fn from(e: polymarket_client_sdk::error::Error) -> Self {
        HotPathError::Clob(e.to_string())
    }
}

/// Which ingress backend is active.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FeedMode {
    /// RTDS `activity` / `trades` (matches production TypeScript monitor).
    #[default]
    RtdsActivity,
    /// CLOB market WS — last trade / book only; **no** third-party wallet on public messages.
    ClobMarketTelemetry,
}
