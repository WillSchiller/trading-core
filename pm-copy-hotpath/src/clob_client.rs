//! Optional **CLOB market WebSocket** telemetry only — book / last trade / best bid-ask.
//!
//! Runs on a **separate** task from the RTDS hot path; never blocks `proxyWallet` → order logic.
//! See [`crate::rtds_listener`] and `WS_SCHEMA.md`.

use std::str::FromStr as _;

use futures::StreamExt as _;
use polymarket_client_sdk::clob::ws::Client as ClobWsClient;
use polymarket_client_sdk::types::U256;
use polymarket_client_sdk::ws::config::Config as WsConfig;
use tokio::sync::broadcast;
use tracing::{trace, warn};

use crate::config::AppConfig;
use crate::types::HotPathError;

pub async fn run_clob_market_telemetry(
    config: AppConfig,
    mut shutdown: broadcast::Receiver<()>,
) -> Result<(), HotPathError> {
    let endpoint = config.clob_ws_base_url.trim_end_matches('/');
    let ws = ClobWsClient::new(endpoint, WsConfig::default())
        .map_err(|e| HotPathError::Clob(e.to_string()))?;

    let ids: Result<Vec<U256>, _> = config
        .asset_ids
        .iter()
        .map(|s| U256::from_str(s))
        .collect();
    let asset_ids = ids.map_err(|e| HotPathError::Clob(e.to_string()))?;

    if asset_ids.is_empty() {
        return Err(HotPathError::Config(
            "clob_market_telemetry requires non-empty asset_ids".into(),
        ));
    }

    tracing::warn!(
        "CLOB market WS telemetry: no proxyWallet on public messages — see WS_SCHEMA.md"
    );

    if config.custom_feature_enabled {
        let stream = ws
            .subscribe_best_bid_ask(asset_ids)
            .map_err(|e| HotPathError::Clob(e.to_string()))?;
        let mut stream = Box::pin(stream);
        loop {
            tokio::select! {
                _ = shutdown.recv() => break Ok(()),
                next = stream.next() => {
                    match next {
                        None => break Ok(()),
                        Some(Ok(ev)) => trace!(?ev, "CLOB best_bid_ask"),
                        Some(Err(e)) => warn!(error = %e, "CLOB ws error"),
                    }
                }
            }
        }
    } else {
        let stream = ws
            .subscribe_last_trade_price(asset_ids)
            .map_err(|e| HotPathError::Clob(e.to_string()))?;
        let mut stream = Box::pin(stream);
        loop {
            tokio::select! {
                _ = shutdown.recv() => break Ok(()),
                next = stream.next() => {
                    match next {
                        None => break Ok(()),
                        Some(Ok(ev)) => trace!(?ev, "CLOB last_trade_price"),
                        Some(Err(e)) => warn!(error = %e, "CLOB ws error"),
                    }
                }
            }
        }
    }
}
