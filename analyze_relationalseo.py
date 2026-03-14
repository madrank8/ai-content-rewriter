#!/usr/bin/env python3
"""
RelationalSEO Rewrite-OS Analyzer
Automates login, captures network traffic, and extracts:
- Frontend framework
- API endpoints
- Authentication method
- Data schema
- Dynamic content loading patterns
"""

import json
import time
import re
import sys
from datetime import datetime

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("Install playwright: pip install playwright && playwright install chromium")
    sys.exit(1)


CONFIG = {
    "login_url": "https://login.relationalseo.com",
    "app_url": "https://login.relationalseo.com/rewrite-os",
    "email": "nirotnt@gmail.com",
    "password": "y3ZR2YFaaJ7WbMy",
}

OUTPUT_FILE = "relationalseo_analysis.json"


def analyze_site():
    results = {
        "timestamp": datetime.now().isoformat(),
        "framework": None,
        "auth_method": None,
        "api_endpoints": [],
        "data_schemas": [],
        "js_bundles": [],
        "cookies": [],
        "local_storage": {},
        "dynamic_content_patterns": [],
    }

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()

        # Capture all network requests
        api_requests = []

        def handle_request(request):
            url = request.url
            method = request.method
            headers = dict(request.headers)

            # Filter for API calls (skip static assets)
            if any(ext in url for ext in [".js", ".css", ".png", ".jpg", ".svg", ".woff", ".ico"]):
                if url.endswith(".js"):
                    results["js_bundles"].append(url)
                return

            entry = {
                "url": url,
                "method": method,
                "content_type": headers.get("content-type", ""),
                "auth_header": headers.get("authorization", ""),
            }

            # Capture POST body if present
            if method == "POST" and request.post_data:
                try:
                    entry["body"] = json.loads(request.post_data)
                except (json.JSONDecodeError, TypeError):
                    entry["body"] = request.post_data

            api_requests.append(entry)

        def handle_response(response):
            url = response.url
            status = response.status
            content_type = response.headers.get("content-type", "")

            if "application/json" in content_type:
                try:
                    body = response.json()
                    results["data_schemas"].append({
                        "url": url,
                        "status": status,
                        "schema": extract_schema(body),
                        "sample": truncate_sample(body),
                    })
                except Exception:
                    pass

        page = context.new_page()
        page.on("request", handle_request)
        page.on("response", handle_response)

        # Step 1: Navigate to login
        print("[*] Navigating to login page...")
        page.goto(CONFIG["login_url"], wait_until="networkidle", timeout=30000)
        time.sleep(2)

        # Detect framework from page source
        results["framework"] = detect_framework(page)

        # Step 2: Login
        print("[*] Attempting login...")
        try:
            # Try common login form selectors
            email_selectors = [
                'input[type="email"]',
                'input[name="email"]',
                'input[name="username"]',
                'input[id="email"]',
                'input[placeholder*="email" i]',
                'input[placeholder*="username" i]',
            ]
            password_selectors = [
                'input[type="password"]',
                'input[name="password"]',
                'input[id="password"]',
            ]
            submit_selectors = [
                'button[type="submit"]',
                'input[type="submit"]',
                'button:has-text("Log in")',
                'button:has-text("Sign in")',
                'button:has-text("Login")',
            ]

            email_input = try_selectors(page, email_selectors)
            if email_input:
                email_input.fill(CONFIG["email"])

            password_input = try_selectors(page, password_selectors)
            if password_input:
                password_input.fill(CONFIG["password"])

            submit_btn = try_selectors(page, submit_selectors)
            if submit_btn:
                submit_btn.click()

            page.wait_for_load_state("networkidle", timeout=15000)
            time.sleep(3)

        except Exception as e:
            print(f"[!] Login error: {e}")

        # Step 3: Navigate to rewrite-os
        print("[*] Navigating to rewrite-os...")
        page.goto(CONFIG["app_url"], wait_until="networkidle", timeout=30000)
        time.sleep(3)

        # Step 4: Extract auth info
        cookies = context.cookies()
        results["cookies"] = [
            {"name": c["name"], "domain": c["domain"], "httpOnly": c["httpOnly"], "secure": c["secure"]}
            for c in cookies
        ]

        # Check for auth tokens
        local_storage = page.evaluate("() => { const items = {}; for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); items[key] = localStorage.getItem(key); } return items; }")
        results["local_storage"] = local_storage

        # Detect auth method
        results["auth_method"] = detect_auth_method(cookies, local_storage, api_requests)

        # Step 5: Interact with UI to trigger more API calls
        print("[*] Exploring UI interactions...")
        explore_ui(page)
        time.sleep(2)

        # Step 6: Take screenshot
        page.screenshot(path="relationalseo_screenshot.png", full_page=True)
        print("[*] Screenshot saved: relationalseo_screenshot.png")

        # Compile API endpoints
        results["api_endpoints"] = deduplicate_endpoints(api_requests)

        # Detect dynamic content patterns
        results["dynamic_content_patterns"] = detect_dynamic_patterns(api_requests)

        browser.close()

    # Save results
    with open(OUTPUT_FILE, "w") as f:
        json.dump(results, f, indent=2, default=str)

    print(f"\n[*] Analysis saved to {OUTPUT_FILE}")
    print_summary(results)

    return results


def detect_framework(page):
    """Detect frontend framework from page markers."""
    checks = {
        "Next.js": [
            "() => !!document.getElementById('__next')",
            "() => !!window.__NEXT_DATA__",
            "() => !!document.querySelector('script[src*=\"_next\"]')",
        ],
        "React": [
            "() => !!document.querySelector('[data-reactroot]')",
            "() => { const el = document.querySelector('#root, #app, #__next'); return el && (el._reactRootContainer !== undefined || Object.keys(el).some(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'))); }",
        ],
        "Vue.js": [
            "() => !!window.__VUE__",
            "() => !!document.querySelector('[data-v-]')",
            "() => { const el = document.querySelector('#app'); return el && el.__vue__ !== undefined; }",
        ],
        "Angular": [
            "() => !!window.ng",
            "() => !!document.querySelector('[ng-version]')",
            "() => !!document.querySelector('[_ngcontent]')",
        ],
        "Svelte": [
            "() => !!document.querySelector('[class*=\"svelte-\"]')",
        ],
        "Nuxt.js": [
            "() => !!window.__NUXT__",
            "() => !!document.getElementById('__nuxt')",
        ],
    }

    detected = []
    for framework, js_checks in checks.items():
        for check in js_checks:
            try:
                if page.evaluate(check):
                    detected.append(framework)
                    break
            except Exception:
                pass

    # Also check meta tags and script sources
    try:
        page_source = page.content()
        if "_next/static" in page_source or "__NEXT_DATA__" in page_source:
            if "Next.js" not in detected:
                detected.append("Next.js")
        if "vue" in page_source.lower() and "Vue.js" not in detected:
            detected.append("Vue.js (probable)")
    except Exception:
        pass

    return detected if detected else ["Unknown - manual inspection needed"]


def detect_auth_method(cookies, local_storage, requests):
    """Determine authentication method from captured data."""
    methods = []

    # Check for JWT in cookies or storage
    for cookie in cookies:
        if any(k in cookie["name"].lower() for k in ["token", "jwt", "session", "auth"]):
            methods.append(f"Cookie-based: {cookie['name']}")

    for key, value in local_storage.items():
        if any(k in key.lower() for k in ["token", "jwt", "auth", "access"]):
            methods.append(f"LocalStorage token: {key}")
            if value and value.startswith("eyJ"):
                methods.append("JWT token detected")

    # Check for Authorization headers in API calls
    for req in requests:
        auth = req.get("auth_header", "")
        if auth:
            if auth.startswith("Bearer"):
                methods.append("Bearer token auth")
            elif auth.startswith("Basic"):
                methods.append("Basic auth")
            else:
                methods.append(f"Custom auth header: {auth[:20]}...")
            break

    # Check for OAuth indicators
    for req in requests:
        url = req.get("url", "")
        if any(k in url for k in ["oauth", "authorize", "callback", "auth0", "cognito"]):
            methods.append(f"OAuth/SSO: {url}")

    return methods if methods else ["Session-based (cookies)"]


def try_selectors(page, selectors):
    """Try multiple CSS selectors, return first match."""
    for selector in selectors:
        try:
            el = page.query_selector(selector)
            if el and el.is_visible():
                return el
        except Exception:
            pass
    return None


def explore_ui(page):
    """Click through UI elements to trigger API calls."""
    interactive_selectors = [
        "button",
        "a[href]",
        "[role='tab']",
        "[role='button']",
        ".nav-item",
        ".menu-item",
    ]

    for selector in interactive_selectors:
        try:
            elements = page.query_selector_all(selector)
            for el in elements[:3]:  # Limit to first 3 of each type
                if el.is_visible():
                    try:
                        el.click()
                        page.wait_for_load_state("networkidle", timeout=3000)
                        time.sleep(0.5)
                    except Exception:
                        pass
        except Exception:
            pass


def extract_schema(data, depth=0, max_depth=3):
    """Extract JSON schema structure from response data."""
    if depth > max_depth:
        return "..."

    if isinstance(data, dict):
        return {k: extract_schema(v, depth + 1) for k, v in list(data.items())[:20]}
    elif isinstance(data, list):
        if data:
            return [extract_schema(data[0], depth + 1)]
        return []
    elif isinstance(data, str):
        return "string"
    elif isinstance(data, bool):
        return "boolean"
    elif isinstance(data, int):
        return "integer"
    elif isinstance(data, float):
        return "number"
    elif data is None:
        return "null"
    return str(type(data).__name__)


def truncate_sample(data, max_str_len=100):
    """Truncate sample data for readability."""
    if isinstance(data, dict):
        return {k: truncate_sample(v) for k, v in list(data.items())[:10]}
    elif isinstance(data, list):
        return [truncate_sample(item) for item in data[:3]]
    elif isinstance(data, str) and len(data) > max_str_len:
        return data[:max_str_len] + "..."
    return data


def deduplicate_endpoints(requests):
    """Deduplicate and categorize API endpoints."""
    seen = set()
    endpoints = []

    for req in requests:
        url = req["url"]
        method = req["method"]

        # Normalize URL (remove query params for dedup)
        base_url = url.split("?")[0]
        key = f"{method}:{base_url}"

        if key not in seen:
            seen.add(key)
            endpoints.append({
                "method": method,
                "url": base_url,
                "has_query_params": "?" in url,
                "has_body": "body" in req,
                "content_type": req.get("content_type", ""),
            })

    return endpoints


def detect_dynamic_patterns(requests):
    """Identify how dynamic content is loaded."""
    patterns = []

    api_calls = [r for r in requests if "api" in r["url"].lower() or "graphql" in r["url"].lower()]
    if api_calls:
        patterns.append("REST API calls for data fetching")

    graphql = [r for r in requests if "graphql" in r["url"].lower()]
    if graphql:
        patterns.append("GraphQL queries")

    websocket_indicators = [r for r in requests if "ws:" in r["url"] or "wss:" in r["url"]]
    if websocket_indicators:
        patterns.append("WebSocket connections for real-time updates")

    sse = [r for r in requests if "stream" in r.get("content_type", "").lower()]
    if sse:
        patterns.append("Server-Sent Events (SSE) for streaming")

    return patterns if patterns else ["Standard HTTP request/response"]


def print_summary(results):
    """Print a formatted summary of findings."""
    print("\n" + "=" * 60)
    print("  RELATIONALSEO REWRITE-OS ANALYSIS SUMMARY")
    print("=" * 60)

    print(f"\n[Framework]  {', '.join(results['framework']) if isinstance(results['framework'], list) else results['framework']}")
    print(f"[Auth]       {', '.join(results['auth_method']) if isinstance(results['auth_method'], list) else results['auth_method']}")

    print(f"\n[API Endpoints] ({len(results['api_endpoints'])} found)")
    for ep in results["api_endpoints"]:
        print(f"  {ep['method']:6s} {ep['url']}")

    print(f"\n[Data Schemas] ({len(results['data_schemas'])} captured)")
    for schema in results["data_schemas"][:5]:
        print(f"  {schema['url']}")
        print(f"    Schema: {json.dumps(schema['schema'], indent=2)[:200]}...")

    print(f"\n[JS Bundles] ({len(results['js_bundles'])} loaded)")
    for bundle in results["js_bundles"][:5]:
        print(f"  {bundle}")

    print(f"\n[Dynamic Content] {', '.join(results['dynamic_content_patterns'])}")
    print(f"\n[Cookies] {len(results['cookies'])} set")
    for c in results["cookies"]:
        print(f"  {c['name']} (domain: {c['domain']}, httpOnly: {c['httpOnly']})")

    print("\n" + "=" * 60)


if __name__ == "__main__":
    analyze_site()
