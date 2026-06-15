#!/usr/bin/env python3
"""
auto_token.py — NOTE: This script is DEPRECATED.

Investigation showed that Clerk's Backend API produces session tokens whose
signatures Convex's HTTP API rejects, even though they are cryptographically
valid RS256 tokens signed by the same JWKS key.

Only the __session cookie issued by Clerk's frontend JS SDK (running in a real
browser or Playwright) is accepted by Convex. Use get_token.js instead:

    node testsprite_tests/get_token.js
        -- requires 'pnpm dev' to be running

    .\\testsprite_tests\\refresh_token.ps1
        -- calls get_token.js automatically, falls back to manual paste

Background:
    Clerk's Backend API (/sessions/{id}/tokens) signs tokens with a different
    key path than the public JWKS, even though the kid matches. Convex's auth
    middleware rejects these tokens with MalformedAccessToken (HTTP 401) while
    accepting browser-issued __session cookies with identical claims.
"""

import sys

print(__doc__)
print("Run: node testsprite_tests/get_token.js")
sys.exit(1)
