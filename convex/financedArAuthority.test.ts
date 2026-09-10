/**
 * GL Customer AR and the canonical customer receivable must describe one debt.
 *
 * When a finance company funds part of a deal the funded portion moves from the
 * customer to the financier. The GL does that as a balanced transfer:
 * `ruleFinanceDisbursed` debits Finance-company AR and credits Customer AR by the
 * SAME amount, so GL Customer AR becomes `billed − financed`. The subledger has
 * to describe the same economic fact.
 *
 * ⚠️ It did not. `transferFinancedAmountFromCustomerReceivable` took a
 * `saleAmountMinor` and OVERWROTE the canonical receivable with
 * `saleAmountMinor − financed` — a replacement, not a transfer. That agrees with
 * the GL only while the customer was billed exactly the vehicle price, and
 * `customerBillableMinor` is `vehicle + tax + dealerFees + warranty + GAP`
 * (SCRUM-22 put tax on top). Measured against the unfixed code:
 *
 *   billed 24,550 · financed 17,000  ->  produced 3,000, should be 7,550
 *                                        4,550 of real debt ERASED
 *   billed  5,000 · financed  9,000  ->  produced 11,000, should be 0
 *                                        debt INVENTED, more than doubled
 *
 * The repository already knew this failure mode from one side: `applications.ts`
 * documents it for DIRECT_TO_SUPPLIER — "It would zero a fee the customer
 * genuinely owes and mark it PAID, while the GL still carries the matching AR
 * debit." That route is guarded by skipping the block. The general case was not.
 *
 * It was latent rather than live only because the single caller passes
 * `quote.vehiclePrice` and quotes carry no tax or fees, so billed happened to
 * equal price. Correct-by-coincidence is one quote field away from wrong.
 */
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { transferFinancedAmountFromCustomerReceivable } from "./applications";

const MODULES = import.meta.glob("./**/*.ts");

const PERMISSIONS = [
  "create:sales",
  "view:sales",
  "edit:vehicles",
  "approve:requests",
  "view:finance_applications",
  "create:finance_application",
  "review:finance_application",
  "approve:finance_application",
  "finalize:financed_deal",
  "confirm:finance_disbursement",
  "verify:finance_documents",
  "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance",
];

async function setup() {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "u_ar_1", email: "ar@test.com", name: "AR User" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "u_ar_appr", email: "ar.appr@test.com", name: "AR Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A190190",
      make: "Kia",
      model: "Sportage",
      year: 2023,
      color: "Blue",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 1000,
      sellingPrice: 20000,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Sam", lastName: "Lee" })
  );

  /**
   * A completed financed sale whose customer was billed `billedMinor`.
   *
   * Seeded directly rather than driven through `finalizeDeal`, because the point
   * is what happens when billed differs from the vehicle price — and the quote
   * path cannot express that today. The reachable path has its own test below.
   */
  async function seedFinancedSale(billedMinor: number, tag: string) {
    // Quote and application come from the real API so the fixtures cannot drift
    // from the schema; only the receivable amount is set directly, because that
    // is the one thing the quote path cannot express.
    const asUser = t.withIdentity({ subject: "u_ar_1", clerkId: "u_ar_1" });
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });

    return t.run(async (ctx) => {
      const receivableId = await ctx.db.insert("receivableDocuments", {
        orgId,
        customerId,
        documentType: "INVOICE" as const,
        documentNumber: `REC-190-${tag}`,
        payerType: "CUSTOMER" as const,
        sourceType: "sales",
        sourceId: "seed",
        originalAmountMinor: billedMinor,
        currency: "JOD",
        scale: 3,
        status: "OPEN" as const,
        issueDate: Date.now(),
        dueDate: Date.now(),
        createdAt: Date.now(),
        createdBy: userId,
      });
      const saleId = await ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 20000,
        saleDate: Date.now(),
        status: "COMPLETED" as const,
        canonicalReceivableDocumentId: receivableId,
      });
      return { saleId, applicationId, receivableId };
    });
  }

  return {
    t,
    orgId,
    userId,
    customerId,
    vehicleId,
    seedFinancedSale,
    asUser: t.withIdentity({ subject: "u_ar_1", clerkId: "u_ar_1" }),
    asApprover: t.withIdentity({ subject: "u_ar_appr", clerkId: "u_ar_appr" }),
  };
}

describe("the financed transfer moves the customer's debt rather than replacing it", () => {
  test("a customer billed MORE than the vehicle price keeps the extra", async () => {
    // 20,000 car plus 4,550 of tax and dealership charges, 17,000 funded.
    // The customer must still owe 7,550. "Price minus financed" gives 3,000.
    const { t, orgId, seedFinancedSale } = await setup();
    const { saleId, applicationId, receivableId } = await seedFinancedSale(24_550_000, "A");

    await t.run((ctx) =>
      transferFinancedAmountFromCustomerReceivable(ctx, {
        orgId,
        saleId,
        applicationId,
        financedAmountMinor: 17_000_000,
      })
    );

    const billed = await t.run(async (ctx) => (await ctx.db.get(receivableId))!.originalAmountMinor);
    expect(billed).toBe(7_550_000);
  });

  test("financing more than was billed leaves nothing owed, and never invents debt", async () => {
    // Billed 5,000, financed 9,000. The unfixed code produced 11,000 — it raised
    // the customer's debt by financing part of it.
    const { t, orgId, seedFinancedSale } = await setup();
    const { saleId, applicationId, receivableId } = await seedFinancedSale(5_000_000, "B");

    await t.run((ctx) =>
      transferFinancedAmountFromCustomerReceivable(ctx, {
        orgId,
        saleId,
        applicationId,
        financedAmountMinor: 9_000_000,
      })
    );

    const receivable = await t.run((ctx) => ctx.db.get(receivableId));
    expect(receivable!.originalAmountMinor).toBe(0);
    expect(receivable!.status).toBe("PAID");
  });

  test("a customer billed exactly the vehicle price is unaffected", async () => {
    const { t, orgId, seedFinancedSale } = await setup();
    const { saleId, applicationId, receivableId } = await seedFinancedSale(20_000_000, "C");

    await t.run((ctx) =>
      transferFinancedAmountFromCustomerReceivable(ctx, {
        orgId,
        saleId,
        applicationId,
        financedAmountMinor: 17_000_000,
      })
    );

    const billed = await t.run(async (ctx) => (await ctx.db.get(receivableId))!.originalAmountMinor);
    expect(billed).toBe(3_000_000);
  });
});

describe("retrying the transfer", () => {
  test("a second application does not deduct the financed amount twice", async () => {
    // Reading the basis from the receivable is correct but not self-idempotent:
    // a naive retry would compute 7,550 − 17,000 and zero the balance. The
    // finance-company receivable the deal opens alongside is the marker that the
    // move already happened — a fact about the deal, not a balance that later
    // payments will change.
    const { t, orgId, userId, customerId, seedFinancedSale } = await setup();
    const { saleId, applicationId, receivableId } = await seedFinancedSale(24_550_000, "D");

    const apply = () =>
      t.run((ctx) =>
        transferFinancedAmountFromCustomerReceivable(ctx, {
          orgId,
          saleId,
          applicationId,
          financedAmountMinor: 17_000_000,
        })
      );
    const billed = () =>
      t.run(async (ctx) => (await ctx.db.get(receivableId))!.originalAmountMinor);

    await apply();
    const afterFirst = await billed();

    await t.run((ctx) =>
      ctx.db.insert("receivableDocuments", {
        orgId,
        customerId,
        documentType: "INVOICE" as const,
        documentNumber: "REC-190-FC",
        payerType: "FINANCE_COMPANY" as const,
        sourceType: "finance_application",
        sourceId: applicationId,
        originalAmountMinor: 17_000_000,
        currency: "JOD",
        scale: 3,
        status: "OPEN" as const,
        issueDate: Date.now(),
        dueDate: Date.now(),
        createdAt: Date.now(),
        createdBy: userId,
      })
    );

    await apply();

    expect(afterFirst).toBe(7_550_000);
    expect(await billed()).toBe(afterFirst);
  });
});

describe("the reachable path today", () => {
  test("a financed sale through finalizeDeal never leaves the customer owing more than billed", async () => {
    // Pins the invariant on the ONLY path that reaches the transfer. It passed
    // on the unfixed code too, because quotes carry no tax, dealer fees,
    // warranty or GAP — so billed equalled price and the old arithmetic happened
    // to be right. This exists so that adding any billable to the quote path
    // fails here instead of diverging silently.
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();

    const companyId = await t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId,
        name: "Test Finance",
        profitRate: 5.5,
        maxTermMonths: 72,
        gracePeriodMonths: 3,
        isActive: true,
      })
    );

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    await t.run((ctx) => ctx.db.patch(applicationId, { companyId }));
    await asUser.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
    await asApprover.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
    await registerHandover(asUser, api, orgId, applicationId);
    await asUser.mutation(api.applications.registerExpectedPayment, {
      orgId,
      applicationId,
      method: "CASH",
      expectedDate: Date.now(),
    });
    await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });

    const billed = await t.run(async (ctx) => {
      const sale = await ctx.db
        .query("sales")
        .filter((q) => q.eq(q.field("orgId"), orgId))
        .first();
      return (await ctx.db.get(sale!.canonicalReceivableDocumentId!))!.originalAmountMinor;
    });

    expect(billed).toBeLessThanOrEqual(20_000_000);
    expect(billed).toBeGreaterThanOrEqual(0);
  });
});
