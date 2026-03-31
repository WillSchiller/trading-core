use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use polymarket_client_sdk::data::Client as DataClient;
use polymarket_client_sdk::data::types::Side;
use polymarket_client_sdk::data::types::request::TradesRequest;
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

        if let Err(e) = sync_sells(&config, &data_client, &db).await {
            warn!(error = %e, "trade sync error");
        }
    }
}

async fn sync_sells(
    config: &AppConfig,
    client: &DataClient,
    db: &FillDb,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let req = TradesRequest::builder()
        .user(Address::from_str(&config.our_wallet).unwrap())
        .side(Side::Sell)
        .build();

    let trades = client.trades(&req).await?;
    debug!(count = trades.len(), "fetched sell trades from data API");

    for trade in &trades {
        let condition_id = format!("{:#x}", trade.condition_id);
        let price: f64 = trade.price.to_string().parse().unwrap_or(0.0);

        let pool_client = db.pool().get().await?;
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
