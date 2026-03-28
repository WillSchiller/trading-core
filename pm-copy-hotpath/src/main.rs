//! Polymarket copy-trade **hot path**: RTDS activity → `TraderDb` → (optional) CLOB FAK/GTC.
//!
//! Config: `config.toml`, `pm-hotpath.toml`, `config/pm-hotpath.toml`, or env `PM_HOTPATH_*` (see [`pm_copy_hotpath::config::AppConfig`]).

use std::sync::Arc;

use pm_copy_hotpath::{config, order_builder, rtds_listener, trader_db};
use tokio::sync::broadcast;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let app_config = config::AppConfig::load()?;
    tracing::info!(feed_mode = ?app_config.feed_mode(), "starting pm-copy-hotpath");

    let db = Arc::new(trader_db::TraderDb::load(&app_config.traders_json_path)?);
    tracing::info!(traders = db.len(), "trader DB loaded");

    let exec = order_builder::OrderExecutor::connect(&app_config).await?;
    let exec = exec.map(Arc::new);

    let (shutdown_tx, shutdown_rx) = broadcast::channel::<()>(1);

    let cfg = app_config.clone();
    let db_clone = Arc::clone(&db);
    let exec_clone = exec.clone();
    let feed_task = tokio::spawn(async move {
        if let Err(e) = rtds_listener::run_feed(cfg, db_clone, exec_clone, shutdown_rx).await {
            tracing::error!(error = %e, "feed exited with error");
        }
    });

    tokio::signal::ctrl_c().await?;
    tracing::info!("shutdown signal");
    let _ = shutdown_tx.send(());
    let _ = feed_task.await;

    Ok(())
}
