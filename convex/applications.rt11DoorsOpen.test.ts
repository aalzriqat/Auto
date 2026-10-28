import { expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { seedOrgWithMember } from "../test-utils/seedOrg";
import { seedVehicle } from "../test-utils/seedFinanceFixtures";
import { api } from "./_generated/api";
import schema from "./schema";

// Historical behavior only. The shipped-switch suite separately pins the pilot refusal.
vi.mock("./utils/rt11DoorContainment", async (importOriginal) => {
  const { openRt11Doors } = await import("../test-utils/rt11DoorSwitches");
  return openRt11Doors(await importOriginal<typeof import("./utils/rt11DoorContainment")>());
});

test("RT11 doors open: dealer payout still prevents expected payment correction without writes", async () => {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const { orgId, userId, identity } = await seedOrgWithMember(t, {
    clerkId: "rt11_historical", permissions: ["manage:finance"],
  });
  const vehicleId = await seedVehicle(t, orgId, "RT11-HISTORICAL");
  const applicationId = await t.run(async (ctx) => {
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Buyer" });
    const quoteId = await ctx.db.insert("quotes", {
      orgId, customerId, vehicleId, vehiclePrice: 22000, downPayment: 0, termMonths: 48,
      status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
    });
    return ctx.db.insert("financeApplications", {
      orgId, quoteId, customerId, vehicleId, salespersonId: userId, status: "CLOSED",
      expectedPaymentMethod: "BANK_TRANSFER", disbursedAt: Date.now(),
      createdAt: Date.now(), updatedAt: Date.now(),
    });
  });
  const snapshot = async () => ({
    tables: await dbSnapshot(t, Object.keys(schema.tables)),
    scheduled: await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect()),
  });
  const before = await snapshot();
  await expect(identity.mutation(api.applications.correctExpectedPayment, {
    orgId, applicationId, reason: "Wrong method",
  })).rejects.toThrow("Disbursement has already been confirmed for this deal, so its expected payment can no longer be corrected.");
  expect(await snapshot()).toEqual(before);
});
