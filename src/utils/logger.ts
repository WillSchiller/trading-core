import { pino, type Logger as PinoLogger } from 'pino';

const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
const NODE_ENV = process.env.NODE_ENV ?? 'development';

export const logger: PinoLogger = pino({
  level: LOG_LEVEL,
  ...(NODE_ENV === 'development' && {
    formatters: {
      level: (label: string) => ({ level: label }),
    },
  }),
  base: {
    pid: process.pid,
    service: 'dislocation-trader',
  },
  redact: {
    paths: [
      'password',
      'secret',
      'apiKey',
      'apiSecret',
      'privateKey',
      'POSTGRES_PASSWORD',
      'BINANCE_API_SECRET',
      'COINBASE_API_SECRET',
      'EXECUTOR_PRIVATE_KEY',
      'BINANCE_FUTURES_API_SECRET',
    ],
    censor: '[REDACTED]',
  },
});

export function createChildLogger(context: Record<string, unknown>): PinoLogger {
  return logger.child(context);
}

export type Logger = PinoLogger;
