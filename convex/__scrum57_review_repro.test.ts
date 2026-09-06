/**
 * TEMPORARY adversarial-review reproduction file (SCRUM-57 seat review).
 * Not part of the diff under review. Deleted after execution.
 *
 * Demonstrates: deposits.release, when the client reuses a STALE (un-retired)
 * idempotencyKey for what is, domain-wise, a genuinely SECOND real payout
 * (money that became free again via RETURN_TO_UNALLOCATED), silently returns
 * the FIRST calls cached success and moves NO additional cash, with no thrown
 * error observed by the caller.
 *
 * Control: identical seed/step sequence to the existing passing test
 * "and without a key the second release goes through on its own merits"
 * in convex/multiVehicleDepositAllocation.test.ts, with exactly ONE variable
 * changed: the second release call reuses the FIRST calls key instead of a
 * fresh one -- which is what happens if useCommandIdentity retire() never
 * observes a success (lost/errored response) for the first attempt.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const PERMS = [
  "view:sales", "create:sales", "edit:sales", "delete:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "manage:finance", "view:finance", "view:expenses", "view:reports",
  "reopen:accounting_periods",
];

const PRICE_A = 10000;
const DEPOSIT = 5000;

async function seed(tag) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Repro " + tag, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: tag + "_u", email: tag + "@e.com", name: "Sales" })
  );
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: tag + "_m", email: tag + "m@e.com", name: "Manager" })
  );
  const managerRoleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Manager", permissions: PERMS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: managerId, roleId: managerRoleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asUser = t.withIdentity({ subject: tag + "_u", clerkId: tag + "_u" });
  const asManager = t.withIdentity({ subject: tag + "_m", clerkId: tag + "_m" });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));

  const vehicleA = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: "VINREPRO" + tag + "A", make: "Toyota", model: "MA",
      year: 2024, mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
      sellingPrice: PRICE_A, status: "AVAILABLE", sourceType: "STOCK",
      purchasePrice: Math.round(PRICE_A * 0.8),
    })
  );

  const quoteId = await t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId, customerId, vehicleId: vehicleA,
      vehiclePrice: PRICE_A,
      downPayment: 0, termMonths: 0,
      status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
    })
  );

  return { t, orgId, userId, managerId, asUser, asManager, customerId, vehicleA, quoteId };
}

async function payDeposit(s, amount) {
  await s.asUser.mutation(api.deposits.create, {
    idempotencyKey: crypto.randomUUID(),
    orgId: s.orgId, quoteId: s.quoteId, amount: amount ?? DEPOSIT, method: "CASH",
  });
}
const allocate = (s, allocations) =>
  s.asUser.mutation(api.deposits.allocateToVehicles, { orgId: s.orgId, quoteId: s.quoteId, allocations });
const depositRowId = (s) =>
  s.t.run(async (ctx) => (await ctx.db.query("deposits").collect()).find((d) => d.orgId === s.orgId)._id);
const holdsFor = (s, vehicleId) =>
  s.t.run(async (ctx) => (await ctx.db.query("depositVehicleHolds").collect()).filter((h) => h.orgId === s.orgId && h.vehicleId === vehicleId));
const cashOut = (s) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("transactions").collect())
      .filter((tx) => tx.orgId === s.orgId && tx.type === "OUT" && tx.category === "DEPOSIT")
      .map((tx) => tx.amount)
  );
const release = (s, depositId, idempotencyKey) =>
  s.asManager.mutation(api.deposits.release, {
    orgId: s.orgId, depositId, resolution: "REFUNDED", refundMethod: "CASH", idempotencyKey,
  });

describe("SCRUM-57 review: deposits.release stale-key reuse (control vs defect)", () => {
  async function upToSecondFreeIncrement(tag, firstKey) {
    const s = await seed(tag);
    await payDeposit(s);
    await allocate(s, [{ vehicleId: s.vehicleA, amount: 3000 }]);
    const depositId = await depositRowId(s);

    await release(s, depositId, firstKey);

    const [holdA] = await holdsFor(s, s.vehicleA);
    await s.asManager.mutation(api.deposits.resolveReleasedAllocation, {
      orgId: s.orgId, holdId: holdA._id, treatment: "RETURN_TO_UNALLOCATED",
    });

    return { s, depositId };
  }

  test("CONTROL: a FRESH key on release number 2 moves the second real 3000", async () => {
    const { s, depositId } = await upToSecondFreeIncrement("control", crypto.randomUUID());
    await release(s, depositId, crypto.randomUUID());
    expect(await cashOut(s)).toEqual([2000, 3000]);
  });

  test("DEFECT: a STALE un-retired key on release number 2 silently swallows the second real 3000", async () => {
    const staleKey = crypto.randomUUID();
    const { s, depositId } = await upToSecondFreeIncrement("defect", staleKey);

    let threw = false;
    let result;
    try {
      result = await release(s, depositId, staleKey);
    } catch (e) {
      threw = true;
    }

    console.log("SCRUM57_REPRO threw=", threw, "result=", result, "cashOut=", await cashOut(s));

    expect(threw).toBe(true);
  });
});
