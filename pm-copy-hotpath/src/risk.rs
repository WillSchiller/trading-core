use std::time::Instant;

use ahash::AHashMap;
use tracing::{info, warn};

use crate::config::AppConfig;

struct MarketEntry {
    last_order: Instant,
    trade_count: usize,
}

pub struct RiskManager {
    markets: AHashMap<String, MarketEntry>,
    pending_exposure: f64,
    kill_switch: bool,
    max_position_usd: f64,
    max_total_exposure_usd: f64,
    daily_loss_limit_usd: f64,
    max_markets_open: usize,
    max_trades_per_market: usize,
    market_dedup_seconds: u64,
}

impl RiskManager {
    pub fn new(config: &AppConfig) -> Self {
        Self {
            markets: AHashMap::new(),
            pending_exposure: 0.0,
            kill_switch: false,
            max_position_usd: config.max_position_usd,
            max_total_exposure_usd: config.max_total_exposure_usd,
            daily_loss_limit_usd: config.daily_loss_limit_usd,
            max_markets_open: config.max_markets_open,
            max_trades_per_market: config.max_trades_per_market,
            market_dedup_seconds: config.market_dedup_seconds,
        }
    }

    pub fn is_killed(&self) -> bool {
        self.kill_switch
    }

    pub fn trigger_kill_switch(&mut self, reason: &str) {
        self.kill_switch = true;
        warn!(reason, "KILL SWITCH TRIGGERED");
    }

    /// Check all risk gates. Returns Ok(()) if trade is allowed, Err(reason) if not.
    #[allow(clippy::too_many_arguments)]
    pub fn can_trade(
        &mut self,
        proposed_size_usd: f64,
        condition_id: &str,
        total_exposure: f64,
        open_markets: usize,
        daily_pnl: f64,
        position_notional: f64,
        position_trade_count: usize,
    ) -> Result<(), String> {
        if self.kill_switch {
            return Err("kill switch triggered".into());
        }

        // Market dedup
        if let Some(entry) = self.markets.get(condition_id) {
            if entry.last_order.elapsed().as_secs() < self.market_dedup_seconds {
                return Err(format!(
                    "market dedup: {}s since last order",
                    entry.last_order.elapsed().as_secs()
                ));
            }
            if entry.trade_count >= self.max_trades_per_market {
                return Err(format!(
                    "max {} trades per market reached",
                    self.max_trades_per_market
                ));
            }
        }

        let effective_exposure = total_exposure + self.pending_exposure;
        if effective_exposure + proposed_size_usd > self.max_total_exposure_usd {
            return Err(format!(
                "exposure {:.0} + {:.0} > limit {:.0}",
                effective_exposure, proposed_size_usd, self.max_total_exposure_usd
            ));
        }

        if position_notional + proposed_size_usd > self.max_position_usd {
            return Err(format!(
                "position {:.0} + {:.0} > limit {:.0}",
                position_notional, proposed_size_usd, self.max_position_usd
            ));
        }

        if position_trade_count >= self.max_trades_per_market {
            return Err(format!(
                "market has {} trades, max {}",
                position_trade_count, self.max_trades_per_market
            ));
        }

        if position_trade_count == 0 && open_markets >= self.max_markets_open {
            return Err(format!(
                "open markets {} at limit {}",
                open_markets, self.max_markets_open
            ));
        }

        if daily_pnl < -self.daily_loss_limit_usd {
            return Err(format!(
                "daily PnL {:.2} exceeds limit -{:.0}",
                daily_pnl, self.daily_loss_limit_usd
            ));
        }

        Ok(())
    }

    pub fn record_order(&mut self, condition_id: &str, size_usd: f64) {
        self.pending_exposure += size_usd;
        let entry = self
            .markets
            .entry(condition_id.to_owned())
            .or_insert(MarketEntry {
                last_order: Instant::now(),
                trade_count: 0,
            });
        entry.last_order = Instant::now();
        entry.trade_count += 1;
    }

    pub fn release_pending(&mut self, size_usd: f64) {
        self.pending_exposure = (self.pending_exposure - size_usd).max(0.0);
    }

    pub fn check_kill_switch(&mut self, daily_pnl: f64) {
        if !self.kill_switch && daily_pnl < -self.daily_loss_limit_usd {
            self.trigger_kill_switch(&format!(
                "daily PnL {:.2} hit limit -{:.0}",
                daily_pnl, self.daily_loss_limit_usd
            ));
        }
    }

    /// Load existing market trade counts from position data.
    pub fn seed_market_counts(&mut self, counts: Vec<(String, usize)>) {
        for (condition_id, count) in counts {
            self.markets.entry(condition_id).or_insert(MarketEntry {
                last_order: Instant::now()
                    - std::time::Duration::from_secs(self.market_dedup_seconds + 1),
                trade_count: count,
            });
        }
        info!(
            markets = self.markets.len(),
            "risk manager seeded with existing positions"
        );
    }
}
