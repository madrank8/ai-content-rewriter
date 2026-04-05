/**
 * Risk Manager & Kelly Criterion Position Sizer
 * Manages portfolio risk, calculates optimal position sizes,
 * and enforces trading limits
 */

import type {
  ArbitrageOpportunity,
  RiskMetrics,
  RiskLimits,
  TradeRecord,
  Position,
  TradingConfig,
} from './types.js';
import { DEFAULT_RISK_LIMITS } from './config.js';
import { Logger } from './logger.js';

export class RiskManager {
  private config: TradingConfig;
  private limits: RiskLimits;
  private logger: Logger;
  private tradeHistory: TradeRecord[] = [];
  private dailyPnl = 0;
  private dailyTradeCount = 0;
  private dayStart = this.getStartOfDay();
  private peakBalance: number;
  private currentBalance: number;

  constructor(config: TradingConfig, logger: Logger, limits?: RiskLimits) {
    this.config = config;
    this.limits = limits ?? DEFAULT_RISK_LIMITS;
    this.logger = logger.child('RISK');
    this.peakBalance = config.totalBudget;
    this.currentBalance = config.totalBudget;
  }

  // ─── Position Sizing (Kelly Criterion) ──────────────────────

  /**
   * Calculate optimal position size using fractional Kelly criterion
   *
   * Kelly formula: f* = (bp - q) / b
   * where:
   *   f* = fraction of bankroll to bet
   *   b  = net odds received (payout / stake - 1)
   *   p  = probability of winning
   *   q  = probability of losing (1 - p)
   */
  calculatePositionSize(opportunity: ArbitrageOpportunity, positions: Position[]): number {
    const { fairProbability, polymarketProbability } = opportunity;

    // The price we buy at
    const buyPrice = polymarketProbability;
    // Payout is $1 if we win
    const netOdds = (1 / buyPrice) - 1; // e.g., buy at $0.60, net odds = 0.667

    const p = fairProbability; // Our estimated probability of winning
    const q = 1 - p;
    const b = netOdds;

    // Kelly fraction
    let kellyFraction = (b * p - q) / b;

    // Clamp to non-negative (don't bet if negative edge)
    if (kellyFraction <= 0) return 0;

    // Apply fractional Kelly (conservative)
    kellyFraction *= this.config.kellyFraction;

    // Calculate dollar amount
    let positionSize = kellyFraction * this.getAvailableCapital(positions);

    // Apply hard caps
    positionSize = Math.min(positionSize, this.config.maxPositionSize);

    // Don't exceed available liquidity
    positionSize = Math.min(positionSize, opportunity.availableLiquidity * 0.5);

    // Market exposure limit
    const currentExposure = this.getMarketExposure(opportunity.polymarketMarket.id, positions);
    const maxMarketExposure = this.config.totalBudget * (this.config.maxMarketExposurePercent / 100);
    positionSize = Math.min(positionSize, maxMarketExposure - currentExposure);

    // Minimum viable trade
    if (positionSize < 1) return 0;

    // Adjust based on Claude confidence
    positionSize *= this.confidenceMultiplier(opportunity.claudeConfidence);

    // Adjust based on time to close (reduce size for longer-dated markets)
    positionSize *= this.timeDecayMultiplier(opportunity.timeToCloseMs);

    return Math.floor(positionSize * 100) / 100; // Round to cents
  }

  /**
   * Calculate expected value of a trade
   */
  calculateExpectedValue(opportunity: ArbitrageOpportunity, positionSize: number): number {
    const { fairProbability, polymarketProbability } = opportunity;
    const buyPrice = polymarketProbability;

    // EV = (prob_win * payout) - cost
    // Payout per share = $1.00, cost per share = buyPrice
    const shares = positionSize / buyPrice;
    const ev = (fairProbability * shares * 1) - positionSize;

    return Math.round(ev * 100) / 100;
  }

  // ─── Risk Checks ────────────────────────────────────────────

  /**
   * Run all risk checks before placing a trade
   * Returns null if trade is allowed, or a reason string if blocked
   */
  checkTradeAllowed(opportunity: ArbitrageOpportunity, positionSize: number, positions: Position[]): string | null {
    this.resetDailyCountersIfNeeded();

    // Check daily loss limit
    if (this.dailyPnl <= -this.limits.maxDailyLoss) {
      return `Daily loss limit reached: $${Math.abs(this.dailyPnl).toFixed(2)} / $${this.limits.maxDailyLoss}`;
    }

    // Check daily trade count
    if (this.dailyTradeCount >= this.limits.maxDailyTrades) {
      return `Daily trade limit reached: ${this.dailyTradeCount} / ${this.limits.maxDailyTrades}`;
    }

    // Check max concurrent positions
    if (positions.length >= this.config.maxConcurrentPositions) {
      return `Max concurrent positions reached: ${positions.length} / ${this.config.maxConcurrentPositions}`;
    }

    // Check single trade loss potential
    if (positionSize > this.limits.maxSingleLoss) {
      return `Position size $${positionSize} exceeds max single loss $${this.limits.maxSingleLoss}`;
    }

    // Check portfolio drawdown
    const drawdownPercent = this.getCurrentDrawdown();
    if (drawdownPercent >= this.limits.stopTradingDrawdownPercent) {
      return `Drawdown limit reached: ${drawdownPercent.toFixed(1)}% / ${this.limits.stopTradingDrawdownPercent}%`;
    }

    // Check available capital
    if (positionSize > this.getAvailableCapital(positions)) {
      return `Insufficient capital: need $${positionSize}, have $${this.getAvailableCapital(positions).toFixed(2)}`;
    }

    // Minimum edge requirement
    if (opportunity.edgePercent < this.config.minEdgePercent) {
      return `Edge ${opportunity.edgePercent.toFixed(2)}% below minimum ${this.config.minEdgePercent}%`;
    }

    return null; // Trade is allowed
  }

  // ─── Portfolio Metrics ──────────────────────────────────────

  /**
   * Calculate current risk metrics
   */
  getMetrics(positions: Position[]): RiskMetrics {
    this.resetDailyCountersIfNeeded();

    const totalExposure = positions.reduce((sum, p) => sum + p.size * p.avgEntryPrice, 0);
    const totalPnl = this.tradeHistory.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const closedTrades = this.tradeHistory.filter((t) => t.status === 'WON' || t.status === 'LOST');
    const wins = closedTrades.filter((t) => t.status === 'WON').length;
    const winRate = closedTrades.length > 0 ? wins / closedTrades.length : 0;
    const avgReturn = closedTrades.length > 0
      ? closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0) / closedTrades.length
      : 0;

    return {
      totalExposure,
      availableCapital: this.getAvailableCapital(positions),
      totalPnl,
      winRate,
      avgReturn,
      sharpeRatio: this.calculateSharpe(),
      maxDrawdown: this.getMaxDrawdown(),
      currentDrawdown: this.getCurrentDrawdown(),
      positionCount: positions.length,
      dailyPnl: this.dailyPnl,
      dailyTradeCount: this.dailyTradeCount,
    };
  }

  // ─── Trade Recording ────────────────────────────────────────

  recordTrade(trade: TradeRecord): void {
    this.tradeHistory.push(trade);
    this.dailyTradeCount++;
    this.logger.info('Trade recorded', {
      market: trade.question.slice(0, 40),
      side: trade.side,
      size: trade.size,
      price: trade.price,
    });
  }

  recordTradeResult(tradeId: string, pnl: number, won: boolean): void {
    const trade = this.tradeHistory.find((t) => t.id === tradeId);
    if (!trade) return;

    trade.status = won ? 'WON' : 'LOST';
    trade.pnl = pnl;
    trade.exitTime = Date.now();

    this.dailyPnl += pnl;
    this.currentBalance += pnl;
    if (this.currentBalance > this.peakBalance) {
      this.peakBalance = this.currentBalance;
    }

    this.logger.info('Trade resolved', {
      tradeId,
      pnl: pnl.toFixed(2),
      won,
      dailyPnl: this.dailyPnl.toFixed(2),
    });
  }

  // ─── Internal Calculations ──────────────────────────────────

  private getAvailableCapital(positions: Position[]): number {
    const invested = positions.reduce((sum, p) => sum + p.size * p.avgEntryPrice, 0);
    return Math.max(0, this.currentBalance - invested);
  }

  private getMarketExposure(marketId: string, positions: Position[]): number {
    return positions
      .filter((p) => p.marketId === marketId)
      .reduce((sum, p) => sum + p.size * p.avgEntryPrice, 0);
  }

  private getCurrentDrawdown(): number {
    if (this.peakBalance === 0) return 0;
    return ((this.peakBalance - this.currentBalance) / this.peakBalance) * 100;
  }

  private getMaxDrawdown(): number {
    // Simple max drawdown from trade history
    let peak = this.config.totalBudget;
    let maxDd = 0;
    let running = this.config.totalBudget;

    for (const trade of this.tradeHistory) {
      if (trade.pnl !== undefined) {
        running += trade.pnl;
        if (running > peak) peak = running;
        const dd = ((peak - running) / peak) * 100;
        if (dd > maxDd) maxDd = dd;
      }
    }

    return maxDd;
  }

  private calculateSharpe(): number {
    const returns = this.tradeHistory
      .filter((t) => t.pnl !== undefined)
      .map((t) => t.pnl! / t.cost);

    if (returns.length < 5) return 0;

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;
    return mean / stdDev;
  }

  /**
   * Scale position based on Claude's confidence
   * Low confidence = smaller position, high confidence = full size
   */
  private confidenceMultiplier(confidence: number): number {
    if (confidence <= 0) return 0;
    if (confidence >= 0.8) return 1;
    // Linear scale from 0.3 to 1.0 for confidence 0.0-0.8
    return 0.3 + (confidence / 0.8) * 0.7;
  }

  /**
   * Scale position based on time to market close
   * Longer-dated markets get smaller positions (capital lockup cost)
   */
  private timeDecayMultiplier(timeToCloseMs: number): number {
    const hours = timeToCloseMs / 3600_000;
    if (hours <= 2) return 1.0;     // Full size for imminent events
    if (hours <= 12) return 0.8;
    if (hours <= 24) return 0.6;
    if (hours <= 72) return 0.4;
    return 0.25; // Very long-dated
  }

  private resetDailyCountersIfNeeded(): void {
    const today = this.getStartOfDay();
    if (today > this.dayStart) {
      this.dailyPnl = 0;
      this.dailyTradeCount = 0;
      this.dayStart = today;
    }
  }

  private getStartOfDay(): number {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }
}
