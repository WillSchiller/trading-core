use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use hl_pca_hotpath::{config, db, pca_engine, regime, signal, ws_feed};
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

    // XYZ stock/commodity price poller
    let xyz_prices = Arc::clone(&prices);
    let xyz_history = Arc::clone(&history);
    let xyz_config = config.clone();
    let xyz_shutdown = shutdown_tx.subscribe();
    tokio::spawn(async move {
        ws_feed::run_xyz_poller(xyz_config, xyz_prices, xyz_history, xyz_shutdown).await;
    });

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

    // Postgres
    let signal_db = if config.database_url.is_empty() {
        info!("no database_url — signals will NOT be persisted");
        None
    } else {
        match db::SignalDb::connect(&config.database_url) {
            Ok(d) => {
                info!("postgres connected");
                Some(d)
            }
            Err(e) => {
                tracing::warn!(error = %e, "DB connect failed");
                None
            }
        }
    };

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

        // Log top z-scores every tick
        let mut z_list: Vec<(&String, f64, f64)> = signals
            .iter()
            .map(|(a, s)| (a, s.z_score, s.ewma_vol_bps))
            .collect();
        z_list.sort_by(|a, b| b.1.abs().partial_cmp(&a.1.abs()).unwrap());
        if let Some((top_asset, top_z, top_vol)) = z_list.first() {
            info!(
                top_asset = %top_asset,
                top_z = format!("{:.2}", top_z),
                top_vol = format!("{:.0}", top_vol),
                regime = %regime_detector.state(),
                threshold = config.entry_z_score,
                n_above_2 = z_list.iter().filter(|(_, z, _)| z.abs() > 2.0).count(),
                "tick summary"
            );
        }

        // Update regime
        let pc1_ret = signals.values().next().map(|s| s.pc1_return).unwrap_or(0.0);
        let regime = regime_detector.update(pc1_ret);

        // Check exits first
        let exits = signal_mgr.check_exits(&signals, &current_prices);
        for (asset, reason, price, pos) in &exits {
            if let (Some(db), Some(id)) = (&signal_db, pos.db_id) {
                let pnl_bps = pos.pnl_bps(*price);
                let pnl_usd = pnl_bps / 10000.0 * pos.size_usd;
                let _ = db
                    .resolve_signal(
                        id,
                        *price,
                        pnl_bps,
                        pnl_usd,
                        pos.hold_ms(),
                        *reason,
                        pos.peak_pnl_bps,
                        pos.trough_pnl_bps,
                    )
                    .await;
            }
        }

        // Check entries
        let entries = signal_mgr.check_entries(&signals, &current_prices, regime);
        for (asset, price, size) in &entries {
            if let Some(db) = &signal_db {
                let sig = signals.get(asset).unwrap();
                match db
                    .insert_signal(
                        asset,
                        "short",
                        sig.z_score,
                        sig.residual,
                        sig.pc1_return,
                        sig.pc2_return,
                        *price,
                        *size,
                        sig.ewma_vol_bps,
                        regime,
                        0.0,
                    )
                    .await
                {
                    Ok(id) => {
                        signal_mgr.set_db_id(asset, id);
                    }
                    Err(e) => tracing::warn!(error = %e, "failed to persist signal"),
                }
            }
        }

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
