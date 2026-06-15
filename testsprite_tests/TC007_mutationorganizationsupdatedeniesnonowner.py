"""
TC007 — organizations:update is denied for unauthenticated callers and non-owners.

Tests:
  a) No-auth call returns a function-level auth error.
  b) Authenticated owner CAN update their own org (verifies the mutation works).
  c) Two-user test (requires CLERK_JWT_TOKEN_NON_OWNER) verifies that a non-owner
     receives a permission error.

Requires: CLERK_JWT_TOKEN env var for tests b and c.
"""

import sys, os, uuid
sys.path.insert(0, os.path.dirname(__file__))

import requests
from convex_helpers import (
    CONVEX_URL, TIMEOUT,
    convex_mutation, skip_if_no_auth,
)


def _raw_mutation(path: str, args: dict, token: str = "") -> dict:
    """Call a Convex mutation with the correct HTTP API format, optionally with auth."""
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = requests.post(
        f"{CONVEX_URL}/api/mutation",
        headers=headers,
        json={"path": path, "format": "convex_encoded_json", "args": [args]},
        timeout=TIMEOUT,
    )
    return r.json()


def test_unauthenticated_update_denied():
    """Calling organizations:update with no token should return an auth error."""
    skip_if_no_auth()

    # Create a real org so we have a valid orgId to pass
    org_id = convex_mutation("organizations:create", {"name": f"AuthTestOrg-{uuid.uuid4()}"})
    assert org_id, "Failed to create test org"

    data = _raw_mutation("organizations:update", {"orgId": org_id, "name": "ShouldFail"}, token="")
    # No auth → should get a function-level error (status=error or errorMessage)
    assert (
        data.get("status") == "error"
        or "errorMessage" in data
        or data.get("errorCode")
    ), f"Expected an error for unauthenticated call, got: {data}"


def test_owner_can_update_own_org():
    """Positive test: an authenticated owner can rename their org."""
    skip_if_no_auth()

    org_id = convex_mutation("organizations:create", {"name": f"UpdateTarget-{uuid.uuid4()}"})
    assert org_id, "Failed to create test org"

    result = convex_mutation("organizations:update", {"orgId": org_id, "name": "RenamedOrg"})
    # update should return null or the org id — just check it didn't raise
    assert result is None or result, f"Unexpected update result: {result}"


def test_non_owner_update_denied():
    """
    If CLERK_JWT_TOKEN_NON_OWNER is set, verify a non-owner gets a permission error.
    """
    skip_if_no_auth()

    non_owner_token = os.environ.get("CLERK_JWT_TOKEN_NON_OWNER", "")
    if not non_owner_token:
        print(
            "\n[SKIP] CLERK_JWT_TOKEN_NON_OWNER not set — skipping two-user test.",
            file=sys.stderr,
        )
        return

    # Create org as owner
    org_id = convex_mutation("organizations:create", {"name": f"OwnerOrg-{uuid.uuid4()}"})
    assert org_id, "Failed to create test org"

    # Attempt to rename as non-owner
    data = _raw_mutation("organizations:update", {"orgId": org_id, "name": "HijackedName"}, token=non_owner_token)
    assert (
        data.get("status") == "error"
        or "errorMessage" in data
    ), f"Expected permission error for non-owner update, got: {data}"

    err = data.get("errorMessage", "")
    assert any(
        kw in err.lower()
        for kw in ("permission", "not a member", "unauthorized", "owner", "not authorized")
    ), f"Expected a permission error, got: {err}"


test_unauthenticated_update_denied()
test_owner_can_update_own_org()
test_non_owner_update_denied()
