/**
 * Claude AI Market Analyzer
 * Uses Anthropic's Claude to analyze prediction markets and estimate fair probabilities
 * This is the "brain" of the bot - similar to how sovereign2013 uses Claude for decisions
 */

import type {
  MarketAnalysis,
  ClaudeAnalysisRequest,
  PolymarketMarket,
  OrderBook,
  SportsEvent,
} from './types.js';
import { Logger } from './logger.js';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicResponse {
  content: Array<{ type: 'text'; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
}

export class ClaudeAnalyzer {
  private apiKey: string;
  private model: string;
  private logger: Logger;
  private analysisCache: Map<string, { analysis: MarketAnalysis; expiry: number }> = new Map();
  private cacheTtlMs = 300_000; // 5 minute cache for analyses

  constructor(apiKey: string, model: string, logger: Logger) {
    this.apiKey = apiKey;
    this.model = model;
    this.logger = logger.child('CLAUDE');
  }

  /**
   * Analyze a market to estimate fair probability and recommend action
   */
  async analyzeMarket(request: ClaudeAnalysisRequest): Promise<MarketAnalysis> {
    const cacheKey = request.market.id;
    const cached = this.analysisCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
      this.logger.debug('Using cached analysis', { marketId: cacheKey });
      return cached.analysis;
    }

    const prompt = this.buildAnalysisPrompt(request);
    const response = await this.callClaude(prompt);
    const analysis = this.parseAnalysisResponse(response, request.market);

    this.analysisCache.set(cacheKey, {
      analysis,
      expiry: Date.now() + this.cacheTtlMs,
    });

    this.logger.info('Market analyzed', {
      market: request.market.question.slice(0, 60),
      probability: analysis.estimatedProbability,
      confidence: analysis.confidence,
      recommendation: analysis.recommendation,
    });

    return analysis;
  }

  /**
   * Batch analyze multiple markets efficiently
   */
  async analyzeMarkets(
    requests: ClaudeAnalysisRequest[],
    concurrency = 3
  ): Promise<MarketAnalysis[]> {
    const results: MarketAnalysis[] = [];

    for (let i = 0; i < requests.length; i += concurrency) {
      const batch = requests.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(
        batch.map((req) => this.analyzeMarket(req))
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          this.logger.warn('Analysis failed', { error: String(result.reason) });
        }
      }

      // Small delay between batches to avoid rate limits
      if (i + concurrency < requests.length) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    return results;
  }

  /**
   * Quick probability check - lighter weight than full analysis
   * Used for initial screening before deep analysis
   */
  async quickProbabilityEstimate(
    market: PolymarketMarket,
    externalOdds?: SportsEvent
  ): Promise<{ probability: number; confidence: number }> {
    const prompt = this.buildQuickEstimatePrompt(market, externalOdds);
    const response = await this.callClaude(prompt, 300);

    try {
      const parsed = JSON.parse(this.extractJson(response));
      return {
        probability: Math.max(0, Math.min(1, Number(parsed.probability))),
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence))),
      };
    } catch {
      this.logger.warn('Failed to parse quick estimate, using market price');
      return {
        probability: market.outcomePrices[0] ?? 0.5,
        confidence: 0.1,
      };
    }
  }

  // ─── Prompt Construction ────────────────────────────────────

  private buildAnalysisPrompt(request: ClaudeAnalysisRequest): string {
    const { market, orderBook, externalOdds } = request;

    let prompt = `You are an expert sports prediction market analyst and quantitative trader. Analyze this Polymarket prediction market and provide your assessment.

## Market Information
- **Question:** ${market.question}
- **Description:** ${market.description}
- **Category:** ${market.category}
- **Closes:** ${market.endDate}
- **Current YES price:** $${market.outcomePrices[0]?.toFixed(3) ?? 'N/A'} (implied ${((market.outcomePrices[0] ?? 0) * 100).toFixed(1)}%)
- **Current NO price:** $${market.outcomePrices[1]?.toFixed(3) ?? 'N/A'}
- **Volume:** $${market.volume.toLocaleString()}
- **Liquidity:** $${market.liquidity.toLocaleString()}`;

    if (orderBook) {
      prompt += `

## Order Book
- **Spread:** ${(orderBook.spread * 100).toFixed(2)}%
- **Mid price:** $${orderBook.midPrice.toFixed(3)}
- **Best bid:** $${orderBook.bids[0]?.price.toFixed(3) ?? 'N/A'} (${orderBook.bids[0]?.size ?? 0} shares)
- **Best ask:** $${orderBook.asks[0]?.price.toFixed(3) ?? 'N/A'} (${orderBook.asks[0]?.size ?? 0} shares)
- **Bid depth (top 5):** ${orderBook.bids.slice(0, 5).map(b => `$${b.price.toFixed(3)}x${b.size}`).join(', ')}
- **Ask depth (top 5):** ${orderBook.asks.slice(0, 5).map(a => `$${a.price.toFixed(3)}x${a.size}`).join(', ')}`;
    }

    if (externalOdds) {
      prompt += `

## External Sportsbook Odds
- **Event:** ${externalOdds.homeTeam} vs ${externalOdds.awayTeam}
- **Start time:** ${externalOdds.commenceTime}
- **Bookmaker odds:**`;

      for (const bookie of externalOdds.bookmakers.slice(0, 5)) {
        const h2h = bookie.markets.find(m => m.key === 'h2h');
        if (!h2h) continue;
        const oddsStr = h2h.outcomes.map(o => `${o.name}: ${o.price.toFixed(2)}`).join(', ');
        prompt += `\n  - **${bookie.title}:** ${oddsStr}`;
      }
    }

    prompt += `

## Task
Provide a thorough analysis considering:
1. The current market pricing vs your estimated fair probability
2. External odds comparison (if provided) - identify any price discrepancies
3. Key factors that could influence the outcome
4. Risk factors and potential for adverse outcomes
5. Market microstructure (spread, liquidity, time to close)
6. Whether there's a tradeable edge

Respond in JSON format:
{
  "estimatedProbability": <0.0-1.0, your fair probability for YES>,
  "confidence": <0.0-1.0, how confident you are in your estimate>,
  "reasoning": "<2-3 sentence summary>",
  "keyFactors": ["<factor1>", "<factor2>", ...],
  "riskFactors": ["<risk1>", "<risk2>", ...],
  "recommendation": "<STRONG_BUY|BUY|HOLD|SELL|STRONG_SELL>",
  "timeHorizon": "<immediate|hours|days>"
}

IMPORTANT: Be calibrated. When you say 60%, events should happen ~60% of the time. Avoid overconfidence. If you're uncertain, set confidence low. The recommendation refers to buying YES shares.`;

    return prompt;
  }

  private buildQuickEstimatePrompt(market: PolymarketMarket, externalOdds?: SportsEvent): string {
    let prompt = `Quick probability estimate for this prediction market:

Question: "${market.question}"
Current YES price: $${market.outcomePrices[0]?.toFixed(3) ?? '?'}`;

    if (externalOdds) {
      const avgOdds = externalOdds.bookmakers.slice(0, 3).map(b => {
        const h2h = b.markets.find(m => m.key === 'h2h');
        return h2h?.outcomes.map(o => `${o.name}:${o.price}`).join('/') ?? '';
      }).join(' | ');
      prompt += `\nSportsbook odds: ${avgOdds}`;
    }

    prompt += `

Respond with ONLY JSON: {"probability": <0-1>, "confidence": <0-1>}`;

    return prompt;
  }

  // ─── Claude API Communication ───────────────────────────────

  private async callClaude(userPrompt: string, maxTokens = 1024): Promise<string> {
    const messages: AnthropicMessage[] = [
      { role: 'user', content: userPrompt },
    ];

    const body = {
      model: this.model,
      max_tokens: maxTokens,
      messages,
      temperature: 0.3, // Low temperature for more consistent analysis
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        });

        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after') ?? 5);
          this.logger.warn(`Rate limited, waiting ${retryAfter}s`);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }

        if (!res.ok) {
          throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
        }

        const data = (await res.json()) as AnthropicResponse;
        return data.content[0]?.text ?? '';
      } catch (err) {
        lastError = err as Error;
        if (attempt < 2) {
          const delay = 2000 * (attempt + 1);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastError ?? new Error('Claude API call failed');
  }

  // ─── Response Parsing ───────────────────────────────────────

  private parseAnalysisResponse(response: string, market: PolymarketMarket): MarketAnalysis {
    try {
      const json = JSON.parse(this.extractJson(response));

      return {
        marketId: market.id,
        question: market.question,
        estimatedProbability: clamp(Number(json.estimatedProbability), 0, 1),
        confidence: clamp(Number(json.confidence), 0, 1),
        reasoning: String(json.reasoning ?? ''),
        keyFactors: Array.isArray(json.keyFactors) ? json.keyFactors.map(String) : [],
        riskFactors: Array.isArray(json.riskFactors) ? json.riskFactors.map(String) : [],
        recommendation: validateRecommendation(json.recommendation),
        timeHorizon: String(json.timeHorizon ?? 'unknown'),
        analyzedAt: Date.now(),
      };
    } catch (err) {
      this.logger.error('Failed to parse analysis response', {
        error: String(err),
        response: response.slice(0, 200),
      });

      // Return a conservative fallback
      return {
        marketId: market.id,
        question: market.question,
        estimatedProbability: market.outcomePrices[0] ?? 0.5,
        confidence: 0.1,
        reasoning: 'Failed to parse Claude analysis, using market price as estimate',
        keyFactors: [],
        riskFactors: ['Analysis parsing failed'],
        recommendation: 'HOLD',
        timeHorizon: 'unknown',
        analyzedAt: Date.now(),
      };
    }
  }

  /**
   * Extract JSON from a response that may contain markdown code blocks
   */
  private extractJson(text: string): string {
    // Try to find JSON in code blocks
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch?.[1]) return codeBlockMatch[1].trim();

    // Try to find raw JSON object
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch?.[0]) return jsonMatch[0];

    return text;
  }
}

// ─── Utilities ──────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const VALID_RECOMMENDATIONS = new Set([
  'STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL',
]);

function validateRecommendation(
  rec: unknown
): 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL' {
  const s = String(rec).toUpperCase();
  if (VALID_RECOMMENDATIONS.has(s)) return s as MarketAnalysis['recommendation'];
  return 'HOLD';
}
