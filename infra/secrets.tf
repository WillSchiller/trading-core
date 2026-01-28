resource "aws_secretsmanager_secret" "postgres_password" {
  name        = "${var.project_name}/postgres-password"
  description = "PostgreSQL database password"

  recovery_window_in_days = 7

  tags = {
    Name = "${var.project_name}-postgres-password"
  }
}

resource "aws_secretsmanager_secret" "rpc_base_http" {
  name        = "${var.project_name}/rpc-base-http"
  description = "Base chain RPC HTTP endpoint (contains API key)"

  recovery_window_in_days = 7

  tags = {
    Name = "${var.project_name}-rpc-base-http"
  }
}

resource "aws_secretsmanager_secret" "rpc_base_ws" {
  name        = "${var.project_name}/rpc-base-ws"
  description = "Base chain RPC WebSocket endpoint (contains API key)"

  recovery_window_in_days = 7

  tags = {
    Name = "${var.project_name}-rpc-base-ws"
  }
}

resource "aws_secretsmanager_secret" "rpc_mainnet_http" {
  name        = "${var.project_name}/rpc-mainnet-http"
  description = "Ethereum mainnet RPC HTTP endpoint (contains API key)"

  recovery_window_in_days = 7

  tags = {
    Name = "${var.project_name}-rpc-mainnet-http"
  }
}

resource "aws_secretsmanager_secret" "rpc_mainnet_ws" {
  name        = "${var.project_name}/rpc-mainnet-ws"
  description = "Ethereum mainnet RPC WebSocket endpoint (contains API key)"

  recovery_window_in_days = 7

  tags = {
    Name = "${var.project_name}-rpc-mainnet-ws"
  }
}

resource "aws_secretsmanager_secret" "binance_api_key" {
  name        = "${var.project_name}/binance-api-key"
  description = "Binance API key for market data"

  recovery_window_in_days = 7

  tags = {
    Name = "${var.project_name}-binance-api-key"
  }
}

resource "aws_secretsmanager_secret" "binance_api_secret" {
  name        = "${var.project_name}/binance-api-secret"
  description = "Binance API secret for market data"

  recovery_window_in_days = 7

  tags = {
    Name = "${var.project_name}-binance-api-secret"
  }
}

resource "aws_secretsmanager_secret" "coinbase_api_key" {
  name        = "${var.project_name}/coinbase-api-key"
  description = "Coinbase API key for market data"

  recovery_window_in_days = 7

  tags = {
    Name = "${var.project_name}-coinbase-api-key"
  }
}

resource "aws_secretsmanager_secret" "coinbase_api_secret" {
  name        = "${var.project_name}/coinbase-api-secret"
  description = "Coinbase API secret for market data"

  recovery_window_in_days = 7

  tags = {
    Name = "${var.project_name}-coinbase-api-secret"
  }
}

resource "aws_secretsmanager_secret" "coinbase_passphrase" {
  name        = "${var.project_name}/coinbase-passphrase"
  description = "Coinbase API passphrase"

  recovery_window_in_days = 7

  tags = {
    Name = "${var.project_name}-coinbase-passphrase"
  }
}

resource "aws_secretsmanager_secret" "executor_private_key" {
  name        = "${var.project_name}/executor-private-key"
  description = "Private key for trade execution (HIGH SENSITIVITY)"

  recovery_window_in_days = 30

  tags = {
    Name      = "${var.project_name}-executor-private-key"
    Sensitive = "true"
  }
}

resource "aws_secretsmanager_secret" "telegram_bot_token" {
  name        = "${var.project_name}/telegram-bot-token"
  description = "Telegram bot token for alerts"

  recovery_window_in_days = 7

  tags = {
    Name = "${var.project_name}-telegram-bot-token"
  }
}

resource "aws_secretsmanager_secret" "telegram_chat_id" {
  name        = "${var.project_name}/telegram-chat-id"
  description = "Telegram chat ID for alerts"

  recovery_window_in_days = 7

  tags = {
    Name = "${var.project_name}-telegram-chat-id"
  }
}
