export { PolymarketCopyTrader } from './copy-trader.js';
export { loadPolymarketConfig } from './config.js';
export { PolymarketPersistence } from './persistence.js';
export { TraderDiscovery } from './discovery.js';
export { ActivityMonitor } from './monitor.js';
export { CopyExecutor } from './executor.js';
export { PolymarketRiskManager } from './risk-manager.js';
export type {
  PolymarketConfig,
  PolymarketRiskLimits,
  TrackedTrader,
  TraderActivity,
  CopyTrade,
  CopyPosition,
  KillSwitchEvent,
  MarketInfo,
  LeaderboardEntry,
} from './types.js';
