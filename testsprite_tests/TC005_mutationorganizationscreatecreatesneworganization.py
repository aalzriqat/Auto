"""
TC005 — organizations:create creates a new organization, which then appears in
        organizations:listMine.

Requires: CLERK_JWT_TOKEN env var (see convex_helpers.py for instructions).
"""

import sys, os, uuid
sys.path.insert(0, os.path.dirname(__file__))

from convex_helpers import convex_query, convex_mutation, skip_if_no_auth


def test_create_organization_appears_in_list():
    skip_if_no_auth()

    org_name = f"TestOrg-{uuid.uuid4()}"

    # 1. Create the organization
    org_id = convex_mutation("organizations:create", {"name": org_name})
    assert org_id is not None, "organizations:create returned None"
    assert isinstance(org_id, str) and len(org_id) > 0, (
        f"Expected a non-empty string org ID, got: {org_id!r}"
    )

    # 2. Verify it appears in listMine
    orgs = convex_query("organizations:listMine")
    assert isinstance(orgs, list), f"organizations:listMine should return a list, got {type(orgs)}"
    found = next((o for o in orgs if o.get("_id") == org_id), None)
    assert found is not None, (
        f"Newly created org '{org_name}' (id={org_id}) not found in organizations:listMine"
    )
    assert found.get("name") == org_name, (
        f"Org name mismatch: expected '{org_name}', got '{found.get('name')}'"
    )


test_create_organization_appears_in_list()
