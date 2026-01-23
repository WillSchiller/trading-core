#!/bin/bash
set -e

REGION="${AWS_REGION:-us-east-1}"
PROJECT_NAME="${PROJECT_NAME:-dislocation-trader}"

echo "Fetching secrets from AWS Secrets Manager..."

fetch_secret() {
  local secret_name="$1"
  local env_var_name="$2"

  echo "Fetching $secret_name..."
  value=$(aws secretsmanager get-secret-value \
    --region "$REGION" \
    --secret-id "$PROJECT_NAME/$secret_name" \
    --query 'SecretString' \
    --output text 2>/dev/null || echo "")

  if [ -n "$value" ]; then
    export "$env_var_name=$value"
    echo "$env_var_name set from $secret_name"
  else
    echo "Warning: Secret $secret_name not found or empty"
  fi
}

fetch_secret "postgres-password" "POSTGRES_PASSWORD"
fetch_secret "rpc-base-http" "RPC_BASE_HTTP"
fetch_secret "rpc-base-ws" "RPC_BASE_WS"
fetch_secret "binance-api-key" "BINANCE_API_KEY"
fetch_secret "binance-api-secret" "BINANCE_API_SECRET"
fetch_secret "coinbase-api-key" "COINBASE_API_KEY"
fetch_secret "coinbase-api-secret" "COINBASE_API_SECRET"
fetch_secret "coinbase-passphrase" "COINBASE_PASSPHRASE"
fetch_secret "executor-private-key" "EXECUTOR_PRIVATE_KEY"
fetch_secret "telegram-bot-token" "TELEGRAM_BOT_TOKEN"

echo "Secrets fetched successfully"

env | grep -E '^(POSTGRES_PASSWORD|RPC_|BINANCE_|COINBASE_|EXECUTOR_|TELEGRAM_)' | sed 's/=.*/=***REDACTED***/'

if [ "$1" = "export" ]; then
  echo "Exporting secrets to .env file..."
  cat > /home/ubuntu/app/.env.secrets <<EOF
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
RPC_BASE_HTTP=$RPC_BASE_HTTP
RPC_BASE_WS=$RPC_BASE_WS
BINANCE_API_KEY=$BINANCE_API_KEY
BINANCE_API_SECRET=$BINANCE_API_SECRET
COINBASE_API_KEY=$COINBASE_API_KEY
COINBASE_API_SECRET=$COINBASE_API_SECRET
COINBASE_PASSPHRASE=$COINBASE_PASSPHRASE
EXECUTOR_PRIVATE_KEY=$EXECUTOR_PRIVATE_KEY
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
EOF
  chmod 600 /home/ubuntu/app/.env.secrets
  echo "Secrets exported to .env.secrets"
fi
