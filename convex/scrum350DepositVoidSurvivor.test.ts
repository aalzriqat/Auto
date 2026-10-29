import { convexTestWithComponents } from "../test-utils/convexTest";
import { supplierIdFor } from "../test-utils/supplierFixture";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { syntheticVin, DEPOSIT_VOID_FIGURES } from "../scripts/intelligence/browserSwarmLifecycleAttack";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

/**
 * SCRUM-350 LIFE-1 — the setup and the void of the browser mission, run through the REAL
 * mutations: a SOURCED car created with the mission's own VIN, one CASH quote, two held deposits,
 * and a void of the first. The scripted handler tests prove the oracle against a fake; this proves
 * the fake's facts are the product's: the VIN is accepted, the car is RESERVED by both deposits,
 * and a void unwinds only the voided deposit's own receipt and canonical payment.
 */

const PERMISSIONS = [
  "create:sales",
  "edit:sales",
  "view:sales",
  "create:customers",
  "view:customers",
  "create:vehicles",
  "edit:vehicles",
  "view:vehicles",
  "approve:requests",
  "manage:finance",
  "view:finance",
  "confirm:finance_disbursement",
];

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() }),
  );
  const creatorId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "user_life_creator", email: "creator@test.com", name: "Creator" }));
  const approverId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "user_life_approver", email: "approver@test.com", name: "Approver" }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: creatorId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const asCreator = t.withIdentity({ subject: "user_life_creator", clerkId: "user_life_creator" });
  const asApprover = t.withIdentity({ subject: "user_life_approver", clerkId: "user_life_approver" });

  await asCreator.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asCreator.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear,
    periodNumber: 1,
  });
  const period = (await asCreator.query(api.accountingPeriods.list, { orgId }))[0]!;
  await asCreator.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  return { t, orgId, asCreator, asApprover };
}

describe("SCRUM-350 LIFE-1 real-mutation regression: voiding one of two deposits", () => {
  test("the mission's VIN is accepted, both deposits reserve the car, and the void leaves the survivor whole", async () => {
    const { t, orgId, asCreator, asApprover } = await setup();
    const nonce = "life1-regression";
    const figures = DEPOSIT_VOID_FIGURES;

    const customerId = await asCreator.mutation(api.customers.create, { orgId, firstName: "Swarm", lastName: `Deposits-${nonce}` });
    const vehicleId = await asCreator.mutation(api.vehicles.create, {
      orgId,
      vin: syntheticVin(nonce),
      make: "Toyota",
      model: "Camry-life1",
      year: 2022,
      mileage: 800,
      color: "Blue",
      fuelType: "Gasoline",
      transmission: "Automatic",
      sellingPrice: figures.priceMajor,
      sourceType: "SOURCED",
      sourcedSupplierId: await supplierIdFor(t, orgId, `Swarm Supplier ${nonce}`),
      sourceCost: figures.sourceCostMajor,
      status: "AVAILABLE",
      idempotencyKey: `${nonce}-vehicle`,
    });
    const quoteId = await asCreator.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      mode: "CASH",
      vehiclePrice: figures.priceMajor,
      downPayment: 0,
      termMonths: 0,
    });
    const voidedId = await asCreator.mutation(api.deposits.create, {
      orgId,
      quoteId,
      amount: figures.voidedMajor,
      method: "CASH",
      idempotencyKey: `${nonce}-deposit-voided`,
    });
    const survivorId = await asCreator.mutation(api.deposits.create, {
      orgId,
      quoteId,
      amount: figures.survivorMajor,
      method: "CASH",
      idempotencyKey: `${nonce}-deposit-survivor`,
    });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(vehicleId))?.status).toBe("RESERVED");
      expect((await ctx.db.get(voidedId))?.status).toBe("HELD");
      expect((await ctx.db.get(survivorId))?.status).toBe("HELD");
    });

    await asApprover.mutation(api.deposits.voidDeposit, { orgId, depositId: voidedId, reason: `${nonce} recorded in error` });

    await t.run(async (ctx) => {
      const voided = await ctx.db.get(voidedId);
      const survivor = await ctx.db.get(survivorId);
      expect(voided?.status).toBe("VOIDED");
      expect(voided?.holdActive).toBe(false);
      expect(survivor?.status).toBe("HELD");
      expect(survivor?.holdActive).toBe(true);
      expect((await ctx.db.get(vehicleId))?.status).toBe("RESERVED");
      expect((await ctx.db.get(voided!.canonicalPaymentId!))?.status).toBe("VOIDED");
      const survivorPayment = await ctx.db.get(survivor!.canonicalPaymentId!);
      expect(survivorPayment?.status).toBe("SETTLED");
      expect(survivorPayment?.amountMinor).toBe(figures.survivorMajor * 1_000);
    });

    const voidedEvents = await asCreator.query(api.accountingLedger.listAccountingEvents, { orgId, sourceType: "deposits", sourceId: String(voidedId) });
    const voidedReceipt = voidedEvents.find((event) => event.eventType === "DEPOSIT_RECEIVED");
    const voidedReversals = voidedEvents.filter((event) => event.eventType === "JOURNAL_REVERSAL");
    expect(voidedReceipt?.status).toBe("REVERSED");
    expect(voidedReversals).toHaveLength(1);
    // The one reversal is the mirror of THIS deposit's receipt, not merely some reversal.
    expect(voidedReceipt?._id).toBeDefined();
    expect(voidedReversals[0]?.reversalOfEventId).toBe(voidedReceipt?._id);
    expect(voidedReceipt?.reversedByEventId).toBe(voidedReversals[0]?._id);
    const survivorEvents = await asCreator.query(api.accountingLedger.listAccountingEvents, { orgId, sourceType: "deposits", sourceId: String(survivorId) });
    expect(survivorEvents.map((event) => [event.eventType, event.status])).toEqual([["DEPOSIT_RECEIVED", "POSTED"]]);

    // The mission's own reads: the permission-checked subledger sees both payments.
    const survivorRow = await asCreator.query(api.deposits.listByVehicle, { orgId, vehicleId });
    const survivorDeposit = survivorRow.find((row) => row._id === survivorId)!;
    const balance = await asCreator.query(api.subledger.getPaymentBalance, { orgId, paymentId: survivorDeposit.canonicalPaymentId! });
    expect(balance?.payment.status).toBe("SETTLED");
  });
});
