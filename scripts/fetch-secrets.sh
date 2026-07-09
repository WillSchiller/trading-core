#!/bin/bash
set -e

REGION="${AWS_REGION:-eu-west-1}"
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

  if [ -n "$value" ] && [ "$value" != "{}" ]; then
    export "$env_var_name=$value"
    echo "$env_var_name set from $secret_name ($(echo -n "$value" | wc -c | tr -d ' ') chars)"
  else
    export "$env_var_name="
    echo "WARNING: $secret_name not found, empty, or placeholder"
  fi
}

fetch_secret_optional() {
  local secret_name="$1"
  local env_var_name="$2"

  value=$(aws secretsmanager get-secret-value \
    --region "$REGION" \
    --secret-id "$PROJECT_NAME/$secret_name" \
    --query 'SecretString' \
    --output text 2>/dev/null || echo "")

  if [ -n "$value" ] && [ "$value" != "{}" ]; then
    export "$env_var_name=$value"
    echo "$env_var_name set from $secret_name ($(echo -n "$value" | wc -c | tr -d ' ') chars)"
  else
    export "$env_var_name="
  fi
}

fetch_secret "postgres-password" "POSTGRES_PASSWORD"
# RPC secrets not needed in observatory mode (no chain providers)
# fetch_secret "rpc-base-http" "RPC_BASE_HTTP"
# fetch_secret "rpc-base-ws" "RPC_BASE_WS"
# fetch_secret "rpc-mainnet-http" "RPC_MAINNET_HTTP"
# fetch_secret "rpc-mainnet-ws" "RPC_MAINNET_WS"
fetch_secret "binance-api-key" "BINANCE_API_KEY"
fetch_secret "binance-api-secret" "BINANCE_API_SECRET"
fetch_secret_optional "binance-futures-api-key" "BINANCE_FUTURES_API_KEY"
fetch_secret_optional "binance-futures-api-secret" "BINANCE_FUTURES_API_SECRET"
fetch_secret "coinbase-api-key" "COINBASE_API_KEY"
fetch_secret "coinbase-api-secret" "COINBASE_API_SECRET"
fetch_secret "coinbase-passphrase" "COINBASE_PASSPHRASE"
# Executor key not needed in observatory mode
# fetch_secret "executor-private-key" "EXECUTOR_PRIVATE_KEY"
fetch_secret_optional "hyperliquid-private-key" "HYPERLIQUID_PRIVATE_KEY"
fetch_secret_optional "polymarket-private-key" "POLYMARKET_PRIVATE_KEY"
fetch_secret_optional "polymarket-api-key" "POLYMARKET_API_KEY"
fetch_secret_optional "polymarket-api-secret" "POLYMARKET_API_SECRET"
fetch_secret_optional "polymarket-passphrase" "POLYMARKET_PASSPHRASE"
fetch_secret "telegram-bot-token" "TELEGRAM_BOT_TOKEN"
fetch_secret "telegram-chat-id" "TELEGRAM_CHAT_ID"
fetch_secret "grafana-admin-password" "GRAFANA_ADMIN_PASSWORD"

echo "Secrets fetched successfully"

env | grep -E '^(POSTGRES_PASSWORD|RPC_|BINANCE_|COINBASE_|EXECUTOR_|TELEGRAM_|HYPERLIQUID_|POLYMARKET_)' | sed 's/=.*/=***REDACTED***/'

if [ "$1" = "export" ]; then
  echo "Exporting secrets to .env file..."
  cat > /home/ubuntu/app/.env.secrets <<EOF
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
BINANCE_API_KEY=$BINANCE_API_KEY
BINANCE_API_SECRET=$BINANCE_API_SECRET
BINANCE_FUTURES_API_KEY=$BINANCE_FUTURES_API_KEY
BINANCE_FUTURES_API_SECRET=$BINANCE_FUTURES_API_SECRET
COINBASE_API_KEY=$COINBASE_API_KEY
COINBASE_API_SECRET=$COINBASE_API_SECRET
COINBASE_PASSPHRASE=$COINBASE_PASSPHRASE
HYPERLIQUID_PRIVATE_KEY=$HYPERLIQUID_PRIVATE_KEY
POLYMARKET_PRIVATE_KEY=$POLYMARKET_PRIVATE_KEY
POLYMARKET_API_KEY=$POLYMARKET_API_KEY
POLYMARKET_API_SECRET=$POLYMARKET_API_SECRET
POLYMARKET_PASSPHRASE=$POLYMARKET_PASSPHRASE
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID=$TELEGRAM_CHAT_ID
GRAFANA_ADMIN_PASSWORD=$GRAFANA_ADMIN_PASSWORD
ALERTS_ENABLED=true
EOF
  chmod 600 /home/ubuntu/app/.env.secrets
  echo "Secrets exported to .env.secrets"
fi
