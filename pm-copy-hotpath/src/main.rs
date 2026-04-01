use std::sync::Arc;

use pm_copy_hotpath::{
    config, db, fill_checker, order_builder, positions, resolver, risk, rtds_listener, scorer,
    trade_sync, trader_db,
};
use tokio::sync::{Mutex, broadcast};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let app_config = config::AppConfig::load()?;
    tracing::info!(feed_mode = ?app_config.feed_mode(), "starting pm-copy-hotpath");

    let trader_scores = Arc::new(trader_db::TraderDb::load(&app_config.traders_json_path)?);
    tracing::info!(traders = trader_scores.len(), "trader DB loaded");

    let exec = order_builder::OrderExecutor::connect(&app_config).await?;
    let exec = exec.map(Arc::new);

    // Postgres
    let fill_db = if app_config.database_url.is_empty() {
        tracing::warn!("no database_url — fills will NOT be persisted");
        None
    } else {
        let fdb = db::FillDb::connect(&app_config.database_url)?;
        tracing::info!("postgres connected");
        Some(Arc::new(fdb))
    };

    // Position tracker — load from DB
    let mut position_tracker = positions::PositionTracker::new();
    if let Some(ref fdb) = fill_db {
        match fdb.load_open_positions().await {
            Ok(positions) => position_tracker.load(positions),
            Err(e) => tracing::warn!(error = %e, "failed to load positions from DB"),
        }
    }
    let position_tracker = Arc::new(Mutex::new(position_tracker));

    // Risk manager — seed with existing market counts
    let mut risk_mgr = risk::RiskManager::new(&app_config);
    if let Some(fdb) = &fill_db
        && let Ok(counts) = fdb.get_market_trade_counts().await
    {
        risk_mgr.seed_market_counts(counts);
    }
    let risk_mgr = Arc::new(Mutex::new(risk_mgr));

    // ML scorer
    let mut ml_scorer = scorer::Scorer::new(&app_config);
    ml_scorer.start(&app_config).unwrap_or_else(|e| {
        tracing::warn!(error = e, "scorer init failed — running without ML");
    });
    if ml_scorer.is_enabled()
        && let Some(fdb) = &fill_db
    {
        let addrs: Vec<String> = trader_scores.all_addresses();
        ml_scorer.preload_trader_stats(fdb, &addrs).await;
    }
    let ml_scorer = Arc::new(Mutex::new(ml_scorer));

    let (shutdown_tx, shutdown_rx) = broadcast::channel::<()>(4);

    // Resolver task
    if let Some(ref fdb) = fill_db {
        let resolver_shutdown = shutdown_tx.subscribe();
        let cfg = app_config.clone();
        let pos = Arc::clone(&position_tracker);
        let rsk = Arc::clone(&risk_mgr);
        let database = Arc::clone(fdb);
        let executor = exec.clone();
        tokio::spawn(async move {
            resolver::run_resolver(cfg, pos, rsk, database, executor, resolver_shutdown).await;
        });
        tracing::info!("resolver task started");
    }

    // Fill checker — polls pending GTC orders, updates status
    if let (Some(fdb), Some(executor)) = (&fill_db, &exec) {
        let checker_shutdown = shutdown_tx.subscribe();
        let database = Arc::clone(fdb);
        let ex = Arc::clone(executor);
        let pos = Arc::clone(&position_tracker);
        tokio::spawn(async move {
            fill_checker::run_fill_checker(database, ex, pos, checker_shutdown).await;
        });
        tracing::info!("fill checker task started");
    }

    // Trade sync — polls data API, auto-sells near-certain positions
    if let Some(ref fdb) = fill_db {
        let sync_shutdown = shutdown_tx.subscribe();
        let cfg = app_config.clone();
        let database = Arc::clone(fdb);
        let sync_exec = exec.clone();
        tokio::spawn(async move {
            trade_sync::run_trade_sync(cfg, database, sync_exec, sync_shutdown).await;
        });
        tracing::info!("trade sync task started");
    }

    // RTDS feed task
    let market_cache: rtds_listener::MarketCache = Arc::new(Mutex::new(ahash::AHashMap::new()));
    let feed_ctx = rtds_listener::FeedCtx {
        config: app_config.clone(),
        trader_db: Arc::clone(&trader_scores),
        exec: exec.clone(),
        fill_db: fill_db.clone(),
        positions: Arc::clone(&position_tracker),
        risk: Arc::clone(&risk_mgr),
        scorer: Arc::clone(&ml_scorer),
        market_cache,
    };
    let feed_task = tokio::spawn(async move {
        if let Err(e) = rtds_listener::run_feed(feed_ctx, shutdown_rx).await {
            tracing::error!(error = %e, "feed exited with error");
        }
    });

    tokio::signal::ctrl_c().await?;
    tracing::info!("shutdown signal");
    let _ = shutdown_tx.send(());
    let _ = feed_task.await;

    Ok(())
}
