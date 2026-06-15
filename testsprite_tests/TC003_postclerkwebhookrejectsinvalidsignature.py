"""
TC003 — POST /clerk-webhook rejects requests with missing or invalid Svix headers.
Should return HTTP 400.
"""

import sys, os, json
sys.path.insert(0, os.path.dirname(__file__))

import requests
from convex_helpers import CONVEX_SITE_URL, TIMEOUT

WEBHOOK_URL = f"{CONVEX_SITE_URL}/clerk-webhook"

EVENT_PAYLOAD = json.dumps({
    "id": "evt_invalid_test",
    "type": "user.created",
    "data": {"id": "user_test_id", "email": "test@example.com"},
}).encode()


def test_missing_svix_headers_returns_400():
    """No svix-id / svix-timestamp / svix-signature → 400."""
    response = requests.post(
        WEBHOOK_URL,
        headers={"Content-Type": "application/json"},
        data=EVENT_PAYLOAD,
        timeout=TIMEOUT,
    )
    assert response.status_code == 400, (
        f"Expected 400 for missing Svix headers, got {response.status_code}: {response.text}"
    )
    assert "missing" in response.text.lower() or "invalid" in response.text.lower(), (
        f"Response body should mention missing/invalid: {response.text}"
    )


def test_invalid_signature_returns_400():
    """Present but wrong signature → 400."""
    response = requests.post(
        WEBHOOK_URL,
        headers={
            "Content-Type": "application/json",
            "svix-id": "fake-svix-id",
            "svix-timestamp": "1234567890",
            "svix-signature": "v1,totallywrongsignature",
        },
        data=EVENT_PAYLOAD,
        timeout=TIMEOUT,
    )
    assert response.status_code == 400, (
        f"Expected 400 for invalid signature, got {response.status_code}: {response.text}"
    )
    assert "invalid" in response.text.lower() or "signature" in response.text.lower(), (
        f"Response body should mention invalid signature: {response.text}"
    )


test_missing_svix_headers_returns_400()
test_invalid_signature_returns_400()
