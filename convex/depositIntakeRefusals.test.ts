import { describe, expect, test } from "vitest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { G, newApplication, refusalDataOf, seedFinancedDealership } from "../test-utils/financedDealFixture";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { AppErrorCode } from "./utils/errors";
import { MAX_QUOTE_DEPOSITS } from "./utils/firstPaymentEvidence";

import { legacyFinancingMinor } from "../test-utils/legacyFinancing";
/**
 * SCRUM-967: new deposit intake is refused server-side while the open deal is
 * being corrected or unwound, after handover, when the deal cannot be verified,
 * in a different currency, or when a request's agreement changed. Every case
 * goes through a public mutation, asserts the structured error code, and proves
 * that nothing was written: the whole database is identical afterwards.
 */
const modules = import.meta.glob("./**/*.ts");
const allTables = Object.keys(schema.tables);

type Deal = Awaited<ReturnType<typeof openDeal>>;

async function openDeal(tag: string, opts: { approved?: boolean } = {}) {
  const seed = await seedFinancedDealership(tag, {
    modules, ownerPerms: [], actors: {}, label: "Deposit intake refusals", vinPrefix: "DIR",
  });
  const { applicationId, quoteId } = await newApplication(seed, { firstPaymentMinor: 500_000 });
  const target = { orgId: seed.orgId, applicationId };
  if (opts.approved) {
    await seed.owner.as.mutation(api.applications.updateStatus, { ...target, status: "UNDER_REVIEW" });
    await seed.approver.as.mutation(api.applications.updateStatus, { ...target, status: "APPROVED" });
    await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
      ...target, submittedQuotationMinor: G, customerFirstPaymentMinor: 500_000, source: "MANUAL_ENTRY",
    });
    await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      ...target, approvedAmountMinor: G,
      approvedFinancingAmountMinor: legacyFinancingMinor(G, 85), basis: "MANUAL", notes: "Approved first payment",
    });
  }
  return { seed, orgId: seed.orgId, applicationId, quoteId, target };
}

/** The two doors that take new deposit intake. */
const entries = {
  "direct recording (deposits.create)": (d: Deal, key: string) =>
    d.seed.approver.as.mutation(api.deposits.create, {
      orgId: d.orgId, quoteId: d.quoteId, method: "CASH", amount: 100, idempotencyKey: key,
    }),
  "request creation (depositRequests.request)": (d: Deal, key: string) =>
    d.seed.owner.as.mutation(api.depositRequests.request, {
      orgId: d.orgId, quoteId: d.quoteId, amount: 100, idempotencyKey: key,
    }),
} as const;
const entryRows = Object.entries(entries);

/** Runs the refused attempt, checks the code, and proves no money moved. */
async function expectRefusedWithoutWrites(deal: Deal, attempt: () => Promise<unknown>, code: string) {
  const before = await dbSnapshot(deal.seed.t, allTables);
  const refusal = await refusalDataOf(attempt());
  expect(refusal?.code).toBe(code);
  const after = await dbSnapshot(deal.seed.t, allTables);
  for (const table of ["deposits", "depositRequests", "accountingEvents", "journalEntries", "journalLines"]) {
    expect(after[table], table).toEqual(before[table]);
  }
  expect(after).toEqual(before);
}

async function startUnwind(deal: Deal, status: "ACTIVE" | "ABANDONED" = "ACTIVE") {
  const { seed, orgId, applicationId } = deal;
  return await seed.t.run(async (ctx) => {
    const saleId = await ctx.db.insert("sales", {
      orgId, vehicleId: seed.vehicleId, customerId: seed.customerId, salespersonId: seed.owner.userId,
      salePrice: 12500, saleDate: Date.now(), status: "CANCELLED", financingType: "FINANCED",
    });
    return await ctx.db.insert("dealUnwinds", {
      orgId, applicationId, saleId, status, reason: "Customer returned the car", startedBy: seed.owner.userId,
      startedAt: Date.now(), remittanceVersion: 1, remittanceMinor: 0, remittanceMethod: "CASH",
      forwardDueMinor: 0, createdAt: Date.now(), updatedAt: Date.now(),
    });
  });
}

type CorrectionField =
  | "pendingIdentityCorrectionId" | "pendingLenderCorrectionId" | "pendingFirstPaymentEvidenceCorrectionId";
const correctionFields: CorrectionField[] = [
  "pendingIdentityCorrectionId", "pendingLenderCorrectionId", "pendingFirstPaymentEvidenceCorrectionId",
];

/** A real PENDING correction row of the kind, pointed at by the application. */
async function markCorrectionPending(deal: Deal, field: CorrectionField) {
  const { seed, orgId, applicationId, quoteId } = deal;
  await seed.t.run(async (ctx) => {
    const now = Date.now();
    const base = { orgId, applicationId, handoverAt: now, reason: "Correction in progress", requestedBy: seed.owner.userId, requestedAt: now };
    if (field === "pendingIdentityCorrectionId") {
      const id = await ctx.db.insert("deliveredDealIdentityCorrections", {
        ...base, status: "PENDING", kind: "BUYER", originalQuoteId: quoteId, replacementQuoteId: quoteId,
        originalCustomerId: seed.customerId, replacementCustomerId: seed.customerId,
        originalVehicleId: seed.vehicleId, replacementVehicleId: seed.vehicleId,
        handoverBy: seed.owner.userId, economicsStamp: "stamp",
      });
      await ctx.db.patch(applicationId, { pendingIdentityCorrectionId: id });
    } else if (field === "pendingLenderCorrectionId") {
      const id = await ctx.db.insert("deliveredLenderCorrections", {
        ...base, status: "PENDING", originalQuoteId: quoteId, replacementQuoteId: quoteId,
        originalCompanyId: seed.companyId, replacementCompanyId: seed.companyId, economicsStamp: "stamp",
      });
      await ctx.db.patch(applicationId, { pendingLenderCorrectionId: id });
    } else {
      const paymentId = await ctx.db.insert("customerFinanceCompanyPayments", {
        orgId, applicationId, status: "CONFIRMED", amountMinor: 1, currency: "JOD", paidAt: now,
        reference: "LENDER-REF", confirmedBy: seed.owner.userId, confirmedAt: now,
      });
      const id = await ctx.db.insert("firstPaymentEvidenceCorrections", {
        orgId, applicationId, paymentId, status: "PENDING", handoverAt: now, vehicleId: seed.vehicleId,
        attribution: "DIRECT", currency: "JOD", amountMinor: 1, paidAt: now, kind: "RECEIPT",
        reference: "LENDER-REF", reason: "Correction in progress", requestedBy: seed.owner.userId, requestedAt: now,
      });
      await ctx.db.patch(applicationId, { pendingFirstPaymentEvidenceCorrectionId: id });
    }
  });
}

describe.each(entryRows)("%s", (_door, attempt) => {
  test.each(correctionFields)("refuses while %s is set", async (field) => {
    const deal = await openDeal(`corr-${field}`.slice(0, 40));
    await markCorrectionPending(deal, field);
    await expectRefusedWithoutWrites(deal, () => attempt(deal, "corr-key"), AppErrorCode.DEPOSIT_DEAL_CORRECTION_ACTIVE);
  });

  test("refuses while a deal unwind is active, even for approved first-payment terms", async () => {
    const deal = await openDeal("unwind-approved", { approved: true });
    await startUnwind(deal);
    await expectRefusedWithoutWrites(deal, () => attempt(deal, "unwind-key"), AppErrorCode.DEPOSIT_DEAL_CORRECTION_ACTIVE);
  });

  test("an active unwind is the only block when first-payment terms are not approved", async () => {
    const deal = await openDeal("unwind-unapproved");
    const app = await deal.seed.t.run((ctx) => ctx.db.get(deal.applicationId));
    expect(app?.status).not.toBe("APPROVED");
    expect(app?.approvedDealerPurchaseAmountMinor).toBeUndefined();
    const unwindId = await startUnwind(deal);
    await expectRefusedWithoutWrites(deal, () => attempt(deal, "unwind-only-key"), AppErrorCode.DEPOSIT_DEAL_CORRECTION_ACTIVE);
    // Once the unwind is no longer active nothing else stands in the way.
    await deal.seed.t.run((ctx) => ctx.db.patch(unwindId, { status: "ABANDONED" }));
    await expect(attempt(deal, "after-unwind-key")).resolves.toEqual(expect.any(String));
  });

  test("refuses after the vehicle was handed over", async () => {
    const deal = await openDeal("handed-over");
    await deal.seed.t.run((ctx) => ctx.db.patch(deal.applicationId, { vehicleHandoverAt: Date.now() }));
    await expectRefusedWithoutWrites(deal, () => attempt(deal, "handover-key"), AppErrorCode.DEPOSIT_DEAL_HANDED_OVER);
  });

  test("refuses a deposit in a currency other than the deal's", async () => {
    const deal = await openDeal("deal-currency");
    await deal.seed.t.run((ctx) => ctx.db.patch(deal.applicationId, { economicsCurrency: "USD" }));
    await expectRefusedWithoutWrites(deal, () => attempt(deal, "currency-key"), AppErrorCode.DEPOSIT_DEAL_CURRENCY);
  });

  describe("an active deal that cannot be verified", () => {
    const cloneApplication = (deal: Deal, extra: Record<string, unknown> = {}) =>
      deal.seed.t.run(async (ctx) => {
        const { _id, _creationTime, ...copy } = (await ctx.db.get(deal.applicationId))!;
        return await ctx.db.insert("financeApplications", { ...copy, ...extra } as never);
      });

    test("refuses a second open application on the quote", async () => {
      const deal = await openDeal("two-open");
      await cloneApplication(deal);
      await expectRefusedWithoutWrites(deal, () => attempt(deal, "two-open-key"), AppErrorCode.DEPOSIT_DEAL_UNVERIFIED);
    });

    test("refuses an open application whose customer differs from the quote", async () => {
      const deal = await openDeal("other-customer");
      const otherCustomer = await deal.seed.t.run((ctx) =>
        ctx.db.insert("customers", { orgId: deal.orgId, firstName: "Someone", lastName: "Else" }));
      await deal.seed.t.run((ctx) => ctx.db.patch(deal.applicationId, { customerId: otherCustomer }));
      await expectRefusedWithoutWrites(deal, () => attempt(deal, "customer-key"), AppErrorCode.DEPOSIT_DEAL_UNVERIFIED);
    });

    test("refuses an open application whose vehicle differs from the quote", async () => {
      const deal = await openDeal("other-vehicle");
      const otherVehicle = await deal.seed.t.run((ctx) => ctx.db.insert("vehicles", {
        orgId: deal.orgId, vin: "DIR-OTHER-VEHICLE", make: "Kia", model: "Sorento", year: 2024, mileage: 10,
        color: "Black", fuelType: "Gasoline", transmission: "Automatic", status: "AVAILABLE",
        sellingPrice: 12_500, purchasePrice: 9_000, sourceType: "STOCK",
      }));
      await deal.seed.t.run((ctx) => ctx.db.patch(deal.applicationId, { vehicleId: otherVehicle }));
      await expectRefusedWithoutWrites(deal, () => attempt(deal, "vehicle-key"), AppErrorCode.DEPOSIT_DEAL_UNVERIFIED);
    });

    test("refuses a quote with more applications than can be read", async () => {
      const deal = await openDeal("many-applications");
      for (let index = 0; index < MAX_QUOTE_DEPOSITS; index += 1) await cloneApplication(deal, { status: "CANCELLED" });
      await expectRefusedWithoutWrites(deal, () => attempt(deal, "many-apps-key"), AppErrorCode.DEPOSIT_DEAL_UNVERIFIED);
    });

    test("refuses a quote with more sales than can be read", async () => {
      const deal = await openDeal("many-sales");
      await deal.seed.t.run(async (ctx) => {
        for (let index = 0; index < MAX_QUOTE_DEPOSITS + 1; index += 1) {
          await ctx.db.insert("sales", {
            orgId: deal.orgId, quoteId: deal.quoteId, vehicleId: deal.seed.vehicleId, customerId: deal.seed.customerId,
            salespersonId: deal.seed.owner.userId, salePrice: 12500, saleDate: Date.now(), status: "CANCELLED",
            financingType: "FINANCED",
          });
        }
      });
      await expectRefusedWithoutWrites(deal, () => attempt(deal, "many-sales-key"), AppErrorCode.DEPOSIT_DEAL_UNVERIFIED);
    });
  });
});

describe("confirming a request whose deal has since changed", () => {
  const requestOnDeal = async (tag: string) => {
    const deal = await openDeal(tag);
    const requestId = await deal.seed.owner.as.mutation(api.depositRequests.request, {
      orgId: deal.orgId, quoteId: deal.quoteId, amount: 100, idempotencyKey: `${tag}-request`,
    });
    const confirm = () => deal.seed.approver.as.mutation(api.depositRequests.confirm, {
      orgId: deal.orgId, requestId, amount: 100, method: "CASH", idempotencyKey: `${tag}-confirm`,
    });
    return { deal, requestId, confirm };
  };
  const stillPending = async (deal: Deal, requestId: Id<"depositRequests">) => {
    await expect(deal.seed.t.run((ctx) => ctx.db.get(requestId))).resolves.toMatchObject({ status: "PENDING" });
  };

  test("refuses confirmation after the quote's buyer changed", async () => {
    const { deal, requestId, confirm } = await requestOnDeal("agreement-buyer");
    const otherCustomer = await deal.seed.t.run((ctx) =>
      ctx.db.insert("customers", { orgId: deal.orgId, firstName: "New", lastName: "Buyer" }));
    await deal.seed.t.run((ctx) => ctx.db.patch(deal.quoteId, { customerId: otherCustomer }));
    await expectRefusedWithoutWrites(deal, confirm, AppErrorCode.DEPOSIT_REQUEST_AGREEMENT_CHANGED);
    await stillPending(deal, requestId);
  });

  test("refuses confirmation after the quote's vehicle changed", async () => {
    const { deal, requestId, confirm } = await requestOnDeal("agreement-vehicle");
    const otherVehicle = await deal.seed.t.run((ctx) => ctx.db.insert("vehicles", {
      orgId: deal.orgId, vin: "DIR-REPLACEMENT-CAR", make: "Kia", model: "Sorento", year: 2024, mileage: 10,
      color: "Black", fuelType: "Gasoline", transmission: "Automatic", status: "AVAILABLE",
      sellingPrice: 12_500, purchasePrice: 9_000, sourceType: "STOCK",
    }));
    await deal.seed.t.run((ctx) => ctx.db.patch(deal.quoteId, { vehicleId: otherVehicle }));
    await expectRefusedWithoutWrites(deal, confirm, AppErrorCode.DEPOSIT_REQUEST_AGREEMENT_CHANGED);
    await stillPending(deal, requestId);
  });

  test("refuses confirmation while a deal unwind is active", async () => {
    const { deal, requestId, confirm } = await requestOnDeal("confirm-unwind");
    await startUnwind(deal);
    await expectRefusedWithoutWrites(deal, confirm, AppErrorCode.DEPOSIT_DEAL_CORRECTION_ACTIVE);
    await stillPending(deal, requestId);
  });

  test("refuses confirmation after the vehicle was handed over", async () => {
    const { deal, requestId, confirm } = await requestOnDeal("confirm-handover");
    await deal.seed.t.run((ctx) => ctx.db.patch(deal.applicationId, { vehicleHandoverAt: Date.now() }));
    await expectRefusedWithoutWrites(deal, confirm, AppErrorCode.DEPOSIT_DEAL_HANDED_OVER);
    await stillPending(deal, requestId);
  });
});
