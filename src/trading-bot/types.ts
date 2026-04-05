/**
 * Core types for the AI Trading Bot v2.0
 * Polymarket prediction market arbitrage bot powered by multi-model AI ensemble
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
    /** Polymarket proxy wallet (Safe) address */
    funderAddress?: string;
    /** CLOB API base URL */
    clobUrl: string;
    /** Gamma (markets) API base URL */
    gammaUrl: string;
    /** WebSocket URL for real-time streaming */
    wsUrl: string;
  };
  /** Odds provider configurations */
  odds: OddsProvidersConfig;
  /** AI model configurations */
  ai: AIConfig;
  /** Real-time data feed configurations */
  feeds: DataFeedsConfig;
  /** Trading parameters */
  trading: TradingConfig;
  /** Logging level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface OddsProvidersConfig {
  /** The Odds API (basic, 40 books) */
  theOddsApi?: { apiKey: string };
  /** SharpAPI (Pinnacle sharp lines, built-in arb detection, SSE) */
  sharpApi?: { apiKey: string };
  /** Odds-API.io (265 books, WebSocket, /arbitrage-bets endpoint) */
  oddsApiIo?: { apiKey: string };
  /** Sportradar (official league data, injuries, lineups) */
  sportradar?: { apiKey: string };
}

export interface AIConfig {
  /** Anthropic Claude */
  anthropic?: { apiKey: string; model: string };
  /** OpenAI GPT-4o */
  openai?: { apiKey: string; model: string };
  /** Google Gemini */
  google?: { apiKey: string; model: string };
  /** Ensemble weights (must sum to 1.0) */
  ensembleWeights: { claude: number; gpt: number; gemini: number };
  /** Extremization factor for ensemble (1.0 = none, 2.0 = aggressive) */
  extremizationFactor: number;
}

export interface DataFeedsConfig {
  /** X/Twitter API for breaking news from beat reporters */
  twitter?: {
    bearerToken: string;
    /** Reporter account IDs to monitor */
    reporterIds: string[];
  };
  /** Sportradar for live scores, injuries, lineups */
  sportradar?: { apiKey: string };
  /** Tomorrow.io for weather at game venues */
  weather?: { apiKey: string };
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
  /** Enable market-making mode */
  marketMakingEnabled: boolean;
  /** Enable WebSocket real-time streaming */
  useWebSocket: boolean;
  /** Enable news-driven rapid trading */
  newsTrading: boolean;
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
  /** Tick size for this market */
  tickSize?: string;
  /** Whether market uses negative risk model */
  negRisk?: boolean;
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
  /** VPIN score (0-1, higher = more informed trading) */
  vpin?: number;
}

export type PolymarketOrderType = 'GTC' | 'GTD' | 'FOK' | 'FAK';

export interface PolymarketOrder {
  id?: string;
  marketId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  orderType: PolymarketOrderType;
  /** For GTD orders - expiration timestamp */
  expiration?: number;
  /** Post-only flag for market making (rejected if it would cross spread) */
  postOnly?: boolean;
  tickSize?: string;
  negRisk?: boolean;
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
  /** Sharp line (Pinnacle/Circa vig-free) if available */
  sharpLine?: { home: number; away: number; draw?: number };
  /** Live/in-play status */
  live?: boolean;
  /** Current score if live */
  score?: { home: number; away: number };
}

export interface Bookmaker {
  key: string;
  title: string;
  markets: BookmakerMarket[];
  /** Whether this is a sharp book (Pinnacle, Circa, Betfair) */
  isSharp?: boolean;
}

export interface BookmakerMarket {
  key: string; // h2h, spreads, totals
  outcomes: BookmakerOutcome[];
}

export interface BookmakerOutcome {
  name: string;
  price: number; // Decimal odds
  point?: number; // For spreads/totals
}

/** Pre-computed arbitrage opportunity from SharpAPI or Odds-API.io */
export interface ExternalArbAlert {
  provider: string;
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  market: string;
  /** Bookmaker 1 side */
  leg1: { bookmaker: string; outcome: string; odds: number };
  /** Bookmaker 2 side */
  leg2: { bookmaker: string; outcome: string; odds: number };
  /** Guaranteed profit percentage */
  profitPercent: number;
  detectedAt: number;
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
  /** Confidence score from AI ensemble (0-1) */
  claudeConfidence: number;
  /** AI reasoning */
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
  /** Source of the signal */
  signalSource?: 'sharp_line' | 'ensemble_ai' | 'news_event' | 'stale_detection' | 'arb_alert' | 'vpin';
}

export type ArbitrageType =
  | 'cross_platform'    // Polymarket vs sportsbook price difference
  | 'sharp_divergence'  // Polymarket vs Pinnacle/Circa sharp line
  | 'mispricing'        // AI-detected mispricing vs fair value
  | 'multi_outcome'     // Sum of outcomes != 1.0
  | 'stale_price'       // Price hasn't updated after news/score change
  | 'news_driven'       // Breaking news not yet priced in
  | 'momentum'          // Rapid price movement creating overshoot
  | 'external_arb';     // Pre-computed arb from SharpAPI/Odds-API.io

// ─── AI Analysis Types ──────────────────────────────────────────

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
  /** Which model produced this analysis */
  model?: string;
}

/** Ensemble result combining multiple model outputs */
export interface EnsembleResult {
  /** Final combined probability */
  probability: number;
  /** Combined confidence */
  confidence: number;
  /** Individual model results */
  models: {
    name: string;
    probability: number;
    confidence: number;
    weight: number;
    reasoning: string;
  }[];
  /** Disagreement score between models (0 = agree, 1 = disagree) */
  disagreement: number;
  /** Final reasoning summary */
  reasoning: string;
}

export interface ClaudeAnalysisRequest {
  market: PolymarketMarket;
  orderBook: OrderBook;
  externalOdds?: SportsEvent;
  recentTrades?: TradeRecord[];
  newsContext?: string;
  /** Weather conditions if relevant */
  weather?: WeatherData;
  /** Live score if in-play */
  liveScore?: { home: number; away: number; period: string; clock: string };
}

// ─── News & Data Feed Types ─────────────────────────────────────

export interface NewsItem {
  source: 'twitter' | 'sportradar' | 'news_api';
  author: string;
  text: string;
  timestamp: number;
  /** Entities mentioned (team names, player names) */
  entities: string[];
  /** Sentiment score (-1 to 1) */
  sentiment?: number;
  /** Relevance to active markets (0-1) */
  relevance?: number;
  /** Which markets this news might affect */
  affectedMarketIds?: string[];
}

export interface WeatherData {
  venue: string;
  temperature: number; // Fahrenheit
  windSpeed: number; // mph
  windDirection: string;
  precipitationChance: number; // 0-100
  humidity: number; // 0-100
  conditions: string; // "Clear", "Rain", "Snow", etc.
  /** Impact assessment */
  gameImpact: 'none' | 'low' | 'moderate' | 'high';
}

export interface LiveScoreUpdate {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  period: string;
  clock: string;
  /** Key event type */
  eventType?: 'goal' | 'touchdown' | 'basket' | 'run' | 'penalty' | 'injury' | 'ejection';
  timestamp: number;
}

// ─── VPIN / Order Flow Types ────────────────────────────────────

export interface VPINState {
  tokenId: string;
  /** Current VPIN value (0-1, higher = more informed trading) */
  vpin: number;
  /** Buy volume in current bucket */
  buyVolume: number;
  /** Sell volume in current bucket */
  sellVolume: number;
  /** Number of buckets used */
  bucketCount: number;
  /** Alert level */
  alertLevel: 'normal' | 'elevated' | 'high' | 'critical';
  lastUpdated: number;
}

export interface MarketMakingQuote {
  tokenId: string;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
  /** Inventory skew applied */
  inventorySkew: number;
  /** Spread width */
  spreadWidth: number;
}

// ─── Risk Management Types ──────────────────────────────────────

export type HeatLevel = 'normal' | 'warning' | 'critical' | 'max';

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
  /** 4-level heat system */
  heatLevel: HeatLevel;
  /** Brier score for model calibration */
  brierScore?: number;
}

export interface RiskLimits {
  maxDailyLoss: number;
  maxDailyTrades: number;
  maxSingleLoss: number;
  maxCorrelatedExposure: number;
  stopTradingDrawdownPercent: number;
  /** Heat system thresholds */
  warningDrawdownPercent: number;
  criticalDrawdownPercent: number;
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
  /** Signal source that triggered this trade */
  signalSource?: string;
  /** Order type used */
  orderType?: PolymarketOrderType;
}

// ─── Bot Events ─────────────────────────────────────────────────

export type BotEvent =
  | { type: 'scan_complete'; marketsScanned: number; opportunitiesFound: number }
  | { type: 'opportunity_found'; opportunity: ArbitrageOpportunity }
  | { type: 'trade_placed'; trade: TradeRecord }
  | { type: 'trade_filled'; trade: TradeRecord }
  | { type: 'trade_resolved'; trade: TradeRecord; pnl: number }
  | { type: 'risk_alert'; message: string; metrics: RiskMetrics }
  | { type: 'news_alert'; news: NewsItem }
  | { type: 'score_update'; update: LiveScoreUpdate }
  | { type: 'vpin_alert'; state: VPINState }
  | { type: 'arb_alert'; alert: ExternalArbAlert }
  | { type: 'websocket_connected'; channel: string }
  | { type: 'websocket_disconnected'; channel: string }
  | { type: 'error'; error: Error; context: string }
  | { type: 'status'; message: string };

export type BotEventHandler = (event: BotEvent) => void;
