/**
 * SCRUM-876 round 3 - the later-AP-line probe runs for every org, but a retained OPENING payable keeps its
 * dated reconstruction.
 *
 * Invariant: the AP-Suppliers reconciliation may read "reconciled" at a cutoff only when both sides are shown
 * to reflect that cutoff. The GL side is always read AS OF the cutoff. An opening-basis payable is rebuilt AS OF the
 * cutoff from its dated payments, so a later payment of it is not "post-cutoff activity" for the comparison. A native
 * payable cannot be rebuilt, so a later AP-control line that no retained opening payable accounts for is the only
 * evidence of native activity once the native row is gone, and it makes the answer UNAVAILABLE.
 *
 * The opening balance itself is posted through the real `postOpeningBalanceDirect` mutation. The later payments are
 * written as rows plus journal entries directly (the real payment path is exercised by openingRemainingFamilies.test.ts),
 * so each date is explicit.
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
import { DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");
const P1_START = Date.UTC(2026, 0, 1);
const P1_END = Date.UTC(2026, 0, 31, 23, 59, 59, 999);
const P2_START = Date.UTC(2026, 1, 1);
const P2_END = Date.UTC(2026, 1, 28, 23, 59, 59, 999);
const IN_P1 = Date.UTC(2026, 0, 15);
const IN_P2 = Date.UTC(2026, 1, 15);
const OPENING_MINOR = 100_000; // 100 JOD, three decimals
const PAID_MINOR = 40_000;

/** An org whose only AP-Suppliers balance is an opening-basis payable on the canonical AP control account. */
async function seedOpening(tag: string, asOfDate: number, periodToOpen: "p1" | "p2") {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const ownerRole = DEFAULT_ROLE_TEMPLATES.find((role) => role.name === "OWNER");
  if (!ownerRole) throw new Error("Missing native owner template");
  const { orgId, userId, identity: owner } = await seedOrgWithMember(t, {
    clerkId: `${tag}_owner`, roleName: "OWNER", permissions: [...ownerRole.permissions],
  });
  await t.run(async (ctx) => {
    const membership = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique();
    if (!membership) throw new Error("Missing fixture membership");
    await ctx.db.patch(membership.roleId, { isSystemOwnerRole: true });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
  });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = 2026;
  await owner.mutation(api.accountingPeriods.create, { orgId, startDate: P1_START, endDate: P1_END, fiscalYear, periodNumber: 1 });
  await owner.mutation(api.accountingPeriods.create, { orgId, startDate: P2_START, endDate: P2_END, fiscalYear, periodNumber: 2 });
  const periods = await owner.query(api.accountingPeriods.list, { orgId });
  const p1 = periods.find((p: { periodNumber: number }) => p.periodNumber === 1)!;
  const p2 = periods.find((p: { periodNumber: number }) => p.periodNumber === 2)!;
  await owner.mutation(api.accountingPeriods.open, { orgId, periodId: (periodToOpen === "p1" ? p1 : p2)._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId });
  const ap = accounts.find((account: { systemKey?: string }) => account.systemKey === "ACCOUNTS_PAYABLE_SUPPLIERS")!;
  const retained = accounts.find((account: { systemKey?: string }) => account.systemKey === "RETAINED_EARNINGS")!;
  const posted = await owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
    orgId, expectedCurrency: "JOD", asOfDate,
    lines: [
      { accountId: ap._id, debitMinor: 0, creditMinor: OPENING_MINOR },
      { accountId: retained._id, debitMinor: OPENING_MINOR, creditMinor: 0 },
    ],
    allocations: [{
      kind: "SUPPLIER_PAYABLE", counterpartyName: "Synthetic supplier", title: "Synthetic opening payable",
      rowKey: "opening-1", accountId: ap._id, amountMinor: OPENING_MINOR,
    }],
  });
  expect(posted.journalId).toBeTruthy();
  const payable = (await t.run((ctx) => ctx.db.query("vehicleSupplierPayables").take(5)))[0];
  if (payable?.origin !== "OPENING") throw new Error("The fixture did not create an opening-basis payable");
  return { t, orgId, userId, owner, p1, p2, apId: ap._id as Id<"chartOfAccounts">, payable };
}
type Seed = Awaited<ReturnType<typeof seedOpening>>;

const reconAt = (s: Seed, toDate: number) => s.owner.query(api.accountingReports.supplierPayablesReconciliation, { orgId: s.orgId, toDate });

/** One AP-control journal entry + line, as a settlement posting writes it (sourceType/sourceId are the payable). */
const postApEntry = (
  s: Seed,
  period: { _id: Id<"accountingPeriods"> },
  opts: { at: number; debitMinor?: number; creditMinor?: number; category: "SYSTEM" | "REVERSAL" | "MANUAL"; sourceType: string; sourceId: string },
) =>
  s.t.run(async (ctx) => {
    const debitMinor = opts.debitMinor ?? 0;
    const creditMinor = opts.creditMinor ?? 0;
    const journalEntryId = await ctx.db.insert("journalEntries", {
      orgId: s.orgId, journalNumber: `JRN-876O-${opts.at}-${debitMinor}-${creditMinor}-${opts.category}`, accountingDate: opts.at,
      sourceType: opts.sourceType, sourceId: opts.sourceId, category: opts.category, memo: "SCRUM-876 opening fixture",
      status: "POSTED", currency: "JOD", postedBy: s.userId, postedAt: opts.at, createdAt: opts.at,
    });
    await ctx.db.insert("journalLines", {
      orgId: s.orgId, journalEntryId, lineNumber: 1, accountId: s.apId, debitMinor, creditMinor, currency: "JOD", scale: 3, accountingDate: opts.at,
    });
    await incrementAccountSnapshot(ctx, { orgId: s.orgId, accountId: s.apId, currency: "JOD", periodId: period._id, debitMinor, creditMinor });
    return journalEntryId;
  });

/** What the opening settlement path leaves behind for a payment made at `at`: the dated payment row + its AP debit. */
async function settleOpeningPayable(s: Seed, at: number, period: { _id: Id<"accountingPeriods"> }) {
  const paymentId = await s.t.run((ctx) =>
    ctx.db.insert("openingPayablePayments", {
      orgId: s.orgId, payableId: s.payable._id, seq: 1, openingBalanceDraftId: s.payable.openingBalanceDraftId!,
      openingRowKey: s.payable.openingRowKey!, amountMinor: PAID_MINOR, currency: "JOD", method: "CASH",
      occurredAt: at, actorId: s.userId, commandKey: "scrum876-opening-payment", operation: "recordPartialPayment", status: "LIVE",
    } as never),
  );
  await s.t.run((ctx) => ctx.db.patch(s.payable._id, { amountPaid: PAID_MINOR / 1000, paymentSeq: 1, status: "PARTIALLY_PAID", updatedAt: at } as never));
  const entryId = await postApEntry(s, period, { at, debitMinor: PAID_MINOR, category: "SYSTEM", sourceType: "vehicleSupplierPayables", sourceId: s.payable._id });
  return { paymentId, entryId };
}

describe("SCRUM-876 - an opening-basis payable keeps its dated reconstruction under the unconditional later-line probe", () => {
  test("CONTROL: a payment of the opening payable made after the cutoff does not make the earlier period unavailable", async () => {
    const s = await seedOpening("opn", IN_P1, "p1");
    const before = await reconAt(s, P1_END);
    expect(before.status).toBe("AVAILABLE");
    expect(before.byCurrency.JOD).toMatchObject({ glBalanceMinor: OPENING_MINOR, subledgerBalanceMinor: OPENING_MINOR, isReconciled: true });

    await settleOpeningPayable(s, IN_P2, s.p2);

    // January is read as it stood on Jan 31: the February payment is neither in the GL cutoff nor in the rebuilt subledger.
    const jan = await reconAt(s, P1_END);
    expect(jan.status).toBe("AVAILABLE");
    expect(jan.isReconciled).toBe(true);
    expect(jan.byCurrency.JOD).toMatchObject({ glBalanceMinor: OPENING_MINOR, subledgerBalanceMinor: OPENING_MINOR });
    // ... and the later period sees the payment on both sides.
    const feb = await reconAt(s, P2_END);
    expect(feb.status).toBe("AVAILABLE");
    expect(feb.byCurrency.JOD).toMatchObject({ glBalanceMinor: OPENING_MINOR - PAID_MINOR, subledgerBalanceMinor: OPENING_MINOR - PAID_MINOR, isReconciled: true });
  });

  test("CONTROL: a payment made after the cutoff and reversed after it (reversal entry copies the payment's source) is still dated-reconstructable", async () => {
    const s = await seedOpening("opnrev", IN_P1, "p1");
    const { paymentId } = await settleOpeningPayable(s, IN_P2, s.p2);
    const reversedAt = IN_P2 + 24 * 60 * 60 * 1000;
    await s.t.run((ctx) => ctx.db.patch(paymentId, { status: "REVERSED", reversedAt } as never));
    await postApEntry(s, s.p2, { at: reversedAt, creditMinor: PAID_MINOR, category: "REVERSAL", sourceType: "vehicleSupplierPayables", sourceId: s.payable._id });
    const jan = await reconAt(s, P1_END);
    expect(jan.status).toBe("AVAILABLE");
    expect(jan.byCurrency.JOD).toMatchObject({ glBalanceMinor: OPENING_MINOR, subledgerBalanceMinor: OPENING_MINOR, isReconciled: true });
  });

  test("CONTROL: an opening balance posted AFTER the cutoff does not make a pre-cutover period unavailable", async () => {
    const s = await seedOpening("opnlate", IN_P2, "p2");
    const jan = await reconAt(s, P1_END);
    expect(jan.status).toBe("AVAILABLE");
    expect(jan.isReconciled).toBe(true);
    const feb = await reconAt(s, P2_END);
    expect(feb.byCurrency.JOD).toMatchObject({ glBalanceMinor: OPENING_MINOR, subledgerBalanceMinor: OPENING_MINOR, isReconciled: true });
  });

  test("a later line that NO retained opening payable accounts for is refused even though opening rows survive and no native row does", async () => {
    const s = await seedOpening("opnnat", IN_P1, "p1");
    // A native payable that existed in January, was cancelled in February (its reversal is the line below), and was hard-deleted.
    const goneId = await s.t.run(async (ctx) => {
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: "VIN876_OPN", make: "Nissan", model: "Patrol", year: 2023, mileage: 0, color: "White",
        fuelType: "Petrol", transmission: "Automatic", sellingPrice: 30_000, sourceType: "SOURCED", sourcedFromName: "Partner Dealer",
        sourceCost: 19_000, status: "AVAILABLE",
      });
      const id = await ctx.db.insert("vehicleSupplierPayables", {
        orgId: s.orgId, vehicleId, sourcedFromName: "Partner Dealer", currency: "JOD", status: "DUE_ON_SALE", amountDue: 19_000,
        createdBy: s.userId, createdAt: IN_P1, updatedAt: IN_P1,
      } as never);
      await ctx.db.delete(id);
      return id;
    });
    await postApEntry(s, s.p2, { at: IN_P2, debitMinor: 19_000_000, category: "REVERSAL", sourceType: "vehicleSupplierPayables", sourceId: goneId });
    const r = await reconAt(s, P1_END);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("POST_CUTOFF_ACTIVITY");
    expect(r.isReconciled).toBe(false);
  });

  test("a later line sourced to something other than a retained opening payable (manual or another family) is refused, not excused", async () => {
    const s = await seedOpening("opnmanual", IN_P1, "p1");
    await postApEntry(s, s.p2, { at: IN_P2, debitMinor: 5_000, category: "MANUAL", sourceType: "manualJournalDrafts", sourceId: "scrum876-manual" });
    const r = await reconAt(s, P1_END);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("POST_CUTOFF_ACTIVITY");
  });

  test("a later line that merely carries a retained opening payable's id under another source family is refused, not excused", async () => {
    const s = await seedOpening("opnfamily", IN_P1, "p1");
    await postApEntry(s, s.p2, { at: IN_P2, debitMinor: 5_000, category: "SYSTEM", sourceType: "vehicles", sourceId: s.payable._id });
    const r = await reconAt(s, P1_END);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("POST_CUTOFF_ACTIVITY");
  });

  test("a later line is attributed one entry at a time and an over-budget attribution is refused, not assumed explained", async () => {
    const s = await seedOpening("opnbudget", IN_P1, "p1");
    await settleOpeningPayable(s, IN_P2, s.p2);
    await postApEntry(s, s.p2, { at: IN_P2 + 1000, debitMinor: 1_000, category: "SYSTEM", sourceType: "vehicleSupplierPayables", sourceId: s.payable._id });
    const within = await s.t.run((ctx) => computeSupplierPayablesReconciliation(ctx, s.orgId, P1_END, { readLimit: 2 }));
    expect(within.status).toBe("AVAILABLE");
    const over = await s.t.run((ctx) => computeSupplierPayablesReconciliation(ctx, s.orgId, P1_END, { readLimit: 1 }));
    expect(over.status).toBe("UNAVAILABLE");
    expect(over.unavailableReason).toBe("OVER_LIMIT");
    expect(over.isReconciled).toBe(false);
  });
});
