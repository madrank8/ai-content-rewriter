/**
 * Multi-Provider Sharp Odds Aggregator
 *
 * Aggregates odds from multiple paid APIs for maximum edge:
 * - SharpAPI: Pinnacle sharp lines, built-in arb detection, SSE streaming ($79-399/mo)
 * - Odds-API.io: 265 bookmakers, WebSocket, /arbitrage-bets endpoint
 * - The Odds API: 40 books, basic coverage (existing provider)
 *
 * Sharp line detection: Pinnacle and Circa are "sharp" books whose lines
 * represent the most accurate probabilities. Comparing soft book prices
 * against sharp lines reveals exploitable edge.
 */

import type {
  SportsEvent,
  Bookmaker,
  BookmakerMarket,
  BookmakerOutcome,
  ExternalArbAlert,
} from './types.js';
import { SHARP_API_URL, ODDS_API_IO_URL, ODDS_API_URL, SUPPORTED_SPORTS, type SupportedSport } from './config.js';
import { Logger } from './logger.js';

// ─── Raw API Response Types ─────────────────────────────────────

interface SharpApiOdds {
  event_id: string;
  sport: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  bookmakers: Array<{
    key: string;
    title: string;
    is_sharp: boolean;
    markets: Array<{
      key: string;
      outcomes: Array<{ name: string; price: number; point?: number }>;
    }>;
  }>;
  ev_bets?: Array<{
    bookmaker: string;
    outcome: string;
    odds: number;
    ev_percent: number;
    pinnacle_no_vig: number;
  }>;
  arb_bets?: Array<{
    profit_percent: number;
    legs: Array<{ bookmaker: string; outcome: string; odds: number }>;
  }>;
}

interface OddsApiIoEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  is_live: boolean;
  scores?: { home: number; away: number };
  bookmakers: Array<{
    key: string;
    title: string;
    markets: Array<{
      key: string;
      outcomes: Array<{ name: string; price: number; point?: number }>;
    }>;
  }>;
}

interface OddsApiIoArbBet {
  event_id: string;
  home_team: string;
  away_team: string;
  market: string;
  profit_percent: number;
  legs: Array<{
    bookmaker: string;
    outcome: string;
    odds: number;
  }>;
  detected_at: string;
}

interface TheOddsApiEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  bookmakers: Array<{
    key: string;
    title: string;
    markets: Array<{
      key: string;
      outcomes: Array<{ name: string; price: number; point?: number }>;
    }>;
  }>;
}

// ─── Provider Configuration ─────────────────────────────────────

interface SharpOddsConfig {
  theOddsApi?: { apiKey: string };
  sharpApi?: { apiKey: string };
  oddsApiIo?: { apiKey: string };
}

// ─── Sharp Books ────────────────────────────────────────────────

const SHARP_BOOKS = new Set(['pinnacle', 'circa', 'betfair', 'ps3838', 'matchbook']);

export class SharpOddsProvider {
  private config: SharpOddsConfig;
  private logger: Logger;
  private cache: Map<string, { data: SportsEvent[]; timestamp: number }> = new Map();
  private arbCache: ExternalArbAlert[] = [];
  private cacheTtlMs = 30_000; // 30 second cache (faster refresh for paid APIs)

  constructor(config: SharpOddsConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child('SHARP');
    this.logProviders();
  }

  private logProviders(): void {
    const providers: string[] = [];
    if (this.config.sharpApi) providers.push('SharpAPI (Pinnacle sharp lines)');
    if (this.config.oddsApiIo) providers.push('Odds-API.io (265 books)');
    if (this.config.theOddsApi) providers.push('The Odds API (40 books)');
    this.logger.info(`Odds providers: ${providers.join(', ') || 'none configured'}`);
  }

  // ─── Unified Odds Fetching ──────────────────────────────────

  /**
   * Fetch odds from all configured providers, merge, and return unified events
   * Priority: SharpAPI > Odds-API.io > The Odds API
   */
  async getAllSportsOdds(): Promise<SportsEvent[]> {
    const results: Map<string, SportsEvent> = new Map();

    // Fetch from all providers in parallel
    const [sharpResults, oddsIoResults, theOddsResults] = await Promise.allSettled([
      this.config.sharpApi ? this.fetchFromSharpApi() : Promise.resolve([]),
      this.config.oddsApiIo ? this.fetchFromOddsApiIo() : Promise.resolve([]),
      this.config.theOddsApi ? this.fetchFromTheOddsApi() : Promise.resolve([]),
    ]);

    // Merge results, preferring data from sharp providers
    const allEvents = [
      ...(sharpResults.status === 'fulfilled' ? sharpResults.value : []),
      ...(oddsIoResults.status === 'fulfilled' ? oddsIoResults.value : []),
      ...(theOddsResults.status === 'fulfilled' ? theOddsResults.value : []),
    ];

    for (const event of allEvents) {
      const key = `${event.homeTeam}|${event.awayTeam}|${event.commenceTime}`;
      const existing = results.get(key);

      if (existing) {
        // Merge bookmakers from different providers
        const existingBookKeys = new Set(existing.bookmakers.map(b => b.key));
        for (const bookie of event.bookmakers) {
          if (!existingBookKeys.has(bookie.key)) {
            existing.bookmakers.push(bookie);
          }
        }
        // Prefer sharp line from SharpAPI
        if (event.sharpLine && !existing.sharpLine) {
          existing.sharpLine = event.sharpLine;
        }
        if (event.live) existing.live = true;
        if (event.score) existing.score = event.score;
      } else {
        results.set(key, event);
      }
    }

    const merged = Array.from(results.values());
    this.logger.info(`Aggregated ${merged.length} events from ${this.getActiveProviderCount()} providers`);
    return merged;
  }

  /**
   * Fetch pre-computed arbitrage alerts from paid APIs
   */
  async getArbAlerts(): Promise<ExternalArbAlert[]> {
    const alerts: ExternalArbAlert[] = [];

    const [sharpArbs, oddsIoArbs] = await Promise.allSettled([
      this.config.sharpApi ? this.fetchSharpApiArbs() : Promise.resolve([]),
      this.config.oddsApiIo ? this.fetchOddsApiIoArbs() : Promise.resolve([]),
    ]);

    if (sharpArbs.status === 'fulfilled') alerts.push(...sharpArbs.value);
    if (oddsIoArbs.status === 'fulfilled') alerts.push(...oddsIoArbs.value);

    this.arbCache = alerts;
    if (alerts.length > 0) {
      this.logger.info(`Found ${alerts.length} pre-computed arb alerts`);
    }
    return alerts;
  }

  /**
   * Get Pinnacle/Circa vig-free sharp line for an event
   */
  getSharpLine(event: SportsEvent): { home: number; away: number; draw?: number } | null {
    if (event.sharpLine) return event.sharpLine;

    // Calculate from sharp bookmaker odds
    for (const bookie of event.bookmakers) {
      if (!SHARP_BOOKS.has(bookie.key)) continue;

      const h2h = bookie.markets.find(m => m.key === 'h2h');
      if (!h2h) continue;

      // Remove vig to get fair probabilities
      const totalImplied = h2h.outcomes.reduce((sum, o) => sum + 1 / o.price, 0);
      const result: { home: number; away: number; draw?: number } = { home: 0, away: 0 };

      for (const outcome of h2h.outcomes) {
        const fairProb = (1 / outcome.price) / totalImplied;
        if (outcome.name === event.homeTeam) result.home = fairProb;
        else if (outcome.name === event.awayTeam) result.away = fairProb;
        else if (outcome.name === 'Draw') result.draw = fairProb;
      }

      return result;
    }

    return null;
  }

  /**
   * Calculate consensus probability weighted by book sharpness
   * Sharp books get 3x weight vs soft books
   */
  getWeightedConsensusProbability(event: SportsEvent): {
    home: number;
    away: number;
    draw?: number;
  } {
    const probs: { home: number[]; away: number[]; draw: number[] } = {
      home: [], away: [], draw: [],
    };
    const weights: number[] = [];

    for (const bookie of event.bookmakers) {
      const h2h = bookie.markets.find(m => m.key === 'h2h');
      if (!h2h) continue;

      const isSharp = SHARP_BOOKS.has(bookie.key) || bookie.isSharp;
      const weight = isSharp ? 3.0 : 1.0;

      const totalImplied = h2h.outcomes.reduce((sum, o) => sum + 1 / o.price, 0);

      for (const outcome of h2h.outcomes) {
        const fairProb = (1 / outcome.price) / totalImplied;
        if (outcome.name === event.homeTeam) { probs.home.push(fairProb); weights.push(weight); }
        else if (outcome.name === event.awayTeam) { probs.away.push(fairProb); weights.push(weight); }
        else if (outcome.name === 'Draw') { probs.draw.push(fairProb); weights.push(weight); }
      }
    }

    const weightedAvg = (arr: number[], w: number[]) => {
      if (arr.length === 0) return 0;
      let totalW = 0;
      let totalV = 0;
      for (let i = 0; i < arr.length; i++) {
        totalV += arr[i]! * (w[i] ?? 1);
        totalW += w[i] ?? 1;
      }
      return totalW > 0 ? totalV / totalW : 0;
    };

    return {
      home: weightedAvg(probs.home, weights),
      away: weightedAvg(probs.away, weights),
      draw: probs.draw.length > 0 ? weightedAvg(probs.draw, weights) : undefined,
    };
  }

  /**
   * Match a Polymarket question to a sports event
   */
  matchPolymarketToEvent(question: string, events: SportsEvent[]): SportsEvent | null {
    const q = question.toLowerCase();

    for (const event of events) {
      const home = event.homeTeam.toLowerCase();
      const away = event.awayTeam.toLowerCase();

      const homeWords = home.split(/\s+/);
      const awayWords = away.split(/\s+/);

      const homeMatch = homeWords.some(w => w.length > 3 && q.includes(w));
      const awayMatch = awayWords.some(w => w.length > 3 && q.includes(w));

      if (homeMatch && awayMatch) return event;

      const homeShort = homeWords[homeWords.length - 1];
      const awayShort = awayWords[awayWords.length - 1];

      if (homeShort && awayShort &&
          homeShort.length > 3 && awayShort.length > 3 &&
          q.includes(homeShort) && q.includes(awayShort)) {
        return event;
      }
    }

    return null;
  }

  // ─── SharpAPI Provider ──────────────────────────────────────

  private async fetchFromSharpApi(): Promise<SportsEvent[]> {
    const apiKey = this.config.sharpApi!.apiKey;
    const events: SportsEvent[] = [];

    for (const sport of SUPPORTED_SPORTS) {
      try {
        const cached = this.cache.get(`sharp_${sport}`);
        if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
          events.push(...cached.data);
          continue;
        }

        const res = await fetch(`${SHARP_API_URL}/odds/${sport}?include_ev=true`, {
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
        });

        if (!res.ok) continue;
        const data = (await res.json()) as SharpApiOdds[];
        const normalized = data.map(e => this.normalizeSharpApiEvent(e));
        this.cache.set(`sharp_${sport}`, { data: normalized, timestamp: Date.now() });
        events.push(...normalized);
      } catch {
        // Skip failed sports
      }
    }

    return events;
  }

  private async fetchSharpApiArbs(): Promise<ExternalArbAlert[]> {
    const apiKey = this.config.sharpApi!.apiKey;
    try {
      const res = await fetch(`${SHARP_API_URL}/arbitrage`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as SharpApiOdds[];

      const alerts: ExternalArbAlert[] = [];
      for (const event of data) {
        for (const arb of event.arb_bets ?? []) {
          if (arb.legs.length >= 2) {
            alerts.push({
              provider: 'sharpapi',
              eventId: event.event_id,
              homeTeam: event.home_team,
              awayTeam: event.away_team,
              market: 'h2h',
              leg1: { bookmaker: arb.legs[0]!.bookmaker, outcome: arb.legs[0]!.outcome, odds: arb.legs[0]!.odds },
              leg2: { bookmaker: arb.legs[1]!.bookmaker, outcome: arb.legs[1]!.outcome, odds: arb.legs[1]!.odds },
              profitPercent: arb.profit_percent,
              detectedAt: Date.now(),
            });
          }
        }
      }
      return alerts;
    } catch {
      return [];
    }
  }

  private normalizeSharpApiEvent(raw: SharpApiOdds): SportsEvent {
    const bookmakers: Bookmaker[] = raw.bookmakers.map(b => ({
      key: b.key,
      title: b.title,
      isSharp: b.is_sharp,
      markets: b.markets.map((m): BookmakerMarket => ({
        key: m.key,
        outcomes: m.outcomes.map((o): BookmakerOutcome => ({
          name: o.name, price: o.price, point: o.point,
        })),
      })),
    }));

    // Extract sharp line from Pinnacle
    const pinnacle = raw.bookmakers.find(b => b.key === 'pinnacle');
    let sharpLine: SportsEvent['sharpLine'];
    if (pinnacle) {
      const h2h = pinnacle.markets.find(m => m.key === 'h2h');
      if (h2h) {
        const total = h2h.outcomes.reduce((s, o) => s + 1 / o.price, 0);
        sharpLine = {
          home: (1 / (h2h.outcomes.find(o => o.name === raw.home_team)?.price ?? 2)) / total,
          away: (1 / (h2h.outcomes.find(o => o.name === raw.away_team)?.price ?? 2)) / total,
        };
      }
    }

    return {
      id: raw.event_id,
      sportKey: raw.sport,
      sportTitle: raw.sport,
      homeTeam: raw.home_team,
      awayTeam: raw.away_team,
      commenceTime: raw.commence_time,
      bookmakers,
      sharpLine,
    };
  }

  // ─── Odds-API.io Provider ──────────────────────────────────

  private async fetchFromOddsApiIo(): Promise<SportsEvent[]> {
    const apiKey = this.config.oddsApiIo!.apiKey;
    const events: SportsEvent[] = [];

    for (const sport of SUPPORTED_SPORTS) {
      try {
        const cached = this.cache.get(`oddsio_${sport}`);
        if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
          events.push(...cached.data);
          continue;
        }

        const params = new URLSearchParams({
          sport: sport,
          markets: 'h2h',
          odds_format: 'decimal',
          include_live: 'true',
        });

        const res = await fetch(`${ODDS_API_IO_URL}/odds?${params}`, {
          headers: { 'x-api-key': apiKey },
        });

        if (!res.ok) continue;
        const data = (await res.json()) as OddsApiIoEvent[];
        const normalized = data.map(e => this.normalizeOddsApiIoEvent(e));
        this.cache.set(`oddsio_${sport}`, { data: normalized, timestamp: Date.now() });
        events.push(...normalized);
      } catch {
        // Skip failed sports
      }
    }

    return events;
  }

  private async fetchOddsApiIoArbs(): Promise<ExternalArbAlert[]> {
    const apiKey = this.config.oddsApiIo!.apiKey;
    try {
      const res = await fetch(`${ODDS_API_IO_URL}/arbitrage-bets`, {
        headers: { 'x-api-key': apiKey },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as OddsApiIoArbBet[];

      return data.map(arb => ({
        provider: 'odds-api-io',
        eventId: arb.event_id,
        homeTeam: arb.home_team,
        awayTeam: arb.away_team,
        market: arb.market,
        leg1: { bookmaker: arb.legs[0]!.bookmaker, outcome: arb.legs[0]!.outcome, odds: arb.legs[0]!.odds },
        leg2: { bookmaker: arb.legs[1]!.bookmaker, outcome: arb.legs[1]!.outcome, odds: arb.legs[1]!.odds },
        profitPercent: arb.profit_percent,
        detectedAt: new Date(arb.detected_at).getTime(),
      }));
    } catch {
      return [];
    }
  }

  private normalizeOddsApiIoEvent(raw: OddsApiIoEvent): SportsEvent {
    return {
      id: raw.id,
      sportKey: raw.sport_key,
      sportTitle: raw.sport_title,
      homeTeam: raw.home_team,
      awayTeam: raw.away_team,
      commenceTime: raw.commence_time,
      live: raw.is_live,
      score: raw.scores,
      bookmakers: raw.bookmakers.map(b => ({
        key: b.key,
        title: b.title,
        isSharp: SHARP_BOOKS.has(b.key),
        markets: b.markets.map((m): BookmakerMarket => ({
          key: m.key,
          outcomes: m.outcomes.map((o): BookmakerOutcome => ({
            name: o.name, price: o.price, point: o.point,
          })),
        })),
      })),
    };
  }

  // ─── The Odds API Provider (fallback) ───────────────────────

  private async fetchFromTheOddsApi(): Promise<SportsEvent[]> {
    const apiKey = this.config.theOddsApi!.apiKey;
    const events: SportsEvent[] = [];

    const batchSize = 3;
    for (let i = 0; i < SUPPORTED_SPORTS.length; i += batchSize) {
      const batch = SUPPORTED_SPORTS.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(sport => this.fetchTheOddsApiSport(sport, apiKey))
      );
      for (const r of results) {
        if (r.status === 'fulfilled') events.push(...r.value);
      }
    }

    return events;
  }

  private async fetchTheOddsApiSport(sport: SupportedSport, apiKey: string): Promise<SportsEvent[]> {
    const cached = this.cache.get(`theodds_${sport}`);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.data;
    }

    const params = new URLSearchParams({
      apiKey,
      regions: 'us,us2,eu',
      markets: 'h2h',
      oddsFormat: 'decimal',
    });

    const res = await fetch(`${ODDS_API_URL}/sports/${sport}/odds?${params}`);
    if (!res.ok) return [];

    const raw = (await res.json()) as TheOddsApiEvent[];
    const events: SportsEvent[] = raw.map(e => ({
      id: e.id,
      sportKey: e.sport_key,
      sportTitle: e.sport_title,
      homeTeam: e.home_team,
      awayTeam: e.away_team,
      commenceTime: e.commence_time,
      bookmakers: e.bookmakers.map(b => ({
        key: b.key,
        title: b.title,
        isSharp: SHARP_BOOKS.has(b.key),
        markets: b.markets.map((m): BookmakerMarket => ({
          key: m.key,
          outcomes: m.outcomes.map((o): BookmakerOutcome => ({
            name: o.name, price: o.price, point: o.point,
          })),
        })),
      })),
    }));

    this.cache.set(`theodds_${sport}`, { data: events, timestamp: Date.now() });
    return events;
  }

  // ─── Helpers ────────────────────────────────────────────────

  private getActiveProviderCount(): number {
    let count = 0;
    if (this.config.sharpApi) count++;
    if (this.config.oddsApiIo) count++;
    if (this.config.theOddsApi) count++;
    return count;
  }

  getCachedArbAlerts(): ExternalArbAlert[] {
    return this.arbCache;
  }
}
