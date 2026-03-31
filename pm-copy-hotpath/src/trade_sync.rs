use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use polymarket_client_sdk::data::Client as DataClient;
use polymarket_client_sdk::data::types::Side;
use polymarket_client_sdk::data::types::request::{
    ClosedPositionsRequest, PositionsRequest, TradesRequest,
};
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

    // Full reconciliation on startup
    if let Err(e) = reconcile(&addr, &data_client, &db).await {
        warn!(error = %e, "initial reconciliation failed");
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

        if let Err(e) = reconcile(&addr, &data_client, &db).await {
            warn!(error = %e, "reconciliation error");
        }
    }
}

async fn reconcile(
    addr: &Address,
    client: &DataClient,
    db: &FillDb,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let pool = db.pool().get().await?;
    let esc = |s: &str| s.replace('\'', "''");

    // 1. Sync OPEN positions — one row per position (aggregated by PM)
    let pos_req = PositionsRequest::builder().user(*addr).build();
    let positions = client.positions(&pos_req).await?;

    let mut pm_condition_ids: Vec<String> = Vec::new();

    for pos in &positions {
        let condition_id = format!("{:#x}", pos.condition_id);
        let token_id = format!("{}", pos.asset);
        let size: f64 = pos.size.to_string().parse().unwrap_or(0.0);
        let avg_price: f64 = pos.avg_price.to_string().parse().unwrap_or(0.0);
        let cur_price: f64 = pos.cur_price.to_string().parse().unwrap_or(0.0);
        let cost = pos
            .initial_value
            .to_string()
            .parse::<f64>()
            .unwrap_or(avg_price * size);
        let order_key = format!("synced-{}", &condition_id[..10.min(condition_id.len())]);

        pm_condition_ids.push(condition_id.clone());

        let sql = format!(
            "INSERT INTO pm_rust_trades (
                trader_address, condition_id, token_id, side,
                trader_size, trader_price, our_size,
                order_id, fill_price, fill_size, execution_status,
                model_version, market_slug, outcome, neg_risk, pnl
            ) VALUES (
                'self', '{cid}', '{tid}', 'BUY',
                {size}, {avg_price}, {cost},
                '{order_key}', {avg_price}, {size}, 'filled',
                'synced', '{slug}', '{outcome}', {neg_risk}, {cur_price}
            )
            ON CONFLICT (order_id) WHERE order_id <> '' AND order_id IS NOT NULL
            DO UPDATE SET
                fill_size = EXCLUDED.fill_size,
                fill_price = EXCLUDED.fill_price,
                trader_size = EXCLUDED.trader_size,
                our_size = EXCLUDED.our_size,
                pnl = EXCLUDED.pnl,
                market_slug = EXCLUDED.market_slug,
                outcome = EXCLUDED.outcome",
            cid = esc(&condition_id),
            tid = esc(&token_id),
            order_key = esc(&order_key),
            size = size,
            avg_price = avg_price,
            cost = cost,
            slug = esc(&pos.slug),
            outcome = esc(&pos.outcome),
            neg_risk = pos.negative_risk,
            cur_price = cur_price,
        );
        if let Err(e) = pool.simple_query(&sql).await {
            debug!(error = %e, title = %pos.title, "position upsert failed");
        }
    }

    if !pm_condition_ids.is_empty() {
        let in_list: String = pm_condition_ids
            .iter()
            .map(|c| format!("'{}'", esc(c)))
            .collect::<Vec<_>>()
            .join(",");
        let vanished_sql = format!(
            "UPDATE pm_rust_trades SET resolved = true, resolved_at = NOW(), execution_status = 'sold'
             WHERE model_version = 'synced' AND resolved = false AND condition_id NOT IN ({in_list})"
        );
        if let Err(e) = pool.simple_query(&vanished_sql).await {
            warn!(error = %e, "vanished position cleanup failed");
        }
    }

    // 2. Sync CLOSED positions — realized PnL
    let closed_req = ClosedPositionsRequest::builder().user(*addr).build();
    let closed = client.closed_positions(&closed_req).await?;

    for pos in &closed {
        let condition_id = format!("{:#x}", pos.condition_id);
        let order_key = format!("closed-{}", &condition_id[..10.min(condition_id.len())]);

        let exists = pool
            .query(
                "SELECT 1 FROM pm_rust_trades WHERE order_id = $1 LIMIT 1",
                &[&order_key],
            )
            .await?;
        if !exists.is_empty() {
            continue;
        }

        let size: f64 = pos.total_bought.to_string().parse().unwrap_or(0.0);
        let avg_price: f64 = pos.avg_price.to_string().parse().unwrap_or(0.0);
        let payout: f64 = pos.realized_pnl.to_string().parse().unwrap_or(0.0);
        let cost = avg_price * size;
        let real_pnl = payout - cost;

        let sql = format!(
            "INSERT INTO pm_rust_trades (
                trader_address, condition_id, token_id, side,
                trader_size, trader_price, our_size,
                order_id, fill_price, fill_size, execution_status,
                model_version, market_slug, outcome, neg_risk,
                resolved, real_pnl, resolved_at
            ) VALUES (
                'self', '{cid}', '{tid}', 'BUY',
                {size}, {avg_price}, {cost},
                '{order_key}', {avg_price}, {size}, 'sold',
                'synced', '{slug}', '{outcome}', false,
                true, {real_pnl}, NOW()
            )",
            cid = esc(&condition_id),
            tid = esc(&format!("{}", pos.asset)),
            size = size,
            avg_price = avg_price,
            cost = cost,
            order_key = esc(&order_key),
            slug = esc(&pos.slug),
            outcome = esc(&pos.outcome),
            real_pnl = real_pnl,
        );
        if let Err(e) = pool.simple_query(&sql).await {
            debug!(error = %e, slug = %pos.slug, "closed position insert failed");
        }
    }

    // 3. Match sell trades to non-synced open positions
    let sell_req = TradesRequest::builder()
        .user(*addr)
        .side(Side::Sell)
        .build();
    let sells = client.trades(&sell_req).await?;
    let mut sells_matched = 0;

    for trade in &sells {
        let condition_id = format!("{:#x}", trade.condition_id);
        let price: f64 = trade.price.to_string().parse().unwrap_or(0.0);

        let check = pool
            .query(
                "SELECT id FROM pm_rust_trades WHERE condition_id = $1 AND execution_status = 'filled' AND resolved = false AND model_version != 'synced' LIMIT 1",
                &[&condition_id],
            )
            .await?;

        if let Some(row) = check.first() {
            let id: i64 = row.get(0);
            let sql = format!(
                "UPDATE pm_rust_trades SET execution_status = 'sold', resolution_price = {price}, real_pnl = ({price} - fill_price::float8) * fill_size::float8, resolved = true, resolved_at = to_timestamp({ts}) WHERE id = {id} AND resolved = false",
                price = price,
                ts = trade.timestamp,
                id = id,
            );
            if pool.simple_query(&sql).await.is_ok() {
                sells_matched += 1;
            }
        }
    }

    info!(
        open = positions.len(),
        closed = closed.len(),
        sells_matched,
        "reconciliation complete"
    );

    Ok(())
}
