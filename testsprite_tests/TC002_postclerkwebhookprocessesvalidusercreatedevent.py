"""
TC002 — POST /clerk-webhook processes a valid user.created event.

The webhook lives at the Convex SITE url (not the cloud url), because it is
an HTTP action. The Svix signature must be generated with the real
CLERK_WEBHOOK_SECRET that is stored in your Convex environment.

To obtain the secret:
  npx convex env get CLERK_WEBHOOK_SECRET
  (or: Clerk dashboard → Webhooks → your endpoint → Signing Secret)

Set it as: CLERK_WEBHOOK_SECRET=whsec_<value>
"""

import sys, os, time, hmac, hashlib, base64, json
sys.path.insert(0, os.path.dirname(__file__))

import requests
from convex_helpers import CONVEX_SITE_URL, CLERK_WEBHOOK_SECRET, TIMEOUT

WEBHOOK_URL = f"{CONVEX_SITE_URL}/clerk-webhook"


def _sign(secret_b64: str, msg_id: str, payload_bytes: bytes, timestamp: int) -> str:
    """
    Generate a Svix-compatible HMAC-SHA256 signature.

    Svix spec:
      key     = base64_decode(whsec_ secret, stripped of 'whsec_' prefix)
      message = "{msg_id}.{timestamp}.{payload}"
      sig     = base64_encode(HMAC_SHA256(key, message))
      header  = "v1,{sig}"
    """
    key = base64.b64decode(secret_b64)
    msg = f"{msg_id}.{timestamp}.{payload_bytes.decode()}".encode()
    sig = hmac.new(key, msg, hashlib.sha256).digest()
    return base64.b64encode(sig).decode()


def test_valid_user_created_webhook():
    if not CLERK_WEBHOOK_SECRET:
        print(
            "\n[SKIP] CLERK_WEBHOOK_SECRET not set. "
            "Run: npx convex env get CLERK_WEBHOOK_SECRET",
            file=sys.stderr,
        )
        return

    event_payload = {
        "id": f"evt_{int(time.time())}",
        "type": "user.created",
        "data": {
            "id": f"user_test_{int(time.time())}",
            "email_addresses": [
                {"email_address": "webhooktest@example.com", "verification": {"status": "verified"}}
            ],
            "first_name": "Webhook",
            "last_name": "Test",
            "image_url": "",
            "primary_email_address_id": None,
            "public_metadata": {},
            "private_metadata": {},
            "created_at": "2026-06-13T12:00:00Z",
            "updated_at": "2026-06-13T12:00:00Z",
        },
    }
    payload_bytes = json.dumps(event_payload, separators=(",", ":")).encode()
    timestamp = int(time.time())
    msg_id = f"svix-msg-{timestamp}"

    secret_b64 = CLERK_WEBHOOK_SECRET.removeprefix("whsec_")
    signature = _sign(secret_b64, msg_id, payload_bytes, timestamp)

    response = requests.post(
        WEBHOOK_URL,
        headers={
            "Content-Type": "application/json",
            "svix-id": msg_id,
            "svix-timestamp": str(timestamp),
            "svix-signature": f"v1,{signature}",
        },
        data=payload_bytes,
        timeout=TIMEOUT,
    )

    assert response.status_code == 200, (
        f"Expected 200 from webhook, got {response.status_code}: {response.text}"
    )


test_valid_user_created_webhook()
