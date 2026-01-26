# Deployment Guide

Complete guide for deploying the Dislocation Trader system to AWS.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Initial Setup](#initial-setup)
3. [Infrastructure Provisioning](#infrastructure-provisioning)
4. [Secrets Configuration](#secrets-configuration)
5. [Application Deployment](#application-deployment)
6. [Verification](#verification)
7. [CI/CD Setup](#cicd-setup)
8. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required Tools

Install the following on your local machine:

- **Terraform** >= 1.6
  ```bash
  brew install terraform
  ```

- **AWS CLI** >= 2.0
  ```bash
  brew install awscli
  ```

- **Docker** >= 24.0
  ```bash
  brew install docker
  ```

- **SSH Key Pair**
  ```bash
  ssh-keygen -t rsa -b 4096 -f ~/.ssh/dislocation-trader -C "dislocation-trader"
  ```

### AWS Account Setup

1. **Create IAM User** with permissions:
   - EC2 Full Access
   - EBS Full Access
   - VPC Full Access
   - Secrets Manager Full Access
   - CloudWatch Full Access
   - SNS Full Access
   - ECR Full Access
   - IAM Role Creation

2. **Configure AWS CLI:**
   ```bash
   aws configure
   ```

3. **Create S3 bucket for Terraform state:**
   ```bash
   aws s3api create-bucket \
     --bucket dislocation-trader-terraform-state \
     --region us-east-1

   aws s3api put-bucket-versioning \
     --bucket dislocation-trader-terraform-state \
     --versioning-configuration Status=Enabled

   aws s3api put-bucket-encryption \
     --bucket dislocation-trader-terraform-state \
     --server-side-encryption-configuration '{
       "Rules": [{
         "ApplyServerSideEncryptionByDefault": {
           "SSEAlgorithm": "AES256"
         }
       }]
     }'
   ```

### RPC Provider Setup

1. **Sign up for Alchemy or QuickNode** (paid tier recommended)

2. **Create Base Mainnet endpoints:**
   - HTTP endpoint: `https://base-mainnet.g.alchemy.com/v2/YOUR_KEY`
   - WebSocket endpoint: `wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY`

3. **Store endpoints securely** (will be added to Secrets Manager later)

### CEX API Keys

1. **Binance**
   - Create read-only API key at https://www.binance.com/en/my/settings/api-management
   - Enable "Enable Reading" permission only
   - Restrict to your IP if possible

2. **Coinbase**
   - Create API key at https://www.coinbase.com/settings/api
   - Portfolio: View permission only
   - Note the API Key, Secret, and Passphrase

3. **Bybit** (optional)
   - Create read-only API key at https://www.bybit.com/app/user/api-management

### Executor Wallet

1. **Create dedicated wallet:**
   ```bash
   # Use a tool like ethers.js or MetaMask
   # CRITICAL: Use a SEPARATE wallet with limited funds
   ```

2. **Fund wallet** with small amount for gas (0.01-0.1 ETH on Base)

3. **Store private key securely** (will be added to Secrets Manager)

---

## Initial Setup

### 1. Clone Repository

```bash
git clone <repository-url>
cd blockhelix
```

### 2. Configure Terraform Variables

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

```hcl
aws_region  = "us-east-1"
environment = "production"

instance_type    = "t3.medium"
ebs_volume_size  = 50

ssh_public_key = "ssh-rsa AAAAB3NzaC1yc2E... (paste your public key)"

allowed_ssh_cidrs = [
  "YOUR_IP/32",
]

allowed_grafana_cidrs = [
  "YOUR_IP/32",
]

alert_email = "your-email@example.com"

project_name = "dislocation-trader"
vpc_cidr     = "10.0.0.0/16"
subnet_cidr  = "10.0.1.0/24"
```

**Security Note:** Replace `YOUR_IP` with your actual public IP. Use https://whatismyipaddress.com/ to find it.

---

## Infrastructure Provisioning

### 1. Initialize Terraform

```bash
cd infra
terraform init
```

**Expected output:**
```
Initializing the backend...
Successfully configured the backend "s3"!
...
Terraform has been successfully initialized!
```

### 2. Plan Infrastructure

```bash
terraform plan -out=tfplan
```

**Review the plan carefully.** You should see:
- 1 VPC
- 1 Subnet
- 1 Internet Gateway
- 1 Route Table
- 1 Security Group
- 1 EC2 Instance
- 1 EBS Volume
- 1 Elastic IP
- 1 ECR Repository
- 10 Secrets Manager Secrets
- 4 CloudWatch Alarms
- 1 SNS Topic

### 3. Apply Infrastructure

```bash
terraform apply tfplan
```

**Provisioning time:** 5-10 minutes

**Save outputs:**

```bash
terraform output > ../terraform-outputs.txt
```

You should see:
- `instance_public_ip`: EC2 public IP
- `ecr_repository_url`: Docker registry URL
- `grafana_url`: Grafana dashboard URL
- `ssh_command`: SSH connection command

### 4. Verify Infrastructure

```bash
# Test SSH access
ssh -i ~/.ssh/dislocation-trader ubuntu@$(terraform output -raw instance_public_ip)

# Check Docker is installed
docker --version

# Check EBS volume is mounted
df -h | grep /data/postgres

# Exit SSH
exit
```

---

## Secrets Configuration

### 1. Populate AWS Secrets Manager

**Script approach (recommended):**

Create `populate-secrets.sh`:

```bash
#!/bin/bash
set -e

REGION="us-east-1"
PROJECT="dislocation-trader"

populate_secret() {
  local name=$1
  local value=$2

  aws secretsmanager put-secret-value \
    --region "$REGION" \
    --secret-id "$PROJECT/$name" \
    --secret-string "$value"

  echo "✓ Populated $name"
}

populate_secret "postgres-password" "YOUR_SECURE_PASSWORD"
populate_secret "rpc-base-http" "https://base-mainnet.g.alchemy.com/v2/YOUR_KEY"
populate_secret "rpc-base-ws" "wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY"
populate_secret "binance-api-key" "YOUR_BINANCE_KEY"
populate_secret "binance-api-secret" "YOUR_BINANCE_SECRET"
populate_secret "coinbase-api-key" "YOUR_COINBASE_KEY"
populate_secret "coinbase-api-secret" "YOUR_COINBASE_SECRET"
populate_secret "coinbase-passphrase" "YOUR_COINBASE_PASSPHRASE"
populate_secret "executor-private-key" "YOUR_EXECUTOR_PRIVATE_KEY"
populate_secret "telegram-bot-token" "YOUR_TELEGRAM_TOKEN"

echo "All secrets populated successfully"
```

**Run script:**

```bash
chmod +x populate-secrets.sh
./populate-secrets.sh
```

**Manual approach (alternative):**

```bash
aws secretsmanager put-secret-value \
  --region us-east-1 \
  --secret-id dislocation-trader/postgres-password \
  --secret-string "YOUR_SECURE_PASSWORD"

# Repeat for each secret...
```

### 2. Verify Secrets

```bash
aws secretsmanager list-secrets --region us-east-1 --filters Key=name,Values=dislocation-trader/
```

---

## Application Deployment

### 1. Prepare EC2 Instance

SSH to instance:

```bash
ssh -i ~/.ssh/dislocation-trader ubuntu@<INSTANCE_IP>
```

Clone repository:

```bash
cd /home/ubuntu
git clone <repository-url> app
cd app
```

Copy deployment scripts:

```bash
chmod +x scripts/fetch-secrets.sh
```

### 2. Build and Push Docker Image

**From local machine:**

```bash
# Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <ECR_REPOSITORY_URL>

# Build image
docker build -t dislocation-trader:latest -f docker/Dockerfile .

# Tag image
docker tag dislocation-trader:latest <ECR_REPOSITORY_URL>:latest

# Push image
docker push <ECR_REPOSITORY_URL>:latest
```

**Build time:** 2-5 minutes

### 3. Deploy Application

**On EC2 instance:**

```bash
cd /home/ubuntu/app

# Fetch secrets from Secrets Manager
source scripts/fetch-secrets.sh export

# Login to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <ECR_REPOSITORY_URL>

# Set environment variables
export ECR_REPOSITORY_URL=<YOUR_ECR_URL>
export IMAGE_TAG=latest
export PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)
export GRAFANA_ADMIN_PASSWORD=$(openssl rand -base64 16)

# Source secrets
source .env.secrets

# Start services
docker-compose -f docker/docker-compose.prod.yml up -d

# Check status
docker-compose -f docker/docker-compose.prod.yml ps
```

### 4. Run Database Migrations

```bash
docker exec dislocation-trader-app npm run db:migrate
```

### 5. Seed Reference Data

```bash
docker exec dislocation-trader-app npm run db:seed
```

---

## Verification

### 1. Check Container Health

```bash
docker ps

# Expected output: 3 containers running (app, postgres, grafana)
```

### 2. Check Logs

```bash
docker logs dislocation-trader-app --tail 50

# Look for:
# ✓ "config loaded successfully"
# ✓ "database connected"
# ✓ "binance connector connected"
# ✓ "coinbase connector connected"
# ✓ "block watcher started"
```

### 3. Verify Database

```bash
docker exec -it dislocation-postgres psql -U trader -d dislocation_trader

# Check tables exist:
SELECT tablename FROM pg_tables WHERE schemaname = 'public';

# Check connector health:
SELECT * FROM connector_health;

# Exit:
\q
```

### 4. Access Grafana

**URL:** `http://<INSTANCE_IP>:3000`

**Login:**
- Username: `admin`
- Password: (from `GRAFANA_ADMIN_PASSWORD` set earlier)

**Expected:**
- Postgres datasource connected
- Dashboards visible (Overview, Spreads, Executions)

### 5. Test Quote Collection

Wait 2-3 minutes, then check:

```bash
docker exec -it dislocation-postgres psql -U trader -d dislocation_trader -c "SELECT COUNT(*) FROM quotes_raw;"

# Should return non-zero count
```

---

## Dashboard Deployment

Grafana dashboards can be deployed independently of the application, enabling fast iteration on visualization changes.

### Automatic Dashboard Sync

Dashboards are automatically deployed when changes are pushed to `main` branch:

**Trigger paths:**
- `grafana/dashboards/**`
- `grafana/provisioning/**`

**What happens:**
1. GitHub Actions workflow detects dashboard file changes
2. Uploads dashboards to S3 (`s3://blockhelixasia/deploy/grafana/`)
3. SSM syncs files to EC2 (`/home/ubuntu/app/grafana/`)
4. Grafana container is restarted to pick up changes
5. Health check verifies Grafana is running

**Time to deploy:** ~1-2 minutes after push

### Manual Dashboard Sync

**Option 1: GitHub Actions**
1. Go to Actions > "Sync Grafana Dashboards"
2. Click "Run workflow"
3. Optionally check "Force sync" to sync even without changes

**Option 2: Local script**
```bash
./scripts/sync-dashboards.sh
```

**Requirements:**
- AWS CLI configured with appropriate credentials
- EC2 instance must be running

### Dashboard Workflow Details

The sync workflow (`.github/workflows/sync-dashboards.yml`) uses AWS SSM to avoid SSH key management:

1. Finds EC2 instance by tag name (`dislocation-trader-production`)
2. Uses SSM `AWS-RunShellScript` to execute commands on instance
3. Does not require SSH access or exposed ports

**Required GitHub Secrets:**
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

---

## CI/CD Setup

### 1. Configure GitHub Secrets

**Required secrets:**

```
AWS_ACCESS_KEY_ID=<IAM_USER_KEY>
AWS_SECRET_ACCESS_KEY=<IAM_USER_SECRET>
ECR_REGISTRY=<ECR_REGISTRY_URL>
EC2_SSH_KEY=<PRIVATE_KEY_CONTENT>
```

**Add secrets via GitHub UI:**
- Repository → Settings → Secrets and variables → Actions → New repository secret

### 2. Test CI Workflow

```bash
git checkout -b test-ci
git commit --allow-empty -m "Test CI"
git push origin test-ci
```

Open PR on GitHub. CI workflow should run (lint, test, build).

### 3. Test Deploy Workflow

Merge PR to `main`:

```bash
git checkout main
git pull
```

Deploy workflow triggers automatically. Monitor in GitHub Actions tab.

**Expected steps:**
1. Build Docker image
2. Push to ECR
3. SSH to EC2
4. Pull new image
5. Restart containers
6. Health check

---

## Troubleshooting

### Issue: Terraform apply fails

**Error:** `Error: creating EC2 Instance: InvalidKeyPair.NotFound`

**Solution:** Verify `ssh_public_key` in `terraform.tfvars` is correct.

---

### Issue: Cannot SSH to instance

**Error:** `Connection timed out`

**Solution:**
1. Check Security Group allows your IP:
   ```bash
   aws ec2 describe-security-groups --group-ids <SG_ID>
   ```
2. Verify your public IP hasn't changed
3. Update `allowed_ssh_cidrs` in `terraform.tfvars` and re-apply

---

### Issue: Docker containers fail to start

**Error:** `Exited (1) 3 seconds ago`

**Solution:**
1. Check logs:
   ```bash
   docker logs dislocation-trader-app
   ```
2. Verify secrets loaded:
   ```bash
   docker exec dislocation-trader-app env | grep POSTGRES
   ```
3. Ensure Postgres is healthy:
   ```bash
   docker exec dislocation-postgres pg_isready -U trader
   ```

---

### Issue: No quotes appearing

**Symptoms:** `quotes_raw` table empty after 5 minutes

**Solution:**
1. Check CEX connectors:
   ```bash
   docker logs dislocation-trader-app | grep -i "connected"
   ```
2. Verify API keys in Secrets Manager are correct
3. Check connector health:
   ```sql
   SELECT * FROM connector_health WHERE ws_connected = false;
   ```

---

### Issue: Grafana shows "Data source not found"

**Solution:**
1. Check Postgres datasource configuration in Grafana
2. Verify Postgres container is running:
   ```bash
   docker ps | grep postgres
   ```
3. Test connection from Grafana container:
   ```bash
   docker exec dislocation-grafana wget -qO- http://postgres:5432
   ```

---

## Security Checklist

Before going live:

- [ ] SSH restricted to team IPs only
- [ ] Grafana restricted to team IPs only
- [ ] All secrets in Secrets Manager (not in .env files)
- [ ] Executor wallet funded with minimal amount (<0.1 ETH)
- [ ] PAPER_MODE=true enabled
- [ ] CloudWatch alarms configured and tested
- [ ] SNS email subscription confirmed
- [ ] Grafana default password changed
- [ ] fail2ban active on EC2 instance
- [ ] EBS volume encrypted
- [ ] Daily EBS snapshots configured

---

## Next Steps

1. **Monitor for 24-48 hours in paper mode**
   - Verify opportunities are detected
   - Verify cost estimates are reasonable
   - Check for false positives

2. **Tune detection thresholds**
   - Adjust `minSpreadBps` per pair if too noisy
   - Increase `minDurationMs` if gaps close too quickly

3. **Enable live trading** (when ready)
   ```bash
   # Update in Secrets Manager or .env
   PAPER_MODE=false

   # Restart app
   docker-compose -f docker/docker-compose.prod.yml restart app
   ```

4. **Set up Telegram alerts**
   - Create bot via @BotFather
   - Get chat ID
   - Update `TELEGRAM_CHAT_ID` and `TELEGRAM_BOT_TOKEN`

---

## Support

For issues, refer to:
- [Operational Runbook](./runbook.md)
- [WORKLOG](./WORKLOG.md)
- Team Slack: `#dislocation-trader-ops`

---

**Document Version**: 1.0
**Last Updated**: 2026-01-20
