/**
 * Order Execution Engine
 * Handles order placement, monitoring, and trade lifecycle management
 * Supports dry-run mode for paper trading
 */

import type {
  ArbitrageOpportunity,
  PolymarketOrder,
  TradeRecord,
  Position,
} from './types.js';
import type { PolymarketClient } from './polymarket-client.js';
import type { RiskManager } from './risk-manager.js';
import { Logger } from './logger.js';

export class Executor {
  private polyClient: PolymarketClient;
  private riskManager: RiskManager;
  private logger: Logger;
  private dryRun: boolean;
  private pendingOrders: Map<string, PolymarketOrder> = new Map();
  private activeTrades: Map<string, TradeRecord> = new Map();
  private tradeCounter = 0;

  constructor(
    polyClient: PolymarketClient,
    riskManager: RiskManager,
    logger: Logger,
    dryRun: boolean
  ) {
    this.polyClient = polyClient;
    this.riskManager = riskManager;
    this.logger = logger.child('EXEC');
    this.dryRun = dryRun;

    if (this.dryRun) {
      this.logger.warn('Running in DRY-RUN mode - no real orders will be placed');
    }
  }

  /**
   * Execute a trade for an arbitrage opportunity
   */
  async executeTrade(
    opportunity: ArbitrageOpportunity,
    positionSize: number,
    positions: Position[]
  ): Promise<TradeRecord | null> {
    // Final risk check
    const riskCheck = this.riskManager.checkTradeAllowed(opportunity, positionSize, positions);
    if (riskCheck) {
      this.logger.warn('Trade blocked by risk manager', { reason: riskCheck });
      return null;
    }

    const market = opportunity.polymarketMarket;
    const tokenIndex = opportunity.side === 'YES' ? 0 : 1;
    const token = market.tokens[tokenIndex];
    if (!token) {
      this.logger.error('Token not found', { side: opportunity.side, market: market.id });
      return null;
    }

    const price = opportunity.polymarketProbability;
    const shares = Math.floor(positionSize / price);

    if (shares <= 0) {
      this.logger.warn('Position too small', { positionSize, price });
      return null;
    }

    const order: PolymarketOrder = {
      marketId: market.id,
      tokenId: token.tokenId,
      side: 'BUY',
      price,
      size: shares,
      type: 'LIMIT',
    };

    const tradeId = `trade_${++this.tradeCounter}_${Date.now()}`;

    const trade: TradeRecord = {
      id: tradeId,
      marketId: market.id,
      tokenId: token.tokenId,
      question: market.question,
      side: 'BUY',
      outcome: opportunity.side,
      price,
      size: shares,
      cost: shares * price,
      status: 'OPEN',
      entryTime: Date.now(),
      arbType: opportunity.type,
      claudeConfidence: opportunity.claudeConfidence,
      claudeReasoning: opportunity.claudeReasoning,
    };

    if (this.dryRun) {
      this.logger.info('[DRY-RUN] Trade executed', {
        tradeId,
        market: market.question.slice(0, 50),
        side: opportunity.side,
        shares,
        price: price.toFixed(3),
        cost: trade.cost.toFixed(2),
        edge: `${opportunity.edgePercent.toFixed(2)}%`,
        type: opportunity.type,
      });
    } else {
      try {
        const placedOrder = await this.polyClient.placeOrder(order);
        trade.id = placedOrder.id ?? tradeId;
        this.pendingOrders.set(trade.id, placedOrder);

        this.logger.info('Order placed', {
          orderId: placedOrder.id,
          market: market.question.slice(0, 50),
          side: opportunity.side,
          shares,
          price: price.toFixed(3),
          cost: trade.cost.toFixed(2),
        });
      } catch (err) {
        this.logger.error('Order placement failed', {
          error: String(err),
          market: market.id,
        });
        return null;
      }
    }

    this.activeTrades.set(trade.id, trade);
    this.riskManager.recordTrade(trade);

    return trade;
  }

  /**
   * Cancel an active order
   */
  async cancelTrade(tradeId: string): Promise<boolean> {
    const trade = this.activeTrades.get(tradeId);
    if (!trade) return false;

    if (!this.dryRun) {
      try {
        await this.polyClient.cancelOrder(tradeId);
      } catch (err) {
        this.logger.error('Cancel failed', { tradeId, error: String(err) });
        return false;
      }
    }

    trade.status = 'CLOSED';
    trade.exitTime = Date.now();
    trade.pnl = 0;
    this.activeTrades.delete(tradeId);
    this.pendingOrders.delete(tradeId);

    this.logger.info('Trade cancelled', { tradeId });
    return true;
  }

  /**
   * Check and update status of pending orders
   */
  async refreshOrderStatuses(): Promise<void> {
    if (this.dryRun) return;

    try {
      const openOrders = await this.polyClient.getOpenOrders();
      const openOrderIds = new Set(openOrders.map((o) => o.id));

      // Check if any pending orders have been filled (no longer in open orders)
      for (const [orderId, _order] of this.pendingOrders) {
        if (!openOrderIds.has(orderId)) {
          const trade = this.activeTrades.get(orderId);
          if (trade) {
            this.logger.info('Order filled', { orderId, market: trade.question.slice(0, 40) });
            this.pendingOrders.delete(orderId);
          }
        }
      }
    } catch (err) {
      this.logger.warn('Failed to refresh order statuses', { error: String(err) });
    }
  }

  /**
   * Check for resolved markets and record results
   */
  async checkResolutions(): Promise<TradeRecord[]> {
    const resolved: TradeRecord[] = [];

    for (const [tradeId, trade] of this.activeTrades) {
      if (trade.status !== 'OPEN') continue;

      try {
        const market = await this.polyClient.getMarket(trade.marketId);

        if (market.closed) {
          const winningToken = market.tokens.find((t) => t.winner);
          const won = winningToken?.tokenId === trade.tokenId;
          const pnl = won ? (trade.size * 1 - trade.cost) : -trade.cost;

          trade.status = won ? 'WON' : 'LOST';
          trade.pnl = pnl;
          trade.exitTime = Date.now();

          this.riskManager.recordTradeResult(tradeId, pnl, won);
          this.activeTrades.delete(tradeId);
          resolved.push(trade);

          this.logger.info('Trade resolved', {
            tradeId,
            market: trade.question.slice(0, 40),
            won,
            pnl: pnl.toFixed(2),
          });
        }
      } catch {
        // Market might not be resolved yet
      }
    }

    return resolved;
  }

  /**
   * Get all active trades
   */
  getActiveTrades(): TradeRecord[] {
    return Array.from(this.activeTrades.values());
  }

  /**
   * Get trade count
   */
  getTradeCount(): number {
    return this.tradeCounter;
  }

  /**
   * Emergency: cancel all pending orders
   */
  async cancelAllOrders(): Promise<void> {
    this.logger.warn('Cancelling all pending orders');

    const cancellations = Array.from(this.pendingOrders.keys()).map((id) =>
      this.cancelTrade(id).catch((err) =>
        this.logger.error('Failed to cancel', { id, error: String(err) })
      )
    );

    await Promise.allSettled(cancellations);
  }
}
