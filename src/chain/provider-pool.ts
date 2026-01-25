import { createPublicClient, http, webSocket, type PublicClient, type Chain as ViemChain } from 'viem';
import { base, mainnet } from 'viem/chains';
import { createChildLogger, type Logger } from '../utils/logger.js';
import type { Chain } from '../types/index.js';

export interface RpcEndpoint {
  name: string;
  httpUrl: string;
  wsUrl?: string;
  priority: number;
  maxRetriesBeforeFallback: number;
}

export interface ProviderPoolConfig {
  chain: Chain;
  endpoints: RpcEndpoint[];
  healthCheckIntervalMs?: number;
  rateLimitCooldownMs?: number;
}

interface EndpointHealth {
  endpoint: RpcEndpoint;
  isHealthy: boolean;
  consecutiveFailures: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  totalCalls: number;
  totalFailures: number;
  rateLimitedUntil: number | null;
}

export class ProviderPool {
  private logger: Logger;
  private config: Required<ProviderPoolConfig>;
  private viemChain: ViemChain;
  private clients: Map<string, PublicClient>;
  private wsClients: Map<string, PublicClient>;
  private endpointHealth: Map<string, EndpointHealth>;
  private healthCheckTimer: NodeJS.Timeout | null;

  constructor(config: ProviderPoolConfig) {
    this.config = {
      ...config,
      healthCheckIntervalMs: config.healthCheckIntervalMs ?? 60000,
      rateLimitCooldownMs: config.rateLimitCooldownMs ?? 60000,
    };

    this.logger = createChildLogger({
      chain: config.chain,
      component: 'provider-pool'
    });

    this.viemChain = this.getViemChain(config.chain);
    this.clients = new Map();
    this.wsClients = new Map();
    this.endpointHealth = new Map();
    this.healthCheckTimer = null;

    this.initializeEndpoints();
    this.startHealthCheck();
  }

  private getViemChain(chain: Chain): ViemChain {
    switch (chain) {
      case 'base':
        return base;
      case 'mainnet':
        return mainnet;
      default:
        throw new Error(`Unsupported chain: ${chain}`);
    }
  }

  private initializeEndpoints(): void {
    const sortedEndpoints = [...this.config.endpoints].sort((a, b) => a.priority - b.priority);

    for (const endpoint of sortedEndpoints) {
      const httpClient = createPublicClient({
        chain: this.viemChain,
        transport: http(endpoint.httpUrl, {
          retryCount: 2,
          retryDelay: 500,
        }),
      });

      this.clients.set(endpoint.name, httpClient);

      if (endpoint.wsUrl) {
        try {
          const wsClient = createPublicClient({
            chain: this.viemChain,
            transport: webSocket(endpoint.wsUrl, {
              retryCount: 3,
              retryDelay: 1000,
            }),
          });
          this.wsClients.set(endpoint.name, wsClient);
          this.logger.info({ endpoint: endpoint.name }, 'WebSocket client initialized');
        } catch (error) {
          this.logger.warn(
            { endpoint: endpoint.name, error: (error as Error).message },
            'Failed to initialize WebSocket client'
          );
        }
      }

      this.endpointHealth.set(endpoint.name, {
        endpoint,
        isHealthy: true,
        consecutiveFailures: 0,
        lastFailureTime: null,
        lastSuccessTime: null,
        totalCalls: 0,
        totalFailures: 0,
        rateLimitedUntil: null,
      });

      this.logger.info(
        { endpoint: endpoint.name, priority: endpoint.priority },
        'Endpoint initialized'
      );
    }
  }

  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(() => {
      this.checkEndpointHealth();
    }, this.config.healthCheckIntervalMs);
  }

  private async checkEndpointHealth(): Promise<void> {
    const now = Date.now();

    for (const [name, health] of this.endpointHealth.entries()) {
      if (health.rateLimitedUntil && health.rateLimitedUntil > now) {
        continue;
      }

      if (health.rateLimitedUntil && health.rateLimitedUntil <= now) {
        this.logger.info({ endpoint: name }, 'Rate limit cooldown expired, marking healthy');
        health.rateLimitedUntil = null;
        health.isHealthy = true;
        health.consecutiveFailures = 0;
      }

      if (health.consecutiveFailures >= health.endpoint.maxRetriesBeforeFallback) {
        const timeSinceFailure = health.lastFailureTime ? now - health.lastFailureTime : Infinity;
        if (timeSinceFailure > this.config.rateLimitCooldownMs) {
          this.logger.info(
            { endpoint: name, consecutiveFailures: health.consecutiveFailures },
            'Attempting to restore unhealthy endpoint'
          );
          health.isHealthy = true;
          health.consecutiveFailures = 0;
        }
      }
    }
  }

  public getPublicClient(): PublicClient {
    const healthyEndpoints = this.getHealthyEndpoints();

    if (healthyEndpoints.length === 0) {
      this.logger.warn('No healthy endpoints available, using first endpoint');
      const firstEndpoint = this.config.endpoints[0];
      const client = this.clients.get(firstEndpoint.name);
      if (!client) {
        throw new Error('No RPC clients available');
      }
      return client;
    }

    // Always use highest priority (lowest number) healthy endpoint
    const endpoint = healthyEndpoints[0];
    const client = this.clients.get(endpoint.name);
    if (!client) {
      throw new Error(`Client not found for endpoint: ${endpoint.name}`);
    }

    return this.wrapClientWithHealthTracking(client, endpoint.name);
  }

  public getWsPublicClient(): PublicClient | undefined {
    const healthyEndpoints = this.getHealthyEndpoints();

    for (const endpoint of healthyEndpoints) {
      const wsClient = this.wsClients.get(endpoint.name);
      if (wsClient) {
        return this.wrapClientWithHealthTracking(wsClient, endpoint.name);
      }
    }

    this.logger.warn('No healthy WebSocket endpoints available');
    return undefined;
  }

  private getHealthyEndpoints(): RpcEndpoint[] {
    const healthy: RpcEndpoint[] = [];

    for (const health of this.endpointHealth.values()) {
      if (health.isHealthy && !health.rateLimitedUntil) {
        healthy.push(health.endpoint);
      }
    }

    return healthy.sort((a, b) => a.priority - b.priority);
  }

  private wrapClientWithHealthTracking(client: PublicClient, endpointName: string): PublicClient {
    const health = this.endpointHealth.get(endpointName);
    if (!health) {
      return client;
    }

    return new Proxy(client, {
      get: (target, prop) => {
        const original = target[prop as keyof PublicClient];

        if (typeof original === 'function') {
          return async (...args: any[]) => {
            health.totalCalls++;

            try {
              const result = await (original as (...a: unknown[]) => unknown).apply(target, args);
              this.handleSuccess(endpointName);
              return result;
            } catch (error) {
              this.handleError(endpointName, error as Error);
              throw error;
            }
          };
        }

        return original;
      },
    }) as PublicClient;
  }

  private handleSuccess(endpointName: string): void {
    const health = this.endpointHealth.get(endpointName);
    if (!health) return;

    health.lastSuccessTime = Date.now();
    health.consecutiveFailures = 0;

    if (!health.isHealthy) {
      this.logger.info({ endpoint: endpointName }, 'Endpoint recovered');
      health.isHealthy = true;
    }
  }

  private handleError(endpointName: string, error: Error): void {
    const health = this.endpointHealth.get(endpointName);
    if (!health) return;

    health.lastFailureTime = Date.now();
    health.consecutiveFailures++;
    health.totalFailures++;

    const errorMsg = error.message.toLowerCase();

    if (errorMsg.includes('429') || errorMsg.includes('rate limit')) {
      this.logger.warn(
        { endpoint: endpointName, error: error.message },
        'Rate limit detected'
      );
      health.rateLimitedUntil = Date.now() + this.config.rateLimitCooldownMs;
      health.isHealthy = false;
    } else if (errorMsg.includes('timeout') || errorMsg.includes('econnreset')) {
      this.logger.warn(
        { endpoint: endpointName, error: error.message, consecutiveFailures: health.consecutiveFailures },
        'Transient error detected'
      );
    } else {
      this.logger.error(
        { endpoint: endpointName, error: error.message, consecutiveFailures: health.consecutiveFailures },
        'RPC error'
      );
    }

    if (health.consecutiveFailures >= health.endpoint.maxRetriesBeforeFallback) {
      this.logger.error(
        { endpoint: endpointName, consecutiveFailures: health.consecutiveFailures },
        'Endpoint marked unhealthy'
      );
      health.isHealthy = false;
    }
  }

  public getHealthStatus(): Record<string, {
    isHealthy: boolean;
    consecutiveFailures: number;
    totalCalls: number;
    totalFailures: number;
    failureRate: number;
    rateLimitedUntil: number | null;
  }> {
    const status: Record<string, any> = {};

    for (const [name, health] of this.endpointHealth.entries()) {
      status[name] = {
        isHealthy: health.isHealthy,
        consecutiveFailures: health.consecutiveFailures,
        totalCalls: health.totalCalls,
        totalFailures: health.totalFailures,
        failureRate: health.totalCalls > 0 ? health.totalFailures / health.totalCalls : 0,
        rateLimitedUntil: health.rateLimitedUntil,
      };
    }

    return status;
  }

  public async close(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    this.logger.info('Provider pool closed');
  }

  public getViemChainObject(): ViemChain {
    return this.viemChain;
  }
}
