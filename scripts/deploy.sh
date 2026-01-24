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

echo "=== Setting environment ==="
export PUBLIC_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4)

# Load secrets into environment
if [ -f .env.secrets ]; then
  set -a
  source .env.secrets
  set +a
fi

echo "=== Pulling images ==="
docker-compose -f docker/docker-compose.prod.yml pull

echo "=== Starting services ==="
docker-compose -f docker/docker-compose.prod.yml up -d

echo "=== Waiting for services ==="
sleep 10

echo "=== Running migrations ==="
docker exec dislocation-trader-app npm run db:migrate 2>/dev/null || echo "Migration skipped"

echo "=== Service status ==="
docker-compose -f docker/docker-compose.prod.yml ps

echo "=== Deployment completed ==="
