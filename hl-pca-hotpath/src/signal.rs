use ahash::AHashMap;
use tracing::info;

use crate::config::AppConfig;
use crate::pca_engine::AssetSignal;
use crate::types::{ActivePosition, ExitReason, RegimeState};

pub struct SignalManager {
    positions: AHashMap<String, ActivePosition>,
    allowlist: ahash::AHashSet<String>,
    entry_z: f64,
    stop_loss_bps: f64,
    max_hold_ms: u64,
    min_vol_bps: f64,
    min_pc1_bps: f64,
    max_positions: usize,
    base_size: f64,
}

impl SignalManager {
    pub fn new(config: &AppConfig) -> Self {
        let allowlist = config.allowlist.iter().cloned().collect();
        Self {
            positions: AHashMap::new(),
            allowlist,
            entry_z: config.entry_z_score,
            stop_loss_bps: config.stop_loss_bps,
            max_hold_ms: config.max_hold_ms,
            min_vol_bps: config.min_volatility_bps,
            min_pc1_bps: config.min_pc1_return_bps,
            max_positions: config.max_positions,
            base_size: config.base_notional_usd,
        }
    }

    pub fn check_exits(
        &mut self,
        signals: &AHashMap<String, AssetSignal>,
        prices: &AHashMap<String, f64>,
    ) -> Vec<(String, ExitReason, f64, ActivePosition)> {
        let mut exits = Vec::new();

        for (asset, pos) in &mut self.positions {
            let price = match prices.get(asset) {
                Some(p) => *p,
                None => continue,
            };
            let pnl_bps = pos.pnl_bps(price);
            pos.peak_pnl_bps = pos.peak_pnl_bps.max(pnl_bps);
            pos.trough_pnl_bps = pos.trough_pnl_bps.min(pnl_bps);

            // Stop loss
            if pnl_bps <= -self.stop_loss_bps {
                exits.push((asset.clone(), ExitReason::StopLoss, price));
                continue;
            }

            // Time stop
            if pos.hold_ms() >= self.max_hold_ms as i64 {
                exits.push((asset.clone(), ExitReason::TimeStop, price));
                continue;
            }

            // Zero cross (z-score reverted)
            if let Some(sig) = signals.get(asset) {
                if sig.z_score <= 0.0 {
                    exits.push((asset.clone(), ExitReason::ZeroCross, price));
                    continue;
                }
            }

            // Trailing stop
            if pos.peak_pnl_bps >= 25.0 && pnl_bps < pos.peak_pnl_bps - 20.0 {
                exits.push((asset.clone(), ExitReason::TrailingStop, price));
            }
        }

        let exit_keys: Vec<(String, ExitReason, f64)> = exits;
        let mut result = Vec::new();
        for (asset, reason, price) in exit_keys {
            let pos = self.positions.remove(&asset).unwrap();
            let pnl = pos.pnl_bps(price);
            info!(
                asset = %asset,
                reason = %reason,
                pnl_bps = format!("{:.1}", pnl),
                hold_ms = pos.hold_ms(),
                "EXIT"
            );
            result.push((asset, reason, price, pos));
        }

        result
    }

    pub fn check_entries(
        &mut self,
        signals: &AHashMap<String, AssetSignal>,
        prices: &AHashMap<String, f64>,
        regime: RegimeState,
    ) -> Vec<(String, f64, f64)> {
        let mut entries = Vec::new();

        if regime == RegimeState::Bearish {
            return entries;
        }

        if self.positions.len() >= self.max_positions {
            return entries;
        }

        for (asset, sig) in signals {
            if !self.allowlist.contains(asset) {
                continue;
            }
            if self.positions.contains_key(asset) {
                continue;
            }
            if sig.z_score < self.entry_z {
                continue;
            }
            if sig.ewma_vol_bps < self.min_vol_bps {
                continue;
            }
            if sig.pc1_return * 10000.0 < self.min_pc1_bps {
                continue;
            }

            let price = match prices.get(asset) {
                Some(p) => *p,
                None => continue,
            };

            let pos = ActivePosition {
                asset: asset.clone(),
                entry_price: price,
                entry_z: sig.z_score,
                size_usd: self.base_size,
                entered_at: chrono::Utc::now(),
                peak_pnl_bps: 0.0,
                trough_pnl_bps: 0.0,
                db_id: None,
            };

            info!(
                asset,
                z = format!("{:.2}", sig.z_score),
                vol = format!("{:.0}", sig.ewma_vol_bps),
                price,
                size = self.base_size,
                regime = %regime,
                "ENTRY SHORT"
            );

            self.positions.insert(asset.clone(), pos);
            entries.push((asset.clone(), price, self.base_size));

            if self.positions.len() >= self.max_positions {
                break;
            }
        }

        entries
    }

    pub fn set_db_id(&mut self, asset: &str, id: i64) {
        if let Some(pos) = self.positions.get_mut(asset) {
            pos.db_id = Some(id);
        }
    }

    pub fn active_count(&self) -> usize {
        self.positions.len()
    }
}
