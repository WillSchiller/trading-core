# WebSocket schema notes (copy hot-path)

## RTDS — production feed for **who** traded

- **URL:** `wss://ws-live-data.polymarket.com` (SDK default).
- **Subscribe (wire format):**
  ```json
  {
    "action": "subscribe",
    "subscriptions": [
      {
        "topic": "activity",
        "type": "trades",
        "filters": ""
      }
    ]
  }
  ```
  The crate sets `filters` to an empty string to match this shape; slug/event filters can be added later for optimization.
- **Payload:** `RtdsMessage.payload` is JSON. The TypeScript monitor treats it as either a **single object** or an **array** of trade-like objects.
- **Trader identity:** `proxyWallet` (hex address). This matches [`ActivityMonitor`](../src/polymarket/monitor.ts) in the Node stack.

## CLOB market WebSocket — **no** public counterparty on last trade

- **URL base:** `wss://ws-subscriptions-clob.polymarket.com` → market channel `/ws/market`.
- **Subscribe:** `{ "assets_ids": ["<token_id>", ...], "type": "market", "custom_feature_enabled": true }` (see Polymarket docs / SDK).
- **`polymarket-client-sdk` `WsMessage::LastTradePrice`:** includes `asset_id`, `price`, `side`, `size`, `timestamp` — **does not** include maker/taker wallet. Same for `Book` / `PriceChange`.
- **`WsMessage::Trade`:** user **authenticated** channel (your fills), not a global tape of other traders.

**Conclusion:** copy-trading on **other people’s** fills should use **RTDS `activity`/`trades`**. The CLOB market stream in this crate is optional for book/last-price telemetry or future logic; it does **not** drive the default order path.
