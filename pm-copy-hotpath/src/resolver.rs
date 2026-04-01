use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;
use tracing::{debug, info, warn};

use crate::config::AppConfig;
use crate::db::FillDb;
use crate::order_builder::OrderExecutor;
use crate::positions::PositionTracker;
use crate::risk::RiskManager;

#[derive(Debug, serde::Deserialize)]
struct GammaMarket {
    #[serde(default)]
    closed: bool,
    #[serde(default, rename = "outcomePrices")]
    outcome_prices: Option<String>,
    #[serde(default, rename = "clobTokenIds")]
    clob_token_ids: Option<String>,
}

fn get_token_price(market: &GammaMarket, token_id: &str) -> Option<f64> {
    let prices_str = market.outcome_prices.as_deref()?;
    let token_ids_str = market.clob_token_ids.as_deref()?;
    let prices: Vec<f64> = serde_json::from_str::<Vec<serde_json::Value>>(prices_str)
        .ok()?
        .iter()
        .filter_map(|v| match v {
            serde_json::Value::String(s) => s.parse().ok(),
            serde_json::Value::Number(n) => n.as_f64(),
            _ => None,
        })
        .collect();
    let token_ids: Vec<String> = serde_json::from_str(token_ids_str).ok()?;
    let idx = token_ids.iter().position(|id| id == token_id)?;
    prices.get(idx).copied()
}

pub async fn run_resolver(
    config: AppConfig,
    positions: Arc<Mutex<PositionTracker>>,
    risk: Arc<Mutex<RiskManager>>,
    db: Arc<FillDb>,
    exec: Option<Arc<OrderExecutor>>,
    mut shutdown: tokio::sync::broadcast::Receiver<()>,
) {
    let http = reqwest::Client::new();
    let interval = Duration::from_secs(config.resolution_poll_seconds);

    loop {
        tokio::select! {
            biased;
            _ = shutdown.recv() => {
                debug!("resolver shutdown");
                return;
            }
            _ = tokio::time::sleep(interval) => {}
        }

        if let Err(e) = poll_once(&config, &positions, &risk, &db, &exec, &http).await {
            warn!(error = %e, "resolver poll error");
        }
    }
}

async fn poll_once(
    config: &AppConfig,
    positions: &Arc<Mutex<PositionTracker>>,
    _risk: &Arc<Mutex<RiskManager>>,
    db: &Arc<FillDb>,
    exec: &Option<Arc<OrderExecutor>>,
    http: &reqwest::Client,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let condition_ids = {
        let tracker = positions.lock().await;
        tracker.all_condition_ids()
    };

    if condition_ids.is_empty() {
        return Ok(());
    }

    debug!(open = condition_ids.len(), "resolver polling");

    for condition_id in &condition_ids {
        let url = format!(
            "{}/markets?condition_id={}",
            config.gamma_http_url, condition_id
        );
        let resp = match http.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                debug!(condition_id, error = %e, "gamma fetch failed");
                continue;
            }
        };

        let markets: Vec<GammaMarket> = match resp.json().await {
            Ok(m) => m,
            Err(e) => {
                debug!(condition_id, error = %e, "gamma parse failed");
                continue;
            }
        };

        let market = match markets.first() {
            Some(m) => m,
            None => continue,
        };

        let mut tracker = positions.lock().await;
        let pos_list = match tracker.get_positions(condition_id) {
            Some(p) => p.clone(),
            None => continue,
        };

        if market.closed {
            let mut all_resolved = true;
            for pos in &pos_list {
                let resolution_price = match get_token_price(market, &pos.token_id) {
                    Some(p) if (0.0..=1.0).contains(&p) => p,
                    Some(p) => {
                        warn!(
                            id = pos.live_trade_id,
                            price = p,
                            "resolution price out of [0,1] — skipping"
                        );
                        all_resolved = false;
                        continue;
                    }
                    None => {
                        warn!(id = pos.live_trade_id, token_id = %pos.token_id, "could not find resolution price — skipping");
                        all_resolved = false;
                        continue;
                    }
                };
                let real_pnl = (resolution_price - pos.fill_price) * pos.fill_size;
                if let Err(e) = db
                    .resolve_trade(pos.live_trade_id, resolution_price, real_pnl)
                    .await
                {
                    warn!(id = pos.live_trade_id, error = %e, "resolve DB error");
                    all_resolved = false;
                    continue;
                }
                info!(
                    id = pos.live_trade_id,
                    resolution_price,
                    real_pnl = format!("{:.2}", real_pnl),
                    "position resolved"
                );
            }
            if all_resolved {
                let removed = tracker.remove_condition(condition_id);
                drop(tracker);
                let _ = db.get_daily_pnl().await;
                debug!(
                    condition_id,
                    count = removed.len(),
                    "removed resolved positions"
                );
            } else {
                drop(tracker);
                warn!(
                    condition_id,
                    "kept condition in tracker — not all positions resolved"
                );
            }
        } else {
            for pos in &pos_list {
                if let Some(price) = get_token_price(market, &pos.token_id) {
                    let _ = db.update_current_price(pos.live_trade_id, price).await;

                    // Auto-sell at near-certainty
                    if price >= config.auto_sell_threshold
                        && let Some(executor) = exec
                    {
                        info!(
                            id = pos.live_trade_id,
                            price, "auto-sell triggered (near 1.0)"
                        );
                        let signal = crate::types::TradeSignal {
                            trader: String::new(),
                            token_id: pos.token_id.clone(),
                            side: crate::types::CopySide::Sell,
                            price,
                            size: pos.fill_size,
                            condition_id: pos.condition_id.clone(),
                            neg_risk: pos.neg_risk,
                            dedup_key: format!("autosell_{}", pos.live_trade_id),
                        };
                        match executor.execute_sell(&signal, pos.fill_size).await {
                            Ok(Some(result)) => {
                                let real_pnl = (result.fill_price - pos.fill_price) * pos.fill_size;
                                let _ = db
                                    .mark_sold(
                                        pos.live_trade_id,
                                        result.fill_price,
                                        real_pnl,
                                        &result.order_id,
                                    )
                                    .await;
                                tracker.remove_position(condition_id, pos.live_trade_id);
                                info!(
                                    id = pos.live_trade_id,
                                    real_pnl = format!("{:.2}", real_pnl),
                                    "auto-sold"
                                );
                            }
                            Ok(None) => debug!(id = pos.live_trade_id, "auto-sell: no fill"),
                            Err(e) => {
                                warn!(id = pos.live_trade_id, error = %e, "auto-sell error")
                            }
                        }
                    }
                }
            }
            drop(tracker);
        }
    }

    Ok(())
}
