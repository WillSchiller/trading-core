use deadpool_postgres::{Config, Pool, Runtime};
use tokio_postgres::NoTls;
use tracing::{info, warn};

use crate::types::{ExitReason, HotPathError, RegimeState};

pub struct SignalDb {
    pool: Pool,
}

impl SignalDb {
    pub fn connect(database_url: &str) -> Result<Self, HotPathError> {
        let mut cfg = Config::new();
        cfg.url = Some(database_url.to_owned());
        let pool = cfg
            .create_pool(Some(Runtime::Tokio1), NoTls)
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        Ok(Self { pool })
    }

    pub async fn insert_signal(
        &self,
        asset: &str,
        direction: &str,
        z_score: f64,
        residual: f64,
        pc1_return: f64,
        pc2_return: f64,
        entry_price: f64,
        position_size_usd: f64,
        ewma_vol_bps: f64,
        regime_state: RegimeState,
        pc1_momentum: f64,
    ) -> Result<i64, HotPathError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        let esc = |s: &str| s.replace('\'', "''");
        let sql = format!(
            "INSERT INTO pca_signals (asset, direction, z_score, residual, confidence, pc1_return, pc2_return, entry_price, position_size_usd, ewma_vol_bps, regime_state, pc1_momentum, resolved, timestamp)
             VALUES ('{asset}', '{direction}', {z_score}, {residual}, 1.0, {pc1_return}, {pc2_return}, {entry_price}, {position_size_usd}, {ewma_vol_bps}, '{regime}', {pc1_momentum}, false, NOW())
             RETURNING id",
            asset = esc(asset),
            direction = esc(direction),
            z_score = z_score,
            residual = residual,
            pc1_return = pc1_return,
            pc2_return = pc2_return,
            entry_price = entry_price,
            position_size_usd = position_size_usd,
            ewma_vol_bps = ewma_vol_bps,
            regime = regime_state,
            pc1_momentum = pc1_momentum,
        );

        let rows = client.simple_query(&sql).await.map_err(|e| {
            warn!(error = %e, "insert_signal failed");
            HotPathError::Db(e.to_string())
        })?;

        for row in &rows {
            if let tokio_postgres::SimpleQueryMessage::Row(r) = row {
                if let Some(id_str) = r.get(0) {
                    if let Ok(id) = id_str.parse::<i64>() {
                        info!(
                            id,
                            asset,
                            z_score = format!("{:.2}", z_score),
                            "signal persisted"
                        );
                        return Ok(id);
                    }
                }
            }
        }
        Err(HotPathError::Db("no id returned".into()))
    }

    pub async fn resolve_signal(
        &self,
        id: i64,
        exit_price: f64,
        pnl_bps: f64,
        pnl_usd: f64,
        hold_time_ms: i64,
        exit_reason: ExitReason,
        peak_pnl_bps: f64,
        trough_pnl_bps: f64,
    ) -> Result<(), HotPathError> {
        let client = self
            .pool
            .get()
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        let sql = format!(
            "UPDATE pca_signals SET resolved = true, exit_price = {exit_price}, pnl_bps = {pnl_bps}, pnl_usd = {pnl_usd}, hold_time_ms = {hold_time_ms}, exit_reason = '{exit_reason}', exit_timestamp = NOW(), peak_pnl_bps = {peak_pnl_bps}, trough_pnl_bps = {trough_pnl_bps} WHERE id = {id}",
            exit_price = exit_price,
            pnl_bps = pnl_bps,
            pnl_usd = pnl_usd,
            hold_time_ms = hold_time_ms,
            exit_reason = exit_reason,
            peak_pnl_bps = peak_pnl_bps,
            trough_pnl_bps = trough_pnl_bps,
            id = id,
        );
        client
            .simple_query(&sql)
            .await
            .map_err(|e| HotPathError::Db(e.to_string()))?;
        Ok(())
    }
}
