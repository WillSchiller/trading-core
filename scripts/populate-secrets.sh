#!/bin/bash
set -e

REGION="${AWS_REGION:-us-east-1}"
PROJECT="${PROJECT_NAME:-dislocation-trader}"

echo "==================================="
echo "AWS Secrets Manager Setup"
echo "==================================="
echo ""
echo "This script will populate secrets in AWS Secrets Manager."
echo "You will be prompted for each secret value."
echo ""
echo "Region: $REGION"
echo "Project: $PROJECT"
echo ""

read -p "Continue? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

populate_secret() {
  local name=$1
  local prompt=$2
  local hide=${3:-false}

  echo ""
  echo "---"
  if [ "$hide" = "true" ]; then
    read -sp "$prompt: " value
    echo
  else
    read -p "$prompt: " value
  fi

  if [ -z "$value" ]; then
    echo "⚠️  Skipping empty value for $name"
    return
  fi

  aws secretsmanager put-secret-value \
    --region "$REGION" \
    --secret-id "$PROJECT/$name" \
    --secret-string "$value" \
    > /dev/null

  echo "✓ Populated $name"
}

echo ""
echo "=== Database ==="
populate_secret "postgres-password" "PostgreSQL password (generate strong password)" true

echo ""
echo "=== RPC Providers ==="
populate_secret "rpc-base-http" "Base RPC HTTP URL (e.g., https://base-mainnet.g.alchemy.com/v2/KEY)"
populate_secret "rpc-base-ws" "Base RPC WebSocket URL (e.g., wss://base-mainnet.g.alchemy.com/v2/KEY)"

echo ""
echo "=== CEX API Keys ==="
populate_secret "binance-api-key" "Binance API key"
populate_secret "binance-api-secret" "Binance API secret" true
populate_secret "coinbase-api-key" "Coinbase API key"
populate_secret "coinbase-api-secret" "Coinbase API secret" true
populate_secret "coinbase-passphrase" "Coinbase passphrase" true

echo ""
echo "=== Execution Wallet ==="
echo "WARNING: This wallet will be used for live trading."
echo "Use a dedicated hot wallet with limited funds only."
populate_secret "executor-private-key" "Executor private key (0x...)" true

echo ""
echo "=== Alerts ==="
populate_secret "telegram-bot-token" "Telegram bot token (from @BotFather)" true

echo ""
echo "==================================="
echo "All secrets populated successfully!"
echo "==================================="
echo ""
echo "Verify secrets:"
echo "  aws secretsmanager list-secrets --region $REGION --filters Key=name,Values=$PROJECT/"
echo ""
echo "Next steps:"
echo "  1. Deploy infrastructure: cd infra && terraform apply"
echo "  2. Deploy application: see docs/DEPLOYMENT.md"
