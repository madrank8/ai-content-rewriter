# RelationalSEO Rewrite-OS — Architecture Analysis

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER / BROWSER                           │
│  ┌───────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │  Login Page   │───▶│  Auth Guard  │───▶│  Rewrite-OS SPA  │  │
│  │  (Form POST)  │    │  (Token/     │    │  (Dynamic App)   │  │
│  │               │    │   Session)   │    │                  │  │
│  └───────────────┘    └──────────────┘    └──────────────────┘  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ HTTPS
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    login.relationalseo.com                       │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   Reverse Proxy / CDN                     │   │
│  │          (403 for unauthenticated requests)               │   │
│  └────────┬────────────────────────┬────────────────────┬───┘   │
│           │                        │                    │       │
│  ┌────────▼───────┐  ┌─────────────▼──────┐  ┌─────────▼────┐  │
│  │  Auth Service  │  │  Rewrite API       │  │  Static      │  │
│  │                │  │                    │  │  Assets      │  │
│  │  POST /login   │  │  POST /api/rewrite │  │  JS/CSS/IMG  │  │
│  │  POST /signup  │  │  GET  /api/history │  │              │  │
│  │  POST /logout  │  │  GET  /api/status  │  │              │  │
│  │  GET  /me      │  │  POST /api/bulk    │  │              │  │
│  └────────┬───────┘  └─────────┬──────────┘  └──────────────┘  │
│           │                    │                                │
│  ┌────────▼────────────────────▼──────────────────────────┐     │
│  │                  Backend Services                       │     │
│  │                                                        │     │
│  │  ┌──────────┐  ┌────────────┐  ┌────────────────────┐  │     │
│  │  │ Database │  │ AI/LLM API │  │ Queue / Job Worker │  │     │
│  │  │ (Users,  │  │ (GPT/      │  │ (Async rewrites)   │  │     │
│  │  │  Content,│  │  Claude/    │  │                    │  │     │
│  │  │  History)│  │  Custom)    │  │                    │  │     │
│  │  └──────────┘  └────────────┘  └────────────────────┘  │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

## Observations

### What We Know (from HTTP probing)
- **Domain**: `login.relationalseo.com` — dedicated auth subdomain
- **Access Control**: Returns **403 Forbidden** for all unauthenticated requests
- **No public crawling**: Not indexed by search engines, no robots.txt accessible
- **Protected SPA**: The `/rewrite-os` path is behind authentication

### Probable Architecture (based on common SaaS patterns)

| Component              | Likely Technology                          |
|------------------------|--------------------------------------------|
| **Frontend Framework** | React/Next.js or Vue/Nuxt (TBD by analyzer)|
| **Auth Method**        | JWT Bearer tokens or session cookies       |
| **API Style**          | REST JSON API (possibly GraphQL)           |
| **AI Backend**         | OpenAI/Anthropic API for content rewriting |
| **Hosting**            | Vercel, AWS, or Cloudflare (403 behavior)  |

## Estimated API Endpoints

| Method | Endpoint             | Purpose                    |
|--------|----------------------|----------------------------|
| POST   | /api/auth/login      | User authentication        |
| POST   | /api/auth/logout     | Session termination        |
| GET    | /api/auth/me         | Current user profile       |
| POST   | /api/rewrite         | Submit content for rewrite |
| GET    | /api/rewrite/:id     | Get rewrite job status     |
| GET    | /api/rewrite/history | List past rewrites         |
| POST   | /api/rewrite/bulk    | Batch rewrite submission   |
| GET    | /api/settings        | User/account settings      |

> **Note**: These are estimated based on common SaaS patterns.
> Run `analyze_relationalseo.py` to discover actual endpoints.

## Estimated Data Schema

```json
{
  "User": {
    "id": "string (UUID)",
    "email": "string",
    "name": "string",
    "plan": "string (free/pro/enterprise)",
    "credits": "integer",
    "created_at": "datetime"
  },
  "RewriteJob": {
    "id": "string (UUID)",
    "user_id": "string (UUID)",
    "original_content": "string",
    "rewritten_content": "string",
    "status": "string (pending/processing/completed/failed)",
    "options": {
      "tone": "string",
      "style": "string",
      "target_audience": "string",
      "seo_keywords": ["string"]
    },
    "created_at": "datetime",
    "completed_at": "datetime"
  }
}
```

## Automation Strategy

### Phase 1: Discovery (analyze_relationalseo.py)
- Browser-based login with Playwright
- Capture all network traffic (requests + responses)
- Extract actual API endpoints and data schemas
- Identify auth mechanism (JWT, cookies, OAuth)

### Phase 2: Direct API Automation (automation_workflow.py)
- Authenticate via discovered auth endpoint
- Call rewrite API directly (faster, no browser overhead)
- Support batch processing with rate limiting

### Phase 3: Browser Fallback
- If API calls are CSRF-protected or require browser context
- Playwright-based UI automation as fallback
- Screenshot capture for verification

## How to Run

```bash
# Install dependencies
pip install playwright requests
playwright install chromium

# Step 1: Analyze the site (run with display or headless)
python analyze_relationalseo.py

# Step 2: Update automation_workflow.py with discovered endpoints

# Step 3: Run automation
python automation_workflow.py
```
