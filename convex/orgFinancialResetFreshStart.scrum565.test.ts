/**
 * SCRUM-565 D-19 — no organization can NEWLY enter "reset in progress".
 *
 * INVARIANT: once this release is live and older invocations have finished, a
 * destructive `resetOrgFinancialData` can only CONTINUE a reset that is already
 * in progress. A fresh start (clean org, or an organizations row that does not
 * exist) is refused before any write. Dry runs are unchanged.
 *
 * The in-progress state is seeded directly (generation N+1, completed N) because
 * that is the only way into the destructive path that remains.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { beginInProgressReset } from "../test-utils/orgResetFixtures";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import { expect, test, describe, vi, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { RESET_PREFLIGHT_PROTOCOL } from "./orgResetPreflight";

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
});

const PERMISSIONS = [
  "create:expenses", "edit:expenses", "delete:expenses", "view:expenses", "view:users", "manage:finance",
];

type Harness = ReturnType<typeof convexTestWithComponents>;
type Setup = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const { orgId, identity } = await seedOrgWithMember(t, {
    clerkId: "user_a",
    permissions: PERMISSIONS,
    orgName: "Barrier Dealer",
  });
  return { t, orgId, asUser: identity };
}

function createExpense(s: Setup, idempotencyKey: string) {
  return s.asUser.mutation(api.expenses.create, {
    orgId: s.orgId,
    idempotencyKey,
    title: "Office Rent",
    amount: 5000,
    date: 1_756_000_000_000,
    category: "OTHER" as const,
    status: "PAID" as const,
  });
}

async function suspend(t: Harness, orgId: Id<"organizations">) {
  await t.run((ctx) => ctx.db.patch(orgId, { suspended: true, suspendedAt: Date.now() }));
}

async function orgState(t: Harness, orgId: Id<"organizations">) {
  const org = await t.run((ctx) => ctx.db.get(orgId));
  return {
    exists: org !== null,
    generation: org?.financialResetGeneration,
    completed: org?.financialResetCompletedGeneration,
  };
}

async function expenseCount(t: Harness, orgId: Id<"organizations">) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("expenses").collect()).filter((r) => String(r.orgId) === String(orgId)).length
  );
}

const destructive = (t: Harness, orgId: Id<"organizations">, batchSize?: number) =>
  t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
    orgId,
    dryRun: false,
    ...(batchSize === undefined ? {} : { batchSize }),
  });

const FRESH_REFUSED = /Fresh financial resets are disabled/;

describe("SCRUM-565 D-19 — the no-new-start barrier", () => {
  test("(a) a clean suspended org: a fresh destructive call refuses, bumps nothing, deletes nothing", async () => {
    const s = await setup();
    await createExpense(s, "A-1");
    await suspend(s.t, s.orgId);

    await expect(destructive(s.t, s.orgId)).rejects.toThrow(FRESH_REFUSED);

    expect(await orgState(s.t, s.orgId)).toEqual({ exists: true, generation: undefined, completed: undefined });
    expect(await expenseCount(s.t, s.orgId)).toBe(1);
  });

  test("(a2) the barrier is the FIRST refusal: an unsuspended clean org gets it, not the suspension message", async () => {
    const s = await setup();
    await expect(destructive(s.t, s.orgId)).rejects.toThrow(FRESH_REFUSED);
    expect((await orgState(s.t, s.orgId)).generation).toBeUndefined();
  });

  test("(b) a missing organizations row: the destructive call refuses and the orphan row stays", async () => {
    const s = await setup();
    await createExpense(s, "B-1");
    await s.t.run((ctx) => ctx.db.delete(s.orgId));
    expect((await orgState(s.t, s.orgId)).exists).toBe(false);

    await expect(destructive(s.t, s.orgId)).rejects.toThrow(FRESH_REFUSED);

    expect(await expenseCount(s.t, s.orgId)).toBe(1);
  });

  test("(c) a continuation proceeds and finally stamps completion", async () => {
    const s = await setup();
    await createExpense(s, "C-1");
    await createExpense(s, "C-2");
    await suspend(s.t, s.orgId);
    await beginInProgressReset(s.t, s.orgId);
    expect(await orgState(s.t, s.orgId)).toEqual({ exists: true, generation: 1, completed: undefined });

    let remaining = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 60 && remaining > 0; i += 1) {
      remaining = (await destructive(s.t, s.orgId, 1)).remaining;
      // A continuation never bumps again.
      expect((await orgState(s.t, s.orgId)).generation).toBe(1);
    }

    expect(remaining).toBe(0);
    expect(await orgState(s.t, s.orgId)).toEqual({ exists: true, generation: 1, completed: 1 });
    expect(await expenseCount(s.t, s.orgId)).toBe(0);
  });

  test("(c2) once completed, the same org is clean again and a further destructive call is a refused fresh start", async () => {
    const s = await setup();
    await createExpense(s, "C2-1");
    await suspend(s.t, s.orgId);
    await beginInProgressReset(s.t, s.orgId);
    for (let i = 0; i < 60; i += 1) {
      if ((await destructive(s.t, s.orgId)).remaining === 0) break;
    }
    expect(await orgState(s.t, s.orgId)).toEqual({ exists: true, generation: 1, completed: 1 });

    await expect(destructive(s.t, s.orgId)).rejects.toThrow(FRESH_REFUSED);
    expect(await orgState(s.t, s.orgId)).toEqual({ exists: true, generation: 1, completed: 1 });
  });

  test("(d) a dry run on a clean org still reports and writes nothing", async () => {
    const s = await setup();
    await createExpense(s, "D-1");
    await suspend(s.t, s.orgId);

    const report = await s.t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId: s.orgId });

    expect(report.dryRun).toBe(true);
    expect(report.total).toBeGreaterThan(0);
    expect(await orgState(s.t, s.orgId)).toEqual({ exists: true, generation: undefined, completed: undefined });
    expect(await expenseCount(s.t, s.orgId)).toBe(1);
  });

  test("(d2) a dry run for a missing org row still reports", async () => {
    const s = await setup();
    await s.t.run((ctx) => ctx.db.delete(s.orgId));
    const report = await s.t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId: s.orgId });
    expect(report.dryRun).toBe(true);
    expect(report.orgName).toBeNull();
  });

  test("(e) page A read, then a fresh reset on A is refused, then the walk finishes green and A is not mid-reset", async () => {
    const s = await setup();
    await createExpense(s, "E-1");
    await suspend(s.t, s.orgId);

    const query = internal.orgResetPreflight.countOrgsWithResetInProgress;
    const first = await s.t.query(query, { paginationOpts: { numItems: 1, cursor: null } });
    expect(first.protocol).toBe(RESET_PREFLIGHT_PROTOCOL);
    expect(first.freshStartsBlocked).toBe(true);
    expect(first.inProgress).toBe(0);

    // The race the barrier closes: A is attempted AFTER its page was counted.
    await expect(destructive(s.t, s.orgId)).rejects.toThrow(FRESH_REFUSED);

    let total = first.inProgress;
    let cursor = first.continueCursor;
    let isDone = first.isDone;
    for (let i = 0; i < 10 && !isDone; i += 1) {
      const next = await s.t.query(query, { paginationOpts: { numItems: 1, cursor } });
      total += next.inProgress;
      cursor = next.continueCursor;
      isDone = next.isDone;
    }
    expect(isDone).toBe(true);
    expect(total).toBe(0);
    expect((await orgState(s.t, s.orgId)).generation).toBeUndefined();
  });
});
