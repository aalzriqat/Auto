/**
 * SCRUM-571 ruling 10 (owner ruling c23812 on SCRUM-760, recorded as SCRUM-571 comment 23824): an uncollectable
 * financed-customer gap invoice is not acceptable. No certified door applies a customer's payment to a sale invoice
 * (SCRUM-722/723/724 are dark), so a FINANCED deal whose customer still owes the dealership a gap R must refuse at the
 * completion door, before the first write, instead of creating an invoice nobody can collect. It must not enable any
 * receipt or application door.
 *
 * Worked figures (JOD, 3 decimals, minor units; never read back from the code under test). The fixture company lends
 * 85%: a 12,500 quotation approved at 11,500 leaves a net shortfall of 850 that the approver splits.
 *   gap R = cash to the dealership + instalments to the dealership        (the customer's debt to the dealer)
 *   customer pays the finance company, or the dealer absorbs the rest     (never a dealer receivable)
 * Only R > 0 refuses. A deposit does not pay R: on a plan-governed sale the deposit is forwarded to the finance
 * company and is never allocated to the customer invoice.
 *
 * Evidence boundary: convex-test only (no OCC, not the Convex runtime, not production data).
 */
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { registerHandover } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import {
  finalizeAsOwner, newApplication, payForwardAsOwner, readyDeal, refusalDataOf, seedFinancedDealership,
} from "../test-utils/financedDealFixture";
import { getReceivableOutstandingMinor } from "./subledger";
import {
  assertFinancedCustomerGapCollectable,
  assertFinancedInvoiceFullyPaid,
} from "./utils/financedGapPilotGate";
import { FINANCED_CUSTOMER_GAP_COLLECTION_PILOT_REQUIRED } from "./utils/financedGapPilotSwitch";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");
const jod = (major: number) => major * 1_000;
const REFUSAL_CODE = "FINANCED_CUSTOMER_GAP_UNCOLLECTABLE_REFUSED";

const ALL_PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "manage:supplier_settlement", "cancel:closed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:reports", "manage:settings",
];

async function seed(tag: string) {
  const s = await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMS, label: "S571G", vinPrefix: "VIN571G", actors: {},
  });
  // The fixture company lends 100%, which leaves the showroom nothing to contribute.
  await s.t.run((ctx) => ctx.db.patch(s.companyId, { defaultLtvPercent: 85 }));
  return s;
}
type Seeded = Awaited<ReturnType<typeof seed>>;
type AppId = Id<"financeApplications">;

/** How the 850 shortfall is shared, in minor units. customer = cash + instalment + financeCompany. */
type Split = { customer: number; dealer: number; cash: number; installment: number; financeCompany: number };

async function appOf(s: Seeded, applicationId: AppId) {
  return await s.t.run((ctx) => ctx.db.get(applicationId));
}

/** Approved at 11,500 against a 12,500 quotation (shortfall 850), the split agreed, the vehicle handed over. */
async function resolvedDeal(s: Seeded, split: Split): Promise<AppId> {
  const { owner, approver, orgId } = s;
  const { applicationId } = await newApplication(s);
  await owner.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
  await approver.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
  await owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId, applicationId, submittedQuotationMinor: jod(12_500), source: "MANUAL_ENTRY", customerFirstPaymentMinor: jod(500),
  });
  await approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId, applicationId, approvedAmountMinor: jod(11_500), basis: "MANUAL", notes: "Approved below the quotation.",
  });
  expect((await appOf(s, applicationId))?.netShortfallMinor).toBe(jod(850));
  const served = await approver.as.query(api.applications.get, { orgId, applicationId });
  await approver.as.mutation(api.financingEconomics.resolveAppraisalGap, {
    orgId, applicationId, economicsStamp: served!.economicsStamp as string,
    customerGapShareMinor: split.customer,
    dealerGapShareMinor: split.dealer,
    customerGapCashToDealerMinor: split.cash,
    customerGapInstallmentToDealerMinor: split.installment,
    customerGapToFinanceCompanyMinor: split.financeCompany,
  });
  await registerHandover(owner.as, api, orgId, applicationId);
  await owner.as.mutation(api.applications.registerExpectedPayment, {
    orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  const feeId = await owner.as.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(), orgId, applicationId,
    feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER", accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false, actualAmountMinor: 0, description: "No closing costs.",
  });
  await owner.as.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId, feeId, notes: "Matched.", expectedActualAmountMinor: 0, expectedActualEvidenceRevision: 0,
  });
  return applicationId;
}

/** Records the customer's payment to the finance company as confirmed evidence, as the approver. */
function confirmFinanceCompanyPayment(s: Seeded, applicationId: AppId, amountMinor: number) {
  return s.approver.as.mutation(api.customerFinanceCompanyPayments.confirmPayment, {
    orgId: s.orgId, applicationId, amountMinor, paidAt: Date.now() - 1_000, reference: "TRF-571",
    idempotencyKey: crypto.randomUUID(),
  });
}

const finalizeKeyed = (s: Pick<Seeded, "owner" | "orgId">, applicationId: AppId, idempotencyKey: string) =>
  s.owner.as.mutation(api.applications.finalizeDeal, { idempotencyKey, orgId: s.orgId, applicationId });

const everyTable = (s: Pick<Seeded, "t">) => dbSnapshot(s.t, Object.keys(schema.tables));

/** The refusal's code, or a loud marker when the call was accepted. */
async function refusedWithCode(promise: Promise<unknown>): Promise<string> {
  const refusal = await refusalDataOf(promise);
  return refusal === null ? "<<ACCEPTED - NO REFUSAL>>" : (refusal.code ?? `<<NO CODE: ${refusal.message}>>`);
}

/** Finalizes a deal that must refuse, and proves the refusal wrote nothing in any table of any tenant. */
async function expectGapRefusalWithZeroWrites(s: Seeded, applicationId: AppId) {
  const before = await everyTable(s);
  expect(before.sales ?? []).toHaveLength(0);
  const refusal = await refusalDataOf(finalizeKeyed(s, applicationId, crypto.randomUUID()));
  expect(refusal?.code).toBe(REFUSAL_CODE);
  expect(refusal?.message).toContain("Nothing has been changed");
  expect(await everyTable(s)).toEqual(before);
  const app = await appOf(s, applicationId);
  expect(app?.status).toBe("APPROVED");
  expect(app?.finalizedSaleId).toBeUndefined();
}

async function invoiceOf(s: Seeded, applicationId: AppId) {
  return await s.t.run(async (ctx) => {
    const app = (await ctx.db.get(applicationId))!;
    const sale = (await ctx.db.get(app.finalizedSaleId!))!;
    const doc = (await ctx.db.get(sale.canonicalReceivableDocumentId!))!;
    return { saleId: sale._id, doc, outstandingMinor: await getReceivableOutstandingMinor(ctx, doc._id) };
  });
}

describe("SCRUM-571 ruling 10: a financed deal whose customer still owes the dealership a gap refuses at finalize", () => {
  test.each([
    { name: "a cash gap of 850 owed to the dealership", tag: "cash", split: { customer: jod(850), dealer: 0, cash: jod(850), installment: 0, financeCompany: 0 }, fcPaid: 0 },
    { name: "an instalment gap counts exactly like a cash gap", tag: "inst", split: { customer: jod(850), dealer: 0, cash: 0, installment: jod(850), financeCompany: 0 }, fcPaid: 0 },
    { name: "a mixed share (200 cash to the dealership, 400 confirmed to the finance company): the 200 still refuses", tag: "mixed", split: { customer: jod(600), dealer: jod(250), cash: jod(200), installment: 0, financeCompany: jod(400) }, fcPaid: jod(400) },
    { name: "the smallest gap, one minor unit (no rounding or tolerance)", tag: "one", split: { customer: 1, dealer: jod(850) - 1, cash: 1, installment: 0, financeCompany: 0 }, fcPaid: 0 },
  ])("$name: refused, zero writes", async ({ tag, split, fcPaid }) => {
    const s = await seed(tag);
    const applicationId = await resolvedDeal(s, split);
    if (fcPaid > 0) await confirmFinanceCompanyPayment(s, applicationId, fcPaid);
    await expectGapRefusalWithZeroWrites(s, applicationId);
  });
  test("the refusal leaves no idempotency claim behind: the same key refuses again, identically, and writes nothing", async () => {
    const s = await seed("again");
    const applicationId = await resolvedDeal(s, { customer: jod(850), dealer: 0, cash: jod(850), installment: 0, financeCompany: 0 });
    const key = crypto.randomUUID();
    const before = await everyTable(s);
    expect(await refusedWithCode(finalizeKeyed(s, applicationId, key))).toBe(REFUSAL_CODE);
    expect(await refusedWithCode(finalizeKeyed(s, applicationId, key))).toBe(REFUSAL_CODE);
    expect(await everyTable(s)).toEqual(before);
  });
});

describe("SCRUM-571 ruling 10: a held deposit does not pay the gap, and the refusal precedes the forward payment", () => {
  // readyDeal holds a deposit H of 200 and a contribution C of 1,375, and records the gap R on the application.
  test("R = 500 with a deposit held: refused before the finance-company forward is paid, and after it", async () => {
    const s = await seedFinancedDealership("dep", {
      modules: MODULES, ownerPerms: ALL_PERMS, label: "S571G", vinPrefix: "VIN571G", actors: {},
    });
    const { applicationId } = await readyDeal(s, { gapMinor: 500_000 });

    // Forward not yet paid: the gap refusal comes first, so the operator is not asked to pay the company first.
    const unpaid = await everyTable(s);
    expect(await refusedWithCode(finalizeKeyed(s, applicationId, crypto.randomUUID()))).toBe(REFUSAL_CODE);
    expect(await everyTable(s)).toEqual(unpaid);

    // Forward paid: still refused, the deposit having been forwarded to the company and never to the invoice.
    await payForwardAsOwner(s, applicationId);
    const paid = await everyTable(s);
    expect(await refusedWithCode(finalizeKeyed(s, applicationId, crypto.randomUUID()))).toBe(REFUSAL_CODE);
    expect(await everyTable(s)).toEqual(paid);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("APPROVED");
  });
});

describe("SCRUM-571 ruling 10: controls - a deal whose customer owes the dealership nothing still closes", () => {
  test("dealer absorbs the whole shortfall (R = 0): closes, and the customer invoice is a paid zero-value invoice", async () => {
    const s = await seed("absorb");
    const applicationId = await resolvedDeal(s, { customer: 0, dealer: jod(850), cash: 0, installment: 0, financeCompany: 0 });
    await finalizeAsOwner(s, applicationId);
    expect((await appOf(s, applicationId))?.status).toBe("CLOSED");
    const invoice = await invoiceOf(s, applicationId);
    expect(invoice.doc.originalAmountMinor).toBe(0);
    expect(invoice.doc.status).toBe("PAID");
    expect(invoice.outstandingMinor).toBe(0);
  });

  test("the whole customer share is paid to the finance company and confirmed (R = 0): closes with nothing outstanding", async () => {
    const s = await seed("fc");
    const applicationId = await resolvedDeal(s, { customer: jod(400), dealer: jod(450), cash: 0, installment: 0, financeCompany: jod(400) });
    await confirmFinanceCompanyPayment(s, applicationId, jod(400));
    await finalizeAsOwner(s, applicationId);
    expect((await appOf(s, applicationId))?.status).toBe("CLOSED");
    expect((await invoiceOf(s, applicationId)).outstandingMinor).toBe(0);
  });

  test("a deal with no shortfall at all (approved at the quotation) closes", async () => {
    const s = await seedFinancedDealership("flat", {
      modules: MODULES, ownerPerms: ALL_PERMS, label: "S571G", vinPrefix: "VIN571G", actors: {},
    });
    const { applicationId } = await readyDeal(s, { deposit: false });
    await finalizeAsOwner(s, applicationId);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");
  });

  test("replaying a finalize that already closed returns the same sale and is never refused afterwards", async () => {
    const s = await seed("replay");
    const applicationId = await resolvedDeal(s, { customer: 0, dealer: jod(850), cash: 0, installment: 0, financeCompany: 0 });
    const key = crypto.randomUUID();
    await payForwardAsOwner(s, applicationId);
    const first = await finalizeKeyed(s, applicationId, key);
    // A deal that closed before this ruling may carry a gap. Simulate that stored state on the CLOSED application.
    await s.t.run((ctx) => ctx.db.patch(applicationId, { customerGapCashToDealerMinor: jod(200) }));
    expect(await finalizeKeyed(s, applicationId, key)).toBe(first);
    expect(await finalizeKeyed(s, applicationId, crypto.randomUUID())).toBe(first);
  });

  test("the readiness read still answers for a deal that finalize will refuse (the gate is not inside the read path)", async () => {
    const s = await seed("read");
    const applicationId = await resolvedDeal(s, { customer: jod(850), dealer: 0, cash: jod(850), installment: 0, financeCompany: 0 });
    const readiness = await s.owner.as.query(api.applications.getClosingReadiness, { orgId: s.orgId, applicationId });
    expect(Array.isArray(readiness.checks)).toBe(true);
  });
});

describe("SCRUM-571 ruling 10: the gate itself", () => {
  test("the switch is on, and it is a compile-time constant", () => {
    expect(FINANCED_CUSTOMER_GAP_COLLECTION_PILOT_REQUIRED).toBe(true);
  });

  test("the pure rule: only a positive gap refuses; zero and an absent plan (cash, consigned) do not", () => {
    expect(() => assertFinancedCustomerGapCollectable({ customerReceivableMinor: 1 })).toThrow();
    expect(() => assertFinancedCustomerGapCollectable({ customerReceivableMinor: jod(200) })).toThrow();
    expect(() => assertFinancedCustomerGapCollectable({ customerReceivableMinor: 0 })).not.toThrow();
    expect(() => assertFinancedCustomerGapCollectable(undefined)).not.toThrow();
  });

  test("an unreadable gap fails closed instead of reading as zero", () => {
    for (const bad of [Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY]) {
      expect(() => assertFinancedCustomerGapCollectable({ customerReceivableMinor: bad })).toThrow();
    }
  });

  test("the refusal carries its code and says what to do, without any figure", async () => {
    const data = await refusalDataOf(Promise.resolve().then(() => assertFinancedCustomerGapCollectable({ customerReceivableMinor: 123_456 })));
    expect(data?.code).toBe(REFUSAL_CODE);
    expect(data?.message).not.toMatch(/123/);
    expect(data?.message).toMatch(/gap/i);
  });

  test("the backstop reads the actual invoice: an open plan-governed customer invoice refuses, a paid one and a cash completion do not", async () => {
    const s = await seed("back");
    const applicationId = await resolvedDeal(s, { customer: 0, dealer: jod(850), cash: 0, installment: 0, financeCompany: 0 });
    await finalizeAsOwner(s, applicationId);
    const { doc } = await invoiceOf(s, applicationId);
    const plan = { customerReceivableMinor: 0 };

    await s.t.run(async (ctx) => {
      await assertFinancedInvoiceFullyPaid(ctx, { financedSalePlan: plan, saleReceivableId: doc._id });
    });

    // Corrupt the stored invoice so the plan and the real money disagree: 200 is now owed and nothing is allocated.
    await s.t.run((ctx) => ctx.db.patch(doc._id, { originalAmountMinor: jod(200), status: "OPEN" }));
    expect(
      await refusedWithCode(
        s.t.run((ctx) => assertFinancedInvoiceFullyPaid(ctx, { financedSalePlan: plan, saleReceivableId: doc._id }))
      )
    ).toBe(REFUSAL_CODE);

    // A completion with no financed plan is judged by the cash rule, not by this one.
    await s.t.run(async (ctx) => {
      await assertFinancedInvoiceFullyPaid(ctx, { financedSalePlan: undefined, saleReceivableId: doc._id });
    });
  });
});

