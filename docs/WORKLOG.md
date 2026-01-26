# WORKLOG

Coordination log for multi-agent development.

---

## 2026-01-19

### Data Collector Agent

✅ **DONE** — Completed Phase 1: Data Collection (Tasks T1.1-T1.9)

Implemented core data collection infrastructure:

**T1.1 - CexConnector base class** (`src/collectors/cex/base.ts`)
- Abstract WebSocket connector with exponential backoff reconnection (1s → 60s max)
- Heartbeat/ping-pong handling with configurable intervals
- Staleness detection and connection state tracking
- Event-driven architecture (connected, disconnected, quote, error events)

**T1.2 - BinanceConnector** (`src/collectors/cex/binance.ts`)
- bookTicker stream for bid/ask quotes
- Symbol normalization (ETHUSDC → WETH/USDC)
- Zod validation for incoming data

**T1.3 - CoinbaseConnector** (`src/collectors/cex/coinbase.ts`)
- ticker channel subscription with level1 data
- Handles subscription confirmations and heartbeat messages
- Symbol mapping (ETH-USDC → WETH/USDC)

**T1.4 - BybitConnector** (`src/collectors/cex/bybit.ts`)
- ticker stream (tickers.SYMBOL)
- Custom ping/pong protocol (JSON-based, not WebSocket native)
- Filters out zero bids/asks

**T1.5 - QuoteCache** (`src/state/quote-cache.ts`)
- In-memory cache with per-(venue, pair, chain) keys
- CEX staleness: age > 3000ms
- DEX staleness: blockLag > 2 blocks
- Stats tracking and query methods (by venue, by pair, fresh only)

**T1.6 - ChainProvider** (`src/chain/provider.ts`)
- viem-based provider wrapper for Base and Mainnet
- HTTP + WebSocket public clients
- Optional wallet client from private key
- Helper methods for block number, balance, gas estimation

**T1.7 - UniswapV3Connector** (`src/collectors/dex/uniswap-v3.ts`)
- Polls slot0() on every new block via BlockWatcher
- sqrtPriceX96 → human-readable price conversion
- Token decimal adjustment
- Static pool initialization helper (fetches token metadata)

**T1.8 - QuotePersistence** (`src/persistence/quotes.ts`)
- Raw quote sampling (configurable rate, default 1/10)
- Rollup generation (1s, 10s, 1m intervals)
- OHLC aggregation with upserts

**T1.9 - HealthPersistence** (`src/persistence/health.ts`)
- Upserts to connector_health table
- Tracks ws_connected, reconnect_count, error_count, last_quote_at, last_block
- Query methods for individual and all connector health

**Additional utilities:**
- `src/utils/math.ts` - sqrtPriceX96 conversion, spread calculation (bps)
- `src/utils/normalization.ts` - symbol/pair canonicalization
- `src/chain/block-watcher.ts` - Block polling with event emission

🔄 **HANDOFF** - Ready for Phase 2 (opportunity-detector agent)
- QuoteCache provides `getFreshQuotesByPair()` for detection module
- All CEX/DEX quotes are normalized to common format
- Persistence layer ready for opportunity logging

---

## 2026-01-19 (continued)

### System Integration & Testing

**COMPLETED**: Wired up all components in main application entry point (`src/index.ts`)
- Integrated CollectorOrchestrator with config loading
- Integrated OpportunityDetector with quote cache
- Added graceful shutdown handlers
- Configured CEX connector pairs from pairs.json
- Configured DEX connector pools from pairs.json

**COMPLETED**: Environment and dependency setup
- Added `dotenv` package for .env file loading
- Created `.env` file with database credentials and Base RPC endpoints
- Fixed schema defaults for postgres password

**CURRENT STATUS**: Application successfully starts and all systems initialize:

✅ **Working Components:**
- Database pool connects successfully
- All 3 CEX connectors (Binance, Coinbase, Bybit) connect to WebSocket feeds
- CEX connectors subscribe to configured pairs (WETH/USDC, cbETH/WETH)
- Base chain provider initialized
- Block watcher polling Base chain every 2 seconds
- Opportunity detector running with 100ms tick interval
- Quote rollup timers started (1s, 10s, 1m)

⚠️ **Known Issues:**

1. **Health persistence SQL error** (non-critical)
   - Error: "there is no unique or exclusion constraint matching the ON CONFLICT specification"
   - Root cause: ON CONFLICT DO UPDATE SET clause syntax needs fixing
   - Impact: Connector health table not updating properly, but doesn't block core functionality
   - Location: `src/persistence/health.ts` line 60-66

2. **Uniswap V3 slot0 fetching fails** (RPC endpoint issue)
   - Error: "invalid opcode" and "stack underflow" when calling slot0() and liquidity()
   - Root cause: Public Base RPC endpoint may not support full contract calls or pools don't exist
   - Impact: No DEX quotes being collected
   - Location: `src/collectors/dex/uniswap-v3.ts`
   - Solution: Need paid RPC provider (Alchemy/QuickNode) for reliable contract calls

3. **No quotes persisting to database yet**
   - Likely because CEX quotes need time to accumulate and sampling rate is 1/10
   - Need to verify quote events are actually being emitted

**NEXT STEPS:**

1. Fix health persistence SQL syntax (use EXCLUDED keyword)
2. Verify CEX quote flow is working (check logs for quote events)
3. Get proper Base RPC endpoint for DEX data collection
4. Verify quote persistence and rollup generation
5. Test opportunity detection once quotes are flowing

---

## 2026-01-20

### Opportunity Detector Agent

✅ **DONE** — Completed Phase 2: Detection Layer (Tasks T2.1-T2.5)

**T2.1 - SpreadCalculator** (`src/detection/spread-calculator.ts`)
- Pure function spread calculation using Decimal.js for precision
- Formula: `spreadBps = ((dexMid - anchorMid) / anchorMid) * 10000`
- Direction determination: negative = buy_dex, positive = sell_dex
- Confidence assessment based on anchor divergence (high/medium/low)

**T2.2 - Filters** (`src/detection/filters.ts`)
- Threshold filter: checks if spread exceeds minSpreadBps
- Duration filter: tracks persistent gaps with Map-based state
- Depth filter: validates pool liquidity in USD terms
- Staleness filter: ensures all quotes (CEX/DEX) are fresh
- Volatility filter: optionally widens thresholds in high-vol regimes
- Anchor confidence filter: rejects when CEX anchors diverge significantly

**T2.3 - OpportunityDetector** (`src/detection/index.ts`)
- Main detection loop running at 100ms intervals (<50ms target per cycle)
- Iterates through all enabled (pair, chain) combinations
- Retrieves quotes from QuoteCache and applies all filters
- Logs detailed reason codes for every detection cycle

**T2.4 - Opportunity Persistence** (`src/persistence/opportunities.ts`)
- PostgreSQL repository for opportunity lifecycle
- Functions: insertOpportunity, getOpportunityById, updateOpportunityStatus, getRecentOpportunities
- Proper type conversions for BigInt block numbers and Postgres NUMERIC fields

**T2.5 - OpportunityEmitter** (`src/detection/emitter.ts`)
- Event-driven notification system extending Node.js EventEmitter
- Emits `opportunity:detected` and `opportunity:expired` events
- Typed handler registration

**Tests:**
- 39 unit tests passing (spread calculator + filters)
- 2 integration tests with PostgreSQL testcontainer

**Config updates:**
- Increased `minSpreadBps` from 5 to 25 for WETH/USDC (reduce noise)
- Increased `minDurationMs` to 3000ms for all pairs

---

### Timestamp & Clock Hardening

✅ **DONE** — Implemented timestamp synchronization policy

**NTP Status Logging** (`src/utils/clock.ts`)
- Detects chrony, systemd-timesyncd, or ntpd at startup
- Reports sync status, service, and time offset
- Validates timestamp sanity (future/ancient/negative latency)

**Exchange Timestamps in CEX Connectors**
- Binance: parses `E` field (event time) from bookTicker
- Coinbase: parses `time` field from ticker messages
- Bybit: parses `ts` field from orderbook messages
- All calculate `latencyMs = receivedTsMs - exchangeTsMs`

**Timestamp Validation** (`src/state/quote-cache.ts`)
- Rejects future timestamps (>500ms ahead)
- Rejects ancient timestamps (>30s old)
- Rejects negative latency beyond tolerance
- Invalid quotes automatically marked as stale

**Block Timestamp Caching** (`src/chain/block-watcher.ts`)
- Caches `blockNumber → timestamp` for last 100 blocks per chain
- DEX quotes use `blockTsMs` from cached data
- Exposes `getBlockTimestamp()` API

**Time Alignment Filter** (`src/detection/filters.ts`)
- New `timeAlignmentFilter()` ensures CEX/DEX temporal alignment
- Configurable per-chain: Base 1500ms, Mainnet 3000ms
- Skips opportunities with reason `time_skew`

**Drift Monitoring** (`src/persistence/health.ts`)
- Tracks `last_latency_ms` and `p95_latency_ms` per venue
- Counts `invalid_ts_count` and `future_ts_count`

**Database Migration:** `sql/003_add_timestamp_columns.sql`

**Config additions:**
```json
{
  "system": {
    "maxFutureTsMs": 500,
    "maxPastTsMs": 30000,
    "dexBlockLagThreshold": 2
  },
  "detection": {
    "maxTimeSkewMsBase": 1500,
    "maxTimeSkewMsMainnet": 3000
  }
}
```

🔄 **HANDOFF** - Ready for Phase 3 (trade-executor agent)
- Detection layer emits opportunities via OpportunityEmitter
- Opportunities persisted to database with full metadata
- Timestamp alignment ensures valid spread calculations

---

## 2026-01-20 (evening)

### DevOps/Platform Agent

✅ **DONE** — Phase 5: Deployment & Infrastructure (Tasks T5.1-T5.7)

Completed full AWS deployment infrastructure for the Dislocation Trader system.

**T5.1 - Terraform Infrastructure Configuration** (`infra/`)
- `main.tf`: Provider and S3 backend configuration
- `variables.tf`: 13 input variables (region, instance type, IPs, etc.)
- `network.tf`: VPC, subnet, internet gateway, route table
- `security-group.tf`: Hardened security rules (SSH + Grafana IP-restricted, HTTPS/DNS/NTP outbound)
- `ec2.tf`: t3.medium instance with IAM role (Secrets Manager, CloudWatch, ECR access), EBS volume, Elastic IP
- `secrets.tf`: 10 Secrets Manager secrets (DB, RPC, CEX keys, executor key, Telegram)
- `cloudwatch.tf`: Log group, 4 alarms (CPU, memory, disk, status check), SNS topic
- `ecr.tf`: Docker registry with lifecycle policy (keep 10 images)
- `outputs.tf`: Instance IP, Grafana URL, ECR URL, SSH command
- `user-data.sh`: EC2 bootstrap script (Docker, CloudWatch agent, fail2ban, EBS mount, chrony)

**T5.2 - Production Docker Compose** (`docker/docker-compose.prod.yml`)
- App container: Resource limits (2 CPU, 2GB RAM), health checks, restart always
- Postgres container: Tuned config (shared_buffers, work_mem, etc.), EBS-mounted volume
- Grafana container: IP-based access, provisioned datasources
- Log rotation: 10MB max size, 3 files per container
- Network isolation with bridge network

**T5.3 - Multi-stage Dockerfile** (`docker/Dockerfile`)
- Builder stage: npm ci, TypeScript compilation
- Production stage: node:20-slim base, non-root user (trader:1001)
- Security: CA certificates only, minimal layers
- Health check endpoint on port 8080

**T5.4 - AWS Secrets Manager Integration** (`scripts/fetch-secrets.sh`)
- Fetches all secrets from Secrets Manager at runtime
- Exports to `.env.secrets` file
- Masks sensitive values in logs
- Used by deployment workflow and manual starts

**T5.5 - CI/CD Pipeline** (`.github/workflows/`)
- `ci.yml`: Lint, typecheck, unit tests, integration tests (with Postgres service), Docker build
- `deploy.yml`: Build image → push to ECR → SSH to EC2 → pull → restart → migrate → health check
- Manual trigger support for staging/production environments
- Deployment notifications on success/failure

**T5.6 - Operational Runbook** (`docs/runbook.md`)
- Comprehensive 400+ line runbook covering:
  - System architecture diagram
  - SSH and Grafana access procedures
  - Start/stop/restart procedures
  - Deployment (manual and automated)
  - Monitoring and alerts
  - Log access and debugging
  - Database operations (backup, restore, vacuum)
  - Secret rotation procedures
  - Backup and recovery (EBS snapshots, disaster recovery)
  - Scaling (vertical and horizontal)
  - Incident response playbooks
  - Common issues and resolutions

**T5.7 - Deployment Guide** (`docs/DEPLOYMENT.md`)
- Step-by-step deployment instructions
- Prerequisites (tools, AWS setup, RPC provider, CEX keys, wallet)
- Infrastructure provisioning (Terraform init/plan/apply)
- Secrets configuration (populate-secrets.sh script)
- Application deployment (Docker build/push, compose up)
- Verification procedures (health checks, logs, Grafana)
- CI/CD setup (GitHub secrets)
- Troubleshooting section
- Security checklist

**Additional Files:**
- `infra/README.md`: Infrastructure documentation
- `scripts/populate-secrets.sh`: Interactive secret population tool
- `infra/terraform.tfvars.example`: Example variable values
- Updated `.gitignore`: Excludes Terraform state, secrets, keys

**Security Hardening:**
- Security Groups: Least privilege (SSH + Grafana IP-restricted only)
- IAM: Scoped permissions (Secrets Manager read, CloudWatch write, ECR pull)
- Secrets: Never in code/git, fetched at runtime from Secrets Manager
- EC2: fail2ban, unattended-upgrades, IMDSv2 required
- Encryption: EBS, ECR, and Secrets Manager all encrypted at rest
- Non-root containers: App runs as user `trader` (UID 1001)

**Monitoring & Alerting:**
- 4 CloudWatch alarms (CPU, memory, disk, status checks)
- SNS email notifications
- CloudWatch Logs integration
- Grafana dashboards for real-time visibility

**Deployment Automation:**
- One-command infrastructure provisioning
- Automated Docker build/push/deploy pipeline
- Zero-downtime deployments (pull new image → restart)
- Rollback support (deploy previous commit SHA)

**RTO/RPO:**
- RTO: 30 minutes (full system rebuild from Terraform + EBS snapshot)
- RPO: 24 hours (daily EBS snapshots)

🔄 **HANDOFF** - Infrastructure ready for deployment
- All Terraform files validated and documented
- CI/CD pipeline ready to use (requires GitHub secrets setup)
- Operational runbook covers all standard procedures
- Team can deploy to AWS following DEPLOYMENT.md

---

## 2026-01-20 (late)

### Region Configuration Update

✅ **DONE** — Updated AWS region to Singapore (ap-southeast-1) for latency

**Changes:**
- `infra/variables.tf`: Default region changed to `ap-southeast-1`
- `infra/main.tf`: Backend region now configurable via `-backend-config` or `AWS_DEFAULT_REGION`
- `infra/terraform.tfvars.example`: Updated to show Singapore as default
- `infra/README.md`: Updated documentation for region configuration

**How to set region:**
1. Environment variable: `export TF_VAR_aws_region=ap-southeast-1`
2. terraform.tfvars: `aws_region = "ap-southeast-1"`
3. Command line: `terraform apply -var="aws_region=ap-southeast-1"`

**Backend region (for S3 state):**
```bash
export AWS_DEFAULT_REGION=ap-southeast-1
terraform init -backend-config="region=$AWS_DEFAULT_REGION"
```

---

## 2026-01-26

### DevOps/Platform Agent

**IN_PROGRESS** - Dashboard Deployment Pipeline

Adding dedicated Grafana dashboard sync workflow for faster dashboard iterations.

**Problem:**
- Dashboard changes in `grafana/dashboards/*.json` require full deployment via `deploy.yml`
- Full deployment rebuilds Docker image, pushes to ECR, restarts all services
- User wants faster iteration on dashboard changes

**Solution:**
Created lightweight dashboard sync workflow and script:

**Files Created:**
- `.github/workflows/sync-dashboards.yml` - GitHub Actions workflow for dashboard sync
- `scripts/sync-dashboards.sh` - Local script for manual dashboard sync

**Workflow Features:**
- Triggers automatically on push to `main` when `grafana/**` files change
- Can be triggered manually via workflow_dispatch
- Syncs dashboards to S3, then to EC2 via SSM
- Restarts Grafana container to reload dashboards
- Includes health check verification
- Provides summary with Grafana URL

**Usage:**
1. **Automatic:** Push dashboard changes to `main` branch
2. **Manual (GitHub):** Go to Actions > "Sync Grafana Dashboards" > Run workflow
3. **Manual (Local):** Run `./scripts/sync-dashboards.sh`

---

## 2026-01-26 (evening)

### Data Collector Agent

**DONE** - Fixed missing block timestamps in DEX quotes (Medium Priority Audit Issue)

**Problem:**
- DEX quotes (from UniswapV3Connector) were using `ts: new Date()` which captured system time, not actual block timestamp
- This caused time alignment issues with CEX quotes which use exchange timestamps
- The `blockTsMs` field in NormalizedQuote interface was not being populated

**Solution:**
Updated `/Users/will/dev/blockhelix/src/collectors/dex/uniswap-v3.ts` to properly propagate block timestamps:

1. Modified `handleNewBlockEventDriven()` to accept full `blockInfo` object instead of just `blockNumber`
2. Modified `handleNewBlockPolling()` to accept full `blockInfo` object
3. Updated `fetchAllPoolsMulticall()` to accept `blockInfo` and set:
   - `ts: new Date(blockInfo.timestamp)` - uses actual block timestamp
   - `blockTsMs: blockInfo.timestamp` - populates the field for time alignment checks
4. Updated `fetchPoolQuote()` with same changes
5. Updated initial fetch to retrieve block timestamp via `blockWatcher.fetchBlockWithTimestamp()`

**Files Changed:**
- `/Users/will/dev/blockhelix/src/collectors/dex/uniswap-v3.ts` - 6 method signatures and implementations updated
- `/Users/will/dev/blockhelix/src/detection/index.ts` - Fixed unused import warning

**Verification:**
- All unit tests pass (67 tests)
- TypeScript compilation succeeds with no errors
- Build completes successfully

**Impact:**
- DEX quotes now have accurate block timestamps for proper time alignment with CEX quotes
- Time alignment filter in detection layer can now correctly validate temporal synchronization
- Improved audit trail for quote timing analysis

---
