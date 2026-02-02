import { createChildLogger } from './logger.js';

const logger = createChildLogger({ component: 'alerts' });

export type AlertLevel = 'info' | 'warn' | 'critical';

export interface AlertConfig {
  telegramBotToken?: string;
  telegramChatId?: string;
  enabled: boolean;
}

let alertConfig: AlertConfig = {
  enabled: false,
};

export function initAlerts(config: AlertConfig): void {
  alertConfig = config;
  logger.info({ enabled: config.enabled, hasTelegram: !!config.telegramBotToken }, 'Alerts initialized');
}

export async function sendAlert(message: string, level: AlertLevel = 'info'): Promise<void> {
  const emoji = { info: 'info', warn: 'warning', critical: 'alert' }[level];
  const prefix = `[${emoji.toUpperCase()}]`;

  logger.info({ level, message }, `Alert: ${prefix} ${message}`);

  if (!alertConfig.enabled || !alertConfig.telegramBotToken || !alertConfig.telegramChatId) {
    return;
  }

  const escaped = message.replace(/_/g, '\\_');
  const text = `${prefix}\n\n${escaped}`;

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${alertConfig.telegramBotToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: alertConfig.telegramChatId,
          text,
          parse_mode: 'Markdown',
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({ status: response.status, error: errorText }, 'Telegram alert failed');
    }
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to send Telegram alert');
  }
}

export async function alertSystemHalt(reason: string): Promise<void> {
  await sendAlert(`*SYSTEM HALTED*\n\nReason: ${reason}\n\nManual intervention required.`, 'critical');
}

export async function alertInsufficientBalance(chain: string, balance: string, required: string): Promise<void> {
  await sendAlert(
    `*INSUFFICIENT BALANCE*\n\nChain: ${chain}\nBalance: ${balance}\nRequired: ${required}`,
    'critical'
  );
}

export async function alertConsecutiveReverts(chain: string, count: number): Promise<void> {
  await sendAlert(
    `*CONSECUTIVE REVERTS*\n\nChain: ${chain}\nCount: ${count}\n\nSystem will halt if threshold reached.`,
    'warn'
  );
}

export async function alertExecutionFailure(
  chain: string,
  opportunityId: string,
  error: string
): Promise<void> {
  await sendAlert(
    `*EXECUTION FAILURE*\n\nChain: ${chain}\nOpportunity: ${opportunityId}\nError: ${error}`,
    'warn'
  );
}

export async function alertConnectorDown(venue: string, durationMs: number): Promise<void> {
  if (durationMs > 60000) {
    await sendAlert(
      `*CONNECTOR DOWN*\n\nVenue: ${venue}\nDuration: ${Math.round(durationMs / 1000)}s`,
      'warn'
    );
  }
}

export async function alertTradeProfit(
  pair: string,
  direction: string,
  pnlUsd: number,
  spreadBps: number
): Promise<void> {
  const emoji = pnlUsd >= 0 ? '💰' : '📉';
  const sign = pnlUsd >= 0 ? '+' : '';
  await sendAlert(
    `${emoji} *TRADE COMPLETED*\n\nPair: ${pair}\nDirection: ${direction}\nP&L: ${sign}$${pnlUsd.toFixed(2)}\nSpread: ${spreadBps.toFixed(1)} bps`,
    pnlUsd >= 0 ? 'info' : 'warn'
  );
}

export async function alertDailySummary(
  trades: number,
  totalPnl: number,
  winRate: number
): Promise<void> {
  const emoji = totalPnl >= 0 ? '📊' : '⚠️';
  const sign = totalPnl >= 0 ? '+' : '';
  await sendAlert(
    `${emoji} *DAILY SUMMARY*\n\nTrades: ${trades}\nTotal P&L: ${sign}$${totalPnl.toFixed(2)}\nWin Rate: ${(winRate * 100).toFixed(1)}%`,
    'info'
  );
}
