/**
 * SCRUM-888 (PR #747, Seat 2 HIGH finding at 100e9d84) — the supplier registry must survive an
 * organization returning to service.
 *
 * The release backfill and `registryCoverageForRelease` both skip an organization that is being
 * deleted (`deletionRequestId` / `deletionRequestedAt` set). If that organization is later
 * returned to service, it is live with no registry row, every supplier write refuses with
 * REGISTRY_NOT_INITIALISED, and a coverage check taken afterwards reports it MISSING. The release
 * has already declared the registry step complete by then, so the gap would be silent.
 *
 * The rule enforced here is at the source: `reactivateOrganization` in `adminOrgs.ts` is the only
 * function that returns an organization to service, and it ensures the registry row in the same
 * mutation (one Convex transaction, https://docs.convex.dev/database/advanced/occ).
 *
 * Harness-green only: convex-test serializes mutations, so it does not exercise OCC conflicts.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;

beforeEach(() => {
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
});

afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
});

type Harness = ReturnType<typeof convexTestWithComponents>;
const setup = (): Harness => convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));

/** A pre-registry organization: it exists, has an owner and a platform admin, and has NO registry row. */
async function seedOrgWithoutRegistry(t: Harness) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Acme Motors", createdAt: Date.now() }));
  const ownerId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "owner_1", email: "owner@acme.com" }));
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [], isSystemOwnerRole: true }),
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ownerId, roleId }));
  await t.run((ctx) => ctx.db.insert("users", { clerkId: "dev_admin", email: "admin@autoflow.dev" }));
  return { orgId, ownerId };
}

const registryRows = (t: Harness, orgId: Id<"organizations">) =>
  t.run((ctx) =>
    ctx.db
      .query("supplierRegistryState")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .take(5),
  );

type CoveragePage = { checked: number; deleting: number; missing: Id<"organizations">[]; isDone: boolean; continueCursor: string | null };

/** The exact internal query the release walks, over the whole (small) test deployment. */
async function releaseCoverage(t: Harness) {
  const page: CoveragePage = await t.query(internal.suppliers.registryCoverageForRelease, {
    paginationOpts: { numItems: 50, cursor: null },
  });
  expect(page.isDone).toBe(true);
  return page;
}

async function runReleaseBackfill(t: Harness) {
  await t.mutation(internal.suppliers.backfillRegistry, { batchSize: 100, continueAutomatically: false });
}

describe("SCRUM-888 registry survives an organization returning to service", () => {
  test("deletion request skipped by the release, then REJECTED: the org is live and the registry row exists", async () => {
    const t = setup();
    const { orgId } = await seedOrgWithoutRegistry(t);
    const asOwner = t.withIdentity({ subject: "owner_1" });
    const asAdmin = t.withIdentity({ subject: "dev_admin" });

    const { requestId } = await asOwner.mutation(api.organizations.remove, { orgId, reason: "closing" });

    // Release runs while the request is pending: the org is skipped, never reported missing.
    await runReleaseBackfill(t);
    expect(await registryRows(t, orgId)).toHaveLength(0);
    expect(await releaseCoverage(t)).toMatchObject({ checked: 0, deleting: 1, missing: [] });

    await asAdmin.mutation(api.adminOrgs.rejectDeletionRequest, { requestId });

    const org = await t.run((ctx) => ctx.db.get(orgId));
    expect(org?.suspended).toBe(false);
    expect(org?.deletionRequestedAt).toBeUndefined();
    expect(org?.deletionRequestId).toBeUndefined();
    // The invariant: live implies a registry row, created in the same mutation as the reactivation.
    expect(await registryRows(t, orgId)).toHaveLength(1);
    expect(await releaseCoverage(t)).toMatchObject({ checked: 1, deleting: 0, missing: [] });
  });

  test("the row created on reactivation is a fresh lock document at version 0", async () => {
    const t = setup();
    const { orgId } = await seedOrgWithoutRegistry(t);
    const asOwner = t.withIdentity({ subject: "owner_1" });
    const asAdmin = t.withIdentity({ subject: "dev_admin" });
    const { requestId } = await asOwner.mutation(api.organizations.remove, { orgId });
    await asAdmin.mutation(api.adminOrgs.rejectDeletionRequest, { requestId });

    const rows = await registryRows(t, orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId, version: 0 });
  });

  test("rejecting a request for an org that already has its registry row does not create a second one or move the version", async () => {
    const t = setup();
    const { orgId } = await seedOrgWithoutRegistry(t);
    await runReleaseBackfill(t); // live at this point: gets its row
    await t.run(async (ctx) => {
      const [row] = await ctx.db
        .query("supplierRegistryState")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .take(1);
      await ctx.db.patch(row._id, { version: 7 });
    });
    const asOwner = t.withIdentity({ subject: "owner_1" });
    const asAdmin = t.withIdentity({ subject: "dev_admin" });
    const { requestId } = await asOwner.mutation(api.organizations.remove, { orgId });
    await asAdmin.mutation(api.adminOrgs.rejectDeletionRequest, { requestId });

    const rows = await registryRows(t, orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe(7);
  });

  test("lifting an ordinary suspension also ensures the registry row (the second path back to service)", async () => {
    const t = setup();
    const { orgId } = await seedOrgWithoutRegistry(t);
    const asAdmin = t.withIdentity({ subject: "dev_admin" });
    await t.run((ctx) => ctx.db.patch(orgId, { suspended: true, suspendedAt: 1, suspendedReason: "billing" }));
    expect(await registryRows(t, orgId)).toHaveLength(0);

    await asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId });

    expect((await t.run((ctx) => ctx.db.get(orgId)))?.suspended).toBe(false);
    expect(await registryRows(t, orgId)).toHaveLength(1);
    expect(await releaseCoverage(t)).toMatchObject({ checked: 1, missing: [] });
  });

  test("a refused reactivation (purge already begun) leaves the org suspended with no registry row created", async () => {
    const t = setup();
    const { orgId } = await seedOrgWithoutRegistry(t);
    const asOwner = t.withIdentity({ subject: "owner_1" });
    const asAdmin = t.withIdentity({ subject: "dev_admin" });
    const { requestId } = await asOwner.mutation(api.organizations.remove, { orgId });
    // The purge stamped its irreversible marker: reactivation must refuse, and must not leave a registry row behind.
    await t.run((ctx) => ctx.db.patch(orgId, { destructivePurgeStartedAt: Date.now() }));

    await expect(asAdmin.mutation(api.adminOrgs.rejectDeletionRequest, { requestId })).rejects.toThrow();

    expect((await t.run((ctx) => ctx.db.get(orgId)))?.suspended).toBe(true);
    expect(await registryRows(t, orgId)).toHaveLength(0);
    expect(await releaseCoverage(t)).toMatchObject({ checked: 0, deleting: 1, missing: [] });
  });
});
