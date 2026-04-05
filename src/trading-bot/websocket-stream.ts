/**
 * Polymarket WebSocket Real-Time Streaming
 *
 * Connects to Polymarket's CLOB WebSocket for:
 * - Real-time order book updates (sub-second)
 * - Price changes and trade notifications
 * - Market resolution events
 *
 * WebSocket URL: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * User channel:  wss://ws-subscriptions-clob.polymarket.com/ws/user
 */

import WebSocket from 'ws';
import type { OrderBook, OrderBookEntry, BotEventHandler } from './types.js';
import { Logger } from './logger.js';

interface WSMessage {
  event_type: string;
  asset_id?: string;
  market?: string;
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
  price?: string;
  side?: string;
  size?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface OrderBookUpdate {
  tokenId: string;
  book: OrderBook;
}

export type WSEventHandler = (event: WSMessage) => void;

export class PolymarketWebSocket {
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private logger: Logger;
  private subscribedTokens: Set<string> = new Set();
  private localBooks: Map<string, OrderBook> = new Map();
  private handlers: Map<string, WSEventHandler[]> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private connected = false;

  constructor(wsUrl: string, logger: Logger) {
    this.wsUrl = wsUrl;
    this.logger = logger.child('WS');
  }

  /**
   * Connect to the Polymarket market WebSocket channel
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.wsUrl}/market`;
      this.logger.info(`Connecting to ${url}`);

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.logger.info('WebSocket connected');

        // Start keepalive ping
        this.pingInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send('PING');
          }
        }, 5000);

        // Re-subscribe to previously subscribed tokens
        if (this.subscribedTokens.size > 0) {
          this.subscribeToTokens(Array.from(this.subscribedTokens));
        }

        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const raw = data.toString();
          if (raw === 'PONG' || raw === 'pong') return;

          const msg = JSON.parse(raw) as WSMessage;
          this.handleMessage(msg);
        } catch (err) {
          this.logger.debug('Failed to parse WS message', { error: String(err) });
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        this.connected = false;
        this.logger.warn(`WebSocket closed: ${code} ${reason.toString()}`);
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        this.attemptReconnect();
      });

      this.ws.on('error', (err: Error) => {
        this.logger.error('WebSocket error', { error: err.message });
        if (!this.connected) reject(err);
      });
    });
  }

  /**
   * Subscribe to real-time order book updates for specific tokens
   */
  subscribeToTokens(tokenIds: string[]): void {
    for (const id of tokenIds) {
      this.subscribedTokens.add(id);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      const msg = JSON.stringify({
        assets_ids: tokenIds,
        type: 'market',
        custom_feature_enabled: true,
      });
      this.ws.send(msg);
      this.logger.debug(`Subscribed to ${tokenIds.length} tokens`);
    }
  }

  /**
   * Unsubscribe from tokens
   */
  unsubscribeFromTokens(tokenIds: string[]): void {
    for (const id of tokenIds) {
      this.subscribedTokens.delete(id);
      this.localBooks.delete(id);
    }
  }

  /**
   * Register event handler for specific event types
   */
  on(eventType: string, handler: WSEventHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  /**
   * Get locally-maintained order book (updated in real-time via WebSocket)
   */
  getLocalBook(tokenId: string): OrderBook | null {
    return this.localBooks.get(tokenId) ?? null;
  }

  /**
   * Get all locally-maintained order books
   */
  getAllLocalBooks(): Map<string, OrderBook> {
    return new Map(this.localBooks);
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.logger.info('WebSocket disconnected');
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  // ─── Message Handling ───────────────────────────────────────

  private handleMessage(msg: WSMessage): void {
    const tokenId = msg.asset_id;

    switch (msg.event_type) {
      case 'book':
        if (tokenId) this.handleBookSnapshot(tokenId, msg);
        break;
      case 'price_change':
        if (tokenId) this.handlePriceChange(tokenId, msg);
        break;
      case 'last_trade_price':
        if (tokenId) this.handleLastTrade(tokenId, msg);
        break;
      case 'best_bid_ask':
        if (tokenId) this.handleBestBidAsk(tokenId, msg);
        break;
      case 'market_resolved':
        this.handleMarketResolved(msg);
        break;
      case 'tick_size_change':
        break; // Log only
    }

    // Dispatch to registered handlers
    const handlers = this.handlers.get(msg.event_type) ?? [];
    for (const handler of handlers) {
      try { handler(msg); } catch { /* ignore handler errors */ }
    }

    // Also dispatch to wildcard handlers
    const wildcardHandlers = this.handlers.get('*') ?? [];
    for (const handler of wildcardHandlers) {
      try { handler(msg); } catch { /* ignore */ }
    }
  }

  private handleBookSnapshot(tokenId: string, msg: WSMessage): void {
    const bids: OrderBookEntry[] = (msg.bids ?? []).map(b => ({
      price: Number(b.price),
      size: Number(b.size),
    })).sort((a, b) => b.price - a.price);

    const asks: OrderBookEntry[] = (msg.asks ?? []).map(a => ({
      price: Number(a.price),
      size: Number(a.size),
    })).sort((a, b) => a.price - b.price);

    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 1;

    this.localBooks.set(tokenId, {
      bids,
      asks,
      spread: bestAsk - bestBid,
      midPrice: (bestBid + bestAsk) / 2,
      timestamp: msg.timestamp ?? Date.now(),
    });
  }

  private handlePriceChange(tokenId: string, msg: WSMessage): void {
    // Update existing local book with the price level change
    const book = this.localBooks.get(tokenId);
    if (!book) return;

    // Price change contains updated best bid/ask
    if (msg.price) {
      book.timestamp = msg.timestamp ?? Date.now();
      if (book.bids.length > 0 && book.asks.length > 0) {
        book.spread = book.asks[0]!.price - book.bids[0]!.price;
        book.midPrice = (book.bids[0]!.price + book.asks[0]!.price) / 2;
      }
    }
  }

  private handleLastTrade(_tokenId: string, _msg: WSMessage): void {
    // Trade notifications can be used for VPIN calculation
    // Handled by VPIN analyzer via event handlers
  }

  private handleBestBidAsk(tokenId: string, msg: WSMessage): void {
    const book = this.localBooks.get(tokenId);
    if (!book) return;

    // Quick update to spread/midPrice
    book.timestamp = msg.timestamp ?? Date.now();
  }

  private handleMarketResolved(msg: WSMessage): void {
    this.logger.info('Market resolved via WebSocket', { market: msg.market });
  }

  // ─── Reconnection Logic ────────────────────────────────────

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30000);

    this.logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch(err => {
        this.logger.error('Reconnection failed', { error: String(err) });
      });
    }, delay);
  }
}
