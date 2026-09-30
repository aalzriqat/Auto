/**
 * SCRUM-239 - a CLEARED finance-company disbursement cheque the bank returns.
 *
 * INVARIANT: the cheque becomes RETURNED only through
 * `applications.returnFinanceDisbursementCheque`, which in one transaction
 * undoes exactly that disbursement (application receipt fields, every ACTIVE
 * allocation of its canonical payment, the payment, its own
 * FINANCE_CASH_RECEIVED occurrence) and nothing else. A re-confirm mints new
 * versioned keys.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime (no OCC, no paginated-query limit) and not production data.
 */
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getReceivableOutstandingMinor } from "./subledger";
import { financeDisbursementKeys } from "./utils/financeDisbursementKeys";
import { FC_RETURN_MESSAGES } from "./utils/fcCheque";
import { salesAr, salesEn } from "../lib/i18n/domains/sales";
import { getLocalizedErrorMessage } from "../lib/errors";
import { ConvexError } from "convex/values";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

const ALL_PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "finalize:financed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:reports", "manage:settings",
];
/** ACCOUNTANT: reads and posts finance, but does not confirm the transfer. */
const ACCOUNTANT_PERMS = ["view:finance", "manage:finance", "view:finance_applications", "view:reports"];

const G = 12_500_000; // minor units, JOD (3 decimals)
const H = 200_000;
const C = 1_375_000;
const SCALE = 1_000;

type Ledger = "NONE" | "OPEN_YEAR";

async function seed(tag: string, ledger: Ledger) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S239 ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const mkUser = async (suffix: string, perms: string[], owner: boolean) => {
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `${tag}_${suffix}`, email: `${tag}.${suffix}@example.com`, name: suffix })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: suffix.toUpperCase(), permissions: perms, ...(owner ? { isSystemOwnerRole: true } : {}) })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    return { userId, as: t.withIdentity({ subject: `${tag}_${suffix}`, clerkId: `${tag}_${suffix}` }) };
  };
  const owner = await mkUser("owner", ALL_PERMS, true);
  const approver = await mkUser("appr", ALL_PERMS, true);
  const accountant = await mkUser("acct", ACCOUNTANT_PERMS, false);
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"] })
  );
  const fiscalYear = new Date().getUTCFullYear();
  if (ledger === "OPEN_YEAR") {
    await owner.as.mutation(api.chartOfAccounts.initialize, { orgId });
    await owner.as.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(fiscalYear, 0, 1),
      endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
      fiscalYear,
      periodNumber: 1,
    });
    const period = (await owner.as.query(api.accountingPeriods.list, { orgId }))[0];
    await owner.as.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  }
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  const customerStatusId = await t.run((ctx) =>
    ctx.db.insert("orgCustomerStatuses", { orgId, label: "Eligible", isActive: true, order: 1 })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VIN239${tag}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
      color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: G / SCALE, status: "AVAILABLE", sourceType: "STOCK" as const, purchasePrice: 9_000,
    })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId, name: "Jordan Auto Finance", profitRate: 5, maxTermMonths: 60,
      gracePeriodMonths: 0, isActive: true, defaultLtvPercent: 100, adminFees: 0,
    })
  );
  return { t, orgId, customerId, customerStatusId, vehicleId, companyId, owner, approver, accountant, fiscalYear };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** Approved deal with a registered 12,500 CHEQUE tender, finalized. `forward` adds the deposit H and contribution C (plan v2 forward due). */
async function finalizedChequeDeal(tag: string, ledger: Ledger, opts: { forward?: boolean } = {}) {
  const s = await seed(tag, ledger);
  const quoteId = await s.owner.as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId,
    vehiclePrice: G / SCALE, downPayment: 0, termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY", companyId: s.companyId,
    customerEligibilityStatusIds: [s.customerStatusId], totalFinancedAmount: G / SCALE,
  });
  const applicationId = await s.owner.as.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
  await s.owner.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
  await s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
  await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId: s.orgId, applicationId, submittedQuotationMinor: G, source: "MANUAL_ENTRY",
  });
  await s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId: s.orgId, applicationId, approvedAmountMinor: G, basis: "MANUAL", notes: "Approved at the quotation.",
  });
  await registerHandover(s.owner.as, api, s.orgId, applicationId);
  const registerCheque = (chequeNumber: string) =>
    s.owner.as.mutation(api.applications.registerExpectedPayment, {
      orgId: s.orgId, applicationId, method: "CHEQUE", expectedDate: Date.now(),
      chequeDetails: { bank: "Arab Bank", chequeNumber }, faceAmount: String(G / SCALE),
    });
  await registerCheque("CHQ-239-1");
  await s.owner.as.mutation(api.financeDealCosts.recordLegalInvoice, {
    orgId: s.orgId, applicationId, legalInvoiceAmountMinor: G, legalInvoiceNumber: `INV-${applicationId}`,
    legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY",
  });
  const feeId = await s.owner.as.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId,
    feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER", accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false, actualAmountMinor: 0, description: "No closing costs.",
  });
  await s.owner.as.mutation(api.financeDealCosts.reconcileDealFee, { orgId: s.orgId, feeId, notes: "Matched." });
  if (opts.forward) {
    await s.t.run(async (ctx) => {
      await ctx.db.insert("deposits", {
        orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, quoteId,
        amount: H / SCALE, amountMinor: H, currency: "JOD", method: "CASH", status: "HELD", holdActive: true,
        createdBy: (await ctx.db.query("users").first())!._id, createdAt: Date.now(),
      } as never);
      await ctx.db.patch(applicationId, { customerFirstPaymentMinor: H, dealerContributionMinor: C });
    });
  }
  await s.owner.as.mutation(api.applications.finalizeDeal, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId,
  });

  // `expected` is the disbursement version the confirmer observed (round 3).
  const confirm = (expected?: number) =>
    s.owner.as.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: G, idempotencyKey: crypto.randomUUID(),
      ...(expected !== undefined ? { expectedDisbursementVersion: expected } : {}),
    });
  const cheques = () =>
    s.t.run(async (ctx) =>
      (await ctx.db.query("postDatedCheques").withIndex("by_application", (q) => q.eq("applicationId", applicationId)).collect()).sort(
        (a, b) => a._creationTime - b._creationTime
      )
    );
  const app = () => s.t.run((ctx) => ctx.db.get(applicationId));
  const giveBack = (chequeId: Id<"postDatedCheques">, over: { reason?: string; key?: string; as?: Seeded["owner"]["as"] } = {}) =>
    (over.as ?? s.owner.as).mutation(api.applications.returnFinanceDisbursementCheque, {
      orgId: s.orgId, applicationId, chequeId, returnReason: over.reason ?? "Bank returned: insufficient funds",
      idempotencyKey: over.key ?? crypto.randomUUID(),
    });
  const recordForward = async () => {
    const due = await s.t.run(async (ctx) => (await ctx.db.get(applicationId))?.financeCompanyForwardDueMinor ?? 0);
    if (due <= 0) return null;
    return await s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
      orgId: s.orgId, applicationId, method: "BANK_TRANSFER", paidAt: Date.now(),
      expectedAmountMinor: due, idempotencyKey: crypto.randomUUID(),
    });
  };
  return { s, quoteId, applicationId, registerCheque, confirm, cheques, app, giveBack, recordForward };
}

function codeOf(error: unknown): string | null {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "object" && data !== null && typeof (data as { code?: unknown }).code === "string") {
    return (data as { code: string }).code;
  }
  return null;
}
async function refusalCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return codeOf(error) ?? String((error as Error)?.message ?? error);
  }
  return "NO_REFUSAL";
}

/** Net debit-positive movement per system account across EVERY journal line of the org. */
async function glNet(s: Seeded) {
  return await s.t.run(async (ctx) => {
    const net = new Map<string, number>();
    for (const entry of await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()) {
      for (const line of await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)).collect()) {
        const account = await ctx.db.get(line.accountId);
        const key = account?.systemKey ?? String(line.accountId);
        net.set(key, (net.get(key) ?? 0) + line.debitMinor - line.creditMinor);
      }
    }
    return Object.fromEntries([...net].filter(([, v]) => v !== 0)) as Record<string, number>;
  });
}

/** What a disbursement return must NEVER change: the sale (its commission fields are on it), customer receivable, forward rows, other versions' rows. */
async function untouched(s: Seeded, applicationId: Id<"financeApplications">) {
  return await s.t.run(async (ctx) => {
    const app = await ctx.db.get(applicationId);
    const sale = app?.finalizedSaleId ? await ctx.db.get(app.finalizedSaleId) : null;
    return {
      sale,
      customerReceivable: sale?.canonicalReceivableDocumentId ? await ctx.db.get(sale.canonicalReceivableDocumentId) : null,
      forwards: await ctx.db.query("financeCompanyForwards").collect(),
      forwardEvents: (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).filter(
        (e) => !(e.sourceType === "financeApplications" && e.sourceId.startsWith("disbursement_"))
      ),
    };
  });
}

const financeReceivable = (s: Seeded, applicationId: Id<"financeApplications">) =>
  s.t.run((ctx) =>
    ctx.db
      .query("receivableDocuments")
      .withIndex("by_org_source", (q) => q.eq("orgId", s.orgId).eq("sourceType", "finance_application").eq("sourceId", applicationId))
      .unique()
  );
const paymentByKey = (s: Seeded, key: string) =>
  s.t.run((ctx) =>
    ctx.db.query("canonicalPayments").withIndex("by_org_idempotency", (q) => q.eq("orgId", s.orgId).eq("idempotencyKey", key)).unique()
  );
const cashEvents = (s: Seeded) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect())
      .filter((e) => e.eventType === "FINANCE_CASH_RECEIVED")
      .sort((a, b) => a.eventVersion - b.eventVersion)
  );
const pendingRow = (s: Seeded, key: string) =>
  s.t.run((ctx) =>
    ctx.db.query("pendingAccountingEvents").withIndex("by_org_idempotency", (q) => q.eq("orgId", s.orgId).eq("idempotencyKey", key)).unique()
  );
const auditRows = (s: Seeded) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("financialAuditLog").collect()).filter((r) => r.orgId === s.orgId && r.actionType === "RETURN_FINANCE_DISBURSEMENT_CHEQUE")
  );

describe("SCRUM-239 - happy path with a posted ledger", () => {
  test("a) return undoes exactly the disbursement; sale, commission, forward and customer receivable are untouched", async () => {
    const d = await finalizedChequeDeal("a1", "OPEN_YEAR");
    const { s, applicationId } = d;
    const glBeforeConfirm = await glNet(s);
    await d.confirm();
    const [cheque] = await d.cheques();
    expect(cheque.status).toBe("CLEARED");
    expect(((await d.app()) as { disbursementVersion?: number }).disbursementVersion).toBeUndefined();
    expect((await cashEvents(s)).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    const glAfterConfirm = await glNet(s);
    expect(glAfterConfirm).not.toEqual(glBeforeConfirm);
    const receivable = (await financeReceivable(s, applicationId))!;
    expect(await s.t.run((ctx) => getReceivableOutstandingMinor(ctx, receivable._id))).toBe(0);
    const frozen = await untouched(s, applicationId);

    const result = await d.giveBack(cheque._id);
    expect(result).toMatchObject({ chequeId: cheque._id, returnedDisbursementVersion: 1, nextDisbursementVersion: 2, reversal: "REVERSED" });

    // Application: receipt undone, expecting payment again, next version.
    const app = (await d.app())!;
    expect(app.disbursedAt).toBeUndefined();
    expect(app.disbursedAmountMinor).toBeUndefined();
    expect(app.disbursementIdempotencyKey).toBeUndefined();
    expect(app.settlementStatus).toBe("EXPECTED");
    expect(app.disbursementVersion).toBe(2);
    // Cheque: RETURNED, stamped.
    const returned = (await d.cheques())[0];
    expect(returned).toMatchObject({ status: "RETURNED", returnedAfterClearing: true, disbursementVersion: 1 });
    expect(returned.returnReason).toBe("Bank returned: insufficient funds");
    // Payment voided, allocations reversed, receivable back to face.
    const keys = financeDisbursementKeys(applicationId, 1);
    expect((await paymentByKey(s, keys.paymentKey))?.status).toBe("VOIDED");
    const allocations = await s.t.run((ctx) => ctx.db.query("paymentAllocations").collect());
    expect(allocations.filter((a) => a.status === "ACTIVE" && a.receivableDocumentId === receivable._id)).toEqual([]);
    expect(await s.t.run((ctx) => getReceivableOutstandingMinor(ctx, receivable._id))).toBe(G);
    // Ledger: the cash-received event reversed; Bank and AR-FC net to the pre-confirm state.
    expect((await cashEvents(s)).map((e) => [e.eventVersion, e.status])).toEqual([[1, "REVERSED"]]);
    expect(await glNet(s)).toEqual(glBeforeConfirm);
    // Nothing else moved.
    expect(await untouched(s, applicationId)).toEqual(frozen);
    // Audit trail.
    const audits = await auditRows(s);
    expect(audits).toHaveLength(1);
    expect(audits[0].resourceId).toBe(applicationId);
  });

  test("c) an exact replay has one effect; the same key with a different reason is refused", async () => {
    const d = await finalizedChequeDeal("c1", "OPEN_YEAR");
    await d.confirm();
    const [cheque] = await d.cheques();
    const key = crypto.randomUUID();
    const first = await d.giveBack(cheque._id, { key });
    const journalsAfterFirst = await d.s.t.run((ctx) => ctx.db.query("journalEntries").collect());
    const second = await d.giveBack(cheque._id, { key });
    expect(second).toEqual(first);
    expect(((await d.app())!).disbursementVersion).toBe(2);
    expect(await auditRows(d.s)).toHaveLength(1);
    expect(await d.s.t.run((ctx) => ctx.db.query("journalEntries").collect())).toHaveLength(journalsAfterFirst.length);
    expect(await refusalCode(d.giveBack(cheque._id, { key, reason: "a different reason" }))).not.toBe("NO_REFUSAL");
    expect(await auditRows(d.s)).toHaveLength(1);
  });
});

describe("SCRUM-239 - re-confirm after a return (DA-F1)", () => {
  test("b) return, register a new cheque, confirm at v2, return again: every key is versioned and nothing collides", async () => {
    const d = await finalizedChequeDeal("b1", "OPEN_YEAR");
    const { s, applicationId } = d;
    const glBase = await glNet(s);
    await d.confirm();
    const [first] = await d.cheques();
    await d.giveBack(first._id);
    expect(await glNet(s)).toEqual(glBase);

    // A fresh instrument for the same deal, then the second disbursement.
    await s.owner.as.mutation(api.applications.correctExpectedPayment, { orgId: s.orgId, applicationId, reason: "Bank returned the cheque" });
    await d.registerCheque("CHQ-239-2");
    await d.confirm(2);
    const afterConfirm2 = (await d.app())!;
    expect(afterConfirm2.disbursementVersion).toBe(2);
    expect(afterConfirm2.disbursedAt).toBeGreaterThan(0);
    const rows = await d.cheques();
    expect(rows.map((r) => r.status)).toEqual(["RETURNED", "CLEARED"]);
    expect(rows[1].disbursementVersion).toBe(2);
    const v1 = financeDisbursementKeys(applicationId, 1);
    const v2 = financeDisbursementKeys(applicationId, 2);
    expect((await paymentByKey(s, v1.paymentKey))?.status).toBe("VOIDED");
    expect((await paymentByKey(s, v2.paymentKey))?.status).toBe("SETTLED");
    expect((await cashEvents(s)).map((e) => [e.sourceId, e.eventVersion, e.status])).toEqual([
      [v1.sourceId, 1, "REVERSED"],
      [v2.sourceId, 2, "POSTED"],
    ]);
    const receivable = (await financeReceivable(s, applicationId))!;
    expect(await s.t.run((ctx) => getReceivableOutstandingMinor(ctx, receivable._id))).toBe(0);

    // The second disbursement can be returned too, reversing ITS event (not v1's).
    await d.giveBack(rows[1]._id, { reason: "Returned again" });
    expect((await cashEvents(s)).map((e) => [e.eventVersion, e.status])).toEqual([[1, "REVERSED"], [2, "REVERSED"]]);
    expect(await glNet(s)).toEqual(glBase);
    expect(((await d.app())!).disbursementVersion).toBe(3);
    expect(await auditRows(s)).toHaveLength(2);
    expect(await s.t.run((ctx) => getReceivableOutstandingMinor(ctx, receivable._id))).toBe(G);
  });
});

describe("SCRUM-239 - refusals happen before the first write", () => {
  const snapshot = (d: Awaited<ReturnType<typeof finalizedChequeDeal>>) =>
    d.s.t.run(async (ctx) => ({
      app: await ctx.db.get(d.applicationId),
      cheques: await ctx.db.query("postDatedCheques").collect(),
      payments: await ctx.db.query("canonicalPayments").collect(),
      allocations: await ctx.db.query("paymentAllocations").collect(),
      events: await ctx.db.query("accountingEvents").collect(),
      pending: await ctx.db.query("pendingAccountingEvents").collect(),
      audits: await ctx.db.query("financialAuditLog").collect(),
    }));

  test("d) not disbursed, cheque not cleared, wrong application, chain mismatch (amount, currency), wrong org, missing permission", async () => {
    // Not disbursed: the cheque is still HELD on a deal never confirmed.
    const fresh = await finalizedChequeDeal("d0", "OPEN_YEAR");
    const [held] = await fresh.cheques();
    const freshBefore = await snapshot(fresh);
    expect(await refusalCode(fresh.giveBack(held._id))).toBe("FINANCE_RETURN_NOT_DISBURSED");
    expect(await snapshot(fresh)).toEqual(freshBefore);

    const d = await finalizedChequeDeal("d1", "OPEN_YEAR");
    await d.confirm();
    const [cheque] = await d.cheques();
    const before = await snapshot(d);
    const expectRefused = async (code: string, patch: Record<string, unknown> | null, run?: () => Promise<unknown>) => {
      if (patch) await d.s.t.run((ctx) => ctx.db.patch(cheque._id, patch as never));
      expect(await refusalCode(run ? run() : d.giveBack(cheque._id))).toBe(code);
      await d.s.t.run((ctx) => ctx.db.replace(cheque._id, (() => { const { _id, _creationTime, ...rest } = before.cheques[0]; return rest; })() as never));
      expect(await snapshot(d)).toEqual(before);
    };
    // Not CLEARED.
    await expectRefused("FINANCE_RETURN_CHEQUE_NOT_CLEARED", { status: "HELD" });
    // Wrong application: the cheque names no deal.
    await expectRefused("FINANCE_RETURN_CHAIN_MISMATCH", { applicationId: undefined, originApplicationId: undefined });
    // Amount and currency must match the recorded disbursement.
    await expectRefused("FINANCE_RETURN_CHAIN_MISMATCH", { amountMinor: G + 1 });
    await expectRefused("FINANCE_RETURN_CHAIN_MISMATCH", { currency: "USD" });
    // The cheque's disbursement version must be the application's.
    await expectRefused("FINANCE_RETURN_CHAIN_MISMATCH", { disbursementVersion: 7 });
    // ...and must have cleared at the instant the application was disbursed.
    await expectRefused("FINANCE_RETURN_CHAIN_MISMATCH", { clearedAt: 1 });

    // Wrong organisation: another tenant's caller cannot even see the row.
    const other = await seed("d2", "NONE");
    const foreign = await other.owner.as
      .mutation(api.applications.returnFinanceDisbursementCheque, {
        orgId: other.orgId, applicationId: d.applicationId, chequeId: cheque._id, returnReason: "x", idempotencyKey: crypto.randomUUID(),
      })
      .then(() => "NO_REFUSAL", (e: unknown) => String((e as Error).message));
    expect(foreign).not.toBe("NO_REFUSAL");

    // Missing permission: an accountant holds view:finance but not confirm:finance_disbursement.
    expect(await refusalCode(d.giveBack(cheque._id, { as: d.s.accountant.as }))).toBe("FORBIDDEN");
    // A blank reason is refused.
    expect(await refusalCode(d.giveBack(cheque._id, { reason: "   " }))).toBe("FINANCE_RETURN_REASON_REQUIRED");
    // ...and so is one over the 500-character limit, with the limit carried for {max}.
    expect(await refusalCode(d.giveBack(cheque._id, { reason: "x".repeat(501) }))).toBe("FINANCE_RETURN_REASON_TOO_LONG");
    const tooLong = await d.giveBack(cheque._id, { reason: "x".repeat(501) }).then(() => null, (e: unknown) => (e as { data?: { max?: number } }).data);
    expect(tooLong?.max).toBe(500);
    expect(await snapshot(d)).toEqual(before);
  });

  test("d) an allocation that is not exactly the whole payment on this deal's receivable is refused", async () => {
    const d = await finalizedChequeDeal("d3", "OPEN_YEAR");
    await d.confirm();
    const [cheque] = await d.cheques();
    const before = await snapshot(d);
    await d.s.t.run(async (ctx) => {
      const active = (await ctx.db.query("paymentAllocations").collect()).find((a) => a.status === "ACTIVE")!;
      await ctx.db.patch(active._id, { amountMinor: active.amountMinor - 1 });
    });
    expect(await refusalCode(d.giveBack(cheque._id))).toBe("FINANCE_RETURN_ALLOCATION_SHAPE");
    const after = await snapshot(d);
    expect({ ...after, allocations: before.allocations.length }).toEqual({ ...before, allocations: before.allocations.length });
    expect(after.cheques).toEqual(before.cheques);
    expect(after.events).toEqual(before.events);
  });

  test("d) an active allocation that sits on a different receivable than this deal's finance receivable is refused", async () => {
    const d = await finalizedChequeDeal("d5", "OPEN_YEAR");
    await d.confirm();
    const [cheque] = await d.cheques();
    const other = (await untouched(d.s, d.applicationId)).customerReceivable;
    expect(other).not.toBeNull();
    await d.s.t.run(async (ctx) => {
      const active = (await ctx.db.query("paymentAllocations").collect()).find((a) => a.status === "ACTIVE")!;
      await ctx.db.patch(active._id, { receivableDocumentId: other!._id });
    });
    const before = await snapshot(d);
    expect(await refusalCode(d.giveBack(cheque._id))).toBe("FINANCE_RETURN_ALLOCATION_SHAPE");
    expect(await snapshot(d)).toEqual(before);
  });

  test("the legacy customer-collection door still refuses a cleared finance cheque, now with its own code", async () => {
    const d = await finalizedChequeDeal("d4", "OPEN_YEAR");
    await d.confirm();
    const [cheque] = await d.cheques();
    const before = await snapshot(d);
    const error = await d.s.owner.as
      .mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId: d.s.orgId, chequeId: cheque._id })
      .then(() => null, (e: unknown) => e as { data?: { code?: string; message?: string } });
    expect(error?.data?.code).toBe("FINANCE_CHEQUE_RETURN_FROM_DEAL");
    expect(error?.data?.message).toMatch(/Cheque returned by bank/);
    expect(await snapshot(d)).toEqual(before);
  });
});

describe("SCRUM-239 - period and ledger states decide how the receipt is undone", () => {
  test("e) original period closed, current period open: the reversal posts in the open period", async () => {
    const d = await finalizedChequeDeal("e1", "OPEN_YEAR");
    const { s, applicationId } = d;
    const glBase = await glNet(s);
    await d.confirm();
    // Move the original's period into the past and close it; open a period that covers today.
    const dayMs = 24 * 60 * 60 * 1000;
    const boundary = Date.now() - dayMs;
    await s.t.run(async (ctx) => {
      for (const period of await ctx.db.query("accountingPeriods").collect()) {
        if (period.orgId === s.orgId) await ctx.db.patch(period._id, { endDate: boundary, status: "CLOSED" });
      }
    });
    await s.owner.as.mutation(api.accountingPeriods.create, {
      orgId: s.orgId, fiscalYear: s.fiscalYear, periodNumber: 2, startDate: boundary + 1,
      endDate: Date.UTC(s.fiscalYear, 11, 31, 23, 59, 59, 999), openImmediately: true,
    });
    const [cheque] = await d.cheques();
    const result = await d.giveBack(cheque._id);
    expect(result).toMatchObject({ reversal: "REVERSED" });
    expect((await cashEvents(s)).map((e) => e.status)).toEqual(["REVERSED"]);
    expect(await glNet(s)).toEqual(glBase);
    expect(((await d.app())!).disbursementVersion).toBe(2);
    void applicationId;
  });

  test("e) no open period: DEFERRED, a PENDING REVERSE row under the version key, and the return still succeeds", async () => {
    const d = await finalizedChequeDeal("e2", "OPEN_YEAR");
    const { s, applicationId } = d;
    await d.confirm();
    await s.t.run(async (ctx) => {
      for (const period of await ctx.db.query("accountingPeriods").collect()) {
        if (period.orgId === s.orgId) await ctx.db.patch(period._id, { status: "CLOSED" });
      }
    });
    const [cheque] = await d.cheques();
    const result = await d.giveBack(cheque._id);
    expect(result).toMatchObject({ reversal: "DEFERRED" });
    const reversalKey = financeDisbursementKeys(applicationId, 1).reversalKey;
    const row = await pendingRow(s, reversalKey);
    expect(row).toMatchObject({ kind: "REVERSE", status: "PENDING" });
    expect((await cashEvents(s)).map((e) => e.status)).toEqual(["POSTED"]);
    expect((await d.cheques())[0].status).toBe("RETURNED");
    expect(((await d.app())!).disbursementVersion).toBe(2);

    // Once a period opens, the outbox drains the queued reversal.
    await s.t.run(async (ctx) => {
      for (const period of await ctx.db.query("accountingPeriods").collect()) {
        if (period.orgId === s.orgId) await ctx.db.patch(period._id, { status: "OPEN" });
      }
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      await s.t.mutation(internal.accountingOutbox.drainPendingAccountingEvents, { orgId: s.orgId });
      for (let pass = 0; pass < 10; pass += 1) {
        await s.t.finishAllScheduledFunctions(vi.runAllTimers);
        const queued = (await s.t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect())).filter(
          (f) => f.state.kind === "pending" || f.state.kind === "inProgress"
        ).length;
        if (queued === 0) break;
      }
    } finally {
      vi.useRealTimers();
    }
    expect((await cashEvents(s)).map((e) => e.status)).toEqual(["REVERSED"]);
  });

  test("f) NOT_POSTED: the queued forward post is cancelled and the ledger is never touched", async () => {
    const d = await finalizedChequeDeal("f1", "NONE");
    const { s, applicationId } = d;
    await d.confirm();
    const keys = financeDisbursementKeys(applicationId, 1);
    expect(await pendingRow(s, keys.pendingPostKey)).toMatchObject({ kind: "POST", status: "PENDING" });
    const [cheque] = await d.cheques();
    const result = await d.giveBack(cheque._id);
    expect(result).toMatchObject({ reversal: "NOT_POSTED" });
    expect((await pendingRow(s, keys.pendingPostKey))?.status).not.toBe("PENDING");
    expect(await cashEvents(s)).toEqual([]);
    expect(await s.t.run((ctx) => ctx.db.query("journalEntries").collect())).toEqual([]);
    expect((await d.cheques())[0].status).toBe("RETURNED");
  });
});

describe("SCRUM-239 - the forward is a separate fact", () => {
  test("g) plan-v2 deal whose forward was reported returned: the return succeeds and forward state is byte-identical", async () => {
    const d = await finalizedChequeDeal("g1", "OPEN_YEAR", { forward: true });
    const { s, applicationId } = d;
    const forwardId = await d.recordForward();
    expect(forwardId).not.toBeNull();
    await d.confirm();
    await s.owner.as.mutation(api.financeCompanyForward.reportFinanceCompanyForwardReturned, {
      orgId: s.orgId, applicationId, forwardId: forwardId!, reason: "The company sent it back.", idempotencyKey: crypto.randomUUID(),
    });
    const forwardTables = () =>
      s.t.run(async (ctx) => ({
        forwards: await ctx.db.query("financeCompanyForwards").collect(),
        forwardEvents: (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).filter(
          (e) => e.eventType.startsWith("FINANCE_COMPANY_FORWARD")
        ),
        forwardPending: (await ctx.db.query("pendingAccountingEvents").collect()).filter((r) => r.idempotencyKey.includes("forward")),
        forwardFields: (({ financeCompanyForwardDueMinor }) => ({ financeCompanyForwardDueMinor }))((await ctx.db.get(applicationId))!),
      }));
    const before = await forwardTables();
    const [cheque] = await d.cheques();
    await d.giveBack(cheque._id);
    expect(await forwardTables()).toEqual(before);
    expect((await d.cheques())[0].status).toBe("RETURNED");
    expect(((await d.app())!).disbursementVersion).toBe(2);
  });
});

describe("SCRUM-239 - D7 lineage audit", () => {
  const auditOf = (s: Seeded) => s.owner.as.query(api.chequeLineageAudit.auditFinanceCompanyCheques, { orgId: s.orgId, paginationOpts: { numItems: 100, cursor: null } });

  test("i) a proper return is clean; a FAILED queued reversal is flagged; a legacy RETURNED cheque is classified", async () => {
    const clean = await finalizedChequeDeal("i1", "OPEN_YEAR");
    await clean.confirm();
    const [c1] = await clean.cheques();
    await clean.giveBack(c1._id);
    const cleanReport = await auditOf(clean.s);
    expect(JSON.stringify(cleanReport)).not.toMatch(/RETURNED_AFTER_CLEARING_LEGACY|RETURN_DISBURSEMENT_NOT_UNDONE|RETURN_REVERSAL_FAILED|RETURN_REVERSAL_MISSING/);

    // A return whose deferred reversal FAILED is flagged.
    const failing = await finalizedChequeDeal("i2", "OPEN_YEAR");
    await failing.confirm();
    await failing.s.t.run(async (ctx) => {
      for (const period of await ctx.db.query("accountingPeriods").collect()) {
        if (period.orgId === failing.s.orgId) await ctx.db.patch(period._id, { status: "CLOSED" });
      }
    });
    const [c2] = await failing.cheques();
    await failing.giveBack(c2._id);
    const reversalKey = financeDisbursementKeys(failing.applicationId, 1).reversalKey;
    await failing.s.t.run(async (ctx) => {
      const row = (await ctx.db.query("pendingAccountingEvents").collect()).find((r) => r.idempotencyKey === reversalKey)!;
      await ctx.db.patch(row._id, { status: "FAILED" });
    });
    expect(JSON.stringify(await auditOf(failing.s))).toMatch(/RETURN_REVERSAL_FAILED/);

    // A legacy RETURNED-after-clearing cheque (no version, nothing undone) is classified, not ignored.
    const legacy = await finalizedChequeDeal("i3", "OPEN_YEAR");
    await legacy.confirm();
    const [c3] = await legacy.cheques();
    await legacy.s.t.run((ctx) =>
      ctx.db.patch(c3._id, { status: "RETURNED", returnedAfterClearing: true, returnedAt: Date.now(), disbursementVersion: undefined })
    );
    expect(JSON.stringify(await auditOf(legacy.s))).toMatch(/RETURNED_AFTER_CLEARING_LEGACY/);
  });
});

describe("SCRUM-239 - manager notification and coded, translated reason refusals", () => {
  test("the notification carries the cheque's display amount (12500), not its minor-unit face (12500000)", async () => {
    const d = await finalizedChequeDeal("n1", "OPEN_YEAR");
    // notifyManagers reaches members holding manage:users; the seeded owner role does not.
    await d.s.t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "n1_mgr", email: "n1.mgr@example.com", name: "mgr" });
      const roleId = await ctx.db.insert("roles", { orgId: d.s.orgId, name: "MGR", permissions: ["manage:users"] });
      await ctx.db.insert("memberships", { orgId: d.s.orgId, userId, roleId });
    });
    await d.confirm();
    const [cheque] = await d.cheques();
    await d.giveBack(cheque._id);
    const rows = await d.s.t.run(async (ctx) =>
      (await ctx.db.query("notifications").collect()).filter((n) => n.orgId === d.s.orgId && n.type === "collection.cheque_returned")
    );
    expect(rows).toHaveLength(1);
    // The same figure returnClearedCheque sends for a cheque of this face: String(cheque.amount).
    expect(rows[0].data?.amount).toBe(String(cheque.amount));
    expect(rows[0].data?.amount).toBe(String(G / SCALE));
    expect(rows[0].data?.amount).not.toBe(String(G));
  });

  test("every FC return refusal has an EN and an AR dictionary entry, and the EN matches the server message", () => {
    const codes = Object.keys(FC_RETURN_MESSAGES) as Array<keyof typeof FC_RETURN_MESSAGES>;
    expect(codes.length).toBeGreaterThanOrEqual(8);
    for (const code of codes) {
      const key = `ServerError_${code}` as keyof typeof salesEn;
      const en = salesEn[key] as string | undefined;
      const ar = salesAr[key] as string | undefined;
      expect(en, `EN for ${code}`).toBeTruthy();
      expect(ar, `AR for ${code}`).toMatch(/[\u0600-\u06FF]/);
      expect(en!.replace("{max}", "500"), code).toBe(FC_RETURN_MESSAGES[code]);
    }
  });

  test("the too-long refusal interpolates {max} in both languages", () => {
    const error = new ConvexError({ code: "FINANCE_RETURN_REASON_TOO_LONG", message: FC_RETURN_MESSAGES.FINANCE_RETURN_REASON_TOO_LONG, max: 500 });
    const en = getLocalizedErrorMessage(error, (k) => (salesEn as Record<string, string>)[k] ?? k);
    const ar = getLocalizedErrorMessage(error, (k) => (salesAr as Record<string, string>)[k] ?? k);
    expect(en).toContain("500");
    expect(ar).toContain("500");
    expect(en).not.toContain("{max}");
    expect(ar).not.toContain("{max}");
  });
});

describe("SCRUM-239 - the cockpit's disbursementReturn gate is computed on the server", () => {
  test("offered to the finance tier only for a cleared, current disbursement; CONFIRM-only or VIEW-only callers are not offered it", async () => {
    const d = await finalizedChequeDeal("g1", "OPEN_YEAR");
    const mk = async (suffix: string, perms: string[]) => {
      const userId = await d.s.t.run((ctx) => ctx.db.insert("users", { clerkId: `g1_${suffix}`, email: `g1.${suffix}@example.com`, name: suffix }));
      const roleId = await d.s.t.run((ctx) => ctx.db.insert("roles", { orgId: d.s.orgId, name: suffix.toUpperCase(), permissions: perms }));
      await d.s.t.run((ctx) => ctx.db.insert("memberships", { orgId: d.s.orgId, userId, roleId }));
      return d.s.t.withIdentity({ subject: `g1_${suffix}`, clerkId: `g1_${suffix}` });
    };
    const confirmOnly = await mk("confonly", ["view:sales", "view:finance_applications", "confirm:finance_disbursement"]);
    const viewOnly = await mk("viewonly", ["view:sales", "view:finance_applications", "view:finance"]);
    const flag = async (as: typeof d.s.owner.as) =>
      (await as.query(api.applications.dealCockpit, { orgId: d.s.orgId, applicationId: d.applicationId }))?.disbursementReturn;

    // Not disbursed: nothing to return.
    expect(await flag(d.s.owner.as)).toEqual({ mayReturn: false, chequeId: null, lastReturnedChequeId: null });

    await d.confirm();
    const [cheque] = await d.cheques();
    expect(await flag(d.s.owner.as)).toEqual({ mayReturn: true, chequeId: cheque._id, lastReturnedChequeId: null });
    // The same permissions the command requires: both, not either.
    expect((await flag(confirmOnly))?.mayReturn).toBe(false);
    expect((await flag(viewOnly))?.mayReturn).toBe(false);

    await d.giveBack(cheque._id);
    expect(await flag(d.s.owner.as)).toEqual({ mayReturn: false, chequeId: null, lastReturnedChequeId: cheque._id });
  });
});

describe("SCRUM-239 F1 - RETURNED is terminal for collections.returnCheque", () => {
  const returnFromCollections = (s: Seeded, chequeId: Id<"postDatedCheques">, over: { returnedAt?: number; returnReason?: string } = {}) =>
    s.owner.as.mutation(api.collections.returnCheque, { orgId: s.orgId, chequeId, ...over });
  const errorOf = (promise: Promise<unknown>) =>
    promise.then(() => null, (e: unknown) => e as { data?: { code?: string; message?: string } });
  const world = (s: Seeded) =>
    s.t.run(async (ctx) => ({
      cheques: await ctx.db.query("postDatedCheques").collect(),
      notifications: await ctx.db.query("notifications").collect(),
      reminders: await ctx.db.query("collectionReminders").collect(),
      receivables: await ctx.db.query("receivables").collect(),
    }));
  const addManager = (s: Seeded) =>
    s.t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "f1_mgr", email: "f1.mgr@example.com", name: "mgr" });
      const roleId = await ctx.db.insert("roles", { orgId: s.orgId, name: "MGR", permissions: ["manage:users"] });
      await ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId });
    });

  test("a finance-company cheque returned from the deal is refused a second return from Collections, and nothing is written", async () => {
    const d = await finalizedChequeDeal("f1a", "OPEN_YEAR");
    await addManager(d.s);
    await d.confirm();
    const [cheque] = await d.cheques();
    await d.giveBack(cheque._id);
    const before = await world(d.s);
    const returnedBefore = (await d.cheques())[0];
    expect(returnedBefore.status).toBe("RETURNED");

    const error = await errorOf(returnFromCollections(d.s, cheque._id, { returnedAt: Date.now() + 9_000, returnReason: "a different reason" }));
    expect(error?.data?.code).toBe("CHEQUE_ALREADY_RETURNED");
    expect(error?.data?.message).toBe(FC_RETURN_MESSAGES.CHEQUE_ALREADY_RETURNED);
    expect(await world(d.s)).toEqual(before);
    const after = (await d.cheques())[0];
    expect(after.returnedAt).toBe(returnedBefore.returnedAt);
    expect(after.returnReason).toBe(returnedBefore.returnReason);
  });

  test("a RETURNED customer cheque is refused a second return: receivable and reminders are untouched", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      const s = await seed("f1b", "OPEN_YEAR");
      const receivableId = await s.owner.as.mutation(api.collections.createReceivable, {
        idempotencyKey: crypto.randomUUID(),
        orgId: s.orgId,
        customerId: s.customerId,
        sourceType: "INTERNAL_INSTALLMENT",
        title: "Returned twice",
        amount: 500,
        dueDate: Date.now() + 7 * 24 * 60 * 60 * 1000,
        creditSystemKey: "MISCELLANEOUS_INCOME",
      });
      const chequeId = await s.owner.as.mutation(api.collections.registerCheque, {
        orgId: s.orgId, receivableId, customerId: s.customerId, bank: "Arab Bank", chequeNumber: "F1B-1",
        chequeDate: Date.now() + 86_400_000, amount: 100,
      });
      await returnFromCollections(s, chequeId, { returnReason: "NSF" });
      const before = await world(s);
      expect(before.reminders.length).toBeGreaterThan(0);
      const error = await errorOf(returnFromCollections(s, chequeId, { returnedAt: Date.now() + 9_000, returnReason: "again" }));
      expect(error?.data?.code).toBe("CHEQUE_ALREADY_RETURNED");
      expect(await world(s)).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  test("(c) HELD and DEPOSITED cheques, finance-company and customer, are still returnable; the other terminal states keep their own coded refusal", async () => {
    for (const status of ["HELD", "DEPOSITED"] as const) {
      const d = await finalizedChequeDeal(`f1c${status}`, "OPEN_YEAR");
      const [cheque] = await d.cheques();
      if (status === "DEPOSITED") await d.s.t.run((ctx) => ctx.db.patch(cheque._id, { status: "DEPOSITED" }));
      await returnFromCollections(d.s, cheque._id, { returnReason: "NSF" });
      expect((await d.cheques())[0]).toMatchObject({ status: "RETURNED", returnReason: "NSF" });
    }
    const d = await finalizedChequeDeal("f1cx", "OPEN_YEAR");
    const [cheque] = await d.cheques();
    await d.s.t.run((ctx) => ctx.db.patch(cheque._id, { status: "CANCELLED" }));
    const error = await errorOf(returnFromCollections(d.s, cheque._id));
    expect(error?.data?.code).toBe("CHEQUE_NOT_RETURNABLE");
    const missing = await errorOf(
      d.s.owner.as.mutation(api.collections.returnCheque, {
        orgId: d.s.orgId,
        chequeId: await d.s.t.run(async (ctx) => {
          const id = await ctx.db.insert("postDatedCheques", {
            orgId: d.s.orgId, customerId: d.s.customerId, bank: "x", chequeNumber: "gone", chequeDate: Date.now(),
            amount: 1, status: "HELD", createdBy: d.s.owner.userId, createdAt: Date.now(), updatedAt: Date.now(),
          });
          await ctx.db.delete(id);
          return id;
        }),
      })
    );
    expect(missing?.data?.code).toBe("CHEQUE_NOT_FOUND");
  });
});

describe("SCRUM-239 F2 - coded refusals in the finance return command", () => {
  const snapshotAll = (d: Awaited<ReturnType<typeof finalizedChequeDeal>>) =>
    d.s.t.run(async (ctx) => ({
      app: await ctx.db.get(d.applicationId),
      cheques: await ctx.db.query("postDatedCheques").collect(),
      payments: await ctx.db.query("canonicalPayments").collect(),
      allocations: await ctx.db.query("paymentAllocations").collect(),
      events: await ctx.db.query("accountingEvents").collect(),
      pending: await ctx.db.query("pendingAccountingEvents").collect(),
      audits: await ctx.db.query("financialAuditLog").collect(),
      idempotency: await ctx.db.query("commandIdempotency").collect(),
    }));

  test("the same key with a different reason is refused with FINANCE_RETURN_KEY_CONFLICT and writes nothing", async () => {
    const d = await finalizedChequeDeal("f2a", "OPEN_YEAR");
    await d.confirm();
    const [cheque] = await d.cheques();
    const key = crypto.randomUUID();
    await d.giveBack(cheque._id, { key });
    const before = await snapshotAll(d);
    const error = await d.giveBack(cheque._id, { key, reason: "a different reason" }).then(() => null, (e: unknown) => e as { data?: { code?: string; message?: string } });
    expect(error?.data?.code).toBe("FINANCE_RETURN_KEY_CONFLICT");
    expect(error?.data?.message).toBe(FC_RETURN_MESSAGES.FINANCE_RETURN_KEY_CONFLICT);
    expect(await snapshotAll(d)).toEqual(before);
  });

  test("a wrong-organisation application and a wrong-organisation cheque both answer FINANCE_RETURN_NOT_FOUND, exactly like a missing row", async () => {
    const d = await finalizedChequeDeal("f2b", "OPEN_YEAR");
    await d.confirm();
    const [cheque] = await d.cheques();
    const other = await seed("f2c", "NONE");
    const foreignCheque = await other.t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId: other.orgId, customerId: other.customerId, bank: "x", chequeNumber: "foreign", chequeDate: Date.now(),
        amount: 1, status: "CLEARED", createdBy: other.owner.userId, createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    const before = await snapshotAll(d);
    // The caller belongs to the other organisation but names this deal.
    expect(
      await refusalCode(
        other.owner.as.mutation(api.applications.returnFinanceDisbursementCheque, {
          orgId: other.orgId, applicationId: d.applicationId, chequeId: cheque._id, returnReason: "x", idempotencyKey: crypto.randomUUID(),
        })
      )
    ).toBe("FINANCE_RETURN_NOT_FOUND");
    // The caller owns the deal but names another organisation's cheque.
    expect(await refusalCode(d.giveBack(foreignCheque as never))).toBe("FINANCE_RETURN_NOT_FOUND");
    expect(await snapshotAll(d)).toEqual(before);
  });

  test("every new refusal renders its Arabic text in the AR locale and its English text in EN", () => {
    const codes = [
      "FINANCE_RETURN_NOT_FOUND",
      "FINANCE_RETURN_KEY_CONFLICT",
      "CHEQUE_ALREADY_RETURNED",
      "CHEQUE_NOT_RETURNABLE",
      "CHEQUE_NOT_FOUND",
    ] as const;
    for (const code of codes) {
      const error = new ConvexError({ code, message: (FC_RETURN_MESSAGES as Record<string, string>)[code] });
      const en = getLocalizedErrorMessage(error, (k) => (salesEn as Record<string, string>)[k] ?? k);
      const ar = getLocalizedErrorMessage(error, (k) => (salesAr as Record<string, string>)[k] ?? k);
      expect(en, code).toBe((FC_RETURN_MESSAGES as Record<string, string>)[code]);
      expect(ar, code).toMatch(/[\u0600-\u06FF]/);
      expect(ar, code).not.toBe(en);
      expect(ar, code).toContain("لم يتم تغيير أي شيء");
    }
  });
});

describe("SCRUM-239 F4 - audit: a RETURNED stamped cheque whose payment row is missing is a finding", () => {
  test("a missing canonical payment is RETURN_DISBURSEMENT_NOT_UNDONE, not silently accepted", async () => {
    const d = await finalizedChequeDeal("f4a", "OPEN_YEAR");
    await d.confirm();
    const [cheque] = await d.cheques();
    await d.giveBack(cheque._id);
    const clean = await d.s.owner.as.query(api.chequeLineageAudit.auditFinanceCompanyCheques, { orgId: d.s.orgId, paginationOpts: { numItems: 100, cursor: null } });
    expect(clean.findings.filter((f) => f.chequeId === cheque._id)).toEqual([]);

    const keys = financeDisbursementKeys(d.applicationId, 1);
    await d.s.t.run(async (ctx) => {
      const payment = await ctx.db
        .query("canonicalPayments")
        .withIndex("by_org_idempotency", (q) => q.eq("orgId", d.s.orgId).eq("idempotencyKey", keys.paymentKey))
        .unique();
      await ctx.db.delete(payment!._id);
    });
    const report = await d.s.owner.as.query(api.chequeLineageAudit.auditFinanceCompanyCheques, { orgId: d.s.orgId, paginationOpts: { numItems: 100, cursor: null } });
    const mine = report.findings.filter((f) => f.chequeId === cheque._id);
    expect(mine.map((f) => [f.class, f.verdict])).toContainEqual(["RETURN_DISBURSEMENT_NOT_UNDONE", "FINDING"]);
  });
});

describe("SCRUM-239 round 2 - stale confirm key, coded return refusals", () => {
  const confirmWith = (d: Awaited<ReturnType<typeof finalizedChequeDeal>>, key: string, expected?: number) =>
    d.s.owner.as.mutation(api.applications.confirmDisbursement, {
      orgId: d.s.orgId, applicationId: d.applicationId, disbursedAmountMinor: G, idempotencyKey: key,
      ...(expected !== undefined ? { expectedDisbursementVersion: expected } : {}),
    });
  const confirmRow = (s: Seeded, key: string) =>
    s.t.run((ctx) =>
      ctx.db.query("commandIdempotency").withIndex("by_org_operation_key", (q) =>
        q.eq("orgId", s.orgId).eq("operation", "applications.confirmDisbursement").eq("idempotencyKey", key)
      ).unique()
    );
  const errOf = (promise: Promise<unknown>) =>
    promise.then(() => null, (e: unknown) => e as { data?: { code?: string; message?: string } });

  test("F1: a confirm key from version 1 cannot replay after a return; a fresh key books exactly one v2 payment and event", async () => {
    const d = await finalizedChequeDeal("r2a", "OPEN_YEAR");
    const { s, applicationId } = d;
    const keyK = "confirm-disbursement:stale-K";
    await confirmWith(d, keyK);
    const [first] = await d.cheques();
    await d.giveBack(first._id);
    await s.owner.as.mutation(api.applications.correctExpectedPayment, { orgId: s.orgId, applicationId, reason: "Bank returned the cheque" });
    await d.registerCheque("CHQ-239-2");

    const v1 = financeDisbursementKeys(applicationId, 1);
    const v2 = financeDisbursementKeys(applicationId, 2);
    const before = await s.t.run(async (ctx) => ({
      app: await ctx.db.get(applicationId),
      payments: await ctx.db.query("canonicalPayments").collect(),
      allocations: await ctx.db.query("paymentAllocations").collect(),
      events: await ctx.db.query("accountingEvents").collect(),
    }));
    const error = await errOf(confirmWith(d, keyK));
    expect(error?.data?.code).toBe("FINANCE_CONFIRM_STALE_REQUEST");
    expect(await paymentByKey(s, v2.paymentKey)).toBeNull();
    expect((await paymentByKey(s, v1.paymentKey))?.status).toBe("VOIDED");
    expect(await s.t.run(async (ctx) => ({
      app: await ctx.db.get(applicationId),
      payments: await ctx.db.query("canonicalPayments").collect(),
      allocations: await ctx.db.query("paymentAllocations").collect(),
      events: await ctx.db.query("accountingEvents").collect(),
    }))).toEqual(before);

    await confirmWith(d, "confirm-disbursement:fresh", 2);
    expect((await paymentByKey(s, v2.paymentKey))?.status).toBe("SETTLED");
    expect((await cashEvents(s)).map((e) => [e.eventVersion, e.status])).toEqual([[1, "REVERSED"], [2, "POSTED"]]);
  });

  test("F1 (c): a same-version replay of the key before any return still dedupes to one payment and one event", async () => {
    const d = await finalizedChequeDeal("r2b", "OPEN_YEAR");
    const { s, applicationId } = d;
    const keyK = "confirm-disbursement:same-version";
    const first = await confirmWith(d, keyK);
    const second = await confirmWith(d, keyK);
    expect(second).toEqual(first);
    expect(await s.t.run((ctx) => ctx.db.query("canonicalPayments").collect())).toHaveLength(1);
    expect(await cashEvents(s)).toHaveLength(1);
    expect(((await d.app())!).disbursementVersion ?? 1).toBe(1);
    void applicationId;
  });

  test("F1: at version 1 the stored fingerprint is byte-identical to the historical shape", async () => {
    const d = await finalizedChequeDeal("r2c", "OPEN_YEAR");
    const keyK = "confirm-disbursement:fp";
    await confirmWith(d, keyK);
    const row = await confirmRow(d.s, keyK);
    expect(row?.fingerprint).toBe(JSON.stringify({ applicationId: d.applicationId, disbursedAmountMinor: G }));
  });

  test("F3b: an empty or over-long key on the finance return is refused with FINANCE_RETURN_KEY_INVALID, nothing written; default messages unchanged elsewhere", async () => {
    const d = await finalizedChequeDeal("r2d", "OPEN_YEAR");
    await d.confirm();
    const [cheque] = await d.cheques();
    const before = await d.s.t.run(async (ctx) => ({
      cheques: await ctx.db.query("postDatedCheques").collect(),
      idem: await ctx.db.query("commandIdempotency").collect(),
    }));
    for (const key of ["", "   ", "k".repeat(201)]) {
      const error = await errOf(d.giveBack(cheque._id, { key }));
      expect(error?.data?.code, JSON.stringify(key.slice(0, 5))).toBe("FINANCE_RETURN_KEY_INVALID");
    }
    expect(await d.s.t.run(async (ctx) => ({
      cheques: await ctx.db.query("postDatedCheques").collect(),
      idem: await ctx.db.query("commandIdempotency").collect(),
    }))).toEqual(before);
    // 200 characters is the limit and is accepted.
    await d.giveBack(cheque._id, { key: "k".repeat(200) });
  });

  test("F3a: returnClearedCheque answers CHEQUE_NOT_FOUND / CHEQUE_NOT_CLEARED with codes, keeping the old sentence", async () => {
    const d = await finalizedChequeDeal("r2e", "OPEN_YEAR");
    const [held] = await d.cheques();
    const other = await seed("r2f", "NONE");
    const foreign = await other.t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId: other.orgId, customerId: other.customerId, bank: "x", chequeNumber: "foreign", chequeDate: Date.now(),
        amount: 1, status: "CLEARED", createdBy: other.owner.userId, createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    const ret = (chequeId: Id<"postDatedCheques">) =>
      errOf(d.s.owner.as.mutation(api.collections.returnClearedCheque, { orgId: d.s.orgId, chequeId, idempotencyKey: crypto.randomUUID() }));
    const notCleared = await ret(held._id);
    expect(notCleared?.data?.code).toBe("CHEQUE_NOT_CLEARED");
    expect(notCleared?.data?.message).toContain("Only cleared cheques can be returned after clearing");
    expect((await ret(foreign))?.data?.code).toBe("CHEQUE_NOT_FOUND");
  });

  test("new refusals have EN and AR text", () => {
    for (const code of ["FINANCE_CONFIRM_STALE_REQUEST", "FINANCE_RETURN_KEY_INVALID", "CHEQUE_NOT_CLEARED"] as const) {
      const en = (salesEn as Record<string, string>)[`ServerError_${code}`];
      const ar = (salesAr as Record<string, string>)[`ServerError_${code}`];
      expect(en, code).toBe((FC_RETURN_MESSAGES as Record<string, string>)[code]);
      expect(ar, code).toMatch(/[\u0600-\u06FF]/);
      expect(ar, code).toContain("لم يتم تغيير أي شيء");
      expect(en, code).toContain("Nothing has been changed.");
    }
  });
});

describe("SCRUM-239 round 3 - a confirm is bound to the version the confirmer observed", () => {
  type Deal = Awaited<ReturnType<typeof finalizedChequeDeal>>;
  const confirmWith = (d: Deal, key: string, expected?: number) =>
    d.s.owner.as.mutation(api.applications.confirmDisbursement, {
      orgId: d.s.orgId, applicationId: d.applicationId, disbursedAmountMinor: G, idempotencyKey: key,
      ...(expected !== undefined ? { expectedDisbursementVersion: expected } : {}),
    });
  const errOf = (promise: Promise<unknown>) =>
    promise.then(() => null, (e: unknown) => e as { data?: { code?: string; message?: string } });
  const world = (d: Deal) =>
    d.s.t.run(async (ctx) => ({
      app: await ctx.db.get(d.applicationId),
      cheques: await ctx.db.query("postDatedCheques").collect(),
      payments: await ctx.db.query("canonicalPayments").collect(),
      allocations: await ctx.db.query("paymentAllocations").collect(),
      events: await ctx.db.query("accountingEvents").collect(),
      idempotency: await ctx.db.query("commandIdempotency").collect(),
    }));
  /** Confirm v1, return it, and register a same-face replacement: the application is at version 2. */
  const atVersionTwo = async (tag: string) => {
    const d = await finalizedChequeDeal(tag, "OPEN_YEAR");
    await d.confirm();
    const [first] = await d.cheques();
    await d.giveBack(first._id);
    await d.s.owner.as.mutation(api.applications.correctExpectedPayment, { orgId: d.s.orgId, applicationId: d.applicationId, reason: "Bank returned the cheque" });
    await d.registerCheque("CHQ-239-2");
    return d;
  };

  test("R1: a FRESH key from a version-1 screen cannot confirm the version-2 replacement; expected 2 books exactly one payment and event", async () => {
    const d = await atVersionTwo("r3a");
    const { s, applicationId } = d;
    const v2 = financeDisbursementKeys(applicationId, 2);
    const before = await world(d);
    const error = await errOf(confirmWith(d, "confirm-disbursement:fresh-from-stale-screen", 1));
    expect(error?.data?.code).toBe("FINANCE_CONFIRM_STALE_REQUEST");
    expect(await world(d)).toEqual(before);
    expect(await paymentByKey(s, v2.paymentKey)).toBeNull();
    expect((await cashEvents(s)).map((e) => [e.eventVersion, e.status])).toEqual([[1, "REVERSED"]]);
    const replacement = (await d.cheques())[1];
    expect(replacement.status).toBe("HELD");
    expect(((await d.app())!).disbursedAt).toBeUndefined();

    await confirmWith(d, "confirm-disbursement:fresh-observed-v2", 2);
    expect((await paymentByKey(s, v2.paymentKey))?.status).toBe("SETTLED");
    expect((await s.t.run((ctx) => ctx.db.query("canonicalPayments").collect())).filter((p) => p.idempotencyKey === v2.paymentKey)).toHaveLength(1);
    expect((await cashEvents(s)).map((e) => [e.eventVersion, e.status])).toEqual([[1, "REVERSED"], [2, "POSTED"]]);
  });

  test("R1: a legacy client with no expected version cannot confirm at version 2, and nothing is written", async () => {
    const d = await atVersionTwo("r3b");
    const before = await world(d);
    expect((await errOf(confirmWith(d, "confirm-disbursement:legacy-at-v2")))?.data?.code).toBe("FINANCE_CONFIRM_STALE_REQUEST");
    expect(await world(d)).toEqual(before);
  });

  test("R1: at version 1 a legacy client with no expected version still confirms", async () => {
    const d = await finalizedChequeDeal("r3c", "OPEN_YEAR");
    await confirmWith(d, "confirm-disbursement:legacy-v1");
    expect(((await d.app())!).disbursedAt).toBeGreaterThan(0);
    expect(await cashEvents(d.s)).toHaveLength(1);
  });

  test("R1: v2 -> v3: a confirmer that observed version 2 cannot confirm the version-3 replacement", async () => {
    const d = await atVersionTwo("r3d");
    await confirmWith(d, "confirm-disbursement:v2", 2);
    const cheques = await d.cheques();
    await d.giveBack(cheques[1]._id, { reason: "Returned again" });
    await d.s.owner.as.mutation(api.applications.correctExpectedPayment, { orgId: d.s.orgId, applicationId: d.applicationId, reason: "Bank returned the cheque again" });
    await d.registerCheque("CHQ-239-3");
    expect(((await d.app())!).disbursementVersion).toBe(3);
    const before = await world(d);
    expect((await errOf(confirmWith(d, "confirm-disbursement:stale-v2", 2)))?.data?.code).toBe("FINANCE_CONFIRM_STALE_REQUEST");
    expect(await world(d)).toEqual(before);
    await confirmWith(d, "confirm-disbursement:observed-v3", 3);
    expect((await cashEvents(d.s)).map((e) => [e.eventVersion, e.status])).toEqual([[1, "REVERSED"], [2, "REVERSED"], [3, "POSTED"]]);
  });

  test("R1: a same-version retry of one key with the expected version still dedupes to one payment", async () => {
    const d = await finalizedChequeDeal("r3e", "OPEN_YEAR");
    const first = await confirmWith(d, "confirm-disbursement:retry", 1);
    const second = await confirmWith(d, "confirm-disbursement:retry", 1);
    expect(second).toEqual(first);
    expect(await d.s.t.run((ctx) => ctx.db.query("canonicalPayments").collect())).toHaveLength(1);
    expect(await cashEvents(d.s)).toHaveLength(1);
  });

  test("R1: the expected version is not part of the fingerprint (version 1 stays byte-identical)", async () => {
    const d = await finalizedChequeDeal("r3f", "OPEN_YEAR");
    await confirmWith(d, "confirm-disbursement:fp-expected", 1);
    const row = await d.s.t.run((ctx) =>
      ctx.db.query("commandIdempotency").withIndex("by_org_operation_key", (q) =>
        q.eq("orgId", d.s.orgId).eq("operation", "applications.confirmDisbursement").eq("idempotencyKey", "confirm-disbursement:fp-expected")
      ).unique()
    );
    expect(row?.fingerprint).toBe(JSON.stringify({ applicationId: d.applicationId, disbursedAmountMinor: G }));
  });

  test("tenant: an expected version for another organisation's application answers the ordinary not-found refusal, never STALE", async () => {
    const d = await atVersionTwo("r3g");
    const other = await seed("r3h", "NONE");
    const before = await world(d);
    const error = await errOf(
      other.owner.as.mutation(api.applications.confirmDisbursement, {
        orgId: other.orgId, applicationId: d.applicationId, disbursedAmountMinor: G,
        idempotencyKey: crypto.randomUUID(), expectedDisbursementVersion: 1,
      })
    );
    expect(error?.data?.code).not.toBe("FINANCE_CONFIRM_STALE_REQUEST");
    expect(String((error as unknown as Error)?.message)).toContain("Application not found.");
    expect(await world(d)).toEqual(before);
  });
});

describe("SCRUM-239 round 3 - every reachable confirm-after-return refusal is coded", () => {
  type Deal = Awaited<ReturnType<typeof finalizedChequeDeal>>;
  const errOf = (promise: Promise<unknown>) =>
    promise.then(() => null, (e: unknown) => e as { data?: { code?: string; message?: string } });
  const world = (d: Deal) =>
    d.s.t.run(async (ctx) => ({
      app: await ctx.db.get(d.applicationId),
      cheques: await ctx.db.query("postDatedCheques").collect(),
      payments: await ctx.db.query("canonicalPayments").collect(),
      events: await ctx.db.query("accountingEvents").collect(),
    }));
  const expectRefusal = async (d: Deal, code: string, expected?: number) => {
    const before = await world(d);
    const error = await errOf(d.confirm(expected));
    expect(error?.data?.code).toBe(code);
    expect(error?.data?.message).toBe((FC_RETURN_MESSAGES as Record<string, string>)[code]);
    expect(await world(d)).toEqual(before);
  };

  test("a second confirmation of an already-confirmed application: FINANCE_CONFIRM_ALREADY_CONFIRMED", async () => {
    const d = await finalizedChequeDeal("c3a", "OPEN_YEAR");
    await d.confirm();
    await expectRefusal(d, "FINANCE_CONFIRM_ALREADY_CONFIRMED");
  });

  test("a cleared-but-unconfirmed linked cheque: FINANCE_CONFIRM_CHEQUE_ALREADY_CLEARED", async () => {
    const d = await finalizedChequeDeal("c3b", "OPEN_YEAR");
    const [cheque] = await d.cheques();
    await d.s.t.run((ctx) => ctx.db.patch(cheque._id, { status: "CLEARED" }));
    await expectRefusal(d, "FINANCE_CONFIRM_CHEQUE_ALREADY_CLEARED");
  });

  test("only a returned cheque remains: FINANCE_CONFIRM_CHEQUE_RETURNED_OR_CANCELLED", async () => {
    const d = await finalizedChequeDeal("c3c", "OPEN_YEAR");
    await d.confirm();
    const [cheque] = await d.cheques();
    await d.giveBack(cheque._id);
    await expectRefusal(d, "FINANCE_CONFIRM_CHEQUE_RETURNED_OR_CANCELLED", 2);
  });

  test("no cheque row at all: FINANCE_CONFIRM_CHEQUE_NOT_FOUND", async () => {
    const d = await finalizedChequeDeal("c3d", "OPEN_YEAR");
    const [cheque] = await d.cheques();
    await d.s.t.run((ctx) => ctx.db.delete(cheque._id));
    await expectRefusal(d, "FINANCE_CONFIRM_CHEQUE_NOT_FOUND");
  });

  test("two live cheques: FINANCE_CONFIRM_MULTIPLE_LIVE_CHEQUES", async () => {
    const d = await finalizedChequeDeal("c3e", "OPEN_YEAR");
    const [cheque] = await d.cheques();
    await d.s.t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = cheque;
      void _id; void _creationTime;
      await ctx.db.insert("postDatedCheques", { ...rest, chequeNumber: "CHQ-239-DUP" });
    });
    await expectRefusal(d, "FINANCE_CONFIRM_MULTIPLE_LIVE_CHEQUES");
  });

  test("a cheque whose face was never recorded: FINANCE_CONFIRM_CHEQUE_FACE_UNRECORDED", async () => {
    const d = await finalizedChequeDeal("c3f", "OPEN_YEAR");
    const [cheque] = await d.cheques();
    await d.s.t.run((ctx) => ctx.db.patch(cheque._id, { amountMinor: undefined }));
    await expectRefusal(d, "FINANCE_CONFIRM_CHEQUE_FACE_UNRECORDED");
  });

  test("a cheque whose face differs from the receipt: FINANCE_CONFIRM_CHEQUE_FACE_MISMATCH", async () => {
    const d = await finalizedChequeDeal("c3g", "OPEN_YEAR");
    const [cheque] = await d.cheques();
    await d.s.t.run((ctx) => ctx.db.patch(cheque._id, { amountMinor: G + 1 }));
    await expectRefusal(d, "FINANCE_CONFIRM_CHEQUE_FACE_MISMATCH");
  });

  test("returnClearedCheque: a fresh-body reuse of a key is the coded FINANCE_RETURN_KEY_CONFLICT; a bad bank fee is CHEQUE_BANK_FEE_INVALID", async () => {
    const d = await finalizedChequeDeal("c3h", "OPEN_YEAR");
    const [cheque] = await d.cheques();
    const call = (extra: Record<string, unknown>, key = crypto.randomUUID()) =>
      errOf(d.s.owner.as.mutation(api.collections.returnClearedCheque, { orgId: d.s.orgId, chequeId: cheque._id, idempotencyKey: key, ...extra }));
    expect((await call({ bankFeeMinor: -1 }))?.data?.code).toBe("CHEQUE_BANK_FEE_INVALID");
    expect((await call({ bankFeeMinor: 1.5 }))?.data?.code).toBe("CHEQUE_BANK_FEE_INVALID");
    // Same key, different content: the conflict needs a stored row, so seed one.
    const key = crypto.randomUUID();
    await d.s.t.run(async (ctx) => {
      await ctx.db.insert("commandIdempotency", {
        orgId: d.s.orgId, operation: "collections.returnClearedCheque", idempotencyKey: key,
        fingerprint: "{\"different\":true}", status: "COMPLETED", createdBy: d.s.owner.userId, createdAt: Date.now(),
      });
    });
    const conflict = await call({}, key);
    expect(conflict?.data?.code).toBe("FINANCE_RETURN_KEY_CONFLICT");
  });

  test("every new confirm/return refusal has EN text equal to the server text, AR text, and the nothing-changed sentence", () => {
    for (const code of [
      "FINANCE_CONFIRM_ALREADY_CONFIRMED", "FINANCE_CONFIRM_CHEQUE_ALREADY_CLEARED", "FINANCE_CONFIRM_CHEQUE_RETURNED_OR_CANCELLED",
      "FINANCE_CONFIRM_CHEQUE_NOT_FOUND", "FINANCE_CONFIRM_MULTIPLE_LIVE_CHEQUES", "FINANCE_CONFIRM_CHEQUE_FACE_UNRECORDED",
      "FINANCE_CONFIRM_CHEQUE_FACE_MISMATCH", "CHEQUE_BANK_FEE_INVALID", "CHEQUE_RETURN_NO_RECEIPT_LINEAGE", "CHEQUE_RETURN_NO_PAYMENT_TO_REVERSE",
    ] as const) {
      const error = new ConvexError({ code, message: FC_RETURN_MESSAGES[code] });
      const en = getLocalizedErrorMessage(error, (k) => (salesEn as Record<string, string>)[k] ?? k);
      const ar = getLocalizedErrorMessage(error, (k) => (salesAr as Record<string, string>)[k] ?? k);
      expect(en, code).toBe(FC_RETURN_MESSAGES[code]);
      expect(ar, code).toMatch(/[\u0600-\u06FF]/);
      expect(ar, code).toContain("لم يتم تغيير أي شيء");
    }
  });
});
