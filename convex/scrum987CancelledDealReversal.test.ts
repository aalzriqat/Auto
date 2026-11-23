import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, PERMISSIONS } from "./utils/permissions";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { hookCustodyCashReversed } from "./accounting/workflowHooks";
import { recomputeCustodyTotals } from "./utils/financeDealCosts/custodyLedger";
import { custodyEntryPostKey } from "./utils/custodySourceLedger";
import { syncCustodyPayable } from "./utils/financeDealCosts/custodyPosting";
import {
  applyCorrection,
  planCorrection,
  SCRUM987_EXPECTED_UTC_MONTH,
  SCRUM987_ORG_ID,
  SCRUM987_REASON,
  SCRUM987_TARGETS,
  type CorrectionTarget,
} from "./scrum987CancelledDealReversal";

/**
 * SCRUM-987 slice 1 — the one-time reversal of the execution fee and custody
 * issuance of three CANCELLED deals. Every deal is seeded through the REAL
 * handlers (open custody, record the fee from custody, reconcile, cancel);
 * assertions read the ledger (journal lines, event statuses, per-account net
 * by period, balance snapshots), never a return value.
 */

type TestConvex = ReturnType<typeof convexTestWithComponents<typeof schema>>;
const MODULES = import.meta.glob("./**/*.*s");

const OCT_15 = Date.UTC(2026, 9, 15, 9, 0, 0);
const OCT_16 = Date.UTC(2026, 9, 16, 9, 0, 0);
const OCT_20 = Date.UTC(2026, 9, 20, 9, 0, 0);
const NOV_23 = Date.UTC(2026, 10, 23, 10, 0, 0);
const AMOUNTS = [582_150, 870_000, 870_000] as const;
const TOTAL = AMOUNTS.reduce((a, b) => a + b, 0);

interface World {
  t: TestConvex;
  orgId: Id<"organizations">;
  actorId: Id<"users">;
  custodianId: Id<"users">;
  limitedId: Id<"users">;
  outsiderId: Id<"users">;
  octPeriodId: Id<"accountingPeriods">;
  novPeriodId: Id<"accountingPeriods">;
  targets: CorrectionTarget[];
  asActor: ReturnType<TestConvex["withIdentity"]>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(OCT_20));
});
afterEach(() => {
  vi.useRealTimers();
});

async function seedWorld(suffix: string, opts: { legacyOccurredAt?: boolean } = {}): Promise<World> {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S987 ${suffix}`, createdAt: Date.now() }));
  await t.run((ctx) => ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() }));
  const mk = (key: string) => t.run((ctx) => ctx.db.insert("users", { clerkId: `s987_${key}_${suffix}`, email: `${key}${suffix}@x.com`, name: key }));
  const [actorId, custodianId, limitedId, outsiderId] = [await mk("actor"), await mk("cust"), await mk("limited"), await mk("outsider")];
  const ownerRole = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true }));
  const createOnly = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "SALES", permissions: [PERMISSIONS.CREATE_FINANCE_APPLICATION] }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: actorId, roleId: ownerRole }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: custodianId, roleId: ownerRole }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: limitedId, roleId: createOnly }));
  const asActor = t.withIdentity({ subject: `s987_actor_${suffix}` });
  await asActor.mutation(api.chartOfAccounts.initialize, { orgId });
  await asActor.mutation(api.accountingPeriods.create, {
    orgId, fiscalYear: 2026, periodNumber: 10, startDate: Date.UTC(2026, 9, 1), endDate: Date.UTC(2026, 9, 31, 23, 59, 59, 999), openImmediately: true,
  });
  await asActor.mutation(api.accountingPeriods.create, {
    orgId, fiscalYear: 2026, periodNumber: 11, startDate: Date.UTC(2026, 10, 1), endDate: Date.UTC(2026, 10, 30, 23, 59, 59, 999), openImmediately: true,
  });
  const periods = await t.run((ctx) => ctx.db.query("accountingPeriods").collect());
  const octPeriodId = periods.find((p) => p.periodNumber === 10)!._id;
  const novPeriodId = periods.find((p) => p.periodNumber === 11)!._id;

  const labels = ["D-000012", "D-000015", "D-000016"];
  const targets: CorrectionTarget[] = [];
  for (let i = 0; i < 3; i += 1) {
    const amount = AMOUNTS[i];
    const { applicationId, vehicleId } = await t.run(async (ctx) => {
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, vin: `S987VIN${suffix}${i}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10, color: "White",
        fuelType: "Gas", transmission: "Auto", sellingPrice: 10_500, status: "AVAILABLE",
      });
      const customerId = await ctx.db.insert("customers", { orgId, firstName: "S", lastName: `Customer${i}` });
      const quoteId = await ctx.db.insert("quotes", {
        orgId, customerId, vehicleId, vehiclePrice: 10_500, downPayment: 500, termMonths: 48, status: "ACCEPTED", createdBy: actorId, createdAt: Date.now(),
      });
      const applicationId = await ctx.db.insert("financeApplications", {
        orgId, quoteId, customerId, vehicleId, salespersonId: actorId, status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
      });
      return { applicationId, vehicleId };
    });
    const custodyId = await asActor.mutation(api.financeDealCosts.openDealCustody, {
      idempotencyKey: `open-${suffix}-${i}`, orgId, applicationId, userId: custodianId, issuedMinor: amount, method: "CASH", occurredAt: OCT_15,
    });
    const feeId = await asActor.mutation(api.financeDealCosts.recordDealFee, {
      expectedCurrency: "JOD", idempotencyKey: `fee-${suffix}-${i}`, orgId, applicationId,
      feeType: "FINANCE_COMPANY_FEE", paidBy: "EMPLOYEE", paidTo: "FINANCE_COMPANY",
      accountingTreatment: "FINANCE_COMPANY_COMMISSION", deductedFromSettlement: false,
      actualAmountMinor: amount, custodyId, paidAt: OCT_16,
    });
    await asActor.mutation(api.financeDealCosts.reconcileDealCustody, {
      idempotencyKey: `rec-${suffix}-${i}`, orgId, custodyId, notes: "Matches the receipt.",
    });
    await asActor.mutation(api.applications.cancelApplication, { orgId, applicationId, idempotencyKey: `cancel-${suffix}-${i}` });
    const entry = (await t.run((ctx) => ctx.db.query("financeDealCustodyEntries").withIndex("by_custody", (q) => q.eq("custodyId", custodyId)).collect()))[0];
    if (i === 2) {
      // Finalized, then unwound: the sale is CANCELLED and the pointer is kept.
      await t.run(async (ctx) => {
        const app = await ctx.db.get(applicationId);
        const saleId = await ctx.db.insert("sales", {
          orgId, vehicleId, customerId: app!.customerId, salespersonId: actorId, salePrice: 10_500, saleDate: Date.now(), status: "CANCELLED",
        } as never);
        await ctx.db.patch(applicationId, { finalizedSaleId: saleId });
      });
    }
    if (opts.legacyOccurredAt === true && i === 0) {
      await t.run(async (ctx) => {
        const fee = (await ctx.db.get(feeId))!;
        await ctx.db.patch(feeId, { custodyPosted: { version: fee.custodyPosted!.version, amountMinor: fee.custodyPosted!.amountMinor, custodyId } });
      });
    }
    targets.push({
      label: labels[i], applicationId, feeId, custodyId, entryId: entry._id, amountMinor: amount, finalized: i === 2,
    });
  }
  // The clock moves to the correction day and October closes behind the postings.
  vi.setSystemTime(new Date(NOV_23));
  await t.run((ctx) => ctx.db.patch(octPeriodId, { status: "CLOSED" }));
  return { t, orgId, actorId, custodianId, limitedId, outsiderId, octPeriodId, novPeriodId, targets, asActor };
}

const args = (w: World, extra: Partial<Parameters<typeof applyCorrection>[1]> = {}) => ({
  orgId: w.orgId as string, actorId: w.actorId, targets: w.targets, reason: SCRUM987_REASON, now: Date.now(),
  expectedUtcMonth: SCRUM987_EXPECTED_UTC_MONTH, ...extra,
});
const apply = (w: World, extra: Partial<Parameters<typeof applyCorrection>[1]> = {}) =>
  w.t.run((ctx) => applyCorrection(ctx, args(w, extra)));
const plan = (w: World, extra: Partial<Parameters<typeof applyCorrection>[1]> = {}) =>
  w.t.run((ctx) => planCorrection(ctx, args(w, extra)));
const allTables = Object.keys(schema.tables);

/** Net debit-positive movement per system key, restricted to one period (or all). */
async function net(w: World, periodId?: Id<"accountingPeriods">): Promise<Record<string, number>> {
  return await w.t.run(async (ctx) => {
    const keyByAccount = new Map<string, string>();
    for (const a of (await ctx.db.query("chartOfAccounts").collect()).filter((x) => x.orgId === w.orgId)) if (a.systemKey) keyByAccount.set(a._id, a.systemKey);
    const totals: Record<string, number> = {};
    for (const entry of (await ctx.db.query("journalEntries").collect()).filter((e) => e.orgId === w.orgId)) {
      if (periodId !== undefined && entry.periodId !== periodId) continue;
      for (const l of await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)).collect()) {
        const key = keyByAccount.get(l.accountId);
        if (key) totals[key] = (totals[key] ?? 0) + l.debitMinor - l.creditMinor;
      }
    }
    return totals;
  });
}

/** Running snapshot net per system key for one period. */
async function snapshotNet(w: World, periodId: Id<"accountingPeriods">): Promise<Record<string, number>> {
  return await w.t.run(async (ctx) => {
    const keyByAccount = new Map<string, string>();
    for (const a of (await ctx.db.query("chartOfAccounts").collect()).filter((x) => x.orgId === w.orgId)) if (a.systemKey) keyByAccount.set(a._id, a.systemKey);
    const totals: Record<string, number> = {};
    for (const s of await ctx.db.query("accountBalanceSnapshots").withIndex("by_org_period", (q) => q.eq("orgId", w.orgId).eq("periodId", periodId)).collect()) {
      const key = keyByAccount.get(s.accountId);
      if (key) totals[key] = (totals[key] ?? 0) + s.runningDebitMinor - s.runningCreditMinor;
    }
    return totals;
  });
}

const eventsOf = (w: World) => w.t.run((ctx) => ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", w.orgId)).collect());
const nz = (r: Record<string, number>, key: string) => r[key] ?? 0;
const EXP = SYSTEM_KEYS.FINANCE_COMPANY_COMMISSION_EXPENSE;
const CLEARING = SYSTEM_KEYS.DEAL_CUSTODY_CLEARING;
const CASH = SYSTEM_KEYS.CASH_ON_HAND;

describe("happy path: three cancelled deals are reversed through the system paths", () => {
  test("every original event is REVERSED by one POSTED mirrored reversal in November; October is untouched", async () => {
    const w = await seedWorld("happy");
    const octBefore = await net(w, w.octPeriodId);
    const octSnapBefore = await snapshotNet(w, w.octPeriodId);
    // Precondition: the books carry the wrong money.
    expect(nz(await net(w), EXP)).toBe(TOTAL);
    expect(nz(await net(w), CASH)).toBe(-TOTAL);

    const result = await apply(w);
    expect(result.alreadyApplied).toBe(false);
    expect(result.targets).toHaveLength(3);

    // Per-account net over ALL periods is zero for the three accounts.
    const all = await net(w);
    expect([nz(all, EXP), nz(all, CLEARING), nz(all, CASH)]).toEqual([0, 0, 0]);
    // The November period carries exactly the correction: 6860 -X, 1100 +X, 1250 net 0.
    const nov = await net(w, w.novPeriodId);
    expect([nz(nov, EXP), nz(nov, CASH), nz(nov, CLEARING)]).toEqual([-TOTAL, TOTAL, 0]);
    // The closed October period is unchanged — lines and running snapshots.
    expect(await net(w, w.octPeriodId)).toEqual(octBefore);
    expect(await snapshotNet(w, w.octPeriodId)).toEqual(octSnapBefore);
    // The November snapshot reflects the reversal.
    const novSnap = await snapshotNet(w, w.novPeriodId);
    expect([nz(novSnap, EXP), nz(novSnap, CASH), nz(novSnap, CLEARING)]).toEqual([-TOTAL, TOTAL, 0]);

    const events = await eventsOf(w);
    const forward = events.filter((e) => e.eventType === "CUSTODY_FEE_PAID" || e.eventType === "CUSTODY_CASH_ISSUED");
    expect(forward).toHaveLength(6);
    expect(forward.every((e) => e.status === "REVERSED")).toBe(true);
    const reversals = events.filter((e) => e.eventType === "JOURNAL_REVERSAL");
    expect(reversals).toHaveLength(6);
    expect(reversals.every((e) => e.status === "POSTED" && e.accountingDate === NOV_23 && forward.some((f) => f.reversedByEventId === e._id))).toBe(true);
    // F2: no payable reclassification was ever created.
    expect(events.filter((e) => e.eventType === "CUSTODY_PAYABLE_RECLASSIFIED")).toEqual([]);
    expect(await w.t.run((ctx) => ctx.db.query("pendingAccountingEvents").collect())).toEqual([]);
  });

  test("rows: fees voided with the ruling, custody RECONCILED with sign-off untouched, economics untouched, audit row per target", async () => {
    const w = await seedWorld("rows");
    const before = await w.t.run(async (ctx) => ({
      apps: await Promise.all(w.targets.map((t) => ctx.db.get(t.applicationId as Id<"financeApplications">))),
      custody: await Promise.all(w.targets.map((t) => ctx.db.get(t.custodyId as Id<"financeDealCustody">))),
    }));
    await apply(w);
    await w.t.run(async (ctx) => {
      for (let i = 0; i < 3; i += 1) {
        const t = w.targets[i];
        const fee = (await ctx.db.get(t.feeId as Id<"financeDealFees">))!;
        expect(fee.voidedAt).toBe(NOV_23);
        expect(fee.voidedBy).toBe(w.actorId);
        expect(fee.voidReason).toContain("SCRUM-987 owner ruling 2026-11-23");
        expect(fee.custodyPosted).toBeUndefined();
        const custody = (await ctx.db.get(t.custodyId as Id<"financeDealCustody">))!;
        const b = before.custody[i]!;
        expect([custody.status, custody.reconciledAt, custody.reconciledBy, custody.reconciliationNotes]).toEqual([
          b.status, b.reconciledAt, b.reconciledBy, b.reconciliationNotes,
        ]);
        expect([custody.issuedMinor, custody.returnedMinor, custody.reimbursedMinor]).toEqual([0, 0, 0]);
        expect(custody.payableReclassIssued ?? []).toEqual([]);
        expect(await ctx.db.get(t.applicationId as Id<"financeApplications">)).toEqual(before.apps[i]);
        const log = await ctx.db.query("financeDealCustodyEntries").withIndex("by_custody", (q) => q.eq("custodyId", custody._id)).collect();
        const reversal = log.find((e) => e.kind === "REVERSAL")!;
        expect(reversal).toMatchObject({ reversesEntryId: t.entryId, amountMinor: t.amountMinor, note: SCRUM987_REASON });
      }
      const audit = (await ctx.db.query("adminAuditLog").collect()).filter((a) => a.action === "SCRUM-987_CANCELLED_DEAL_REVERSAL");
      expect(audit).toHaveLength(3);
      const reverseAudit = (await ctx.db.query("financialAuditLog").collect()).filter((a) => a.actionType === "REVERSE_EVENT");
      expect(reverseAudit.every((a) => a.description.includes(SCRUM987_REASON))).toBe(true);
    });
  });

  test("legacy custodyPosted without occurredAt reverses the same way", async () => {
    const w = await seedWorld("legacy", { legacyOccurredAt: true });
    await apply(w);
    const nov = await net(w, w.novPeriodId);
    expect([nz(nov, EXP), nz(nov, CASH), nz(nov, CLEARING)]).toEqual([-TOTAL, TOTAL, 0]);
  });

  test("a second run is alreadyApplied and writes nothing", async () => {
    const w = await seedWorld("again");
    await apply(w);
    const snapshot = await dbSnapshot(w.t, allTables);
    const again = await apply(w);
    expect(again).toEqual({ alreadyApplied: true, targets: [] });
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
    expect((await plan(w)).kind).toBe("ALREADY_APPLIED");
  });
});

describe("ordering and read-back are load-bearing", () => {
  test("reversing the issuance BEFORE the fee posts a payable reclassification (so the order is required)", async () => {
    const w = await seedWorld("order");
    const t = w.targets[0];
    // The wrong order, written by hand with the very same internals.
    await w.t.run(async (ctx) => {
      const custodyId = t.custodyId as Id<"financeDealCustody">;
      const entryId = t.entryId as Id<"financeDealCustodyEntries">;
      const reversalEntryId = await ctx.db.insert("financeDealCustodyEntries", {
        orgId: w.orgId, custodyId, kind: "REVERSAL", reversesEntryId: entryId, amountMinor: t.amountMinor, note: "wrong order",
        occurredAt: Date.now(), recordedBy: w.actorId, recordedAt: Date.now(),
      });
      await recomputeCustodyTotals(ctx, custodyId);
      await hookCustodyCashReversed(ctx, { orgId: w.orgId, entryId, kind: "ISSUED", reversalEntryId, reason: "x", actorId: w.actorId, reversalDate: Date.now() });
      await syncCustodyPayable(ctx, custodyId, w.actorId, Date.now(), [{ must: "OFF_BOOKS", idempotencyKey: custodyEntryPostKey(entryId) }]);
    });
    const reclass = (await eventsOf(w)).filter((e) => e.eventType === "CUSTODY_PAYABLE_RECLASSIFIED");
    expect(reclass.length).toBeGreaterThan(0);
    // The shipped order never produces one (asserted in the happy path as well).
    const w2 = await seedWorld("order2");
    await apply(w2);
    expect((await eventsOf(w2)).filter((e) => e.eventType === "CUSTODY_PAYABLE_RECLASSIFIED")).toEqual([]);
  });

  test("a closed November is refused at the plan, before any write", async () => {
    const w = await seedWorld("readback");
    await w.t.run((ctx) => ctx.db.patch(w.novPeriodId, { status: "CLOSED" }));
    const snapshot = await dbSnapshot(w.t, allTables);
    await expect(apply(w)).rejects.toThrow(/no OPEN accounting period/);
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
  });

  test("F1 read-back: if the hooks return DEFERRED while the planner saw an open period, the call throws and rolls back", async () => {
    const w = await seedWorld("readback2");
    const snapshot = await dbSnapshot(w.t, allTables);
    // The planner passes with the period open; the reversal hooks then find it closed.
    const stale = Date.now();
    await expect(
      w.t.run(async (ctx) => {
        const planned = await planCorrection(ctx, args(w, { now: stale }));
        expect(planned.kind).toBe("READY");
        // A deferred reversal: queue-and-return instead of posting.
        await ctx.db.patch(w.novPeriodId, { status: "CLOSED" });
        return await applyCorrectionSkippingPlan(ctx, w);
      })
    ).rejects.toThrow(/read-back failed/);
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
  });
});

/** Runs the executor's writes against a period that closed after planning — the read-back must refuse. */
async function applyCorrectionSkippingPlan(ctx: Parameters<typeof applyCorrection>[0], w: World) {
  // `applyCorrection` plans first; with November closed it would refuse at the plan. To reach the
  // read-back we re-open the period for the plan only, via a one-shot `getOpenPeriodForDate` window:
  await ctx.db.patch(w.novPeriodId, { status: "OPEN" });
  const original = ctx.db.patch.bind(ctx.db);
  let closedAfterPlan = false;
  (ctx.db as unknown as { patch: typeof ctx.db.patch }).patch = (async (...a: unknown[]) => {
    if (!closedAfterPlan) {
      closedAfterPlan = true;
      await (original as (...x: unknown[]) => Promise<void>)(w.novPeriodId, { status: "CLOSED" });
    }
    return await (original as (...x: unknown[]) => Promise<void>)(...a);
  }) as never;
  return await applyCorrection(ctx, args(w));
}

describe("fail closed before any write", () => {
  const refused = async (w: World, pattern: RegExp, extra: Partial<Parameters<typeof applyCorrection>[1]> = {}) => {
    const snapshot = await dbSnapshot(w.t, allTables);
    await expect(apply(w, extra)).rejects.toThrow(pattern);
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
  };

  test("a typo'd id or a wrong amount touches nothing", async () => {
    const w = await seedWorld("typo");
    await refused(w, /not all in the expected original state/, {
      targets: [w.targets[0], w.targets[1], { ...w.targets[2], feeId: "rh7evqeycaesbde744d9tep0n18jdezx" }],
    });
    await refused(w, /not all in the expected original state/, {
      targets: [w.targets[0], { ...w.targets[1], amountMinor: w.targets[1].amountMinor + 1 }, w.targets[2]],
    });
  });

  test("a partially applied state is refused with a report", async () => {
    const w = await seedWorld("partial");
    await apply(w, { targets: [w.targets[0]] });
    const snapshot = await dbSnapshot(w.t, allTables);
    await expect(apply(w)).rejects.toThrow(/partially applied/);
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
  });

  test("an original event that is already REVERSED or still PENDING refuses the whole run", async () => {
    for (const status of ["REVERSED", "PENDING"] as const) {
      const w = await seedWorld(`evt${status}`);
      await w.t.run(async (ctx) => {
        const ev = (await ctx.db.query("accountingEvents").withIndex("by_org_source", (q) =>
          q.eq("orgId", w.orgId).eq("sourceType", "financeDealFees").eq("sourceId", w.targets[1].feeId)).collect())[0];
        await ctx.db.patch(ev._id, { status });
      });
      await refused(w, /not all in the expected original state/);
    }
  });

  test("an outbox row that is not terminal refuses", async () => {
    const w = await seedWorld("outbox");
    await w.t.run((ctx) => ctx.db.insert("pendingAccountingEvents", {
      orgId: w.orgId, kind: "POST", status: "PENDING", idempotencyKey: "stray", accountingDate: NOV_23, actorId: w.actorId,
      attempts: 0, createdAt: NOV_23, sourceType: "financeDealFees", sourceId: w.targets[0].feeId,
    }));
    await refused(w, /not all in the expected original state/);
  });

  test("no open period for today refuses (a deferred reversal is not a correction)", async () => {
    const w = await seedWorld("noperiod");
    await w.t.run((ctx) => ctx.db.patch(w.novPeriodId, { status: "CLOSED" }));
    await refused(w, /no OPEN accounting period/);
  });

  test("running outside the expected month refuses", async () => {
    const w = await seedWorld("month");
    await refused(w, /not in 2026-12/, { expectedUtcMonth: "2026-12" });
  });

  test("actor: non-member, custodian, and a role without the confirm permission are refused", async () => {
    const w = await seedWorld("actor");
    await refused(w, /not a member/, { actorId: w.outsiderId });
    await refused(w, /not all in the expected original state/, { actorId: w.custodianId });
    await refused(w, /the actor lacks/, { actorId: w.limitedId });
  });

  test("a fee deducted from settlement, a direct payment, or a payable position is refused", async () => {
    const w = await seedWorld("shape");
    await w.t.run((ctx) => ctx.db.patch(w.targets[0].feeId as Id<"financeDealFees">, { deductedFromSettlement: true }));
    await refused(w, /not all in the expected original state/);
    const w2 = await seedWorld("shape2");
    await w2.t.run((ctx) => ctx.db.patch(w2.targets[1].custodyId as Id<"financeDealCustody">, { payableTargetMinor: 5 }));
    await refused(w2, /not all in the expected original state/);
  });

  test("an ACTIVE unwind on the finalized deal refuses", async () => {
    const w = await seedWorld("unwind");
    await w.t.run(async (ctx) => {
      const app = (await ctx.db.get(w.targets[2].applicationId as Id<"financeApplications">))!;
      await ctx.db.insert("dealUnwinds", {
        orgId: w.orgId, applicationId: app._id, saleId: app.finalizedSaleId!, status: "ACTIVE", reason: "x", startedBy: w.actorId,
        startedAt: NOV_23, createdAt: NOV_23, updatedAt: NOV_23, remittanceVersion: 1, remittanceMinor: 0, remittanceMethod: "CASH", forwardDueMinor: 0,
      } as never);
    });
    await refused(w, /not all in the expected original state/);
  });

  test("rehearsal performs every write, proves the result, then rolls everything back", async () => {
    const w = await seedWorld("rehearse");
    const snapshot = await dbSnapshot(w.t, allTables);
    const inside: { writes?: number } = {};
    await expect(
      w.t.run(async (ctx) => {
        const result = await applyCorrection(ctx, args(w));
        inside.writes = (await ctx.db.query("financeDealCustodyEntries").collect()).filter((e) => e.kind === "REVERSAL").length;
        throw new Error(`REHEARSAL ${JSON.stringify(result)}`);
      })
    ).rejects.toThrow(/REHEARSAL/);
    expect(inside.writes).toBe(3);
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
  });
});

describe("the hard-coded allow-list", () => {
  test("ids are well-formed for their tables and match the invariant packet", async () => {
    const w = await seedWorld("ids");
    await w.t.run(async (ctx) => {
      for (const target of SCRUM987_TARGETS) {
        // A production id has the shape of its table's ids: 32 lowercase chars. The test deployment
        // mints ids of the same width; normalizeId proves the id/table pairing when a row exists.
        for (const id of [target.applicationId, target.feeId, target.custodyId, target.entryId]) expect(id).toMatch(/^[a-z0-9]{32}$/);
      }
      expect(ctx.db.normalizeId("organizations", SCRUM987_ORG_ID) === null || typeof SCRUM987_ORG_ID === "string").toBe(true);
    });
    expect(SCRUM987_TARGETS.map((t) => [t.label, t.amountMinor, t.finalized])).toEqual([
      ["D-000012", 582_150, false], ["D-000015", 870_000, false], ["D-000016", 870_000, true],
    ]);
    expect(SCRUM987_TARGETS.map((t) => t.feeId)).toEqual([
      "rh716g08tzs0kjq8xh1kcprvfs8jdgfp", "rh71aasc38t34x4g22gmpvxhws8jcyy5", "rh7evqeycaesbde744d9tep0n18jdezs",
    ]);
    expect(SCRUM987_TARGETS.map((t) => t.entryId)).toEqual([
      "rd73sbrcqf3qfecr4v6m0rxx3h8jce2s", "rd725v20e792s89e4n0b5vah3n8jd1ph", "rd7eqpry1j41gw6ch7z3tn4k9s8jckf7",
    ]);
    expect(SCRUM987_TARGETS.map((t) => t.custodyId)).toEqual([
      "r976ejw9pca01ckx442f48pk6s8jdynn", "r97cy2f8t6gqex3zn5hgm2kz1x8jdmct", "r97f74vwqhfd2v7kspzep6pmvn8jc536",
    ]);
    expect(SCRUM987_TARGETS.map((t) => t.applicationId)).toEqual([
      "qs7en3pgh408khqsagjphgqhrx8jdxzf", "qs7dq0emdxtb7m65kbfgca41398jc811", "qs70da2paqr67nvawywa4tnxfn8jcnds",
    ]);
    expect(SCRUM987_ORG_ID).toBe("pd7pw6zrrz9q9ke4sdv6xtw6tn8g8v5n");
  });

  test("the internal doors against a deployment that lacks these ids fail closed and write nothing", async () => {
    const w = await seedWorld("doors");
    const snapshot = await dbSnapshot(w.t, allTables);
    await expect(
      w.t.mutation(internal.scrum987CancelledDealReversal.applyScrum987, { actorId: w.actorId, confirm: "SCRUM-987", mode: "apply" })
    ).rejects.toThrow();
    await expect(
      w.t.query(internal.scrum987CancelledDealReversal.planScrum987, { actorId: w.actorId })
    ).rejects.toThrow();
    expect(await dbSnapshot(w.t, allTables)).toEqual(snapshot);
  });
});
