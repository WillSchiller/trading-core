#!/bin/bash
set -e

cd /home/ubuntu/app

echo "=== Fetching deployment files ==="
mkdir -p docker scripts grafana
aws s3 cp s3://blockhelixasia/deploy/docker-compose.prod.yml docker/docker-compose.prod.yml
aws s3 cp s3://blockhelixasia/deploy/fetch-secrets.sh scripts/fetch-secrets.sh
chmod +x scripts/*.sh

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

echo "=== Pulling images ==="
docker-compose --env-file .env -f docker/docker-compose.prod.yml pull

echo "=== Starting services ==="
docker-compose --env-file .env -f docker/docker-compose.prod.yml up -d

echo "=== Waiting for services ==="
sleep 10

echo "=== Running migrations ==="
docker exec dislocation-trader-app npm run db:migrate 2>/dev/null || echo "Migration skipped"

echo "=== Service status ==="
docker-compose --env-file .env -f docker/docker-compose.prod.yml ps

echo "=== Deployment completed ==="
