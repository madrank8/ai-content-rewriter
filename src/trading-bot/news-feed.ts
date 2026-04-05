/**
 * Real-Time News & Data Feed Aggregator
 *
 * Combines multiple data sources for maximum information edge:
 * 1. Twitter/X API Pro ($5K/mo) - Beat reporter tweets (fastest source, 5-30min ahead)
 * 2. Sportradar - Official injuries, lineups, live scores
 * 3. Tomorrow.io - Weather conditions at game venues
 *
 * Information edge hierarchy:
 *   Beat reporter tweets > Sharp line movements > Official league reports > News articles
 */

import type {
  NewsItem,
  WeatherData,
  LiveScoreUpdate,
  BotEventHandler,
} from './types.js';
import { SPORTRADAR_URL, TOMORROW_IO_URL } from './config.js';
import { Logger } from './logger.js';

// ─── Twitter/X Streaming ────────────────────────────────────────

interface TwitterStreamRule {
  value: string;
  tag: string;
}

interface TwitterTweet {
  data: {
    id: string;
    text: string;
    author_id: string;
    created_at: string;
    entities?: {
      annotations?: Array<{ normalized_text: string; type: string }>;
    };
  };
  includes?: {
    users?: Array<{ id: string; username: string; name: string }>;
  };
}

/**
 * Twitter/X Filtered Stream for breaking sports news
 * Uses the Pro tier ($5K/mo) for real-time streaming with rules
 */
export class TwitterNewsFeed {
  private bearerToken: string;
  private reporterIds: string[];
  private logger: Logger;
  private onNewsCallback: ((news: NewsItem) => void) | null = null;
  private abortController: AbortController | null = null;
  private connected = false;

  constructor(bearerToken: string, reporterIds: string[], logger: Logger) {
    this.bearerToken = bearerToken;
    this.reporterIds = reporterIds;
    this.logger = logger.child('TWITTER');
  }

  /**
   * Set up filtered stream rules targeting beat reporters
   */
  async setupStreamRules(): Promise<void> {
    // Delete existing rules
    const existingRules = await this.getExistingRules();
    if (existingRules.length > 0) {
      await this.deleteRules(existingRules.map(r => r.id));
    }

    // Create rules for each reporter
    const rules: TwitterStreamRule[] = [];

    // Monitor specific reporter accounts
    if (this.reporterIds.length > 0) {
      // Batch reporters into groups of 5 for rule efficiency
      for (let i = 0; i < this.reporterIds.length; i += 5) {
        const batch = this.reporterIds.slice(i, i + 5);
        const fromClause = batch.map(id => `from:${id}`).join(' OR ');
        rules.push({
          value: `(${fromClause}) -is:retweet`,
          tag: `reporters_batch_${Math.floor(i / 5)}`,
        });
      }
    }

    // Monitor injury/lineup keywords from any sports account
    rules.push({
      value: '(injury OR injured OR "ruled out" OR "questionable" OR "doubtful" OR "will not play" OR "lineup" OR "starting") (NFL OR NBA OR MLB OR NHL OR NCAA) -is:retweet',
      tag: 'injury_keywords',
    });

    if (rules.length === 0) return;

    const res = await fetch('https://api.twitter.com/2/tweets/search/stream/rules', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ add: rules }),
    });

    if (!res.ok) {
      this.logger.error('Failed to set stream rules', { status: res.status });
      return;
    }

    this.logger.info(`Set up ${rules.length} stream rules targeting ${this.reporterIds.length} reporters`);
  }

  /**
   * Start the filtered stream - receives tweets in real-time
   */
  async startStream(onNews: (news: NewsItem) => void): Promise<void> {
    this.onNewsCallback = onNews;
    await this.setupStreamRules();
    this.connectStream();
  }

  /**
   * Stop the stream
   */
  stopStream(): void {
    this.connected = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.logger.info('Twitter stream stopped');
  }

  private async connectStream(): Promise<void> {
    this.abortController = new AbortController();
    const url = 'https://api.twitter.com/2/tweets/search/stream?tweet.fields=created_at,entities&expansions=author_id&user.fields=username,name';

    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.bearerToken}` },
        signal: this.abortController.signal,
      });

      if (!res.ok) {
        this.logger.error('Stream connection failed', { status: res.status });
        this.scheduleReconnect();
        return;
      }

      this.connected = true;
      this.logger.info('Twitter filtered stream connected');

      const reader = res.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = '';

      while (this.connected) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === '') continue;

          try {
            const tweet = JSON.parse(trimmed) as TwitterTweet;
            if (tweet.data) {
              this.processTweet(tweet);
            }
          } catch {
            // Skip malformed lines (heartbeats, etc.)
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        this.logger.error('Stream error', { error: String(err) });
        this.scheduleReconnect();
      }
    }
  }

  private processTweet(tweet: TwitterTweet): void {
    const author = tweet.includes?.users?.find(u => u.id === tweet.data.author_id);
    const entities = tweet.data.entities?.annotations?.map(a => a.normalized_text) ?? [];

    const news: NewsItem = {
      source: 'twitter',
      author: author?.username ?? tweet.data.author_id,
      text: tweet.data.text,
      timestamp: new Date(tweet.data.created_at).getTime(),
      entities,
      sentiment: this.quickSentiment(tweet.data.text),
    };

    this.logger.info(`Breaking: @${news.author}: ${news.text.slice(0, 100)}...`);

    if (this.onNewsCallback) {
      this.onNewsCallback(news);
    }
  }

  /**
   * Quick rule-based sentiment for sports injury news
   * Negative = player out/injured, Positive = player returning
   */
  private quickSentiment(text: string): number {
    const lower = text.toLowerCase();
    const negative = ['ruled out', 'will not play', 'out for', 'injured', 'torn', 'broken',
      'surgery', 'doubtful', 'suspended', 'ejected', 'sidelined'];
    const positive = ['returning', 'cleared', 'back in', 'activated', 'upgraded',
      'will play', 'expected to play', 'probable'];

    const negScore = negative.filter(w => lower.includes(w)).length;
    const posScore = positive.filter(w => lower.includes(w)).length;

    if (negScore > posScore) return -0.5 - (negScore * 0.1);
    if (posScore > negScore) return 0.5 + (posScore * 0.1);
    return 0;
  }

  private async getExistingRules(): Promise<Array<{ id: string; value: string }>> {
    try {
      const res = await fetch('https://api.twitter.com/2/tweets/search/stream/rules', {
        headers: { 'Authorization': `Bearer ${this.bearerToken}` },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: Array<{ id: string; value: string }> };
      return data.data ?? [];
    } catch {
      return [];
    }
  }

  private async deleteRules(ids: string[]): Promise<void> {
    await fetch('https://api.twitter.com/2/tweets/search/stream/rules', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ delete: { ids } }),
    });
  }

  private scheduleReconnect(): void {
    if (!this.connected) return;
    setTimeout(() => this.connectStream(), 5000);
  }
}

// ─── Sportradar Live Data ───────────────────────────────────────

interface SportradarInjury {
  player: { full_name: string };
  status: string;
  desc: string;
  start_date: string;
}

interface SportradarGame {
  id: string;
  status: string;
  home: { name: string; points?: number };
  away: { name: string; points?: number };
  period?: number;
  clock?: string;
}

/**
 * Sportradar integration for official league data
 * Provides: injuries, lineups, live scores, play-by-play
 */
export class SportradarFeed {
  private apiKey: string;
  private logger: Logger;
  private injuryCache: Map<string, { injuries: NewsItem[]; timestamp: number }> = new Map();
  private cacheTtlMs = 120_000; // 2 minute cache

  constructor(apiKey: string, logger: Logger) {
    this.apiKey = apiKey;
    this.logger = logger.child('SRAD');
  }

  /**
   * Fetch latest injury reports for a sport
   */
  async getInjuries(sport: 'nfl' | 'nba' | 'mlb' | 'nhl'): Promise<NewsItem[]> {
    const cached = this.injuryCache.get(sport);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.injuries;
    }

    try {
      const season = new Date().getFullYear();
      const url = `${SPORTRADAR_URL}/${sport}/trial/v8/en/league/${season}/REG/injuries.json?api_key=${this.apiKey}`;

      const res = await fetch(url);
      if (!res.ok) return [];

      const data = (await res.json()) as { teams?: Array<{ name: string; players?: SportradarInjury[] }> };
      const injuries: NewsItem[] = [];

      for (const team of data.teams ?? []) {
        for (const player of team.players ?? []) {
          injuries.push({
            source: 'sportradar',
            author: 'Sportradar',
            text: `${player.player.full_name} (${team.name}): ${player.status} - ${player.desc}`,
            timestamp: new Date(player.start_date).getTime(),
            entities: [player.player.full_name, team.name],
          });
        }
      }

      this.injuryCache.set(sport, { injuries, timestamp: Date.now() });
      return injuries;
    } catch (err) {
      this.logger.warn(`Failed to fetch ${sport} injuries`, { error: String(err) });
      return [];
    }
  }

  /**
   * Fetch live scores for today's games
   */
  async getLiveScores(sport: 'nfl' | 'nba' | 'mlb' | 'nhl'): Promise<LiveScoreUpdate[]> {
    try {
      const today = new Date().toISOString().split('T')[0]!.replace(/-/g, '/');
      const url = `${SPORTRADAR_URL}/${sport}/trial/v8/en/games/${today}/schedule.json?api_key=${this.apiKey}`;

      const res = await fetch(url);
      if (!res.ok) return [];

      const data = (await res.json()) as { games?: SportradarGame[] };
      const scores: LiveScoreUpdate[] = [];

      for (const game of data.games ?? []) {
        if (game.status === 'inprogress' || game.status === 'halftime') {
          scores.push({
            eventId: game.id,
            homeTeam: game.home.name,
            awayTeam: game.away.name,
            homeScore: game.home.points ?? 0,
            awayScore: game.away.points ?? 0,
            period: String(game.period ?? ''),
            clock: game.clock ?? '',
            timestamp: Date.now(),
          });
        }
      }

      return scores;
    } catch (err) {
      this.logger.warn(`Failed to fetch ${sport} scores`, { error: String(err) });
      return [];
    }
  }
}

// ─── Tomorrow.io Weather ────────────────────────────────────────

interface TomorrowIoResponse {
  data: {
    values: {
      temperature: number;
      windSpeed: number;
      windDirection: number;
      precipitationProbability: number;
      humidity: number;
      weatherCode: number;
    };
  };
}

/** Major sports venue coordinates */
const VENUE_COORDS: Record<string, { lat: number; lng: number; name: string }> = {
  // NFL stadiums (selected)
  'Arrowhead Stadium': { lat: 39.0489, lng: -94.4839, name: 'Arrowhead Stadium' },
  'Lambeau Field': { lat: 44.5013, lng: -88.0622, name: 'Lambeau Field' },
  'Soldier Field': { lat: 41.8623, lng: -87.6167, name: 'Soldier Field' },
  'MetLife Stadium': { lat: 40.8128, lng: -74.0742, name: 'MetLife Stadium' },
  'Highmark Stadium': { lat: 42.7738, lng: -78.7870, name: 'Highmark Stadium' },
};

/**
 * Weather data for outdoor sports venues
 * Wind, rain, and temperature significantly affect scoring in outdoor sports
 */
export class WeatherFeed {
  private apiKey: string;
  private logger: Logger;
  private cache: Map<string, { data: WeatherData; timestamp: number }> = new Map();
  private cacheTtlMs = 600_000; // 10 minute cache

  constructor(apiKey: string, logger: Logger) {
    this.apiKey = apiKey;
    this.logger = logger.child('WEATHER');
  }

  /**
   * Get weather conditions at a game venue
   */
  async getWeather(venueName: string): Promise<WeatherData | null> {
    const cached = this.cache.get(venueName);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.data;
    }

    const venue = VENUE_COORDS[venueName];
    if (!venue) return null;

    try {
      const url = `${TOMORROW_IO_URL}/weather/realtime?location=${venue.lat},${venue.lng}&apikey=${this.apiKey}`;
      const res = await fetch(url);
      if (!res.ok) return null;

      const raw = (await res.json()) as TomorrowIoResponse;
      const v = raw.data.values;

      const weather: WeatherData = {
        venue: venueName,
        temperature: v.temperature * 9 / 5 + 32, // C to F
        windSpeed: v.windSpeed * 2.237, // m/s to mph
        windDirection: this.degreesToDirection(v.windDirection),
        precipitationChance: v.precipitationProbability,
        humidity: v.humidity,
        conditions: this.weatherCodeToConditions(v.weatherCode),
        gameImpact: this.assessImpact(v),
      };

      this.cache.set(venueName, { data: weather, timestamp: Date.now() });
      return weather;
    } catch (err) {
      this.logger.warn('Weather fetch failed', { venue: venueName, error: String(err) });
      return null;
    }
  }

  /**
   * Get weather for a game by searching for the venue from team names
   */
  async getWeatherForGame(homeTeam: string): Promise<WeatherData | null> {
    // Find venue matching the home team
    for (const [venueName] of Object.entries(VENUE_COORDS)) {
      // Simple heuristic - could be improved with a full team-to-venue mapping
      if (venueName.toLowerCase().includes(homeTeam.toLowerCase().split(' ').pop() ?? '')) {
        return this.getWeather(venueName);
      }
    }
    return null;
  }

  private assessImpact(values: TomorrowIoResponse['data']['values']): WeatherData['gameImpact'] {
    const windMph = values.windSpeed * 2.237;
    const precipProb = values.precipitationProbability;
    const tempF = values.temperature * 9 / 5 + 32;

    if (windMph > 25 || precipProb > 70 || tempF < 10 || tempF > 105) return 'high';
    if (windMph > 15 || precipProb > 40 || tempF < 25 || tempF > 95) return 'moderate';
    if (windMph > 10 || precipProb > 20) return 'low';
    return 'none';
  }

  private degreesToDirection(degrees: number): string {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(degrees / 45) % 8]!;
  }

  private weatherCodeToConditions(code: number): string {
    if (code <= 1000) return 'Clear';
    if (code <= 1100) return 'Mostly Clear';
    if (code <= 1102) return 'Partly Cloudy';
    if (code <= 1001) return 'Cloudy';
    if (code >= 4000 && code <= 4201) return 'Rain';
    if (code >= 5000 && code <= 5101) return 'Snow';
    if (code >= 6000 && code <= 6201) return 'Freezing Rain';
    if (code >= 7000 && code <= 7102) return 'Ice';
    if (code >= 8000) return 'Thunderstorm';
    return 'Unknown';
  }
}
