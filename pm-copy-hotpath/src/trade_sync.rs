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

    // Full bootstrap on startup
    if let Err(e) = full_sync(&addr, &data_client, &db).await {
        warn!(error = %e, "full sync failed");
    }

    let interval = Duration::from_secs(300);
    info!("trade sync running (every 5min)");

    loop {
        tokio::select! {
            biased;
            _ = shutdown.recv() => {
                debug!("trade sync shutdown");
                return;
            }
            _ = tokio::time::sleep(interval) => {}
        }

        if let Err(e) = full_sync(&addr, &data_client, &db).await {
            warn!(error = %e, "sync cycle error");
        }
    }
}

async fn full_sync(
    addr: &Address,
    client: &DataClient,
    db: &FillDb,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let pool_client = db.pool().get().await?;
    let esc = |s: &str| s.replace('\'', "''");

    // 1. Import all BUY trades
    let buy_req = TradesRequest::builder().user(*addr).side(Side::Buy).build();
    let buys = client.trades(&buy_req).await?;
    let mut buys_inserted = 0;

    for trade in &buys {
        let condition_id = format!("{:#x}", trade.condition_id);
        let token_id = format!("{}", trade.asset);
        let tx_hash = trade.transaction_hash.to_string();
        let price: f64 = trade.price.to_string().parse().unwrap_or(0.0);
        let size: f64 = trade.size.to_string().parse().unwrap_or(0.0);

        // Dedup by transaction hash
        let exists = pool_client
            .query(
                "SELECT 1 FROM pm_rust_trades WHERE order_id = $1 LIMIT 1",
                &[&tx_hash],
            )
            .await?;

        if !exists.is_empty() {
            continue;
        }

        let sql = format!(
            "INSERT INTO pm_rust_trades (
                trader_address, condition_id, token_id, side,
                trader_size, trader_price, our_size,
                order_id, fill_price, fill_size, execution_status,
                model_version, market_slug, outcome, neg_risk,
                created_at
            ) VALUES (
                'self', '{cid}', '{tid}', 'BUY',
                {size}, {price}, {cost},
                '{tx}', {price}, {size}, 'filled',
                'synced', '{slug}', '{outcome}', false,
                to_timestamp({ts})
            )",
            cid = esc(&condition_id),
            tid = esc(&token_id),
            size = size,
            price = price,
            cost = price * size,
            tx = esc(&tx_hash),
            slug = esc(&trade.slug),
            outcome = esc(&trade.outcome),
            ts = trade.timestamp,
        );

        if let Err(e) = pool_client.simple_query(&sql).await {
            debug!(error = %e, slug = %trade.slug, "buy insert failed");
        } else {
            buys_inserted += 1;
        }
    }

    // 2. Import all SELL trades — match to buys by condition_id
    let sell_req = TradesRequest::builder()
        .user(*addr)
        .side(Side::Sell)
        .build();
    let sells = client.trades(&sell_req).await?;
    let mut sells_matched = 0;

    for trade in &sells {
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
            "UPDATE pm_rust_trades SET execution_status = 'sold', resolution_price = {price}, real_pnl = ({price} - fill_price::float8) * fill_size::float8, resolved = true, resolved_at = to_timestamp({ts}) WHERE id = {id} AND resolved = false",
            price = price,
            ts = trade.timestamp,
            id = id,
        );
        if pool_client.simple_query(&sql).await.is_ok() {
            sells_matched += 1;
        }
    }

    // 3. Update current prices on open positions from positions API
    let pos_req = PositionsRequest::builder().user(*addr).build();
    let positions = client.positions(&pos_req).await?;

    for pos in &positions {
        let condition_id = format!("{:#x}", pos.condition_id);
        let cur_price: f64 = pos.cur_price.to_string().parse().unwrap_or(0.0);

        let sql = format!(
            "UPDATE pm_rust_trades SET pnl = {cur_price} WHERE condition_id = '{cid}' AND resolved = false AND execution_status = 'filled'",
            cur_price = cur_price,
            cid = esc(&condition_id),
        );
        let _ = pool_client.simple_query(&sql).await;
    }

    // 4. Mark positions as resolved if they're not in the positions API anymore
    //    (market resolved or fully sold)
    let open_condition_ids: std::collections::HashSet<String> = positions
        .iter()
        .map(|p| format!("{:#x}", p.condition_id))
        .collect();

    let db_open = pool_client
        .query(
            "SELECT DISTINCT condition_id FROM pm_rust_trades WHERE resolved = false AND execution_status = 'filled' AND model_version = 'synced'",
            &[],
        )
        .await?;

    for row in &db_open {
        let cid: String = row.get(0);
        if !open_condition_ids.contains(&cid) {
            // Position no longer exists on PM — mark resolved
            // Don't set real_pnl since we don't know the resolution price
            let sql = format!(
                "UPDATE pm_rust_trades SET resolved = true, resolved_at = NOW() WHERE condition_id = '{cid}' AND resolved = false AND execution_status = 'filled' AND model_version = 'synced'",
                cid = esc(&cid),
            );
            let _ = pool_client.simple_query(&sql).await;
            debug!(condition_id = %cid, "synced position no longer on PM — resolved");
        }
    }

    info!(
        buys = buys.len(),
        buys_inserted,
        sells = sells.len(),
        sells_matched,
        open_positions = positions.len(),
        "sync complete"
    );

    Ok(())
}
