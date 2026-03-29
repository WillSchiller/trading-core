//! **RTDS hot path** — `wss://ws-live-data.polymarket.com`, topic `activity` / type `trades`.
//!
//! ## Latency-critical path
//! 1. **WS frame** → SDK delivers `RtdsMessage` (reconnect + backoff live inside `polymarket-client-sdk`).
//! 2. **Parse** → `ActivityTrade` via `serde_json` (heap: one `Value` clone per payload item — tighten with `simd-json` later).
//! 3. **Dedup** → `AHashSet` insert (`String` for id — unavoidable without a fixed-size id type).
//! 4. **Score** → `TraderDb::score_for(&str)` — **no allocation** if address is already lowercase (we normalize once at load + once per message for `proxyWallet`).
//! 5. **Order** → `tokio::spawn` + `OrderExecutor::execute_copy` so TLS/HTTP never blocks the reader.

use std::sync::Arc;

use ahash::AHashSet;
use futures::StreamExt as _;
use polymarket_client_sdk::rtds::Client as RtdsClient;
use polymarket_client_sdk::rtds::types::request::Subscription;
use polymarket_client_sdk::ws::config::Config as WsConfig;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::broadcast;
use tracing::{Level, span};
use tracing::{debug, instrument, trace, warn};

use crate::clob_client;
use crate::config::AppConfig;
use crate::db::{FillDb, FillRecord};
use crate::order_builder::OrderExecutor;
use crate::trader_db::TraderDb;
use crate::types::{CopySide, FeedMode, HotPathError, TradeSignal};

/// Wire shape for Polymarket RTDS activity trades (camelCase on the wire).
/// `asset` is what the TypeScript monitor uses; aliases cover `assetId` / `tokenId` variants.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityTrade {
    #[serde(default)]
    proxy_wallet: String,
    #[serde(default, alias = "assetId", alias = "token_id", alias = "tokenId")]
    asset: String,
    #[serde(default)]
    side: String,
    #[serde(default)]
    size: Option<Value>,
    #[serde(default)]
    price: Option<Value>,
    #[serde(default)]
    condition_id: String,
    #[serde(default)]
    transaction_hash: Option<String>,
    #[serde(default)]
    timestamp: Option<Value>,
    #[serde(default)]
    neg_risk: Option<bool>,
}

fn json_to_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn payload_items(payload: &Value) -> Vec<Value> {
    match payload {
        Value::Array(a) => a.clone(),
        Value::Object(_) => vec![payload.clone()],
        _ => vec![],
    }
}

/// Run the configured feed until shutdown or stream end.
pub async fn run_feed(
    config: AppConfig,
    db: Arc<TraderDb>,
    exec: Option<Arc<OrderExecutor>>,
    fill_db: Option<Arc<FillDb>>,
    shutdown: broadcast::Receiver<()>,
) -> Result<(), HotPathError> {
    match config.feed_mode() {
        FeedMode::RtdsActivity => run_rtds(config, db, exec, fill_db, shutdown).await,
        FeedMode::ClobMarketTelemetry => {
            clob_client::run_clob_market_telemetry(config, shutdown).await
        }
    }
}

async fn run_rtds(
    config: AppConfig,
    db: Arc<TraderDb>,
    exec: Option<Arc<OrderExecutor>>,
    fill_db: Option<Arc<FillDb>>,
    mut shutdown: broadcast::Receiver<()>,
) -> Result<(), HotPathError> {
    let client = RtdsClient::new(&config.rtds_ws_url, WsConfig::default())
        .map_err(|e| HotPathError::Clob(e.to_string()))?;

    // Match production subscribe JSON: `"filters": ""` (empty string, not omitted).
    // SDK serializes `Some("")` as a JSON string via the non-JSON fallback branch.
    let sub = Subscription::builder()
        .topic(String::from("activity"))
        .msg_type(String::from("trades"))
        .filters(String::new())
        .build();

    let stream = client
        .subscribe_raw(sub)
        .map_err(|e| HotPathError::Clob(e.to_string()))?;
    let mut stream = Box::pin(stream);
    let mut seen = AHashSet::<String>::new();
    const MAX_SEEN: usize = 100_000;

    loop {
        tokio::select! {
            biased;
            _ = shutdown.recv() => {
                trace!("RTDS feed shutdown");
                break Ok(());
            }
            next = stream.next() => {
                let Some(frame) = next else { break Ok(()); };
                let msg = match frame {
                    Ok(m) => m,
                    Err(e) => {
                        warn!(error = %e, "RTDS frame error (transient)");
                        continue;
                    }
                };
                if msg.topic != "activity" {
                    continue;
                }
                let ws_span = span!(Level::TRACE, "rtds_recv", topic = %msg.topic);
                let _g = ws_span.enter();

                for item in payload_items(&msg.payload) {
                    if let Some(sig) = parse_activity_item(&item, &mut seen, MAX_SEEN) {
                        process_signal(sig, &config, &db, exec.as_ref(), fill_db.as_ref()).await;
                    }
                }
            }
        }
    }
}

fn parse_activity_item(
    item: &Value,
    seen: &mut AHashSet<String>,
    max_seen: usize,
) -> Option<TradeSignal> {
    let t: ActivityTrade = serde_json::from_value(item.clone()).ok()?;
    let wallet_raw = t.proxy_wallet.trim();
    if wallet_raw.len() < 5 {
        return None;
    }
    let trader = wallet_raw.to_lowercase();
    let price = json_to_f64(t.price.as_ref()?)?;
    let size = t.size.as_ref().and_then(json_to_f64).unwrap_or(0.0);
    if price <= 0.0 {
        return None;
    }

    let dedup_key = t
        .transaction_hash
        .clone()
        .unwrap_or_else(|| format!("ws_{:?}_{}_{}", t.timestamp, t.condition_id, t.side));

    if seen.contains(&dedup_key) {
        return None;
    }
    if seen.len() >= max_seen {
        seen.clear();
    }
    seen.insert(dedup_key.clone());

    let side = if t.side.eq_ignore_ascii_case("BUY") {
        CopySide::Buy
    } else {
        CopySide::Sell
    };

    Some(TradeSignal {
        trader,
        token_id: t.asset,
        side,
        price,
        size,
        condition_id: t.condition_id,
        neg_risk: t.neg_risk.unwrap_or(false),
        dedup_key,
    })
}

#[instrument(skip_all, fields(trader = %signal.trader, token = %signal.token_id))]
async fn process_signal(
    signal: TradeSignal,
    config: &AppConfig,
    db: &TraderDb,
    exec: Option<&Arc<OrderExecutor>>,
    fill_db: Option<&Arc<FillDb>>,
) {
    let lookup_span = span!(Level::TRACE, "trader_lookup");
    let _lg = lookup_span.enter();

    let score = match db.score_for(&signal.trader) {
        Some(s) => s,
        None => return,
    };

    if score < config.score_threshold {
        debug!(score, threshold = config.score_threshold, "below threshold");
        return;
    }

    tracing::info!(
        trader = %signal.trader,
        score,
        side = ?signal.side,
        price = signal.price,
        "passed gates — executing"
    );

    let Some(exec) = exec else {
        tracing::info!(
            trader = %signal.trader,
            "no authenticated CLOB client — set POLYMARKET_PRIVATE_KEY (dry_run still parses signals)"
        );
        return;
    };

    let cfg = config.clone();
    let sig = signal.clone();
    let exec = Arc::clone(exec);
    let fdb = fill_db.cloned();
    tokio::spawn(async move {
        let order_span = span!(Level::TRACE, "sign_and_post");
        let _o = order_span.enter();
        match exec
            .execute_copy(
                &sig,
                cfg.copy_size_usd,
                cfg.min_entry_price,
                cfg.max_entry_price,
            )
            .await
        {
            Ok(Some(result)) => {
                if let Some(ref db) = fdb {
                    let record = FillRecord {
                        signal: sig,
                        order_id: result.order_id,
                        execution_status: result.status,
                        size_usd: cfg.copy_size_usd,
                        fill_price: result.fill_price,
                    };
                    if let Err(e) = db.insert_fill(&record).await {
                        warn!(error = %e, "failed to persist fill to postgres");
                    }
                }
            }
            Ok(None) => {}
            Err(e) => {
                warn!(error = %e, "order path failed");
            }
        }
    });
}
