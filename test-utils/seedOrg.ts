import type { convexTestWithComponents } from "./convexTest";

/**
 * An organization with an active subscription and one member holding
 * `permissions`.
 *
 * Every Convex suite that exercises a tenant-scoped query needs this same
 * five-row preamble — org, subscription, user, role, membership — and it was
 * being copied per file. Sonar's new-code duplication gate is what surfaced it,
 * but the reason to fix it is that a change to the shape (a required
 * subscription field, say) otherwise has to be made in each copy, and the copy
 * someone misses fails in a way that looks like a bug in the feature.
 *
 * Lives outside `convex/` deliberately: anything under that directory is
 * bundled and deployed, and test scaffolding has no business shipping.
 */
export async function seedOrgWithMember(
  t: ReturnType<typeof convexTestWithComponents>,
  options: {
    clerkId: string;
    permissions: string[];
    orgName?: string;
    roleName?: string;
    memberName?: string;
  }
) {
  const { clerkId, permissions } = options;
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: options.orgName ?? "Test Org", createdAt: Date.now() })
  );
  await t.run(async (ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      clerkId,
      email: `${clerkId}@test.com`,
      name: options.memberName ?? "Member",
    })
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", { orgId, name: options.roleName ?? "SEEDED", permissions })
  );
  await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));

  const identity = t.withIdentity({ subject: clerkId });
  return { orgId, userId, identity };
}

/** The permission sets these suites seed. */
export const VIEWER_PERMISSIONS = ["view:leads", "edit:leads"];
export const MANAGER_PERMISSIONS = [
  "view:leads",
  "view:customers",
  "merge:customers",
  "approve:requests",
];
