use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use tokio::sync::{Mutex, broadcast};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, info, warn};

use crate::types::HotPathError;

pub type PriceMap = Arc<Mutex<HashMap<String, f64>>>;
pub type PriceHistory = Arc<Mutex<HashMap<String, Vec<(f64, i64)>>>>;

pub async fn run_ws_feed(
    url: &str,
    prices: PriceMap,
    history: PriceHistory,
    mut shutdown: broadcast::Receiver<()>,
) -> Result<(), HotPathError> {
    loop {
        let mut sub_shutdown = shutdown.resubscribe();
        tokio::select! {
            biased;
            _ = shutdown.recv() => return Ok(()),
            result = connect_and_stream(url, &prices, &history, &mut sub_shutdown) => {
                match result {
                    Ok(()) => return Ok(()),
                    Err(e) => {
                        warn!(error = %e, "WS disconnected, reconnecting in 5s");
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                }
            }
        }
    }
}

async fn connect_and_stream(
    url: &str,
    prices: &PriceMap,
    history: &PriceHistory,
    shutdown: &mut broadcast::Receiver<()>,
) -> Result<(), HotPathError> {
    let (ws, _) = connect_async(url)
        .await
        .map_err(|e| HotPathError::Ws(e.to_string()))?;
    let (mut write, mut read) = ws.split();

    let sub = serde_json::json!({
        "method": "subscribe",
        "subscription": {"type": "allMids"}
    });
    write
        .send(Message::Text(sub.to_string().into()))
        .await
        .map_err(|e| HotPathError::Ws(e.to_string()))?;
    info!("subscribed to allMids");

    let mut ping_interval = tokio::time::interval(Duration::from_secs(30));

    loop {
        tokio::select! {
            biased;
            _ = shutdown.recv() => return Ok(()),
            _ = ping_interval.tick() => {
                let _ = write.send(Message::Text(r#"{"method":"ping"}"#.to_owned().into())).await;
            }
            msg = read.next() => {
                let Some(msg) = msg else { return Err(HotPathError::Ws("stream ended".into())); };
                let msg = msg.map_err(|e| HotPathError::Ws(e.to_string()))?;
                if let Message::Text(text) = msg {
                    if let Err(e) = process_message(&text, prices, history).await {
                        debug!(error = %e, "message parse error");
                    }
                }
            }
        }
    }
}

async fn process_message(
    text: &str,
    prices: &PriceMap,
    history: &PriceHistory,
) -> Result<(), HotPathError> {
    let msg: serde_json::Value = serde_json::from_str(text)?;

    let channel = msg.get("channel").and_then(|c| c.as_str()).unwrap_or("");
    if channel != "allMids" {
        return Ok(());
    }

    let mids = msg
        .get("data")
        .and_then(|d| d.get("mids"))
        .and_then(|m| m.as_object())
        .ok_or_else(|| HotPathError::Ws("no mids in message".into()))?;

    let now = chrono::Utc::now().timestamp_millis();
    let mut price_map = prices.lock().await;
    let mut hist_map = history.lock().await;

    for (asset, val) in mids {
        if let Some(price_str) = val.as_str() {
            if let Ok(price) = price_str.parse::<f64>() {
                price_map.insert(asset.clone(), price);
                let hist = hist_map.entry(asset.clone()).or_default();
                hist.push((price, now));
                // Keep last 24h of history
                if hist.len() > 86400 {
                    hist.drain(..hist.len() - 86400);
                }
            }
        }
    }

    Ok(())
}
