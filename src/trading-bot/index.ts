/**
 * AI Trading Bot - Polymarket Prediction Market Arbitrage
 *
 * A Claude AI-powered trading bot for Polymarket prediction markets,
 * inspired by sovereign2013's bot that turned $1 into $3.3M.
 *
 * Strategy:
 * 1. Cross-platform arbitrage: Compare Polymarket prices with sportsbook odds
 * 2. AI mispricing detection: Use Claude to estimate fair probabilities
 * 3. Multi-outcome arbitrage: Find underround pricing opportunities
 * 4. Kelly criterion sizing: Optimal position sizing with fractional Kelly
 * 5. Real-time risk management: Drawdown limits, exposure caps, daily limits
 *
 * @module trading-bot
 */

export { TradingBot } from './bot.js';
export { PolymarketClient } from './polymarket-client.js';
export { OddsAggregator } from './odds-aggregator.js';
export { ClaudeAnalyzer } from './claude-analyzer.js';
export { ArbitrageDetector } from './arbitrage-detector.js';
export { RiskManager } from './risk-manager.js';
export { Executor } from './executor.js';
export { Logger } from './logger.js';
export { loadConfigFromEnv, DEFAULT_TRADING_CONFIG, DEFAULT_RISK_LIMITS } from './config.js';
export type {
  BotConfig,
  TradingConfig,
  RiskLimits,
  PolymarketMarket,
  PolymarketOrder,
  OrderBook,
  Position,
  SportsEvent,
  ArbitrageOpportunity,
  ArbitrageType,
  MarketAnalysis,
  RiskMetrics,
  TradeRecord,
  BotEvent,
  BotEventHandler,
} from './types.js';
