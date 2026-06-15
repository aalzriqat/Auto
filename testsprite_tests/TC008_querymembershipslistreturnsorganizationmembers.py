"""
TC008 — memberships:list returns the members of an organization.

The token holder is expected to already be an OWNER of at least one org (which
is auto-created when they sign up).  The test creates a fresh org so results
are deterministic.

Requires: CLERK_JWT_TOKEN env var.
"""

import sys, os, uuid
sys.path.insert(0, os.path.dirname(__file__))

from convex_helpers import convex_query, convex_mutation, skip_if_no_auth


PAGINATION_OPTS = {"numItems": 50, "cursor": None}


def test_memberships_list_returns_members():
    skip_if_no_auth()

    # 1. Create a fresh org
    org_name = f"MemberListTest-{uuid.uuid4()}"
    org_id = convex_mutation("organizations:create", {"name": org_name})
    assert isinstance(org_id, str) and org_id, "Failed to create test organization"

    # 2. List members — the creator should be in there as OWNER
    result = convex_query(
        "memberships:list",
        {"orgId": org_id, "paginationOpts": PAGINATION_OPTS},
    )

    # memberships:list returns a paginated result: { page: [...], isDone, continueCursor }
    assert isinstance(result, dict), (
        f"memberships:list should return a paginated object, got {type(result)}"
    )
    page = result.get("page", [])
    assert isinstance(page, list), f"'page' should be a list, got {type(page)}"
    assert len(page) >= 1, "There should be at least one member (the creator)"

    # 3. Verify each member entry has the expected fields
    for member in page:
        assert "userId" in member or "user" in member, (
            f"Member entry missing userId/user: {member}"
        )
        assert "roleId" in member or "role" in member, (
            f"Member entry missing roleId/role: {member}"
        )


test_memberships_list_returns_members()
