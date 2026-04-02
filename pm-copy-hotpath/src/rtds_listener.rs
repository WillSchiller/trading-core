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
use crate::order_builder::{OrderExecutor, OrderOutcome};
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
    pub market_cache: MarketCache,
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
    #[serde(default)]
    outcome: Option<String>,
    #[serde(default, alias = "slug")]
    market_slug: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MarketMeta {
    pub outcome: String,
    pub slug: String,
}

pub type MarketCache = Arc<Mutex<ahash::AHashMap<String, MarketMeta>>>;

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
                    cache_market_meta(&item, &ctx.market_cache).await;
                    if let Some(sig) = parse_activity_item(&item, &mut seen, MAX_SEEN) {
                        if sig.side == CopySide::Sell && is_our_wallet(&sig.trader, &ctx.config) {
                            detect_self_sell(&sig, &ctx).await;
                        } else {
                            process_signal(sig, &ctx).await;
                        }
                    }
                }
            }
        }
    }
}

fn derive_category(slug: &str) -> &'static str {
    let s = slug.to_lowercase();
    if s.contains("bitcoin")
        || s.contains("btc")
        || s.contains("eth")
        || s.contains("sol")
        || s.contains("xrp")
        || s.contains("crypto")
        || s.contains("doge")
        || s.contains("hype")
        || s.contains("token")
        || s.contains("defi")
    {
        "CRYPTO"
    } else if s.contains("nba")
        || s.contains("nfl")
        || s.contains("mlb")
        || s.contains("nhl")
        || s.contains("premier")
        || s.contains("bundesliga")
        || s.contains("serie-a")
        || s.contains("lol")
        || s.contains("fifa")
        || s.contains("bayern")
        || s.contains("win-on")
        || s.contains("foxy")
        || s.contains("esport")
    {
        "SPORTS"
    } else if s.contains("trump")
        || s.contains("biden")
        || s.contains("elect")
        || s.contains("president")
        || s.contains("congress")
        || s.contains("politi")
        || s.contains("senate")
        || s.contains("governor")
    {
        "POLITICS"
    } else {
        "OTHER"
    }
}

async fn cache_market_meta(item: &Value, cache: &MarketCache) {
    let t: ActivityTrade = match serde_json::from_value(item.clone()) {
        Ok(t) => t,
        Err(_) => return,
    };
    if t.condition_id.is_empty() {
        return;
    }
    let outcome = t.outcome.unwrap_or_default();
    let slug = t.market_slug.unwrap_or_default();
    if outcome.is_empty() && slug.is_empty() {
        return;
    }
    let mut map: tokio::sync::MutexGuard<'_, ahash::AHashMap<String, MarketMeta>> =
        cache.lock().await;
    map.entry(t.condition_id)
        .or_insert(MarketMeta { outcome, slug });
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

fn is_our_wallet(trader: &str, config: &AppConfig) -> bool {
    !config.our_wallet.is_empty() && trader == config.our_wallet
}

async fn detect_self_sell(signal: &TradeSignal, ctx: &FeedCtx) {
    let Some(db) = &ctx.fill_db else { return };
    info!(
        condition = %signal.condition_id,
        price = signal.price,
        size = signal.size,
        "detected self-sell on RTDS"
    );
    let sql = format!(
        "UPDATE pm_rust_trades SET execution_status = 'sold', resolution_price = {}, real_pnl = ({} - fill_price::float8) * fill_size::float8, resolved = true, resolved_at = NOW() WHERE condition_id = '{}' AND execution_status = 'filled' AND resolved = false AND model_version != 'synced'",
        signal.price,
        signal.price,
        signal.condition_id.replace('\'', "''"),
    );
    let client = match db.pool().get().await {
        Ok(c) => c,
        Err(e) => {
            warn!(error = %e, "self-sell DB error");
            return;
        }
    };
    match client.simple_query(&sql).await {
        Ok(_) => info!(condition = %signal.condition_id, "self-sell recorded in DB"),
        Err(e) => warn!(error = %e, "self-sell update failed"),
    }
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

    let market_meta: Option<MarketMeta> = ctx
        .market_cache
        .lock()
        .await
        .get(&signal.condition_id)
        .cloned();
    let category = market_meta
        .as_ref()
        .map(|m| derive_category(&m.slug))
        .unwrap_or("OTHER");
    let outcome_name = market_meta
        .as_ref()
        .map(|m| m.outcome.as_str())
        .unwrap_or("");
    let slug = market_meta.as_ref().map(|m| m.slug.as_str()).unwrap_or("");

    let mut scorer_guard = ctx.scorer.lock().await;
    let (ml_result, ml_scores_json) = if scorer_guard.is_enabled() {
        let (result, json) = scorer_guard.score_all_json(&signal, category, outcome_name, slug);
        (Some(result), json)
    } else {
        (None, String::new())
    };
    drop(scorer_guard);

    let use_ml = match mode {
        "ml" => true,
        "ab" => market_is_ml(&signal.condition_id),
        _ => false,
    };

    let (trade_size, model_version) = match &ml_result {
        Some(result) if result.pass && result.kelly_size >= ctx.config.min_bet_usd => {
            (result.kelly_size, "v6_kelly".to_owned())
        }
        _ => {
            // ML rejected — skip trade, but still record the attempt
            if let Some(db) = &ctx.fill_db {
                let record = FillRecord {
                    signal: signal.clone(),
                    order_id: String::new(),
                    execution_status: "ml_skip",
                    size_usd: 0.0,
                    fill_price: signal.price,
                    model_version: "ml_skip".to_owned(),
                    win_score: ml_result.as_ref().map(|r| r.win_score),
                    cal_prob: ml_result.as_ref().map(|r| r.cal_prob),
                    kelly_size: ml_result.as_ref().map(|r| r.kelly_size),
                    latency_ms: None,
                    market_slug: market_meta
                        .as_ref()
                        .map(|m| m.slug.clone())
                        .unwrap_or_default(),
                    outcome: market_meta
                        .as_ref()
                        .map(|m| m.outcome.clone())
                        .unwrap_or_default(),
                    ml_scores_json: ml_scores_json.clone(),
                };
                let _ = db.insert_fill(&record).await;
            }
            return;
        }
    };

    info!(
        trader = %signal.trader,
        size = format!("{:.2}", trade_size),
        path = &model_version,
        "ML approved"
    );

    let tracker = ctx.positions.lock().await;
    let total_exposure = tracker.total_exposure();
    let open_markets = tracker.open_market_count();
    let position_notional = tracker.notional(&signal.condition_id);
    let position_trade_count = tracker.trade_count(&signal.condition_id);
    drop(tracker);

    let mut risk_guard = ctx.risk.lock().await;
    if let Err(reason) = risk_guard.can_trade(
        trade_size,
        &signal.condition_id,
        total_exposure,
        open_markets,
        0.0,
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
    let is_ml = use_ml;
    let cached_slug = market_meta
        .as_ref()
        .map(|m| m.slug.clone())
        .unwrap_or_default();
    let cached_outcome = market_meta
        .as_ref()
        .map(|m| m.outcome.clone())
        .unwrap_or_default();
    let scores_json = ml_scores_json;

    tokio::spawn(async move {
        let t0 = std::time::Instant::now();
        let outcome = exec
            .execute_copy(&sig, trade_size, min_entry, max_entry, is_ml)
            .await;
        let latency_ms = t0.elapsed().as_millis() as i32;

        let (status, order_id, fill_price) = match &outcome {
            Ok(OrderOutcome::FakFilled(r)) => (r.status, r.order_id.clone(), r.fill_price),
            Ok(OrderOutcome::GtcPosted(r)) => (r.status, r.order_id.clone(), r.fill_price),
            Ok(OrderOutcome::BalanceError) => ("balance_error", String::new(), sig.price),
            Ok(OrderOutcome::BookEmpty) => ("no_fill", String::new(), sig.price),
            Ok(OrderOutcome::PriceBand) => ("price_band", String::new(), sig.price),
            Ok(OrderOutcome::BelowMinimum) => ("below_min", String::new(), sig.price),
            Ok(OrderOutcome::DryRun) => return,
            Err(e) => {
                warn!(error = %e, "order failed");
                rsk.lock().await.release_pending(trade_size);
                return;
            }
        };

        if let Some(db) = &fdb {
            let record = FillRecord {
                signal: sig.clone(),
                order_id: order_id.clone(),
                execution_status: status,
                size_usd: trade_size,
                fill_price,
                model_version: mv.clone(),
                win_score: ml_scores.as_ref().map(|r| r.win_score),
                cal_prob: ml_scores.as_ref().map(|r| r.cal_prob),
                kelly_size: ml_scores.as_ref().map(|r| r.kelly_size),
                latency_ms: Some(latency_ms),
                market_slug: cached_slug.clone(),
                outcome: cached_outcome.clone(),
                ml_scores_json: scores_json.clone(),
            };
            match db.insert_fill(&record).await {
                Ok(id) => {
                    if matches!(
                        outcome,
                        Ok(OrderOutcome::FakFilled(_) | OrderOutcome::GtcPosted(_))
                    ) {
                        let fill_size = trade_size / fill_price.max(0.01);
                        let position = Position {
                            live_trade_id: id,
                            condition_id: sig.condition_id.clone(),
                            token_id: sig.token_id.clone(),
                            fill_price,
                            fill_size,
                            order_id,
                            neg_risk: sig.neg_risk,
                            filled_at: chrono::Utc::now(),
                            model_version: mv,
                        };
                        pos.lock().await.track_buy(position);
                    }
                }
                Err(e) => warn!(error = %e, "fill DB write failed"),
            }
        }

        if !matches!(
            outcome,
            Ok(OrderOutcome::FakFilled(_) | OrderOutcome::GtcPosted(_))
        ) {
            rsk.lock().await.release_pending(trade_size);
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
