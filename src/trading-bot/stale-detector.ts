/**
 * Stale Price Detector
 *
 * Identifies markets where the price hasn't updated after new information:
 * 1. Cross-market correlation: Related markets moved but this one didn't
 * 2. News-driven: Breaking news should have moved the price but hasn't
 * 3. Score-driven: Live game score changed but prediction market is stale
 * 4. Sharp line divergence: Pinnacle/sharp books repriced but Polymarket hasn't
 *
 * Staleness windows:
 *   Score change → 1-5 seconds
 *   Beat reporter tweet → 30-120 seconds
 *   Official injury report → 5-30 seconds
 *   Related market reprice → seconds to minutes
 */

import type {
  PolymarketMarket,
  OrderBook,
  SportsEvent,
  ArbitrageOpportunity,
  LiveScoreUpdate,
  NewsItem,
  ArbitrageType,
} from './types.js';
import { Logger } from './logger.js';

interface StaleCandidate {
  market: PolymarketMarket;
  reason: string;
  expectedProbability: number;
  currentProbability: number;
  staleDuration: number; // How long it's been stale (ms)
  signalSource: ArbitrageOpportunity['signalSource'];
}

/** Pre-computed probability lookup for Dixon-Coles Poisson model */
interface ScorelineProbability {
  homeGoals: number;
  awayGoals: number;
  homeWinProb: number;
  drawProb: number;
  awayWinProb: number;
}

export class StaleDetector {
  private logger: Logger;

  /** Track last known prices for staleness detection */
  private priceHistory: Map<string, Array<{ price: number; timestamp: number }>> = new Map();

  /** Track which markets are correlated */
  private correlationGroups: Map<string, Set<string>> = new Map();

  /** Pre-computed scoreline probabilities for live sports */
  private scorelineLookup: Map<string, ScorelineProbability[]> = new Map();

  private minEdgePercent: number;

  constructor(logger: Logger, minEdgePercent = 2.0) {
    this.logger = logger.child('STALE');
    this.minEdgePercent = minEdgePercent;
  }

  // ─── Score-Driven Staleness ─────────────────────────────────

  /**
   * Check if any Polymarket markets are stale after a live score update
   * This is the highest-edge, most time-sensitive detection
   */
  detectScoreStale(
    scoreUpdate: LiveScoreUpdate,
    markets: PolymarketMarket[],
    currentBooks: Map<string, OrderBook>
  ): StaleCandidate[] {
    const candidates: StaleCandidate[] = [];
    const q = `${scoreUpdate.homeTeam} ${scoreUpdate.awayTeam}`.toLowerCase();

    for (const market of markets) {
      if (!market.question.toLowerCase().includes(scoreUpdate.homeTeam.toLowerCase().split(' ').pop() ?? '')) continue;
      if (!market.question.toLowerCase().includes(scoreUpdate.awayTeam.toLowerCase().split(' ').pop() ?? '')) continue;

      const currentPrice = market.outcomePrices[0] ?? 0.5;

      // Estimate new fair probability based on score
      // Simple model: leading team should have higher probability
      const scoreDiff = scoreUpdate.homeScore - scoreUpdate.awayScore;
      let estimatedProb: number;

      if (market.question.toLowerCase().includes(scoreUpdate.homeTeam.toLowerCase())) {
        // Market is about home team winning
        estimatedProb = this.estimateWinProbFromScore(scoreDiff, scoreUpdate.period);
      } else {
        // Market is about away team winning
        estimatedProb = this.estimateWinProbFromScore(-scoreDiff, scoreUpdate.period);
      }

      const edge = Math.abs(estimatedProb - currentPrice);
      if (edge > this.minEdgePercent / 100) {
        candidates.push({
          market,
          reason: `Score changed to ${scoreUpdate.homeScore}-${scoreUpdate.awayScore} (${scoreUpdate.period}) but price still at ${currentPrice.toFixed(3)}`,
          expectedProbability: estimatedProb,
          currentProbability: currentPrice,
          staleDuration: 0,
          signalSource: 'stale_detection',
        });
      }
    }

    if (candidates.length > 0) {
      this.logger.info(`Found ${candidates.length} stale markets after score update`, {
        score: `${scoreUpdate.homeTeam} ${scoreUpdate.homeScore}-${scoreUpdate.awayScore} ${scoreUpdate.awayTeam}`,
      });
    }

    return candidates;
  }

  // ─── News-Driven Staleness ──────────────────────────────────

  /**
   * Check if markets haven't repriced after breaking news
   */
  detectNewsStale(
    news: NewsItem,
    markets: PolymarketMarket[]
  ): StaleCandidate[] {
    const candidates: StaleCandidate[] = [];
    const newsLower = news.text.toLowerCase();

    // Only act on high-impact news
    if (news.sentiment === undefined || Math.abs(news.sentiment) < 0.3) return candidates;

    for (const market of markets) {
      const questionLower = market.question.toLowerCase();

      // Check if any entity from the news matches the market
      const relevant = news.entities.some(entity =>
        questionLower.includes(entity.toLowerCase())
      );

      if (!relevant) continue;

      const currentPrice = market.outcomePrices[0] ?? 0.5;

      // Estimate impact direction from sentiment
      // Negative sentiment (injury/ruled out) typically decreases the affected team's win probability
      const impact = news.sentiment * 0.1; // Scale down - single injury ~ 5-10% probability shift
      const estimatedProb = Math.max(0.01, Math.min(0.99, currentPrice + impact));

      const edge = Math.abs(estimatedProb - currentPrice);
      if (edge > this.minEdgePercent / 100) {
        candidates.push({
          market,
          reason: `Breaking: "${news.text.slice(0, 80)}..." - price hasn't adjusted`,
          expectedProbability: estimatedProb,
          currentProbability: currentPrice,
          staleDuration: Date.now() - news.timestamp,
          signalSource: 'news_event',
        });
      }
    }

    return candidates;
  }

  // ─── Sharp Line Divergence ──────────────────────────────────

  /**
   * Detect when Polymarket price diverges from sharp bookmaker lines
   * Sharp books (Pinnacle, Circa) reprice faster than prediction markets
   */
  detectSharpDivergence(
    markets: PolymarketMarket[],
    events: SportsEvent[],
    matchFn: (q: string, events: SportsEvent[]) => SportsEvent | null
  ): StaleCandidate[] {
    const candidates: StaleCandidate[] = [];

    for (const market of markets) {
      const event = matchFn(market.question, events);
      if (!event?.sharpLine) continue;

      const polyPrice = market.outcomePrices[0] ?? 0.5;
      const sharpProb = event.sharpLine.home; // Assuming YES = home team

      const edge = Math.abs(sharpProb - polyPrice);
      if (edge > this.minEdgePercent / 100) {
        candidates.push({
          market,
          reason: `Sharp line: ${(sharpProb * 100).toFixed(1)}% vs Polymarket: ${(polyPrice * 100).toFixed(1)}%`,
          expectedProbability: sharpProb,
          currentProbability: polyPrice,
          staleDuration: 0,
          signalSource: 'sharp_line',
        });
      }
    }

    return candidates;
  }

  // ─── Cross-Market Correlation ───────────────────────────────

  /**
   * Register correlated markets (e.g., "Team wins championship" correlated with "Team wins semifinal")
   */
  registerCorrelation(marketIds: string[]): void {
    for (const id of marketIds) {
      const existing = this.correlationGroups.get(id) ?? new Set();
      for (const otherId of marketIds) {
        if (otherId !== id) existing.add(otherId);
      }
      this.correlationGroups.set(id, existing);
    }
  }

  /**
   * Detect when a correlated market moved but this one didn't
   */
  detectCrossMarketStale(
    markets: Map<string, PolymarketMarket>
  ): StaleCandidate[] {
    const candidates: StaleCandidate[] = [];

    for (const [marketId, correlated] of this.correlationGroups) {
      const market = markets.get(marketId);
      if (!market) continue;

      const history = this.priceHistory.get(marketId);
      if (!history || history.length < 2) continue;

      const currentPrice = history[history.length - 1]!.price;
      const recentChange = Math.abs(currentPrice - history[history.length - 2]!.price);

      // If this market hasn't moved but correlated markets have
      if (recentChange < 0.005) { // Less than 0.5% change
        for (const corrId of correlated) {
          const corrHistory = this.priceHistory.get(corrId);
          if (!corrHistory || corrHistory.length < 2) continue;

          const corrChange = Math.abs(
            corrHistory[corrHistory.length - 1]!.price -
            corrHistory[corrHistory.length - 2]!.price
          );

          if (corrChange > 0.03) { // Correlated market moved 3%+
            candidates.push({
              market,
              reason: `Correlated market ${corrId} moved ${(corrChange * 100).toFixed(1)}% but this market is flat`,
              expectedProbability: currentPrice + corrChange * 0.5, // Rough estimate
              currentProbability: currentPrice,
              staleDuration: 0,
              signalSource: 'stale_detection',
            });
          }
        }
      }
    }

    return candidates;
  }

  // ─── Price Tracking ─────────────────────────────────────────

  /**
   * Record a price observation for staleness tracking
   */
  recordPrice(marketId: string, price: number): void {
    const history = this.priceHistory.get(marketId) ?? [];
    history.push({ price, timestamp: Date.now() });

    // Keep only last 100 observations
    if (history.length > 100) history.shift();

    this.priceHistory.set(marketId, history);
  }

  // ─── Conversion to ArbitrageOpportunity ─────────────────────

  /**
   * Convert stale candidates to ArbitrageOpportunity format
   */
  toOpportunities(candidates: StaleCandidate[], idCounter: { value: number }): ArbitrageOpportunity[] {
    return candidates.map(c => {
      const edge = Math.abs(c.expectedProbability - c.currentProbability);
      const side = c.expectedProbability > c.currentProbability ? 'YES' : 'NO';

      const arbType: ArbitrageType = c.signalSource === 'news_event'
        ? 'news_driven'
        : c.signalSource === 'sharp_line'
          ? 'sharp_divergence'
          : 'stale_price';

      return {
        id: `opp_${++idCounter.value}`,
        type: arbType,
        polymarketMarket: c.market,
        polymarketProbability: side === 'YES' ? c.currentProbability : (1 - c.currentProbability),
        fairProbability: side === 'YES' ? c.expectedProbability : (1 - c.expectedProbability),
        edgePercent: edge * 100,
        side,
        recommendedSize: 0,
        expectedValue: 0,
        claudeConfidence: 0.6, // Medium confidence for stale detection
        claudeReasoning: c.reason,
        availableLiquidity: c.market.liquidity,
        discoveredAt: Date.now(),
        timeToCloseMs: new Date(c.market.endDate).getTime() - Date.now(),
        signalSource: c.signalSource,
      };
    });
  }

  // ─── Helpers ────────────────────────────────────────────────

  /**
   * Rough win probability estimation from score differential and period
   * More sophisticated version would use pre-computed Dixon-Coles tables
   */
  private estimateWinProbFromScore(scoreDiff: number, period: string): number {
    // Simple logistic model based on score differential
    // This is a placeholder - production would use pre-computed lookup tables
    const periodWeight = this.getPeriodWeight(period);
    const adjustedDiff = scoreDiff * periodWeight;

    // Logistic function centered at 0.5
    return 1 / (1 + Math.exp(-adjustedDiff * 0.5));
  }

  /**
   * How much weight a score differential carries based on game progress
   * Early in the game = less decisive, late = more decisive
   */
  private getPeriodWeight(period: string): number {
    const p = period.toLowerCase();
    if (p.includes('1st') || p === '1') return 0.3;
    if (p.includes('2nd') || p === '2') return 0.5;
    if (p.includes('3rd') || p === '3') return 0.8;
    if (p.includes('4th') || p === '4' || p.includes('final')) return 1.5;
    if (p.includes('ot') || p.includes('overtime')) return 2.0;
    if (p.includes('half')) return 0.5;
    return 0.5;
  }
}
