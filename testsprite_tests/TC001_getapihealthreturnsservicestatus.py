"""
TC001 — Convex deployment is reachable and returns JSON (not HTML).

There is no /api/health endpoint in this app. Instead we verify that:
  1. The Convex cloud URL responds with valid JSON to a basic query call
     (even an unauthenticated one returns a structured error, never HTML).
  2. The Convex site URL (HTTP actions) is reachable.
"""

import sys, os
sys.path.insert(0, os.path.dirname(__file__))

import requests
from convex_helpers import CONVEX_URL, CONVEX_SITE_URL, TIMEOUT


def test_convex_cloud_returns_json_not_html():
    """
    POST /api/query without auth returns a JSON auth-error — not a 404 HTML page.
    """
    response = requests.post(
        f"{CONVEX_URL}/api/query",
        headers={"Content-Type": "application/json"},
        json={"path": "organizations:listMine", "args": {}, "format": "json"},
        timeout=TIMEOUT,
    )
    assert response.status_code == 200, (
        f"Expected HTTP 200 from Convex, got {response.status_code}"
    )
    data = response.json()
    assert isinstance(data, dict), "Convex should return a JSON object"
    assert "errorMessage" in data or "value" in data, (
        f"Unexpected response shape: {data}"
    )


def test_convex_site_is_reachable():
    """
    A GET to /clerk-webhook on the site URL should return a Convex error (405/404),
    not an HTML page from Next.js.
    """
    response = requests.get(
        f"{CONVEX_SITE_URL}/clerk-webhook",
        timeout=TIMEOUT,
        allow_redirects=False,
    )
    assert response.status_code in (404, 405, 400), (
        f"Expected 404/405/400 from Convex site for GET, got {response.status_code}"
    )


test_convex_cloud_returns_json_not_html()
test_convex_site_is_reachable()
