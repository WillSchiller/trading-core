# Operational Runbook

**Version**: 1.0
**Last Updated**: 2026-01-20
**Owner**: DevOps Team

## Table of Contents

1. [Overview](#overview)
2. [System Architecture](#system-architecture)
3. [Access and Authentication](#access-and-authentication)
4. [Start/Stop Procedures](#startstop-procedures)
5. [Deployment](#deployment)
6. [Monitoring and Alerts](#monitoring-and-alerts)
7. [Log Access and Debugging](#log-access-and-debugging)
8. [Database Operations](#database-operations)
9. [Secret Rotation](#secret-rotation)
10. [Backup and Recovery](#backup-and-recovery)
11. [Scaling](#scaling)
12. [Incident Response](#incident-response)
13. [Common Issues](#common-issues)

---

## Overview

The Dislocation Trader system detects and exploits price dislocations between centralized exchanges (CEX) and decentralized exchanges (DEX). It runs on a single EC2 instance with docker-compose orchestrating three containers: Node.js app, PostgreSQL, and Grafana.

**Key Components:**
- EC2 instance (t3.medium): us-east-1
- EBS volume: 50GB gp3 for Postgres data
- ECR: Docker image registry
- Secrets Manager: All credentials
- CloudWatch: Logs and metrics
- SNS: Alert notifications

**RTO (Recovery Time Objective)**: 30 minutes
**RPO (Recovery Point Objective)**: 24 hours (daily EBS snapshots)

---

## System Architecture

```
┌─────────────────────────────────────────────────┐
│              EC2 Instance (t3.medium)           │
│                                                 │
│  ┌──────────────┐  ┌────────────┐  ┌─────────┐│
│  │  Node.js App │  │ PostgreSQL │  │ Grafana ││
│  │  (Port 8080) │  │ (Port 5432)│  │(Port 3k)││
│  └──────────────┘  └────────────┘  └─────────┘│
│         │                 │                     │
│         └─────────────────┘                     │
│                   │                             │
│  ┌────────────────┴─────────────────────────┐  │
│  │         EBS Volume (/data/postgres)      │  │
│  └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
          │                        │
    ┌─────┴────────┐       ┌──────┴────────┐
    │ CEX WebSocket│       │ Base RPC      │
    │ Feeds        │       │ Provider      │
    └──────────────┘       └───────────────┘
```

---

## Access and Authentication

### SSH Access

```bash
ssh -i ~/.ssh/dislocation-trader.pem ubuntu@<EC2_PUBLIC_IP>
```

**Security:**
- SSH restricted to team IPs only (defined in Terraform variables)
- Key-based authentication only (no password)
- fail2ban active (5 attempts → 1 hour ban)

### Grafana Access

**URL**: `http://<EC2_PUBLIC_IP>:3000`

**Default Credentials:**
- Username: `admin`
- Password: Stored in `GRAFANA_ADMIN_PASSWORD` (Secrets Manager or .env)

**Security:**
- Access restricted to team IPs only
- Change default password on first login

### AWS Console Access

Use AWS IAM credentials with appropriate permissions:
- EC2 read/write
- EBS snapshot management
- Secrets Manager read
- CloudWatch read
- ECR read/write

---

## Start/Stop Procedures

### Start All Services

```bash
cd /home/ubuntu/app

source scripts/fetch-secrets.sh export

docker-compose -f docker/docker-compose.prod.yml up -d

docker-compose -f docker/docker-compose.prod.yml ps
```

**Startup Order:**
1. PostgreSQL (waits for health check)
2. App (depends on Postgres)
3. Grafana (depends on Postgres)

**Expected Startup Time:** 60-90 seconds

### Stop All Services

```bash
cd /home/ubuntu/app

docker-compose -f docker/docker-compose.prod.yml down
```

**Graceful Shutdown:**
- Node.js app receives SIGTERM and drains connections (30s timeout)
- Postgres flushes WAL and completes checkpoints
- Grafana saves in-memory state

### Restart Single Service

```bash
docker-compose -f docker/docker-compose.prod.yml restart app

docker logs -f dislocation-trader-app
```

### Stop System Completely (Maintenance)

```bash
docker-compose -f docker/docker-compose.prod.yml down

aws ec2 stop-instances --instance-ids <INSTANCE_ID> --region us-east-1
```

**Before stopping EC2:**
- Notify team in Slack/Telegram
- Ensure no active trades (check Grafana "Executions" dashboard)
- Take EBS snapshot if making risky changes

---

## Deployment

### Manual Deployment

```bash
ssh ubuntu@<EC2_PUBLIC_IP>

cd /home/ubuntu/app

source scripts/fetch-secrets.sh export

aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <ECR_REGISTRY>

export ECR_REPOSITORY_URL=<ECR_REGISTRY>/dislocation-trader-production
export IMAGE_TAG=latest

docker-compose -f docker/docker-compose.prod.yml pull

docker-compose -f docker/docker-compose.prod.yml up -d

docker exec dislocation-trader-app npm run db:migrate

docker logs -f dislocation-trader-app
```

### Automated Deployment (GitHub Actions)

**Trigger:**
- Push to `main` branch (automatic)
- Manual dispatch via GitHub Actions UI

**Steps:**
1. Build Docker image
2. Push to ECR
3. SSH to EC2
4. Pull new image
5. Restart containers
6. Run migrations
7. Health check

**Rollback Procedure:**

```bash
export IMAGE_TAG=<PREVIOUS_COMMIT_SHA>

docker-compose -f docker/docker-compose.prod.yml up -d

docker-compose -f docker/docker-compose.prod.yml ps
```

### Configuration Management

**Important:** Configuration files (`config/default.json`, `config/pairs.json`) are baked into the Docker image at build time. They are NOT volume-mounted from the host.

**Why?**
- Ensures config and code are always in sync
- Prevents crash-loops from config/code version mismatch
- Config changes require a new deployment (intentional - provides audit trail)

**To update configuration:**
1. Edit config files in the git repository
2. Commit and push to `main`
3. CI/CD will build a new image with the updated config
4. New container starts with matching code + config

**What IS volume-mounted:**
- `sql/` - Database migrations (for flexibility)
- `grafana/` - Dashboard definitions (for quick iteration)

**Emergency config change (not recommended):**
If you must change config without a full deployment:
```bash
# SSH to instance
ssh ubuntu@<EC2_PUBLIC_IP>

# Edit config inside running container (temporary - lost on restart)
docker exec -it dislocation-trader-app sh -c "cat /app/config/default.json"

# For persistent change, trigger a new deployment instead
```

---

## Monitoring and Alerts

### CloudWatch Alarms

**Active Alarms:**
- CPU > 80% for 5 minutes
- Memory > 85%
- Disk > 80%
- EC2 status check failed

**Alert Destination:** SNS topic → Email (configured in Terraform)

### Grafana Dashboards

**Overview Dashboard:**
- System health (connectors, RPC status)
- Quote freshness
- Opportunity count (last hour/day)
- Execution summary

**Spreads Dashboard:**
- CEX vs DEX price overlay
- Spread distribution (histogram)
- Top pairs by dislocation frequency

**Executions Dashboard:**
- Fill rate
- Revert rate
- Average gas cost
- Realized PnL proxy

### Manual Health Check

```bash
docker ps

docker logs --tail 100 dislocation-trader-app

docker exec dislocation-postgres pg_isready -U trader

curl http://localhost:3000/api/health
```

---

## Log Access and Debugging

### View Live Logs

```bash
docker logs -f dislocation-trader-app

docker logs -f dislocation-postgres

docker logs -f dislocation-grafana
```

### Search Logs

```bash
docker logs dislocation-trader-app 2>&1 | grep "ERROR"

docker logs dislocation-trader-app --since 1h | grep "opportunity"
```

### CloudWatch Logs

**Log Groups:**
- `/aws/ec2/dislocation-trader-production`

**Streams:**
- `{instance-id}/syslog`
- `{instance-id}/docker`

**Query via CLI:**

```bash
aws logs tail /aws/ec2/dislocation-trader-production --follow
```

### Common Debug Commands

```bash
docker exec -it dislocation-trader-app node -e "console.log(require('./dist/config').default)"

docker exec -it dislocation-postgres psql -U trader -d dislocation_trader -c "SELECT * FROM connector_health ORDER BY updated_at DESC LIMIT 10;"

docker stats
```

---

## Database Operations

### Connect to Database

```bash
docker exec -it dislocation-postgres psql -U trader -d dislocation_trader
```

### Run Migrations

```bash
docker exec dislocation-trader-app npm run db:migrate
```

### Database Backup (Manual)

```bash
docker exec dislocation-postgres pg_dump -U trader -d dislocation_trader -F c -f /tmp/backup.dump

docker cp dislocation-postgres:/tmp/backup.dump ./backup-$(date +%Y%m%d).dump
```

### Database Restore

```bash
docker cp ./backup-20260120.dump dislocation-postgres:/tmp/restore.dump

docker exec dislocation-postgres pg_restore -U trader -d dislocation_trader -c /tmp/restore.dump
```

### Check Database Size

```sql
SELECT pg_size_pretty(pg_database_size('dislocation_trader')) AS db_size;

SELECT schemaname, tablename, pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
LIMIT 10;
```

### Vacuum and Analyze

```sql
VACUUM ANALYZE;

SELECT schemaname, tablename, last_vacuum, last_autovacuum
FROM pg_stat_user_tables
ORDER BY last_autovacuum DESC;
```

---

## Secret Rotation

**Rotation Schedule:**
- CEX API keys: Every 90 days
- RPC provider keys: Every 90 days
- Postgres password: Every 90 days
- Executor private key: On suspected compromise only

### Rotation Procedure

1. **Generate new credential** (CEX portal, RPC provider, etc.)

2. **Update AWS Secrets Manager:**

```bash
aws secretsmanager put-secret-value \
  --region us-east-1 \
  --secret-id dislocation-trader/binance-api-key \
  --secret-string "NEW_API_KEY"
```

3. **Restart application to pick up new secrets:**

```bash
ssh ubuntu@<EC2_PUBLIC_IP>

cd /home/ubuntu/app
source scripts/fetch-secrets.sh export

docker-compose -f docker/docker-compose.prod.yml restart app

docker logs -f dislocation-trader-app
```

4. **Verify functionality** (check Grafana for quote flow, no connector errors)

5. **Revoke old credential** (CEX portal, RPC provider)

6. **Log rotation event** (document in team wiki/runbook updates)

### Emergency Key Rotation (Compromised Executor Key)

```bash
aws secretsmanager put-secret-value \
  --region us-east-1 \
  --secret-id dislocation-trader/executor-private-key \
  --secret-string "NEW_PRIVATE_KEY"

ssh ubuntu@<EC2_PUBLIC_IP>
cd /home/ubuntu/app
docker-compose -f docker/docker-compose.prod.yml down
source scripts/fetch-secrets.sh export
docker-compose -f docker/docker-compose.prod.yml up -d
```

---

## Backup and Recovery

### Automated Backups

**EBS Snapshots:**
- Frequency: Daily at 02:00 UTC
- Retention: 7 days
- Managed by: AWS Data Lifecycle Manager (DLM) policy

### Manual EBS Snapshot

```bash
aws ec2 create-snapshot \
  --region us-east-1 \
  --volume-id <VOLUME_ID> \
  --description "Manual snapshot before upgrade $(date +%Y-%m-%d)" \
  --tag-specifications 'ResourceType=snapshot,Tags=[{Key=Name,Value=manual-snapshot}]'
```

### Restore from EBS Snapshot

1. **Stop the instance:**

```bash
aws ec2 stop-instances --instance-ids <INSTANCE_ID> --region us-east-1
```

2. **Detach current volume:**

```bash
aws ec2 detach-volume --volume-id <OLD_VOLUME_ID> --region us-east-1
```

3. **Create volume from snapshot:**

```bash
aws ec2 create-volume \
  --region us-east-1 \
  --availability-zone us-east-1a \
  --snapshot-id <SNAPSHOT_ID> \
  --volume-type gp3 \
  --iops 3000 \
  --throughput 125
```

4. **Attach new volume:**

```bash
aws ec2 attach-volume \
  --volume-id <NEW_VOLUME_ID> \
  --instance-id <INSTANCE_ID> \
  --device /dev/sdf \
  --region us-east-1
```

5. **Start instance:**

```bash
aws ec2 start-instances --instance-ids <INSTANCE_ID> --region us-east-1
```

### Disaster Recovery (Full System Rebuild)

**Prerequisites:**
- EBS snapshot available
- Terraform state intact
- Secrets in Secrets Manager

**Procedure:**

```bash
cd infra/

terraform apply -auto-approve

ssh ubuntu@<NEW_EC2_IP>

cd /home/ubuntu/app

git clone <REPOSITORY_URL> .

source scripts/fetch-secrets.sh export

aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <ECR_REGISTRY>

docker-compose -f docker/docker-compose.prod.yml up -d

docker exec dislocation-trader-app npm run db:migrate
```

**RTO**: 30 minutes (provisioning + deployment)
**RPO**: 24 hours (last EBS snapshot)

---

## Scaling

### Vertical Scaling (Larger Instance)

1. **Stop application:**

```bash
docker-compose -f docker/docker-compose.prod.yml down
```

2. **Update Terraform:**

```hcl
variable "instance_type" {
  default = "t3.large"
}
```

3. **Apply changes:**

```bash
terraform apply
```

4. **Restart application** (see Start/Stop Procedures)

### Horizontal Scaling (Future)

**MVP uses single instance.** For horizontal scaling:
- Move Postgres to RDS
- Deploy multiple app instances behind ALB
- Use Redis for distributed state/locking
- Shard quote collection by venue

---

## Incident Response

### System Down / Unresponsive

1. **Check AWS Console:**
   - EC2 status checks
   - CloudWatch alarms

2. **SSH to instance:**

```bash
ssh ubuntu@<EC2_PUBLIC_IP>

docker ps
docker logs dislocation-trader-app --tail 100
top
df -h
```

3. **Restart services:**

```bash
docker-compose -f docker/docker-compose.prod.yml restart
```

4. **If unrecoverable, restore from snapshot** (see Backup and Recovery)

### High CPU / Memory Usage

1. **Identify process:**

```bash
docker stats
top
```

2. **Check logs for errors/loops:**

```bash
docker logs dislocation-trader-app | grep -E "ERROR|WARN"
```

3. **Restart app container:**

```bash
docker-compose -f docker/docker-compose.prod.yml restart app
```

4. **Scale vertically if persistent** (see Scaling)

### Database Connection Failures

1. **Check Postgres health:**

```bash
docker exec dislocation-postgres pg_isready -U trader
```

2. **Check connection pool exhaustion:**

```sql
SELECT count(*) FROM pg_stat_activity WHERE datname = 'dislocation_trader';
```

3. **Restart Postgres:**

```bash
docker-compose -f docker/docker-compose.prod.yml restart postgres
```

### CEX/DEX Connector Down

1. **Check connector health:**

```sql
SELECT * FROM connector_health WHERE ws_connected = false ORDER BY updated_at DESC;
```

2. **Check logs:**

```bash
docker logs dislocation-trader-app | grep -i "binance\|coinbase\|bybit"
```

3. **Verify API keys not revoked** (Secrets Manager)

4. **Restart app to trigger reconnect:**

```bash
docker-compose -f docker/docker-compose.prod.yml restart app
```

### Failed Deployment

1. **Check GitHub Actions logs** (build, push, deploy steps)

2. **Rollback to previous version:**

```bash
export IMAGE_TAG=<PREVIOUS_SHA>
docker-compose -f docker/docker-compose.prod.yml up -d
```

3. **Fix issue locally, re-deploy**

---

## Common Issues

### Issue: Quotes not appearing in database

**Symptoms:** `quotes_raw` table empty or stale

**Diagnosis:**

```bash
docker logs dislocation-trader-app | grep "quote"
```

**Causes:**
- CEX WebSocket disconnected
- Quote sampling rate too low
- Persistence disabled

**Resolution:**

```bash
docker-compose -f docker/docker-compose.prod.yml restart app
```

Check `connector_health` table for connection status.

---

### Issue: Opportunities detected but not executed

**Symptoms:** `opportunities` table has entries, `executions` table empty

**Diagnosis:**

```sql
SELECT status, skip_reason, COUNT(*) FROM opportunities GROUP BY status, skip_reason;
```

**Causes:**
- Paper mode enabled (expected)
- Risk limits exceeded
- Gas too high

**Resolution:**
- If paper mode: Working as intended
- If live mode: Check `skip_reason` column for details

---

### Issue: High disk usage

**Symptoms:** Disk > 80% alert, CloudWatch alarm

**Diagnosis:**

```bash
df -h
du -sh /data/postgres/*
```

**Causes:**
- Large `quotes_raw` table
- No vacuum/autovacuum

**Resolution:**

```sql
DELETE FROM quotes_raw WHERE ts < now() - interval '7 days';
VACUUM FULL quotes_raw;
```

Or increase EBS volume size (Terraform variable `ebs_volume_size`).

---

### Issue: Grafana not accessible

**Symptoms:** Port 3000 timeout or connection refused

**Diagnosis:**

```bash
docker ps | grep grafana
curl http://localhost:3000/api/health
```

**Causes:**
- Container down
- Security group misconfigured
- IP not whitelisted

**Resolution:**

```bash
docker-compose -f docker/docker-compose.prod.yml restart grafana
```

Check Security Group in AWS Console for allowed IPs.

---

## Contacts and Escalation

**Primary On-Call:** DevOps Team
**Secondary:** Engineering Lead
**Escalation Path:** CTO

**Communication Channels:**
- Slack: `#dislocation-trader-ops`
- Telegram: Ops alert group
- PagerDuty: (if configured)

---

## Changelog

| Date | Author | Change |
|------|--------|--------|
| 2026-01-20 | DevOps Agent | Initial runbook |

---

**Document Status**: Living document, update after each incident or operational change.
