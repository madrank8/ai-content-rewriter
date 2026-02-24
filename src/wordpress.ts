/**
 * WordPress Integration
 * =====================
 * Connect to WordPress sites via the REST API to fetch, rewrite, and
 * update posts/pages directly.
 *
 * Uses Application Passwords for authentication (built into WordPress core
 * since version 5.6). No plugins required.
 *
 * @example
 * ```typescript
 * import { WordPressRewriter } from "@affiliate.fm/ai-content-rewriter";
 *
 * const wp = new WordPressRewriter(
 *   {
 *     siteUrl: "https://example.com",
 *     username: "admin",
 *     applicationPassword: "XXXX XXXX XXXX XXXX XXXX XXXX",
 *   },
 *   {
 *     provider: "openai",
 *     apiKey: "sk-...",
 *   }
 * );
 *
 * // List recent posts
 * const posts = await wp.listPosts();
 *
 * // Rewrite a post and save as a new draft
 * const result = await wp.rewritePost(123, { createDraft: true });
 * ```
 */

import { ContentRewriter } from "./rewriter.js";
import type {
  WordPressConfig,
  WordPressPost,
  WordPressPostType,
  WordPressListOptions,
  WordPressRewriteOptions,
  WordPressRewriteResult,
  WordPressBatchProgressCallback,
  RewriterOptions,
  RewriteCallOptions,
} from "./types.js";
import { ValidationError, WordPressError } from "./types.js";

// =============================================================================
// WORDPRESS REWRITER CLASS
// =============================================================================

export class WordPressRewriter {
  private readonly wpConfig: WordPressConfig;
  private readonly rewriter: ContentRewriter;
  private readonly authHeader: string;
  private readonly baseApiUrl: string;

  /**
   * Create a new WordPressRewriter instance.
   *
   * @param wpConfig - WordPress site connection details
   * @param rewriterOptions - AI rewriter configuration (provider, API key, etc.)
   *
   * @example
   * ```typescript
   * const wp = new WordPressRewriter(
   *   {
   *     siteUrl: "https://example.com",
   *     username: "admin",
   *     applicationPassword: "XXXX XXXX XXXX XXXX XXXX XXXX",
   *   },
   *   {
   *     provider: "openai",
   *     apiKey: process.env.OPENAI_API_KEY!,
   *   }
   * );
   * ```
   */
  constructor(wpConfig: WordPressConfig, rewriterOptions: RewriterOptions) {
    this.validateConfig(wpConfig);
    this.wpConfig = wpConfig;
    this.rewriter = new ContentRewriter(rewriterOptions);

    // Build Basic Auth header (Application Passwords use Basic Auth)
    const credentials = `${wpConfig.username}:${wpConfig.applicationPassword}`;
    this.authHeader =
      "Basic " + Buffer.from(credentials, "utf-8").toString("base64");

    // Normalize site URL and build API base
    const siteUrl = wpConfig.siteUrl.replace(/\/+$/, "");
    this.baseApiUrl = `${siteUrl}/wp-json/wp/v2`;
  }

  // ===========================================================================
  // PUBLIC METHODS
  // ===========================================================================

  /**
   * Test the WordPress connection and authentication.
   *
   * @returns Object with connection status and site info
   * @throws {WordPressError} If the connection fails
   *
   * @example
   * ```typescript
   * const status = await wp.testConnection();
   * console.log(status.name); // "My WordPress Site"
   * ```
   */
  async testConnection(): Promise<{ name: string; url: string }> {
    const siteUrl = this.wpConfig.siteUrl.replace(/\/+$/, "");
    const response = await this.request(`${siteUrl}/wp-json`);
    return { name: response.name, url: response.url };
  }

  /**
   * List posts or pages from the WordPress site.
   *
   * @param options - Filtering and pagination options
   * @returns Array of WordPress posts/pages
   *
   * @example
   * ```typescript
   * // List published posts
   * const posts = await wp.listPosts();
   *
   * // List draft pages
   * const drafts = await wp.listPosts({
   *   type: "pages",
   *   status: "draft",
   *   perPage: 50,
   * });
   *
   * // Search posts
   * const results = await wp.listPosts({ search: "affiliate marketing" });
   * ```
   */
  async listPosts(options: WordPressListOptions = {}): Promise<WordPressPost[]> {
    const type = options.type || "posts";
    const params = new URLSearchParams();

    if (options.status && options.status !== "any") {
      params.set("status", options.status);
    } else if (options.status === "any") {
      params.set("status", "publish,draft,pending,private");
    }
    if (options.perPage) {
      params.set("per_page", String(Math.min(Math.max(options.perPage, 1), 100)));
    }
    if (options.page) {
      params.set("page", String(Math.max(options.page, 1)));
    }
    if (options.search) {
      params.set("search", options.search);
    }
    if (options.orderBy) {
      params.set("orderby", options.orderBy);
    }
    if (options.order) {
      params.set("order", options.order);
    }

    const queryString = params.toString();
    const url = `${this.baseApiUrl}/${type}${queryString ? `?${queryString}` : ""}`;

    return this.request(url);
  }

  /**
   * Fetch a single post or page by ID.
   *
   * @param id - WordPress post/page ID
   * @param type - Post type (default: "posts")
   * @returns The WordPress post/page
   *
   * @example
   * ```typescript
   * const post = await wp.getPost(123);
   * console.log(post.title.rendered);
   * ```
   */
  async getPost(
    id: number,
    type: WordPressPostType = "posts"
  ): Promise<WordPressPost> {
    return this.request(`${this.baseApiUrl}/${type}/${id}`);
  }

  /**
   * Rewrite a WordPress post/page using AI and optionally update it or
   * create a new draft.
   *
   * @param id - WordPress post/page ID to rewrite
   * @param options - Rewrite and WordPress-specific options
   * @returns Rewrite result with WordPress metadata
   *
   * @example
   * ```typescript
   * // Rewrite and preview (no changes saved)
   * const result = await wp.rewritePost(123);
   * console.log(result.rewriteResult.content);
   *
   * // Rewrite and update the original post
   * const result = await wp.rewritePost(123, { updatePost: true });
   *
   * // Rewrite and save as a new draft
   * const result = await wp.rewritePost(123, { createDraft: true });
   * console.log(`New draft ID: ${result.newPostId}`);
   *
   * // Rewrite with progress tracking
   * const result = await wp.rewritePost(123, {
   *   onProgress: (p) => console.log(p.message),
   * });
   * ```
   */
  async rewritePost(
    id: number,
    options: WordPressRewriteOptions = {}
  ): Promise<WordPressRewriteResult> {
    const {
      type = "posts",
      updatePost = false,
      createDraft = false,
      rewriteTitle = true,
      rewriteExcerpt = true,
      ...rewriteCallOptions
    } = options;

    if (updatePost && createDraft) {
      throw new ValidationError(
        "Cannot use both updatePost and createDraft. Choose one."
      );
    }

    // Fetch the original post
    const post = await this.getPost(id, type);

    // Strip rendered HTML wrappers WordPress adds
    const content = this.cleanRenderedContent(post.content.rendered);
    const title = this.decodeHtmlEntities(post.title.rendered);
    const excerpt = this.cleanRenderedContent(post.excerpt.rendered);

    // Rewrite using the core rewriter
    const rewriteOptions: RewriteCallOptions = {
      ...rewriteCallOptions,
      variants: 1,
    };

    const [result] = await this.rewriter.rewrite(
      {
        content,
        title: rewriteTitle ? title : undefined,
        description: rewriteExcerpt ? excerpt : undefined,
        format: "html",
      },
      rewriteOptions
    );

    // Use original title/excerpt if not rewriting them
    if (!rewriteTitle) {
      result.title = title;
    }
    if (!rewriteExcerpt) {
      result.description = excerpt;
    }

    const wpResult: WordPressRewriteResult = {
      postId: id,
      originalTitle: title,
      rewriteResult: result,
      updated: false,
    };

    // Update the original post
    if (updatePost) {
      await this.updatePostContent(id, type, result);
      wpResult.updated = true;
    }

    // Create a new draft with rewritten content
    if (createDraft) {
      const newPost = await this.createDraftPost(type, post, result);
      wpResult.newPostId = newPost.id;
    }

    return wpResult;
  }

  /**
   * Rewrite multiple posts/pages in sequence.
   *
   * @param ids - Array of post/page IDs to rewrite
   * @param options - Rewrite options applied to all posts
   * @param onBatchProgress - Callback for batch-level progress
   * @returns Array of rewrite results
   *
   * @example
   * ```typescript
   * const results = await wp.rewritePosts([101, 102, 103], {
   *   createDraft: true,
   * }, (progress) => {
   *   console.log(`${progress.currentPost}/${progress.totalPosts}: ${progress.postTitle}`);
   * });
   * ```
   */
  async rewritePosts(
    ids: number[],
    options: WordPressRewriteOptions = {},
    onBatchProgress?: WordPressBatchProgressCallback
  ): Promise<WordPressRewriteResult[]> {
    if (ids.length === 0) {
      return [];
    }

    const results: WordPressRewriteResult[] = [];
    const type = options.type || "posts";

    for (let i = 0; i < ids.length; i++) {
      const postId = ids[i];

      // Report batch progress with post title
      let postTitle = `Post #${postId}`;
      if (onBatchProgress) {
        try {
          const post = await this.getPost(postId, type);
          postTitle = this.decodeHtmlEntities(post.title.rendered);
        } catch {
          // Use fallback title
        }
      }

      // Wrap the per-post onProgress to include batch context
      const perPostOptions: WordPressRewriteOptions = {
        ...options,
        onProgress: onBatchProgress
          ? (rewriteProgress) => {
              onBatchProgress({
                currentPost: i + 1,
                totalPosts: ids.length,
                postId,
                postTitle,
                rewriteProgress,
              });
            }
          : options.onProgress,
      };

      if (onBatchProgress) {
        onBatchProgress({
          currentPost: i + 1,
          totalPosts: ids.length,
          postId,
          postTitle,
        });
      }

      const result = await this.rewritePost(postId, perPostOptions);
      results.push(result);
    }

    return results;
  }

  /**
   * Access the underlying ContentRewriter instance for direct use.
   */
  getRewriter(): ContentRewriter {
    return this.rewriter;
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  private validateConfig(config: WordPressConfig): void {
    if (!config.siteUrl) {
      throw new ValidationError("WordPress siteUrl is required");
    }
    if (!config.username) {
      throw new ValidationError("WordPress username is required");
    }
    if (!config.applicationPassword) {
      throw new ValidationError("WordPress applicationPassword is required");
    }
    try {
      new URL(config.siteUrl);
    } catch {
      throw new ValidationError(
        `Invalid WordPress siteUrl: ${config.siteUrl}`
      );
    }
  }

  private async request(url: string, init?: RequestInit): Promise<any> {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });

    if (!response.ok) {
      let errorBody: any;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text().catch(() => null);
      }

      const message =
        errorBody?.message || `WordPress API error: ${response.status}`;

      if (response.status === 401) {
        throw new WordPressError(
          `Authentication failed: ${message}. Verify your username and Application Password.`,
          401,
          errorBody
        );
      }
      if (response.status === 403) {
        throw new WordPressError(
          `Permission denied: ${message}. The user may lack sufficient capabilities.`,
          403,
          errorBody
        );
      }
      if (response.status === 404) {
        throw new WordPressError(
          `Not found: ${message}. Check that the post ID and type are correct.`,
          404,
          errorBody
        );
      }

      throw new WordPressError(message, response.status, errorBody);
    }

    return response.json();
  }

  private async updatePostContent(
    id: number,
    type: WordPressPostType,
    result: { content: string; title: string; description: string }
  ): Promise<void> {
    await this.request(`${this.baseApiUrl}/${type}/${id}`, {
      method: "POST",
      body: JSON.stringify({
        title: result.title,
        content: result.content,
        excerpt: result.description,
      }),
    });
  }

  private async createDraftPost(
    type: WordPressPostType,
    originalPost: WordPressPost,
    result: { content: string; title: string; description: string }
  ): Promise<WordPressPost> {
    const body: Record<string, unknown> = {
      title: result.title,
      content: result.content,
      excerpt: result.description,
      status: "draft",
    };

    // Carry over categories and tags from the original
    if (originalPost.categories) {
      body.categories = originalPost.categories;
    }
    if (originalPost.tags) {
      body.tags = originalPost.tags;
    }
    if (originalPost.featured_media) {
      body.featured_media = originalPost.featured_media;
    }

    return this.request(`${this.baseApiUrl}/${type}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * Clean WordPress rendered content by removing wrapper elements
   * that WordPress adds during rendering (e.g., wrapping <p> tags).
   */
  private cleanRenderedContent(html: string): string {
    return html.trim();
  }

  /**
   * Decode common HTML entities that WordPress renders in titles.
   */
  private decodeHtmlEntities(text: string): string {
    return text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&#8217;/g, "\u2019")
      .replace(/&#8216;/g, "\u2018")
      .replace(/&#8220;/g, "\u201C")
      .replace(/&#8221;/g, "\u201D")
      .replace(/&#8211;/g, "\u2013")
      .replace(/&#8212;/g, "\u2014")
      .replace(/&#8230;/g, "\u2026");
  }
}
