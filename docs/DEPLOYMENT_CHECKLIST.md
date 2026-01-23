# Deployment Checklist

Use this checklist for initial deployment and major updates.

## Pre-Deployment

### Prerequisites
- [ ] AWS account with appropriate IAM permissions
- [ ] AWS CLI installed and configured
- [ ] Terraform >= 1.6 installed
- [ ] Docker installed
- [ ] SSH key pair generated (`~/.ssh/dislocation-trader`)
- [ ] Team IPs identified for Security Group whitelist

### RPC Provider Setup
- [ ] Alchemy or QuickNode account created (paid tier)
- [ ] Base Mainnet HTTP endpoint URL obtained
- [ ] Base Mainnet WebSocket endpoint URL obtained
- [ ] Endpoints tested with curl/wscat

### CEX API Keys
- [ ] Binance read-only API key created
- [ ] Coinbase read-only API key + secret + passphrase created
- [ ] Bybit read-only API key created (optional)
- [ ] All keys tested with example API calls

### Executor Wallet
- [ ] Dedicated wallet created (separate from all other wallets)
- [ ] Private key securely backed up
- [ ] Wallet funded with minimal Base ETH (0.01-0.1 ETH)
- [ ] Wallet address documented

### Telegram Alerts
- [ ] Bot created via @BotFather
- [ ] Bot token obtained
- [ ] Chat ID obtained (send message to bot, use getUpdates API)

## Infrastructure Provisioning

### S3 Backend
- [ ] S3 bucket created: `dislocation-trader-terraform-state`
- [ ] Bucket versioning enabled
- [ ] Bucket encryption enabled (AES256)
- [ ] Bucket region set to `us-east-1`

### Terraform Configuration
- [ ] `infra/terraform.tfvars` created from example
- [ ] `aws_region` set correctly
- [ ] `instance_type` chosen (t3.medium recommended)
- [ ] `ebs_volume_size` set (50GB default)
- [ ] `ssh_public_key` pasted (full key content)
- [ ] `allowed_ssh_cidrs` configured with team IPs
- [ ] `allowed_grafana_cidrs` configured with team IPs
- [ ] `alert_email` set for CloudWatch notifications

### Terraform Execution
- [ ] `terraform init` completed successfully
- [ ] `terraform validate` passed
- [ ] `terraform plan` reviewed (no unexpected changes)
- [ ] `terraform apply` completed
- [ ] Terraform outputs saved (`terraform output > terraform-outputs.txt`)
- [ ] Instance public IP noted
- [ ] ECR repository URL noted

### Infrastructure Verification
- [ ] SSH access works: `ssh -i ~/.ssh/dislocation-trader ubuntu@<IP>`
- [ ] Docker installed on EC2: `docker --version`
- [ ] EBS volume mounted: `df -h | grep /data/postgres`
- [ ] CloudWatch agent running: `systemctl status amazon-cloudwatch-agent`
- [ ] fail2ban active: `systemctl status fail2ban`
- [ ] chrony syncing time: `chronyc tracking`

## Secrets Configuration

### AWS Secrets Manager
- [ ] `scripts/populate-secrets.sh` executed
- [ ] All 10 secrets populated:
  - [ ] `postgres-password`
  - [ ] `rpc-base-http`
  - [ ] `rpc-base-ws`
  - [ ] `binance-api-key`
  - [ ] `binance-api-secret`
  - [ ] `coinbase-api-key`
  - [ ] `coinbase-api-secret`
  - [ ] `coinbase-passphrase`
  - [ ] `executor-private-key`
  - [ ] `telegram-bot-token`
- [ ] Secrets verified: `aws secretsmanager list-secrets --filters Key=name,Values=dislocation-trader/`

## Application Deployment

### EC2 Instance Setup
- [ ] Repository cloned to `/home/ubuntu/app`
- [ ] `scripts/fetch-secrets.sh` made executable
- [ ] Secrets fetched and exported to `.env.secrets`
- [ ] `.env.secrets` permissions set to 600

### Docker Image
- [ ] ECR login successful
- [ ] Docker image built locally
- [ ] Image tagged with ECR URL
- [ ] Image pushed to ECR
- [ ] Image pull tested on EC2

### Container Deployment
- [ ] `ECR_REPOSITORY_URL` environment variable set
- [ ] `IMAGE_TAG` set (latest or commit SHA)
- [ ] `PUBLIC_IP` set (instance IP)
- [ ] `GRAFANA_ADMIN_PASSWORD` generated and set
- [ ] `.env.secrets` sourced
- [ ] `docker-compose -f docker/docker-compose.prod.yml up -d` executed
- [ ] All 3 containers running: `docker ps`

### Database Setup
- [ ] Database migrations run: `docker exec dislocation-trader-app npm run db:migrate`
- [ ] Reference data seeded: `docker exec dislocation-trader-app npm run db:seed`
- [ ] Tables verified: `psql -U trader -d dislocation_trader -c "\dt"`
- [ ] Venues seeded: `SELECT * FROM venues;`
- [ ] Pairs seeded: `SELECT * FROM pairs;`

## Verification

### Application Health
- [ ] App logs show successful startup: `docker logs dislocation-trader-app --tail 50`
- [ ] Config loaded successfully (log message)
- [ ] Database connection established (log message)
- [ ] CEX connectors connected:
  - [ ] Binance connected
  - [ ] Coinbase connected
  - [ ] Bybit connected (if enabled)
- [ ] DEX connectors initialized (Base chain)
- [ ] Block watcher started

### Data Collection
- [ ] Wait 2-3 minutes for quotes to accumulate
- [ ] `quotes_raw` table has data: `SELECT COUNT(*) FROM quotes_raw;`
- [ ] `connector_health` table shows connections: `SELECT * FROM connector_health;`
- [ ] CEX quotes fresh (last_quote_at recent)
- [ ] DEX quotes appearing (if RPC endpoint working)

### Grafana
- [ ] Grafana accessible at `http://<IP>:3000`
- [ ] Login successful (admin / GRAFANA_ADMIN_PASSWORD)
- [ ] Default password changed
- [ ] Postgres datasource connected
- [ ] Dashboards visible:
  - [ ] Overview dashboard loads
  - [ ] Spreads dashboard loads
  - [ ] Executions dashboard loads
- [ ] Sample data visible in dashboards

### Monitoring
- [ ] CloudWatch log group exists: `/aws/ec2/dislocation-trader-production`
- [ ] Logs streaming to CloudWatch
- [ ] CloudWatch alarms active (CPU, memory, disk, status check)
- [ ] SNS subscription confirmed (check email)
- [ ] Test alarm by triggering threshold (optional)

## CI/CD Setup

### GitHub Secrets
- [ ] `AWS_ACCESS_KEY_ID` added
- [ ] `AWS_SECRET_ACCESS_KEY` added
- [ ] `ECR_REGISTRY` added (format: `123456789.dkr.ecr.us-east-1.amazonaws.com`)
- [ ] `EC2_SSH_KEY` added (private key content)

### Workflow Testing
- [ ] Test branch created
- [ ] Test commit pushed
- [ ] CI workflow triggered and passed (lint, test, build)
- [ ] PR merged to main
- [ ] Deploy workflow triggered and completed successfully
- [ ] Health check passed at end of deploy

## Security Hardening

### Pre-Production Checklist
- [ ] SSH restricted to team IPs only (not 0.0.0.0/0)
- [ ] Grafana restricted to team IPs only
- [ ] No secrets in git repository
- [ ] No secrets in docker-compose.yml (all from Secrets Manager)
- [ ] Executor wallet funded with minimal amount (<0.1 ETH)
- [ ] `PAPER_MODE=true` in initial deployment
- [ ] All containers running as non-root
- [ ] EBS volumes encrypted
- [ ] fail2ban active and configured
- [ ] unattended-upgrades enabled
- [ ] CloudWatch alarms tested
- [ ] Backup schedule confirmed (daily EBS snapshots)

### Access Control
- [ ] SSH key protected (600 permissions)
- [ ] AWS credentials rotated (not root account)
- [ ] Grafana default password changed
- [ ] Team members documented with access
- [ ] Runbook shared with team

## Post-Deployment

### Monitoring Period (24-48 hours)
- [ ] Monitor Grafana dashboards hourly
- [ ] Check for connector disconnects
- [ ] Verify quote flow is continuous
- [ ] Review opportunity detection (should see detections in paper mode)
- [ ] Check for errors in logs
- [ ] Verify disk usage stable
- [ ] Verify memory/CPU normal
- [ ] Confirm no CloudWatch alarms firing

### Tuning
- [ ] Review opportunity frequency (too high/low?)
- [ ] Adjust `minSpreadBps` per pair if needed
- [ ] Adjust `minDurationMs` if gaps close too fast
- [ ] Review `minLiquidityUsd` thresholds
- [ ] Check false positive rate

### Documentation
- [ ] Document actual IP addresses in team wiki
- [ ] Document ECR URLs
- [ ] Document Grafana URL and credentials
- [ ] Document on-call rotation
- [ ] Add incident response contact info
- [ ] Update runbook with any deployment quirks

## Live Trading Enablement (When Ready)

### Pre-Live Checklist
- [ ] Paper mode results reviewed (24-48 hours minimum)
- [ ] Opportunity detection validated (real dislocations, not noise)
- [ ] Cost estimates validated (gas, slippage reasonable)
- [ ] No false positives causing bad trades
- [ ] All team members notified
- [ ] Executor wallet balance confirmed
- [ ] Risk limits reviewed and approved:
  - [ ] `MAX_TRADE_SIZE_USD` appropriate
  - [ ] `MAX_OPEN_EXPOSURE_USD` appropriate
  - [ ] `MAX_GAS_GWEI` reasonable for Base
  - [ ] `COOLDOWN_SECONDS` set

### Enable Live Trading
- [ ] Update secret: `PAPER_MODE=false` in Secrets Manager or .env
- [ ] Restart application: `docker-compose restart app`
- [ ] Monitor first 10 trades closely
- [ ] Verify executions appear in `executions` table
- [ ] Verify on-chain transactions via Basescan
- [ ] Monitor realized gas costs
- [ ] Monitor realized slippage
- [ ] Set Telegram alerts to high priority

### Emergency Contacts
- [ ] On-call engineer: _________________
- [ ] Secondary contact: _________________
- [ ] Emergency halt procedure documented
- [ ] Rollback procedure tested

## Rollback Procedure

If issues arise:
1. [ ] Stop trading: `docker-compose down` or set `PAPER_MODE=true`
2. [ ] Identify issue in logs/Grafana
3. [ ] Deploy previous version:
   ```bash
   export IMAGE_TAG=<previous-commit-sha>
   docker-compose up -d
   ```
4. [ ] Verify rollback successful
5. [ ] Document incident

## Sign-Off

Deployment completed by: ___________________
Date: ___________________
Deployment type: [ ] Initial  [ ] Update  [ ] Hotfix
Environment: [ ] Production  [ ] Staging

Team approval:
- DevOps: ___________________
- Engineering Lead: ___________________
- Product Owner: ___________________

Notes:
_________________________________________________________________
_________________________________________________________________
_________________________________________________________________
