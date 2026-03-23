#!/bin/bash
set -e

SRC_REGION="ap-southeast-1"
DST_REGION="eu-west-1"
PROJECT="dislocation-trader"

SECRETS=(
  "postgres-password"
  "binance-api-key"
  "binance-api-secret"
  "coinbase-api-key"
  "coinbase-api-secret"
  "coinbase-passphrase"
  "hyperliquid-private-key"
  "polymarket-private-key"
  "polymarket-api-key"
  "polymarket-api-secret"
  "polymarket-passphrase"
  "telegram-bot-token"
  "telegram-chat-id"
)

echo "Copying secrets from $SRC_REGION to $DST_REGION..."

for secret in "${SECRETS[@]}"; do
  full_name="$PROJECT/$secret"
  echo -n "  $full_name... "

  value=$(aws secretsmanager get-secret-value \
    --region "$SRC_REGION" \
    --secret-id "$full_name" \
    --query 'SecretString' \
    --output text 2>/dev/null || echo "")

  if [ -z "$value" ]; then
    echo "SKIP (not found in source)"
    continue
  fi

  # Try create, if exists then update
  if aws secretsmanager create-secret \
    --region "$DST_REGION" \
    --name "$full_name" \
    --secret-string "$value" \
    --no-cli-pager 2>/dev/null; then
    echo "CREATED"
  else
    aws secretsmanager put-secret-value \
      --region "$DST_REGION" \
      --secret-id "$full_name" \
      --secret-string "$value" \
      --no-cli-pager >/dev/null 2>&1
    echo "UPDATED"
  fi
done

echo "Done."
