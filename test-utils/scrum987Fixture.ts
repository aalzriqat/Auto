// SCRUM-987 slice 1 — shared fixture for the two scrum987CancelledDealReversal test files. Seeds the three
// cancelled deals through the REAL handlers; callers pass their own `import.meta.glob` result because a glob
// resolves relative to the file that writes it.
import { vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { ALL_PERMISSIONS, PERMISSIONS } from "../convex/utils/permissions";
import { SYSTEM_KEYS } from "../convex/utils/defaultChart";
import { getCumulativeBalancesAsOf } from "../convex/accounting/accountSnapshots";
import { applyCorrection } from "../convex/scrum987CancelledDealReversal";
import { planCorrection } from "../convex/utils/scrum987Inspection";
import { SCRUM987_EXPECTED_UTC_MONTH, SCRUM987_REASON, type CorrectionTarget } from "../convex/utils/scrum987Targets";
import { convexTestWithComponents } from "./convexTest";
export type TestConvex = ReturnType<typeof convexTestWithComponents<typeof schema>>;
export const OCT_15 = Date.UTC(2026, 9, 15, 9, 0, 0);
export const OCT_16 = Date.UTC(2026, 9, 16, 9, 0, 0);
export const OCT_20 = Date.UTC(2026, 9, 20, 9, 0, 0);
export const NOV_23 = Date.UTC(2026, 10, 23, 10, 0, 0);
export const AMOUNTS = [582_150, 870_000, 870_000] as const;
export const TOTAL = AMOUNTS.reduce((a, b) => a + b, 0);

export interface World {
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
export async function seedWorld(modules: Record<string, () => Promise<unknown>>, suffix: string, opts: { legacyOccurredAt?: boolean } = {}): Promise<World> {
  const t = convexTestWithComponents(schema, modules);
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

export const args = (w: World, extra: Partial<Parameters<typeof applyCorrection>[1]> = {}) => ({
  orgId: w.orgId as string, actorId: w.actorId, targets: w.targets, reason: SCRUM987_REASON, now: Date.now(),
  expectedUtcMonth: SCRUM987_EXPECTED_UTC_MONTH, ...extra,
});
export const apply = (w: World, extra: Partial<Parameters<typeof applyCorrection>[1]> = {}) =>
  w.t.run((ctx) => applyCorrection(ctx, args(w, extra)));
export const plan = (w: World, extra: Partial<Parameters<typeof applyCorrection>[1]> = {}) =>
  w.t.run((ctx) => planCorrection(ctx, args(w, extra)));
export const allTables = Object.keys(schema.tables);

/** Net debit-positive movement per system key, restricted to one period (or all). */
export async function net(w: World, periodId?: Id<"accountingPeriods">): Promise<Record<string, number>> {
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
export async function snapshotNet(w: World, periodId: Id<"accountingPeriods">): Promise<Record<string, number>> {
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

export const eventsOf = (w: World) => w.t.run((ctx) => ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", w.orgId)).collect());
export const nz = (r: Record<string, number>, key: string) => r[key] ?? 0;
export const EXP = SYSTEM_KEYS.FINANCE_COMPANY_COMMISSION_EXPENSE;
export const CLEARING = SYSTEM_KEYS.DEAL_CUSTODY_CLEARING;
export const CASH = SYSTEM_KEYS.CASH_ON_HAND;
/**
 * A real registered internalMutation built by `internalMutation` from ./functions — its ctx.db is
 * `wrapOwnNumberDB(ctx, aggregateTriggers)`, exactly what applyScrum987 receives. (`t.run` only applies
 * `aggregateTriggers.wrapDB`, and nesting the production wrapper inside it does not terminate.)
 */
export const runWrappedRef = makeFunctionReference<"mutation", {
  actorId: Id<"users">; mode: "rehearse" | "apply"; orgId: string; targets: unknown; now: number; expectedUtcMonth: string;
}, { alreadyApplied: boolean; targets: unknown[] }>("__scrum987WrappedHarness:runWrapped");
export const wrappedRun = (w: World, mode: "rehearse" | "apply" = "apply") =>
  w.t.mutation(runWrappedRef, {
    actorId: w.actorId, mode, orgId: w.orgId as string, targets: w.targets, now: Date.now(), expectedUtcMonth: SCRUM987_EXPECTED_UTC_MONTH,
  });

/** Per-system-key cumulative balance (debit - credit) as of a date, read by the GL report helper. */
export async function reportNet(w: World, asOf: number): Promise<Record<string, number>> {
  return await w.t.run(async (ctx) => {
    const keyByAccount = new Map<string, string>();
    for (const a of await ctx.db.query("chartOfAccounts").withIndex("by_org", (q) => q.eq("orgId", w.orgId)).collect()) {
      if (a.systemKey) keyByAccount.set(a._id, a.systemKey);
    }
    const totals: Record<string, number> = {};
    for (const b of await getCumulativeBalancesAsOf(ctx, w.orgId, asOf)) {
      const key = keyByAccount.get(b.accountId);
      if (key) totals[key] = (totals[key] ?? 0) + b.debitMinor - b.creditMinor;
    }
    return totals;
  });
}
