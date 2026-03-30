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
        let fill_size_val = fill.size_usd / fill.fill_price.max(0.01);
        let ts = chrono::Utc::now().timestamp_millis();
        let esc = |s: &str| s.replace('\'', "''");
        let opt_num = |v: Option<f64>| match v {
            Some(x) => format!("{x}"),
            None => "NULL".to_string(),
        };

        let sql = format!(
            "INSERT INTO pm_rust_trades (
                trader_address, condition_id, token_id, side,
                trader_size, trader_price, our_size,
                order_id, fill_price, fill_size, execution_status,
                model_version, win_score, cal_prob, kelly_size,
                market_slug, neg_risk
            ) VALUES (
                '{trader}', '{cid}', '{tid}', '{side}',
                {size}, {price}, {our_size},
                '{oid}', {fpx}, {fsz}, '{status}',
                '{mv}', {ws}, {cp}, {ks},
                '', {neg_risk}
            )
            RETURNING id",
            neg_risk = fill.signal.neg_risk,
            trader = esc(&fill.signal.trader),
            cid = esc(&fill.signal.condition_id),
            tid = esc(&fill.signal.token_id),
            side = side,
            size = fill.signal.size,
            price = fill.signal.price,
            our_size = fill.size_usd,
            oid = esc(&fill.order_id),
            fpx = fill.fill_price,
            fsz = fill_size_val,
            status = fill.execution_status,
            mv = esc(&fill.model_version),
            ws = opt_num(fill.win_score),
            cp = opt_num(fill.cal_prob),
            ks = opt_num(fill.kelly_size),
        );

        let rows = client.simple_query(&sql).await.map_err(|e| {
            tracing::error!(error = %e, sql = %sql, "insert_fill SQL failed");
            HotPathError::Db(e.to_string())
        })?;
        let id = rows
            .iter()
            .find_map(|msg| {
                if let tokio_postgres::SimpleQueryMessage::Row(row) = msg {
                    row.get(0).and_then(|v| v.parse::<i64>().ok())
                } else {
                    None
                }
            })
            .unwrap_or(-1);

        if id > 0 {
            tracing::info!(id, order_id = %fill.order_id, source = "rust", status = fill.execution_status, "fill written to postgres");
        } else {
            tracing::debug!(order_id = %fill.order_id, "duplicate trade or insert skipped");
        }
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
                    order_id, created_at, COALESCE(model_version, '') as mv
             FROM pm_rust_trades
             WHERE execution_status = 'filled' AND resolved = false AND side = 'BUY'",
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
             FROM pm_rust_trades
             WHERE resolved = true AND execution_status IN ('filled', 'sold')
               AND resolved_at >= CURRENT_DATE",
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
             FROM pm_rust_trades
             WHERE execution_status = 'filled' AND resolved = false AND side = 'BUY'
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
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        let sql = format!(
            "UPDATE pm_rust_trades SET resolved = true, resolution_price = {}, real_pnl = {}, resolved_at = NOW() WHERE id = {}",
            resolution_price, real_pnl, live_trade_id
        );
        client.simple_query(&sql).await.map_err(|e| HotPathError::Db(e.to_string()))?;
        Ok(())
    }

    pub async fn mark_sold(
        &self,
        live_trade_id: i64,
        exit_price: f64,
        real_pnl: f64,
        sell_order_id: &str,
    ) -> Result<(), HotPathError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        let esc_oid = sell_order_id.replace('\'', "''");
        let sql = format!(
            "UPDATE pm_rust_trades SET execution_status = 'sold', resolution_price = {}, real_pnl = {}, resolved = true, resolved_at = NOW(), order_id = order_id || ',' || '{}' WHERE id = {}",
            exit_price, real_pnl, esc_oid, live_trade_id
        );
        client.simple_query(&sql).await.map_err(|e| HotPathError::Db(e.to_string()))?;
        Ok(())
    }

    pub async fn update_current_price(
        &self,
        live_trade_id: i64,
        current_price: f64,
    ) -> Result<(), HotPathError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        let sql = format!("UPDATE pm_rust_trades SET pnl = {} WHERE id = {}", current_price, live_trade_id);
        client.simple_query(&sql).await.map_err(|e| HotPathError::Db(e.to_string()))?;
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
        let fp = fill_price.map(|v| format!("{v}")).unwrap_or("fill_price".to_owned());
        let fs = fill_size.map(|v| format!("{v}")).unwrap_or("fill_size".to_owned());
        let sql = format!(
            "UPDATE pm_rust_trades SET execution_status = '{}', fill_price = {}, fill_size = {} WHERE id = {}",
            status.replace('\'', "''"), fp, fs, live_trade_id
        );
        client.simple_query(&sql).await
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
