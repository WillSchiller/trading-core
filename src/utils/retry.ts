import { logger } from './logger.js';

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterPercent: number;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterPercent: 20,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  context?: Record<string, unknown>
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY, ...config };
  let lastError: Error = new Error('No attempts made');

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt === cfg.maxAttempts) break;

      const baseDelay = Math.min(
        cfg.baseDelayMs * Math.pow(cfg.backoffMultiplier, attempt - 1),
        cfg.maxDelayMs
      );
      const jitter = baseDelay * (cfg.jitterPercent / 100) * (Math.random() - 0.5) * 2;
      const delay = Math.round(baseDelay + jitter);

      logger.warn(
        {
          attempt,
          maxAttempts: cfg.maxAttempts,
          nextDelayMs: delay,
          error: lastError.message,
          ...context,
        },
        'Retry scheduled'
      );

      await sleep(delay);
    }
  }

  throw lastError;
}
