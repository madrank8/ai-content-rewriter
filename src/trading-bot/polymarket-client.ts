/**
 * Polymarket CLOB API Client
 * Handles market data fetching, order book queries, and order placement
 * Based on Polymarket's CLOB (Central Limit Order Book) on Polygon
 */

import { createHmac } from 'node:crypto';
import type {
  PolymarketMarket,
  OrderBook,
  OrderBookEntry,
  PolymarketOrder,
  PolymarketOrderType,
  Position,
} from './types.js';
import { Logger } from './logger.js';

interface PolymarketClientConfig {
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  privateKey: string;
  clobUrl: string;
  gammaUrl: string;
}

interface RawMarket {
  condition_id: string;
  question_id: string;
  question: string;
  description: string;
  category: string;
  end_date_iso: string;
  active: boolean;
  closed: boolean;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
    winner: boolean;
  }>;
  volume_num_fmt?: string;
  liquidity_num_fmt?: string;
  slug: string;
  outcomes: string;
  outcome_prices: string;
  [key: string]: unknown;
}

interface RawOrderBook {
  bids: Array<{ price: string; size: string }>;
  asks: Array<{ price: string; size: string }>;
}

export class PolymarketClient {
  private config: PolymarketClientConfig;
  private logger: Logger;
  private requestCount = 0;
  private windowStart = Date.now();

  constructor(config: PolymarketClientConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child('POLY');
  }

  // ─── Market Data ────────────────────────────────────────────

  /**
   * Fetch active sports markets from Polymarket Gamma API
   */
  async getSportsMarkets(limit = 100, offset = 0): Promise<PolymarketMarket[]> {
    const params = new URLSearchParams({
      active: 'true',
      closed: 'false',
      limit: String(limit),
      offset: String(offset),
      order: 'volume',
      ascending: 'false',
      // Filter for sports-related categories
      tag: 'sports',
    });

    const data = await this.gammaGet<RawMarket[]>(`/markets?${params}`);
    return data.map(this.normalizeMarket);
  }

  /**
   * Fetch a specific market by condition ID
   */
  async getMarket(conditionId: string): Promise<PolymarketMarket> {
    const data = await this.gammaGet<RawMarket>(`/markets/${conditionId}`);
    return this.normalizeMarket(data);
  }

  /**
   * Search markets by query string
   */
  async searchMarkets(query: string, limit = 50): Promise<PolymarketMarket[]> {
    const params = new URLSearchParams({
      active: 'true',
      closed: 'false',
      limit: String(limit),
      // Text search
      _q: query,
    });

    const data = await this.gammaGet<RawMarket[]>(`/markets?${params}`);
    return data.map(this.normalizeMarket);
  }

  /**
   * Fetch markets closing soon (higher urgency for arbitrage)
   */
  async getMarketsClosingSoon(withinHours = 24): Promise<PolymarketMarket[]> {
    const cutoff = new Date(Date.now() + withinHours * 3600_000).toISOString();
    const params = new URLSearchParams({
      active: 'true',
      closed: 'false',
      end_date_max: cutoff,
      order: 'end_date',
      ascending: 'true',
      limit: '100',
    });

    const data = await this.gammaGet<RawMarket[]>(`/markets?${params}`);
    return data.map(this.normalizeMarket);
  }

  // ─── Order Book ─────────────────────────────────────────────

  /**
   * Fetch the order book for a specific token
   */
  async getOrderBook(tokenId: string): Promise<OrderBook> {
    const data = await this.clobGet<RawOrderBook>(`/book?token_id=${tokenId}`);

    const bids: OrderBookEntry[] = (data.bids ?? []).map((b) => ({
      price: Number(b.price),
      size: Number(b.size),
    }));

    const asks: OrderBookEntry[] = (data.asks ?? []).map((a) => ({
      price: Number(a.price),
      size: Number(a.size),
    }));

    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 1;

    return {
      bids,
      asks,
      spread: bestAsk - bestBid,
      midPrice: (bestBid + bestAsk) / 2,
      timestamp: Date.now(),
    };
  }

  /**
   * Get available liquidity at or better than a target price
   */
  getAvailableLiquidity(book: OrderBook, side: 'BUY' | 'SELL', targetPrice: number): number {
    const entries = side === 'BUY' ? book.asks : book.bids;
    let totalSize = 0;

    for (const entry of entries) {
      if (side === 'BUY' && entry.price > targetPrice) break;
      if (side === 'SELL' && entry.price < targetPrice) break;
      totalSize += entry.size * entry.price;
    }

    return totalSize;
  }

  // ─── Order Management ───────────────────────────────────────

  /**
   * Place an order on the CLOB with proper order type support
   * Supports GTC, GTD, FOK, FAK order types
   */
  async placeOrder(order: PolymarketOrder): Promise<PolymarketOrder> {
    this.logger.info('Placing order', {
      market: order.marketId,
      side: order.side,
      price: order.price,
      size: order.size,
      orderType: order.orderType,
      postOnly: order.postOnly,
    });

    const payload: Record<string, unknown> = {
      tokenID: order.tokenId,
      price: order.price,
      size: order.size,
      side: order.side,
      orderType: order.orderType ?? 'GTC',
    };

    // GTD orders need an expiration timestamp
    if (order.orderType === 'GTD' && order.expiration) {
      payload['expiration'] = order.expiration;
    }

    // Tick size and neg_risk are required for proper order creation
    if (order.tickSize) payload['tickSize'] = order.tickSize;
    if (order.negRisk !== undefined) payload['negRisk'] = order.negRisk;

    // Post-only flag for market making (rejected if it would cross spread)
    if (order.postOnly) payload['postOnly'] = true;

    const result = await this.clobPost<{ orderID: string; status: string }>('/order', payload);

    return {
      ...order,
      id: result.orderID,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Get tick size for a market (required for order creation)
   */
  async getTickSize(tokenId: string): Promise<string> {
    const data = await this.clobGet<{ minimum_tick_size: string }>(`/tick-size?token_id=${tokenId}`);
    return data.minimum_tick_size ?? '0.01';
  }

  /**
   * Check if a market uses the negative risk model
   */
  async getNegRisk(tokenId: string): Promise<boolean> {
    const data = await this.clobGet<{ neg_risk: boolean }>(`/neg-risk?token_id=${tokenId}`);
    return data.neg_risk ?? false;
  }

  /**
   * Cancel an existing order
   */
  async cancelOrder(orderId: string): Promise<void> {
    await this.clobDelete(`/order/${orderId}`);
    this.logger.info('Order cancelled', { orderId });
  }

  /**
   * Get open orders
   */
  async getOpenOrders(): Promise<PolymarketOrder[]> {
    return this.clobGet<PolymarketOrder[]>('/orders?status=open');
  }

  /**
   * Get current positions
   */
  async getPositions(): Promise<Position[]> {
    return this.clobGet<Position[]>('/positions');
  }

  // ─── Price Utilities ────────────────────────────────────────

  /**
   * Get the effective fill price for a given size
   * Walks the order book to calculate slippage
   */
  getEffectiveFillPrice(book: OrderBook, side: 'BUY' | 'SELL', sizeUsdc: number): number {
    const entries = side === 'BUY' ? book.asks : book.bids;
    let remainingSize = sizeUsdc;
    let totalCost = 0;
    let totalShares = 0;

    for (const entry of entries) {
      const entryValueUsdc = entry.size * entry.price;
      const fillAmount = Math.min(remainingSize, entryValueUsdc);
      const shares = fillAmount / entry.price;

      totalCost += fillAmount;
      totalShares += shares;
      remainingSize -= fillAmount;

      if (remainingSize <= 0) break;
    }

    if (totalShares === 0) return side === 'BUY' ? 1 : 0;
    return totalCost / totalShares;
  }

  // ─── HTTP Methods ───────────────────────────────────────────

  private async gammaGet<T>(path: string): Promise<T> {
    await this.rateLimit();
    const url = `${this.config.gammaUrl}${path}`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`Gamma API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  private async clobGet<T>(path: string): Promise<T> {
    await this.rateLimit();
    const url = `${this.config.clobUrl}${path}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = this.sign('GET', path, timestamp);

    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'POLY_API_KEY': this.config.apiKey,
        'POLY_SIGNATURE': signature,
        'POLY_TIMESTAMP': timestamp,
        'POLY_PASSPHRASE': this.config.apiPassphrase,
      },
    });
    if (!res.ok) {
      throw new Error(`CLOB API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  private async clobPost<T>(path: string, body: unknown): Promise<T> {
    await this.rateLimit();
    const url = `${this.config.clobUrl}${path}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyStr = JSON.stringify(body);
    const signature = this.sign('POST', path, timestamp, bodyStr);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'POLY_API_KEY': this.config.apiKey,
        'POLY_SIGNATURE': signature,
        'POLY_TIMESTAMP': timestamp,
        'POLY_PASSPHRASE': this.config.apiPassphrase,
      },
      body: bodyStr,
    });
    if (!res.ok) {
      throw new Error(`CLOB API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  private async clobDelete(path: string): Promise<void> {
    await this.rateLimit();
    const url = `${this.config.clobUrl}${path}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = this.sign('DELETE', path, timestamp);

    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        'POLY_API_KEY': this.config.apiKey,
        'POLY_SIGNATURE': signature,
        'POLY_TIMESTAMP': timestamp,
        'POLY_PASSPHRASE': this.config.apiPassphrase,
      },
    });
    if (!res.ok) {
      throw new Error(`CLOB API error ${res.status}: ${await res.text()}`);
    }
  }

  // ─── Auth & Rate Limiting ───────────────────────────────────

  private sign(method: string, path: string, timestamp: string, body = ''): string {
    const message = timestamp + method + path + body;
    return createHmac('sha256', Buffer.from(this.config.apiSecret, 'base64'))
      .update(message)
      .digest('base64');
  }

  /**
   * Simple rate limiter: max 900 requests per 10 seconds (conservative vs 9000 limit)
   */
  private async rateLimit(): Promise<void> {
    const now = Date.now();
    if (now - this.windowStart > 10_000) {
      this.requestCount = 0;
      this.windowStart = now;
    }

    this.requestCount++;
    if (this.requestCount >= 900) {
      const waitMs = 10_000 - (now - this.windowStart) + 100;
      this.logger.debug(`Rate limit pause: ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.requestCount = 0;
      this.windowStart = Date.now();
    }
  }

  // ─── Normalization ──────────────────────────────────────────

  private normalizeMarket = (raw: RawMarket): PolymarketMarket => {
    const outcomes = typeof raw.outcomes === 'string' ? JSON.parse(raw.outcomes) as string[] : raw.outcomes;
    const outcomePrices = typeof raw.outcome_prices === 'string'
      ? (JSON.parse(raw.outcome_prices) as string[]).map(Number)
      : (raw.outcome_prices as unknown as number[]);

    return {
      id: raw.condition_id,
      conditionId: raw.condition_id,
      questionId: raw.question_id,
      question: raw.question,
      description: raw.description ?? '',
      category: raw.category ?? '',
      endDate: raw.end_date_iso,
      active: raw.active,
      closed: raw.closed,
      tokens: (raw.tokens ?? []).map((t) => ({
        tokenId: t.token_id,
        outcome: t.outcome,
        price: Number(t.price),
        winner: t.winner,
      })),
      volume: Number(raw.volume_num_fmt ?? 0),
      liquidity: Number(raw.liquidity_num_fmt ?? 0),
      slug: raw.slug,
      outcomes: outcomes ?? [],
      outcomePrices: outcomePrices ?? [],
    };
  };
}
