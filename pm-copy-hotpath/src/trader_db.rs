//! Precomputed scores: load once, hot-path lookup with **no allocation** on hit.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use ahash::AHashMap;

use crate::types::HotPathError;

pub struct TraderDb {
    /// Keys are **lowercase** hex addresses (`0x...`).
    scores: AHashMap<String, f64>,
}

impl TraderDb {
    pub fn load(path: &Path) -> Result<Self, HotPathError> {
        let raw = fs::read_to_string(path)?;
        let parsed: HashMap<String, f64> = serde_json::from_str(&raw)?;
        let mut scores = AHashMap::with_capacity(parsed.len());
        for (k, v) in parsed {
            scores.insert(normalize_key(&k)?, v);
        }
        Ok(Self { scores })
    }

    /// O(1) lookup; **zero heap allocation** when `trader_lower` is already lowercase & 'static is not required.
    #[inline]
    pub fn score_for(&self, trader_lower: &str) -> Option<f64> {
        self.scores.get(trader_lower).copied()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.scores.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.scores.is_empty()
    }
}

fn normalize_key(addr: &str) -> Result<String, HotPathError> {
    let s = addr.trim().to_lowercase();
    if s.len() < 3 || !s.starts_with("0x") {
        return Err(HotPathError::BadAddress(addr.to_owned()));
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_is_case_insensitive_at_load() {
        let mut m = HashMap::new();
        m.insert("0xABCDEF0123456789abcdef0123456789abcdef01".to_owned(), 0.9);
        let json = serde_json::to_string(&m).unwrap();
        let dir = std::env::temp_dir();
        let p = dir.join("pm-traders-test.json");
        std::fs::write(&p, &json).unwrap();
        let db = TraderDb::load(&p).unwrap();
        assert!(
            (db.score_for("0xabcdef0123456789abcdef0123456789abcdef01")
                .unwrap()
                - 0.9)
                .abs()
                < 1e-9
        );
        std::fs::remove_file(p).ok();
    }
}
