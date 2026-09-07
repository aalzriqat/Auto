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
 * replay authority behind all 29 `runWithIdempotency` call sites — before the
 * economic provenance those commands write.
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

  test("T3 GENERALITY: after reactivation the SAME command key re-executes, duplicating the effect", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, ownerId } = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: "dev_admin" });

    const first = await executeEconomicCommand(t, orgId, ownerId, "K");
    const { requestId } = await asAdmin.mutation(api.adminOrgs.hardDeleteOrg, {
      orgId,
      confirmName: "Acme Motors",
    });
    await purgeUntilCommandAuthorityGone(t, requestId);
    await markRequestFailedAsTheCatchBlockDoes(t, requestId);

    try {
      await asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId });
    } catch {
      // Once T2 is fixed this throws and the org never returns to service.
    }

    const second = await executeEconomicCommand(t, orgId, ownerId, "K");

    // The identical economic intent must not produce a second effect.
    expect(second.provenanceId).toBe(first.provenanceId);
    expect(await countRows(t, "employeeAdvances")).toBe(1);
  });
});
