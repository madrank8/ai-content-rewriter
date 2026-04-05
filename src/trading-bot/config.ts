/**
 * Default configuration and environment loader for the trading bot v2.0
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
  marketMakingEnabled: false,
  useWebSocket: true,
  newsTrading: true,
};

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxDailyLoss: 500,
  maxDailyTrades: 100,
  maxSingleLoss: 200,
  maxCorrelatedExposure: 2000,
  stopTradingDrawdownPercent: 20,
  warningDrawdownPercent: 10,
  criticalDrawdownPercent: 15,
};

export const POLYMARKET_CLOB_URL = 'https://clob.polymarket.com';
export const POLYMARKET_GAMMA_URL = 'https://gamma-api.polymarket.com';
export const POLYMARKET_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws';
export const ODDS_API_URL = 'https://api.the-odds-api.com/v4';
export const SHARP_API_URL = 'https://api.sharpapi.io/v1';
export const ODDS_API_IO_URL = 'https://api.odds-api.io/v1';
export const SPORTRADAR_URL = 'https://api.sportradar.us';
export const TOMORROW_IO_URL = 'https://api.tomorrow.io/v4';

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
  'tennis_atp',
  'tennis_wta',
  'golf_pga',
] as const;

export type SupportedSport = (typeof SUPPORTED_SPORTS)[number];

/** Key Twitter/X beat reporter account IDs to monitor for breaking news */
export const DEFAULT_REPORTER_IDS = [
  // NFL
  '29233759',   // @AdamSchefter
  '54aborte1',  // @RapSheet (Ian Rapoport)
  '25059658',   // @TomPelissero
  // NBA
  '57466897',   // @ShamsCharania
  '330895474',  // @ChrisBHaynes
  // MLB
  '58aborte4',  // @JeffPassan
  '72aborte8',  // @Ken_Rosenthal
];

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
      funderAddress: process.env['POLYMARKET_FUNDER_ADDRESS'],
      clobUrl: process.env['POLYMARKET_CLOB_URL'] ?? POLYMARKET_CLOB_URL,
      gammaUrl: process.env['POLYMARKET_GAMMA_URL'] ?? POLYMARKET_GAMMA_URL,
      wsUrl: process.env['POLYMARKET_WS_URL'] ?? POLYMARKET_WS_URL,
    },
    odds: {
      theOddsApi: process.env['ODDS_API_KEY'] ? { apiKey: process.env['ODDS_API_KEY'] } : undefined,
      sharpApi: process.env['SHARP_API_KEY'] ? { apiKey: process.env['SHARP_API_KEY'] } : undefined,
      oddsApiIo: process.env['ODDS_API_IO_KEY'] ? { apiKey: process.env['ODDS_API_IO_KEY'] } : undefined,
      sportradar: process.env['SPORTRADAR_API_KEY'] ? { apiKey: process.env['SPORTRADAR_API_KEY'] } : undefined,
    },
    ai: {
      anthropic: process.env['ANTHROPIC_API_KEY']
        ? { apiKey: process.env['ANTHROPIC_API_KEY'], model: process.env['CLAUDE_MODEL'] ?? 'claude-sonnet-4-6' }
        : undefined,
      openai: process.env['OPENAI_API_KEY']
        ? { apiKey: process.env['OPENAI_API_KEY'], model: process.env['GPT_MODEL'] ?? 'gpt-4o' }
        : undefined,
      google: process.env['GOOGLE_AI_KEY']
        ? { apiKey: process.env['GOOGLE_AI_KEY'], model: process.env['GEMINI_MODEL'] ?? 'gemini-1.5-pro' }
        : undefined,
      ensembleWeights: {
        claude: Number(process.env['ENSEMBLE_WEIGHT_CLAUDE'] ?? 0.40),
        gpt: Number(process.env['ENSEMBLE_WEIGHT_GPT'] ?? 0.35),
        gemini: Number(process.env['ENSEMBLE_WEIGHT_GEMINI'] ?? 0.25),
      },
      extremizationFactor: Number(process.env['EXTREMIZATION_FACTOR'] ?? 1.5),
    },
    feeds: {
      twitter: process.env['TWITTER_BEARER_TOKEN']
        ? {
            bearerToken: process.env['TWITTER_BEARER_TOKEN'],
            reporterIds: (process.env['TWITTER_REPORTER_IDS'] ?? '').split(',').filter(Boolean),
          }
        : undefined,
      sportradar: process.env['SPORTRADAR_API_KEY']
        ? { apiKey: process.env['SPORTRADAR_API_KEY'] }
        : undefined,
      weather: process.env['TOMORROW_IO_KEY']
        ? { apiKey: process.env['TOMORROW_IO_KEY'] }
        : undefined,
    },
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
  if (process.env['MARKET_MAKING'] === 'true') {
    config.trading.marketMakingEnabled = true;
  }
  if (process.env['USE_WEBSOCKET'] === 'false') {
    config.trading.useWebSocket = false;
  }
  if (process.env['NEWS_TRADING'] === 'false') {
    config.trading.newsTrading = false;
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
