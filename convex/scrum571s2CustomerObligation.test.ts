import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents, recordReconciledZeroCost } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
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
    invoice?: "present" | "none";
    /** Whether the sale-completed event and journal are POSTED (the default). */
    posted?: "yes" | "event-pending" | "journal-draft" | "no-event" | "no-journal";
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
    const applicationId = await s.t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId: s.orgId,
        quoteId: s.quoteId,
        customerId: s.customerId,
        vehicleId: s.vehicleId,
        salespersonId: s.userId,
        status: opts.reconciledFee ? ("APPROVED" as const) : closedFields.status,
        quoteModeAtSubmission: "CONFIGURED_FINANCE_COMPANY" as const,
        companyId,
        economicsCurrency: "JOD",
        targetSellingAmountMinor: 12_000_000,
        approvedDealerPurchaseAmountMinor: 11_000_000,
        financeCompanyFundedPortionMinor: 9_350_000,
        dealerContributionMinor: 1_650_000,
        ...(opts.gapCashMinor !== undefined ? { customerGapCashToDealerMinor: opts.gapCashMinor } : {}),
        ...(opts.gapInstallmentMinor !== undefined ? { customerGapInstallmentToDealerMinor: opts.gapInstallmentMinor } : {}),
        ...(opts.reconciledFee ? {} : closedFields),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    await s.t.run((ctx) => ctx.db.patch(saleId, { applicationId }));

    await s.t.run(async (ctx) => {
      if (opts.invoice !== "none") {
        const originalMinor = opts.invoiceMinor ?? 1_000_000;
        const receivableId = await ctx.db.insert("receivableDocuments", {
          orgId: s.orgId, documentType: "INVOICE", documentNumber: `INV-${saleId}`, payerType: "CUSTOMER",
          customerId: s.customerId, sourceType: "sales", sourceId: saleId, originalAmountMinor: originalMinor,
          currency: "JOD", scale: 3, issueDate: Date.now(), dueDate: Date.now(),
          status: openMinor === 0 ? "PAID" : "OPEN", createdAt: Date.now(), createdBy: s.userId,
        });
        const paidMinor = originalMinor - openMinor;
        if (paidMinor > 0) {
          const paymentId = await ctx.db.insert("canonicalPayments", {
            orgId: s.orgId, direction: "IN", payerType: "CUSTOMER", customerId: s.customerId, method: "CASH",
            amountMinor: paidMinor, currency: "JOD", scale: 3, status: "SETTLED",
            idempotencyKey: `co-paid-${saleId}`, createdBy: s.userId, createdAt: Date.now(),
          });
          await ctx.db.insert("paymentAllocations", {
            orgId: s.orgId, paymentId, receivableDocumentId: receivableId, amountMinor: paidMinor, currency: "JOD",
            scale: 3, allocationDate: Date.now(), status: "ACTIVE", createdBy: s.userId, createdAt: Date.now(),
          });
        }
        await ctx.db.patch(saleId, { canonicalReceivableDocumentId: receivableId });
      }

      const posted = opts.posted ?? "yes";
      if (posted !== "no-event") {
        const eventId = await ctx.db.insert("accountingEvents", {
          orgId: s.orgId, eventType: "SALE_COMPLETED", sourceType: "sales", sourceId: saleId, eventVersion: 1,
          idempotencyKey: `sale_completed_${saleId}`, occurredAt: Date.now(), accountingDate: Date.now(),
          currency: "JOD", payload: {}, status: posted === "event-pending" ? "PENDING" : "POSTED",
          createdBy: s.userId, createdAt: Date.now(),
        });
        if (posted !== "no-journal") {
          const journalId = await ctx.db.insert("journalEntries", {
            orgId: s.orgId, accountingEventId: eventId, journalNumber: `JE-${saleId}`, accountingDate: Date.now(),
            sourceType: "sales", sourceId: saleId, category: "SYSTEM", memo: "sale", currency: "JOD",
            status: posted === "journal-draft" ? "DRAFT" : "POSTED", postedBy: s.userId, postedAt: Date.now(),
            createdAt: Date.now(),
          });
          await ctx.db.patch(eventId, { journalEntryId: journalId });
        }
      }
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

  test("a financed deal with gap exactly 0 is unchanged: an open invoice does not hold it", async () => {
    const s = await seed("gap0");
    const { applicationId } = await insertFinancedDeal(s, { gapCashMinor: 0, gapInstallmentMinor: 0, openMinor: 500_000 });
    expect(await settlementOf(s, applicationId)).toBe("COMPLETE");
  });

  test("a gap that cannot be read is UNKNOWN, never settled", async () => {
    const s = await seed("gapnan");
    const { applicationId } = await insertFinancedDeal(s, { gapCashMinor: -5, openMinor: 0 });
    expect(await settlementOf(s, applicationId)).not.toBe("COMPLETE");
  });

  test("a zero-value invoice recognised nothing: it needs no posting to read settled", async () => {
    const s = await seed("zero");
    const { applicationId } = await insertFinancedDeal(s, {
      gapCashMinor: 500_000, invoiceMinor: 0, openMinor: 0, posted: "no-event",
    });
    expect(await settlementOf(s, applicationId)).toBe("COMPLETE");
  });

  describe("fail closed: a gap deal whose invoice cannot be proven is not settled", () => {
    test("control: the fully proven shape is settled (so each case below differs by one fact)", async () => {
      const s = await seed("fc_ctl");
      const { applicationId } = await insertFinancedDeal(s, { gapCashMinor: 500_000, openMinor: 0 });
      expect(await settlementOf(s, applicationId)).toBe("COMPLETE");
    });

    test("an invoice in another currency", async () => {
      const s = await seed("fc_cur");
      const { applicationId, saleId } = await insertFinancedDeal(s, { gapCashMinor: 500_000, openMinor: 0 });
      await s.t.run(async (ctx) => {
        const sale = (await ctx.db.get(saleId))!;
        await ctx.db.patch(sale.canonicalReceivableDocumentId!, { currency: "USD" });
      });
      expect(await settlementOf(s, applicationId)).not.toBe("COMPLETE");
    });

    test("an invoice from another organization", async () => {
      const s = await seed("fc_org");
      const { applicationId, saleId } = await insertFinancedDeal(s, { gapCashMinor: 500_000, openMinor: 0 });
      await s.t.run(async (ctx) => {
        const foreign = await ctx.db.insert("organizations", { name: "CO foreign", createdAt: Date.now() });
        const sale = (await ctx.db.get(saleId))!;
        await ctx.db.patch(sale.canonicalReceivableDocumentId!, { orgId: foreign });
      });
      expect(await settlementOf(s, applicationId)).not.toBe("COMPLETE");
    });

    test("an invoice whose payer is not the customer", async () => {
      const s = await seed("fc_payer");
      const { applicationId, saleId } = await insertFinancedDeal(s, { gapCashMinor: 500_000, openMinor: 0 });
      await s.t.run(async (ctx) => {
        const sale = (await ctx.db.get(saleId))!;
        await ctx.db.patch(sale.canonicalReceivableDocumentId!, { payerType: "FINANCE_COMPANY" });
      });
      expect(await settlementOf(s, applicationId)).not.toBe("COMPLETE");
    });

    test("an invoice that belongs to another sale", async () => {
      const s = await seed("fc_src");
      const { applicationId, saleId } = await insertFinancedDeal(s, { gapCashMinor: 500_000, openMinor: 0 });
      await s.t.run(async (ctx) => {
        const sale = (await ctx.db.get(saleId))!;
        await ctx.db.patch(sale.canonicalReceivableDocumentId!, { sourceId: "some_other_sale" });
      });
      expect(await settlementOf(s, applicationId)).not.toBe("COMPLETE");
    });

    test("a missing pointer", async () => {
      const s = await seed("fc_ptr");
      const { applicationId } = await insertFinancedDeal(s, { gapCashMinor: 500_000, invoice: "none" });
      expect(await settlementOf(s, applicationId)).not.toBe("COMPLETE");
    });

    test.each<{ name: string; posted: NonNullable<DealOpts["posted"]> }>([
      { name: "a sale-completed event that is only queued (PENDING)", posted: "event-pending" },
      { name: "a posted event whose journal is not POSTED", posted: "journal-draft" },
      { name: "a posted event with no journal", posted: "no-journal" },
      { name: "no sale-completed event at all", posted: "no-event" },
    ])("$name", async ({ name, posted }) => {
      const s = await seed(`fc_${name.replace(/\W+/g, "").slice(0, 16)}`);
      const { applicationId } = await insertFinancedDeal(s, { gapCashMinor: 500_000, openMinor: 0, posted });
      expect(await settlementOf(s, applicationId)).not.toBe("COMPLETE");
    });
  });
});
