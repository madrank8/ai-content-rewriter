/**
 * AI Content Rewriter Types
 * =========================
 * Core type definitions for the rewriter library.
 */

// =============================================================================
// CONTENT TYPES
// =============================================================================

export type ContentFormat = "html" | "markdown" | "text";

export interface ContentInput {
  /** Main content to rewrite (HTML, Markdown, or plain text) */
  content: string;
  /** Page title (optional, will be extracted from content if not provided) */
  title?: string;
  /** Meta description (optional) */
  description?: string;
  /** Content format (auto-detected if not specified) */
  format?: ContentFormat;
}

export interface RewriteResult {
  /** Rewritten content */
  content: string;
  /** Rewritten title */
  title: string;
  /** Rewritten description */
  description: string;
  /** Cost of this rewrite in USD (if available) */
  cost?: number;
  /** Original format that was detected/used */
  format: ContentFormat;
}

// =============================================================================
// PROVIDER TYPES
// =============================================================================

export type ProviderType = "openai" | "anthropic" | "custom";

/**
 * Provider configuration for constructor.
 * API key and type are required, model has a default.
 */
export interface ProviderConfig {
  /** Provider type */
  type: ProviderType;
  /** API key for the provider */
  apiKey: string;
  /** Model to use (e.g., "gpt-4.1", "claude-3-opus"). Default: "gpt-4.1" */
  model?: string;
  /** Base URL for custom providers or proxies */
  baseUrl?: string;
  /** Additional provider-specific options */
  options?: Record<string, unknown>;
}

// =============================================================================
// CONSTRUCTOR OPTIONS
// =============================================================================

/**
 * Options passed to ContentRewriter constructor.
 * Provider config is required here, not in each rewrite call.
 */
export interface RewriterOptions {
  /** Provider type: "openai", "anthropic", or "custom" */
  provider: ProviderType;
  /** API key for the provider */
  apiKey: string;
  /** Model to use (default: "gpt-4.1") */
  model?: string;
  /** Base URL for custom providers or proxies */
  baseUrl?: string;
  /** Default temperature for generation (0-2, default: 0.9) */
  temperature?: number;
  /** Custom prompt templates to add */
  customPrompts?: Record<string, string | { name: string; prompt: string }>;
}

// =============================================================================
// REWRITE OPTIONS (per-call)
// =============================================================================

/**
 * Options for individual rewrite() calls.
 * Provider is NOT here - it's in constructor.
 */
export interface RewriteCallOptions {
  /** Custom prompt (uses built-in if not specified) */
  prompt?: string;
  /** Prompt template key from built-in templates */
  promptTemplate?: string;
  /** Number of variants to generate (default: 1) */
  variants?: number;
  /** Temperature for this specific call (overrides constructor default) */
  temperature?: number;
  /** Progress callback for tracking generation */
  onProgress?: ProgressCallback;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Apply AI pattern masking to results (default: true) */
  maskAIPatterns?: boolean;
}

// =============================================================================
// PROGRESS TRACKING
// =============================================================================

export interface RewriteProgress {
  /** Current phase of rewriting */
  phase: "preparing" | "generating" | "processing" | "done";
  /** Current variant being generated (1-based) */
  currentVariant: number;
  /** Total variants to generate */
  totalVariants: number;
  /** For large content: current chunk (1-based) */
  currentChunk?: number;
  /** For large content: total chunks */
  totalChunks?: number;
  /** Human-readable status message */
  message: string;
  /** Accumulated cost so far */
  costSoFar?: number;
}

export type ProgressCallback = (progress: RewriteProgress) => void;

// =============================================================================
// STREAMING SUPPORT
// =============================================================================

export interface StreamingResult {
  /** Partial or complete result */
  result: Partial<RewriteResult>;
  /** Whether this is the final result */
  isFinal: boolean;
  /** Variant index (0-based) */
  variantIndex: number;
}

export type StreamingCallback = (result: StreamingResult) => void;

// =============================================================================
// ERRORS
// =============================================================================

export class RewriterError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "RewriterError";
  }
}

export class ProviderError extends RewriterError {
  constructor(
    message: string,
    public readonly provider: ProviderType,
    details?: unknown
  ) {
    super(message, "PROVIDER_ERROR", details);
    this.name = "ProviderError";
  }
}

export class ValidationError extends RewriterError {
  constructor(message: string, details?: unknown) {
    super(message, "VALIDATION_ERROR", details);
    this.name = "ValidationError";
  }
}

export class RateLimitError extends ProviderError {
  constructor(provider: ProviderType, public readonly retryAfter?: number) {
    super("Rate limit exceeded", provider, { retryAfter });
    this.name = "RateLimitError";
  }
}

export class WordPressError extends RewriterError {
  constructor(
    message: string,
    public readonly statusCode?: number,
    details?: unknown
  ) {
    super(message, "WORDPRESS_ERROR", details);
    this.name = "WordPressError";
  }
}

// =============================================================================
// WORDPRESS TYPES
// =============================================================================

/** WordPress site connection configuration */
export interface WordPressConfig {
  /** WordPress site URL (e.g., "https://example.com") */
  siteUrl: string;
  /** WordPress username */
  username: string;
  /** WordPress Application Password (generate in Users → Profile → Application Passwords) */
  applicationPassword: string;
}

/** WordPress post/page type identifier */
export type WordPressPostType = "posts" | "pages";

/** WordPress post status */
export type WordPressPostStatus =
  | "publish"
  | "draft"
  | "pending"
  | "private"
  | "future"
  | "trash";

/** WordPress post as returned by the REST API */
export interface WordPressPost {
  id: number;
  date: string;
  date_gmt: string;
  modified: string;
  modified_gmt: string;
  slug: string;
  status: WordPressPostStatus;
  type: string;
  link: string;
  title: { rendered: string };
  content: { rendered: string; protected: boolean };
  excerpt: { rendered: string; protected: boolean };
  author: number;
  featured_media: number;
  categories?: number[];
  tags?: number[];
}

/** Options for listing WordPress posts/pages */
export interface WordPressListOptions {
  /** Post type to list (default: "posts") */
  type?: WordPressPostType;
  /** Filter by status (default: "publish") */
  status?: WordPressPostStatus | "any";
  /** Number of results per page (1-100, default: 10) */
  perPage?: number;
  /** Page number (default: 1) */
  page?: number;
  /** Search term to filter posts */
  search?: string;
  /** Field to order results by */
  orderBy?: "date" | "title" | "id" | "modified" | "slug";
  /** Sort direction */
  order?: "asc" | "desc";
}

/** Options for rewriting a WordPress post */
export interface WordPressRewriteOptions extends RewriteCallOptions {
  /** Post type (default: "posts") */
  type?: WordPressPostType;
  /** Update the original post with rewritten content (default: false) */
  updatePost?: boolean;
  /** Create a new draft with the rewritten content instead of updating (default: false) */
  createDraft?: boolean;
  /** Rewrite the post title (default: true) */
  rewriteTitle?: boolean;
  /** Rewrite the excerpt/meta description (default: true) */
  rewriteExcerpt?: boolean;
}

/** Result of a WordPress post rewrite operation */
export interface WordPressRewriteResult {
  /** Original post ID */
  postId: number;
  /** Original post title */
  originalTitle: string;
  /** The rewrite result (content, title, description, cost) */
  rewriteResult: RewriteResult;
  /** Whether the original post was updated in WordPress */
  updated: boolean;
  /** ID of the new draft post, if createDraft was true */
  newPostId?: number;
}

/** Progress callback for batch WordPress operations */
export interface WordPressBatchProgress {
  /** Current post being processed (1-based) */
  currentPost: number;
  /** Total posts to process */
  totalPosts: number;
  /** ID of the post being processed */
  postId: number;
  /** Title of the post being processed */
  postTitle: string;
  /** Rewrite progress for the current post (if available) */
  rewriteProgress?: RewriteProgress;
}

export type WordPressBatchProgressCallback = (
  progress: WordPressBatchProgress
) => void;
