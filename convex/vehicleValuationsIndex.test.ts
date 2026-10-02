/**
 * SCRUM-557 — the vehicleValuations (org, vehicle, company) lookups read through
 * one tenant-led index, `by_org_vehicle_company`.
 *
 * Invariants under test:
 *  I1  a lookup selects the EARLIEST-created row for (org, vehicle, company);
 *  I2  a row stamped with another org is never selected or patched;
 *  I4  listValuations returns the org's rows in creation order, as before.
 *
 * Evidence boundary: convex-test only — repository behaviour, not the Convex
 * runtime, not production data.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

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
    permissions: ["create:sales", "view:sales", "view:vehicles", "view:customers", "edit:vehicle_valuations"],
    orgName: `ValIdx Dealer ${tag}`,
    roleName: "Sales",
  });
  const otherOrgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `ValIdx Other ${tag}`, createdAt: Date.now() })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Val", lastName: "Customer" })
  );
  return { t, orgId, otherOrgId, userId, asUser, customerId };
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

function insertValuation(
  t: TestConvex,
  row: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    companyId: Id<"financeCompanies">;
    valuationAmount: number;
  }
) {
  return t.run((ctx) => ctx.db.insert("vehicleValuations", row));
}

function rowsFor(t: TestConvex, vehicleId: Id<"vehicles">) {
  return t.run(async (ctx) =>
    (await ctx.db.query("vehicleValuations").collect())
      .filter((row) => row.vehicleId === vehicleId)
      .sort((a, b) => a._creationTime - b._creationTime)
  );
}

describe("saveValuation (by org + vehicle + company)", () => {
  test("CHARACTERIZATION: no match inserts; a second save for the same (vehicle, company) patches the SAME row", async () => {
    const { t, orgId, asUser } = await seedDealer("s1");
    const vehicleId = await seedVehicle(t, orgId, "VALS1VEH000001");
    const companyId = await seedCompany(t, orgId, "Finance A");

    const first = await asUser.mutation(api.finance.saveValuation, {
      orgId, vehicleId, companyId, valuationAmount: 10_000,
    });
    const second = await asUser.mutation(api.finance.saveValuation, {
      orgId, vehicleId, companyId, valuationAmount: 12_000,
    });

    expect(second).toBe(first);
    const rows = await rowsFor(t, vehicleId);
    expect(rows).toHaveLength(1);
    expect(rows[0].valuationAmount).toBe(12_000);
  });

  test("CHARACTERIZATION: same vehicle, different company is a separate row", async () => {
    const { t, orgId, asUser } = await seedDealer("s2");
    const vehicleId = await seedVehicle(t, orgId, "VALS2VEH000001");
    const companyA = await seedCompany(t, orgId, "Finance A");
    const companyB = await seedCompany(t, orgId, "Finance B");

    const a = await asUser.mutation(api.finance.saveValuation, {
      orgId, vehicleId, companyId: companyA, valuationAmount: 10_000,
    });
    const b = await asUser.mutation(api.finance.saveValuation, {
      orgId, vehicleId, companyId: companyB, valuationAmount: 11_000,
    });

    expect(b).not.toBe(a);
    expect(await rowsFor(t, vehicleId)).toHaveLength(2);
  });

  test("CHARACTERIZATION: with two pre-existing rows for the same (org, vehicle, company) the EARLIER one is patched", async () => {
    const { t, orgId, asUser } = await seedDealer("s3");
    const vehicleId = await seedVehicle(t, orgId, "VALS3VEH000001");
    const companyId = await seedCompany(t, orgId, "Finance A");
    const earlier = await insertValuation(t, { orgId, vehicleId, companyId, valuationAmount: 1_000 });
    const later = await insertValuation(t, { orgId, vehicleId, companyId, valuationAmount: 2_000 });

    const patched = await asUser.mutation(api.finance.saveValuation, {
      orgId, vehicleId, companyId, valuationAmount: 9_000,
    });

    expect(patched).toBe(earlier);
    const [earlierRow, laterRow] = await t.run(async (ctx) => [await ctx.db.get(earlier), await ctx.db.get(later)]);
    expect(earlierRow?.valuationAmount).toBe(9_000);
    expect(laterRow?.valuationAmount).toBe(2_000);
  });

  test("TENANT: a same-(vehicle, company) row stamped with another org is NOT patched; a new row is inserted for the caller", async () => {
    const { t, orgId, otherOrgId, asUser } = await seedDealer("s4");
    const vehicleId = await seedVehicle(t, orgId, "VALS4VEH000001");
    const companyId = await seedCompany(t, orgId, "Finance A");
    // Created FIRST, so the old by_vehicle + companyId read would have found it.
    const foreign = await insertValuation(t, { orgId: otherOrgId, vehicleId, companyId, valuationAmount: 777 });

    const saved = await asUser.mutation(api.finance.saveValuation, {
      orgId, vehicleId, companyId, valuationAmount: 5_000,
    });

    expect(saved).not.toBe(foreign);
    const foreignRow = await t.run((ctx) => ctx.db.get(foreign));
    expect(foreignRow?.valuationAmount).toBe(777);
    expect(foreignRow?.orgId).toBe(otherOrgId);
    const savedRow = await t.run((ctx) => ctx.db.get(saved));
    expect(savedRow).toMatchObject({ orgId, vehicleId, companyId, valuationAmount: 5_000 });
  });
});

describe("listValuations (by org + vehicle)", () => {
  test("returns the org's rows in creation order and excludes another org's row on the same vehicle", async () => {
    const { t, orgId, otherOrgId, asUser } = await seedDealer("l1");
    const vehicleId = await seedVehicle(t, orgId, "VALL1VEH000001");
    const companies = [
      await seedCompany(t, orgId, "Finance A"),
      await seedCompany(t, orgId, "Finance B"),
      await seedCompany(t, orgId, "Finance C"),
    ];
    // Insert in the REVERSE of companyId order, so index (companyId) order and
    // creation order disagree: the sort in listValuations is what is under test.
    const creationOrder = [...companies].sort().reverse();
    const expectedIds: Id<"vehicleValuations">[] = [];
    for (const [index, companyId] of creationOrder.entries()) {
      expectedIds.push(await insertValuation(t, { orgId, vehicleId, companyId, valuationAmount: 1_000 * (index + 1) }));
    }
    await insertValuation(t, { orgId: otherOrgId, vehicleId, companyId: companies[0], valuationAmount: 999 });

    const listed = await asUser.query(api.finance.listValuations, { orgId, vehicleId });

    expect(listed.map((row) => row._id)).toEqual(expectedIds);
    expect(listed.every((row) => row.orgId === orgId)).toBe(true);
    expect(listed).toHaveLength(3);
  });
});

describe("createFromQuote valuation read (tenant-led index)", () => {
  async function createWithForeignValuation(tag: string, vin: string) {
    const { t, orgId, otherOrgId, userId, asUser, customerId } = await seedDealer(tag);
    const vehicleId = await seedVehicle(t, orgId, vin);
    const companyId = await seedCompany(t, orgId, "Quote Finance");
    // A valuation for the quote's own (vehicle, company) but stamped with ANOTHER org.
    await insertValuation(t, { orgId: otherOrgId, vehicleId, companyId, valuationAmount: 20_000 });
    const quoteId = await t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId,
        customerId,
        vehicleId,
        vehiclePrice: 22000,
        downPayment: 2000,
        termMonths: 48,
        status: "ACCEPTED",
        createdBy: userId,
        createdAt: Date.now(),
        monthlyInstallment: 500,
        companyId,
        mode: "CONFIGURED_FINANCE_COMPANY" as const,
        totalFinancedAmount: 15000,
      })
    );
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    return (await t.run((ctx) => ctx.db.get(applicationId)))?.underwritingSnapshot;
  }

  test("TENANT: another org's valuation for the same (vehicle, company) is not used", async () => {
    const snapshot = await createWithForeignValuation("c1", "VALC1VEH000001");

    expect(snapshot?.vehicleValuationAtSubmission).toBeUndefined();
    expect(snapshot?.ltvAtSubmission).toBeUndefined();
  });
  // The match / other-company / none paths are covered by the existing
  // "createFromQuote vehicle valuation read" suite in applicationsIndexReads.test.ts.
});

describe("listQuotesByCustomer (by customer, org filtered in JS)", () => {
  test("a quote of the same customerId stamped with another org is excluded; order is creation order", async () => {
    const { t, orgId, otherOrgId, userId, asUser, customerId } = await seedDealer("q1");
    const vehicleId = await seedVehicle(t, orgId, "VALQ1VEH000001");
    const base = {
      customerId,
      vehicleId,
      vehiclePrice: 22000,
      downPayment: 2000,
      termMonths: 48,
      status: "DRAFT" as const,
      createdBy: userId,
      createdAt: Date.now(),
    };
    const ids = await t.run(async (ctx) => {
      const first = await ctx.db.insert("quotes", { ...base, orgId });
      // Direct insert: customer ids are org-scoped, so no public API builds this row.
      await ctx.db.insert("quotes", { ...base, orgId: otherOrgId });
      const second = await ctx.db.insert("quotes", { ...base, orgId });
      return [first, second];
    });

    const listed = await asUser.query(api.quotes.listQuotesByCustomer, { orgId, customerId });

    expect(listed.map((quote) => quote._id)).toEqual(ids);
  });
});
