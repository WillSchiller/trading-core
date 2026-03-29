use ahash::AHashMap;
use tracing::info;

use crate::types::Position;

#[derive(Default)]
pub struct PositionTracker {
    by_condition: AHashMap<String, Vec<Position>>,
}

impl PositionTracker {
    pub fn new() -> Self {
        Self {
            by_condition: AHashMap::new(),
        }
    }

    pub fn load(&mut self, positions: Vec<Position>) {
        for pos in positions {
            self.by_condition
                .entry(pos.condition_id.clone())
                .or_default()
                .push(pos);
        }
        info!(
            conditions = self.by_condition.len(),
            total = self.all_positions().len(),
            "positions loaded"
        );
    }

    pub fn track_buy(&mut self, pos: Position) {
        self.by_condition
            .entry(pos.condition_id.clone())
            .or_default()
            .push(pos);
    }

    pub fn get_positions(&self, condition_id: &str) -> Option<&Vec<Position>> {
        self.by_condition.get(condition_id)
    }

    pub fn trade_count(&self, condition_id: &str) -> usize {
        self.by_condition.get(condition_id).map_or(0, |v| v.len())
    }

    pub fn notional(&self, condition_id: &str) -> f64 {
        self.by_condition
            .get(condition_id)
            .map_or(0.0, |positions| {
                positions.iter().map(|p| p.fill_price * p.fill_size).sum()
            })
    }

    pub fn open_market_count(&self) -> usize {
        self.by_condition.len()
    }

    pub fn total_exposure(&self) -> f64 {
        self.by_condition
            .values()
            .flat_map(|v| v.iter())
            .map(|p| p.fill_price * p.fill_size)
            .sum()
    }

    pub fn all_positions(&self) -> Vec<&Position> {
        self.by_condition.values().flat_map(|v| v.iter()).collect()
    }

    pub fn all_condition_ids(&self) -> Vec<String> {
        self.by_condition.keys().cloned().collect()
    }

    pub fn remove_condition(&mut self, condition_id: &str) -> Vec<Position> {
        self.by_condition.remove(condition_id).unwrap_or_default()
    }

    pub fn remove_position(&mut self, condition_id: &str, live_trade_id: i64) -> Option<Position> {
        let positions = self.by_condition.get_mut(condition_id)?;
        let idx = positions
            .iter()
            .position(|p| p.live_trade_id == live_trade_id)?;
        let pos = positions.remove(idx);
        if positions.is_empty() {
            self.by_condition.remove(condition_id);
        }
        Some(pos)
    }
}
