"""
TC006 — organizations:update renames an organization when called by the OWNER.

Requires: CLERK_JWT_TOKEN env var (must be an OWNER of at least one org).
"""

import sys, os, uuid
sys.path.insert(0, os.path.dirname(__file__))

from convex_helpers import convex_query, convex_mutation, skip_if_no_auth


def test_owner_can_update_org_name():
    skip_if_no_auth()

    original_name = f"UpdateTest-{uuid.uuid4()}"
    updated_name = f"UpdateTest-{uuid.uuid4()}-renamed"

    # 1. Create the org
    org_id = convex_mutation("organizations:create", {"name": original_name})
    assert isinstance(org_id, str) and org_id, "Failed to create test organization"

    # 2. Rename it
    convex_mutation("organizations:update", {"orgId": org_id, "name": updated_name})

    # 3. Verify the new name in listMine
    orgs = convex_query("organizations:listMine")
    updated = next((o for o in orgs if o.get("_id") == org_id), None)
    assert updated is not None, "Organization not found after update"
    assert updated.get("name") == updated_name, (
        f"Expected name '{updated_name}', got '{updated.get('name')}'"
    )


test_owner_can_update_org_name()
