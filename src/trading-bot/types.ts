/**
 * Core types for the AI Trading Bot
 * Polymarket prediction market arbitrage bot powered by Claude AI
 */

// ─── Configuration ──────────────────────────────────────────────

export interface BotConfig {
  /** Polymarket API credentials */
  polymarket: {
    apiKey: string;
    apiSecret: string;
    apiPassphrase: string;
    /** Polygon wallet private key for signing orders */
    privateKey: string;
    /** CLOB API base URL */
    clobUrl: string;
    /** Gamma (markets) API base URL */
    gammaUrl: string;
  };
  /** The Odds API key for sportsbook data */
  oddsApiKey: string;
  /** Anthropic API key for Claude analysis */
  anthropicApiKey: string;
  /** Claude model to use */
  claudeModel: string;
  /** Trading parameters */
  trading: TradingConfig;
  /** Logging level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface TradingConfig {
  /** Maximum position size in USDC */
  maxPositionSize: number;
  /** Total portfolio budget in USDC */
  totalBudget: number;
  /** Minimum edge (%) required to place a trade */
  minEdgePercent: number;
  /** Kelly fraction (0.25 = quarter Kelly) */
  kellyFraction: number;
  /** Maximum number of concurrent positions */
  maxConcurrentPositions: number;
  /** Minimum liquidity depth required in USDC */
  minLiquidityDepth: number;
  /** Maximum exposure per single market (% of budget) */
  maxMarketExposurePercent: number;
  /** Polling interval in ms for market scanning */
  scanIntervalMs: number;
  /** Enable dry-run mode (no real orders) */
  dryRun: boolean;
}

// ─── Polymarket Types ───────────────────────────────────────────

export interface PolymarketMarket {
  id: string;
  conditionId: string;
  questionId: string;
  question: string;
  description: string;
  category: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  tokens: PolymarketToken[];
  volume: number;
  liquidity: number;
  slug: string;
  outcomes: string[];
  outcomePrices: number[];
}

export interface PolymarketToken {
  tokenId: string;
  outcome: string;
  price: number;
  winner: boolean;
}

export interface OrderBookEntry {
  price: number;
  size: number;
}

export interface OrderBook {
  bids: OrderBookEntry[];
  asks: OrderBookEntry[];
  spread: number;
  midPrice: number;
  timestamp: number;
}

export interface PolymarketOrder {
  id?: string;
  marketId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  type: 'LIMIT' | 'MARKET';
  status?: OrderStatus;
  createdAt?: string;
}

export type OrderStatus = 'PENDING' | 'OPEN' | 'FILLED' | 'PARTIAL' | 'CANCELLED' | 'EXPIRED';

export interface Position {
  marketId: string;
  tokenId: string;
  outcome: string;
  question: string;
  size: number;
  avgEntryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  timestamp: number;
}

// ─── External Odds Types ────────────────────────────────────────

export interface SportsEvent {
  id: string;
  sportKey: string;
  sportTitle: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  bookmakers: Bookmaker[];
}

export interface Bookmaker {
  key: string;
  title: string;
  markets: BookmakerMarket[];
}

export interface BookmakerMarket {
  key: string; // h2h, spreads, totals
  outcomes: BookmakerOutcome[];
}

export interface BookmakerOutcome {
  name: string;
  price: number; // American odds or decimal
  point?: number; // For spreads/totals
}

// ─── Arbitrage Types ────────────────────────────────────────────

export interface ArbitrageOpportunity {
  id: string;
  type: ArbitrageType;
  polymarketMarket: PolymarketMarket;
  /** Implied probability from Polymarket price */
  polymarketProbability: number;
  /** Fair probability estimated from external sources */
  fairProbability: number;
  /** Edge in percentage points */
  edgePercent: number;
  /** Recommended side to take */
  side: 'YES' | 'NO';
  /** Recommended position size via Kelly */
  recommendedSize: number;
  /** Expected value of the trade */
  expectedValue: number;
  /** Confidence score from Claude analysis (0-1) */
  claudeConfidence: number;
  /** Claude's reasoning */
  claudeReasoning: string;
  /** Matching sportsbook odds if cross-platform arb */
  externalOdds?: {
    bookmaker: string;
    impliedProbability: number;
    decimalOdds: number;
  };
  /** Available liquidity at the target price */
  availableLiquidity: number;
  /** Timestamp of discovery */
  discoveredAt: number;
  /** Time until market closes */
  timeToCloseMs: number;
}

export type ArbitrageType =
  | 'cross_platform'    // Polymarket vs sportsbook price difference
  | 'mispricing'        // AI-detected mispricing vs fair value
  | 'multi_outcome'     // Sum of outcomes != 1.0
  | 'stale_price'       // Price hasn't updated after news
  | 'momentum';         // Rapid price movement creating overshoot

// ─── Claude Analysis Types ──────────────────────────────────────

export interface MarketAnalysis {
  marketId: string;
  question: string;
  estimatedProbability: number;
  confidence: number;
  reasoning: string;
  keyFactors: string[];
  riskFactors: string[];
  recommendation: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';
  timeHorizon: string;
  analyzedAt: number;
}

export interface ClaudeAnalysisRequest {
  market: PolymarketMarket;
  orderBook: OrderBook;
  externalOdds?: SportsEvent;
  recentTrades?: TradeRecord[];
  newsContext?: string;
}

// ─── Risk Management Types ──────────────────────────────────────

export interface RiskMetrics {
  totalExposure: number;
  availableCapital: number;
  totalPnl: number;
  winRate: number;
  avgReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  currentDrawdown: number;
  positionCount: number;
  dailyPnl: number;
  dailyTradeCount: number;
}

export interface RiskLimits {
  maxDailyLoss: number;
  maxDailyTrades: number;
  maxSingleLoss: number;
  maxCorrelatedExposure: number;
  stopTradingDrawdownPercent: number;
}

// ─── Trade Record ───────────────────────────────────────────────

export interface TradeRecord {
  id: string;
  marketId: string;
  tokenId: string;
  question: string;
  side: 'BUY' | 'SELL';
  outcome: string;
  price: number;
  size: number;
  cost: number;
  status: 'OPEN' | 'WON' | 'LOST' | 'CLOSED';
  entryTime: number;
  exitTime?: number;
  pnl?: number;
  arbType: ArbitrageType;
  claudeConfidence: number;
  claudeReasoning: string;
}

// ─── Bot Events ─────────────────────────────────────────────────

export type BotEvent =
  | { type: 'scan_complete'; marketsScanned: number; opportunitiesFound: number }
  | { type: 'opportunity_found'; opportunity: ArbitrageOpportunity }
  | { type: 'trade_placed'; trade: TradeRecord }
  | { type: 'trade_filled'; trade: TradeRecord }
  | { type: 'trade_resolved'; trade: TradeRecord; pnl: number }
  | { type: 'risk_alert'; message: string; metrics: RiskMetrics }
  | { type: 'error'; error: Error; context: string }
  | { type: 'status'; message: string };

export type BotEventHandler = (event: BotEvent) => void;
