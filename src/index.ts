/**
 * AI Content Rewriter
 * ===================
 * AI-powered content rewriting library for ethical affiliate marketing.
 *
 * @example
 * ```typescript
 * import { ContentRewriter } from "@affiliate.fm/ai-content-rewriter";
 *
 * const rewriter = new ContentRewriter({
 *   provider: "openai",
 *   apiKey: "sk-...",
 *   model: "gpt-4.1",
 * });
 *
 * // Rewrite content
 * const [result] = await rewriter.rewrite("<h1>Hello</h1><p>World</p>");
 * console.log(result.content);
 *
 * // Multiple variants
 * const results = await rewriter.rewrite(html, { variants: 3 });
 * ```
 */

// Main class export
export { ContentRewriter } from "./rewriter.js";

// WordPress integration
export { WordPressRewriter } from "./wordpress.js";

// Types
export type {
  // Constructor options
  RewriterOptions,
  // Per-call options
  RewriteCallOptions,
  // Content types
  ContentInput,
  ContentFormat,
  RewriteResult,
  // Provider types
  ProviderConfig,
  ProviderType,
  // Progress types
  RewriteProgress,
  ProgressCallback,
  StreamingResult,
  StreamingCallback,
  // WordPress types
  WordPressConfig,
  WordPressPost,
  WordPressPostType,
  WordPressPostStatus,
  WordPressListOptions,
  WordPressRewriteOptions,
  WordPressRewriteResult,
  WordPressBatchProgress,
  WordPressBatchProgressCallback,
} from "./types.js";

// Errors
export {
  RewriterError,
  ProviderError,
  ValidationError,
  RateLimitError,
  WordPressError,
} from "./types.js";

// Constants
export {
  LIMITS,
  PROCESSING,
  DEFAULTS,
  PROMPTS,
  MODEL_PRICING,
  getModelPricing,
  type PromptTemplateKey,
} from "./constants.js";

// Utilities (for advanced usage)
export {
  detectFormat,
  extractTitleFromHtml,
  extractTitleFromMarkdown,
  extractDescriptionFromHtml,
  normalizeArticleContent,
  estimateTokens,
  splitIntoChunks,
  parseAiResponse,
  checkUniqueness,
  type UniquenessResult,
} from "./utils.js";

// Cost estimation
export { estimateCost, calculateCost } from "./providers/openai.js";

// Providers (for direct access - advanced)
export {
  rewriteWithOpenAI,
  rewriteLargeContentWithOpenAI,
  generateVariantsWithOpenAI,
  type OpenAIRewriteOptions,
  type OpenAIRewriteResult,
} from "./providers/index.js";

// AI Pattern Masking (anti-detection)
export {
  maskAIPatterns,
  maskAIPatternsInHTML,
  type MaskingOptions,
} from "./masker.js";
