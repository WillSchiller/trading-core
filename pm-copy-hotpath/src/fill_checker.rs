use std::sync::Arc;
use std::time::Duration;

use polymarket_client_sdk::clob::types::OrderStatusType;
use tokio::sync::{Mutex, broadcast};
use tracing::{debug, info, warn};

use crate::db::FillDb;
use crate::order_builder::OrderExecutor;
use crate::positions::PositionTracker;

const STALE_ORDER_MINUTES: i64 = 10;

pub async fn run_fill_checker(
    db: Arc<FillDb>,
    exec: Arc<OrderExecutor>,
    positions: Arc<Mutex<PositionTracker>>,
    mut shutdown: broadcast::Receiver<()>,
) {
    let interval = Duration::from_secs(30);
    loop {
        tokio::select! {
            biased;
            _ = shutdown.recv() => {
                debug!("fill_checker shutdown");
                return;
            }
            _ = tokio::time::sleep(interval) => {}
        }

        if let Err(e) = check_pending(&db, &exec, &positions).await {
            warn!(error = %e, "fill_checker error");
        }
    }
}

async fn check_pending(
    db: &FillDb,
    exec: &OrderExecutor,
    positions: &Arc<Mutex<PositionTracker>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let pending = db.load_pending_orders().await?;
    if pending.is_empty() {
        return Ok(());
    }

    debug!(count = pending.len(), "checking pending orders");

    for (trade_id, order_id, condition_id, token_id, fill_price) in &pending {
        let order = match exec.get_order(order_id).await {
            Ok(o) => o,
            Err(e) => {
                debug!(order_id, error = %e, "failed to fetch order");
                continue;
            }
        };

        match order.status {
            OrderStatusType::Matched => {
                let size_matched: f64 = order.size_matched.to_string().parse().unwrap_or(0.0);
                let actual_price: f64 = order.price.to_string().parse().unwrap_or(*fill_price);
                info!(
                    trade_id,
                    order_id, size_matched, actual_price, "GTC order FILLED"
                );
                db.update_execution_status(
                    *trade_id,
                    "filled",
                    Some(actual_price),
                    Some(size_matched),
                )
                .await?;

                let pos = crate::types::Position {
                    live_trade_id: *trade_id,
                    condition_id: condition_id.clone(),
                    token_id: token_id.clone(),
                    fill_price: actual_price,
                    fill_size: size_matched,
                    order_id: order_id.clone(),
                    neg_risk: false,
                    filled_at: chrono::Utc::now(),
                    model_version: String::new(),
                };
                positions.lock().await.track_buy(pos);
            }
            OrderStatusType::Live => {
                let age = chrono::Utc::now() - order.created_at;
                if age.num_seconds() / 60 > STALE_ORDER_MINUTES {
                    info!(
                        trade_id,
                        order_id,
                        age_min = age.num_seconds() / 60,
                        "cancelling stale GTC"
                    );
                    let _ = exec.cancel_order(order_id).await;
                    db.update_execution_status(*trade_id, "cancelled", None, None)
                        .await?;
                }
            }
            OrderStatusType::Canceled | OrderStatusType::Unmatched => {
                debug!(trade_id, order_id, status = ?order.status, "order dead");
                db.update_execution_status(*trade_id, "cancelled", None, None)
                    .await?;
            }
            _ => {
                debug!(trade_id, order_id, status = ?order.status, "unknown status");
            }
        }
    }

    Ok(())
}
