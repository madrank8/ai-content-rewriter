#!/usr/bin/env python3
"""
RelationalSEO Rewrite-OS Automation Workflow
Automates the content rewriting workflow once API endpoints are discovered.

Usage:
  1. First run analyze_relationalseo.py to discover endpoints
  2. Update the API_BASE and endpoints below based on findings
  3. Run this script to automate content rewriting
"""

import json
import time
import requests
import sys
from pathlib import Path

# ─── Configuration (update after running analyzer) ───────────────────────────

API_BASE = "https://login.relationalseo.com"  # Update based on analysis
AUTH_ENDPOINT = "/api/auth/login"               # Update based on analysis
REWRITE_ENDPOINT = "/api/rewrite"               # Update based on analysis

CREDENTIALS = {
    "email": "nirotnt@gmail.com",
    "password": "y3ZR2YFaaJ7WbMy",
}


# ─── Session Manager ─────────────────────────────────────────────────────────

class RelationalSEOClient:
    def __init__(self, base_url=API_BASE):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
            "Accept": "application/json",
            "Content-Type": "application/json",
        })
        self.token = None

    def login(self):
        """Authenticate and store session/token."""
        print("[*] Logging in...")

        # Strategy 1: JSON POST to auth endpoint
        try:
            resp = self.session.post(
                f"{self.base_url}{AUTH_ENDPOINT}",
                json=CREDENTIALS,
                timeout=15,
            )
            if resp.ok:
                data = resp.json()
                # Extract token (common patterns)
                self.token = (
                    data.get("token")
                    or data.get("access_token")
                    or data.get("data", {}).get("token")
                )
                if self.token:
                    self.session.headers["Authorization"] = f"Bearer {self.token}"
                    print("[+] Login successful (Bearer token)")
                    return True
                else:
                    # Session cookie auth - already stored in session
                    print("[+] Login successful (session cookie)")
                    return True
        except Exception as e:
            print(f"[!] Login strategy 1 failed: {e}")

        # Strategy 2: Form POST
        try:
            resp = self.session.post(
                f"{self.base_url}/login",
                data=CREDENTIALS,
                timeout=15,
            )
            if resp.ok:
                print("[+] Login successful (form POST)")
                return True
        except Exception as e:
            print(f"[!] Login strategy 2 failed: {e}")

        print("[-] Login failed. Run analyze_relationalseo.py first to discover auth endpoints.")
        return False

    def rewrite_content(self, content, options=None):
        """Submit content for rewriting."""
        payload = {
            "content": content,
            "text": content,  # Some APIs use 'text' instead
        }
        if options:
            payload.update(options)

        resp = self.session.post(
            f"{self.base_url}{REWRITE_ENDPOINT}",
            json=payload,
            timeout=60,
        )

        if resp.ok:
            return resp.json()

        print(f"[-] Rewrite failed: {resp.status_code} {resp.text[:200]}")
        return None

    def get_rewrite_status(self, job_id):
        """Poll for async rewrite job completion."""
        for attempt in range(30):
            resp = self.session.get(
                f"{self.base_url}{REWRITE_ENDPOINT}/{job_id}",
                timeout=15,
            )
            if resp.ok:
                data = resp.json()
                status = data.get("status", "")
                if status in ("completed", "done", "finished"):
                    return data
                elif status in ("failed", "error"):
                    print(f"[-] Job failed: {data}")
                    return None
            time.sleep(2)

        print("[-] Job timed out")
        return None

    def batch_rewrite(self, contents, options=None):
        """Rewrite multiple pieces of content."""
        results = []
        for i, content in enumerate(contents):
            print(f"[*] Rewriting {i + 1}/{len(contents)}...")
            result = self.rewrite_content(content, options)
            if result:
                # Check if async
                job_id = result.get("job_id") or result.get("id")
                if job_id and result.get("status") in ("pending", "processing"):
                    result = self.get_rewrite_status(job_id)

                results.append(result)
            else:
                results.append({"error": "Failed", "original": content})

            time.sleep(1)  # Rate limiting

        return results


# ─── Playwright-based automation (for JS-heavy apps) ─────────────────────────

def automate_with_browser(contents):
    """
    Use Playwright for browser-based automation when direct API
    access is not available (e.g., CSRF-protected forms).
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Install playwright: pip install playwright && playwright install chromium")
        return []

    results = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context()
        page = context.new_page()

        # Login
        page.goto(f"{API_BASE}", wait_until="networkidle")
        time.sleep(1)

        # Fill login form
        for selector in ['input[type="email"]', 'input[name="email"]', 'input[placeholder*="email" i]']:
            el = page.query_selector(selector)
            if el:
                el.fill(CREDENTIALS["email"])
                break

        for selector in ['input[type="password"]', 'input[name="password"]']:
            el = page.query_selector(selector)
            if el:
                el.fill(CREDENTIALS["password"])
                break

        for selector in ['button[type="submit"]', 'button:has-text("Log in")', 'button:has-text("Sign in")']:
            el = page.query_selector(selector)
            if el:
                el.click()
                break

        page.wait_for_load_state("networkidle", timeout=15000)
        time.sleep(2)

        # Navigate to rewrite-os
        page.goto(f"{API_BASE}/rewrite-os", wait_until="networkidle")
        time.sleep(2)

        # Process each content item
        for i, content in enumerate(contents):
            print(f"[*] Browser rewriting {i + 1}/{len(contents)}...")

            # Find textarea/input for content
            textarea = page.query_selector('textarea, [contenteditable="true"], input[type="text"]')
            if textarea:
                textarea.fill(content)

                # Find and click submit/rewrite button
                for btn_selector in [
                    'button:has-text("Rewrite")',
                    'button:has-text("Submit")',
                    'button:has-text("Generate")',
                    'button[type="submit"]',
                ]:
                    btn = page.query_selector(btn_selector)
                    if btn:
                        btn.click()
                        break

                # Wait for result
                page.wait_for_load_state("networkidle", timeout=30000)
                time.sleep(3)

                # Extract result (look for output areas)
                for result_selector in [
                    ".result",
                    ".output",
                    "[data-result]",
                    ".rewritten-content",
                    "#output",
                ]:
                    result_el = page.query_selector(result_selector)
                    if result_el:
                        results.append({
                            "original": content,
                            "rewritten": result_el.inner_text(),
                        })
                        break
                else:
                    # Fallback: capture page text
                    results.append({
                        "original": content,
                        "rewritten": "Check screenshot for result",
                    })

                page.screenshot(path=f"rewrite_result_{i}.png")

        browser.close()

    return results


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    # Sample content to rewrite
    sample_contents = [
        "Artificial intelligence is transforming the way businesses operate.",
        "Search engine optimization requires a strategic approach to content.",
    ]

    print("=" * 50)
    print("  RelationalSEO Rewrite-OS Automation")
    print("=" * 50)

    # Try API-based approach first
    client = RelationalSEOClient()
    if client.login():
        results = client.batch_rewrite(sample_contents)
        if results and not any(r.get("error") for r in results):
            print("\n[+] API-based rewriting successful!")
            for r in results:
                print(json.dumps(r, indent=2))
            return

    # Fallback to browser automation
    print("\n[*] Falling back to browser automation...")
    results = automate_with_browser(sample_contents)
    if results:
        print("\n[+] Browser-based rewriting completed!")
        for r in results:
            print(json.dumps(r, indent=2))
    else:
        print("\n[-] Automation failed. Manual analysis required.")
        print("    Run: python analyze_relationalseo.py")
        print("    Then update endpoints in this script.")


if __name__ == "__main__":
    main()
