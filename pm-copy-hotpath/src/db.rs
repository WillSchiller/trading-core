use deadpool_postgres::{Config, ManagerConfig, Pool, RecyclingMethod, Runtime};
use tokio_postgres::NoTls;

use crate::types::{CopySide, HotPathError, Position};

pub struct FillDb {
    pool: Pool,
}

pub struct FillRecord {
    pub signal: crate::types::TradeSignal,
    pub order_id: String,
    pub execution_status: &'static str,
    pub size_usd: f64,
    pub fill_price: f64,
    pub model_version: String,
    pub win_score: Option<f64>,
    pub cal_prob: Option<f64>,
    pub kelly_size: Option<f64>,
}

pub struct TraderRollingStats {
    pub pnls: Vec<f64>,
    pub total_trades: usize,
    pub median_size: f64,
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

    pub async fn insert_fill(&self, fill: &FillRecord) -> Result<i64, HotPathError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;

        let side = match fill.signal.side {
            CopySide::Buy => "BUY",
            CopySide::Sell => "SELL",
        };

        let s = |v: f64| format!("{v}");
        let s_opt = |v: Option<f64>| v.map(|x| format!("{x}"));

        let size = s(fill.signal.size);
        let price = s(fill.signal.price);
        let our_size = s(fill.size_usd);
        let entry_price = s(fill.fill_price);
        let fill_size_val = s(fill.size_usd / fill.fill_price.max(0.01));
        let win_score = s_opt(fill.win_score);
        let cal_prob = s_opt(fill.cal_prob);
        let kelly_size = s_opt(fill.kelly_size);
        let ts = chrono::Utc::now().timestamp_millis();

        let row = client.query_opt(
            "INSERT INTO pm_live_trades (
                trader_address, condition_id, token_id, side,
                size, price, our_size, our_entry_price,
                order_id, fill_price, fill_size, execution_status, executed_at,
                trader_timestamp, source, model_version,
                win_score, cal_prob, kelly_size
            ) VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9, $10::numeric, $11::numeric, $12, NOW(), $13, 'rust', $14, $15::numeric, $16::numeric, $17::numeric)
            ON CONFLICT (trader_address, condition_id, token_id, side, trader_timestamp) DO NOTHING
            RETURNING id",
            &[
                &fill.signal.trader,
                &fill.signal.condition_id,
                &fill.signal.token_id,
                &side,
                &size,
                &price,
                &our_size,
                &entry_price,
                &fill.order_id,
                &entry_price,
                &fill_size_val,
                &fill.execution_status,
                &ts,
                &fill.model_version,
                &win_score,
                &cal_prob,
                &kelly_size,
            ],
        ).await.map_err(|e| HotPathError::Db(e.to_string()))?;

        let id = match row {
            Some(r) => r.get::<_, i64>(0),
            None => {
                tracing::debug!(order_id = %fill.order_id, "duplicate trade, skipped");
                return Ok(-1);
            }
        };
        tracing::info!(id, order_id = %fill.order_id, source = "rust", status = fill.execution_status, "fill written to postgres");
        Ok(id)
    }

    pub async fn load_open_positions(&self) -> Result<Vec<Position>, HotPathError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        let rows = client
            .query(
                "SELECT id, condition_id, token_id, fill_price::float8, fill_size::float8,
                    order_id, executed_at, COALESCE(model_version, '') as mv
             FROM pm_live_trades
             WHERE execution_status = 'filled' AND resolved = false AND side = 'BUY' AND source = 'rust'",
                &[],
            )
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;

        let mut positions = Vec::with_capacity(rows.len());
        for row in &rows {
            let id: i64 = row.get(0);
            let condition_id: String = row.get(1);
            let token_id: String = row.get(2);
            let fill_price: f64 = row.get(3);
            let fill_size: f64 = row.get(4);
            let order_id: Option<String> = row.get(5);
            let executed_at: Option<chrono::DateTime<chrono::Utc>> = row.get(6);
            let model_version: String = row.get(7);
            positions.push(Position {
                live_trade_id: id,
                condition_id,
                token_id,
                fill_price,
                fill_size,
                order_id: order_id.unwrap_or_default(),
                neg_risk: false,
                filled_at: executed_at.unwrap_or_else(chrono::Utc::now),
                model_version,
            });
        }
        Ok(positions)
    }

    pub async fn get_daily_pnl(&self) -> Result<f64, HotPathError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        let row = client
            .query_one(
                "SELECT COALESCE(SUM(real_pnl), 0)::float8
             FROM pm_live_trades
             WHERE resolved = true AND execution_status IN ('filled', 'sold')
               AND resolved_at >= CURRENT_DATE AND source = 'rust'",
                &[],
            )
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        Ok(row.get(0))
    }

    pub async fn get_market_trade_counts(&self) -> Result<Vec<(String, usize)>, HotPathError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        let rows = client
            .query(
                "SELECT condition_id, COUNT(*)::int
             FROM pm_live_trades
             WHERE execution_status = 'filled' AND resolved = false AND side = 'BUY' AND source = 'rust'
             GROUP BY condition_id",
                &[],
            )
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        Ok(rows
            .iter()
            .map(|r| {
                let cid: String = r.get(0);
                let count: i32 = r.get(1);
                (cid, count as usize)
            })
            .collect())
    }

    pub async fn resolve_trade(
        &self,
        live_trade_id: i64,
        resolution_price: f64,
        real_pnl: f64,
    ) -> Result<(), HotPathError> {
        let s = |v: f64| format!("{v}");
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        client
            .execute(
                "UPDATE pm_live_trades
             SET resolved = true, resolution_price = $2::numeric, real_pnl = $3::numeric, resolved_at = NOW()
             WHERE id = $1",
                &[&live_trade_id, &s(resolution_price), &s(real_pnl)],
            )
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        Ok(())
    }

    pub async fn mark_sold(
        &self,
        live_trade_id: i64,
        exit_price: f64,
        real_pnl: f64,
        sell_order_id: &str,
    ) -> Result<(), HotPathError> {
        let s = |v: f64| format!("{v}");
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        client
            .execute(
                "UPDATE pm_live_trades
             SET execution_status = 'sold', resolution_price = $2::numeric, real_pnl = $3::numeric,
                 resolved = true, resolved_at = NOW(), order_id = order_id || ',' || $4
             WHERE id = $1",
                &[&live_trade_id, &s(exit_price), &s(real_pnl), &sell_order_id],
            )
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        Ok(())
    }

    pub async fn update_current_price(
        &self,
        live_trade_id: i64,
        current_price: f64,
    ) -> Result<(), HotPathError> {
        let s = |v: f64| format!("{v}");
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        client
            .execute(
                "UPDATE pm_live_trades SET current_price = $2::numeric WHERE id = $1",
                &[&live_trade_id, &s(current_price)],
            )
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        Ok(())
    }

    pub async fn update_execution_status(
        &self,
        live_trade_id: i64,
        status: &str,
        fill_price: Option<f64>,
        fill_size: Option<f64>,
    ) -> Result<(), HotPathError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        client
            .execute(
                "UPDATE pm_live_trades
             SET execution_status = $2,
                 fill_price = COALESCE($3, fill_price),
                 fill_size = COALESCE($4, fill_size)
             WHERE id = $1",
                &[&live_trade_id, &status, &fill_price, &fill_size],
            )
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        Ok(())
    }

    pub async fn save_kill_switch_event(
        &self,
        reason: &str,
        daily_pnl: f64,
        total_exposure: f64,
        positions_open: usize,
    ) -> Result<(), HotPathError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        client.execute(
            "INSERT INTO pm_kill_switch_events (reason, daily_pnl, total_exposure, positions_open, triggered_at)
             VALUES ($1, $2, $3, $4, NOW())",
            &[&reason, &daily_pnl, &total_exposure, &(positions_open as i32)],
        ).await.map_err(|e| HotPathError::Db(e.to_string()))?;
        Ok(())
    }

    pub async fn get_trader_rolling_stats(
        &self,
        address: &str,
    ) -> Result<TraderRollingStats, HotPathError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        let rows = client
            .query(
                "SELECT pnl_if_copied::float8 as pnl, size::float8 as trade_size
             FROM pm_shadow_trades
             WHERE trader_address = $1 AND resolved = true AND side = 'BUY' AND our_entry_price > 0
             ORDER BY trader_timestamp",
                &[&address],
            )
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;

        let pnls: Vec<f64> = rows.iter().map(|r| r.get::<_, f64>(0)).collect();
        let mut sizes: Vec<f64> = rows.iter().map(|r| r.get::<_, f64>(1)).collect();
        sizes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let median_size = if sizes.is_empty() {
            1.0
        } else {
            sizes[sizes.len() / 2]
        };
        let total_trades = pnls.len();

        Ok(TraderRollingStats {
            pnls,
            total_trades,
            median_size,
        })
    }

    pub fn pool(&self) -> &Pool {
        &self.pool
    }
}
