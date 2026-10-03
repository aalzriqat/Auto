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
 * `existing.result`, naming ids of rows the reset had deleted. The mechanism is
 * a generation counter (rationale in `utils/orgResetGeneration.ts`); the
 * "frozen clock" test below is the case a timestamp would lose.
 *
 * Every economic effect here goes through the real `expenses.create` mutation,
 * which runs inside `runWithIdempotency`.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { expectAppError } from "../test-utils/expectAppError";
import { resetOrgToCompletion } from "../test-utils/orgResetFixtures";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import { expect, test, describe, vi, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { FINANCIAL_RESET_IN_PROGRESS_MESSAGE } from "./adminOrgs";
import { COMMAND_RECORDED_BEFORE_RESET_MESSAGE } from "./utils/idempotency";

// SCRUM-565: opens the destructive-reset gate for THIS file only (the gate itself is proven unmocked in
// orgFinancialReset.scrum565gate.test.ts).
vi.mock("./utils/resetProtocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/resetProtocol")>()),
  RESET_PROTOCOL_COMPLETE: true,
}));

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

const PERMISSIONS = [
  "create:expenses", "edit:expenses", "delete:expenses", "view:expenses", "view:users", "manage:finance",
];

const REPLAY_CODE = "COMMAND_RECORDED_BEFORE_RESET";
const IN_PROGRESS_CODE = "ORG_FINANCIAL_RESET_IN_PROGRESS";

type Harness = ReturnType<typeof convexTestWithComponents>;
type Setup = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const { orgId, userId, identity } = await seedOrgWithMember(t, {
    clerkId: "user_a",
    permissions: PERMISSIONS,
    orgName: "Reset Dealer",
  });
  await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "dev_admin", email: "admin@autoflow.dev" })
  );
  return { t, orgId, userId, asUser: identity, asAdmin: t.withIdentity({ subject: "dev_admin" }) };
}

function createExpense(s: Setup, idempotencyKey: string, amount = 5000) {
  return s.asUser.mutation(api.expenses.create, {
    orgId: s.orgId,
    idempotencyKey,
    title: "Office Rent",
    amount,
    date: 1_756_000_000_000,
    category: "OTHER" as const,
    status: "PAID" as const,
  });
}

/** A replay of `idempotencyKey` is refused with the coded, translated reason. */
function expectReplayRefused(s: Setup, idempotencyKey: string, amount?: number) {
  return expectAppError(createExpense(s, idempotencyKey, amount), REPLAY_CODE, COMMAND_RECORDED_BEFORE_RESET_MESSAGE);
}

function unsuspend(s: Setup) {
  return s.asAdmin.mutation(api.adminOrgs.unsuspendOrg, { orgId: s.orgId });
}

function expectUnsuspendRefused(s: Setup) {
  return expectAppError(unsuspend(s), IN_PROGRESS_CODE, FINANCIAL_RESET_IN_PROGRESS_MESSAGE);
}

async function suspend(t: Harness, orgId: Id<"organizations">) {
  await t.run((ctx) => ctx.db.patch(orgId, { suspended: true, suspendedAt: Date.now() }));
}

/** Suspend, run the reset to completion, reactivate: the whole operator sequence. */
async function resetAndReactivate(s: Setup) {
  await suspend(s.t, s.orgId);
  await resetOrgToCompletion(s.t, s.orgId);
  await unsuspend(s);
}

async function resetBatch(t: Harness, orgId: Id<"organizations">, batchSize?: number) {
  return await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
    orgId,
    dryRun: false,
    ...(batchSize === undefined ? {} : { batchSize }),
  });
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
    const s = await setup();
    const first = await createExpense(s, "K");
    const second = await createExpense(s, "K");
    expect(second).toEqual(first);
    expect((await footprint(s.t, s.orgId)).expenses).toBe(1);
  });

  test("a key recorded before a completed reset is refused on replay, with no writes", async () => {
    const s = await setup();
    await createExpense(s, "K");
    await resetAndReactivate(s);

    const before = await footprint(s.t, s.orgId);
    expect(before.expenses).toBe(0);
    expect(before.commands).toBe(1);

    await expectReplayRefused(s, "K");
    expect(await footprint(s.t, s.orgId)).toEqual(before);
  });

  test("F2: the refusal holds when the clock is frozen so createdAt equals the reset time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T10:00:00.000Z"));
    const s = await setup();

    await createExpense(s, "K");
    const commandRow = await s.t.run((ctx) =>
      ctx.db.query("commandIdempotency").withIndex("by_org_createdAt", (q) => q.eq("orgId", s.orgId)).first()
    );
    await resetAndReactivate(s);

    // Same instant for the command and the reset: a timestamp comparison cannot
    // tell them apart, which is exactly why a generation counter is used.
    expect(Date.now()).toBe(commandRow!.createdAt);
    await expectReplayRefused(s, "K");
  });

  test("a command recorded in the new generation replays normally until the next reset", async () => {
    const s = await setup();
    await createExpense(s, "K1");
    await resetAndReactivate(s);

    const first = await createExpense(s, "K2");
    expect(await createExpense(s, "K2")).toEqual(first);
    await expectReplayRefused(s, "K1");
  });

  test("a SECOND reset invalidates a key recorded after the first; both refused after it completes", async () => {
    const s = await setup();
    await createExpense(s, "K1");
    await resetAndReactivate(s);
    expect(await orgState(s.t, s.orgId)).toMatchObject({ generation: 1, completed: 1 });

    // Two rows so a batch of one leaves the second reset genuinely partial.
    const k2 = await createExpense(s, "K2");
    await createExpense(s, "K3", 7000);
    expect(await createExpense(s, "K2")).toEqual(k2);

    await suspend(s.t, s.orgId);
    const partial = await resetBatch(s.t, s.orgId, 1);
    expect(partial.remaining).toBeGreaterThan(0);
    expect(await orgState(s.t, s.orgId)).toMatchObject({ generation: 2, completed: 1 });
    await expectUnsuspendRefused(s);

    await resetOrgToCompletion(s.t, s.orgId, 1);
    expect(await orgState(s.t, s.orgId)).toMatchObject({ generation: 2, completed: 2 });
    await unsuspend(s);

    await expectReplayRefused(s, "K2");
    await expectReplayRefused(s, "K1");
  });

  test("findCommandUnit refuses a unit recorded before the reset", async () => {
    const s = await setup();
    const { orgId, t } = s;
    const { findCommandUnit, recordCommandUnit } = await import("./utils/idempotency");
    const unit = { orgId, operation: "scrum563.unit", idempotencyKey: "import:row-1", fingerprint: "fp" };

    await t.run((ctx) => recordCommandUnit(ctx, { ...unit, result: { vehicleId: "gone" } }));
    expect(await t.run((ctx) => findCommandUnit(ctx, unit))).toEqual({ result: { vehicleId: "gone" } });

    await resetAndReactivate(s);

    await expectAppError(
      t.run((ctx) => findCommandUnit(ctx, unit)),
      REPLAY_CODE,
      COMMAND_RECORDED_BEFORE_RESET_MESSAGE
    );

    // A unit recorded after the reset is stamped with the new generation.
    const fresh = { ...unit, idempotencyKey: "import:row-2" };
    await t.run((ctx) => recordCommandUnit(ctx, { ...fresh, result: { ok: true } }));
    expect(await t.run((ctx) => findCommandUnit(ctx, fresh))).toEqual({ result: { ok: true } });
  });
});

describe("SCRUM-563 R1 — generation lifecycle", () => {
  test("continuation batches do not bump the generation; it moves exactly once per reset", async () => {
    const s = await setup();
    for (const key of ["A", "B", "C"]) await createExpense(s, key);
    await suspend(s.t, s.orgId);

    const first = await resetBatch(s.t, s.orgId, 1);
    expect(first.remaining).toBeGreaterThan(0);
    expect(first.cashDrawerStatePresent).toBe(false);
    expect(await orgState(s.t, s.orgId)).toMatchObject({ generation: 1 });
    expect((await orgState(s.t, s.orgId)).completed ?? 0).toBe(0);

    const second = await resetBatch(s.t, s.orgId, 1);
    expect(second.remaining).toBeGreaterThan(0);
    expect(await orgState(s.t, s.orgId)).toMatchObject({ generation: 1 });
    expect((await orgState(s.t, s.orgId)).completed ?? 0).toBe(0);

    await resetOrgToCompletion(s.t, s.orgId, 1);
    expect(await orgState(s.t, s.orgId)).toMatchObject({ generation: 1, completed: 1 });
  });

  test("a dry run writes nothing, including during an in-progress reset", async () => {
    const s = await setup();
    await createExpense(s, "A");
    await createExpense(s, "B");
    await suspend(s.t, s.orgId);

    await s.t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId: s.orgId });
    expect(await orgState(s.t, s.orgId)).toEqual({ generation: undefined, completed: undefined, suspended: true });

    await resetBatch(s.t, s.orgId, 1);
    const mid = await orgState(s.t, s.orgId);
    await s.t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId: s.orgId, dryRun: true });
    expect(await orgState(s.t, s.orgId)).toEqual(mid);
  });

  test("a refused destructive run (org not suspended) does not bump the generation", async () => {
    const s = await setup();
    await expect(resetBatch(s.t, s.orgId)).rejects.toThrow();
    expect((await orgState(s.t, s.orgId)).generation).toBeUndefined();
  });
});

describe("SCRUM-563 F1 — cash drawer state refuses the reset (its own replay survives a reset)", () => {
  /** An OPEN session plus one movement recorded through the real public mutations. */
  async function seedCash(s: Setup, idempotencyKey = "CASH-K") {
    const sessionId = await s.asUser.mutation(api.cashDrawer.open, { orgId: s.orgId, openingFloatMinor: 10_000 });
    const record = () =>
      s.asUser.mutation(api.cashDrawer.recordMovement, {
        orgId: s.orgId,
        sessionId,
        type: "SALE" as const,
        amountMinor: 2_500,
        idempotencyKey,
      });
    return { sessionId, movementId: await record(), record };
  }

  async function cashRows(s: Setup) {
    return await s.t.run(async (ctx) => ({
      sessions: (await ctx.db.query("cashDrawerSessions").collect()).length,
      movements: (await ctx.db.query("cashMovements").collect()).length,
    }));
  }

  test("(a) a destructive reset throws and changes nothing", async () => {
    const s = await setup();
    await createExpense(s, "E1");
    await seedCash(s);
    await suspend(s.t, s.orgId);

    await expect(resetBatch(s.t, s.orgId)).rejects.toThrow(/cash drawer/i);

    expect((await orgState(s.t, s.orgId)).generation).toBeUndefined();
    expect(await cashRows(s)).toEqual({ sessions: 1, movements: 1 });
    expect((await footprint(s.t, s.orgId)).expenses).toBe(1);
  });

  test("(b) a dry run reports cashDrawerStatePresent: true and writes nothing", async () => {
    const s = await setup();
    await seedCash(s);
    await suspend(s.t, s.orgId);

    const dry = await s.t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId: s.orgId, dryRun: true });
    expect(dry.cashDrawerStatePresent).toBe(true);
    expect(await orgState(s.t, s.orgId)).toEqual({ generation: undefined, completed: undefined, suspended: true });
    expect(await cashRows(s)).toEqual({ sessions: 1, movements: 1 });
  });

  test("(c) control: an org with no cash state resets to completion", async () => {
    const s = await setup();
    await createExpense(s, "E1");
    await suspend(s.t, s.orgId);
    const dry = await s.t.mutation(internal.orgFinancialReset.resetOrgFinancialData, { orgId: s.orgId, dryRun: true });
    expect(dry.cashDrawerStatePresent).toBe(false);
    const done = await resetOrgToCompletion(s.t, s.orgId);
    expect(done.cashDrawerStatePresent).toBe(false);
    expect(await orgState(s.t, s.orgId)).toMatchObject({ generation: 1, completed: 1 });
  });

  test("(d) a cash key recorded before the reset replays in its generation, and the reset that would orphan it refuses", async () => {
    const s = await setup();
    const { movementId, record } = await seedCash(s, "K");
    expect(await record()).toEqual(movementId);
    expect((await cashRows(s)).movements).toBe(1);

    await suspend(s.t, s.orgId);
    await expect(resetBatch(s.t, s.orgId)).rejects.toThrow(/cash drawer/i);

    // No reset ever completed, so K can never be replayed across one.
    expect((await orgState(s.t, s.orgId)).generation).toBeUndefined();
    await unsuspend(s);
    expect(await record()).toEqual(movementId);
  });
});

describe("SCRUM-563 R3 — reactivation guard", () => {
  test("unsuspendOrg refuses while a partial reset is in progress, and succeeds after completion", async () => {
    const s = await setup();
    for (const key of ["A", "B", "C"]) await createExpense(s, key);
    await suspend(s.t, s.orgId);
    const partial = await resetBatch(s.t, s.orgId, 1);
    expect(partial.remaining).toBeGreaterThan(0);

    await expectUnsuspendRefused(s);
    expect((await orgState(s.t, s.orgId)).suspended).toBe(true);

    await resetOrgToCompletion(s.t, s.orgId, 1);
    await unsuspend(s);
    expect((await orgState(s.t, s.orgId)).suspended).toBe(false);
  });

  test("rejectDeletionRequest's reactivation refuses mid-reset too, leaving the request pending", async () => {
    const s = await setup();
    for (const key of ["A", "B", "C"]) await createExpense(s, key);
    const requestId = await s.t.run((ctx) =>
      ctx.db.insert("organizationDeletionRequests", {
        orgId: s.orgId,
        orgName: "Reset Dealer",
        requestedBy: s.userId,
        requestedAt: Date.now(),
        status: "PENDING_REVIEW",
      })
    );
    const reject = () => s.asAdmin.mutation(api.adminOrgs.rejectDeletionRequest, { requestId });
    await suspend(s.t, s.orgId);
    const partial = await resetBatch(s.t, s.orgId, 1);
    expect(partial.remaining).toBeGreaterThan(0);

    await expectAppError(reject(), IN_PROGRESS_CODE, FINANCIAL_RESET_IN_PROGRESS_MESSAGE);
    // The refusal is uncaught, so the request transition rolled back with it.
    expect((await s.t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("PENDING_REVIEW");
    expect((await orgState(s.t, s.orgId)).suspended).toBe(true);

    await resetOrgToCompletion(s.t, s.orgId, 1);
    await reject();
    expect((await orgState(s.t, s.orgId)).suspended).toBe(false);
  });
});
