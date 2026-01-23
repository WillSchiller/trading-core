# Quick Reference Card

Essential commands and information for operating the Dislocation Trader system.

## SSH Access

```bash
ssh -i ~/.ssh/dislocation-trader ubuntu@<EC2_PUBLIC_IP>
```

## Service Management

```bash
# Start all services
cd /home/ubuntu/app
docker-compose -f docker/docker-compose.prod.yml up -d

# Stop all services
docker-compose -f docker/docker-compose.prod.yml down

# Restart single service
docker-compose -f docker/docker-compose.prod.yml restart app

# Check status
docker-compose -f docker/docker-compose.prod.yml ps
```

## Logs

```bash
# App logs (live)
docker logs -f dislocation-trader-app

# App logs (last 100 lines)
docker logs --tail 100 dislocation-trader-app

# Postgres logs
docker logs dislocation-postgres

# All services
docker-compose -f docker/docker-compose.prod.yml logs -f
```

## Database

```bash
# Connect to database
docker exec -it dislocation-postgres psql -U trader -d dislocation_trader

# Common queries
SELECT * FROM connector_health ORDER BY updated_at DESC LIMIT 5;
SELECT COUNT(*) FROM quotes_raw;
SELECT COUNT(*) FROM opportunities WHERE detected_at > now() - interval '1 hour';
SELECT * FROM executions ORDER BY created_at DESC LIMIT 10;

# Exit
\q
```

## Deployment

```bash
# Fetch secrets
source scripts/fetch-secrets.sh export

# Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <ECR_URL>

# Pull and restart
docker-compose -f docker/docker-compose.prod.yml pull
docker-compose -f docker/docker-compose.prod.yml up -d

# Run migrations
docker exec dislocation-trader-app npm run db:migrate
```

## Monitoring

### Grafana
- **URL**: `http://<EC2_PUBLIC_IP>:3000`
- **User**: admin
- **Password**: (from GRAFANA_ADMIN_PASSWORD)

### CloudWatch Logs
```bash
aws logs tail /aws/ec2/dislocation-trader-production --follow
```

### Container Stats
```bash
docker stats
```

## Health Checks

```bash
# Postgres
docker exec dislocation-postgres pg_isready -U trader

# Grafana
curl http://localhost:3000/api/health

# All containers
docker ps
```

## Troubleshooting

### CEX Connector Down
```bash
docker logs dislocation-trader-app | grep -i "binance\|coinbase\|bybit"
docker-compose -f docker/docker-compose.prod.yml restart app
```

### High CPU/Memory
```bash
docker stats
top
# Scale up instance or tune detection thresholds
```

### Database Issues
```bash
docker exec dislocation-postgres pg_isready -U trader
docker-compose -f docker/docker-compose.prod.yml restart postgres
```

### Disk Full
```bash
df -h
# Delete old quotes: see runbook.md
```

## Emergency Procedures

### Stop Trading
```bash
# Option 1: Stop all services
docker-compose -f docker/docker-compose.prod.yml down

# Option 2: Enable paper mode
# Update PAPER_MODE=true in Secrets Manager, then:
docker-compose -f docker/docker-compose.prod.yml restart app
```

### Rollback Deployment
```bash
export IMAGE_TAG=<previous-commit-sha>
docker-compose -f docker/docker-compose.prod.yml up -d
```

### Restore from Backup
See `docs/runbook.md` → Backup and Recovery

## Important Files

### On EC2
- App directory: `/home/ubuntu/app`
- Secrets: `/home/ubuntu/app/.env.secrets` (auto-generated)
- Postgres data: `/data/postgres` (EBS mount)

### Configuration
- Compose: `docker/docker-compose.prod.yml`
- Terraform: `infra/*.tf`
- Pairs: `config/pairs.json`
- Default config: `config/default.json`

## Terraform

```bash
cd infra/

# Plan changes
terraform plan

# Apply changes
terraform apply

# Get outputs
terraform output

# Destroy (DANGEROUS)
terraform destroy
```

## Common Environment Variables

```bash
# Set for deployment
export ECR_REPOSITORY_URL=<your-ecr-url>
export IMAGE_TAG=latest
export PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
export GRAFANA_ADMIN_PASSWORD=<password>

# Feature flags
export PAPER_MODE=true
export ENABLE_BASE=true
export ENABLE_MAINNET=false
export LOG_LEVEL=info
```

## Secrets Management

```bash
# Fetch all secrets
source scripts/fetch-secrets.sh export

# Update single secret
aws secretsmanager put-secret-value \
  --region us-east-1 \
  --secret-id dislocation-trader/postgres-password \
  --secret-string "NEW_PASSWORD"

# List all secrets
aws secretsmanager list-secrets \
  --region us-east-1 \
  --filters Key=name,Values=dislocation-trader/
```

## Key Ports

- **SSH**: 22 (IP-restricted)
- **Grafana**: 3000 (IP-restricted)
- **Postgres**: 5432 (127.0.0.1 only)
- **App**: 8080 (internal only)

## Key IPs

- **EC2 Public IP**: `terraform output instance_public_ip`
- **Elastic IP**: Same as public IP (persistent)
- **Private IP**: `terraform output instance_private_ip`

## CloudWatch Alarms

- CPU > 80% for 5 min
- Memory > 85%
- Disk > 80%
- Status check failed

**Notifications**: SNS email (configured in Terraform)

## Resource Limits

- **App**: 2 CPU, 2GB RAM
- **Postgres**: 1.5 CPU, 2GB RAM
- **Grafana**: 0.5 CPU, 512MB RAM

## Backup Schedule

- **EBS Snapshots**: Daily at 02:00 UTC
- **Retention**: 7 days
- **Manual**: See runbook.md

## Documentation

- **Full Deployment**: `docs/DEPLOYMENT.md`
- **Checklist**: `docs/DEPLOYMENT_CHECKLIST.md`
- **Runbook**: `docs/runbook.md`
- **Infrastructure**: `INFRASTRUCTURE_SUMMARY.md`
- **Worklog**: `docs/WORKLOG.md`

## Support Contacts

- **DevOps**: (on-call)
- **Engineering**: (lead)
- **Slack**: `#dislocation-trader-ops`
- **Telegram**: Ops alert group

## URLs

- **ECR**: `terraform output ecr_repository_url`
- **Grafana**: `terraform output grafana_url`
- **SSH**: `terraform output ssh_command`

---

**Keep this card handy for daily operations!**

For detailed procedures, always refer to the full documentation in `docs/`.
