import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { appConfigSchema, envConfigSchema, pairsFileSchema } from './schema.js';
import type { AppConfig, EnvConfig, PairConfig } from './types.js';
export type { ValidationMode } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(__dirname, '../../config');

loadDotenv();

function loadJsonFile<T>(path: string): T {
  const content = readFileSync(path, 'utf-8');
  return JSON.parse(content) as T;
}

function loadEnvConfig(): EnvConfig {
  const raw = {
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
    postgres: {
      host: process.env.POSTGRES_HOST,
      port: process.env.POSTGRES_PORT,
      database: process.env.POSTGRES_DB,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD ?? '',
    },
    rpc: {
      mainnet: {
        drpc: {
          http: process.env.RPC_DRPC_MAINNET_HTTP,
          ws: process.env.RPC_DRPC_MAINNET_WS,
        },
        alchemy: {
          http: process.env.RPC_ALCHEMY_MAINNET_HTTP ?? process.env.RPC_MAINNET_HTTP,
          ws: process.env.RPC_ALCHEMY_MAINNET_WS ?? process.env.RPC_MAINNET_WS,
        },
      },
      base: {
        drpc: {
          http: process.env.RPC_DRPC_BASE_HTTP,
          ws: process.env.RPC_DRPC_BASE_WS,
        },
        alchemy: {
          http: process.env.RPC_ALCHEMY_BASE_HTTP ?? process.env.RPC_BASE_HTTP,
          ws: process.env.RPC_ALCHEMY_BASE_WS ?? process.env.RPC_BASE_WS,
        },
      },
    },
    cex: {
      binanceApiKey: process.env.BINANCE_API_KEY,
      binanceApiSecret: process.env.BINANCE_API_SECRET,
      coinbaseApiKey: process.env.COINBASE_API_KEY,
      coinbaseApiSecret: process.env.COINBASE_API_SECRET,
      coinbasePassphrase: process.env.COINBASE_PASSPHRASE,
      bybitApiKey: process.env.BYBIT_API_KEY,
      bybitApiSecret: process.env.BYBIT_API_SECRET,
    },
    binanceFutures: {
      apiKey: process.env.BINANCE_FUTURES_API_KEY,
      apiSecret: process.env.BINANCE_FUTURES_API_SECRET,
    },
    executorPrivateKey: process.env.EXECUTOR_PRIVATE_KEY,
    paperMode: process.env.PAPER_MODE,
    enableExecution: process.env.ENABLE_EXECUTION,
    enableMainnet: process.env.ENABLE_MAINNET,
    enableBase: process.env.ENABLE_BASE,
    telegram:
      process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
        ? {
            botToken: process.env.TELEGRAM_BOT_TOKEN,
            chatId: process.env.TELEGRAM_CHAT_ID,
          }
        : undefined,
  };

  return envConfigSchema.parse(raw);
}

function loadAppConfig(): AppConfig {
  const defaultConfig = loadJsonFile<Record<string, unknown>>(join(CONFIG_DIR, 'default.json'));
  return appConfigSchema.parse(defaultConfig);
}

function loadPairsConfig(): PairConfig[] {
  const pairsFile = loadJsonFile<{ pairs: unknown[] }>(join(CONFIG_DIR, 'pairs.json'));
  const validated = pairsFileSchema.parse(pairsFile);
  return validated.pairs;
}

let _env: EnvConfig | null = null;
let _app: AppConfig | null = null;
let _pairs: PairConfig[] | null = null;

export function getEnvConfig(): EnvConfig {
  if (!_env) {
    _env = loadEnvConfig();
  }
  return _env;
}

export function getAppConfig(): AppConfig {
  if (!_app) {
    _app = loadAppConfig();
  }
  return _app;
}

export function getPairsConfig(): PairConfig[] {
  if (!_pairs) {
    _pairs = loadPairsConfig();
  }
  return _pairs;
}

export function getConfig() {
  return {
    env: getEnvConfig(),
    app: getAppConfig(),
    pairs: getPairsConfig(),
  };
}

export function reloadConfig() {
  _env = null;
  _app = null;
  _pairs = null;
  return getConfig();
}
