/**
 * SCRUM-291 — `payroll.recoverAdvance` must have ONE authoritative replay
 * boundary.
 *
 * The defect: a lookup keyed on `(orgId, idempotencyKey)` alone ran BEFORE
 * `runWithIdempotency`. It is not keyed on the advance, the amount or the
 * method, so a retained identity carrying a materially different economic
 * intent resolved to an unrelated recovery row and was returned as success —
 * a second idempotency authority that fails OPEN, sitting in front of the one
 * that fails CLOSED. Because `run()` was never reached, the canonical
 * fingerprint comparison was unreachable on that path.
 *
 * These tests assert the invariant from the caller's perspective:
 *   every economic recoverAdvance intent must enter the command-log boundary
 *   before any path can return a successful economic result.
 *
 * They are failing-first against the pre-fix code. The load-bearing green
 * control is the full-repayment replay: the early return existed for a
 * legitimate reason, and the fix must preserve that behaviour rather than
 * delete it.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, beforeEach, expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PAYROLL_CLOCK = new Date("2026-07-15T12:00:00.000Z");
beforeEach(() => {
  vi.setSystemTime(PAYROLL_CLOCK);
});
afterEach(() => {
  vi.useRealTimers();
});

type AnyT = ReturnType<typeof convexTestWithComponents>;

const CONFLICT = /reused with different request content/i;

/** Whole-table read then JS filter: test-only, these tables hold a handful of rows. */
async function recoverAdvanceCommandRows(t: AnyT) {
  const all = await t.run((ctx) => ctx.db.query("commandIdempotency").collect());
  return all.filter((r) => r.operation === "payroll.recoverAdvance");
}

/**
 * Counts EMPLOYEE_ADVANCE_RECOVERED across BOTH surfaces. Without an
 * initialized chart / open period the hook QUEUES into
 * `pendingAccountingEvents` instead of posting to `accountingEvents`, so
 * reading only the posted table reports 0 for a GL effect that was in fact
 * produced. The existing payroll suite reads both for exactly this reason.
 */
async function advanceRecoveredEvents(t: AnyT) {
  return await t.run(async (ctx) => {
    const posted = await ctx.db.query("accountingEvents").collect();
    const pending = await ctx.db.query("pendingAccountingEvents").collect();
    const isRecovery = (r: { eventType: string }) => r.eventType === "EMPLOYEE_ADVANCE_RECOVERED";
    return [...posted.filter(isRecovery), ...pending.filter(isRecovery)];
  });
}

/**
 * Whole-table read then JS filter, like the helpers above. `AnyT` resolves
 * without the schema generic, so an indexed `.withIndex("by_advance", ...)`
 * here would not typecheck; these tables hold a handful of rows in a test.
 */
async function recoveriesFor(t: AnyT, advanceId: Id<"employeeAdvances">) {
  return await t.run(async (ctx) => {
    const all = await ctx.db.query("employeeAdvanceRecoveries").collect();
    return all.filter((r) => (r as { advanceId: Id<"employeeAdvances"> }).advanceId === advanceId);
  });
}

/** Runs a mutation and reports the outcome instead of throwing, so a test can assert on either. */
async function attempt<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

async function seedPayrollOrg(t: AnyT, suffix: string) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Payroll ${suffix}`, createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `pay_${suffix}`, email: `${suffix}@example.com`, name: "Emp" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Admin",
      isSystemOwnerRole: true,
      permissions: ["view:payroll", "manage:payroll", "view:commissions", "manage:commissions"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: [] })
  );
  return { orgId, userId, asAdmin: t.withIdentity({ subject: `pay_${suffix}`, clerkId: `pay_${suffix}` }) };
}

describe("SCRUM-291: recoverAdvance has one authoritative replay boundary", () => {
  test("first execution: A1 recovers 40 under key K, leaving command-log evidence and one GL effect", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "r291first");
    const a1 = await asAdmin.mutation(api.payroll.recordAdvance, { orgId, userId, amount: 100, idempotencyKey: "adv-first" });

    const r1 = await asAdmin.mutation(api.payroll.recoverAdvance, {
      orgId,
      advanceId: a1,
      method: "CASH",
      amount: 40,
      idempotencyKey: "K",
    });

    const adv = await t.run((ctx) => ctx.db.get(a1));
    expect(adv?.recoveredMinor).toBe(40000);
    expect(adv?.status).toBe("OUTSTANDING");
    expect(await recoveriesFor(t, a1)).toHaveLength(1);
    // One economic intent => exactly one command-log row, and one GL effect.
    const rows = await recoverAdvanceCommandRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe("K");
    expect(await advanceRecoveredEvents(t)).toHaveLength(1);
    expect(r1).toBeDefined();
  });

  test("exact retry after commit replays the original result and books nothing new", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "r291retry");
    const a1 = await asAdmin.mutation(api.payroll.recordAdvance, { orgId, userId, amount: 100, idempotencyKey: "adv-retry" });

    const args = { orgId, advanceId: a1, method: "CASH" as const, amount: 40, idempotencyKey: "K" };
    const r1 = await asAdmin.mutation(api.payroll.recoverAdvance, args);
    const r2 = await asAdmin.mutation(api.payroll.recoverAdvance, args);

    expect(r2).toBe(r1);
    const adv = await t.run((ctx) => ctx.db.get(a1));
    expect(adv?.recoveredMinor).toBe(40000);
    expect(await recoveriesFor(t, a1)).toHaveLength(1);
    expect(await recoverAdvanceCommandRows(t)).toHaveLength(1);
    expect(await advanceRecoveredEvents(t)).toHaveLength(1);
  });

  test("RED (primary production scenario): a retained identity with a CHANGED AMOUNT fails closed", async () => {
    // The web payroll page holds one identity per advance across attempts. The
    // operator recovers 40, loses the response, sees 60 outstanding, and
    // resubmits 60 under the SAME identity. That is a different economic
    // instruction and must never be reported as success.
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "r291amt");
    const a1 = await asAdmin.mutation(api.payroll.recordAdvance, { orgId, userId, amount: 100, idempotencyKey: "adv-amt" });

    await asAdmin.mutation(api.payroll.recoverAdvance, { orgId, advanceId: a1, method: "CASH", amount: 40, idempotencyKey: "K" });
    const second = await attempt(() =>
      asAdmin.mutation(api.payroll.recoverAdvance, { orgId, advanceId: a1, method: "CASH", amount: 60, idempotencyKey: "K" })
    );

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toMatch(CONFLICT);
    // No false success, no second recovery, no second economic event.
    const adv = await t.run((ctx) => ctx.db.get(a1));
    expect(adv?.recoveredMinor).toBe(40000);
    expect(adv?.status).toBe("OUTSTANDING");
    expect(await recoveriesFor(t, a1)).toHaveLength(1);
    expect(await advanceRecoveredEvents(t)).toHaveLength(1);
  });

  test("RED: a key reused for a DIFFERENT advance fails closed and leaves A2 untouched", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "r291cross");
    const a1 = await asAdmin.mutation(api.payroll.recordAdvance, { orgId, userId, amount: 100, idempotencyKey: "adv-c1" });
    const a2 = await asAdmin.mutation(api.payroll.recordAdvance, { orgId, userId, amount: 250, idempotencyKey: "adv-c2" });

    const r1 = await asAdmin.mutation(api.payroll.recoverAdvance, { orgId, advanceId: a1, method: "CASH", idempotencyKey: "K" });
    const second = await attempt(() =>
      asAdmin.mutation(api.payroll.recoverAdvance, { orgId, advanceId: a2, method: "CASH", idempotencyKey: "K" })
    );

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toMatch(CONFLICT);
    // Must NOT hand back the other advance's recovery id.
    if (second.ok) expect(second.value).not.toBe(r1);
    const adv2 = await t.run((ctx) => ctx.db.get(a2));
    expect(adv2?.status).toBe("OUTSTANDING");
    expect(adv2?.recoveredMinor).toBe(0);
    expect(await recoveriesFor(t, a2)).toHaveLength(0);
    expect(await advanceRecoveredEvents(t)).toHaveLength(1);
  });

  test("RED: the same advance and key with a CHANGED PAYMENT METHOD fails closed", async () => {
    // `method` selects the cash account in the GL hook, so two otherwise
    // identical recoveries differing only by method are different economic
    // instructions.
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "r291meth");
    const a1 = await asAdmin.mutation(api.payroll.recordAdvance, { orgId, userId, amount: 100, idempotencyKey: "adv-meth" });

    await asAdmin.mutation(api.payroll.recoverAdvance, { orgId, advanceId: a1, method: "CASH", amount: 40, idempotencyKey: "K" });
    const second = await attempt(() =>
      asAdmin.mutation(api.payroll.recoverAdvance, {
        orgId,
        advanceId: a1,
        method: "BANK_TRANSFER",
        amount: 40,
        idempotencyKey: "K",
      })
    );

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toMatch(CONFLICT);
    expect(await recoveriesFor(t, a1)).toHaveLength(1);
    expect(await advanceRecoveredEvents(t)).toHaveLength(1);
  });

  test("an OMITTED method is the same intent as an explicit CASH one and replays", async () => {
    // normalizePaymentMethod(undefined) === "CASH". The fingerprint must be
    // taken over the NORMALIZED request, so these two calls are one intent —
    // otherwise a caller that stops sending the default would be told its own
    // retry is a conflict.
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "r291norm");
    const a1 = await asAdmin.mutation(api.payroll.recordAdvance, { orgId, userId, amount: 100, idempotencyKey: "adv-norm" });

    const r1 = await asAdmin.mutation(api.payroll.recoverAdvance, { orgId, advanceId: a1, method: "CASH", amount: 40, idempotencyKey: "K" });
    const r2 = await asAdmin.mutation(api.payroll.recoverAdvance, { orgId, advanceId: a1, amount: 40, idempotencyKey: "K" });

    expect(r2).toBe(r1);
    expect(await recoveriesFor(t, a1)).toHaveLength(1);
  });

  test("GREEN CONTROL (load-bearing): an identical retry after FULL repayment still replays the original recovery", async () => {
    // This is why the early return existed. The advance is RECOVERED, so the
    // `status !== "OUTSTANDING"` refusal would reject the replay if the status
    // check ran before the replay boundary. The fix must resolve the replay
    // from the command log FIRST, not delete the behaviour.
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "r291full");
    const a1 = await asAdmin.mutation(api.payroll.recordAdvance, { orgId, userId, amount: 100, idempotencyKey: "adv-full" });

    const r1 = await asAdmin.mutation(api.payroll.recoverAdvance, { orgId, advanceId: a1, method: "CASH", idempotencyKey: "K" });
    const adv = await t.run((ctx) => ctx.db.get(a1));
    expect(adv?.status).toBe("RECOVERED");

    const r2 = await asAdmin.mutation(api.payroll.recoverAdvance, { orgId, advanceId: a1, method: "CASH", idempotencyKey: "K" });
    expect(r2).toBe(r1);
    expect(await recoveriesFor(t, a1)).toHaveLength(1);
    expect(await advanceRecoveredEvents(t)).toHaveLength(1);
  });

  test("a FRESH key for the remaining balance is a legitimate second recovery", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "r291fresh");
    const a1 = await asAdmin.mutation(api.payroll.recordAdvance, { orgId, userId, amount: 100, idempotencyKey: "adv-fresh" });

    await asAdmin.mutation(api.payroll.recoverAdvance, { orgId, advanceId: a1, method: "CASH", amount: 40, idempotencyKey: "K1" });
    await asAdmin.mutation(api.payroll.recoverAdvance, { orgId, advanceId: a1, method: "CASH", amount: 60, idempotencyKey: "K2" });

    const adv = await t.run((ctx) => ctx.db.get(a1));
    expect(adv?.recoveredMinor).toBe(100000);
    expect(adv?.status).toBe("RECOVERED");
    // Two distinct economic movements => two recovery rows and two GL effects.
    expect(await recoveriesFor(t, a1)).toHaveLength(2);
    expect(await recoverAdvanceCommandRows(t)).toHaveLength(2);
    expect(await advanceRecoveredEvents(t)).toHaveLength(2);
  });

  test("an immediate DOUBLE-SUBMIT of the identical request books exactly one recovery", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "r291dbl");
    const a1 = await asAdmin.mutation(api.payroll.recordAdvance, { orgId, userId, amount: 100, idempotencyKey: "adv-dbl" });

    const args = { orgId, advanceId: a1, method: "CASH" as const, amount: 40, idempotencyKey: "K" };
    const r1 = await asAdmin.mutation(api.payroll.recoverAdvance, args);
    const r2 = await asAdmin.mutation(api.payroll.recoverAdvance, args);

    expect(r2).toBe(r1);
    const adv = await t.run((ctx) => ctx.db.get(a1));
    expect(adv?.recoveredMinor).toBe(40000);
    expect(await recoveriesFor(t, a1)).toHaveLength(1);
    expect(await advanceRecoveredEvents(t)).toHaveLength(1);
  });

  test("CONCURRENT identical retries produce exactly one recovery and one GL effect", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "r291conc");
    const a1 = await asAdmin.mutation(api.payroll.recordAdvance, { orgId, userId, amount: 100, idempotencyKey: "adv-conc" });

    const args = { orgId, advanceId: a1, method: "CASH" as const, amount: 40, idempotencyKey: "K" };
    const outcomes = await Promise.all([
      attempt(() => asAdmin.mutation(api.payroll.recoverAdvance, args)),
      attempt(() => asAdmin.mutation(api.payroll.recoverAdvance, args)),
    ]);

    // Either both replay the same id, or one is rejected as in-flight. What is
    // NOT negotiable is the economic outcome: one movement, one journal.
    const succeeded = outcomes.filter((o) => o.ok);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    const adv = await t.run((ctx) => ctx.db.get(a1));
    expect(adv?.recoveredMinor).toBe(40000);
    expect(await recoveriesFor(t, a1)).toHaveLength(1);
    expect(await advanceRecoveredEvents(t)).toHaveLength(1);
  });

  test("a rejected conflicting retry adds NO command-log row, recovery, event or state change", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asAdmin } = await seedPayrollOrg(t, "r291norej");
    const a1 = await asAdmin.mutation(api.payroll.recordAdvance, { orgId, userId, amount: 100, idempotencyKey: "adv-norej" });

    await asAdmin.mutation(api.payroll.recoverAdvance, { orgId, advanceId: a1, method: "CASH", amount: 40, idempotencyKey: "K" });
    const before = {
      commands: (await recoverAdvanceCommandRows(t)).length,
      recoveries: (await recoveriesFor(t, a1)).length,
      events: (await advanceRecoveredEvents(t)).length,
      recovered: (await t.run((ctx) => ctx.db.get(a1)))?.recoveredMinor,
    };

    const rejected = await attempt(() =>
      asAdmin.mutation(api.payroll.recoverAdvance, { orgId, advanceId: a1, method: "CHEQUE", amount: 25, idempotencyKey: "K" })
    );
    expect(rejected.ok).toBe(false);

    // A conflict is a refusal, not a partial write. Convex rolls the whole
    // mutation back on throw, so nothing above may have moved.
    expect((await recoverAdvanceCommandRows(t)).length).toBe(before.commands);
    expect((await recoveriesFor(t, a1)).length).toBe(before.recoveries);
    expect((await advanceRecoveredEvents(t)).length).toBe(before.events);
    expect((await t.run((ctx) => ctx.db.get(a1)))?.recoveredMinor).toBe(before.recovered);
  });
});
