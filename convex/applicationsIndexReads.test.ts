/**
 * SCRUM-555 part 2 — `applications.ts` reads through indexes instead of query
 * field predicates. Only the READ MECHANISM changed: every refusal and every
 * computed snapshot value must be exactly what it was.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { transferFinancedAmountFromCustomerReceivable } from "./applications";

const MODULES = import.meta.glob("./**/*.*s");

type TestConvex = ReturnType<typeof convexTestWithComponents>;

async function seedDealer(tag: string) {
  const t = convexTestWithComponents(schema, MODULES);
  const {
    orgId,
    userId,
    identity: asUser,
  } = await seedOrgWithMember(t, {
    clerkId: `${tag}_user`,
    permissions: ["create:sales", "view:sales"],
    orgName: `IdxReads Dealer ${tag}`,
    roleName: "Sales",
  });
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Idx", lastName: "Customer" })
  );
  return { t, orgId, userId, asUser, customerId };
}

async function seedVehicle(t: TestConvex, orgId: Id<"organizations">, vin: string) {
  return await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin,
      make: "Toyota",
      model: "RAV4",
      year: 2025,
      mileage: 100,
      color: "Silver",
      fuelType: "Gasoline",
      transmission: "Automatic",
      purchasePrice: 18000,
      sellingPrice: 22000,
      status: "AVAILABLE",
    })
  );
}

async function seedCompany(t: TestConvex, orgId: Id<"organizations">, name: string) {
  return await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name,
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
      adminFees: 0,
    })
  );
}

async function seedQuote(
  t: TestConvex,
  args: {
    orgId: Id<"organizations">;
    customerId: Id<"customers">;
    vehicleId: Id<"vehicles">;
    userId: Id<"users">;
    companyId?: Id<"financeCompanies">;
    totalFinancedAmount?: number;
  }
) {
  return await t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId: args.orgId,
      customerId: args.customerId,
      vehicleId: args.vehicleId,
      vehiclePrice: 22000,
      downPayment: 2000,
      termMonths: 48,
      status: "ACCEPTED",
      createdBy: args.userId,
      createdAt: Date.now(),
      monthlyInstallment: 500,
      ...(args.companyId ? { companyId: args.companyId, mode: "CONFIGURED_FINANCE_COMPANY" as const } : {}),
      ...(args.totalFinancedAmount !== undefined ? { totalFinancedAmount: args.totalFinancedAmount } : {}),
      // SCRUM-533: a financed quote carries the pricing snapshot `saveQuote` would have frozen; its
      // figures equal the quote's own (createFromQuote refuses any disagreement).
      ...(args.companyId && args.totalFinancedAmount !== undefined
        ? {
            customerQuotePricingSnapshot: {
              currency: "JOD",
              vehiclePrice: 22000,
              downPayment: 2000,
              termMonths: 48,
              executionFees: 0,
              commission: 0,
              profitRate: 5,
              insuranceRate: 0,
              gracePeriodMonths: 0,
              includesCommissionInDebt: false,
              totalFinancedAmount: args.totalFinancedAmount,
              totalContractValue: args.totalFinancedAmount,
              monthlyInstallment: 500,
              totalProfit: 0,
              takafulAmount: 0,
            },
          }
        : {}),
    })
  );
}

describe("createFromQuote duplicate-application read (by quote)", () => {
  test("a second application for the same quote is refused; a different quote in the same org is not", async () => {
    const { t, orgId, userId, asUser, customerId } = await seedDealer("t1");
    const vehicleA = await seedVehicle(t, orgId, "IDXT1VEHA0001");
    const vehicleB = await seedVehicle(t, orgId, "IDXT1VEHB0001");
    const quoteA = await seedQuote(t, { orgId, customerId, vehicleId: vehicleA, userId });
    const quoteB = await seedQuote(t, { orgId, customerId, vehicleId: vehicleB, userId });

    const first = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId: quoteA });
    expect(first).toBeTruthy();

    await expect(
      asUser.mutation(api.applications.createFromQuote, { orgId, quoteId: quoteA })
    ).rejects.toThrow("An application already exists for this quote.");

    const second = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId: quoteB });
    expect(second).not.toBe(first);
  });
});

describe("createFromQuote in-flight application read (by org + vehicle)", () => {
  async function seedApplicationRow(
    t: TestConvex,
    args: {
      orgId: Id<"organizations">;
      customerId: Id<"customers">;
      vehicleId: Id<"vehicles">;
      quoteId: Id<"quotes">;
      userId: Id<"users">;
      status: "UNDER_REVIEW" | "CLOSED";
    }
  ) {
    return await t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId: args.orgId,
        customerId: args.customerId,
        vehicleId: args.vehicleId,
        quoteId: args.quoteId,
        salespersonId: args.userId,
        status: args.status,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
  }

  test("another org's in-flight row on the same vehicle does not block; a same-org one does", async () => {
    const { t, orgId, userId, asUser, customerId } = await seedDealer("t2");
    const vehicleId = await seedVehicle(t, orgId, "IDXT2VEH00001");
    const quoteId = await seedQuote(t, { orgId, customerId, vehicleId, userId });

    // The OTHER org's in-flight row points at the same vehicle id.
    const otherOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Org t2", createdAt: Date.now() })
    );
    const otherCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId: otherOrgId, firstName: "Other", lastName: "Customer" })
    );
    const otherQuoteId = await seedQuote(t, {
      orgId: otherOrgId,
      customerId: otherCustomerId,
      vehicleId,
      userId,
    });
    await seedApplicationRow(t, {
      orgId: otherOrgId,
      customerId: otherCustomerId,
      vehicleId,
      quoteId: otherQuoteId,
      userId,
      status: "UNDER_REVIEW",
    });

    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    expect(applicationId).toBeTruthy();

    const secondQuote = await seedQuote(t, { orgId, customerId, vehicleId, userId });
    await expect(
      asUser.mutation(api.applications.createFromQuote, { orgId, quoteId: secondQuote })
    ).rejects.toThrow(/already has an active finance application/);
  });

  test("a same-org CLOSED row on the vehicle does not block", async () => {
    const { t, orgId, userId, asUser, customerId } = await seedDealer("t2b");
    const vehicleId = await seedVehicle(t, orgId, "IDXT2BVEH0001");
    const closedQuote = await seedQuote(t, { orgId, customerId, vehicleId, userId });
    await seedApplicationRow(t, { orgId, customerId, vehicleId, quoteId: closedQuote, userId, status: "CLOSED" });

    const quoteId = await seedQuote(t, { orgId, customerId, vehicleId, userId });
    await expect(
      asUser.mutation(api.applications.createFromQuote, { orgId, quoteId })
    ).resolves.toBeTruthy();
  });
});

describe("createFromQuote guarantor read", () => {
  test("deleted guarantors are excluded; absent and false isDeleted are both included", async () => {
    const { t, orgId, userId, asUser, customerId } = await seedDealer("t3");
    const vehicleId = await seedVehicle(t, orgId, "IDXT3VEH00001");
    const base = { orgId, customerId, lastName: "G", phone: "555-0100" };
    const { absentId, falseId } = await t.run(async (ctx) => {
      const absentId = await ctx.db.insert("guarantors", { ...base, firstName: "Absent", nationalId: "N-1111" });
      const falseId = await ctx.db.insert("guarantors", {
        ...base,
        firstName: "False",
        nationalId: "N-2222",
        isDeleted: false,
      });
      await ctx.db.insert("guarantors", { ...base, firstName: "Deleted", nationalId: "N-3333", isDeleted: true });
      return { absentId, falseId };
    });
    const quoteId = await seedQuote(t, { orgId, customerId, vehicleId, userId });

    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    const application = await t.run((ctx) => ctx.db.get(applicationId));
    const snapshot = application?.underwritingSnapshot?.guarantorsAtSubmission ?? [];

    expect(snapshot.map((g) => g.guarantorId).sort()).toEqual([absentId, falseId].sort());
    expect(snapshot.map((g) => g.firstName).sort()).toEqual(["Absent", "False"]);
  });
});

describe("createFromQuote vehicle valuation read", () => {
  /** A quote with `quoteCompany`, financed 15000, plus the given valuations on its vehicle. */
  async function createWithValuations(tag: string, vin: string, valuedCompanies: ("other" | "quote")[]) {
    const { t, orgId, userId, asUser, customerId } = await seedDealer(tag);
    const vehicleId = await seedVehicle(t, orgId, vin);
    const companies = {
      other: await seedCompany(t, orgId, "Other Finance"),
      quote: await seedCompany(t, orgId, "Quote Finance"),
    };
    for (const which of valuedCompanies) {
      await t.run((ctx) =>
        ctx.db.insert("vehicleValuations", {
          orgId,
          vehicleId,
          companyId: companies[which],
          valuationAmount: which === "other" ? 10000 : 20000,
        })
      );
    }
    const quoteId = await seedQuote(t, {
      orgId,
      customerId,
      vehicleId,
      userId,
      companyId: companies.quote,
      totalFinancedAmount: 15000,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    return (await t.run((ctx) => ctx.db.get(applicationId)))?.underwritingSnapshot;
  }

  test("only the quote company's valuation feeds vehicleValuation and ltv", async () => {
    // The other company's valuation is inserted FIRST, so it is first in index order.
    const snapshot = await createWithValuations("t4", "IDXT4VEH00001", ["other", "quote"]);

    expect(snapshot?.vehicleValuationAtSubmission).toBe(20000);
    expect(snapshot?.ltvAtSubmission).toBe(75);
  });

  test("with only another company's valuation, vehicleValuation and ltv are undefined", async () => {
    const snapshot = await createWithValuations("t4b", "IDXT4BVEH0001", ["other"]);

    expect(snapshot?.vehicleValuationAtSubmission).toBeUndefined();
    expect(snapshot?.ltvAtSubmission).toBeUndefined();
  });
});

describe("getActiveReceivableAllocations (via transferFinancedAmountFromCustomerReceivable)", () => {
  // `getActiveReceivableAllocations` is module-private; the exported transfer
  // observes the allocation set exactly (it sums it and derives the status).
  async function seedReceivable(t: TestConvex, seed: Awaited<ReturnType<typeof seedDealer>>, vin: string) {
    const { orgId, userId, customerId } = seed;
    const vehicleId = await seedVehicle(t, orgId, vin);
    return await t.run(async (ctx) => {
      const receivableDocumentId = await ctx.db.insert("receivableDocuments", {
        orgId,
        documentType: "INVOICE",
        documentNumber: `REC-${vin}`,
        payerType: "CUSTOMER",
        customerId,
        sourceType: "sales",
        sourceId: `sale-${vin}`,
        originalAmountMinor: 20_000_000,
        currency: "JOD",
        scale: 3,
        issueDate: Date.now(),
        dueDate: Date.now(),
        status: "OPEN",
        createdAt: Date.now(),
        createdBy: userId,
      });
      const paymentId = await ctx.db.insert("canonicalPayments", {
        orgId,
        direction: "IN",
        payerType: "CUSTOMER",
        customerId,
        method: "CASH",
        amountMinor: 9_000_000,
        currency: "JOD",
        scale: 3,
        status: "SETTLED",
        idempotencyKey: `idx-${vin}`,
        createdBy: userId,
        createdAt: Date.now(),
      });
      const saleId = await ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 20_000,
        saleDate: Date.now(),
        status: "COMPLETED",
        canonicalReceivableDocumentId: receivableDocumentId,
      });
      return { receivableDocumentId, paymentId, saleId };
    });
  }

  async function addAllocation(
    t: TestConvex,
    seed: Awaited<ReturnType<typeof seedDealer>>,
    ids: { receivableDocumentId: Id<"receivableDocuments">; paymentId: Id<"canonicalPayments"> },
    amountMinor: number,
    status: "ACTIVE" | "REVERSED"
  ) {
    await t.run((ctx) =>
      ctx.db.insert("paymentAllocations", {
        orgId: seed.orgId,
        paymentId: ids.paymentId,
        receivableDocumentId: ids.receivableDocumentId,
        amountMinor,
        currency: "JOD",
        scale: 3,
        allocationDate: Date.now(),
        status,
        createdBy: seed.userId,
        createdAt: Date.now(),
      })
    );
  }

  /** Seeds a receivable with the given allocations, transfers 17_000_000 of it to financing, returns the result row. */
  async function transferWith(tag: string, vin: string, allocations: { amountMinor: number; status: "ACTIVE" | "REVERSED" }[]) {
    const seed = await seedDealer(tag);
    const { t, orgId } = seed;
    const ids = await seedReceivable(t, seed, vin);
    for (const a of allocations) {
      await addAllocation(t, seed, ids, a.amountMinor, a.status);
    }
    await t.run((ctx) =>
      transferFinancedAmountFromCustomerReceivable(ctx, {
        orgId,
        saleId: ids.saleId,
        saleAmountMinor: 20_000_000,
        financedAmountMinor: 17_000_000,
      })
    );
    return await t.run((ctx) => ctx.db.get(ids.receivableDocumentId));
  }

  test("a REVERSED allocation is ignored; the ACTIVE ones alone set the status", async () => {
    // The REVERSED amount exceeds the non-financed balance: counted, it would throw "exceed".
    const receivable = await transferWith("t5", "IDXT5VEH00001", [
      { amountMinor: 1_000_000, status: "ACTIVE" },
      { amountMinor: 5_000_000, status: "REVERSED" },
    ]);

    expect(receivable?.originalAmountMinor).toBe(3_000_000);
    expect(receivable?.status).toBe("PARTIALLY_PAID");
  });

  test("with only a REVERSED allocation the receivable is OPEN, not partially paid", async () => {
    const receivable = await transferWith("t5b", "IDXT5BVEH0001", [{ amountMinor: 2_000_000, status: "REVERSED" }]);

    expect(receivable?.status).toBe("OPEN");
  });
});
