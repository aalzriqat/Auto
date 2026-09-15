import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, PERMISSIONS } from "./utils/permissions";
import { MAX_DEAL_CUSTODY_DECISION_RECORDS, MAX_DEAL_CUSTODY_RECORDS } from "./financeDealCosts";

/**
 * The bounded custody read (`listDealCosts.custody`) and the paginated
 * movement log (`listCustodyMovements`) that replaced hydrating every movement
 * of every custody record inside the deal read.
 */

type TestConvex = ConvexTestInstance<typeof schema>;
type AuthenticatedTestConvex = ReturnType<TestConvex["withIdentity"]>;
const MODULES = import.meta.glob("./**/*.*s");
const jod = (major: number): number => Math.round(major * 1000);

interface Seed {
  t: TestConvex;
  orgId: Id<"organizations">;
  otherOrgId: Id<"organizations">;
  userId: Id<"users">;
  employeeId: Id<"users">;
  applicationId: Id<"financeApplications">;
  asUser: AuthenticatedTestConvex;
}

async function seedDeal(suffix = "1"): Promise<Seed> {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `CM Dealer ${suffix}`, createdAt: Date.now() }));
  const otherOrgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `CM Other ${suffix}`, createdAt: Date.now() }));
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `cm_user_${suffix}`, email: `cm${suffix}@x.com`, name: "Rana" }));
  const employeeId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `cm_emp_${suffix}`, email: `cme${suffix}@x.com`, name: "Rami" }));
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: employeeId, roleId }));
  const applicationId = await t.run(async (ctx) => {
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: `CMVIN${suffix}`, make: "Toyota", model: "Camry", year: 2024,
      mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
      sellingPrice: 10_500, status: "AVAILABLE",
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "CM", lastName: "Customer" });
    const quoteId = await ctx.db.insert("quotes", {
      orgId, customerId, vehicleId, vehiclePrice: 10_500, downPayment: 500,
      termMonths: 48, status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
    });
    return await ctx.db.insert("financeApplications", {
      orgId, quoteId, customerId, vehicleId, salespersonId: userId,
      status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
    });
  });
  const asUser = t.withIdentity({ subject: `cm_user_${suffix}` });
  // Custody money commands post to the ledger and refuse without a chart
  // (`assertCustodyAccountingReady`); no period is opened, so postings queue.
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  return { t, orgId, otherOrgId, userId, employeeId, applicationId, asUser };
}

async function openCustody(seed: Seed, issued = jod(700)) {
  return await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
    idempotencyKey: crypto.randomUUID(),
    orgId: seed.orgId,
    applicationId: seed.applicationId,
    userId: seed.employeeId,
    issuedMinor: issued,
    method: "CASH",
    reference: "CV-1",
  });
}

async function move(seed: Seed, custodyId: Id<"financeDealCustody">, kind: "ISSUED" | "RETURNED" | "REIMBURSED", amountMinor: number) {
  await seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
    orgId: seed.orgId, custodyId, kind, amountMinor, idempotencyKey: crypto.randomUUID(),
  });
}

describe("the deal read serves the custody SUMMARY only, by name, bounded", () => {
  test("names the holder and carries no movement log", async () => {
    const seed = await seedDeal();
    const custodyId = await openCustody(seed);
    await move(seed, custodyId, "RETURNED", jod(100));
    const costs = await seed.asUser.query(api.financeDealCosts.listDealCosts, { orgId: seed.orgId, applicationId: seed.applicationId });
    expect(costs.custody).toHaveLength(1);
    expect(costs.custody[0]._id).toBe(custodyId);
    expect(costs.custody[0].userName).toBe("Rami");
    expect(costs.custody[0].issuedMinor).toBe(jod(700));
    expect(costs.custody[0].returnedMinor).toBe(jod(100));
    expect(costs.custody[0].summary?.employeeOwesDealerMinor).toBe(jod(600));
    expect(costs.custodyTruncated).toBe(false);
    expect("entries" in costs.custody[0]).toBe(false);
  });

  test("past the cap the list is a prefix and says so", async () => {
    const seed = await seedDeal("2");
    // Rows written directly: the product refuses a second OPEN custody per
    // person, and the cap is about what a READ can carry, not about product rules.
    await seed.t.run(async (ctx) => {
      for (let i = 0; i <= MAX_DEAL_CUSTODY_RECORDS; i += 1) {
        await ctx.db.insert("financeDealCustody", {
          orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.employeeId, currency: "JOD",
          issuedMinor: 0, returnedMinor: 0, reimbursedMinor: 0, status: "RECONCILED",
          createdBy: seed.userId, createdAt: Date.now() + i, updatedAt: Date.now() + i,
        });
      }
    });
    const costs = await seed.asUser.query(api.financeDealCosts.listDealCosts, { orgId: seed.orgId, applicationId: seed.applicationId });
    expect(costs.custody).toHaveLength(MAX_DEAL_CUSTODY_RECORDS);
    expect(costs.custodyTruncated).toBe(true);
  });
});

describe("writer guards enumerate every custody record, never a bounded prefix", () => {
  test("the one-open-record rule still sees an open custody sitting past the read cap", async () => {
    const seed = await seedDeal("5");
    // MAX closed rows first, then ONE open row for the same employee — the
    // (MAX + 1)th record. A writer reading a capped prefix would not see it.
    await seed.t.run(async (ctx) => {
      for (let i = 0; i < MAX_DEAL_CUSTODY_RECORDS; i += 1) {
        await ctx.db.insert("financeDealCustody", {
          orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.employeeId, currency: "JOD",
          issuedMinor: 0, returnedMinor: 0, reimbursedMinor: 0, status: "RECONCILED",
          createdBy: seed.userId, createdAt: Date.now() + i, updatedAt: Date.now() + i,
        });
      }
      await ctx.db.insert("financeDealCustody", {
        orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.employeeId, currency: "JOD",
        issuedMinor: 100, returnedMinor: 0, reimbursedMinor: 0, status: "OPEN",
        createdBy: seed.userId, createdAt: Date.now() + 100, updatedAt: Date.now() + 100,
      });
    });
    // The screen read is a prefix and says so...
    const costs = await seed.asUser.query(api.financeDealCosts.listDealCosts, { orgId: seed.orgId, applicationId: seed.applicationId });
    expect(costs.custodyTruncated).toBe(true);
    // ...but the writer is not: it refuses a second open custody for this person.
    await expect(openCustody(seed)).rejects.toThrow(/already holds an open custody/);
    // And the adoption precondition sees the custody rows too.
    expect(costs.expected.adoption.state).not.toBe("AVAILABLE");
  });
});

describe("writer decision reads are bounded at MAX_DEAL_CUSTODY_DECISION_RECORDS, and refuse rather than truncate past it", () => {
  async function closedRecords(seed: Seed, count: number) {
    await seed.t.run(async (ctx) => {
      for (let i = 0; i < count; i += 1) {
        await ctx.db.insert("financeDealCustody", {
          orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.employeeId, currency: "JOD",
          issuedMinor: 0, returnedMinor: 0, reimbursedMinor: 0, status: "RECONCILED",
          createdBy: seed.userId, createdAt: Date.now() + i, updatedAt: Date.now() + i,
        });
      }
    });
  }
  const countRecords = (seed: Seed) =>
    seed.t.run(async (ctx) =>
      (await ctx.db.query("financeDealCustody").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).collect()).length
    );

  test("AT the cap: opening custody still enumerates every record and works", async () => {
    const seed = await seedDeal("cap");
    await closedRecords(seed, MAX_DEAL_CUSTODY_DECISION_RECORDS);
    const custodyId = await openCustody(seed);
    expect(custodyId).toBeTruthy();
    expect(await countRecords(seed)).toBe(MAX_DEAL_CUSTODY_DECISION_RECORDS + 1);
  });

  test("PAST the cap: opening custody is refused with the reason and writes nothing — not decided on a prefix", async () => {
    const seed = await seedDeal("cap-plus");
    await closedRecords(seed, MAX_DEAL_CUSTODY_DECISION_RECORDS + 1);
    await expect(openCustody(seed)).rejects.toThrow(new RegExp(`more than ${MAX_DEAL_CUSTODY_DECISION_RECORDS} custody records`));
    expect(await countRecords(seed)).toBe(MAX_DEAL_CUSTODY_DECISION_RECORDS + 1);
    const entries = await seed.t.run((ctx) => ctx.db.query("financeDealCustodyEntries").withIndex("by_org", (q) => q.eq("orgId", seed.orgId)).collect());
    expect(entries).toEqual([]);
  });

  test("PAST the cap: the deal's denomination proof (every cost writer) is refused with the same reason and writes no line", async () => {
    const seed = await seedDeal("cap-currency");
    await closedRecords(seed, MAX_DEAL_CUSTODY_DECISION_RECORDS + 1);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordDealFee, {
        expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId,
        feeType: "LICENSING", paidBy: "DEALER", paidTo: "GOVERNMENT", accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE", actualAmountMinor: jod(90),
      })
    ).rejects.toThrow(new RegExp(`more than ${MAX_DEAL_CUSTODY_DECISION_RECORDS} custody records`));
    const fees = await seed.t.run((ctx) =>
      ctx.db.query("financeDealFees").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).collect()
    );
    expect(fees).toEqual([]);
  });

  test("PAST the cap: classification is refused with the same reason before any stamp", async () => {
    const seed = await seedDeal("cap-classify");
    await seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId: seed.orgId, applicationId: seed.applicationId,
      legalInvoiceAmountMinor: jod(10_500), legalInvoiceNumber: "INV-1", legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY",
    });
    const feeId = await seed.asUser.mutation(api.financeDealCosts.recordDealFee, {
      expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId,
      feeType: "LICENSING", paidBy: "DEALER", paidTo: "GOVERNMENT", accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE", actualAmountMinor: jod(90),
    });
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, { orgId: seed.orgId, feeId, notes: "matched" });
    await closedRecords(seed, MAX_DEAL_CUSTODY_DECISION_RECORDS + 1);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, { orgId: seed.orgId, applicationId: seed.applicationId, notes: "on file" })
    ).rejects.toThrow(new RegExp(`more than ${MAX_DEAL_CUSTODY_DECISION_RECORDS} custody records`));
    const app = (await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))!;
    expect(app.accountingClassification).not.toBe("CLASSIFIED");
    expect(app.accountingClassifiedAt).toBeUndefined();
  });
});

describe("listCustodyMovements", () => {
  test("pages the log oldest first and marks a reversed movement, across pages", async () => {
    const seed = await seedDeal("3");
    const custodyId = await openCustody(seed);
    await move(seed, custodyId, "RETURNED", jod(100));
    await move(seed, custodyId, "RETURNED", jod(50));
    const entries = await seed.t.run((ctx) =>
      ctx.db.query("financeDealCustodyEntries").withIndex("by_custody", (q) => q.eq("custodyId", custodyId)).collect()
    );
    const secondReturn = entries.find((e) => e.kind === "RETURNED" && e.amountMinor === jod(50))!;
    await seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
      orgId: seed.orgId, custodyId, kind: "REVERSAL", reversesEntryId: secondReturn._id,
      amountMinor: jod(50), idempotencyKey: crypto.randomUUID(),
    });

    const first = await seed.asUser.query(api.financeDealCosts.listCustodyMovements, {
      orgId: seed.orgId, custodyId, paginationOpts: { numItems: 3, cursor: null },
    });
    expect(first.page.map((e) => e.kind)).toEqual(["ISSUED", "RETURNED", "RETURNED"]);
    expect(first.page[0].recordedByName).toBe("Rana");
    expect(first.page[0].reference).toBe("CV-1");
    // The reversal is on the NEXT page, and the reversed row still knows.
    expect(first.page[1].reversed).toBe(false);
    expect(first.page[2].reversed).toBe(true);
    expect(first.isDone).toBe(false);

    const second = await seed.asUser.query(api.financeDealCosts.listCustodyMovements, {
      orgId: seed.orgId, custodyId, paginationOpts: { numItems: 3, cursor: first.continueCursor },
    });
    expect(second.page.map((e) => e.kind)).toEqual(["REVERSAL"]);
    expect(second.page[0].reversesEntryId).toBe(secondReturn._id);
    expect(second.page[0].reversed).toBe(false);
    expect(second.isDone).toBe(true);
  });

  test("refuses a custody record of another org, and a caller without the read permission", async () => {
    const seed = await seedDeal("4");
    const custodyId = await openCustody(seed);
    const foreign = await seed.t.run((ctx) =>
      ctx.db.insert("financeDealCustody", {
        orgId: seed.otherOrgId, applicationId: seed.applicationId, userId: seed.employeeId, currency: "JOD",
        issuedMinor: 0, returnedMinor: 0, reimbursedMinor: 0, status: "RECONCILED",
        createdBy: seed.userId, createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    await expect(
      seed.asUser.query(api.financeDealCosts.listCustodyMovements, {
        orgId: seed.orgId, custodyId: foreign, paginationOpts: { numItems: 10, cursor: null },
      })
    ).rejects.toThrow();

    const viewerId = await seed.t.run((ctx) => ctx.db.insert("users", { clerkId: "cm_viewer", email: "v@x.com" }));
    const roleId = await seed.t.run((ctx) => ctx.db.insert("roles", { orgId: seed.orgId, name: "SALES", permissions: [PERMISSIONS.VIEW_SALES] }));
    await seed.t.run((ctx) => ctx.db.insert("memberships", { orgId: seed.orgId, userId: viewerId, roleId }));
    await expect(
      seed.t.withIdentity({ subject: "cm_viewer" }).query(api.financeDealCosts.listCustodyMovements, {
        orgId: seed.orgId, custodyId, paginationOpts: { numItems: 10, cursor: null },
      })
    ).rejects.toThrow();
  });
});
