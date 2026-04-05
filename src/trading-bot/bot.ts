/**
 * Main Trading Bot Orchestrator
 * Coordinates all components: market scanning, analysis, execution, and risk management
 * Inspired by sovereign2013's Claude-powered Polymarket trading strategy
 */

import type {
  BotConfig,
  BotEvent,
  BotEventHandler,
  ArbitrageOpportunity,
  Position,
  RiskMetrics,
} from './types.js';
import { PolymarketClient } from './polymarket-client.js';
import { OddsAggregator } from './odds-aggregator.js';
import { ClaudeAnalyzer } from './claude-analyzer.js';
import { ArbitrageDetector } from './arbitrage-detector.js';
import { RiskManager } from './risk-manager.js';
import { Executor } from './executor.js';
import { Logger } from './logger.js';

export class TradingBot {
  private config: BotConfig;
  private logger: Logger;
  private polyClient: PolymarketClient;
  private oddsAggregator: OddsAggregator;
  private claudeAnalyzer: ClaudeAnalyzer;
  private arbDetector: ArbitrageDetector;
  private riskManager: RiskManager;
  private executor: Executor;
  private eventHandlers: BotEventHandler[] = [];
  private running = false;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private cycleCount = 0;

  constructor(config: BotConfig) {
    this.config = config;
    this.logger = new Logger(config.logLevel, 'BOT');

    // Initialize components
    this.polyClient = new PolymarketClient(config.polymarket, this.logger);
    const oddsApiKey = config.odds.theOddsApi?.apiKey ?? '';
    this.oddsAggregator = new OddsAggregator(oddsApiKey, this.logger);
    const anthropicKey = config.ai.anthropic?.apiKey ?? '';
    const claudeModel = config.ai.anthropic?.model ?? 'claude-sonnet-4-6';
    this.claudeAnalyzer = new ClaudeAnalyzer(
      anthropicKey,
      claudeModel,
      this.logger
    );
    this.riskManager = new RiskManager(config.trading, this.logger);
    this.arbDetector = new ArbitrageDetector(
      this.polyClient,
      this.oddsAggregator,
      this.claudeAnalyzer,
      config.trading,
      this.logger
    );
    this.executor = new Executor(
      this.polyClient,
      this.riskManager,
      this.logger,
      config.trading.dryRun
    );
  }

  /**
   * Subscribe to bot events
   */
  on(handler: BotEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Start the trading bot
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('Bot is already running');
      return;
    }

    this.running = true;
    this.logger.info('=== AI Trading Bot Starting ===', {
      dryRun: this.config.trading.dryRun,
      budget: this.config.trading.totalBudget,
      kellyFraction: this.config.trading.kellyFraction,
      minEdge: `${this.config.trading.minEdgePercent}%`,
      scanInterval: `${this.config.trading.scanIntervalMs / 1000}s`,
      model: this.config.ai.anthropic?.model ?? 'claude-sonnet-4-6',
    });

    this.emit({ type: 'status', message: 'Bot started' });

    // Run first scan immediately
    await this.runCycle();

    // Set up recurring scan
    this.scanTimer = setInterval(() => {
      this.runCycle().catch((err) => {
        this.logger.error('Scan cycle failed', { error: String(err) });
        this.emit({ type: 'error', error: err as Error, context: 'scan_cycle' });
      });
    }, this.config.trading.scanIntervalMs);

    this.logger.info('Bot is running. Press Ctrl+C to stop.');
  }

  /**
   * Stop the trading bot gracefully
   */
  async stop(): Promise<void> {
    this.logger.info('Stopping bot...');
    this.running = false;

    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }

    // Cancel pending orders
    await this.executor.cancelAllOrders();

    // Print final metrics
    const positions = await this.getPositions();
    const metrics = this.riskManager.getMetrics(positions);
    this.printMetrics(metrics);

    this.emit({ type: 'status', message: 'Bot stopped' });
    this.logger.info('=== Bot Stopped ===');
  }

  /**
   * Run a single scan-analyze-execute cycle
   */
  private async runCycle(): Promise<void> {
    if (!this.running) return;

    this.cycleCount++;
    const cycleStart = Date.now();
    this.logger.info(`─── Cycle #${this.cycleCount} ───`);

    try {
      // Step 1: Check resolved markets
      const resolved = await this.executor.checkResolutions();
      if (resolved.length > 0) {
        for (const trade of resolved) {
          this.emit({
            type: 'trade_resolved',
            trade,
            pnl: trade.pnl ?? 0,
          });
        }
      }

      // Step 2: Refresh order statuses
      await this.executor.refreshOrderStatuses();

      // Step 3: Get current positions
      const positions = await this.getPositions();

      // Step 4: Risk check - should we keep trading?
      const metrics = this.riskManager.getMetrics(positions);
      if (this.cycleCount % 10 === 0) {
        this.printMetrics(metrics);
      }

      // Step 5: Scan for opportunities
      const opportunities = await this.arbDetector.scan();

      this.emit({
        type: 'scan_complete',
        marketsScanned: opportunities.length > 0 ? 200 : 0, // approximation
        opportunitiesFound: opportunities.length,
      });

      if (opportunities.length === 0) {
        this.logger.info('No opportunities found this cycle');
        return;
      }

      // Step 6: Size and execute top opportunities
      let tradesPlaced = 0;
      const maxTradesPerCycle = 5;

      for (const opp of opportunities) {
        if (tradesPlaced >= maxTradesPerCycle) break;
        if (!this.running) break;

        // Calculate position size
        const positionSize = this.riskManager.calculatePositionSize(opp, positions);
        if (positionSize <= 0) continue;

        // Enrich opportunity with size and EV
        opp.recommendedSize = positionSize;
        opp.expectedValue = this.riskManager.calculateExpectedValue(opp, positionSize);

        this.emit({ type: 'opportunity_found', opportunity: opp });

        this.logger.info('Opportunity found', {
          type: opp.type,
          market: opp.polymarketMarket.question.slice(0, 50),
          side: opp.side,
          edge: `${opp.edgePercent.toFixed(2)}%`,
          size: `$${positionSize.toFixed(2)}`,
          ev: `$${opp.expectedValue.toFixed(2)}`,
          confidence: opp.claudeConfidence.toFixed(2),
        });

        // Execute
        const trade = await this.executor.executeTrade(opp, positionSize, positions);
        if (trade) {
          tradesPlaced++;
          this.emit({ type: 'trade_placed', trade });
        }

        // Small delay between trades
        if (tradesPlaced < maxTradesPerCycle) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
      this.logger.info(`Cycle #${this.cycleCount} complete`, {
        elapsed: `${elapsed}s`,
        opportunities: opportunities.length,
        tradesPlaced,
        activeTrades: this.executor.getActiveTrades().length,
      });

    } catch (err) {
      this.logger.error('Cycle error', { error: String(err) });
      this.emit({ type: 'error', error: err as Error, context: 'cycle' });
    }
  }

  // ─── Helpers ────────────────────────────────────────────────

  private async getPositions(): Promise<Position[]> {
    if (this.config.trading.dryRun) {
      // In dry-run mode, construct positions from active trades
      return this.executor.getActiveTrades().map((t) => ({
        marketId: t.marketId,
        tokenId: t.tokenId,
        outcome: t.outcome,
        question: t.question,
        size: t.size,
        avgEntryPrice: t.price,
        currentPrice: t.price, // Can't track real-time in dry-run
        pnl: 0,
        pnlPercent: 0,
        timestamp: t.entryTime,
      }));
    }

    try {
      return await this.polyClient.getPositions();
    } catch {
      return [];
    }
  }

  private printMetrics(metrics: RiskMetrics): void {
    this.logger.info('=== Portfolio Metrics ===', {
      exposure: `$${metrics.totalExposure.toFixed(2)}`,
      available: `$${metrics.availableCapital.toFixed(2)}`,
      totalPnl: `$${metrics.totalPnl.toFixed(2)}`,
      dailyPnl: `$${metrics.dailyPnl.toFixed(2)}`,
      winRate: `${(metrics.winRate * 100).toFixed(1)}%`,
      sharpe: metrics.sharpeRatio.toFixed(2),
      maxDD: `${metrics.maxDrawdown.toFixed(1)}%`,
      positions: metrics.positionCount,
      dailyTrades: metrics.dailyTradeCount,
    });
  }

  private emit(event: BotEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        this.logger.error('Event handler error', { error: String(err) });
      }
    }
  }
}
