/**
 * SCRUM-297 — FAILING-FIRST reproduction of the org destructive-lifecycle defect.
 *
 * PROVENANCE (working-directory drift has bitten prior sessions):
 *   worktree : E:/tmp/auto-scrum297
 *   branch   : agent/scrum-297-org-purge-lifecycle
 *   base SHA : 62b5a5b9c44ad878064f9f6cccf776a1c53a8c05  (protected main)
 *
 * INVARIANT UNDER TEST
 *   Once destructive organization deletion has removed any economic command
 *   authority, that organization must not become operational again unless the
 *   remaining financial state and command provenance are proven coherent.
 *
 * These tests are LIFECYCLE-level on purpose. Payroll is the manifestation that
 * SCRUM-291 reproduced; it is not the boundary. The boundary is
 * ORGANIZATION_DELETION_STEPS[0] deleting `commandIdempotency` — the sole
 * replay authority behind all 30 `runWithIdempotency` call sites — before the
 * economic provenance those commands write.
 *
 * ⚠️ SCOPE OF THAT COUNT, because a count without its scope is a rumour: 30 is
 * the number of CALL EXPRESSIONS of the helper in non-test `convex/` source,
 * across 12 modules (applications 5, collections 5, sales 5, financeDealCosts
 * 3, deposits/paymentIntents/payroll/sourcingPayables 2 each, expenses/
 * prepaidExpenses/supplierReceivables/transactions 1 each). SCRUM-57 counts a
 * DIFFERENT set — economic command sites — and lands on 29. The two numbers do
 * not contradict each other and must not be conflated. This comment said 29
 * while the assertion at the bottom of T3 said 30; 30 is the one that matches
 * this scope.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { runWithIdempotency } from "./utils/idempotency";
import { ORGANIZATION_DELETION_STEPS } from "./adminOrgs";

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

async function seedOrg(t: Harness) {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: "Acme Motors", createdAt: Date.now() })
  );
  const ownerId = await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId: "owner_1", email: "owner@acme.com" })
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [], isSystemOwnerRole: true })
  );
  await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId: ownerId, roleId }));
  await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId: "dev_admin", email: "admin@autoflow.dev" })
  );
  return { orgId, ownerId };
}

/**
 * Execute an economic command through the SHARED command log, exactly as all 29
 * production call sites do. The effect is written into `employeeAdvances`, a
 * table listed in KNOWN_UNCOVERED_PRE_EXISTING, so it survives the purge.
 */
async function executeEconomicCommand(
  t: Harness,
  orgId: Id<"organizations">,
  ownerId: Id<"users">,
  key: string
) {
  return await t.run(async (ctx) =>
    runWithIdempotency(
      ctx,
      { orgId, operation: "scrum297.genericEconomicCommand", idempotencyKey: key },
      async () => {
        const now = Date.now();
        const provenanceId = await ctx.db.insert("employeeAdvances", {
          orgId,
          userId: ownerId,
          amountMinor: 40000,
          recoveredMinor: 0,
          currency: "JOD",
          date: now,
          status: "OUTSTANDING",
          createdAt: now,
          updatedAt: now,
        });
        return { provenanceId };
      }
    )
  );
}

async function countRows(t: Harness, table: "commandIdempotency" | "employeeAdvances") {
  return await t.run(async (ctx) => (await ctx.db.query(table).collect()).length);
}

/** Drive the REAL purge engine until the first destructive step has drained. */
async function purgeUntilCommandAuthorityGone(
  t: Harness,
  requestId: Id<"organizationDeletionRequests">
) {
  for (let i = 0; i < 50; i += 1) {
    if ((await countRows(t, "commandIdempotency")) === 0) return;
    await t.mutation(internal.adminOrgs.runDeletionRequestBatch, { requestId });
  }
  throw new Error("command authority never drained");
}

/** Persist exactly what runDeletionRequestBatch's catch block persists on a thrown step. */
async function markRequestFailedAsTheCatchBlockDoes(
  t: Harness,
  requestId: Id<"organizationDeletionRequests">
) {
  await t.run(async (ctx) =>
    ctx.db.patch(requestId, {
      status: "FAILED",
      failedAt: Date.now(),
      error: "An unexpected error occurred while deleting the organization.",
      lastProcessedAt: Date.now(),
    })
  );
}

describe("SCRUM-297 — organization destructive lifecycle", () => {
  test("STRUCTURAL: commandIdempotency is destroyed FIRST, before every economic table", async () => {
    const commandStep = ORGANIZATION_DELETION_STEPS.findIndex(
      (step) => step.kind === "orgRows" && step.table === "commandIdempotency"
    );
    expect(commandStep).toBe(0);

    // Every economic authority the command log protects is destroyed LATER, so
    // an interruption between them is asymmetric by construction.
    for (const later of [
      "accountingEvents",
      "journalEntries",
      "canonicalPayments",
      "deposits",
      "sales",
    ]) {
      const index = ORGANIZATION_DELETION_STEPS.findIndex(
        (step) => step.kind === "orgRows" && step.table === later
      );
      expect(index).toBeGreaterThan(commandStep);
    }
  });

  test("T1 CONTROL: partial purge erases command authority while economic provenance survives", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, ownerId } = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: "dev_admin" });

    await executeEconomicCommand(t, orgId, ownerId, "K");
    expect(await countRows(t, "commandIdempotency")).toBe(1);
    expect(await countRows(t, "employeeAdvances")).toBe(1);

    const { requestId } = await asAdmin.mutation(api.adminOrgs.hardDeleteOrg, {
      orgId,
      confirmName: "Acme Motors",
    });
    await purgeUntilCommandAuthorityGone(t, requestId);

    // THE CONTROL: authority gone, provenance survives, org row still present.
    expect(await countRows(t, "commandIdempotency")).toBe(0);
    expect(await countRows(t, "employeeAdvances")).toBe(1);
    expect(await t.run(async (ctx) => await ctx.db.get(orgId))).not.toBeNull();
  });

  test("T2 REQUIRED INVARIANT: unsuspendOrg must REFUSE after destructive progress", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, ownerId } = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: "dev_admin" });

    await executeEconomicCommand(t, orgId, ownerId, "K");
    const { requestId } = await asAdmin.mutation(api.adminOrgs.hardDeleteOrg, {
      orgId,
      confirmName: "Acme Motors",
    });
    await purgeUntilCommandAuthorityGone(t, requestId);
    await markRequestFailedAsTheCatchBlockDoes(t, requestId);

    // FAILED is absent from ACTIVE_DELETION_STATUSES, so the only guard misses.
    await expect(asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId })).rejects.toThrow();

    const org = await t.run(async (ctx) => await ctx.db.get(orgId));
    expect(org?.suspended).toBe(true);
  });

  test("T3 GENERALITY: the economic surface stays unreachable after destructive progress", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, ownerId } = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: "dev_admin" });
    const asOwner = t.withIdentity({ subject: "owner_1" });

    await executeEconomicCommand(t, orgId, ownerId, "K");
    const { requestId } = await asAdmin.mutation(api.adminOrgs.hardDeleteOrg, {
      orgId,
      confirmName: "Acme Motors",
    });
    await purgeUntilCommandAuthorityGone(t, requestId);
    await markRequestFailedAsTheCatchBlockDoes(t, requestId);

    await expect(asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId })).rejects.toThrow();

    // Reactivation is the ONLY route to the economic surface: every ordinary
    // command goes through requireTenantAuth, which refuses a suspended org. So
    // refusing reactivation is what makes the retry unreachable for all 30
    // runWithIdempotency call sites at once, not just for payroll.
    const org = await t.run(async (ctx) => await ctx.db.get(orgId));
    expect(org?.suspended).toBe(true);
    await expect(asOwner.query(api.organizations.get, { orgId })).rejects.toThrow();
  });

  test("T4 RESUME: a failed purge can still be driven to completion", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, ownerId } = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: "dev_admin" });

    await executeEconomicCommand(t, orgId, ownerId, "K");
    const first = await asAdmin.mutation(api.adminOrgs.hardDeleteOrg, {
      orgId,
      confirmName: "Acme Motors",
    });
    await purgeUntilCommandAuthorityGone(t, first.requestId);
    await markRequestFailedAsTheCatchBlockDoes(t, first.requestId);

    // Failing closed must not strand the org: completion stays reachable.
    const resumed = await asAdmin.mutation(api.adminOrgs.hardDeleteOrg, {
      orgId,
      confirmName: "Acme Motors",
    });
    for (let i = 0; i < 400; i += 1) {
      const request = await t.run(async (ctx) => ctx.db.get(resumed.requestId));
      if (request?.status !== "RUNNING") break;
      await t.mutation(internal.adminOrgs.runDeletionRequestBatch, { requestId: resumed.requestId });
    }

    const request = await t.run(async (ctx) => ctx.db.get(resumed.requestId));
    expect(request?.status).toBe("COMPLETED");
    expect(await t.run(async (ctx) => await ctx.db.get(orgId))).toBeNull();
  });

  test("T6 LEGACY: a purge that failed BEFORE the marker existed is still refused", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, ownerId } = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: "dev_admin" });

    await executeEconomicCommand(t, orgId, ownerId, "K");
    const { requestId } = await asAdmin.mutation(api.adminOrgs.hardDeleteOrg, {
      orgId,
      confirmName: "Acme Motors",
    });

    // The shape a pre-SCRUM-297 purge left behind: the command log destroyed by
    // a batch that ran under code which stamped nothing, the request FAILED,
    // and NO marker on the organization. Reconstructed directly because no
    // current code path can produce it — that is precisely why a marker-only
    // guard cannot see these organizations.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("commandIdempotency").collect()) {
        await ctx.db.delete(row._id);
      }
      await ctx.db.patch(orgId, { destructivePurgeStartedAt: undefined });
    });
    await markRequestFailedAsTheCatchBlockDoes(t, requestId);

    const before = await t.run(async (ctx) => await ctx.db.get(orgId));
    expect(before?.destructivePurgeStartedAt).toBeUndefined();
    expect(await countRows(t, "commandIdempotency")).toBe(0);
    expect(await countRows(t, "employeeAdvances")).toBe(1);

    await expect(asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId })).rejects.toThrow();

    // Refusing reactivation must not also refuse the one legal way forward.
    await expect(
      asAdmin.mutation(api.adminOrgs.hardDeleteOrg, { orgId, confirmName: "Acme Motors" })
    ).resolves.toBeDefined();
  });

  test("T7 SIBLING WRITER: rejectDeletionRequest cannot reactivate a purged org either", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, ownerId } = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: "dev_admin" });
    const asOwner = t.withIdentity({ subject: "owner_1" });

    await executeEconomicCommand(t, orgId, ownerId, "K");
    const { requestId } = await asAdmin.mutation(api.adminOrgs.hardDeleteOrg, {
      orgId,
      confirmName: "Acme Motors",
    });
    await purgeUntilCommandAuthorityGone(t, requestId);
    await markRequestFailedAsTheCatchBlockDoes(t, requestId);

    // The organization as it stood after the pre-guard `unsuspendOrg` leaked it:
    // live, with the FAILED request still on file. `unsuspendOrg` refuses this
    // now, so the only way to reach the state is to reconstruct it — which is
    // precisely why guarding one writer was not enough.
    await t.run(async (ctx) => ctx.db.patch(orgId, { suspended: false, suspendedAt: undefined }));

    // The owner files a fresh deletion request; an admin rejects it. Rejection
    // used to clear `suspended` unconditionally AND erase `deletionRequestId`,
    // returning a purged organization to service without consulting either
    // condition — and destroying the pointer to the failed purge on the way.
    const filed = await asOwner.mutation(api.organizations.remove, { orgId });
    await expect(
      asAdmin.mutation(api.adminOrgs.rejectDeletionRequest, { requestId: filed.requestId })
    ).rejects.toThrow();

    const org = await t.run(async (ctx) => await ctx.db.get(orgId));
    expect(org?.deletionRequestId).toBeDefined();

    // Refusing must not strand the organization: completing the purge is still
    // reachable, which is the whole point of failing closed rather than dead.
    await expect(
      asAdmin.mutation(api.adminOrgs.approveDeletionRequest, { requestId: filed.requestId })
    ).resolves.toBeDefined();
  });

  test("T5 MARKER ORDERING: irreversibility is stamped even when the batch deletes nothing", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: "dev_admin" });

    // No command rows at all, so step 0 deletes nothing and records no counts.
    // The marker must still be set, because it is written ahead of the step
    // rather than derived from what the step reported.
    expect(await countRows(t, "commandIdempotency")).toBe(0);

    const { requestId } = await asAdmin.mutation(api.adminOrgs.hardDeleteOrg, {
      orgId,
      confirmName: "Acme Motors",
    });
    await t.mutation(internal.adminOrgs.runDeletionRequestBatch, { requestId });

    const org = await t.run(async (ctx) => await ctx.db.get(orgId));
    expect(org?.destructivePurgeStartedAt).toEqual(expect.any(Number));

    const request = await t.run(async (ctx) => ctx.db.get(requestId));
    expect(request?.deletedCounts ?? {}).toEqual({});
  });
});
