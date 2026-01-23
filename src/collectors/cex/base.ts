import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { createChildLogger, type Logger } from '../../utils/logger.js';
import type { NormalizedQuote } from '../../types/index.js';

export interface CexConnectorConfig {
  venue: string;
  wsUrl: string;
  pairs: string[];
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectBackoffMultiplier?: number;
  resetAttemptsAfterMs?: number;
}

interface WsReconnectState {
  isConnected: boolean;
  reconnectAttempts: number;
  lastConnectTime: Date | null;
  lastDisconnectTime: Date | null;
  lastError: string | null;
}

export abstract class CexConnector extends EventEmitter {
  protected logger: Logger;
  protected ws: WebSocket | null = null;
  protected config: Required<CexConnectorConfig>;
  protected reconnectState: WsReconnectState;
  protected reconnectTimer: NodeJS.Timeout | null = null;
  protected heartbeatTimer: NodeJS.Timeout | null = null;
  protected heartbeatCheckTimer: NodeJS.Timeout | null = null;
  protected lastHeartbeatReceived: Date | null = null;
  protected isShuttingDown = false;

  constructor(config: CexConnectorConfig) {
    super();
    this.config = {
      ...config,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 30000,
      heartbeatTimeoutMs: config.heartbeatTimeoutMs ?? 10000,
      reconnectInitialDelayMs: config.reconnectInitialDelayMs ?? 1000,
      reconnectMaxDelayMs: config.reconnectMaxDelayMs ?? 60000,
      reconnectBackoffMultiplier: config.reconnectBackoffMultiplier ?? 2,
      resetAttemptsAfterMs: config.resetAttemptsAfterMs ?? 300000,
    };

    this.logger = createChildLogger({ venue: this.config.venue, component: 'cex-connector' });

    this.reconnectState = {
      isConnected: false,
      reconnectAttempts: 0,
      lastConnectTime: null,
      lastDisconnectTime: null,
      lastError: null,
    };
  }

  public async connect(): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.warn('Cannot connect during shutdown');
      return;
    }

    if (this.ws && this.reconnectState.isConnected) {
      this.logger.debug('Already connected');
      return;
    }

    try {
      const url = this.buildWsUrl();
      this.logger.info({ url }, 'Connecting to WebSocket');

      this.ws = new WebSocket(url);

      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data: WebSocket.Data) => this.handleMessage(data));
      this.ws.on('error', (error: Error) => this.handleError(error));
      this.ws.on('close', (code: number, reason: Buffer) => this.handleClose(code, reason));
      this.ws.on('ping', () => this.handlePing());
      this.ws.on('pong', () => this.handlePong());
    } catch (error) {
      this.logger.error({ error: (error as Error).message }, 'Failed to create WebSocket');
      this.reconnectState.lastError = (error as Error).message;
      this.scheduleReconnect();
    }
  }

  public async disconnect(): Promise<void> {
    this.logger.info('Disconnecting');
    this.isShuttingDown = true;

    this.clearTimers();

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.reconnectState.isConnected = false;
    this.emit('disconnected', { venue: this.config.venue, planned: true });
  }

  public isConnected(): boolean {
    return this.reconnectState.isConnected;
  }

  public getReconnectState(): WsReconnectState {
    return { ...this.reconnectState };
  }

  protected abstract buildWsUrl(): string;
  protected abstract subscribe(): void;
  protected abstract parseMessage(data: WebSocket.Data): NormalizedQuote | null;
  protected abstract sendHeartbeat(): void;

  protected handleOpen(): void {
    this.logger.info('WebSocket connected');

    this.reconnectState.isConnected = true;
    this.reconnectState.lastConnectTime = new Date();
    this.reconnectState.lastError = null;

    if (
      this.reconnectState.lastConnectTime &&
      this.reconnectState.lastDisconnectTime &&
      this.reconnectState.lastConnectTime.getTime() - this.reconnectState.lastDisconnectTime.getTime() >
        this.config.resetAttemptsAfterMs
    ) {
      this.logger.info('Connection stable, resetting reconnect attempts');
      this.reconnectState.reconnectAttempts = 0;
    }

    this.emit('connected', { venue: this.config.venue });

    this.subscribe();
    this.startHeartbeat();
  }

  protected handleMessage(data: WebSocket.Data): void {
    try {
      const quote = this.parseMessage(data);
      if (quote) {
        this.emit('quote', quote);
      }
    } catch (error) {
      this.logger.error(
        { error: (error as Error).message, data: data.toString().slice(0, 200) },
        'Failed to parse message'
      );
    }
  }

  protected handleError(error: Error): void {
    this.logger.error({ error: error.message }, 'WebSocket error');
    this.reconnectState.lastError = error.message;
    this.emit('error', { venue: this.config.venue, error: error.message });
  }

  protected handleClose(code: number, reason: Buffer): void {
    const reasonStr = reason.toString() || 'unknown';
    this.logger.warn({ code, reason: reasonStr }, 'WebSocket closed');

    this.reconnectState.isConnected = false;
    this.reconnectState.lastDisconnectTime = new Date();

    this.clearTimers();
    this.emit('disconnected', { venue: this.config.venue, planned: false, code, reason: reasonStr });

    if (!this.isShuttingDown) {
      this.scheduleReconnect();
    }
  }

  protected handlePing(): void {
    this.lastHeartbeatReceived = new Date();
  }

  protected handlePong(): void {
    this.lastHeartbeatReceived = new Date();
  }

  protected startHeartbeat(): void {
    this.clearHeartbeatTimers();

    this.lastHeartbeatReceived = new Date();

    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.reconnectState.isConnected) {
        this.sendHeartbeat();
      }
    }, this.config.heartbeatIntervalMs);

    this.heartbeatCheckTimer = setInterval(() => {
      if (!this.lastHeartbeatReceived) return;

      const timeSinceLastHeartbeat = Date.now() - this.lastHeartbeatReceived.getTime();

      if (timeSinceLastHeartbeat > this.config.heartbeatTimeoutMs) {
        this.logger.warn(
          { timeSinceLastHeartbeat },
          'Heartbeat timeout exceeded, forcing reconnect'
        );
        this.forceReconnect();
      }
    }, this.config.heartbeatTimeoutMs);
  }

  protected forceReconnect(): void {
    this.logger.info('Forcing reconnect');
    if (this.ws) {
      this.ws.terminate();
    }
  }

  protected scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectState.reconnectAttempts++;

    const baseDelay = Math.min(
      this.config.reconnectInitialDelayMs *
        Math.pow(this.config.reconnectBackoffMultiplier, this.reconnectState.reconnectAttempts - 1),
      this.config.reconnectMaxDelayMs
    );

    const jitter = baseDelay * 0.2 * (Math.random() - 0.5) * 2;
    const delay = Math.round(baseDelay + jitter);

    this.logger.info(
      {
        attempt: this.reconnectState.reconnectAttempts,
        delayMs: delay,
      },
      'Scheduling reconnect'
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  protected clearTimers(): void {
    this.clearHeartbeatTimers();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  protected clearHeartbeatTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.heartbeatCheckTimer) {
      clearInterval(this.heartbeatCheckTimer);
      this.heartbeatCheckTimer = null;
    }
  }

  protected normalizeSymbol(symbol: string): string {
    const upper = symbol.toUpperCase();
    if (upper === 'ETHUSDC' || upper === 'ETH-USDC') return 'WETH/USDC';
    if (upper === 'ETHUSD' || upper === 'ETH-USD') return 'WETH/USDC';
    if (upper === 'CBETHETH' || upper === 'CBETH-ETH') return 'cbETH/WETH';
    return symbol;
  }
}
