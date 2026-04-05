/**
 * AI Trading Bot v2.0 - Polymarket Prediction Market Arbitrage
 *
 * A multi-model AI-powered trading bot for Polymarket prediction markets,
 * inspired by sovereign2013's bot that turned $1 into $3.3M.
 *
 * Major features:
 * 1. Multi-provider odds: SharpAPI (Pinnacle), Odds-API.io (265 books), The Odds API
 * 2. Multi-model AI ensemble: Claude (40%) + GPT-4o (35%) + Gemini (25%) with extremization
 * 3. Real-time WebSocket: Polymarket order book streaming for sub-second reaction
 * 4. Twitter/X news feed: Beat reporter monitoring for 5-30min information edge
 * 5. VPIN order flow analysis: Detect informed trading, protect against adverse selection
 * 6. Market making mode: Avellaneda-Stoikov spread capture with inventory management
 * 7. Stale price detection: Cross-market correlation, score-driven, news-driven
 * 8. Sportradar integration: Official injuries, lineups, live scores
 * 9. Weather data: Tomorrow.io for outdoor sports game conditions
 * 10. 4-level heat system: Dynamic position sizing based on drawdown severity
 *
 * @module trading-bot
 */

// ─── Core ───────────────────────────────────────────────────────
export { TradingBot } from './bot.js';
export { PolymarketClient } from './polymarket-client.js';
export { Logger } from './logger.js';
export { loadConfigFromEnv, DEFAULT_TRADING_CONFIG, DEFAULT_RISK_LIMITS } from './config.js';

// ─── Odds Providers ─────────────────────────────────────────────
export { SharpOddsProvider } from './sharp-odds-provider.js';
export { OddsAggregator } from './odds-aggregator.js';

// ─── AI Analysis ────────────────────────────────────────────────
export { EnsembleAnalyzer } from './ensemble-analyzer.js';
export { ClaudeAnalyzer } from './claude-analyzer.js';

// ─── Real-Time Data ─────────────────────────────────────────────
export { PolymarketWebSocket } from './websocket-stream.js';
export { TwitterNewsFeed, SportradarFeed, WeatherFeed } from './news-feed.js';

// ─── Strategy ───────────────────────────────────────────────────
export { ArbitrageDetector } from './arbitrage-detector.js';
export { StaleDetector } from './stale-detector.js';
export { VPINAnalyzer, MarketMaker } from './vpin-analyzer.js';

// ─── Execution ──────────────────────────────────────────────────
export { RiskManager } from './risk-manager.js';
export { Executor } from './executor.js';

// ─── Types ──────────────────────────────────────────────────────
export type {
  BotConfig,
  TradingConfig,
  RiskLimits,
  OddsProvidersConfig,
  AIConfig,
  DataFeedsConfig,
  PolymarketMarket,
  PolymarketOrder,
  PolymarketOrderType,
  OrderBook,
  Position,
  SportsEvent,
  ExternalArbAlert,
  ArbitrageOpportunity,
  ArbitrageType,
  MarketAnalysis,
  EnsembleResult,
  ClaudeAnalysisRequest,
  NewsItem,
  WeatherData,
  LiveScoreUpdate,
  VPINState,
  MarketMakingQuote,
  RiskMetrics,
  HeatLevel,
  TradeRecord,
  BotEvent,
  BotEventHandler,
} from './types.js';
