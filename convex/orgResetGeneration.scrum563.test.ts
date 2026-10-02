/**
 * SCRUM-563 — a command identity recorded before an org financial reset must
 * not replay after it, and the org must not be reactivated mid-reset.
 *
 * INVARIANT: after an org financial reset begins, no command identity recorded
 * before that reset may replay its stored result, and the org may not be
 * reactivated until the reset has completed.
 *
 * Why it matters: `commandIdempotency` is NOT in RESET_TABLES, so command rows
 * survive the reset. A replay of a pre-reset key used to hand back
 * `existing.result`, naming ids of rows the reset had deleted.
 *
 * The mechanism is a generation counter on the organization, not a timestamp:
 * a timestamp compare is defeated by an equal clock (the "frozen clock" test).
 *
 * Every economic effect here goes through the real `expenses.create` mutation,
 * which runs inside `runWithIdempotency`.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;

beforeEach(() => {
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
});

afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
  vi.useRealTimers();
});

const PERMISSIONS = ["create:expenses", "edit:expenses", "delete:expenses", "view:expenses", "view:users"];

const REPLAY_CODE = "COMMAND_RECORDED_BEFORE_RESET";
const IN_PROGRESS_CODE = "ORG_FINANCIAL_RESET_IN_PROGRESS";

type Harness = ReturnType<typeof convexTestWithComponents>;

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Reset Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_a", email: "a@test.com", name: "A" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ADMIN", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "dev_admin", email: "admin@autoflow.dev" })
  );
  return {
    t,
    orgId,
    userId,
    asUser: t.withIdentity({ subject: "user_a" }),
    asAdmin: t.withIdentity({ subject: "dev_admin" }),
  };
}

function expensePayload(orgId: Id<"organizations">, idempotencyKey: string, amount = 5000) {
  return {
    orgId,
    idempotencyKey,
    title: "Office Rent",
    amount,
    date: 1_756_000_000_000,
    category: "OTHER" as const,
    status: "PAID" as const,
  };
}

/** What a caller sees: the structured code, or RESOLVED, or the raw message. */
async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "RESOLVED";
  } catch (error) {
    const data = (error as { data?: { code?: string } }).data;
    return data?.code ?? `UNCODED: ${(error as Error).message}`;
  }
}

async function suspend(t: Harness, orgId: Id<"organizations">) {
  await t.run((ctx) => ctx.db.patch(orgId, { suspended: true, suspendedAt: Date.now() }));
}

async function resetBatch(t: Harness, orgId: Id<"organizations">, batchSize?: number) {
  return await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
    orgId,
    dryRun: false,
    ...(batchSize === undefined ? {} : { batchSize }),
  });
}

/** Runs destructive batches until the reset reports nothing remaining. */
async function resetToCompletion(t: Harness, orgId: Id<"organizations">, batchSize?: number) {
  for (let i = 0; i < 40; i += 1) {
    const result = await resetBatch(t, orgId, batchSize);
    if (result.remaining === 0) return result;
  }
  throw new Error("reset never completed");
}

async function orgState(t: Harness, orgId: Id<"organizations">) {
  const org = await t.run((ctx) => ctx.db.get(orgId));
  return {
    generation: org?.financialResetGeneration,
    completed: org?.financialResetCompletedGeneration,
    suspended: org?.suspended,
  };
}

async function footprint(t: Harness, orgId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const mine = (rows: { orgId?: unknown }[]) =>
      rows.filter((r) => String(r.orgId) === String(orgId)).length;
    return {
      expenses: mine(await ctx.db.query("expenses").collect()),
      transactions: mine(await ctx.db.query("transactions").collect()),
      commands: mine(await ctx.db.query("commandIdempotency").collect()),
    };
  });
}

describe("SCRUM-563 R2 — replay guard", () => {
  test("CONTROL: before any reset, replaying a key returns the stored result", async () => {
    const { t, orgId, asUser } = await setup();
    const first = await asUser.mutation(api.expenses.create, expensePayload(orgId, "K"));
    const second = await asUser.mutation(api.expenses.create, expensePayload(orgId, "K"));
    expect(second).toEqual(first);
    expect((await footprint(t, orgId)).expenses).toBe(1);
  });

  test("a key recorded before a completed reset is refused on replay, with no writes", async () => {
    const { t, orgId, asUser, asAdmin } = await setup();
    await asUser.mutation(api.expenses.create, expensePayload(orgId, "K"));

    await suspend(t, orgId);
    await resetToCompletion(t, orgId);
    await asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId });

    const before = await footprint(t, orgId);
    expect(before.expenses).toBe(0);
    expect(before.commands).toBe(1);

    expect(await outcome(asUser.mutation(api.expenses.create, expensePayload(orgId, "K")))).toBe(REPLAY_CODE);
    expect(await footprint(t, orgId)).toEqual(before);
  });

  test("F2: the refusal holds when the clock is frozen so createdAt equals the reset time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T10:00:00.000Z"));
    const { t, orgId, asUser, asAdmin } = await setup();

    await asUser.mutation(api.expenses.create, expensePayload(orgId, "K"));
    const commandRow = await t.run((ctx) =>
      ctx.db.query("commandIdempotency").withIndex("by_org_createdAt", (q) => q.eq("orgId", orgId)).first()
    );

    await suspend(t, orgId);
    await resetToCompletion(t, orgId);
    await asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId });

    // Same instant for the command and the reset: a timestamp comparison cannot
    // tell them apart, which is exactly why a generation counter is used.
    expect(Date.now()).toBe(commandRow!.createdAt);
    expect(await outcome(asUser.mutation(api.expenses.create, expensePayload(orgId, "K")))).toBe(REPLAY_CODE);
  });

  test("a command recorded in the new generation replays normally until the next reset", async () => {
    const { t, orgId, asUser, asAdmin } = await setup();
    await asUser.mutation(api.expenses.create, expensePayload(orgId, "K1"));
    await suspend(t, orgId);
    await resetToCompletion(t, orgId);
    await asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId });

    const first = await asUser.mutation(api.expenses.create, expensePayload(orgId, "K2"));
    const second = await asUser.mutation(api.expenses.create, expensePayload(orgId, "K2"));
    expect(second).toEqual(first);
    expect(await outcome(asUser.mutation(api.expenses.create, expensePayload(orgId, "K1")))).toBe(REPLAY_CODE);
  });

  test("a SECOND reset invalidates a key recorded after the first; both refused after it completes", async () => {
    const { t, orgId, asUser, asAdmin } = await setup();
    await asUser.mutation(api.expenses.create, expensePayload(orgId, "K1"));

    await suspend(t, orgId);
    await resetToCompletion(t, orgId);
    await asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId });
    expect(await orgState(t, orgId)).toMatchObject({ generation: 1, completed: 1 });

    // Two rows so a batch of one leaves the second reset genuinely partial.
    const k2 = await asUser.mutation(api.expenses.create, expensePayload(orgId, "K2"));
    await asUser.mutation(api.expenses.create, expensePayload(orgId, "K3", 7000));
    expect(await asUser.mutation(api.expenses.create, expensePayload(orgId, "K2"))).toEqual(k2);

    await suspend(t, orgId);
    const partial = await resetBatch(t, orgId, 1);
    expect(partial.remaining).toBeGreaterThan(0);
    expect(await orgState(t, orgId)).toMatchObject({ generation: 2, completed: 1 });
    expect(await outcome(asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId }))).toBe(IN_PROGRESS_CODE);

    await resetToCompletion(t, orgId, 1);
    expect(await orgState(t, orgId)).toMatchObject({ generation: 2, completed: 2 });
    await asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId });

    expect(await outcome(asUser.mutation(api.expenses.create, expensePayload(orgId, "K2")))).toBe(REPLAY_CODE);
    expect(await outcome(asUser.mutation(api.expenses.create, expensePayload(orgId, "K1")))).toBe(REPLAY_CODE);
  });

  test("findCommandUnit refuses a unit recorded before the reset", async () => {
    const { t, orgId, asAdmin } = await setup();
    const { findCommandUnit, recordCommandUnit } = await import("./utils/idempotency");
    const unit = { orgId, operation: "scrum563.unit", idempotencyKey: "import:row-1", fingerprint: "fp" };

    await t.run((ctx) => recordCommandUnit(ctx, { ...unit, result: { vehicleId: "gone" } }));
    expect(await t.run((ctx) => findCommandUnit(ctx, unit))).toEqual({ result: { vehicleId: "gone" } });

    await suspend(t, orgId);
    await resetToCompletion(t, orgId);
    await asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId });

    expect(await outcome(t.run((ctx) => findCommandUnit(ctx, unit)))).toBe(REPLAY_CODE);

    // A unit recorded after the reset is stamped with the new generation.
    const fresh = { ...unit, idempotencyKey: "import:row-2" };
    await t.run((ctx) => recordCommandUnit(ctx, { ...fresh, result: { ok: true } }));
    expect(await t.run((ctx) => findCommandUnit(ctx, fresh))).toEqual({ result: { ok: true } });
  });
});

describe("SCRUM-563 R1 — generation lifecycle", () => {
  test("continuation batches do not bump the generation; it moves exactly once per reset", async () => {
    const { t, orgId, asUser } = await setup();
    for (const key of ["A", "B", "C"]) {
      await asUser.mutation(api.expenses.create, expensePayload(orgId, key));
    }
    await suspend(t, orgId);

    const first = await resetBatch(t, orgId, 1);
    expect(first.remaining).toBeGreaterThan(0);
    expect(await orgState(t, orgId)).toMatchObject({ generation: 1 });
    expect((await orgState(t, orgId)).completed ?? 0).toBe(0);

    const second = await resetBatch(t, orgId, 1);
    expect(second.remaining).toBeGreaterThan(0);
    expect(await orgState(t, orgId)).toMatchObject({ generation: 1 });
    expect((await orgState(t, orgId)).completed ?? 0).toBe(0);

    await resetToCompletion(t, orgId, 1);
    expect(await orgState(t, orgId)).toMatchObject({ generation: 1, completed: 1 });
  });

  test("a dry run writes nothing, including during an in-progress reset", async () => {
    const { t, orgId, asUser } = await setup();
    await asUser.mutation(api.expenses.create, expensePayload(orgId, "A"));
    await asUser.mutation(api.expenses.create, expensePayload(orgId, "B"));
    await suspend(t, orgId);

    await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId });
    expect(await orgState(t, orgId)).toEqual({ generation: undefined, completed: undefined, suspended: true });

    await resetBatch(t, orgId, 1);
    const mid = await orgState(t, orgId);
    await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId, dryRun: true });
    expect(await orgState(t, orgId)).toEqual(mid);
  });

  test("a refused destructive run (org not suspended) does not bump the generation", async () => {
    const { t, orgId } = await setup();
    await expect(resetBatch(t, orgId)).rejects.toThrow();
    expect((await orgState(t, orgId)).generation).toBeUndefined();
  });
});

describe("SCRUM-563 R3 — reactivation guard", () => {
  test("unsuspendOrg refuses while a partial reset is in progress, and succeeds after completion", async () => {
    const { t, orgId, asUser, asAdmin } = await setup();
    for (const key of ["A", "B", "C"]) {
      await asUser.mutation(api.expenses.create, expensePayload(orgId, key));
    }
    await suspend(t, orgId);
    const partial = await resetBatch(t, orgId, 1);
    expect(partial.remaining).toBeGreaterThan(0);

    expect(await outcome(asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId }))).toBe(IN_PROGRESS_CODE);
    expect((await orgState(t, orgId)).suspended).toBe(true);

    await resetToCompletion(t, orgId, 1);
    expect(await outcome(asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId }))).toBe("RESOLVED");
    expect((await orgState(t, orgId)).suspended).toBe(false);
  });

  test("rejectDeletionRequest's reactivation refuses mid-reset too, leaving the request pending", async () => {
    const { t, orgId, userId, asUser, asAdmin } = await setup();
    for (const key of ["A", "B", "C"]) {
      await asUser.mutation(api.expenses.create, expensePayload(orgId, key));
    }
    const requestId = await t.run((ctx) =>
      ctx.db.insert("organizationDeletionRequests", {
        orgId,
        orgName: "Reset Dealer",
        requestedBy: userId,
        requestedAt: Date.now(),
        status: "PENDING_REVIEW",
      })
    );
    await suspend(t, orgId);
    const partial = await resetBatch(t, orgId, 1);
    expect(partial.remaining).toBeGreaterThan(0);

    expect(await outcome(asAdmin.mutation(api.adminOrgs.rejectDeletionRequest, { requestId }))).toBe(IN_PROGRESS_CODE);
    // The refusal is uncaught, so the request transition rolled back with it.
    expect((await t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("PENDING_REVIEW");
    expect((await orgState(t, orgId)).suspended).toBe(true);

    await resetToCompletion(t, orgId, 1);
    expect(await outcome(asAdmin.mutation(api.adminOrgs.rejectDeletionRequest, { requestId }))).toBe("RESOLVED");
    expect((await orgState(t, orgId)).suspended).toBe(false);
  });
});
