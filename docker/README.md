# Docker Configuration

Production-ready Docker setup for the Dislocation Trader system.

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage production build |
| `docker-compose.prod.yml` | Production compose configuration |
| `.dockerignore` | Build exclusions |

## Dockerfile

### Multi-Stage Build

**Builder Stage**:
- Base: `node:20-slim`
- Installs production dependencies only
- Compiles TypeScript to JavaScript
- Removes dev dependencies

**Production Stage**:
- Base: `node:20-slim`
- Minimal system packages (ca-certificates only)
- Non-root user: `trader` (UID 1001)
- Copies compiled code and dependencies
- Health check on port 8080

### Build

```bash
docker build -t dislocation-trader:latest -f docker/Dockerfile .
```

**Build Context**: Root directory (required for `src/`, `config/`, `sql/`)

**Build Time**: 2-5 minutes (depending on network)

**Image Size**: ~300MB (optimized with multi-stage build)

## docker-compose.prod.yml

### Services

#### app

**Image**: From ECR (`$ECR_REPOSITORY_URL:$IMAGE_TAG`)

**Environment Variables** (required):
- `NODE_ENV=production`
- Database credentials (from `.env.secrets`)
- RPC endpoints (from `.env.secrets`)
- CEX API keys (from `.env.secrets`)
- Executor private key (from `.env.secrets`)
- Telegram bot token (from `.env.secrets`)
- Feature flags (`PAPER_MODE`, `ENABLE_BASE`, etc.)

**Resources**:
- Limits: 2 CPU, 2GB RAM
- Reservations: 0.5 CPU, 512MB RAM

**Restart**: Always (unless stopped manually)

**Health Check**: HTTP endpoint on port 8080, 30s interval

**Logging**: JSON file driver, 10MB max size, 3 files

#### postgres

**Image**: `postgres:16-alpine`

**Configuration**:
- Tuned for performance (see `command` section)
- `shared_buffers=512MB`
- `effective_cache_size=1536MB`
- `work_mem=32MB`
- Max connections: 50

**Volume**: `/data/postgres` (EBS-mounted on EC2)

**Resources**:
- Limits: 1.5 CPU, 2GB RAM
- Reservations: 0.5 CPU, 512MB RAM

**Health Check**: `pg_isready` command, 10s interval

**Port**: Bound to 127.0.0.1:5432 (not public)

#### grafana

**Image**: `grafana/grafana:10.2.3`

**Configuration**:
- Admin credentials from environment
- Provisioned datasources (`../grafana/provisioning`)
- Provisioned dashboards (`../grafana/dashboards`)

**Resources**:
- Limits: 0.5 CPU, 512MB RAM
- Reservations: 0.1 CPU, 128MB RAM

**Port**: 3000 (IP-restricted via Security Group)

**Health Check**: HTTP API health endpoint, 30s interval

### Networking

**Network**: Bridge driver (`app-network`)

All containers on same network, can communicate via service names:
- `postgres` → Postgres container
- `app` → Node.js app container
- `grafana` → Grafana container

### Volumes

**grafana_data**: Persistent volume for Grafana settings/dashboards

**postgres data**: Mounted from host `/data/postgres` (EBS volume)

### Environment Variables

**Required**:
```bash
ECR_REPOSITORY_URL=<your-ecr-url>
IMAGE_TAG=latest
PUBLIC_IP=<ec2-public-ip>

# From Secrets Manager
POSTGRES_PASSWORD=<secret>
RPC_BASE_HTTP=<secret>
RPC_BASE_WS=<secret>
BINANCE_API_KEY=<secret>
BINANCE_API_SECRET=<secret>
COINBASE_API_KEY=<secret>
COINBASE_API_SECRET=<secret>
COINBASE_PASSPHRASE=<secret>
EXECUTOR_PRIVATE_KEY=<secret>
TELEGRAM_BOT_TOKEN=<secret>

# Config
PAPER_MODE=true
ENABLE_BASE=true
ENABLE_MAINNET=false
LOG_LEVEL=info

# Grafana
GRAFANA_ADMIN_PASSWORD=<secure-password>
```

## Usage

### Production Deployment

**On EC2 instance**:

```bash
# Fetch secrets from AWS Secrets Manager
source /home/ubuntu/app/scripts/fetch-secrets.sh export

# Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <ECR_URL>

# Set environment variables
export ECR_REPOSITORY_URL=<your-ecr-url>
export IMAGE_TAG=latest
export PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
export GRAFANA_ADMIN_PASSWORD=$(openssl rand -base64 16)

# Source secrets
source .env.secrets

# Start services
docker-compose -f docker/docker-compose.prod.yml up -d

# Check status
docker-compose -f docker/docker-compose.prod.yml ps

# View logs
docker-compose -f docker/docker-compose.prod.yml logs -f app
```

### Local Development

For local development, use the root `docker-compose.yml` (not the production version):

```bash
docker-compose up -d
npm run dev
```

## Container Management

### Start/Stop

```bash
# Start all services
docker-compose -f docker/docker-compose.prod.yml up -d

# Stop all services
docker-compose -f docker/docker-compose.prod.yml down

# Restart single service
docker-compose -f docker/docker-compose.prod.yml restart app

# View status
docker-compose -f docker/docker-compose.prod.yml ps
```

### Logs

```bash
# View all logs
docker-compose -f docker/docker-compose.prod.yml logs

# Follow app logs
docker-compose -f docker/docker-compose.prod.yml logs -f app

# View last 100 lines
docker-compose -f docker/docker-compose.prod.yml logs --tail 100 app
```

### Exec into Container

```bash
# App container
docker exec -it dislocation-trader-app sh

# Postgres container
docker exec -it dislocation-postgres psql -U trader -d dislocation_trader

# Grafana container
docker exec -it dislocation-grafana sh
```

### Resource Usage

```bash
# Real-time stats
docker stats

# Container disk usage
docker system df
```

## Health Checks

### App Container

**Endpoint**: `http://localhost:8080/health`

**Expected Response**: 200 OK

**Check Interval**: 30s
**Timeout**: 10s
**Retries**: 3
**Start Period**: 60s

### Postgres Container

**Command**: `pg_isready -U trader -d dislocation_trader`

**Check Interval**: 10s
**Timeout**: 5s
**Retries**: 5
**Start Period**: 30s

### Grafana Container

**Endpoint**: `http://localhost:3000/api/health`

**Check Interval**: 30s
**Timeout**: 10s
**Retries**: 3
**Start Period**: 30s

## Troubleshooting

### Container Won't Start

**Check logs**:
```bash
docker logs dislocation-trader-app
```

**Common causes**:
- Missing environment variables
- Database not ready (wait for Postgres health check)
- Invalid secrets
- Port already in use

### High Resource Usage

**Check stats**:
```bash
docker stats
```

**Solutions**:
- Increase resource limits in compose file
- Scale EC2 instance vertically
- Review app logs for loops/leaks

### Database Connection Issues

**Check Postgres health**:
```bash
docker exec dislocation-postgres pg_isready -U trader
```

**Check connection pool**:
```sql
SELECT count(*) FROM pg_stat_activity WHERE datname = 'dislocation_trader';
```

**Solutions**:
- Restart Postgres: `docker-compose restart postgres`
- Check credentials in environment
- Verify volume mount: `df -h | grep postgres`

### Out of Disk Space

**Check usage**:
```bash
df -h
docker system df
```

**Clean up**:
```bash
# Remove old images
docker image prune -a

# Remove stopped containers
docker container prune

# Remove unused volumes
docker volume prune
```

## Security

### Non-Root User

App container runs as user `trader` (UID 1001), not root.

**Verify**:
```bash
docker exec dislocation-trader-app whoami
# Expected: trader
```

### Secrets Management

**Never**:
- Hardcode secrets in compose file
- Commit secrets to git
- Log secrets in application

**Always**:
- Fetch from Secrets Manager at runtime
- Use `.env.secrets` file (gitignored)
- Mask secrets in logs

### Network Isolation

Containers communicate via internal bridge network.

**External access**:
- Grafana: Port 3000 (IP-restricted via Security Group)
- Postgres: Bound to 127.0.0.1 (not public)
- App: No public ports (internal only)

## Resource Limits

### Why Resource Limits?

- Prevent OOM killer from stopping containers
- Ensure fair resource sharing
- Protect host system from runaway processes
- Enable accurate capacity planning

### Tuning

**If app needs more resources**:
```yaml
deploy:
  resources:
    limits:
      cpus: '3'
      memory: 4G
```

**If Postgres needs more resources**:
```yaml
deploy:
  resources:
    limits:
      cpus: '2'
      memory: 4G
```

**Monitor actual usage**:
```bash
docker stats --no-stream
```

## Logging

### Log Drivers

**Current**: JSON file driver
- Max size: 10MB per file
- Max files: 3
- Total per container: 30MB

### Log Rotation

Automatic via Docker (when file exceeds 10MB).

### Log Aggregation

Logs streamed to CloudWatch via CloudWatch agent on EC2 host.

**View in CloudWatch**:
- Log group: `/aws/ec2/dislocation-trader-production`
- Streams: `{instance-id}/docker`

### Change Log Level

```bash
# Set in environment
export LOG_LEVEL=debug

# Restart app
docker-compose -f docker/docker-compose.prod.yml restart app
```

## Maintenance

### Update Docker Images

```bash
# Pull latest images
docker-compose -f docker/docker-compose.prod.yml pull

# Restart with new images
docker-compose -f docker/docker-compose.prod.yml up -d
```

### Database Migrations

```bash
docker exec dislocation-trader-app npm run db:migrate
```

### Database Vacuum

```bash
docker exec -it dislocation-postgres psql -U trader -d dislocation_trader -c "VACUUM ANALYZE;"
```

### Prune Old Data

```bash
docker exec -it dislocation-postgres psql -U trader -d dislocation_trader -c "DELETE FROM quotes_raw WHERE ts < now() - interval '7 days';"
```

## References

- [Dockerfile Best Practices](https://docs.docker.com/develop/develop-images/dockerfile_best-practices/)
- [Docker Compose Docs](https://docs.docker.com/compose/)
- [Production Deployment Guide](../docs/DEPLOYMENT.md)
- [Operational Runbook](../docs/runbook.md)
