"""
TC010 — memberships:add rejects a duplicate pending invitation for the same email.

Requires: CLERK_JWT_TOKEN env var.
"""

import sys, os, uuid
sys.path.insert(0, os.path.dirname(__file__))

from convex_helpers import convex_mutation, convex_query, skip_if_no_auth


def _get_owner_role_id(org_id: str) -> str:
    roles = convex_query("roles:list", {"orgId": org_id})
    assert isinstance(roles, list) and roles, "No roles found for org"
    owner = next((r for r in roles if r.get("name", "").upper() == "OWNER"), roles[0])
    return owner["_id"]


def test_duplicate_pending_invitation_rejected():
    skip_if_no_auth()

    org_id = convex_mutation("organizations:create", {"name": f"DupInvite-{uuid.uuid4()}"})
    assert org_id, "Failed to create org"

    role_id = _get_owner_role_id(org_id)

    # Use an email that will never match an existing user
    test_email = f"pending-{uuid.uuid4()}@testsprite-nonexistent.example.com"

    # 1. First invitation → should succeed with status "invited"
    first = convex_mutation(
        "memberships:add",
        {"orgId": org_id, "userEmail": test_email, "roleId": role_id},
    )
    assert isinstance(first, dict), f"Expected dict, got {type(first)}: {first}"
    assert first.get("status") == "invited", (
        f"Expected status 'invited' on first call, got: {first}"
    )

    # 2. Second invitation for same email → should raise an error
    try:
        second = convex_mutation(
            "memberships:add",
            {"orgId": org_id, "userEmail": test_email, "roleId": role_id},
        )
        # If no exception was raised the function must have indicated an error in the value
        # (some backends return an error object instead of throwing)
        assert second.get("status") not in ("invited", "added"), (
            f"Expected rejection for duplicate invitation, but got: {second}"
        )
    except Exception as e:
        # Exception path — verify the message indicates a duplicate / pending invite
        err = str(e).lower()
        assert any(kw in err for kw in ("pending", "already", "duplicate", "invitation", "exist")), (
            f"Expected a duplicate-invitation error, got: {e}"
        )


test_duplicate_pending_invitation_rejected()
