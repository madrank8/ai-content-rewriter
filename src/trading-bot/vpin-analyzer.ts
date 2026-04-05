/**
 * VPIN (Volume-Synchronized Probability of Informed Trading) Analyzer
 * + Market Making Quote Engine
 *
 * VPIN detects informed trading flow by measuring the imbalance between
 * buy-initiated and sell-initiated volume. High VPIN = likely insider activity.
 *
 * Market Making uses Avellaneda-Stoikov framework adapted for binary markets:
 * - Post bid/ask around fair value
 * - Skew quotes based on inventory
 * - Widen spread when VPIN is elevated (adverse selection risk)
 *
 * Reference: Easley, Lopez de Prado, O'Hara (2012)
 */

import type {
  VPINState,
  MarketMakingQuote,
  OrderBook,
} from './types.js';
import { Logger } from './logger.js';

// ─── VPIN Volume Bucket ─────────────────────────────────────────

interface VolumeBucket {
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  timestamp: number;
}

interface TradeEvent {
  tokenId: string;
  price: number;
  size: number;
  side: 'buy' | 'sell';
  timestamp: number;
}

// ─── VPIN Analyzer ──────────────────────────────────────────────

export class VPINAnalyzer {
  private logger: Logger;

  /** Per-token VPIN state */
  private states: Map<string, {
    buckets: VolumeBucket[];
    currentBucket: VolumeBucket;
    bucketSize: number;
    maxBuckets: number;
    midPrice: number;
  }> = new Map();

  /** Default volume bucket size in USDC */
  private defaultBucketSize = 500;
  /** Number of buckets to track */
  private defaultMaxBuckets = 50;

  constructor(logger: Logger) {
    this.logger = logger.child('VPIN');
  }

  /**
   * Initialize VPIN tracking for a token
   */
  initToken(tokenId: string, bucketSize?: number, maxBuckets?: number): void {
    this.states.set(tokenId, {
      buckets: [],
      currentBucket: { buyVolume: 0, sellVolume: 0, totalVolume: 0, timestamp: Date.now() },
      bucketSize: bucketSize ?? this.defaultBucketSize,
      maxBuckets: maxBuckets ?? this.defaultMaxBuckets,
      midPrice: 0.5,
    });
  }

  /**
   * Process a trade event and update VPIN
   * Call this from WebSocket trade feed
   */
  processTrade(trade: TradeEvent): VPINState {
    let state = this.states.get(trade.tokenId);
    if (!state) {
      this.initToken(trade.tokenId);
      state = this.states.get(trade.tokenId)!;
    }

    state.midPrice = trade.price;
    const tradeVolume = trade.price * trade.size;

    // Classify trade direction using Lee-Ready algorithm
    // Trades above midpoint = buy-initiated, below = sell-initiated
    if (trade.side === 'buy') {
      state.currentBucket.buyVolume += tradeVolume;
    } else {
      state.currentBucket.sellVolume += tradeVolume;
    }
    state.currentBucket.totalVolume += tradeVolume;

    // Check if bucket is full
    if (state.currentBucket.totalVolume >= state.bucketSize) {
      state.buckets.push({ ...state.currentBucket });

      // Keep only maxBuckets
      if (state.buckets.length > state.maxBuckets) {
        state.buckets.shift();
      }

      // Reset current bucket
      state.currentBucket = { buyVolume: 0, sellVolume: 0, totalVolume: 0, timestamp: Date.now() };
    }

    return this.getState(trade.tokenId);
  }

  /**
   * Get current VPIN state for a token
   */
  getState(tokenId: string): VPINState {
    const state = this.states.get(tokenId);
    if (!state || state.buckets.length === 0) {
      return {
        tokenId,
        vpin: 0,
        buyVolume: 0,
        sellVolume: 0,
        bucketCount: 0,
        alertLevel: 'normal',
        lastUpdated: Date.now(),
      };
    }

    // VPIN = SUM(|V_buy - V_sell|) / (n * V_bucket)
    const n = state.buckets.length;
    const sumImbalance = state.buckets.reduce(
      (sum, b) => sum + Math.abs(b.buyVolume - b.sellVolume), 0
    );
    const vpin = sumImbalance / (n * state.bucketSize);

    const totalBuy = state.buckets.reduce((s, b) => s + b.buyVolume, 0);
    const totalSell = state.buckets.reduce((s, b) => s + b.sellVolume, 0);

    return {
      tokenId,
      vpin: Math.min(vpin, 1),
      buyVolume: totalBuy,
      sellVolume: totalSell,
      bucketCount: n,
      alertLevel: this.classifyAlert(vpin),
      lastUpdated: Date.now(),
    };
  }

  /**
   * Get VPIN for all tracked tokens
   */
  getAllStates(): Map<string, VPINState> {
    const result = new Map<string, VPINState>();
    for (const tokenId of this.states.keys()) {
      result.set(tokenId, this.getState(tokenId));
    }
    return result;
  }

  /**
   * Check if VPIN indicates dangerous level of informed trading
   */
  isHighRisk(tokenId: string): boolean {
    const state = this.getState(tokenId);
    return state.alertLevel === 'high' || state.alertLevel === 'critical';
  }

  private classifyAlert(vpin: number): VPINState['alertLevel'] {
    if (vpin >= 0.7) return 'critical';
    if (vpin >= 0.5) return 'high';
    if (vpin >= 0.3) return 'elevated';
    return 'normal';
  }
}

// ─── Market Making Quote Engine ─────────────────────────────────

/**
 * Avellaneda-Stoikov market making adapted for binary prediction markets
 *
 * Reservation price: r = s - q * γ * σ² * (T - t)
 * Optimal spread:    δ = γ * σ² * (T-t) + (2/γ) * ln(1 + γ/k)
 *
 * Where:
 *   s = mid price
 *   q = inventory (positive = long YES)
 *   γ = risk aversion parameter
 *   σ = volatility of the binary contract
 *   T-t = time to expiration
 *   k = order arrival intensity parameter
 */
export class MarketMaker {
  private logger: Logger;

  /** Risk aversion parameter (higher = wider spreads, less risk) */
  private gamma = 0.1;
  /** Order arrival intensity */
  private kappa = 1.5;

  /** Current inventory per token */
  private inventory: Map<string, number> = new Map();

  constructor(logger: Logger, gamma?: number, kappa?: number) {
    this.logger = logger.child('MM');
    if (gamma) this.gamma = gamma;
    if (kappa) this.kappa = kappa;
  }

  /**
   * Calculate optimal bid/ask quotes for a token
   *
   * @param tokenId - The token to quote
   * @param midPrice - Current mid price
   * @param timeToExpiryHours - Hours until market closes
   * @param vpin - Current VPIN (for adverse selection adjustment)
   * @param baseSize - Base position size for quotes
   */
  calculateQuotes(
    tokenId: string,
    midPrice: number,
    timeToExpiryHours: number,
    vpin: number,
    baseSize: number
  ): MarketMakingQuote {
    const q = this.inventory.get(tokenId) ?? 0; // Current inventory
    const T = timeToExpiryHours / 24; // Normalize to days
    const sigma = this.binaryVolatility(midPrice);

    // Avellaneda-Stoikov reservation price
    // r = s - q * γ * σ² * T
    const reservationPrice = midPrice - q * this.gamma * sigma * sigma * T;

    // Optimal spread
    // δ = γ * σ² * T + (2/γ) * ln(1 + γ/k)
    let optimalSpread = this.gamma * sigma * sigma * T +
      (2 / this.gamma) * Math.log(1 + this.gamma / this.kappa);

    // Widen spread based on VPIN (adverse selection protection)
    // High VPIN = informed traders, widen spread to avoid being picked off
    if (vpin > 0.3) {
      const vpinMultiplier = 1 + (vpin - 0.3) * 3; // Up to 3.1x wider at VPIN=1.0
      optimalSpread *= vpinMultiplier;
    }

    // Minimum spread (don't go below tick size practically)
    optimalSpread = Math.max(optimalSpread, 0.005);

    // Calculate bid and ask
    let bidPrice = reservationPrice - optimalSpread / 2;
    let askPrice = reservationPrice + optimalSpread / 2;

    // Clamp to valid price range
    bidPrice = Math.max(0.01, Math.min(0.99, bidPrice));
    askPrice = Math.max(0.01, Math.min(0.99, askPrice));

    // Ensure bid < ask
    if (bidPrice >= askPrice) {
      bidPrice = askPrice - 0.005;
    }

    // Inventory skew (reduce size on the side we're overweight)
    const inventorySkew = -q * 0.1; // Negative q means we're short, skew towards buying
    const bidSizeMultiplier = q > 0 ? Math.max(0.3, 1 - q / (baseSize * 2)) : 1;
    const askSizeMultiplier = q < 0 ? Math.max(0.3, 1 + q / (baseSize * 2)) : 1;

    return {
      tokenId,
      bidPrice: Math.round(bidPrice * 1000) / 1000,
      bidSize: Math.floor(baseSize * bidSizeMultiplier),
      askPrice: Math.round(askPrice * 1000) / 1000,
      askSize: Math.floor(baseSize * askSizeMultiplier),
      inventorySkew,
      spreadWidth: askPrice - bidPrice,
    };
  }

  /**
   * Update inventory after a fill
   */
  updateInventory(tokenId: string, side: 'BUY' | 'SELL', size: number): void {
    const current = this.inventory.get(tokenId) ?? 0;
    const delta = side === 'BUY' ? size : -size;
    this.inventory.set(tokenId, current + delta);
    this.logger.debug('Inventory updated', { tokenId, side, size, newInventory: current + delta });
  }

  /**
   * Get current inventory for a token
   */
  getInventory(tokenId: string): number {
    return this.inventory.get(tokenId) ?? 0;
  }

  /**
   * Binary contract volatility approximation
   * σ ≈ √(p * (1-p)) - highest at 50c, near zero at 0/100c
   */
  private binaryVolatility(price: number): number {
    return Math.sqrt(price * (1 - price));
  }
}
