"""
Shared helpers for AutoFlow Convex backend tests.

Secrets are loaded (in priority order) from:
  1. Environment variables already set in the shell
  2. testsprite_tests/.env.test  (gitignored — safe to put real tokens here)

Required tokens:
  CLERK_JWT_TOKEN        — Clerk session JWT (aud=convex). Expires every ~60 s.
                           Auto-refresh (requires pnpm dev to be running):
                             node testsprite_tests/get_token.js
                           Or via PowerShell (tries auto then falls back to paste):
                             .\\testsprite_tests\\refresh_token.ps1

  CLERK_WEBHOOK_SECRET   — Svix signing secret for TC002.
                           Run:  npx convex env get CLERK_WEBHOOK_SECRET
"""

import os
import pathlib
import requests

# ── Load .env.test ──────────────────────────────────────────────────────────────
_ENV_FILE = pathlib.Path(__file__).parent / ".env.test"

def _load_env_file() -> None:
    """Parse key=value lines from .env.test and set them in os.environ if not already set."""
    if not _ENV_FILE.exists():
        return
    for line in _ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if key and value and key not in os.environ:
            os.environ[key] = value

_load_env_file()

# ── Endpoints ──────────────────────────────────────────────────────────────────
CONVEX_URL = "https://fine-mallard-320.eu-west-1.convex.cloud"   # Queries / mutations
CONVEX_SITE_URL = "https://fine-mallard-320.eu-west-1.convex.site"  # HTTP actions (webhooks)

# ── Auth ───────────────────────────────────────────────────────────────────────
CLERK_JWT_TOKEN = os.environ.get("CLERK_JWT_TOKEN", "")
CLERK_WEBHOOK_SECRET = os.environ.get("CLERK_WEBHOOK_SECRET", "")

TIMEOUT = 30


def _auth_header() -> dict:
    """Returns Authorization header using Bearer scheme (required by Convex HTTP API)."""
    token = os.environ.get("CLERK_JWT_TOKEN", CLERK_JWT_TOKEN)
    if not token:
        return {}
    return {"Authorization": f"Bearer {token}"}


def _check_response(response: requests.Response, kind: str, path: str) -> object:
    """Parse a Convex HTTP API response, raising on any error."""
    data = response.json()

    # HTTP-level errors (401, 400, etc.)
    if response.status_code != 200:
        code = data.get("code", response.status_code)
        msg = data.get("message", response.text)
        if code in ("MalformedAccessToken", "AuthenticationFailed", "Unauthenticated"):
            raise Exception(
                f"Convex auth error for {kind} '{path}': {msg}\n"
                "Token is expired or invalid. Refresh it:\n"
                "  Auto:   node testsprite_tests/get_token.js  (needs pnpm dev)\n"
                "  Manual: .\\testsprite_tests\\refresh_token.ps1"
            )
        raise Exception(f"Convex HTTP {response.status_code} for {kind} '{path}': {msg}")

    # Function-level errors (status=error, errorMessage, or status field)
    status = data.get("status")
    if status == "error" or "errorMessage" in data:
        err_msg = data.get("errorMessage", data.get("message", "unknown error"))
        raise Exception(
            f"Convex {kind} error in '{path}': {err_msg}"
        )

    return data.get("value")


def convex_query(path: str, args: dict = None) -> object:
    """
    Call a Convex query via the HTTP API.
    path  — e.g. "organizations:listMine"
    """
    response = requests.post(
        f"{CONVEX_URL}/api/query",
        headers={**_auth_header(), "Content-Type": "application/json"},
        json={"path": path, "format": "convex_encoded_json", "args": [args or {}]},
        timeout=TIMEOUT,
    )
    return _check_response(response, "query", path)


def convex_mutation(path: str, args: dict = None) -> object:
    """
    Call a Convex mutation via the HTTP API.
    path  — e.g. "organizations:create"
    """
    response = requests.post(
        f"{CONVEX_URL}/api/mutation",
        headers={**_auth_header(), "Content-Type": "application/json"},
        json={"path": path, "format": "convex_encoded_json", "args": [args or {}]},
        timeout=TIMEOUT,
    )
    return _check_response(response, "mutation", path)


def skip_if_no_auth() -> None:
    """Call at the top of any test that requires authentication."""
    token = os.environ.get("CLERK_JWT_TOKEN", CLERK_JWT_TOKEN)
    if not token:
        import sys
        print(
            "\n[SKIP] CLERK_JWT_TOKEN not set. "
            "Copy the __session cookie from DevTools into testsprite_tests/.env.test",
            file=sys.stderr,
        )
        raise SystemExit(0)
