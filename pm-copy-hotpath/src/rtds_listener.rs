use std::sync::Arc;

use ahash::AHashSet;
use futures::StreamExt as _;
use polymarket_client_sdk::rtds::Client as RtdsClient;
use polymarket_client_sdk::rtds::types::request::Subscription;
use polymarket_client_sdk::ws::config::Config as WsConfig;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{Mutex, broadcast};
use tracing::{debug, info, trace, warn};

use crate::clob_client;
use crate::config::AppConfig;
use crate::db::{FillDb, FillRecord};
use crate::order_builder::OrderExecutor;
use crate::positions::PositionTracker;
use crate::risk::RiskManager;
use crate::scorer::Scorer;
use crate::trader_db::TraderDb;
use crate::types::{CopySide, FeedMode, HotPathError, Position, TradeSignal};

pub struct FeedCtx {
    pub config: AppConfig,
    pub trader_db: Arc<TraderDb>,
    pub exec: Option<Arc<OrderExecutor>>,
    pub fill_db: Option<Arc<FillDb>>,
    pub positions: Arc<Mutex<PositionTracker>>,
    pub risk: Arc<Mutex<RiskManager>>,
    pub scorer: Arc<Mutex<Scorer>>,
}

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

pub async fn run_feed(ctx: FeedCtx, shutdown: broadcast::Receiver<()>) -> Result<(), HotPathError> {
    match ctx.config.feed_mode() {
        FeedMode::RtdsActivity => run_rtds(ctx, shutdown).await,
        FeedMode::ClobMarketTelemetry => {
            clob_client::run_clob_market_telemetry(ctx.config, shutdown).await
        }
    }
}

async fn run_rtds(ctx: FeedCtx, mut shutdown: broadcast::Receiver<()>) -> Result<(), HotPathError> {
    let client = RtdsClient::new(&ctx.config.rtds_ws_url, WsConfig::default())
        .map_err(|e| HotPathError::Clob(e.to_string()))?;

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

                for item in payload_items(&msg.payload) {
                    if let Some(sig) = parse_activity_item(&item, &mut seen, MAX_SEEN) {
                        process_signal(sig, &ctx).await;
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

async fn process_signal(signal: TradeSignal, ctx: &FeedCtx) {
    let score = match ctx.trader_db.score_for(&signal.trader) {
        Some(s) => s,
        None => return,
    };

    if score < ctx.config.score_threshold {
        debug!(
            score,
            threshold = ctx.config.score_threshold,
            "below threshold"
        );
        return;
    }

    match signal.side {
        CopySide::Buy => process_buy(signal, ctx).await,
        CopySide::Sell => process_sell(signal, ctx).await,
    }
}

fn market_is_ml(condition_id: &str) -> bool {
    let mut h: u64 = 5381;
    for b in condition_id.bytes() {
        h = h.wrapping_mul(33).wrapping_add(b as u64);
    }
    h.is_multiple_of(2)
}

async fn process_buy(signal: TradeSignal, ctx: &FeedCtx) {
    let Some(exec) = &ctx.exec else {
        debug!(trader = %signal.trader, "no CLOB client");
        return;
    };

    let mode = ctx.config.execution_mode.as_str();

    let mut scorer_guard = ctx.scorer.lock().await;
    let ml_result = if scorer_guard.is_enabled() {
        Some(scorer_guard.score(&signal, "SPORTS"))
    } else {
        None
    };
    drop(scorer_guard);

    let use_ml = match mode {
        "ml" => true,
        "ab" => market_is_ml(&signal.condition_id),
        _ => false,
    };

    let (trade_size, model_version) = if use_ml {
        match &ml_result {
            Some(result) if result.pass && result.kelly_size >= ctx.config.min_bet_usd => {
                (result.kelly_size, "ml_kelly".to_owned())
            }
            Some(result) => {
                debug!(
                    trader = %signal.trader,
                    kelly = format!("{:.2}", result.kelly_size),
                    pass = result.pass,
                    "ML path: scorer rejected"
                );
                return;
            }
            None => {
                debug!(trader = %signal.trader, "ML path but no model loaded");
                return;
            }
        }
    } else {
        (ctx.config.copy_size_usd, "control".to_owned())
    };

    if mode == "ab" {
        info!(
            trader = %signal.trader,
            path = &model_version,
            size = format!("{:.2}", trade_size),
            ml_kelly = ml_result.as_ref().map(|r| format!("{:.2}", r.kelly_size)).unwrap_or_default(),
            ml_pass = ml_result.as_ref().map(|r| r.pass),
            "A/B split"
        );
    }

    let tracker = ctx.positions.lock().await;
    let total_exposure = tracker.total_exposure();
    let open_markets = tracker.open_market_count();
    let position_notional = tracker.notional(&signal.condition_id);
    let position_trade_count = tracker.trade_count(&signal.condition_id);
    drop(tracker);

    let daily_pnl = match &ctx.fill_db {
        Some(fdb) => fdb.get_daily_pnl().await.unwrap_or(0.0),
        None => 0.0,
    };

    let mut risk_guard = ctx.risk.lock().await;
    if let Err(reason) = risk_guard.can_trade(
        trade_size,
        &signal.condition_id,
        total_exposure,
        open_markets,
        daily_pnl,
        position_notional,
        position_trade_count,
    ) {
        debug!(trader = %signal.trader, reason, "risk rejected");
        return;
    }
    risk_guard.record_order(&signal.condition_id, trade_size);
    drop(risk_guard);

    info!(
        trader = %signal.trader,
        price = signal.price,
        size = format!("{:.2}", trade_size),
        path = &model_version,
        condition = %signal.condition_id,
        "passed all gates — executing BUY"
    );

    let sig = signal.clone();
    let exec = Arc::clone(exec);
    let fdb = ctx.fill_db.clone();
    let pos = Arc::clone(&ctx.positions);
    let rsk = Arc::clone(&ctx.risk);
    let min_entry = ctx.config.min_entry_price;
    let max_entry = ctx.config.max_entry_price;
    let ml_scores = ml_result;
    let mv = model_version.clone();

    tokio::spawn(async move {
        match exec
            .execute_copy(&sig, trade_size, min_entry, max_entry)
            .await
        {
            Ok(Some(result)) => {
                let fill_size = trade_size / result.fill_price.max(0.01);
                if let Some(db) = &fdb {
                    let record = FillRecord {
                        signal: sig.clone(),
                        order_id: result.order_id.clone(),
                        execution_status: result.status,
                        size_usd: trade_size,
                        fill_price: result.fill_price,
                        model_version: mv.clone(),
                        win_score: ml_scores.as_ref().map(|r| r.win_score),
                        cal_prob: ml_scores.as_ref().map(|r| r.cal_prob),
                        kelly_size: ml_scores.as_ref().map(|r| r.kelly_size),
                    };
                    match db.insert_fill(&record).await {
                        Ok(id) => {
                            let position = Position {
                                live_trade_id: id,
                                condition_id: sig.condition_id.clone(),
                                token_id: sig.token_id.clone(),
                                fill_price: result.fill_price,
                                fill_size,
                                order_id: result.order_id,
                                neg_risk: sig.neg_risk,
                                filled_at: chrono::Utc::now(),
                                model_version: mv,
                            };
                            pos.lock().await.track_buy(position);
                        }
                        Err(e) => warn!(error = %e, "fill DB write failed"),
                    }
                }
            }
            Ok(None) => {
                rsk.lock().await.release_pending(trade_size);
            }
            Err(e) => {
                warn!(error = %e, "order failed");
                rsk.lock().await.release_pending(trade_size);
            }
        }
    });
}

async fn process_sell(signal: TradeSignal, ctx: &FeedCtx) {
    let Some(exec) = &ctx.exec else {
        return;
    };

    let tracker = ctx.positions.lock().await;
    let pos_list = match tracker.get_positions(&signal.condition_id) {
        Some(p) => p.clone(),
        None => return,
    };
    drop(tracker);

    if pos_list.is_empty() {
        return;
    }

    info!(
        trader = %signal.trader,
        condition = %signal.condition_id,
        positions = pos_list.len(),
        "trader sell signal — executing exit"
    );

    for pos in &pos_list {
        match exec.execute_sell(&signal, pos.fill_size).await {
            Ok(Some(result)) => {
                let real_pnl = (result.fill_price - pos.fill_price) * pos.fill_size;
                info!(
                    id = pos.live_trade_id,
                    exit_price = result.fill_price,
                    real_pnl = format!("{:.2}", real_pnl),
                    "SELL filled"
                );
                if let Some(db) = &ctx.fill_db {
                    let _ = db
                        .mark_sold(
                            pos.live_trade_id,
                            result.fill_price,
                            real_pnl,
                            &result.order_id,
                        )
                        .await;
                }
                ctx.positions
                    .lock()
                    .await
                    .remove_position(&signal.condition_id, pos.live_trade_id);
            }
            Ok(None) => debug!(id = pos.live_trade_id, "sell: no fill"),
            Err(e) => warn!(id = pos.live_trade_id, error = %e, "sell error"),
        }
    }
}
