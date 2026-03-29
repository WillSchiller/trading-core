use deadpool_postgres::{Config, ManagerConfig, Pool, RecyclingMethod, Runtime};
use tokio_postgres::NoTls;

use crate::types::{CopySide, HotPathError, TradeSignal};

pub struct FillDb {
    pool: Pool,
}

pub struct FillRecord {
    pub signal: TradeSignal,
    pub order_id: String,
    pub execution_status: &'static str,
    pub size_usd: f64,
    pub fill_price: f64,
}

impl FillDb {
    pub fn connect(database_url: &str) -> Result<Self, HotPathError> {
        let mut cfg = Config::new();
        cfg.url = Some(database_url.to_owned());
        cfg.manager = Some(ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        });
        let pool = cfg
            .create_pool(Some(Runtime::Tokio1), NoTls)
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        Ok(Self { pool })
    }

    pub async fn insert_fill(&self, fill: &FillRecord) -> Result<(), HotPathError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;

        let side = match fill.signal.side {
            CopySide::Buy => "BUY",
            CopySide::Sell => "SELL",
        };

        client.execute(
            "INSERT INTO pm_live_trades (
                trader_address, condition_id, token_id, side,
                size, price, our_size, our_entry_price,
                order_id, fill_price, execution_status, executed_at,
                trader_timestamp, source
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12, 'rust')
            ON CONFLICT (trader_address, condition_id, token_id, side, trader_timestamp) DO NOTHING",
            &[
                &fill.signal.trader,
                &fill.signal.condition_id,
                &fill.signal.token_id,
                &side,
                &fill.signal.size,
                &fill.signal.price,
                &fill.size_usd,
                &fill.fill_price,
                &fill.order_id,
                &fill.fill_price,
                &fill.execution_status,
                &(chrono::Utc::now().timestamp_millis()),
            ],
        ).await.map_err(|e| HotPathError::Db(e.to_string()))?;

        tracing::info!(
            order_id = %fill.order_id,
            source = "rust",
            status = fill.execution_status,
            "fill written to postgres"
        );

        Ok(())
    }
}
