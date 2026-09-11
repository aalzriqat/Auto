/**
 * Retry boundaries for the commands brought into the protected topology by the
 * SCRUM-313 census (owner ruling: scope A, mechanism C).
 *
 * Each test asks the only question that matters operationally: the operator's
 * response was lost and they submitted again — did the dealership just pay,
 * capitalize, or owe TWICE?
 *
 * The two state-guarded commands are proved here rather than asserted, because
 * the owner overruled my HIGH on `workOrders.update` and a classification that
 * nobody has watched hold is not evidence.
 *
 * EVIDENCE BOUNDARY: `convex-test` is repository behaviour. It is NOT Convex
 * runtime parity and NOT data parity — in particular it serialises everything
 * and models no OCC, so none of this proves anything about two CONCURRENT
 * submissions. It proves the sequential lost-response retry, which is the case
 * these guards exist for.
 */
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.ts");

async function freshOrg(suffix: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  registerRateLimiter(t);
  const orgId = (await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Retry ${suffix}`, createdAt: Date.now() })
  )) as Id<"organizations">;
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = (await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `rt_${suffix}`, email: `${suffix}@retry.test`, name: "Owner" })
  )) as Id<"users">;
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "OWNER", isSystemOwnerRole: true,
      permissions: ["view:finance", "manage:finance", "create:vehicles", "edit:vehicles", "view:sales"],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "USD", currencySymbol: "$",
      enabledPaymentTypes: ["CASH", "CHEQUE", "BANK_TRANSFER"],
    })
  );
  const asAdmin = t.withIdentity({ subject: `rt_${suffix}`, clerkId: `rt_${suffix}` });
  await asAdmin.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await asAdmin.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    fiscalYear: year,
    periodNumber: 1,
  });
  const period = (await asAdmin.query(api.accountingPeriods.list, { orgId }))[0];
  await asAdmin.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  return { t, asAdmin, orgId, userId };
}

/** How many rows this org holds in a table — the duplicate detector. */
async function countRows(t: any, orgId: Id<"organizations">, table: string) {
  return await t.run(async (ctx: any) => {
    const rows = await ctx.db.query(table).collect();
    return rows.filter((r: any) => r.orgId === orgId).length;
  });
}

async function countJournals(t: any, orgId: Id<"organizations">) {
  return await countRows(t, orgId, "journalEntries");
}

describe("SCRUM-313 · identity-guarded creation commands survive a lost-response retry", () => {
  test("fixedAssets.capitalize: the same intent capitalizes ONE asset and posts ONE journal", async () => {
    const { t, asAdmin, orgId } = await freshOrg("cap");
    const key = crypto.randomUUID();
    const args = {
      idempotencyKey: key,
      orgId,
      name: "Ramp lift",
      purchaseDate: Date.now(),
      costMinor: 500_000,
      usefulLifeMonths: 60,
      paymentMethod: "CASH" as const,
    };
    const first = await asAdmin.mutation(api.fixedAssets.capitalize, args);
    const journalsAfterFirst = await countJournals(t, orgId);

    // The lost response: the operator submits the identical intent again.
    const second = await asAdmin.mutation(api.fixedAssets.capitalize, args);

    expect(second).toBe(first);
    expect(await countRows(t, orgId, "fixedAssets")).toBe(1);
    expect(await countJournals(t, orgId)).toBe(journalsAfterFirst);
  });

  test("partnerEquity.add: a retry creates ONE partner and ONE contribution posting", async () => {
    const { t, asAdmin, orgId } = await freshOrg("pe");
    const args = {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      partnerName: "A. Partner",
      openingContributionMinor: 250_000,
      paymentMethod: "CASH" as const,
    };
    const first = await asAdmin.mutation(api.partnerEquity.add, args);
    const journals = await countJournals(t, orgId);

    const second = await asAdmin.mutation(api.partnerEquity.add, args);

    expect(second).toBe(first);
    expect(await countRows(t, orgId, "partnerEquity")).toBe(1);
    expect(await countRows(t, orgId, "partnerEquityTransactions")).toBe(1);
    expect(await countJournals(t, orgId)).toBe(journals);
  });

  test("partnerEquity.add is guarded even with NO opening capital", async () => {
    // The command is only conditionally economic, but identity is unconditional:
    // a runtime condition cannot be expressed by a compile-time discriminant,
    // and the duplicate partner row is worth preventing on its own.
    const { t, asAdmin, orgId } = await freshOrg("pe0");
    const args = { idempotencyKey: crypto.randomUUID(), orgId, partnerName: "No Capital" };
    const first = await asAdmin.mutation(api.partnerEquity.add, args);
    const second = await asAdmin.mutation(api.partnerEquity.add, args);
    expect(second).toBe(first);
    expect(await countRows(t, orgId, "partnerEquity")).toBe(1);
  });

  test("partnerEquity.recordEquityMovement: a retried draw is not taken twice", async () => {
    const { t, asAdmin, orgId } = await freshOrg("mv");
    const partnerId = await asAdmin.mutation(api.partnerEquity.add, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      partnerName: "Movement Partner",
      openingContributionMinor: 1_000_000,
      paymentMethod: "CASH" as const,
    });
    const before = await countRows(t, orgId, "partnerEquityTransactions");

    const args = {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      partnerId: partnerId as Id<"partnerEquity">,
      type: "DRAW" as const,
      amountMinor: 100_000,
      paymentMethod: "CASH" as const,
    };
    const first = await asAdmin.mutation(api.partnerEquity.recordEquityMovement, args);
    const second = await asAdmin.mutation(api.partnerEquity.recordEquityMovement, args);

    expect(second).toBe(first);
    // Exactly ONE new movement. The DRAW balance check is not a retry barrier —
    // a repeated draw of 100,000 against 1,000,000 would pass it twice.
    expect(await countRows(t, orgId, "partnerEquityTransactions")).toBe(before + 1);
  });

  test("vehicles.create: a retry capitalizes ONE car, not two", async () => {
    const { t, asAdmin, orgId } = await freshOrg("veh");
    const args = {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      vin: "1HGCM82633A00001",
      make: "Toyota",
      model: "Camry",
      year: 2024,
      mileage: 100,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      sellingPrice: 30_000,
      purchasePrice: 25_000,
      purchasePaymentMethod: "CASH" as const,
      sourceType: "STOCK" as const,
      status: "AVAILABLE" as const,
    };
    const first = await asAdmin.mutation(api.vehicles.create, args);
    const journals = await countJournals(t, orgId);

    const second = await asAdmin.mutation(api.vehicles.create, args);

    expect(second).toBe(first);
    expect(await countRows(t, orgId, "vehicles")).toBe(1);
    // The acquisition posted once. Without identity the retry would mint a new
    // vehicle id, a new `vehicle_acquired_<id>` key and a SECOND capitalization.
    expect(await countJournals(t, orgId)).toBe(journals);
  });

  test("workOrders.create: a retried COMPLETED work order posts ONE expense", async () => {
    const { t, asAdmin, orgId } = await freshOrg("wo");
    const vehicleId = (await asAdmin.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId, vin: "1HGCM82633A00002", make: "Kia", model: "Rio", year: 2022, mileage: 10, color: "Red",
      fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 12_000,
      sourceType: "STOCK" as const,
      status: "AVAILABLE" as const,
    })) as Id<"vehicles">;
    const expensesBefore = await countRows(t, orgId, "expenses");

    const args = {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      vehicleId,
      title: "Brake job",
      status: "COMPLETED" as const,
      tasks: [{ id: "1", description: "Pads", partsCost: 200, laborCost: 100, completed: true }],
    };
    const first = await asAdmin.mutation(api.workOrders.create, args);
    const second = await asAdmin.mutation(api.workOrders.create, args);

    expect(second).toBe(first);
    expect(await countRows(t, orgId, "workOrders")).toBe(1);
    expect(await countRows(t, orgId, "expenses")).toBe(expensesBefore + 1);
  });

  test("vehicles.createReservation: a retry does not take the deposit twice", async () => {
    // This test exists because the mutation battery caught its ABSENCE: making
    // the reservation identity per-call random left the suite green, which
    // means nothing here was testing the guard at all.
    const { t, asAdmin, orgId } = await freshOrg("resv");
    const vehicleId = (await asAdmin.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId, vin: "1HGCM82633A90001", make: "Ford", model: "Focus", year: 2020,
      mileage: 20, color: "Black", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: 11_000, sourceType: "STOCK" as const, status: "AVAILABLE" as const,
    })) as Id<"vehicles">;
    const customerId = (await t.run((ctx: any) =>
      ctx.db.insert("customers", { orgId, firstName: "Res", lastName: "Customer", createdAt: Date.now() })
    )) as Id<"customers">;

    const depositsBefore = await countRows(t, orgId, "deposits");
    const args = {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      vehicleId,
      customerId,
      depositAmount: 500,
      depositMethod: "CASH" as const,
    };
    const first = await asAdmin.mutation(api.vehicles.createReservation, args);
    const second = await asAdmin.mutation(api.vehicles.createReservation, args);

    expect(second).toBe(first);
    // Exactly one deposit. Commitment lineage would NOT have caught this: it
    // answers which deal owns the car, not whether this command already ran.
    expect(await countRows(t, orgId, "deposits")).toBe(depositsBefore + 1);
    expect(await countRows(t, orgId, "vehicleReservations")).toBe(1);
  });
});

describe("SCRUM-313 · identity refuses a DIFFERENT intent wearing the same key", () => {
  test("same key, different content is refused rather than silently deduped", async () => {
    const { asAdmin, orgId } = await freshOrg("conflict");
    const key = crypto.randomUUID();
    const base = {
      idempotencyKey: key,
      orgId,
      name: "Compressor",
      purchaseDate: Date.now(),
      costMinor: 100_000,
      usefulLifeMonths: 24,
    };
    await asAdmin.mutation(api.fixedAssets.capitalize, base);
    // A genuinely different asset must never be absorbed into the first one's
    // identity — returning the first result here would silently LOSE the second
    // asset while telling the operator it succeeded.
    await expect(
      asAdmin.mutation(api.fixedAssets.capitalize, { ...base, costMinor: 900_000 })
    ).rejects.toThrow();
  });
});

describe("SCRUM-313 · the STATE_GUARDED commands are proved, not asserted", () => {
  test("workOrders.update: the second call cannot create a second expense", async () => {
    // Owner overruled my HIGH here. The guard is `wo.expenseId`, set by this
    // same mutation, so after a committed update the retry refuses before
    // reaching createWorkOrderExpense.
    const { t, asAdmin, orgId } = await freshOrg("woupd");
    const vehicleId = (await asAdmin.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId, vin: "1HGCM82633A00003", make: "Mazda", model: "3", year: 2021, mileage: 5, color: "Blue",
      fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 15_000,
      sourceType: "STOCK" as const,
      status: "AVAILABLE" as const,
    })) as Id<"vehicles">;

    const workOrderId = (await asAdmin.mutation(api.workOrders.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId, vehicleId, title: "Service", status: "OPEN" as const,
      tasks: [{ id: "1", description: "Oil", partsCost: 50, laborCost: 25, completed: false }],
    })) as Id<"workOrders">;

    const expensesBefore = await countRows(t, orgId, "expenses");
    const completion = {
      orgId,
      workOrderId,
      title: "Service",
      status: "COMPLETED" as const,
      tasks: [{ id: "1", description: "Oil", partsCost: 50, laborCost: 25, completed: true }],
    };
    await asAdmin.mutation(api.workOrders.update, completion);
    expect(await countRows(t, orgId, "expenses")).toBe(expensesBefore + 1);

    // The retry. It must REFUSE, and leave the expense count untouched.
    await expect(asAdmin.mutation(api.workOrders.update, completion)).rejects.toThrow();
    expect(await countRows(t, orgId, "expenses")).toBe(expensesBefore + 1);
  });

  test("vehicles.correctAcquisitionCost: the retry is refused by a convergent state", async () => {
    // The absorbing state is the vehicle row: the retry re-reads the ALREADY
    // PATCHED cost, computes delta === 0 and throws. The throw is uncaught, so
    // Convex rolls back before the correction row and the hook.
    const { t, asAdmin, orgId } = await freshOrg("cost");
    const vehicleId = (await asAdmin.mutation(api.vehicles.create, {
      idempotencyKey: crypto.randomUUID(),
      orgId, vin: "1HGCM82633A00004", make: "Honda", model: "Civic", year: 2023, mileage: 50, color: "Grey",
      fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 20_000,
      purchasePrice: 18_000, purchasePaymentMethod: "CASH" as const,
      sourceType: "STOCK" as const,
      status: "AVAILABLE" as const,
    })) as Id<"vehicles">;

    const correction = {
      orgId,
      vehicleId,
      newCost: 19_000,
      reason: "Supplier invoice error",
      correctionType: "SUPPLIER_INVOICE_ERROR" as const,
    };
    await asAdmin.mutation(api.vehicles.correctAcquisitionCost, correction);
    const journals = await countJournals(t, orgId);
    const corrections = await countRows(t, orgId, "vehicleCostCorrections");

    // The MESSAGE is asserted, not merely "it threw". A generic rejection
    // assertion survived deleting the delta guard entirely — something further
    // down also refuses, so the test passed while the barrier this
    // classification NAMES was gone. Pinning the message makes the test prove
    // the stated mechanism rather than the outcome some other guard happens to
    // produce.
    await expect(
      asAdmin.mutation(api.vehicles.correctAcquisitionCost, correction)
    ).rejects.toThrow(/nothing to correct/);

    // No second correction row and no second journal — the rollback held.
    expect(await countRows(t, orgId, "vehicleCostCorrections")).toBe(corrections);
    expect(await countJournals(t, orgId)).toBe(journals);
  });
});
