use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use polymarket_client_sdk::data::Client as DataClient;
use polymarket_client_sdk::data::types::Side;
use polymarket_client_sdk::data::types::request::{PositionsRequest, TradesRequest};
use polymarket_client_sdk::types::Address;
use tokio::sync::broadcast;
use tracing::{debug, info, warn};

use crate::config::AppConfig;
use crate::db::FillDb;

pub async fn run_trade_sync(
    config: AppConfig,
    db: Arc<FillDb>,
    mut shutdown: broadcast::Receiver<()>,
) {
    if config.our_wallet.is_empty() {
        info!("no our_wallet configured — trade sync disabled");
        return;
    }

    let data_client = match DataClient::new("https://data-api.polymarket.com") {
        Ok(c) => c,
        Err(e) => {
            warn!(error = %e, "failed to create data client");
            return;
        }
    };

    let addr = match Address::from_str(&config.our_wallet) {
        Ok(a) => a,
        Err(e) => {
            warn!(error = %e, "invalid our_wallet address");
            return;
        }
    };

    // Bootstrap: sync all positions on startup
    if let Err(e) = sync_positions(&addr, &data_client, &db).await {
        warn!(error = %e, "position bootstrap failed");
    }

    let interval = Duration::from_secs(300);
    info!("trade sync started (every 5min)");

    loop {
        tokio::select! {
            biased;
            _ = shutdown.recv() => {
                debug!("trade sync shutdown");
                return;
            }
            _ = tokio::time::sleep(interval) => {}
        }

        if let Err(e) = sync_sells(&addr, &data_client, &db).await {
            warn!(error = %e, "trade sync error");
        }
        if let Err(e) = sync_positions(&addr, &data_client, &db).await {
            warn!(error = %e, "position sync error");
        }
    }
}

async fn sync_positions(
    addr: &Address,
    client: &DataClient,
    db: &FillDb,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let req = PositionsRequest::builder().user(*addr).build();
    let positions = client.positions(&req).await?;
    info!(count = positions.len(), "synced positions from data API");

    let pool_client = db.pool().get().await?;

    for pos in &positions {
        let condition_id = format!("{:#x}", pos.condition_id);
        let token_id = format!("{}", pos.asset);
        let size: f64 = pos.size.to_string().parse().unwrap_or(0.0);
        let avg_price: f64 = pos.avg_price.to_string().parse().unwrap_or(0.0);
        let cur_price: f64 = pos.cur_price.to_string().parse().unwrap_or(0.0);
        let _cash_pnl: f64 = pos.cash_pnl.to_string().parse().unwrap_or(0.0);
        let _title = pos.title.replace('\'', "''");
        let outcome = pos.outcome.replace('\'', "''");
        let slug = pos.slug.replace('\'', "''");

        // Check if we already track this position
        let existing = pool_client
            .query(
                "SELECT id FROM pm_rust_trades WHERE condition_id = $1 AND token_id = $2 AND execution_status IN ('filled', 'pending') AND resolved = false LIMIT 1",
                &[&condition_id, &token_id],
            )
            .await?;

        if existing.is_empty() {
            // Insert missing position
            let sql = format!(
                "INSERT INTO pm_rust_trades (trader_address, condition_id, token_id, side, trader_size, trader_price, our_size, order_id, fill_price, fill_size, execution_status, model_version, market_slug, outcome, neg_risk)
                 VALUES ('self', '{cid}', '{tid}', 'BUY', {size}, {avg_price}, {cost}, 'synced', {avg_price}, {size}, 'filled', 'synced', '{slug}', '{outcome}', {neg_risk})
                 ON CONFLICT DO NOTHING",
                cid = condition_id.replace('\'', "''"),
                tid = token_id.replace('\'', "''"),
                size = size,
                avg_price = avg_price,
                cost = avg_price * size,
                slug = slug,
                outcome = outcome,
                neg_risk = pos.negative_risk,
            );
            if let Err(e) = pool_client.simple_query(&sql).await {
                debug!(error = %e, title = %pos.title, "position insert failed");
            } else {
                info!(title = %pos.title, size, avg_price, "synced missing position");
            }
        }

        // Update current price (mark-to-market)
        let update = format!(
            "UPDATE pm_rust_trades SET pnl = {cur_price} WHERE condition_id = '{cid}' AND resolved = false",
            cur_price = cur_price,
            cid = condition_id.replace('\'', "''"),
        );
        let _ = pool_client.simple_query(&update).await;
    }

    Ok(())
}

async fn sync_sells(
    addr: &Address,
    client: &DataClient,
    db: &FillDb,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let req = TradesRequest::builder()
        .user(*addr)
        .side(Side::Sell)
        .build();
    let trades = client.trades(&req).await?;
    debug!(count = trades.len(), "fetched sell trades from data API");

    let pool_client = db.pool().get().await?;

    for trade in &trades {
        let condition_id = format!("{:#x}", trade.condition_id);
        let price: f64 = trade.price.to_string().parse().unwrap_or(0.0);

        let check = pool_client
            .query(
                "SELECT id FROM pm_rust_trades WHERE condition_id = $1 AND execution_status = 'filled' AND resolved = false LIMIT 1",
                &[&condition_id],
            )
            .await?;

        if check.is_empty() {
            continue;
        }

        let id: i64 = check[0].get(0);
        let sql = format!(
            "UPDATE pm_rust_trades SET execution_status = 'sold', resolution_price = {price}, real_pnl = ({price} - fill_price::float8) * fill_size::float8, resolved = true, resolved_at = NOW() WHERE id = {id} AND resolved = false"
        );
        pool_client.simple_query(&sql).await?;
        info!(id, condition_id = %condition_id, exit_price = price, "trade sync: sell detected");
    }

    Ok(())
}
