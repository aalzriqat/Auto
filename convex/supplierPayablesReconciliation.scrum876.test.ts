/**
 * SCRUM-876 - the AP-Suppliers reconciliation measures both sides at the SAME cutoff.
 *
 * Invariant: the supplier-payable subledger and the GL control balance are compared at one cutoff. A
 * native payable row carries no per-event dates (one cumulative `amountPaid`, one `updatedAt`), so it
 * cannot be restated to an earlier date. When anything on the subledger side moved after the cutoff
 * (including a payable that existed at the cutoff and was CANCELLED after it), or
 * the GL control account holds a line dated after it, or the cutoff is not a usable instant, the result
 * is UNAVAILABLE with a reason - never `isReconciled: true` and never an invented difference - and the
 * period close raises a warning (owner decision: reconciliation differences warn, they do not block).
 *
 * The GL and the rows are seeded directly so each date is explicit; the readers under test are the real
 * `supplierPayablesReconciliation` query and `accountingPeriods.closeChecklist`.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex runtime and not production data.
 */
import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { incrementAccountSnapshot } from "./accounting/accountSnapshots";
import { computeSupplierPayablesReconciliation } from "./accountingReports";
import { SUPPLIER_PAYABLES_RECON_POST_CUTOFF_WARNING } from "./utils/closeWarnings";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");
const JOD = (major: number) => major * 1000; // JOD has three decimals

// Two consecutive past periods. P1 is the one being closed; P2 holds "later" activity.
const P1_START = Date.UTC(2026, 0, 1);
const P1_END = Date.UTC(2026, 0, 31, 23, 59, 59, 999);
const P2_START = Date.UTC(2026, 1, 1);
const P2_END = Date.UTC(2026, 1, 28, 23, 59, 59, 999);
const IN_P1 = Date.UTC(2026, 0, 15);
const IN_P2 = Date.UTC(2026, 1, 15);

async function seedDealer(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const { orgId, userId } = await seedOrgWithMember(t, {
    clerkId: `${tag}_user`,
    orgName: `AP876 ${tag}`,
    roleName: "Owner",
    memberName: `${tag} User`,
    permissions: ["view:finance", "manage:finance", "view:vehicles", "create:vehicles"],
  });
  await t.run((ctx) => ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] }));
  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = 2026;
  await asUser.mutation(api.accountingPeriods.create, { orgId, startDate: P1_START, endDate: P1_END, fiscalYear, periodNumber: 1 });
  await asUser.mutation(api.accountingPeriods.create, { orgId, startDate: P2_START, endDate: P2_END, fiscalYear, periodNumber: 2 });
  const periods = await asUser.query(api.accountingPeriods.list, { orgId });
  const byNumber = (n: number) => periods.find((p: { periodNumber: number }) => p.periodNumber === n)!;
  const p1 = byNumber(1);
  const p2 = byNumber(2);
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VIN876_${tag}`, make: "Nissan", model: "Patrol", year: 2023, mileage: 0, color: "White",
      fuelType: "Petrol", transmission: "Automatic", sellingPrice: 30_000, sourceType: "SOURCED",
      sourcedFromName: "Partner Dealer", sourceCost: 19_000, status: "AVAILABLE",
    })
  );
  return { t, orgId, userId, asUser, vehicleId, p1, p2 };
}
type Seed = Awaited<ReturnType<typeof seedDealer>>;

/** A native supplier payable row, stamped as if it were last touched at `touchedAt`. */
const insertPayable = (s: Seed, fields: Record<string, unknown> & { createdAt: number; updatedAt: number }) =>
  s.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierPayables", {
      orgId: s.orgId, vehicleId: s.vehicleId, sourcedFromName: "Partner Dealer", currency: "JOD", status: "DUE_ON_SALE",
      createdBy: s.userId, ...fields,
    } as never)
  );

/** One AP-Suppliers GL line on `accountingDate`: credit raises the liability, debit lowers it. */
const postApLine = (s: Seed, period: { _id: Id<"accountingPeriods"> }, accountingDate: number, side: { creditMinor: number } | { debitMinor: number }) =>
  s.t.run(async (ctx) => {
    const account = (await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", s.orgId).eq("systemKey", "ACCOUNTS_PAYABLE_SUPPLIERS"))
      .unique())!;
    const creditMinor = "creditMinor" in side ? side.creditMinor : 0;
    const debitMinor = "debitMinor" in side ? side.debitMinor : 0;
    const journalEntryId = await ctx.db.insert("journalEntries", {
      orgId: s.orgId, journalNumber: `JRN-876-${accountingDate}-${creditMinor}-${debitMinor}`, accountingDate, sourceType: "vehicles",
      sourceId: s.vehicleId, category: "SYSTEM", memo: "SCRUM-876 fixture", status: "POSTED", currency: "JOD", postedBy: s.userId,
      postedAt: accountingDate, createdAt: accountingDate,
    });
    await ctx.db.insert("journalLines", {
      orgId: s.orgId, journalEntryId, lineNumber: 1, accountId: account._id, debitMinor, creditMinor, currency: "JOD", scale: 3, accountingDate,
    });
    await incrementAccountSnapshot(ctx, { orgId: s.orgId, accountId: account._id, currency: "JOD", periodId: period._id, debitMinor, creditMinor });
  });

const reconAt = (s: Seed, toDate: number) => s.asUser.query(api.accountingReports.supplierPayablesReconciliation, { orgId: s.orgId, toDate });
const checklist = (s: Seed, periodId: Id<"accountingPeriods">) => s.asUser.query(api.accountingPeriods.closeChecklist, { orgId: s.orgId, periodId });
const supplierWarnings = (warnings: string[]) => warnings.filter((w) => /supplier payables/i.test(w));

describe("SCRUM-876 - healthy controls and genuine differences are still reported as they were", () => {
  test("CONTROL: a payable and its GL credit both inside the period reconcile, and the close raises no supplier warning", async () => {
    const s = await seedDealer("ctl");
    await insertPayable(s, { amountDue: 19_000, createdAt: IN_P1, updatedAt: IN_P1 });
    await postApLine(s, s.p1, IN_P1, { creditMinor: JOD(19_000) });

    const r = await reconAt(s, P1_END);
    expect(r.status).toBe("AVAILABLE");
    expect(r.byCurrency.JOD).toMatchObject({ glBalanceMinor: JOD(19_000), subledgerBalanceMinor: JOD(19_000), isReconciled: true });
    expect(r.isReconciled).toBe(true);

    const c = await checklist(s, s.p1._id);
    expect(c.supplierPayablesReconciliation.status).toBe("AVAILABLE");
    expect(supplierWarnings(c.warnings)).toEqual([]);
  });

  test("CONTROL: a row stamped exactly AT the cutoff is on the cutoff, not after it", async () => {
    const s = await seedDealer("edge");
    await insertPayable(s, { amountDue: 19_000, createdAt: IN_P1, updatedAt: P1_END });
    await postApLine(s, s.p1, P1_END, { creditMinor: JOD(19_000) });
    const r = await reconAt(s, P1_END);
    expect(r.status).toBe("AVAILABLE");
    expect(r.isReconciled).toBe(true);
  });

  test("CONTROL: a genuine difference wholly inside the period is still reported as a difference, not hidden or made unavailable", async () => {
    const s = await seedDealer("diff");
    await insertPayable(s, { amountDue: 15_000, createdAt: IN_P1, updatedAt: IN_P1 });
    await postApLine(s, s.p1, IN_P1, { creditMinor: JOD(19_000) });
    const r = await reconAt(s, P1_END);
    expect(r.status).toBe("AVAILABLE");
    expect(r.isReconciled).toBe(false);
    expect(r.byCurrency.JOD).toMatchObject({ glBalanceMinor: JOD(19_000), subledgerBalanceMinor: JOD(15_000), isReconciled: false });
    const c = await checklist(s, s.p1._id);
    expect(supplierWarnings(c.warnings).join(" ")).toMatch(/does not reconcile to the GL for: JOD/);
  });
});

describe("SCRUM-876 - a later payable or payment cannot stand in for an earlier-period difference", () => {
  test("REPRO 1: the earlier payable is deleted but its GL stays; a same-sized later payable must not make the earlier period read reconciled", async () => {
    const s = await seedDealer("del");
    const earlier = await insertPayable(s, { amountDue: 19_000, createdAt: IN_P1, updatedAt: IN_P1 });
    await postApLine(s, s.p1, IN_P1, { creditMinor: JOD(19_000) });
    await insertPayable(s, { amountDue: 19_000, createdAt: IN_P2, updatedAt: IN_P2 });
    await postApLine(s, s.p2, IN_P2, { creditMinor: JOD(19_000) });
    await s.t.run((ctx) => ctx.db.delete(earlier));

    const r = await reconAt(s, P1_END);
    expect(r.isReconciled).toBe(false);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("POST_CUTOFF_ACTIVITY");

    const c = await checklist(s, s.p1._id);
    expect(c.supplierPayablesReconciliation.status).toBe("UNAVAILABLE");
    expect(c.warnings).toContain(SUPPLIER_PAYABLES_RECON_POST_CUTOFF_WARNING);
    expect(c.canClose).toBe(true); // owner decision: the difference warns, it does not block the close
  });

  test("REPRO 1b: a later payable offsets a real 4,000 shortfall inside the earlier period", async () => {
    const s = await seedDealer("offset");
    await insertPayable(s, { amountDue: 15_000, createdAt: IN_P1, updatedAt: IN_P1 });
    await postApLine(s, s.p1, IN_P1, { creditMinor: JOD(19_000) });
    await insertPayable(s, { amountDue: 4_000, createdAt: IN_P2, updatedAt: IN_P2 });
    await postApLine(s, s.p2, IN_P2, { creditMinor: JOD(4_000) });

    // Measured naively, the current subledger is 19,000 against a period-end GL of 19,000.
    const r = await reconAt(s, P1_END);
    expect(r.isReconciled).toBe(false);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("POST_CUTOFF_ACTIVITY");
    const c = await checklist(s, s.p1._id);
    expect(c.warnings).toContain(SUPPLIER_PAYABLES_RECON_POST_CUTOFF_WARNING);
  });

  test("a payment made after the cutoff does not count as if it had been made before it", async () => {
    const s = await seedDealer("latepay");
    await insertPayable(s, { amountDue: 19_000, amountPaid: 5_000, status: "PARTIALLY_PAID", paidAt: IN_P2, createdAt: IN_P1, updatedAt: IN_P2 });
    await postApLine(s, s.p1, IN_P1, { creditMinor: JOD(19_000) });
    await postApLine(s, s.p2, IN_P2, { debitMinor: JOD(5_000) });

    // Without the guard the current 14,000 is set against the Jan-31 GL of 19,000: an invented 5,000 difference.
    const r = await reconAt(s, P1_END);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("POST_CUTOFF_ACTIVITY");
    expect(r.isReconciled).toBe(false);
    expect(r.byCurrency).toEqual({});
  });
});

describe("SCRUM-876 - a payable row written after the cutoff is not assumed to belong before it", () => {
  test("a payable written after the cutoff for a posting dated before it is UNAVAILABLE, not counted", async () => {
    const s = await seedDealer("backdated");
    // A backdated sale: the AP credit is dated inside the period, the row was written afterwards.
    await insertPayable(s, { amountDue: 19_000, createdAt: IN_P2, updatedAt: IN_P2 });
    await postApLine(s, s.p1, IN_P1, { creditMinor: JOD(19_000) });
    const r = await reconAt(s, P1_END);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("POST_CUTOFF_ACTIVITY");
    expect(r.isReconciled).toBe(false);
    expect(r.byCurrency).toEqual({});
  });
});

describe("SCRUM-876 - GL lines dated after the cutoff (future-dated postings)", () => {
  test("a payable whose AP credit is dated after the cutoff is not compared against a GL that cannot see it", async () => {
    const s = await seedDealer("future");
    // sales.create accepts a saleDate up to 10 days ahead: the payable exists now, its GL credit is dated later.
    await insertPayable(s, { amountDue: 19_000, createdAt: IN_P1, updatedAt: IN_P1 });
    await postApLine(s, s.p2, IN_P2, { creditMinor: JOD(19_000) });

    const r = await reconAt(s, P1_END);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("POST_CUTOFF_ACTIVITY");
    expect(r.isReconciled).toBe(false);
    const c = await checklist(s, s.p1._id);
    expect(c.warnings).toContain(SUPPLIER_PAYABLES_RECON_POST_CUTOFF_WARNING);
  });

  test("the same holds for an omitted cutoff (now): a GL credit dated tomorrow is later than now", async () => {
    const s = await seedDealer("tomorrow");
    const now = Date.now();
    await insertPayable(s, { amountDue: 19_000, createdAt: now, updatedAt: now });
    await postApLine(s, s.p2, now + 24 * 60 * 60 * 1000, { creditMinor: JOD(19_000) });
    const r = await s.t.run((ctx) => computeSupplierPayablesReconciliation(ctx, s.orgId, undefined));
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("POST_CUTOFF_ACTIVITY");
    expect(r.isReconciled).toBe(false);
  });
});

describe("SCRUM-876 - an unusable cutoff is refused, never read as 'nothing is later'", () => {
  test("NaN, Infinity and -Infinity cutoffs are UNAVAILABLE with an invalid-date reason", async () => {
    const s = await seedDealer("badcutoff");
    await insertPayable(s, { amountDue: 19_000, createdAt: IN_P1, updatedAt: IN_P1 });
    await postApLine(s, s.p1, IN_P1, { creditMinor: JOD(19_000) });
    for (const toDate of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const r = await s.t.run((ctx) => computeSupplierPayablesReconciliation(ctx, s.orgId, toDate));
      expect(r.status).toBe("UNAVAILABLE");
      expect(r.unavailableReason).toBe("INVALID_DATE");
      expect(r.isReconciled).toBe(false);
      expect(r.currencies).toEqual([]);
    }
  });

  test("a payable row with a non-finite stamp cannot be placed before the cutoff", async () => {
    const s = await seedDealer("badstamp");
    await insertPayable(s, { amountDue: 19_000, createdAt: IN_P1, updatedAt: Number.NaN });
    await postApLine(s, s.p1, IN_P1, { creditMinor: JOD(19_000) });
    const r = await reconAt(s, P1_END);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.isReconciled).toBe(false);
  });
});

// SCRUM-876 round 2 (both seats, HIGH): a payable CANCELLED after the cutoff is not an open-status row, so it
// used to leave the comparison entirely while its January AP credit stayed in the January GL.
/** What saleCancellation.cancelPendingSupplierPayables writes: status, cancelledAt/By and updatedAt, all `now`. */
const cancelPayable = (s: Seed, id: Id<"vehicleSupplierPayables">, at: number) =>
  s.t.run((ctx) => ctx.db.patch(id, { status: "CANCELLED", cancelledAt: at, cancelledBy: s.userId, updatedAt: at } as never));

describe("SCRUM-876 - a payable cancelled after the cutoff cannot be erased from the earlier period", () => {
  test("a January payable cancelled in February cannot hide the January difference", async () => {
    const s = await seedDealer("cxlmask");
    const id = await insertPayable(s, { amountDue: 19_000, createdAt: IN_P1, updatedAt: IN_P1 });
    await postApLine(s, s.p1, IN_P1, { creditMinor: JOD(19_000) });
    await postApLine(s, s.p1, IN_P1, { debitMinor: JOD(19_000) }); // a misposted January debit: GL 0 against a 19,000 payable

    // CONTROL (live row): the real January difference is reported.
    const live = await reconAt(s, P1_END);
    expect(live.status).toBe("AVAILABLE");
    expect(live.isReconciled).toBe(false);
    expect(live.byCurrency.JOD).toMatchObject({ glBalanceMinor: 0, subledgerBalanceMinor: JOD(19_000), isReconciled: false });

    await cancelPayable(s, id, IN_P2);
    await postApLine(s, s.p2, IN_P2, { debitMinor: JOD(19_000) }); // the February reversal of the AP credit

    const r = await reconAt(s, P1_END);
    expect(r.isReconciled).toBe(false);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("POST_CUTOFF_ACTIVITY");
    expect(r.byCurrency).toEqual({});
    const c = await checklist(s, s.p1._id);
    expect(c.warnings).toContain(SUPPLIER_PAYABLES_RECON_POST_CUTOFF_WARNING);
    expect(c.canClose).toBe(true); // owner decision: warns, never blocks
  });

  test("a reconciled January cannot read as a difference once its only payable is cancelled in February", async () => {
    const s = await seedDealer("cxlinvent");
    const id = await insertPayable(s, { amountDue: 19_000, createdAt: IN_P1, updatedAt: IN_P1 });
    await postApLine(s, s.p1, IN_P1, { creditMinor: JOD(19_000) });
    expect((await reconAt(s, P1_END)).isReconciled).toBe(true);

    await cancelPayable(s, id, IN_P2);
    await postApLine(s, s.p2, IN_P2, { debitMinor: JOD(19_000) });

    const r = await reconAt(s, P1_END);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("POST_CUTOFF_ACTIVITY");
    expect(r.isReconciled).toBe(false);
    expect(r.byCurrency).toEqual({});
    expect((await checklist(s, s.p1._id)).warnings).toContain(SUPPLIER_PAYABLES_RECON_POST_CUTOFF_WARNING);
  });

  test("a CLOSED January (read from snapshots) cannot be made to look reconciled by a February cancellation", async () => {
    const s = await seedDealer("cxlclosed");
    const id = await insertPayable(s, { amountDue: 19_000, createdAt: IN_P1, updatedAt: IN_P1 });
    await postApLine(s, s.p1, IN_P1, { creditMinor: JOD(19_000) });
    await postApLine(s, s.p1, IN_P1, { debitMinor: JOD(19_000) });
    await s.asUser.mutation(api.accountingPeriods.open, { orgId: s.orgId, periodId: s.p1._id });
    const open = await checklist(s, s.p1._id);
    await s.asUser.mutation(api.accountingPeriods.close, { orgId: s.orgId, periodId: s.p1._id, acknowledgedWarnings: open.warnings });
    const closed = await s.t.run((ctx) => ctx.db.get(s.p1._id));
    expect(closed?.status).toBe("CLOSED");
    const before = await reconAt(s, P1_END);
    expect(before.status).toBe("AVAILABLE");
    expect(before.isReconciled).toBe(false);

    await cancelPayable(s, id, IN_P2);
    await postApLine(s, s.p2, IN_P2, { debitMinor: JOD(19_000) });

    const r = await reconAt(s, P1_END);
    expect(r.isReconciled).toBe(false);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("POST_CUTOFF_ACTIVITY");
  });

  test("CONTROL: a payable created and cancelled inside January, with its reversal, still reconciles to zero", async () => {
    const s = await seedDealer("cxlinside");
    const id = await insertPayable(s, { amountDue: 19_000, createdAt: IN_P1, updatedAt: IN_P1 });
    await postApLine(s, s.p1, IN_P1, { creditMinor: JOD(19_000) });
    await cancelPayable(s, id, IN_P1 + 1000);
    await postApLine(s, s.p1, IN_P1 + 1000, { debitMinor: JOD(19_000) });

    const r = await reconAt(s, P1_END);
    expect(r.status).toBe("AVAILABLE");
    expect(r.isReconciled).toBe(true);
    expect(supplierWarnings((await checklist(s, s.p1._id)).warnings)).toEqual([]);
  });

  test("a legacy cancelled row with no cancelledAt is placed by its updatedAt", async () => {
    const s = await seedDealer("cxllegacy");
    await insertPayable(s, { amountDue: 19_000, status: "CANCELLED", createdAt: IN_P1, updatedAt: IN_P2 });
    await postApLine(s, s.p1, IN_P1, { creditMinor: JOD(19_000) });
    const r = await reconAt(s, P1_END);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("POST_CUTOFF_ACTIVITY");
  });

  test("a payable cancelled before the cutoff whose AP credit is dated after it is not compared against a GL that shows only the reversal", async () => {
    const s = await seedDealer("cxlfuture");
    // sales.create accepts a future saleDate: the credit is dated after the cutoff, the cancellation (and its reversal) before it.
    const id = await insertPayable(s, { amountDue: 19_000, createdAt: IN_P1, updatedAt: IN_P1 });
    await postApLine(s, s.p2, IN_P2, { creditMinor: JOD(19_000) });
    await cancelPayable(s, id, IN_P1 + 1000);
    await postApLine(s, s.p1, IN_P1 + 1000, { debitMinor: JOD(19_000) });
    const r = await reconAt(s, P1_END);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("POST_CUTOFF_ACTIVITY");
  });

  test("cancelled payables are read inside the same bounded budget and an over-budget read is refused, not summed", async () => {
    const s = await seedDealer("cxlbudget");
    for (let i = 0; i < 3; i += 1) {
      const id = await insertPayable(s, { amountDue: 1_000, createdAt: IN_P1, updatedAt: IN_P1 });
      await cancelPayable(s, id, IN_P1 + 1000);
    }
    const within = await s.t.run((ctx) => computeSupplierPayablesReconciliation(ctx, s.orgId, P1_END, { readLimit: 3 }));
    expect(within.status).toBe("AVAILABLE");
    const over = await s.t.run((ctx) => computeSupplierPayablesReconciliation(ctx, s.orgId, P1_END, { readLimit: 2 }));
    expect(over.status).toBe("UNAVAILABLE");
    expect(over.unavailableReason).toBe("OVER_LIMIT");
    expect(over.isReconciled).toBe(false);
  });
});
