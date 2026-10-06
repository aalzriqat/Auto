/**
 * SCRUM-651 (D-42) - the AP-Suppliers subledger is the signed open balance of
 * every non-CANCELLED supplier payable, whatever its status label, and a sale
 * cancellation never leaves a live payable whose AP credit it reversed.
 *
 * Writers are the real mutations (sales.create, sourcingPayables.*, sales.update
 * cancellation, deal unwind); rows are seeded directly only where no writer can
 * reach the shape (legacy PAID with no amountPaid, overpaid, second currency).
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime (no read-limit enforcement, no OCC) and not production data.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { computeSupplierPayablesReconciliation } from "./accountingReports";
import { seedOrgWithMember } from "../test-utils/seedOrg";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");
const JOD = (major: number) => major * 1000; // JOD has three decimals

async function seedDealer(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const { orgId, userId } = await seedOrgWithMember(t, {
    clerkId: `${tag}_user`,
    orgName: `AP651 ${tag}`,
    roleName: "Owner",
    memberName: `${tag} User`,
    permissions: [
      "view:sales", "create:sales", "edit:sales", "delete:sales", "manage:finance", "view:finance",
      "view:customers", "create:customers", "view:vehicles", "create:vehicles", "edit:vehicles",
      "approve:requests", "view:commissions", "manage:commissions",
    ],
  });
  await t.run((ctx) => ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] }));
  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999), fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Customer" }));

  // Cancellation needs a second user holding approve:requests.
  const approverId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_approver`, email: `${tag}.a@example.com`, name: "Approver" }));
  const approverRole = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Manager", permissions: ["view:sales", "edit:sales", "approve:requests"] })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId: approverRole }));
  const asApprover = t.withIdentity({ subject: `${tag}_approver`, clerkId: `${tag}_approver` });

  return { t, orgId, userId, asUser, asApprover, customerId };
}
type Seed = Awaited<ReturnType<typeof seedDealer>>;

let keySeq = 0;
/** A COMPLETED consigned sale: the real SALE_COMPLETED posting credits AP-Suppliers and writes the payable. */
async function sourcedSale(s: Seed, cost = 19_000) {
  const n = ++keySeq;
  const vehicleId = await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin: `VIN651_${n}`, make: "Nissan", model: "Patrol", year: 2023, mileage: 0, color: "White",
      fuelType: "Petrol", transmission: "Automatic", sellingPrice: cost + 5_000, sourceType: "SOURCED",
      sourcedFromName: "Partner Dealer", sourceCost: cost, status: "AVAILABLE",
    })
  );
  const saleId = await s.asUser.mutation(api.sales.create, {
    orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
    salePrice: cost + 5_000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
    idempotencyKey: `ap651_sale_${n}`,
  });
  const payable = (await s.t.run((ctx) =>
    ctx.db.query("vehicleSupplierPayables").withIndex("by_sale", (q) => q.eq("saleId", saleId)).unique()
  ))!;
  return { saleId, vehicleId, payableId: payable._id as Id<"vehicleSupplierPayables"> };
}

const payableOf = (s: Seed, id: Id<"vehicleSupplierPayables">) => s.t.run((ctx) => ctx.db.get(id));

/** Net AP-Suppliers credit across every posted journal line (originals and reversals alike). */
const apNetMinor = (s: Seed, currency = "JOD") =>
  s.t.run(async (ctx) => {
    const account = (await ctx.db
      .query("chartOfAccounts")
      .withIndex("by_org_systemKey", (q) => q.eq("orgId", s.orgId).eq("systemKey", "ACCOUNTS_PAYABLE_SUPPLIERS"))
      .unique())!;
    const lines = await ctx.db.query("journalLines").withIndex("by_org_account", (q) => q.eq("orgId", s.orgId).eq("accountId", account._id)).collect();
    return lines.filter((l) => l.currency === currency).reduce((sum, l) => sum + l.creditMinor - l.debitMinor, 0);
  });

const recon = (s: Seed) => s.asUser.query(api.accountingReports.supplierPayablesReconciliation, { orgId: s.orgId });

async function refusalCode(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
  } catch (caught) {
    const error = caught as { data?: { code?: string }; message?: string };
    return error.data?.code ?? `UNCODED: ${error.message}`;
  }
  return "RESOLVED";
}

const eventCount = (s: Seed, eventType: string) =>
  s.t.run(async (ctx) =>
    (
      await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_eventType_date", (q) => q.eq("orgId", s.orgId).eq("eventType", eventType as never))
        .collect()
    ).length
  );

/** A hand-seeded supplier payable (no writer reaches these shapes); defaults to a JOD row from an old dealer. */
const insertPayable = (s: Seed, vehicleId: Id<"vehicles">, fields: Record<string, unknown>) => {
  const now = Date.now();
  return s.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierPayables", {
      orgId: s.orgId, vehicleId, sourcedFromName: "Old Dealer", currency: "JOD", createdBy: s.userId, createdAt: now, updatedAt: now,
      ...fields,
    } as never)
  );
};

describe("SCRUM-651 - reconciliation counts every non-CANCELLED payable by its open balance", () => {
  test("CONTROL: a fresh consigned sale reconciles", async () => {
    const s = await seedDealer("ctl");
    await sourcedSale(s);
    const r = await recon(s);
    expect(r.byCurrency.JOD).toMatchObject({ glBalanceMinor: JOD(19_000), subledgerBalanceMinor: JOD(19_000), isReconciled: true });
    expect(r.isReconciled).toBe(true);
    expect(r.status).toBe("AVAILABLE");
  });

  test("dispute then undispute: the payable is counted in every state and the GL agrees", async () => {
    const s = await seedDealer("disp");
    const { payableId } = await sourcedSale(s);

    await s.asUser.mutation(api.sourcingPayables.setDisputed, { orgId: s.orgId, payableId, disputed: true, reason: "Wrong figure" });
    expect((await payableOf(s, payableId))?.status).toBe("DISPUTED");
    expect(await apNetMinor(s)).toBe(JOD(19_000));
    const disputed = await recon(s);
    expect(disputed.byCurrency.JOD.subledgerBalanceMinor).toBe(JOD(19_000));
    expect(disputed.isReconciled).toBe(true);

    await s.asUser.mutation(api.sourcingPayables.setDisputed, { orgId: s.orgId, payableId, disputed: false });
    expect((await payableOf(s, payableId))?.status).toBe("DUE_ON_SALE");
    const lifted = await recon(s);
    expect(lifted.byCurrency.JOD.subledgerBalanceMinor).toBe(JOD(19_000));
    expect(lifted.isReconciled).toBe(true);
  });

  test("partial payment: only the remainder is counted and it equals the GL", async () => {
    const s = await seedDealer("part");
    const { payableId } = await sourcedSale(s);
    await s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
      orgId: s.orgId, payableId, amount: 5_000, idempotencyKey: "ap651_part_1",
    });
    expect((await payableOf(s, payableId))?.status).toBe("PARTIALLY_PAID");
    expect(await apNetMinor(s)).toBe(JOD(14_000));
    const r = await recon(s);
    expect(r.byCurrency.JOD).toMatchObject({ glBalanceMinor: JOD(14_000), subledgerBalanceMinor: JOD(14_000), isReconciled: true });
  });

  test("a payable settled in full contributes nothing and the GL agrees", async () => {
    const s = await seedDealer("full");
    const { payableId } = await sourcedSale(s);
    await s.asUser.mutation(api.sourcingPayables.markPaid, { orgId: s.orgId, payableId, idempotencyKey: "ap651_full_1" });
    const r = await recon(s);
    expect(r.byCurrency.JOD).toMatchObject({ glBalanceMinor: 0, subledgerBalanceMinor: 0, isReconciled: true });
  });

  test("a legacy PAID row with no amountPaid contributes 0, an overpaid row contributes a NEGATIVE amount", async () => {
    const s = await seedDealer("legacy");
    const { vehicleId } = await sourcedSale(s); // 19,000 live
    const now = Date.now();
    await insertPayable(s, vehicleId, { amountDue: 15_000, status: "PAID", paidAt: now }); // legacy: settled before amountPaid existed
    await insertPayable(s, vehicleId, { amountDue: 1_000, status: "PAID", amountPaid: 1_500, paidAt: now }); // paid twice over
    const r = await recon(s);
    // 19,000 + 0 + (1,000 - 1,500) = 18,500 - signed, never clamped to zero.
    expect(r.byCurrency.JOD.subledgerBalanceMinor).toBe(JOD(18_500));
  });

  test("an owned ON_ACCOUNT acquisition creates its AP credit AND a payable the reconciliation counts (R1)", async () => {
    const s = await seedDealer("onacct");
    const vehicleId = await s.asUser.mutation(api.vehicles.create, {
      idempotencyKey: "ap651_onacct_1", orgId: s.orgId, vin: "1HGCM82633A651001", make: "Honda", model: "Accord", year: 2020,
      mileage: 10000, color: "White", fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 20_000,
      status: "AVAILABLE", sourceType: "STOCK", purchasePrice: 10_000,
      purchasePaymentMethod: "ON_ACCOUNT", sourcedFromName: "Credit Supplier Co",
    });
    const payable = await s.t.run((ctx) =>
      ctx.db.query("vehicleSupplierPayables").withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicleId)).first()
    );
    expect(payable?.status).toBe("PENDING");
    // The posted AP lines (not just the row) carry the credit: acquisition-time, no sale involved.
    expect(await apNetMinor(s)).toBe(JOD(10_000));
    const r = await recon(s);
    expect(r.byCurrency.JOD).toMatchObject({ glBalanceMinor: JOD(10_000), subledgerBalanceMinor: JOD(10_000), isReconciled: true });
  });

  test("two currencies reconcile independently", async () => {
    const s = await seedDealer("ccy");
    const { vehicleId } = await sourcedSale(s); // JOD
    const now = Date.now();
    await insertPayable(s, vehicleId, { sourcedFromName: "US Dealer", amountDue: 2_000, currency: "USD", status: "DISPUTED" });
    // Fixture GL for the USD payable (the org posts in JOD, so no real writer reaches this).
    await s.t.run(async (ctx) => {
      const account = (await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", s.orgId).eq("systemKey", "ACCOUNTS_PAYABLE_SUPPLIERS"))
        .unique())!;
      const journalEntryId = await ctx.db.insert("journalEntries", {
        orgId: s.orgId, journalNumber: "JRN-USD-651", accountingDate: now, sourceType: "vehicles", sourceId: vehicleId,
        category: "SYSTEM", memo: "USD payable fixture", status: "POSTED", currency: "USD", postedBy: s.userId, postedAt: now, createdAt: now,
      });
      await ctx.db.insert("journalLines", {
        orgId: s.orgId, journalEntryId, lineNumber: 1, accountId: account._id, debitMinor: 0, creditMinor: 200_000,
        currency: "USD", scale: 2, accountingDate: now,
      });
    });
    const r = await recon(s);
    expect(r.currencies).toEqual(["JOD", "USD"]);
    expect(r.byCurrency.JOD).toMatchObject({ subledgerBalanceMinor: JOD(19_000), isReconciled: true });
    expect(r.byCurrency.USD).toMatchObject({ glBalanceMinor: 200_000, subledgerBalanceMinor: 200_000, isReconciled: true });
  });

  test("a payable on a soft-deleted vehicle is still counted", async () => {
    const s = await seedDealer("softdel");
    const { vehicleId } = await sourcedSale(s);
    await s.t.run((ctx) => ctx.db.patch(vehicleId, { isDeleted: true }));
    expect((await recon(s)).byCurrency.JOD.subledgerBalanceMinor).toBe(JOD(19_000));
  });
});

describe("SCRUM-651 - the reconciliation never says reconciled when it could not see the whole truth", () => {
  test("rows beyond the read bound: UNAVAILABLE (over-limit), never a truncated pass", async () => {
    const s = await seedDealer("lim");
    await sourcedSale(s);
    await sourcedSale(s);
    await sourcedSale(s);
    const tooSmall = await s.t.run((ctx) => computeSupplierPayablesReconciliation(ctx, s.orgId, undefined, { readLimit: 2 }));
    expect(tooSmall.status).toBe("UNAVAILABLE");
    expect(tooSmall.unavailableReason).toBe("OVER_LIMIT");
    expect(tooSmall.isReconciled).toBe(false);
    // Exactly at the bound is still fully visible.
    const exact = await s.t.run((ctx) => computeSupplierPayablesReconciliation(ctx, s.orgId, undefined, { readLimit: 3 }));
    expect(exact.status).toBe("AVAILABLE");
    expect(exact.isReconciled).toBe(true);
  });

  const queueEvent = (s: Seed, fields: Record<string, unknown>) =>
    s.t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId: s.orgId, kind: "POST", status: "PENDING", idempotencyKey: `k_${Math.random()}`, accountingDate: Date.now(),
        actorId: s.userId, attempts: 0, createdAt: Date.now(), sourceType: "sales", sourceId: "x", eventType: "SALE_COMPLETED",
        ...fields,
      } as never)
    );

  test.each(["PENDING", "FAILED"] as const)("an AP-affecting %s outbox event: UNAVAILABLE (pending postings)", async (status) => {
    const s = await seedDealer(`pp_${status}`);
    await sourcedSale(s);
    await queueEvent(s, { status });
    const r = await recon(s);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("PENDING_POSTINGS");
    expect(r.isReconciled).toBe(false);
  });

  test("a queued REVERSE of an AP-affecting original is also UNAVAILABLE", async () => {
    const s = await seedDealer("pp_rev");
    await sourcedSale(s);
    const original = await s.t.run(async (ctx) =>
      (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).find((e) => e.eventType === "SALE_COMPLETED")!
    );
    await queueEvent(s, { kind: "REVERSE", eventType: undefined, originalEventId: original._id });
    expect((await recon(s)).unavailableReason).toBe("PENDING_POSTINGS");
  });

  test("CONTROL: a queued event that cannot touch AP does not make it unavailable", async () => {
    const s = await seedDealer("pp_ctl");
    await sourcedSale(s);
    await queueEvent(s, { eventType: "EXPENSE_POSTED" });
    const r = await recon(s);
    expect(r.status).toBe("AVAILABLE");
    expect(r.isReconciled).toBe(true);
  });

  test("a manual journal draft awaiting approval that touches AP is UNAVAILABLE; one that does not is not", async () => {
    const s = await seedDealer("draft");
    await sourcedSale(s);
    const accounts = await s.t.run((ctx) => ctx.db.query("chartOfAccounts").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect());
    const ap = accounts.find((a) => a.systemKey === "ACCOUNTS_PAYABLE_SUPPLIERS")!;
    const other = accounts.find((a) => a.systemKey !== "ACCOUNTS_PAYABLE_SUPPLIERS")!;
    const now = Date.now();
    const draft = (accountId: Id<"chartOfAccounts">, key: string) =>
      s.t.run((ctx) =>
        ctx.db.insert("manualJournalDrafts", {
          orgId: s.orgId, status: "PENDING_APPROVAL", memo: "m", idempotencyKey: key, createdBy: s.userId, createdAt: now,
          lines: [{ accountId, debitMinor: 1, creditMinor: 0 }],
        })
      );
    await draft(other._id, "ap651_draft_other");
    expect((await recon(s)).status).toBe("AVAILABLE");
    await draft(ap._id, "ap651_draft_ap");
    const r = await recon(s);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("PENDING_POSTINGS");
    expect(r.isReconciled).toBe(false);
  });

  test("the period-close checklist warns that the AP check could not run, instead of reading it as reconciled", async () => {
    const s = await seedDealer("close");
    await sourcedSale(s);
    await queueEvent(s, { status: "FAILED" });
    const periods = await s.asUser.query(api.accountingPeriods.list, { orgId: s.orgId });
    const checklist = await s.asUser.query(api.accountingPeriods.closeChecklist, { orgId: s.orgId, periodId: periods[0]._id });
    expect(checklist.supplierPayablesReconciliation.status).toBe("UNAVAILABLE");
    expect(checklist.warnings.some((w: string) => /Supplier payables reconciliation could not be completed/i.test(w))).toBe(true);
  });
});

describe("SCRUM-651 - sale cancellation tears down every unpaid payable and refuses every paid one", () => {
  const cancel = (s: Seed, saleId: Id<"sales">) => s.asApprover.mutation(api.sales.update, { orgId: s.orgId, saleId, status: "CANCELLED" });

  test("an undisputed unpaid payable is cancelled and AP nets to zero (control)", async () => {
    const s = await seedDealer("c_pend");
    const { saleId, payableId } = await sourcedSale(s);
    await cancel(s, saleId);
    expect((await payableOf(s, payableId))?.status).toBe("CANCELLED");
    expect(await apNetMinor(s)).toBe(0);
    expect((await recon(s)).byCurrency.JOD).toMatchObject({ glBalanceMinor: 0, subledgerBalanceMinor: 0, isReconciled: true });
  });

  test("a DISPUTED payable is cancelled with the sale and AP nets to zero", async () => {
    const s = await seedDealer("c_disp");
    const { saleId, payableId } = await sourcedSale(s);
    await s.asUser.mutation(api.sourcingPayables.setDisputed, { orgId: s.orgId, payableId, disputed: true, reason: "Wrong figure" });
    await cancel(s, saleId);
    const after = await payableOf(s, payableId);
    expect(after?.status).toBe("CANCELLED");
    expect(after?.cancelledBy).toBeTruthy();
    expect(await apNetMinor(s)).toBe(0);
    expect((await recon(s)).byCurrency.JOD.subledgerBalanceMinor).toBe(0);
  });

  test("a DUE_ON_SALE payable (dispute lifted) is cancelled with the sale and AP nets to zero", async () => {
    const s = await seedDealer("c_due");
    const { saleId, payableId } = await sourcedSale(s);
    await s.asUser.mutation(api.sourcingPayables.setDisputed, { orgId: s.orgId, payableId, disputed: true, reason: "x" });
    await s.asUser.mutation(api.sourcingPayables.setDisputed, { orgId: s.orgId, payableId, disputed: false });
    expect((await payableOf(s, payableId))?.status).toBe("DUE_ON_SALE");
    await cancel(s, saleId);
    expect((await payableOf(s, payableId))?.status).toBe("CANCELLED");
    expect(await apNetMinor(s)).toBe(0);
  });

  test("a PARTIALLY_PAID payable refuses the cancellation with the coded error and writes nothing", async () => {
    const s = await seedDealer("c_part");
    const { saleId, payableId } = await sourcedSale(s);
    await s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
      orgId: s.orgId, payableId, amount: 5_000, idempotencyKey: "ap651_c_part_1",
    });
    const payableBefore = await payableOf(s, payableId);
    const apBefore = await apNetMinor(s);
    const reversalsBefore = await eventCount(s, "JOURNAL_REVERSAL");

    expect(await refusalCode(cancel(s, saleId))).toBe("SUPPLIER_PAYABLE_PAID_CANCEL_REFUSED");

    expect((await s.t.run((ctx) => ctx.db.get(saleId)))?.status).toBe("COMPLETED");
    expect(await payableOf(s, payableId)).toEqual(payableBefore);
    expect(await apNetMinor(s)).toBe(apBefore);
    expect(await eventCount(s, "JOURNAL_REVERSAL")).toBe(reversalsBefore);
  });

  test("a PAID payable refuses the cancellation with the coded error and writes nothing", async () => {
    const s = await seedDealer("c_paid");
    const { saleId, payableId } = await sourcedSale(s);
    await s.asUser.mutation(api.sourcingPayables.markPaid, { orgId: s.orgId, payableId, idempotencyKey: "ap651_c_paid_1" });
    const reversalsBefore = await eventCount(s, "JOURNAL_REVERSAL");
    expect(await refusalCode(cancel(s, saleId))).toBe("SUPPLIER_PAYABLE_PAID_CANCEL_REFUSED");
    expect((await s.t.run((ctx) => ctx.db.get(saleId)))?.status).toBe("COMPLETED");
    expect(await eventCount(s, "JOURNAL_REVERSAL")).toBe(reversalsBefore);
  });

  test("a DISPUTED payable that carries a recorded payment is refused too (paid amount, not the label, decides)", async () => {
    const s = await seedDealer("c_disp_paid");
    const { saleId, payableId } = await sourcedSale(s);
    await s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
      orgId: s.orgId, payableId, amount: 1_000, idempotencyKey: "ap651_c_dp_1",
    });
    await s.asUser.mutation(api.sourcingPayables.setDisputed, { orgId: s.orgId, payableId, disputed: true, reason: "x" });
    expect(await refusalCode(cancel(s, saleId))).toBe("SUPPLIER_PAYABLE_PAID_CANCEL_REFUSED");
    expect((await payableOf(s, payableId))?.status).toBe("DISPUTED");
  });

  test("a legacy PAID row with amountDue 0 (nothing ever left) does NOT refuse the cancellation (R5)", async () => {
    const s = await seedDealer("c_zero_paid");
    const { saleId, vehicleId, payableId } = await sourcedSale(s);
    const now = Date.now();
    const zeroPaidId = await insertPayable(s, vehicleId, { saleId, amountDue: 0, status: "PAID", paidAt: now });
    expect(await refusalCode(cancel(s, saleId))).toBe("RESOLVED");
    expect((await s.t.run((ctx) => ctx.db.get(saleId)))?.status).toBe("CANCELLED");
    expect((await payableOf(s, payableId))?.status).toBe("CANCELLED");
    expect((await payableOf(s, zeroPaidId))?.status).toBe("CANCELLED");
    expect(await apNetMinor(s)).toBe(0);
  });

  test("the refusal has English and Arabic copy", async () => {
    const { commonEn, commonAr } = await import("../lib/i18n/domains/common");
    const key = "ServerError_SUPPLIER_PAYABLE_PAID_CANCEL_REFUSED";
    expect((commonEn as Record<string, string>)[key]).toMatch(/manual accounting correction/);
    expect((commonAr as Record<string, string>)[key]).toMatch(/[؀-ۿ]/);
  });
});
