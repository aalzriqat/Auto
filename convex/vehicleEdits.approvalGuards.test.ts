declare global {
  interface ImportMeta {
    glob: any;
  }
}
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

// SCRUM-717 (D-45): coverage for two vehicleEdits paths Sonar flagged as new and
// untested. Kept beside (not inside) vehicleEdits.test.ts, which already carries
// its own setup() and was left untouched.

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Guards Org", createdAt: Date.now() })
  );
  const salespersonId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "guard_sales", email: "gs@test.com", name: "Guard Sales" })
  );
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "guard_mgr", email: "gm@test.com", name: "Guard Manager" })
  );
  const managerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "MANAGER",
      permissions: ["view:vehicles", "edit:vehicles"],
    })
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", { orgId, userId: managerId, roleId: managerRoleId })
  );
  const insertVehicle = (vin: string, make: string) =>
    t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        make,
        model: "Model",
        status: "AVAILABLE",
        vin,
        year: 2021,
        mileage: 30000,
        color: "Blue",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 18000,
      })
    );
  const vehicleId = await insertVehicle("GUARDVIN0001", "Nissan");

  return {
    t,
    orgId,
    vehicleId,
    insertVehicle,
    salespersonId,
    managerId,
    asManager: t.withIdentity({ subject: "guard_mgr" }),
  };
}

// Failing-first reasoning: the approval-time `assertOnAccountHasCreditor` is the
// only thing standing between a request written before the rule existed (or forged
// through the table) and an on-account acquisition posted with no creditor. Drop it
// from `resolve` and the approval goes through: the vehicle takes the purchase
// price and the request resolves, instead of this refusal.
describe("vehicleEdits.resolve approval-time ownership guards", () => {
  it("refuses to approve an UPDATE that buys on account without naming the supplier", async () => {
    const { t, orgId, vehicleId, salespersonId, asManager } = await setup();

    const requestId = await t.run((ctx) =>
      ctx.db.insert("vehicleEdits", {
        orgId,
        vehicleId,
        requestedBy: salespersonId,
        type: "UPDATE",
        payload: { purchasePrice: 9000, purchasePaymentMethod: "ON_ACCOUNT" },
        status: "PENDING",
        createdAt: Date.now(),
      })
    );

    await expect(
      asManager.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" })
    ).rejects.toThrow("A supplier name is required for a vehicle purchased on account.");

    const vehicle = await t.run((ctx) => ctx.db.get(vehicleId));
    expect(vehicle?.purchasePrice).toBeUndefined();
    const request = await t.run((ctx) => ctx.db.get(requestId));
    expect(request?.status).toBe("PENDING");
  });
});

// getHistory had no test. Failing-first reasoning: it reads the `by_org_vehicle`
// index; if the vehicle bound were dropped from that condition, another vehicle's
// edit history would leak into this vehicle's screen.
describe("vehicleEdits.getHistory", () => {
  it("returns only this vehicle's edits, newest first, with requester and resolver names", async () => {
    const { t, orgId, vehicleId, insertVehicle, salespersonId, managerId, asManager } = await setup();
    const otherVehicleId = await insertVehicle("GUARDVIN0002", "Kia");

    const firstId = await t.run((ctx) =>
      ctx.db.insert("vehicleEdits", {
        orgId,
        vehicleId,
        requestedBy: salespersonId,
        type: "UPDATE",
        payload: { sellingPrice: 17000 },
        status: "APPROVED",
        resolvedBy: managerId,
        createdAt: Date.now(),
      })
    );
    const secondId = await t.run((ctx) =>
      ctx.db.insert("vehicleEdits", {
        orgId,
        vehicleId,
        requestedBy: salespersonId,
        type: "UPDATE",
        payload: { mileage: 31000 },
        status: "PENDING",
        createdAt: Date.now(),
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("vehicleEdits", {
        orgId,
        vehicleId: otherVehicleId,
        requestedBy: salespersonId,
        type: "UPDATE",
        payload: { sellingPrice: 8000 },
        status: "PENDING",
        createdAt: Date.now(),
      })
    );

    const history = await asManager.query(api.vehicleEdits.getHistory, { orgId, vehicleId });

    expect(history.map((edit) => edit._id)).toEqual([secondId, firstId]);
    expect(history[0]?.requestedByName).toBe("Guard Sales");
    expect(history[0]?.resolvedByName).toBeUndefined();
    expect(history[1]?.resolvedByName).toBe("Guard Manager");
  });
});
