# Infrastructure Summary

Complete AWS infrastructure for the CEX/DEX Dislocation Trader system.

## Overview

The infrastructure is provisioned entirely via Terraform and consists of a single EC2 instance running docker-compose with three containers: Node.js app, PostgreSQL, and Grafana.

**Deployment Model**: Single-instance monolith (MVP)
**Region**: us-east-1 (configurable)
**Infrastructure as Code**: Terraform
**Container Orchestration**: docker-compose
**Secrets Management**: AWS Secrets Manager
**Monitoring**: CloudWatch + Grafana

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         AWS Account                         │
│                                                             │
│  ┌────────────────────────────────────────────────────┐   │
│  │                    VPC (10.0.0.0/16)               │   │
│  │                                                     │   │
│  │  ┌───────────────────────────────────────────┐    │   │
│  │  │   Subnet (10.0.1.0/24)                    │    │   │
│  │  │                                            │    │   │
│  │  │  ┌──────────────────────────────────┐    │    │   │
│  │  │  │  EC2 Instance (t3.medium)        │    │    │   │
│  │  │  │                                   │    │    │   │
│  │  │  │  ┌────────────────────────────┐  │    │    │   │
│  │  │  │  │  Docker Containers         │  │    │    │   │
│  │  │  │  │                            │  │    │    │   │
│  │  │  │  │  ┌──────────────────────┐ │  │    │    │   │
│  │  │  │  │  │ Node.js App          │ │  │    │    │   │
│  │  │  │  │  │ (Port 8080)          │ │  │    │    │   │
│  │  │  │  │  │ - CEX connectors     │ │  │    │    │   │
│  │  │  │  │  │ - DEX readers        │ │  │    │    │   │
│  │  │  │  │  │ - Detection engine   │ │  │    │    │   │
│  │  │  │  │  │ - Paper trader       │ │  │    │    │   │
│  │  │  │  │  └──────────────────────┘ │  │    │    │   │
│  │  │  │  │                            │  │    │    │   │
│  │  │  │  │  ┌──────────────────────┐ │  │    │    │   │
│  │  │  │  │  │ PostgreSQL           │ │  │    │    │   │
│  │  │  │  │  │ (Port 5432)          │ │  │    │    │   │
│  │  │  │  │  │ - Quotes storage     │ │  │    │    │   │
│  │  │  │  │  │ - Opportunities      │ │  │    │    │   │
│  │  │  │  │  │ - Executions         │ │  │    │    │   │
│  │  │  │  │  └──────────────────────┘ │  │    │    │   │
│  │  │  │  │           │                │  │    │    │   │
│  │  │  │  │           ▼                │  │    │    │   │
│  │  │  │  │  ┌──────────────────────┐ │  │    │    │   │
│  │  │  │  │  │ EBS Volume (50GB)    │ │  │    │    │   │
│  │  │  │  │  │ /data/postgres       │ │  │    │    │   │
│  │  │  │  │  └──────────────────────┘ │  │    │    │   │
│  │  │  │  │                            │  │    │    │   │
│  │  │  │  │  ┌──────────────────────┐ │  │    │    │   │
│  │  │  │  │  │ Grafana              │ │  │    │    │   │
│  │  │  │  │  │ (Port 3000)          │ │  │    │    │   │
│  │  │  │  │  │ - Dashboards         │ │  │    │    │   │
│  │  │  │  │  │ - Alerts             │ │  │    │    │   │
│  │  │  │  │  └──────────────────────┘ │  │    │    │   │
│  │  │  │  └────────────────────────────┘  │    │    │   │
│  │  │  │                                   │    │    │   │
│  │  │  │  Elastic IP: 1.2.3.4             │    │    │   │
│  │  │  └───────────────────────────────────┘    │    │   │
│  │  │                                            │    │   │
│  │  └────────────────────────────────────────────┘    │   │
│  │                                                     │   │
│  │  Internet Gateway                                  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────┐               │
│  │ Secrets Manager  │  │ CloudWatch       │               │
│  │ (10 secrets)     │  │ (Logs + Metrics) │               │
│  └──────────────────┘  └──────────────────┘               │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────┐               │
│  │ ECR              │  │ SNS Topic        │               │
│  │ (Docker images)  │  │ (Email alerts)   │               │
│  └──────────────────┘  └──────────────────┘               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                     │                    │
              ┌──────┴────────┐    ┌─────┴──────┐
              │ CEX WebSocket │    │ Base RPC   │
              │ Feeds         │    │ Provider   │
              │ (Binance,     │    │ (Alchemy)  │
              │  Coinbase,    │    │            │
              │  Bybit)       │    │            │
              └───────────────┘    └────────────┘
```

## File Structure

```
blockhelix/
├── infra/                          # Terraform infrastructure
│   ├── main.tf                     # Provider + backend config
│   ├── variables.tf                # Input variables
│   ├── network.tf                  # VPC, subnet, IGW, route table
│   ├── security-group.tf           # Security group rules
│   ├── ec2.tf                      # EC2 instance, IAM, EBS, EIP
│   ├── secrets.tf                  # Secrets Manager resources
│   ├── cloudwatch.tf               # Log group, alarms, SNS
│   ├── ecr.tf                      # Docker registry
│   ├── outputs.tf                  # Terraform outputs
│   ├── user-data.sh                # EC2 bootstrap script
│   ├── terraform.tfvars.example    # Example variables
│   └── README.md                   # Infrastructure docs
│
├── docker/                         # Docker configuration
│   ├── docker-compose.prod.yml     # Production compose file
│   ├── Dockerfile                  # Multi-stage build
│   └── .dockerignore               # Build exclusions
│
├── .github/workflows/              # CI/CD pipelines
│   ├── ci.yml                      # Lint, test, build
│   └── deploy.yml                  # Deploy to EC2
│
├── scripts/                        # Deployment scripts
│   ├── fetch-secrets.sh            # Fetch from Secrets Manager
│   └── populate-secrets.sh         # Initial secret setup
│
└── docs/                           # Documentation
    ├── DEPLOYMENT.md               # Full deployment guide
    ├── DEPLOYMENT_CHECKLIST.md     # Step-by-step checklist
    ├── runbook.md                  # Operational runbook
    └── WORKLOG.md                  # Development log
```

## Infrastructure Components

### Networking

**VPC**: 10.0.0.0/16
- Public subnet: 10.0.1.0/24
- Internet Gateway for outbound connectivity
- Route table with default route to IGW

**Security Group**: Least-privilege inbound rules
- SSH (22): Restricted to team IPs only
- Grafana (3000): Restricted to team IPs only
- All other inbound: DENY

**Outbound**: Allow HTTPS (443), DNS (53), NTP (123), HTTP (80)

### Compute

**EC2 Instance**: t3.medium (2 vCPU, 4GB RAM)
- OS: Ubuntu 22.04 LTS (Jammy)
- Monitoring: CloudWatch agent for metrics/logs
- Security: fail2ban, unattended-upgrades, IMDSv2
- Time sync: chrony (NTP client)
- User-data: Automated bootstrap script

**IAM Role**: Scoped permissions
- Secrets Manager: Read `dislocation-trader/*` secrets
- CloudWatch: Write logs and metrics
- ECR: Pull Docker images

**Elastic IP**: Stable public address for SSH/Grafana access

### Storage

**EBS Volume**: 50GB gp3
- IOPS: 3000
- Throughput: 125 MB/s
- Encryption: AES-256 at rest
- Mount: `/data/postgres`
- Backup: Daily snapshots (7-day retention)

### Container Registry

**ECR Repository**: `dislocation-trader-production`
- Image scanning: Enabled on push
- Lifecycle policy: Keep 10 most recent images
- Encryption: AES-256 at rest

### Secrets Management

**AWS Secrets Manager** (10 secrets):
1. `postgres-password`: Database password
2. `rpc-base-http`: Base RPC HTTP endpoint
3. `rpc-base-ws`: Base RPC WebSocket endpoint
4. `binance-api-key`: Binance market data key
5. `binance-api-secret`: Binance secret
6. `coinbase-api-key`: Coinbase key
7. `coinbase-api-secret`: Coinbase secret
8. `coinbase-passphrase`: Coinbase passphrase
9. `executor-private-key`: Trading wallet private key
10. `telegram-bot-token`: Alert bot token

**Recovery**: 7-day minimum (30 days for executor key)

### Monitoring & Alerting

**CloudWatch Log Group**: `/aws/ec2/dislocation-trader-production`
- Retention: 30 days
- Streams: syslog, docker logs

**CloudWatch Alarms** (4):
1. CPU > 80% for 5 minutes
2. Memory > 85%
3. Disk > 80%
4. EC2 status check failed

**SNS Topic**: Email notifications for all alarms

### Docker Containers

**App Container**:
- Image: Custom Node.js app (from ECR)
- Resources: 2 CPU, 2GB RAM limit
- Restart: Always
- Health check: HTTP endpoint on port 8080

**Postgres Container**:
- Image: postgres:16-alpine
- Resources: 1.5 CPU, 2GB RAM limit
- Volume: EBS-mounted `/data/postgres`
- Config: Tuned for performance (shared_buffers, work_mem, etc.)
- Restart: Always

**Grafana Container**:
- Image: grafana/grafana:10.2.3
- Resources: 0.5 CPU, 512MB RAM limit
- Port: 3000 (IP-restricted)
- Restart: Always

## CI/CD Pipeline

### CI Workflow (`.github/workflows/ci.yml`)

**Triggers**: Pull requests and pushes to main/develop

**Jobs**:
1. Lint and Typecheck
   - ESLint
   - TypeScript compiler check
2. Test
   - Unit tests
   - Integration tests (with Postgres service)
3. Build
   - Docker image build (no push)

**Duration**: ~5-7 minutes

### Deploy Workflow (`.github/workflows/deploy.yml`)

**Triggers**:
- Push to main (automatic)
- Manual workflow dispatch

**Jobs**:
1. Build and Push
   - Build Docker image
   - Tag with commit SHA and `latest`
   - Push to ECR
2. Deploy
   - SSH to EC2
   - Fetch secrets from Secrets Manager
   - Login to ECR
   - Pull new image
   - Restart containers via docker-compose
   - Run database migrations
   - Health check Grafana

**Duration**: ~8-10 minutes

**Rollback**: Deploy previous commit SHA

## Security Features

### Network Security
- Security Groups: IP-whitelisted inbound only
- No public database access (Postgres bound to 127.0.0.1)
- IMDSv2 required (prevents SSRF attacks)

### Application Security
- Containers run as non-root user (UID 1001)
- Secrets never in code/images (fetched at runtime)
- Docker socket not exposed
- Resource limits prevent DoS

### System Security
- fail2ban: SSH brute-force protection
- unattended-upgrades: Automatic security patches
- chrony: Time synchronization (critical for trading)
- SSH key-based auth only (no passwords)

### Data Security
- EBS encryption at rest (AES-256)
- ECR encryption at rest (AES-256)
- Secrets Manager encryption at rest (AWS KMS)
- TLS for all external connections (HTTPS, WSS)

## Cost Estimate

**Monthly AWS Costs** (us-east-1, approximate):

| Service | Configuration | Cost/Month |
|---------|--------------|------------|
| EC2 (t3.medium) | On-Demand, 24/7 | $30 |
| EBS (50GB gp3) | 3000 IOPS, 125MB/s | $5 |
| EBS Snapshots | 50GB × 7 days | $3 |
| Elastic IP | Associated | $0 |
| ECR | 10GB storage | $1 |
| Secrets Manager | 10 secrets | $4 |
| CloudWatch | Logs + Metrics | $10 |
| Data Transfer | 100GB/month | $9 |
| **Total** | | **~$62/month** |

**Additional Costs** (external):
- RPC provider (Alchemy/QuickNode): $50-200/month
- CEX API (Binance/Coinbase): Free (market data only)
- **Total with RPC**: **$112-262/month**

**Cost Optimization**:
- Use Reserved Instance: Save ~40% on EC2 ($18/month)
- Use Savings Plan: Save ~30-40% on EC2
- Enable EBS snapshots lifecycle: Reduce snapshot costs

## Backup Strategy

### Automated Backups

**EBS Snapshots**:
- Frequency: Daily at 02:00 UTC
- Retention: 7 days
- Automation: AWS Data Lifecycle Manager (DLM)
- Recovery: Point-in-time restore

### Manual Backups

**Database Backup**:
```bash
docker exec dislocation-postgres pg_dump -U trader -d dislocation_trader -F c -f /tmp/backup.dump
docker cp dislocation-postgres:/tmp/backup.dump ./backup-$(date +%Y%m%d).dump
```

**EBS Snapshot**:
```bash
aws ec2 create-snapshot --volume-id <VOLUME_ID> --description "Manual snapshot"
```

### Disaster Recovery

**RTO** (Recovery Time Objective): 30 minutes
- Provision new EC2 via Terraform
- Restore EBS from snapshot
- Deploy application

**RPO** (Recovery Point Objective): 24 hours
- Last daily EBS snapshot
- Consider more frequent snapshots for production

## Scaling Considerations

### Vertical Scaling (Current MVP)

**Scale Up**:
```hcl
# infra/terraform.tfvars
instance_type = "t3.large"  # 2 vCPU, 8GB RAM
ebs_volume_size = 100       # Double storage
```

**Apply**: `terraform apply` (requires instance stop/start)

### Horizontal Scaling (Future)

For future scale-out:
1. Move Postgres to RDS (managed, multi-AZ)
2. Deploy multiple app instances behind ALB
3. Use Redis for distributed state/cache
4. Shard quote collection by venue
5. Use SQS for opportunity queue

## Operational Procedures

### Start/Stop

**Start All Services**:
```bash
cd /home/ubuntu/app
source scripts/fetch-secrets.sh export
docker-compose -f docker/docker-compose.prod.yml up -d
```

**Stop All Services**:
```bash
docker-compose -f docker/docker-compose.prod.yml down
```

**Restart Single Service**:
```bash
docker-compose -f docker/docker-compose.prod.yml restart app
```

### Deployment

**Automated** (via GitHub Actions):
- Push to main branch triggers deploy workflow
- Manual approval gate for production

**Manual**:
```bash
aws ecr get-login-password | docker login --username AWS --password-stdin <ECR_URL>
docker-compose -f docker/docker-compose.prod.yml pull
docker-compose -f docker/docker-compose.prod.yml up -d
docker exec dislocation-trader-app npm run db:migrate
```

### Monitoring

**Grafana Dashboards**:
- Overview: System health, connector status
- Spreads: CEX/DEX price comparison
- Executions: Trade history, PnL

**CloudWatch Logs**:
```bash
aws logs tail /aws/ec2/dislocation-trader-production --follow
```

**Container Logs**:
```bash
docker logs -f dislocation-trader-app
```

### Troubleshooting

**Common Issues**:
1. CEX connector disconnected → Check API keys, restart app
2. High CPU → Check for quote processing loops, scale up
3. Disk full → Delete old quotes, increase EBS volume
4. Cannot SSH → Check Security Group IPs, verify key

**Emergency Stop**:
```bash
docker-compose -f docker/docker-compose.prod.yml down
# or
PAPER_MODE=true  # Disable live trading
```

## Next Steps

### Immediate (Pre-Deployment)
1. Review and customize `infra/terraform.tfvars`
2. Obtain RPC provider credentials
3. Create CEX API keys
4. Generate executor wallet
5. Follow `docs/DEPLOYMENT.md` step-by-step

### Post-Deployment (24-48 hours)
1. Monitor quote collection in Grafana
2. Verify opportunity detection (paper mode)
3. Review cost estimates vs. actual
4. Tune detection thresholds if needed
5. Document any deployment quirks

### Production Readiness (Before Live Trading)
1. Run paper mode for 24-48 hours minimum
2. Validate opportunity quality (not noise)
3. Verify cost models (gas, slippage)
4. Set up Telegram alerts
5. Enable `PAPER_MODE=false`
6. Monitor first 10 trades closely

## Documentation

| Document | Purpose |
|----------|---------|
| `docs/DEPLOYMENT.md` | Complete deployment guide |
| `docs/DEPLOYMENT_CHECKLIST.md` | Step-by-step checklist |
| `docs/runbook.md` | Operational procedures |
| `infra/README.md` | Infrastructure details |
| `docs/WORKLOG.md` | Development history |

## Support

**Primary Contact**: DevOps Team
**Communication**: Slack `#dislocation-trader-ops`

**Escalation Path**:
1. DevOps Engineer (on-call)
2. Engineering Lead
3. CTO

**Emergency Procedures**: See `docs/runbook.md` → Incident Response

---

**Document Version**: 1.0
**Last Updated**: 2026-01-20
**Status**: Ready for deployment
