/**
 * Arbitrage Detection Engine
 * Identifies mispricings between Polymarket and external sportsbooks,
 * multi-outcome arbs, and AI-detected value opportunities
 */

import type {
  ArbitrageOpportunity,
  ArbitrageType,
  PolymarketMarket,
  OrderBook,
  SportsEvent,
  MarketAnalysis,
} from './types.js';
import type { PolymarketClient } from './polymarket-client.js';
import type { OddsAggregator } from './odds-aggregator.js';
import type { ClaudeAnalyzer } from './claude-analyzer.js';
import type { TradingConfig } from './types.js';
import { Logger } from './logger.js';

export class ArbitrageDetector {
  private polyClient: PolymarketClient;
  private oddsAggregator: OddsAggregator;
  private claudeAnalyzer: ClaudeAnalyzer;
  private config: TradingConfig;
  private logger: Logger;
  private opportunityCounter = 0;

  constructor(
    polyClient: PolymarketClient,
    oddsAggregator: OddsAggregator,
    claudeAnalyzer: ClaudeAnalyzer,
    config: TradingConfig,
    logger: Logger
  ) {
    this.polyClient = polyClient;
    this.oddsAggregator = oddsAggregator;
    this.claudeAnalyzer = claudeAnalyzer;
    this.config = config;
    this.logger = logger.child('ARB');
  }

  /**
   * Main scan loop - finds all arbitrage opportunities
   */
  async scan(): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];

    // Fetch data in parallel
    const [sportsMarkets, closingMarkets, externalOdds] = await Promise.all([
      this.polyClient.getSportsMarkets(200),
      this.polyClient.getMarketsClosingSoon(48),
      this.oddsAggregator.getAllSportsOdds(),
    ]);

    // Combine and deduplicate markets
    const allMarkets = this.deduplicateMarkets([...sportsMarkets, ...closingMarkets]);

    this.logger.info(`Scanning ${allMarkets.length} markets against ${externalOdds.length} external events`);

    // Phase 1: Cross-platform arbitrage detection (fast, no AI needed)
    const crossPlatformOpps = await this.findCrossPlatformArbs(allMarkets, externalOdds);
    opportunities.push(...crossPlatformOpps);

    // Phase 2: Multi-outcome arbitrage (fast check)
    const multiOutcomeOpps = this.findMultiOutcomeArbs(allMarkets);
    opportunities.push(...multiOutcomeOpps);

    // Phase 3: AI-powered mispricing detection (slower, uses Claude)
    // Only analyze markets that look promising based on quick heuristics
    const candidatesForAI = this.prefilterForAIAnalysis(allMarkets, externalOdds);
    const aiOpps = await this.findAIMispricings(candidatesForAI, externalOdds);
    opportunities.push(...aiOpps);

    // Sort by expected value
    opportunities.sort((a, b) => b.expectedValue - a.expectedValue);

    this.logger.info(`Found ${opportunities.length} opportunities`, {
      crossPlatform: crossPlatformOpps.length,
      multiOutcome: multiOutcomeOpps.length,
      aiDetected: aiOpps.length,
    });

    return opportunities;
  }

  // ─── Cross-Platform Arbitrage ───────────────────────────────

  /**
   * Compare Polymarket prices with sportsbook odds to find discrepancies
   */
  private async findCrossPlatformArbs(
    markets: PolymarketMarket[],
    externalOdds: SportsEvent[]
  ): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];

    for (const market of markets) {
      // Try to match with external event
      const matchedEvent = this.oddsAggregator.matchPolymarketToEvent(
        market.question,
        externalOdds
      );
      if (!matchedEvent) continue;

      // Get consensus probability from sportsbooks (vig-removed)
      const consensus = this.oddsAggregator.getConsensusProbability(matchedEvent);
      const bestOdds = this.oddsAggregator.findBestOdds(matchedEvent);

      // Compare Polymarket YES price with sportsbook consensus
      const polyYesPrice = market.outcomePrices[0] ?? 0.5;
      const polyNoPrice = market.outcomePrices[1] ?? (1 - polyYesPrice);

      // Check if Polymarket underprices YES (buy YES opportunity)
      const yesEdge = consensus.home - polyYesPrice;
      if (yesEdge > this.config.minEdgePercent / 100) {
        const tokenId = market.tokens[0]?.tokenId;
        if (!tokenId) continue;

        let book: OrderBook;
        try {
          book = await this.polyClient.getOrderBook(tokenId);
        } catch {
          continue;
        }

        const liquidity = this.polyClient.getAvailableLiquidity(book, 'BUY', polyYesPrice + 0.03);
        if (liquidity < this.config.minLiquidityDepth) continue;

        opportunities.push(this.createOpportunity({
          type: 'cross_platform',
          market,
          polyProbability: polyYesPrice,
          fairProbability: consensus.home,
          edge: yesEdge,
          side: 'YES',
          liquidity,
          externalOdds: {
            bookmaker: bestOdds.home.bookmaker,
            impliedProbability: bestOdds.home.impliedProb,
            decimalOdds: bestOdds.home.odds,
          },
        }));
      }

      // Check if Polymarket underprices NO (buy NO opportunity)
      const noEdge = consensus.away - polyNoPrice;
      if (noEdge > this.config.minEdgePercent / 100) {
        const tokenId = market.tokens[1]?.tokenId;
        if (!tokenId) continue;

        let book: OrderBook;
        try {
          book = await this.polyClient.getOrderBook(tokenId);
        } catch {
          continue;
        }

        const liquidity = this.polyClient.getAvailableLiquidity(book, 'BUY', polyNoPrice + 0.03);
        if (liquidity < this.config.minLiquidityDepth) continue;

        opportunities.push(this.createOpportunity({
          type: 'cross_platform',
          market,
          polyProbability: polyNoPrice,
          fairProbability: consensus.away,
          edge: noEdge,
          side: 'NO',
          liquidity,
          externalOdds: {
            bookmaker: bestOdds.away.bookmaker,
            impliedProbability: bestOdds.away.impliedProb,
            decimalOdds: bestOdds.away.odds,
          },
        }));
      }
    }

    return opportunities;
  }

  // ─── Multi-Outcome Arbitrage ────────────────────────────────

  /**
   * Find markets where sum of outcome prices < 1.0 (underround)
   */
  private findMultiOutcomeArbs(markets: PolymarketMarket[]): ArbitrageOpportunity[] {
    const opportunities: ArbitrageOpportunity[] = [];

    for (const market of markets) {
      if (market.outcomePrices.length < 2) continue;

      const sumPrices = market.outcomePrices.reduce((a, b) => a + b, 0);

      // If sum < 1.0, buying all outcomes guarantees profit
      // We want sum < 0.98 for meaningful edge after fees
      if (sumPrices < 0.98) {
        const edge = 1 - sumPrices;
        // Find the cheapest outcome as primary trade
        const minPriceIdx = market.outcomePrices.indexOf(Math.min(...market.outcomePrices));
        const side = minPriceIdx === 0 ? 'YES' : 'NO';

        opportunities.push(this.createOpportunity({
          type: 'multi_outcome',
          market,
          polyProbability: market.outcomePrices[minPriceIdx] ?? 0.5,
          fairProbability: market.outcomePrices[minPriceIdx]! / sumPrices,
          edge,
          side,
          liquidity: market.liquidity,
        }));
      }
    }

    return opportunities;
  }

  // ─── AI-Powered Mispricing Detection ────────────────────────

  /**
   * Pre-filter markets that are good candidates for deep AI analysis
   */
  private prefilterForAIAnalysis(
    markets: PolymarketMarket[],
    externalOdds: SportsEvent[]
  ): { market: PolymarketMarket; event?: SportsEvent }[] {
    const candidates: { market: PolymarketMarket; event?: SportsEvent }[] = [];

    for (const market of markets) {
      // Skip very low liquidity markets
      if (market.liquidity < this.config.minLiquidityDepth * 2) continue;

      // Skip markets closing very soon (< 1 hour) - too risky
      const timeToClose = new Date(market.endDate).getTime() - Date.now();
      if (timeToClose < 3600_000) continue;

      // Find matching external event
      const event = this.oddsAggregator.matchPolymarketToEvent(market.question, externalOdds) ?? undefined;

      // Prioritize markets with external odds for comparison
      // Also include high-volume markets without external odds
      if (event || market.volume > 10_000) {
        candidates.push({ market, event });
      }
    }

    // Limit to top candidates to manage API costs
    return candidates.slice(0, 15);
  }

  /**
   * Use Claude to deeply analyze markets for mispricings
   */
  private async findAIMispricings(
    candidates: { market: PolymarketMarket; event?: SportsEvent }[],
    _externalOdds: SportsEvent[]
  ): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];

    // First pass: quick probability estimates
    const quickResults = await Promise.allSettled(
      candidates.map(({ market, event }) =>
        this.claudeAnalyzer.quickProbabilityEstimate(market, event)
          .then(result => ({ market, event, ...result }))
      )
    );

    // Filter for markets where Claude disagrees with the market price
    const deepCandidates: { market: PolymarketMarket; event?: SportsEvent }[] = [];

    for (const result of quickResults) {
      if (result.status !== 'fulfilled') continue;
      const { market, probability, confidence } = result.value;

      const marketPrice = market.outcomePrices[0] ?? 0.5;
      const disagreement = Math.abs(probability - marketPrice);

      // Only deep-analyze if Claude disagrees significantly and is somewhat confident
      if (disagreement > 0.05 && confidence > 0.3) {
        deepCandidates.push({
          market: result.value.market,
          event: result.value.event,
        });
      }
    }

    this.logger.info(`${deepCandidates.length}/${candidates.length} markets flagged for deep analysis`);

    // Second pass: deep analysis on flagged markets
    for (const { market, event } of deepCandidates.slice(0, 8)) {
      try {
        const tokenId = market.tokens[0]?.tokenId;
        const orderBook = tokenId
          ? await this.polyClient.getOrderBook(tokenId)
          : undefined;

        const analysis = await this.claudeAnalyzer.analyzeMarket({
          market,
          orderBook: orderBook!,
          externalOdds: event,
        });

        const marketPrice = market.outcomePrices[0] ?? 0.5;
        const edge = analysis.estimatedProbability - marketPrice;
        const absEdge = Math.abs(edge);

        if (absEdge > this.config.minEdgePercent / 100 && analysis.confidence > 0.4) {
          const side = edge > 0 ? 'YES' : 'NO';
          const sideProbability = side === 'YES' ? marketPrice : (1 - marketPrice);
          const fairProbability = side === 'YES'
            ? analysis.estimatedProbability
            : (1 - analysis.estimatedProbability);

          opportunities.push({
            id: `opp_${++this.opportunityCounter}`,
            type: 'mispricing',
            polymarketMarket: market,
            polymarketProbability: sideProbability,
            fairProbability,
            edgePercent: absEdge * 100,
            side,
            recommendedSize: 0, // Calculated by position sizer
            expectedValue: 0, // Calculated by position sizer
            claudeConfidence: analysis.confidence,
            claudeReasoning: analysis.reasoning,
            availableLiquidity: orderBook
              ? this.polyClient.getAvailableLiquidity(orderBook, 'BUY', sideProbability + 0.03)
              : market.liquidity,
            discoveredAt: Date.now(),
            timeToCloseMs: new Date(market.endDate).getTime() - Date.now(),
          });
        }
      } catch (err) {
        this.logger.warn('Deep analysis failed', {
          market: market.question.slice(0, 50),
          error: String(err),
        });
      }
    }

    return opportunities;
  }

  // ─── Helpers ────────────────────────────────────────────────

  private createOpportunity(params: {
    type: ArbitrageType;
    market: PolymarketMarket;
    polyProbability: number;
    fairProbability: number;
    edge: number;
    side: 'YES' | 'NO';
    liquidity: number;
    externalOdds?: ArbitrageOpportunity['externalOdds'];
  }): ArbitrageOpportunity {
    return {
      id: `opp_${++this.opportunityCounter}`,
      type: params.type,
      polymarketMarket: params.market,
      polymarketProbability: params.polyProbability,
      fairProbability: params.fairProbability,
      edgePercent: params.edge * 100,
      side: params.side,
      recommendedSize: 0, // Calculated by position sizer
      expectedValue: 0,
      claudeConfidence: 0,
      claudeReasoning: '',
      externalOdds: params.externalOdds,
      availableLiquidity: params.liquidity,
      discoveredAt: Date.now(),
      timeToCloseMs: new Date(params.market.endDate).getTime() - Date.now(),
    };
  }

  private deduplicateMarkets(markets: PolymarketMarket[]): PolymarketMarket[] {
    const seen = new Set<string>();
    return markets.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }
}
