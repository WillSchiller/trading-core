#!/bin/bash
set -e

cd /home/ubuntu/app

echo "=== Fetching deployment files ==="
mkdir -p docker scripts grafana/provisioning grafana/dashboards sql
aws s3 cp s3://blockhelixasia/deploy/docker-compose.prod.yml docker/docker-compose.prod.yml
aws s3 cp s3://blockhelixasia/deploy/fetch-secrets.sh scripts/fetch-secrets.sh
aws s3 sync s3://blockhelixasia/deploy/grafana/ grafana/ --delete
aws s3 sync s3://blockhelixasia/deploy/sql/ sql/ --delete
chmod +x scripts/*.sh
echo "=== Grafana files ==="
find grafana -type f | head -20
echo "=== SQL files ==="
ls -la sql/

echo "=== Fetching secrets ==="
export AWS_REGION="${AWS_REGION:-ap-southeast-1}"
export PROJECT_NAME="${PROJECT_NAME:-dislocation-trader}"
bash scripts/fetch-secrets.sh export

echo "=== Logging into ECR ==="
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REGISTRY

echo "=== Getting Public IP ==="
PUBLIC_IP=$(curl -s --connect-timeout 5 http://169.254.169.254/latest/meta-data/public-ipv4 || echo "3.1.140.199")
echo "PUBLIC_IP: $PUBLIC_IP"

# Create .env file for docker-compose
cat > .env << EOF
ECR_REPOSITORY_URL=${ECR_REPOSITORY_URL}
IMAGE_TAG=${IMAGE_TAG:-latest}
PUBLIC_IP=${PUBLIC_IP}
GRAFANA_ADMIN_PASSWORD=admin123
TELEGRAM_CHAT_ID=
EOF

# Append secrets
if [ -f .env.secrets ]; then
  cat .env.secrets >> .env
fi

echo "=== Environment file ==="
cat .env | sed 's/=.*/=***REDACTED***/'

echo "=== Current directory ==="
pwd

echo "=== Check .env.secrets ==="
ls -la .env.secrets || echo "No .env.secrets file!"
cat .env.secrets 2>/dev/null | sed 's/=.*/=***/' || echo "Cannot read .env.secrets"

echo "=== Check .env ==="
ls -la .env || echo "No .env file!"
wc -l .env
cat .env | sed 's/=.*/=***/'

echo "=== Stopping existing services ==="
docker-compose --env-file .env -f docker/docker-compose.prod.yml down -v 2>/dev/null || true

echo "=== Preparing postgres data directory ==="
# EBS volume is mounted at /data - ensure postgres directory exists with correct permissions
sudo mkdir -p /data/postgres
sudo chown -R 70:70 /data/postgres
sudo chmod 700 /data/postgres

echo "=== Pulling images ==="
docker-compose --env-file .env -f docker/docker-compose.prod.yml pull

echo "=== Starting postgres first ==="
docker-compose --env-file .env -f docker/docker-compose.prod.yml up -d postgres

echo "=== Waiting for postgres to initialize ==="
for i in {1..30}; do
  if docker exec dislocation-postgres pg_isready -U trader -d dislocation_trader 2>/dev/null; then
    echo "Postgres is ready!"
    break
  fi
  echo "Waiting for postgres... ($i/30)"
  sleep 2
done

echo "=== Postgres logs ==="
docker logs dislocation-postgres 2>&1 | tail -50

echo "=== Starting remaining services (app auto-migrates on startup) ==="
docker-compose --env-file .env -f docker/docker-compose.prod.yml up -d

echo "=== Waiting for services ==="
sleep 10

echo "=== Service status ==="
docker-compose --env-file .env -f docker/docker-compose.prod.yml ps

echo "=== Final container logs (if any errors) ==="
docker logs dislocation-postgres 2>&1 | tail -20 || true
docker logs dislocation-trader-app 2>&1 | tail -20 || true

echo "=== Deployment completed ==="
