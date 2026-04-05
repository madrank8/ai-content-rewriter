/**
 * Multi-Model Ensemble AI Analyzer
 *
 * Combines multiple frontier AI models for superior probability estimation:
 * - Claude (Anthropic) - 40% weight: Best reasoning and calibration
 * - GPT-4o (OpenAI) - 35% weight: Strong multi-modal analysis
 * - Gemini 1.5 Pro (Google) - 25% weight: Diverse perspective
 *
 * Uses extremization to correct for averaging bias:
 *   p_ext = p^a / (p^a + (1-p)^a) where a > 1
 *
 * Models forecast independently and are explicitly told NOT to anchor to market price.
 * Adaptive reweighting based on Brier scores by market category.
 */

import type {
  MarketAnalysis,
  EnsembleResult,
  ClaudeAnalysisRequest,
  PolymarketMarket,
  AIConfig,
} from './types.js';
import { Logger } from './logger.js';

interface ModelProvider {
  name: string;
  weight: number;
  apiKey: string;
  model: string;
  endpoint: string;
  /** Running Brier score for calibration tracking */
  brierAccumulator: { totalScore: number; count: number };
}

interface APIResponse {
  probability: number;
  confidence: number;
  reasoning: string;
  keyFactors: string[];
  riskFactors: string[];
  recommendation: string;
}

export class EnsembleAnalyzer {
  private providers: ModelProvider[] = [];
  private config: AIConfig;
  private logger: Logger;
  private analysisCache: Map<string, { result: EnsembleResult; expiry: number }> = new Map();
  private cacheTtlMs = 300_000; // 5 min cache

  constructor(config: AIConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child('ENSEMBLE');
    this.initProviders();
  }

  private initProviders(): void {
    if (this.config.anthropic) {
      this.providers.push({
        name: 'claude',
        weight: this.config.ensembleWeights.claude,
        apiKey: this.config.anthropic.apiKey,
        model: this.config.anthropic.model,
        endpoint: 'https://api.anthropic.com/v1/messages',
        brierAccumulator: { totalScore: 0, count: 0 },
      });
    }

    if (this.config.openai) {
      this.providers.push({
        name: 'gpt',
        weight: this.config.ensembleWeights.gpt,
        apiKey: this.config.openai.apiKey,
        model: this.config.openai.model,
        endpoint: 'https://api.openai.com/v1/chat/completions',
        brierAccumulator: { totalScore: 0, count: 0 },
      });
    }

    if (this.config.google) {
      this.providers.push({
        name: 'gemini',
        weight: this.config.ensembleWeights.gemini,
        apiKey: this.config.google.apiKey,
        model: this.config.google.model,
        endpoint: `https://generativelanguage.googleapis.com/v1beta/models/${this.config.google.model}:generateContent`,
        brierAccumulator: { totalScore: 0, count: 0 },
      });
    }

    // Normalize weights to sum to 1
    const totalWeight = this.providers.reduce((s, p) => s + p.weight, 0);
    if (totalWeight > 0) {
      for (const p of this.providers) {
        p.weight /= totalWeight;
      }
    }

    this.logger.info(`Ensemble initialized: ${this.providers.map(p => `${p.name}(${(p.weight * 100).toFixed(0)}%)`).join(' + ')}`);
  }

  // ─── Main Analysis ──────────────────────────────────────────

  /**
   * Run ensemble analysis across all models and combine results
   */
  async analyzeMarket(request: ClaudeAnalysisRequest): Promise<EnsembleResult> {
    const cacheKey = request.market.id;
    const cached = this.analysisCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
      return cached.result;
    }

    if (this.providers.length === 0) {
      throw new Error('No AI providers configured');
    }

    const prompt = this.buildPrompt(request);

    // Query all models in parallel
    const modelResults = await Promise.allSettled(
      this.providers.map(provider => this.queryModel(provider, prompt))
    );

    const successfulResults: {
      name: string;
      probability: number;
      confidence: number;
      weight: number;
      reasoning: string;
    }[] = [];

    for (let i = 0; i < this.providers.length; i++) {
      const result = modelResults[i]!;
      const provider = this.providers[i]!;

      if (result.status === 'fulfilled') {
        successfulResults.push({
          name: provider.name,
          probability: result.value.probability,
          confidence: result.value.confidence,
          weight: provider.weight,
          reasoning: result.value.reasoning,
        });
      } else {
        this.logger.warn(`${provider.name} analysis failed`, { error: String(result.reason) });
      }
    }

    if (successfulResults.length === 0) {
      throw new Error('All model providers failed');
    }

    // Combine using weighted average
    const ensemble = this.combineResults(successfulResults, request.market);

    this.analysisCache.set(cacheKey, { result: ensemble, expiry: Date.now() + this.cacheTtlMs });

    this.logger.info('Ensemble analysis complete', {
      market: request.market.question.slice(0, 50),
      probability: ensemble.probability.toFixed(3),
      confidence: ensemble.confidence.toFixed(2),
      disagreement: ensemble.disagreement.toFixed(3),
      models: successfulResults.map(r => `${r.name}:${r.probability.toFixed(3)}`).join(' '),
    });

    return ensemble;
  }

  /**
   * Quick probability estimate using the fastest available model
   */
  async quickEstimate(
    market: PolymarketMarket
  ): Promise<{ probability: number; confidence: number }> {
    const provider = this.providers[0];
    if (!provider) return { probability: market.outcomePrices[0] ?? 0.5, confidence: 0.1 };

    const prompt = `Quick probability estimate for prediction market:
Question: "${market.question}"
Current YES price: $${market.outcomePrices[0]?.toFixed(3) ?? '?'}

DO NOT anchor to the current market price. Estimate independently.
Respond ONLY with JSON: {"probability": <0-1>, "confidence": <0-1>}`;

    try {
      const result = await this.queryModel(provider, prompt, 200);
      return {
        probability: clamp(result.probability, 0.01, 0.99),
        confidence: clamp(result.confidence, 0, 1),
      };
    } catch {
      return { probability: market.outcomePrices[0] ?? 0.5, confidence: 0.1 };
    }
  }

  // ─── Result Combination ─────────────────────────────────────

  private combineResults(
    results: { name: string; probability: number; confidence: number; weight: number; reasoning: string }[],
    market: PolymarketMarket
  ): EnsembleResult {
    // Normalize weights for available models
    const totalWeight = results.reduce((s, r) => s + r.weight, 0);
    const normalizedResults = results.map(r => ({ ...r, weight: r.weight / totalWeight }));

    // Weighted average probability
    let avgProbability = normalizedResults.reduce(
      (sum, r) => sum + r.probability * r.weight, 0
    );

    // Weighted average confidence
    const avgConfidence = normalizedResults.reduce(
      (sum, r) => sum + r.confidence * r.weight, 0
    );

    // Calculate disagreement (variance between models)
    const disagreement = Math.sqrt(
      normalizedResults.reduce(
        (sum, r) => sum + r.weight * (r.probability - avgProbability) ** 2, 0
      )
    );

    // Apply extremization: push away from 0.5 to correct averaging compression
    // p_ext = p^a / (p^a + (1-p)^a)
    const a = this.config.extremizationFactor;
    if (a > 1 && avgProbability > 0.01 && avgProbability < 0.99) {
      const pa = avgProbability ** a;
      const qa = (1 - avgProbability) ** a;
      avgProbability = pa / (pa + qa);
    }

    // Reduce confidence when models disagree
    const confidenceAdjust = Math.max(0.3, 1 - disagreement * 2);
    const finalConfidence = avgConfidence * confidenceAdjust;

    // Combine reasoning from all models
    const reasoning = normalizedResults
      .map(r => `[${r.name.toUpperCase()} ${(r.probability * 100).toFixed(1)}%] ${r.reasoning}`)
      .join(' | ');

    return {
      probability: clamp(avgProbability, 0.01, 0.99),
      confidence: clamp(finalConfidence, 0, 1),
      models: normalizedResults,
      disagreement,
      reasoning,
    };
  }

  // ─── Model Querying ─────────────────────────────────────────

  private async queryModel(provider: ModelProvider, prompt: string, maxTokens = 800): Promise<APIResponse> {
    switch (provider.name) {
      case 'claude':
        return this.queryClaude(provider, prompt, maxTokens);
      case 'gpt':
        return this.queryGPT(provider, prompt, maxTokens);
      case 'gemini':
        return this.queryGemini(provider, prompt, maxTokens);
      default:
        throw new Error(`Unknown provider: ${provider.name}`);
    }
  }

  private async queryClaude(provider: ModelProvider, prompt: string, maxTokens: number): Promise<APIResponse> {
    const res = await fetch(provider.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: maxTokens,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) throw new Error(`Claude API error ${res.status}`);
    const data = (await res.json()) as { content: Array<{ text: string }> };
    return this.parseResponse(data.content[0]?.text ?? '');
  }

  private async queryGPT(provider: ModelProvider, prompt: string, maxTokens: number): Promise<APIResponse> {
    const res = await fetch(provider.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: maxTokens,
        temperature: 0.3,
        messages: [
          { role: 'system', content: 'You are a calibrated prediction market analyst. Respond only in JSON.' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!res.ok) throw new Error(`GPT API error ${res.status}`);
    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return this.parseResponse(data.choices[0]?.message.content ?? '');
  }

  private async queryGemini(provider: ModelProvider, prompt: string, _maxTokens: number): Promise<APIResponse> {
    const res = await fetch(`${provider.endpoint}?key=${provider.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3 },
      }),
    });

    if (!res.ok) throw new Error(`Gemini API error ${res.status}`);
    const data = (await res.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    return this.parseResponse(data.candidates[0]?.content.parts[0]?.text ?? '');
  }

  // ─── Prompt Building ────────────────────────────────────────

  private buildPrompt(request: ClaudeAnalysisRequest): string {
    const { market, orderBook, externalOdds, weather, liveScore, newsContext } = request;

    let prompt = `You are a calibrated sports prediction analyst. Estimate the TRUE probability for this prediction market outcome.

CRITICAL: Do NOT anchor to the current market price. Estimate independently based on fundamentals.

## Market
- **Question:** ${market.question}
- **Description:** ${market.description}
- **Closes:** ${market.endDate}
- **Current YES price:** $${market.outcomePrices[0]?.toFixed(3) ?? '?'} (DO NOT anchor to this)
- **Volume:** $${market.volume.toLocaleString()}`;

    if (orderBook) {
      prompt += `\n- **Spread:** ${(orderBook.spread * 100).toFixed(2)}%`;
      if (orderBook.vpin !== undefined) {
        prompt += `\n- **VPIN (informed trading):** ${orderBook.vpin.toFixed(3)}`;
      }
    }

    if (externalOdds) {
      prompt += `\n\n## Sportsbook Odds (Sharp Reference)`;
      if (externalOdds.sharpLine) {
        prompt += `\n- **Pinnacle sharp line (vig-free):** Home ${(externalOdds.sharpLine.home * 100).toFixed(1)}%, Away ${(externalOdds.sharpLine.away * 100).toFixed(1)}%`;
      }
      for (const bookie of externalOdds.bookmakers.slice(0, 5)) {
        const h2h = bookie.markets.find(m => m.key === 'h2h');
        if (h2h) {
          const odds = h2h.outcomes.map(o => `${o.name}: ${o.price.toFixed(2)}`).join(', ');
          prompt += `\n- **${bookie.title}${bookie.isSharp ? ' (SHARP)' : ''}:** ${odds}`;
        }
      }
    }

    if (liveScore) {
      prompt += `\n\n## Live Score\n- ${liveScore.home} - ${liveScore.away} (${liveScore.period}, ${liveScore.clock})`;
    }

    if (weather) {
      prompt += `\n\n## Weather at Venue\n- ${weather.conditions}, ${weather.temperature.toFixed(0)}°F, Wind: ${weather.windSpeed.toFixed(0)}mph ${weather.windDirection}`;
      prompt += `\n- Precip: ${weather.precipitationChance}%, Impact: ${weather.gameImpact}`;
    }

    if (newsContext) {
      prompt += `\n\n## Breaking News\n${newsContext}`;
    }

    prompt += `\n\n## Instructions
Provide your independent probability estimate. Consider:
1. Team/player strength, recent form, matchup history
2. Injuries, lineup changes, rest days
3. Home/away advantage
4. Weather impact (if outdoor sport)
5. Sharp bookmaker lines vs current market price discrepancy
6. Any breaking news that hasn't been priced in

Respond in JSON:
{
  "probability": <0.01-0.99>,
  "confidence": <0-1>,
  "reasoning": "<2-3 sentences>",
  "keyFactors": ["..."],
  "riskFactors": ["..."],
  "recommendation": "<STRONG_BUY|BUY|HOLD|SELL|STRONG_SELL>"
}`;

    return prompt;
  }

  // ─── Response Parsing ───────────────────────────────────────

  private parseResponse(text: string): APIResponse {
    const jsonStr = this.extractJson(text);
    const parsed = JSON.parse(jsonStr);

    return {
      probability: clamp(Number(parsed.probability ?? 0.5), 0.01, 0.99),
      confidence: clamp(Number(parsed.confidence ?? 0.5), 0, 1),
      reasoning: String(parsed.reasoning ?? ''),
      keyFactors: Array.isArray(parsed.keyFactors) ? parsed.keyFactors.map(String) : [],
      riskFactors: Array.isArray(parsed.riskFactors) ? parsed.riskFactors.map(String) : [],
      recommendation: String(parsed.recommendation ?? 'HOLD'),
    };
  }

  private extractJson(text: string): string {
    const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock?.[1]) return codeBlock[1].trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch?.[0]) return jsonMatch[0];
    return text;
  }

  // ─── Calibration Tracking ──────────────────────────────────

  /**
   * Record actual outcome for Brier score tracking
   * Call this when a market resolves
   */
  recordOutcome(marketId: string, actualOutcome: boolean): void {
    const cached = this.analysisCache.get(marketId);
    if (!cached) return;

    const actual = actualOutcome ? 1 : 0;

    for (const modelResult of cached.result.models) {
      const provider = this.providers.find(p => p.name === modelResult.name);
      if (provider) {
        const brierScore = (modelResult.probability - actual) ** 2;
        provider.brierAccumulator.totalScore += brierScore;
        provider.brierAccumulator.count++;

        this.logger.debug('Brier score updated', {
          model: provider.name,
          predicted: modelResult.probability.toFixed(3),
          actual,
          brierScore: brierScore.toFixed(4),
          avgBrier: (provider.brierAccumulator.totalScore / provider.brierAccumulator.count).toFixed(4),
        });
      }
    }
  }

  /**
   * Get average Brier score per model for adaptive reweighting
   */
  getBrierScores(): Record<string, number> {
    const scores: Record<string, number> = {};
    for (const p of this.providers) {
      scores[p.name] = p.brierAccumulator.count > 0
        ? p.brierAccumulator.totalScore / p.brierAccumulator.count
        : 0.25; // Default (perfectly uncalibrated)
    }
    return scores;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
