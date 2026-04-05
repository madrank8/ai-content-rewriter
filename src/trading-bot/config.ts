/**
 * Default configuration and environment loader for the trading bot
 */

import type { BotConfig, TradingConfig, RiskLimits } from './types.js';

export const DEFAULT_TRADING_CONFIG: TradingConfig = {
  maxPositionSize: 500,
  totalBudget: 10_000,
  minEdgePercent: 2.0,
  kellyFraction: 0.25, // Quarter Kelly - conservative
  maxConcurrentPositions: 20,
  minLiquidityDepth: 100,
  maxMarketExposurePercent: 5,
  scanIntervalMs: 30_000, // 30 seconds
  dryRun: true, // Safe by default
};

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxDailyLoss: 500,
  maxDailyTrades: 100,
  maxSingleLoss: 200,
  maxCorrelatedExposure: 2000,
  stopTradingDrawdownPercent: 10,
};

export const POLYMARKET_CLOB_URL = 'https://clob.polymarket.com';
export const POLYMARKET_GAMMA_URL = 'https://gamma-api.polymarket.com';
export const ODDS_API_URL = 'https://api.the-odds-api.com/v4';

/** Sports keys supported for cross-platform arbitrage */
export const SUPPORTED_SPORTS = [
  'americanfootball_nfl',
  'americanfootball_ncaaf',
  'basketball_nba',
  'basketball_ncaab',
  'baseball_mlb',
  'icehockey_nhl',
  'soccer_epl',
  'soccer_usa_mls',
  'mma_mixed_martial_arts',
] as const;

export type SupportedSport = (typeof SUPPORTED_SPORTS)[number];

/**
 * Load configuration from environment variables
 */
export function loadConfigFromEnv(overrides?: Partial<BotConfig>): BotConfig {
  const config: BotConfig = {
    polymarket: {
      apiKey: requireEnv('POLYMARKET_API_KEY'),
      apiSecret: requireEnv('POLYMARKET_API_SECRET'),
      apiPassphrase: requireEnv('POLYMARKET_API_PASSPHRASE'),
      privateKey: requireEnv('POLYMARKET_PRIVATE_KEY'),
      clobUrl: process.env['POLYMARKET_CLOB_URL'] ?? POLYMARKET_CLOB_URL,
      gammaUrl: process.env['POLYMARKET_GAMMA_URL'] ?? POLYMARKET_GAMMA_URL,
    },
    oddsApiKey: requireEnv('ODDS_API_KEY'),
    anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
    claudeModel: process.env['CLAUDE_MODEL'] ?? 'claude-sonnet-4-6',
    trading: {
      ...DEFAULT_TRADING_CONFIG,
      ...(overrides?.trading ?? {}),
    },
    logLevel: (process.env['LOG_LEVEL'] as BotConfig['logLevel']) ?? 'info',
  };

  // Allow env overrides for trading params
  if (process.env['MAX_POSITION_SIZE']) {
    config.trading.maxPositionSize = Number(process.env['MAX_POSITION_SIZE']);
  }
  if (process.env['TOTAL_BUDGET']) {
    config.trading.totalBudget = Number(process.env['TOTAL_BUDGET']);
  }
  if (process.env['MIN_EDGE_PERCENT']) {
    config.trading.minEdgePercent = Number(process.env['MIN_EDGE_PERCENT']);
  }
  if (process.env['KELLY_FRACTION']) {
    config.trading.kellyFraction = Number(process.env['KELLY_FRACTION']);
  }
  if (process.env['DRY_RUN'] === 'false') {
    config.trading.dryRun = false;
  }
  if (process.env['SCAN_INTERVAL_MS']) {
    config.trading.scanIntervalMs = Number(process.env['SCAN_INTERVAL_MS']);
  }

  return { ...config, ...overrides };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
