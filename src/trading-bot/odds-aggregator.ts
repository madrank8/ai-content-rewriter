/**
 * External Odds Aggregator
 * Fetches odds from sportsbooks via The Odds API for cross-platform arbitrage
 */

import type { SportsEvent, Bookmaker, BookmakerMarket, BookmakerOutcome } from './types.js';
import { ODDS_API_URL, SUPPORTED_SPORTS, type SupportedSport } from './config.js';
import { Logger } from './logger.js';

interface OddsApiEvent {
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
      outcomes: Array<{
        name: string;
        price: number;
        point?: number;
      }>;
    }>;
  }>;
}

export class OddsAggregator {
  private apiKey: string;
  private logger: Logger;
  private cache: Map<string, { data: SportsEvent[]; timestamp: number }> = new Map();
  private cacheTtlMs = 60_000; // 1 minute cache

  constructor(apiKey: string, logger: Logger) {
    this.apiKey = apiKey;
    this.logger = logger.child('ODDS');
  }

  /**
   * Fetch odds for all supported sports
   */
  async getAllSportsOdds(): Promise<SportsEvent[]> {
    const results: SportsEvent[] = [];

    // Fetch in parallel but limit concurrency
    const batchSize = 3;
    for (let i = 0; i < SUPPORTED_SPORTS.length; i += batchSize) {
      const batch = SUPPORTED_SPORTS.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map((sport) => this.getOddsForSport(sport))
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(...result.value);
        } else {
          this.logger.warn('Failed to fetch odds', { error: String(result.reason) });
        }
      }
    }

    this.logger.info(`Fetched ${results.length} events across ${SUPPORTED_SPORTS.length} sports`);
    return results;
  }

  /**
   * Fetch odds for a specific sport
   */
  async getOddsForSport(sport: SupportedSport): Promise<SportsEvent[]> {
    // Check cache
    const cached = this.cache.get(sport);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.data;
    }

    const params = new URLSearchParams({
      apiKey: this.apiKey,
      regions: 'us,us2,eu',
      markets: 'h2h',
      oddsFormat: 'decimal',
    });

    const url = `${ODDS_API_URL}/sports/${sport}/odds?${params}`;
    const res = await fetch(url);

    if (!res.ok) {
      if (res.status === 429) {
        this.logger.warn('Odds API rate limited, using cache');
        return cached?.data ?? [];
      }
      throw new Error(`Odds API error ${res.status}: ${await res.text()}`);
    }

    const raw = (await res.json()) as OddsApiEvent[];
    const events = raw.map(this.normalizeEvent);

    this.cache.set(sport, { data: events, timestamp: Date.now() });
    return events;
  }

  /**
   * Find the best odds across bookmakers for a given event
   */
  findBestOdds(event: SportsEvent): {
    home: { bookmaker: string; odds: number; impliedProb: number };
    away: { bookmaker: string; odds: number; impliedProb: number };
    draw?: { bookmaker: string; odds: number; impliedProb: number };
  } {
    let bestHome = { bookmaker: '', odds: 0, impliedProb: 1 };
    let bestAway = { bookmaker: '', odds: 0, impliedProb: 1 };
    let bestDraw: { bookmaker: string; odds: number; impliedProb: number } | undefined;

    for (const bookie of event.bookmakers) {
      const h2h = bookie.markets.find((m) => m.key === 'h2h');
      if (!h2h) continue;

      for (const outcome of h2h.outcomes) {
        const impliedProb = 1 / outcome.price;

        if (outcome.name === event.homeTeam && outcome.price > bestHome.odds) {
          bestHome = { bookmaker: bookie.key, odds: outcome.price, impliedProb };
        } else if (outcome.name === event.awayTeam && outcome.price > bestAway.odds) {
          bestAway = { bookmaker: bookie.key, odds: outcome.price, impliedProb };
        } else if (outcome.name === 'Draw' && (!bestDraw || outcome.price > bestDraw.odds)) {
          bestDraw = { bookmaker: bookie.key, odds: outcome.price, impliedProb };
        }
      }
    }

    return { home: bestHome, away: bestAway, draw: bestDraw };
  }

  /**
   * Calculate consensus probability from multiple bookmakers
   * Removes vig to get fair probabilities
   */
  getConsensusProbability(event: SportsEvent): {
    home: number;
    away: number;
    draw?: number;
  } {
    const probs: { home: number[]; away: number[]; draw: number[] } = {
      home: [],
      away: [],
      draw: [],
    };

    for (const bookie of event.bookmakers) {
      const h2h = bookie.markets.find((m) => m.key === 'h2h');
      if (!h2h) continue;

      // Calculate total implied probability (includes vig)
      const totalImplied = h2h.outcomes.reduce((sum, o) => sum + 1 / o.price, 0);

      for (const outcome of h2h.outcomes) {
        // Remove vig by normalizing
        const fairProb = (1 / outcome.price) / totalImplied;

        if (outcome.name === event.homeTeam) probs.home.push(fairProb);
        else if (outcome.name === event.awayTeam) probs.away.push(fairProb);
        else if (outcome.name === 'Draw') probs.draw.push(fairProb);
      }
    }

    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    return {
      home: avg(probs.home),
      away: avg(probs.away),
      draw: probs.draw.length > 0 ? avg(probs.draw) : undefined,
    };
  }

  /**
   * Match a Polymarket question to a sports event
   * Uses fuzzy team name matching
   */
  matchPolymarketToEvent(
    question: string,
    events: SportsEvent[]
  ): SportsEvent | null {
    const q = question.toLowerCase();

    for (const event of events) {
      const home = event.homeTeam.toLowerCase();
      const away = event.awayTeam.toLowerCase();

      // Check if both teams appear in the question
      const homeWords = home.split(/\s+/);
      const awayWords = away.split(/\s+/);

      const homeMatch = homeWords.some((w) => w.length > 3 && q.includes(w));
      const awayMatch = awayWords.some((w) => w.length > 3 && q.includes(w));

      if (homeMatch && awayMatch) return event;

      // Also try with common abbreviations stripped
      const homeShort = homeWords[homeWords.length - 1]; // e.g., "Wildcats"
      const awayShort = awayWords[awayWords.length - 1];

      if (homeShort && awayShort &&
          homeShort.length > 3 && awayShort.length > 3 &&
          q.includes(homeShort) && q.includes(awayShort)) {
        return event;
      }
    }

    return null;
  }

  // ─── Helpers ────────────────────────────────────────────────

  private normalizeEvent = (raw: OddsApiEvent): SportsEvent => ({
    id: raw.id,
    sportKey: raw.sport_key,
    sportTitle: raw.sport_title,
    homeTeam: raw.home_team,
    awayTeam: raw.away_team,
    commenceTime: raw.commence_time,
    bookmakers: raw.bookmakers.map((b): Bookmaker => ({
      key: b.key,
      title: b.title,
      markets: b.markets.map((m): BookmakerMarket => ({
        key: m.key,
        outcomes: m.outcomes.map((o): BookmakerOutcome => ({
          name: o.name,
          price: o.price,
          point: o.point,
        })),
      })),
    })),
  });
}
