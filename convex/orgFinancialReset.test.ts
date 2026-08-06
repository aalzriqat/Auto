import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { RESET_TABLES_FOR_TEST } from "./orgFinancialReset";

/**
 * This deletes production rows with no undo, so the tests are about what it
 * must NOT touch at least as much as what it removes.
 */

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

function setup() {
  return convexTestWithComponents(schema, MODULES);
}

/** Seeds one org with a row in each of three reset tables plus protected rows. */
async function seedOrg(t: ReturnType<typeof setup>, name: string) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name, createdAt: Date.now() })
  );

  await t.run(async (ctx) => {
    await ctx.db.insert("chartOfAccounts", {
      orgId,
      code: "1000",
      name: "Cash",
      type: "ASSET" as const,
      normalBalance: "DEBIT" as const,
      isControlAccount: false,
      allowManualPosting: true,
      active: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("transactions", {
      orgId,
      type: "IN" as const,
      amount: 1000,
      date: Date.now(),
      category: "VEHICLE_SALE" as const,
      description: "sale",
    });
    await ctx.db.insert("expenses", {
      orgId,
      title: "Office supplies",
      amount: 50,
      date: Date.now(),
      category: "OTHER" as const,
    });

    // Protected: must survive the reset.
    await ctx.db.insert("vehicles", {
      orgId,
      make: "Toyota",
      model: "Corolla",
      year: 2020,
      vin: `VIN${name}`,
      mileage: 1000,
      color: "White",
      fuelType: "PETROL",
      transmission: "AUTOMATIC",
      sellingPrice: 10000,
      status: "SOLD" as const,
    });
    await ctx.db.insert("customers", { orgId, firstName: "Keep", lastName: "Me" });
  });

  return orgId;
}

async function countFor(
  t: ReturnType<typeof setup>,
  table: "chartOfAccounts" | "transactions" | "expenses" | "vehicles" | "customers",
  orgId: Id<"organizations">,
) {
  const rows = await t.run((ctx) =>
    ctx.db
      .query(table)
      .filter((q) => q.eq(q.field("orgId"), orgId))
      .collect()
  );
  return rows.length;
}

describe("resetOrgFinancialData", () => {
  test("defaults to a dry run and destroys nothing", async () => {
    // The safe form has to be the default: a caller who forgets the flag gets
    // a report, not a deletion.
    const t = setup();
    const orgId = await seedOrg(t, "Dry Run Motors");

    const result = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId,
    });

    expect(result.dryRun).toBe(true);
    expect(result.orgName).toBe("Dry Run Motors");
    expect(result.total).toBe(3);
    expect(result.perTable).toEqual({ chartOfAccounts: 1, transactions: 1, expenses: 1 });

    // Everything still there.
    expect(await countFor(t, "chartOfAccounts", orgId)).toBe(1);
    expect(await countFor(t, "transactions", orgId)).toBe(1);
    expect(await countFor(t, "expenses", orgId)).toBe(1);
  });

  test("with dryRun false, removes the listed tables and nothing else", async () => {
    const t = setup();
    const orgId = await seedOrg(t, "Reset Motors");

    const result = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId,
      dryRun: false,
    });
    expect(result.total).toBe(3);
    expect(result.remaining).toBe(0);

    expect(await countFor(t, "chartOfAccounts", orgId)).toBe(0);
    expect(await countFor(t, "transactions", orgId)).toBe(0);
    expect(await countFor(t, "expenses", orgId)).toBe(0);

    // Inventory and CRM are explicitly out of scope.
    expect(await countFor(t, "vehicles", orgId)).toBe(1);
    expect(await countFor(t, "customers", orgId)).toBe(1);
  });

  test("never touches another organization's rows", async () => {
    // The failure that would matter most: a reset for one dealership reaching
    // into another's books.
    const t = setup();
    const target = await seedOrg(t, "Target Motors");
    const bystander = await seedOrg(t, "Bystander Motors");

    await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId: target,
      dryRun: false,
    });

    expect(await countFor(t, "chartOfAccounts", target)).toBe(0);
    expect(await countFor(t, "transactions", bystander)).toBe(1);
    expect(await countFor(t, "chartOfAccounts", bystander)).toBe(1);
    expect(await countFor(t, "expenses", bystander)).toBe(1);
  });

  test("leaves vehicle status alone, including SOLD with no sale behind it", async () => {
    // Accepted inconsistency, chosen deliberately — pinned so a later edit
    // cannot quietly start rewriting inventory.
    const t = setup();
    const orgId = await seedOrg(t, "Status Motors");

    await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId,
      dryRun: false,
    });

    const vehicles = await t.run((ctx) =>
      ctx.db
        .query("vehicles")
        .filter((q) => q.eq(q.field("orgId"), orgId))
        .collect()
    );
    expect(vehicles).toHaveLength(1);
    expect(vehicles[0].status).toBe("SOLD");
  });

  test("deletes an appraisal's stored report rather than orphaning it", async () => {
    const t = setup();
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Blob Motors", createdAt: Date.now() })
    );
    const blobId = await t.run((ctx) => ctx.storage.store(new Blob(["appraisal.pdf"])));

    const appraisalId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "reset_u1", email: "u@x.com" });
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId, vin: "VINRESET1", make: "Toyota", model: "Camry", year: 2024, mileage: 10,
        color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 20000,
        status: "AVAILABLE",
      });
      const customerId = await ctx.db.insert("customers", {
        orgId, firstName: "Reset", lastName: "Customer",
      });
      const quoteId = await ctx.db.insert("quotes", {
        orgId, customerId, vehicleId, vehiclePrice: 20000, downPayment: 2000,
        termMonths: 48, status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
      });
      const applicationId = await ctx.db.insert("financeApplications", {
        orgId, quoteId, customerId, vehicleId, salespersonId: userId,
        status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
      });
      return await ctx.db.insert("financeAppraisals", {
        orgId, applicationId, vehicleId, appraisalAmountMinor: 12_500_000,
        currency: "JOD", providerType: "FINANCE_COMPANY", appraisedAt: Date.now(),
        documentStorageIds: [blobId], isReappraisal: false, status: "APPROVED",
        recordedBy: userId, recordedAt: Date.now(),
      });
    });

    await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId,
      dryRun: false,
    });

    // An orphaned row is recoverable. A blob with nothing referencing it is
    // not enumerable, not deletable by any code path, and billed indefinitely —
    // and this one is the finance company's report on a customer's vehicle.
    expect(await t.run((ctx) => ctx.db.get(appraisalId))).toBeNull();
    expect(await t.run((ctx) => ctx.storage.getUrl(blobId))).toBeNull();
  });

  test("the signed-off scope excludes inventory, CRM, people and org config", async () => {
    // A guard on the constant itself. Adding a table here is a decision that
    // should fail this test and be made on purpose, not slipped in.
    const forbidden = [
      "vehicles",
      "vehicleValuations",
      "customers",
      "leads",
      "memberships",
      "roles",
      "orgSettings",
      "subscriptions",
      "branches",
      "bankAccounts",
      "financeCompanies",
      "orgValuationCompanies",
      "organizations",
    ];
    for (const table of forbidden) {
      expect(RESET_TABLES_FOR_TEST).not.toContain(table);
    }
    // 26 -> 28: `financeAppraisals` and `financeApplicationOverrides` were added
    // deliberately. They are children of `financeApplications`, which the reset
    // already clears, so leaving them out orphaned every appraisal and every
    // money-change audit row against an application id that no longer resolves
    // — and, for appraisals, left `_storage` blobs with nothing referencing
    // them. They are listed immediately before their parent so a run that stops
    // between batches never leaves a child without one. The financeCompanies
    // row itself is still deliberately out of scope, as `forbidden` pins above.
    expect(RESET_TABLES_FOR_TEST).toHaveLength(28);
  });
});
