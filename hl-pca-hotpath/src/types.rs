use thiserror::Error;

#[derive(Debug, Error)]
pub enum HotPathError {
    #[error("config: {0}")]
    Config(String),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("WS: {0}")]
    Ws(String),
    #[error("DB: {0}")]
    Db(String),
    #[error("exchange: {0}")]
    Exchange(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegimeState {
    Bullish,
    Bearish,
    Neutral,
}

impl std::fmt::Display for RegimeState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bullish => write!(f, "bullish"),
            Self::Bearish => write!(f, "bearish"),
            Self::Neutral => write!(f, "neutral"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitReason {
    ZeroCross,
    StopLoss,
    TimeStop,
    TrailingStop,
}

impl std::fmt::Display for ExitReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ZeroCross => write!(f, "zero_cross"),
            Self::StopLoss => write!(f, "stop_loss"),
            Self::TimeStop => write!(f, "time_stop"),
            Self::TrailingStop => write!(f, "trailing_stop"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ActivePosition {
    pub asset: String,
    pub entry_price: f64,
    pub entry_z: f64,
    pub size_usd: f64,
    pub entered_at: chrono::DateTime<chrono::Utc>,
    pub peak_pnl_bps: f64,
    pub trough_pnl_bps: f64,
}

impl ActivePosition {
    pub fn pnl_bps(&self, current_price: f64) -> f64 {
        // Short: profit when price goes down
        (self.entry_price - current_price) / self.entry_price * 10000.0
    }

    pub fn hold_ms(&self) -> i64 {
        (chrono::Utc::now() - self.entered_at).num_milliseconds()
    }
}
