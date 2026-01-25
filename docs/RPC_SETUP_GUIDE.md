# RPC Multi-Provider Setup Guide

## Quick Start

### 1. Get API Keys

#### dRPC (Primary Provider - Recommended)
1. Visit https://drpc.org
2. Sign up for free account
3. Create a new project
4. Copy your API key (shows as `dkey` parameter)
5. Free tier: **210M compute units/month**

#### Alchemy (Fallback Provider)
1. Visit https://www.alchemy.com
2. Sign up for free account
3. Create app for Base and/or Ethereum
4. Copy API keys
5. Free tier: **30M compute units/month**

### 2. Configure Environment Variables

Update your `.env` file:

```bash
# Primary: dRPC (210M CU/month free)
RPC_DRPC_BASE_HTTP=https://lb.drpc.org/ogrpc?network=base&dkey=YOUR_DRPC_KEY_HERE
RPC_DRPC_BASE_WS=wss://lb.drpc.org/ogws?network=base&dkey=YOUR_DRPC_KEY_HERE

# Fallback: Alchemy (30M CU/month free)
RPC_ALCHEMY_BASE_HTTP=https://base-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY_HERE
RPC_ALCHEMY_BASE_WS=wss://base-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY_HERE

# If trading on Ethereum mainnet, add:
# RPC_DRPC_MAINNET_HTTP=https://lb.drpc.org/ogrpc?network=ethereum&dkey=YOUR_DRPC_KEY_HERE
# RPC_DRPC_MAINNET_WS=wss://lb.drpc.org/ogws?network=ethereum&dkey=YOUR_DRPC_KEY_HERE
# RPC_ALCHEMY_MAINNET_HTTP=https://eth-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY_HERE
# RPC_ALCHEMY_MAINNET_WS=wss://eth-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY_HERE
```

**Important:** Replace `YOUR_DRPC_KEY_HERE` and `YOUR_ALCHEMY_KEY_HERE` with your actual API keys.

### 3. Verify Configuration

Start the application:

```bash
npm run dev
```

Look for these log messages:

```
✓ RPC endpoints configured { chain: 'base', endpointCount: 2 }
✓ Endpoint initialized { endpoint: 'drpc', priority: 1 }
✓ Endpoint initialized { endpoint: 'alchemy', priority: 2 }
✓ WebSocket client initialized { endpoint: 'drpc' }
✓ Chain provider initialized { endpointCount: 2 }
✓ WebSocket block subscription active
```

## Provider Priority

The system automatically uses providers in this order:

1. **dRPC** (priority 1) - Primary, used for all calls when healthy
2. **Alchemy** (priority 2) - Fallback, used when dRPC is rate-limited or unhealthy

## Automatic Failover

The system automatically handles:

### Rate Limits
- Detects 429 (rate limit) errors
- Switches to fallback provider immediately
- Cooldown period: 60 seconds
- Automatically restores primary after cooldown

### Connection Failures
- Tracks consecutive failures per provider
- Switches after 3 consecutive failures
- Auto-recovers after 60 seconds without failures

### WebSocket Disconnects
- Falls back to HTTP polling if WebSocket fails
- Continues operation without interruption
- Logs warning with fallback notice

## Monitoring Provider Health

### View Status Programmatically

```typescript
const healthStatus = chainProvider.getHealthStatus();
console.log(healthStatus);
```

Output:
```json
{
  "drpc": {
    "isHealthy": true,
    "consecutiveFailures": 0,
    "totalCalls": 15234,
    "totalFailures": 2,
    "failureRate": 0.00013,
    "rateLimitedUntil": null
  },
  "alchemy": {
    "isHealthy": true,
    "consecutiveFailures": 0,
    "totalCalls": 45,
    "totalFailures": 0,
    "failureRate": 0,
    "rateLimitedUntil": null
  }
}
```

### Monitor in Logs

Enable debug logging:

```bash
LOG_LEVEL=debug npm run dev
```

Look for:
- `"Using cached gas price"` - Gas cache hits
- `"WebSocket block subscription active"` - WS working correctly
- `"Rate limit detected"` - Provider rate limited (normal)
- `"Endpoint marked unhealthy"` - Failover triggered
- `"Endpoint recovered"` - Provider restored

## Usage Monitoring

### Check dRPC Usage

1. Login to https://drpc.org
2. View dashboard
3. Check "Compute Units Used" chart
4. Free tier: 210M CU/month

### Check Alchemy Usage

1. Login to https://www.alchemy.com
2. Select your app
3. View "Compute Units" chart
4. Free tier: 30M CU/month

### Expected Usage

With Base trading only:
- **dRPC:** ~9-11M CU/month (4-5% of free tier)
- **Alchemy:** ~0.5-2M CU/month (2-7% of free tier, mostly failover)

With Base + Ethereum mainnet:
- **dRPC:** ~15-20M CU/month (7-10% of free tier)
- **Alchemy:** ~1-3M CU/month (3-10% of free tier)

## Troubleshooting

### "No RPC endpoints configured for chain: base"

**Cause:** No RPC provider configured in .env

**Fix:** Add at least one provider (dRPC or Alchemy) for Base

```bash
RPC_DRPC_BASE_HTTP=https://lb.drpc.org/ogrpc?network=base&dkey=YOUR_KEY
```

### "Rate limit detected" (frequent)

**Cause:** Hitting free tier limits

**Options:**
1. **Normal behavior** - System will auto-failover, wait 60s
2. **Upgrade tier** - Get paid plan for higher limits
3. **Add 3rd provider** - Add QuickNode, Infura, or another provider

### "WebSocket subscription error"

**Cause:** WebSocket connection failed

**Impact:** Minimal - automatically falls back to HTTP polling

**Fix (optional):**
1. Check firewall allows WSS connections
2. Verify WebSocket URL is correct
3. Test WebSocket manually: `wscat -c wss://your-endpoint`

### High failure rate on provider

**Causes:**
- Invalid API key
- Network/firewall blocking requests
- Provider outage

**Fix:**
1. Verify API key is correct and active
2. Check provider status page
3. Test endpoint manually: `curl https://your-endpoint`
4. Check firewall/VPN settings

### Application keeps using fallback provider

**Cause:** Primary provider unhealthy

**Check:**
1. View health status (see above)
2. Check `rateLimitedUntil` value
3. Review logs for error messages

**Fix:**
1. Wait for automatic recovery (60s)
2. Restart application if persistent
3. Check API key quota on provider dashboard

## Advanced Configuration

### Add Third Provider (Optional)

Example with QuickNode:

```bash
# Get API key from https://www.quicknode.com
RPC_QUICKNODE_BASE_HTTP=https://your-endpoint.quiknode.pro/YOUR_KEY/
RPC_QUICKNODE_BASE_WS=wss://your-endpoint.quiknode.pro/YOUR_KEY/
```

Then update `src/chain/rpc-config-builder.ts` to include QuickNode endpoint.

### Adjust Cache TTL

In `src/execution/gas.ts` constructor:

```typescript
this.config = {
  ...config,
  gasCacheTtlMs: config.gasCacheTtlMs ?? 15000, // Default 15s instead of 10s
};
```

### Disable WebSocket (Use HTTP Only)

In `src/collectors/orchestrator.ts`:

```typescript
const blockWatcher = new BlockWatcher(
  {
    chain: chain as Chain,
    useWebSocket: false  // Force HTTP polling
  },
  provider
);
```

### Adjust Failover Threshold

In `src/chain/rpc-config-builder.ts`:

```typescript
{
  name: 'drpc',
  httpUrl: chainRpcConfig.drpc.http,
  wsUrl: chainRpcConfig.drpc.ws,
  priority: 1,
  maxRetriesBeforeFallback: 5  // Default is 3
}
```

## Cost Optimization Tips

### Reduce RPC Calls
1. **Enable WebSocket** - Eliminates block polling (saves ~20% of calls)
2. **Cache gas prices** - Already enabled, 10s TTL (saves ~50-75% of gas calls)
3. **Reduce opportunity detection frequency** - Lower `tickIntervalMs` in config

### Maximize Free Tier
1. **Use dRPC as primary** - 7x larger free tier than Alchemy
2. **Enable both providers** - Automatic load balancing and failover
3. **Monitor usage weekly** - Check dashboards to avoid surprises

### When to Upgrade

Consider paid tier if:
- Using >150M CU/month on dRPC (>70% of free tier)
- Frequent rate limiting (multiple times per hour)
- Trading on 3+ chains simultaneously
- Running multiple instances of the bot

## Provider Comparison

| Provider | Free Tier | Paid Starting | WebSocket | Chains | Notes |
|----------|-----------|---------------|-----------|--------|-------|
| **dRPC** | 210M CU/mo | $19/mo | Yes | All major | Best free tier |
| **Alchemy** | 30M CU/mo | $49/mo | Yes | ETH, Base, etc | Industry standard |
| **QuickNode** | 50M CU/mo | $29/mo | Yes | All major | Good alternative |
| **Infura** | 25M CU/mo | $50/mo | Yes | ETH, L2s | Reliable |

**Recommendation:** Use dRPC + Alchemy for best free tier coverage (240M CU/month total).

## Support

### dRPC Support
- Docs: https://docs.drpc.org
- Discord: https://discord.gg/drpc
- Status: https://status.drpc.org

### Alchemy Support
- Docs: https://docs.alchemy.com
- Discord: https://discord.gg/alchemy
- Status: https://status.alchemy.com

### Project Issues
- GitHub: Open an issue with logs and health status
- Include: Chain, provider names, error messages, health status JSON
