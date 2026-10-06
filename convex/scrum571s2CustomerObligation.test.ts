import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents, recordReconciledZeroCost } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { seedSaleCompletedPosting, seedSaleInvoice, type SaleCompletedPostingStatus } from "../test-utils/saleInvoiceFixtures";
import { ALL_PERMISSIONS } from "./utils/permissions";

type TestConvex = ConvexTestInstance<typeof schema>;

const MODULES = import.meta.glob("./**/*.*s");

/**
 * SCRUM-571 slice 2a (D-43): a sale must never read as money-settled while its
 * canonical customer invoice has an outstanding balance, or while that balance
 * or its posted origin cannot be proven. The rule holds on EVERY financier leg,
 * not only the financier-less one.
 *
 * Every case drives the REAL cockpit and overview queries, so a test that
 * handed `moneySettled` straight to the stage derivation could not pass here.
 */
describe("SCRUM-571 s2a: the customer's invoice gates 'settled' on every financier leg", () => {
  interface Seed {
    t: TestConvex;
    orgId: Id<"organizations">;
    userId: Id<"users">;
    customerId: Id<"customers">;
    vehicleId: Id<"vehicles">;
    quoteId: Id<"quotes">;
    asOwner: ReturnType<TestConvex["withIdentity"]>;
  }

  async function seed(tag: string): Promise<Seed> {
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `CO ${tag}`, createdAt: Date.now() }));
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `co_${tag}`, email: `co.${tag}@example.com`, name: "CO Owner" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "CO", lastName: "Customer" }));
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: `COVIN${tag}`,
        make: "Toyota",
        model: "Camry",
        year: 2024,
        mileage: 100,
        color: "White",
        fuelType: "Gasoline",
        transmission: "Automatic",
        sellingPrice: 10_500,
        status: "SOLD",
        sourceType: "STOCK" as const,
        purchasePrice: 9_500,
        landedCostTotal: 100,
      })
    );
    const quoteId = await t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId,
        customerId,
        vehicleId,
        vehiclePrice: 10_500,
        downPayment: 500,
        termMonths: 60,
        status: "ACCEPTED",
        createdBy: userId,
        createdAt: Date.now(),
      })
    );
    return { t, orgId, userId, customerId, vehicleId, quoteId, asOwner: t.withIdentity({ subject: `co_${tag}` }) };
  }

  interface DealOpts {
    /** What the customer owes the dealership directly (gap in cash). Undefined: nothing recorded. */
    gapCashMinor?: number;
    gapInstallmentMinor?: number;
    /** Invoice amount outstanding after allocations; 0 pays it in full. */
    openMinor?: number;
    /** `none`: the sale carries no canonical pointer. */
    invoice?: "none";
    /** The sale-completed posting's state; POSTED by default. */
    posted?: SaleCompletedPostingStatus;
    reconciledFee?: boolean;
    /** Invoice face value; 0 is a zero-value invoice that recognised nothing. */
    invoiceMinor?: number;
  }

  async function insertFinancedDeal(s: Seed, opts: DealOpts = {}) {
    const openMinor = opts.openMinor ?? 1_000_000;
    const companyId = await s.t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId: s.orgId,
        name: "Configured Finance",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
        adminFees: 0,
        defaultLtvPercent: 100,
      })
    );
    const saleId = await s.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        customerId: s.customerId,
        salespersonId: s.userId,
        salePrice: 10_500,
        saleDate: Date.now(),
        status: "COMPLETED",
        financingType: "FINANCED",
      })
    );
    const closedFields = {
      status: "CLOSED" as const,
      finalizedSaleId: saleId,
      handoverStatus: "HANDED_OVER" as const,
      // The financier's own leg is finished, so only the customer's invoice can keep the deal open.
      settlementStatus: "FULLY_SETTLED" as const,
    };
    // A reconciled-fee deal starts APPROVED (the fee is recorded through the real mutation) and closes after.
    const applicationId = await s.t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId: s.orgId,
        quoteId: s.quoteId,
        customerId: s.customerId,
        vehicleId: s.vehicleId,
        salespersonId: s.userId,
        quoteModeAtSubmission: "CONFIGURED_FINANCE_COMPANY" as const,
        companyId,
        economicsCurrency: "JOD",
        targetSellingAmountMinor: 12_000_000,
        approvedDealerPurchaseAmountMinor: 11_000_000,
        financeCompanyFundedPortionMinor: 9_350_000,
        dealerContributionMinor: 1_650_000,
        ...(opts.gapCashMinor !== undefined ? { customerGapCashToDealerMinor: opts.gapCashMinor } : {}),
        ...(opts.gapInstallmentMinor !== undefined ? { customerGapInstallmentToDealerMinor: opts.gapInstallmentMinor } : {}),
        ...(opts.reconciledFee ? { status: "APPROVED" as const } : closedFields),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await s.t.run((ctx) => ctx.db.patch(saleId, { applicationId }));

    await s.t.run(async (ctx) => {
      const base = { orgId: s.orgId, saleId, userId: s.userId };
      if (opts.invoice !== "none") {
        await seedSaleInvoice(ctx, { ...base, customerId: s.customerId, originalMinor: opts.invoiceMinor ?? 1_000_000, openMinor });
      }
      await seedSaleCompletedPosting(ctx, { ...base, status: opts.posted });
    });

    if (opts.reconciledFee) {
      await recordReconciledZeroCost(s.asOwner, api, s.orgId, applicationId);
      await s.t.run((ctx) => ctx.db.patch(applicationId, closedFields));
    }
    return { applicationId, saleId };
  }

  async function settlementOf(s: Seed, applicationId: Id<"financeApplications">) {
    const view = await s.asOwner.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    return view!.stages.find((st) => st.key === "SETTLEMENT")!.state;
  }

  async function profitOf(s: Seed, applicationId: Id<"financeApplications">) {
    const view = await s.asOwner.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId });
    return view!.financialSummary!.profit;
  }

  test("control: a financed deal with no customer gap and a paid invoice reads settled", async () => {
    const s = await seed("ctl");
    const { applicationId } = await insertFinancedDeal(s, { gapCashMinor: 0, openMinor: 0 });
    expect(await settlementOf(s, applicationId)).toBe("COMPLETE");
  });

  test("a financed deal whose customer owes a gap and whose invoice is open is NOT settled", async () => {
    const s = await seed("open");
    const { applicationId } = await insertFinancedDeal(s, { gapCashMinor: 500_000, openMinor: 500_000, reconciledFee: true });
    expect(await settlementOf(s, applicationId)).not.toBe("COMPLETE");
    const profit = await profitOf(s, applicationId);
    if (!profit.available || profit.basis !== "MANAGEMENT_ESTIMATE") throw new Error("expected an estimate");
    // `fullySettled` false: the headline is not called ACTUAL.
    expect(profit.classification).toBe("ESTIMATED_AWAITING_SETTLEMENT");
  });

  test("an instalment gap counts exactly like a cash gap", async () => {
    const s = await seed("inst");
    const { applicationId } = await insertFinancedDeal(s, { gapInstallmentMinor: 500_000, openMinor: 500_000 });
    expect(await settlementOf(s, applicationId)).not.toBe("COMPLETE");
  });

  test("the same deal reads settled once the invoice is fully paid", async () => {
    const s = await seed("paid");
    const { applicationId } = await insertFinancedDeal(s, { gapCashMinor: 500_000, openMinor: 0, reconciledFee: true });
    expect(await settlementOf(s, applicationId)).toBe("COMPLETE");
    const profit = await profitOf(s, applicationId);
    if (!profit.available || profit.basis !== "MANAGEMENT_ESTIMATE") throw new Error("expected an estimate");
    expect(profit.classification).not.toBe("ESTIMATED_AWAITING_SETTLEMENT");
  });

  test("a financed deal with gap exactly 0 is still judged on its invoice: an open invoice holds it (D-48)", async () => {
    const s = await seed("gap0");
    const { applicationId } = await insertFinancedDeal(s, { gapCashMinor: 0, gapInstallmentMinor: 0, openMinor: 500_000 });
    expect(await settlementOf(s, applicationId)).not.toBe("COMPLETE");
  });

  test("control: a gap-0 deal whose invoice is a paid zero-value invoice reads settled without a posting", async () => {
    const s = await seed("gap0zero");
    const { applicationId } = await insertFinancedDeal(s, {
      gapCashMinor: 0, gapInstallmentMinor: 0, invoiceMinor: 0, openMinor: 0, posted: "MISSING",
    });
    expect(await settlementOf(s, applicationId)).toBe("COMPLETE");
  });

  test("a gap-0 deal with no canonical invoice is UNKNOWN, never settled", async () => {
    const s = await seed("gap0none");
    const { applicationId } = await insertFinancedDeal(s, { gapCashMinor: 0, gapInstallmentMinor: 0, invoice: "none" });
    expect(await settlementOf(s, applicationId)).not.toBe("COMPLETE");
  });

  test("the financed cockpit names the invoice balance beside the deposit position, and withholds it without view:finance", async () => {
    const s = await seed("f4fin");
    const { applicationId } = await insertFinancedDeal(s, { gapCashMinor: 500_000, openMinor: 500_000 });
    const view = await s.asOwner.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    expect(view!.customerInvoiceState).toBe("OPEN");
    expect(view!.money!.customerInvoice).toEqual({ state: "OPEN", outstandingMinor: 500_000, currency: "JOD" });
    // The deposit row is a different fact and stays on its own party row.
    expect(view!.money!.parties.find((p) => p.party === "CUSTOMER")).toBeDefined();

    const viewerId = await s.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "co_f4fin_viewer", email: "co.f4v@example.com", name: "Viewer" })
    );
    const roleId = await s.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: s.orgId, name: "SALES", permissions: ["view:sales", "view:finance_applications"], isSystemOwnerRole: false })
    );
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.orgId, userId: viewerId, roleId }));
    const viewer = await s.t
      .withIdentity({ subject: "co_f4fin_viewer", clerkId: "co_f4fin_viewer" })
      .query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    expect(viewer!.customerInvoiceState).toBe("OPEN");
    expect(viewer!.money).toBeNull();
  });

  test("a gap that cannot be read is UNKNOWN, never settled", async () => {
    const s = await seed("gapnan");
    const { applicationId } = await insertFinancedDeal(s, { gapCashMinor: -5, openMinor: 0 });
    expect(await settlementOf(s, applicationId)).not.toBe("COMPLETE");
  });

  test("a zero-value invoice recognised nothing: it needs no posting to read settled", async () => {
    const s = await seed("zero");
    const { applicationId } = await insertFinancedDeal(s, {
      gapCashMinor: 500_000, invoiceMinor: 0, openMinor: 0, posted: "MISSING",
    });
    expect(await settlementOf(s, applicationId)).toBe("COMPLETE");
  });

  describe("fail closed: a gap deal whose invoice cannot be proven is not settled", () => {
    test("control: the fully proven shape is settled (so each case below differs by one fact)", async () => {
      const s = await seed("fc_ctl");
      const { applicationId } = await insertFinancedDeal(s, { gapCashMinor: 500_000, openMinor: 0 });
      expect(await settlementOf(s, applicationId)).toBe("COMPLETE");
    });

    test.each<{ name: string; patch: (ctx: MutationCtx) => Promise<Partial<Doc<"receivableDocuments">>> }>([
      { name: "an invoice in another currency", patch: async () => ({ currency: "USD" }) },
      {
        name: "an invoice from another organization",
        patch: async (ctx) => ({
          orgId: await ctx.db.insert("organizations", { name: "CO foreign", createdAt: Date.now() }),
        }),
      },
      { name: "an invoice whose payer is not the customer", patch: async () => ({ payerType: "FINANCE_COMPANY" }) },
      { name: "an invoice that belongs to another sale", patch: async () => ({ sourceId: "some_other_sale" }) },
    ])("$name", async ({ patch }) => {
      const s = await seed("fc_invoice");
      const { applicationId, saleId } = await insertFinancedDeal(s, { gapCashMinor: 500_000, openMinor: 0 });
      await s.t.run(async (ctx) => {
        const sale = (await ctx.db.get(saleId))!;
        await ctx.db.patch(sale.canonicalReceivableDocumentId!, await patch(ctx));
      });
      expect(await settlementOf(s, applicationId)).not.toBe("COMPLETE");
    });

    test("a missing pointer", async () => {
      const s = await seed("fc_ptr");
      const { applicationId } = await insertFinancedDeal(s, { gapCashMinor: 500_000, invoice: "none" });
      expect(await settlementOf(s, applicationId)).not.toBe("COMPLETE");
    });

    test.each<{ name: string; posted: SaleCompletedPostingStatus }>([
      { name: "a sale-completed event that is only queued (PENDING)", posted: "PENDING" },
      { name: "a posted event whose journal is not POSTED", posted: "JOURNAL_DRAFT" },
      { name: "a posted event with no journal", posted: "NO_JOURNAL" },
      { name: "no sale-completed event at all", posted: "MISSING" },
    ])("$name", async ({ posted }) => {
      const s = await seed(`fc_${posted}`);
      const { applicationId } = await insertFinancedDeal(s, { gapCashMinor: 500_000, openMinor: 0, posted });
      expect(await settlementOf(s, applicationId)).not.toBe("COMPLETE");
    });
  });
});
