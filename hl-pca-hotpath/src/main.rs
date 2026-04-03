use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use hl_pca_hotpath::{config, pca_engine, regime, signal, ws_feed};
use tokio::sync::{Mutex, broadcast};
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let config = config::AppConfig::load()?;
    info!(paper = config.paper_mode, "starting hl-pca-hotpath");

    let prices: ws_feed::PriceMap = Arc::new(Mutex::new(HashMap::new()));
    let history: ws_feed::PriceHistory = Arc::new(Mutex::new(HashMap::new()));

    let (shutdown_tx, _) = broadcast::channel::<()>(4);

    // WS feed
    let ws_prices = Arc::clone(&prices);
    let ws_history = Arc::clone(&history);
    let ws_url = config.ws_url.clone();
    let ws_shutdown = shutdown_tx.subscribe();
    tokio::spawn(async move {
        if let Err(e) = ws_feed::run_ws_feed(&ws_url, ws_prices, ws_history, ws_shutdown).await {
            tracing::error!(error = %e, "WS feed exited");
        }
    });
    info!("WS feed started");

    // Wait for initial prices
    info!("waiting for price data...");
    loop {
        let n = prices.lock().await.len();
        if n >= config.assets.len() * 80 / 100 {
            info!(assets = n, "price data ready");
            break;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }

    // PCA engine + signal loop
    let mut engine = pca_engine::PcaEngine::new(
        config.num_factors,
        config.pca_lookback_periods,
        config.return_window_ms,
        config.pca_refresh_periods,
    );
    let mut regime_detector = regime::RegimeDetector::new(10, 0.5, 3);
    let mut signal_mgr = signal::SignalManager::new(&config);

    let tick = Duration::from_millis(config.tick_interval_ms);
    let mut interval = tokio::time::interval(tick);
    let mut shutdown_rx = shutdown_tx.subscribe();

    info!("PCA engine started, tick={}ms", config.tick_interval_ms);

    loop {
        tokio::select! {
            biased;
            _ = shutdown_rx.recv() => break,
            _ = interval.tick() => {}
        }

        // Copy price history for PCA
        let hist = {
            let h = history.lock().await;
            let mut m = ahash::AHashMap::new();
            for (k, v) in h.iter() {
                m.insert(k.clone(), v.clone());
            }
            m
        };

        let current_prices = {
            let p = prices.lock().await;
            let mut m = ahash::AHashMap::new();
            for (k, v) in p.iter() {
                m.insert(k.clone(), *v);
            }
            m
        };

        // Run PCA tick
        let signals = match engine.tick(&config.assets, &hist) {
            Some(s) => s,
            None => continue,
        };

        // Update regime
        let pc1_ret = signals.values().next().map(|s| s.pc1_return).unwrap_or(0.0);
        let regime = regime_detector.update(pc1_ret);

        // Check exits first
        let _exits = signal_mgr.check_exits(&signals, &current_prices);

        // Check entries
        let _entries = signal_mgr.check_entries(&signals, &current_prices, regime);

        if signal_mgr.active_count() > 0 {
            info!(
                positions = signal_mgr.active_count(),
                regime = %regime,
                "tick"
            );
        }
    }

    info!("shutdown");
    let _ = shutdown_tx.send(());
    Ok(())
}
