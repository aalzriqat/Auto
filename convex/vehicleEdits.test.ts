declare global {
  interface ImportMeta {
    glob: any;
  }
}
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

// vehicleEdits.ts had no test file. Its authorization was covered indirectly
// via vehicles.test.ts, but nothing asserted that approving a request actually
// applies the payload to the vehicle — the whole point of the workflow. A
// resolve() that patched the request row and forgot the vehicle would have
// looked correct in the UI (request disappears from the pending list) and
// silently dropped every approved edit.

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Edits Org", createdAt: Date.now() })
  );

  // Salesperson may request an edit but not resolve one.
  const salespersonId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "edit_sales", email: "es@test.com", name: "Edit Sales" })
  );
  const salesRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "SALES",
      permissions: ["view:vehicles", "edit:vehicles:request", "create:vehicles:request"],
    })
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", { orgId, userId: salespersonId, roleId: salesRoleId })
  );

  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "edit_mgr", email: "em@test.com", name: "Edit Manager" })
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

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      make: "Nissan",
      model: "Altima",
      status: "AVAILABLE",
      vin: "EDITVIN00001",
      year: 2021,
      mileage: 30000,
      color: "Blue",
      fuelType: "Petrol",
      transmission: "Automatic",
      sellingPrice: 18000,
    })
  );

  return {
    t,
    orgId,
    vehicleId,
    salespersonId,
    managerId,
    asSalesperson: t.withIdentity({ subject: "edit_sales" }),
    asManager: t.withIdentity({ subject: "edit_mgr" }),
  };
}

describe("vehicleEdits.requestUpdate", () => {
  it("stores only the fields that actually changed", async () => {
    const { t, orgId, vehicleId, asSalesperson } = await setup();

    const requestId = await asSalesperson.mutation(api.vehicleEdits.requestUpdate, {
      orgId,
      vehicleId,
      payload: { sellingPrice: 17000, make: "Nissan", color: "Blue" },
    });

    const request = await t.run((ctx) => ctx.db.get(requestId));
    expect(request?.status).toBe("PENDING");
    expect(request?.payload).toEqual({ sellingPrice: 17000 });
  });

  it("refuses a request that changes nothing", async () => {
    const { orgId, vehicleId, asSalesperson } = await setup();

    await expect(
      asSalesperson.mutation(api.vehicleEdits.requestUpdate, {
        orgId,
        vehicleId,
        payload: { make: "Nissan", color: "Blue" },
      })
    ).rejects.toThrow("No changes detected.");
  });

  it("does not apply the edit before it is approved", async () => {
    const { t, orgId, vehicleId, asSalesperson } = await setup();

    await asSalesperson.mutation(api.vehicleEdits.requestUpdate, {
      orgId,
      vehicleId,
      payload: { sellingPrice: 1 },
    });

    const vehicle = await t.run((ctx) => ctx.db.get(vehicleId));
    expect(vehicle?.sellingPrice).toBe(18000);
  });
});

describe("vehicleEdits.resolve", () => {
  it("approving an UPDATE applies the payload to the vehicle", async () => {
    const { t, orgId, vehicleId, managerId, asSalesperson, asManager } = await setup();

    const requestId = await asSalesperson.mutation(api.vehicleEdits.requestUpdate, {
      orgId,
      vehicleId,
      payload: { sellingPrice: 17000, mileage: 31000 },
    });

    await asManager.mutation(api.vehicleEdits.resolve, {
      orgId,
      requestId,
      status: "APPROVED",
    });

    const vehicle = await t.run((ctx) => ctx.db.get(vehicleId));
    expect(vehicle?.sellingPrice).toBe(17000);
    expect(vehicle?.mileage).toBe(31000);
    expect(vehicle?.updatedBy).toBe(managerId);

    const request = await t.run((ctx) => ctx.db.get(requestId));
    expect(request?.status).toBe("APPROVED");
    expect(request?.resolvedBy).toBe(managerId);
    expect(request?.resolvedAt).toEqual(expect.any(Number));
  });

  it("rejecting an UPDATE leaves the vehicle untouched", async () => {
    const { t, orgId, vehicleId, asSalesperson, asManager } = await setup();

    const requestId = await asSalesperson.mutation(api.vehicleEdits.requestUpdate, {
      orgId,
      vehicleId,
      payload: { sellingPrice: 17000 },
    });

    await asManager.mutation(api.vehicleEdits.resolve, {
      orgId,
      requestId,
      status: "REJECTED",
    });

    const vehicle = await t.run((ctx) => ctx.db.get(vehicleId));
    expect(vehicle?.sellingPrice).toBe(18000);
    expect((await t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("REJECTED");
  });

  it("approving a selling-price change records vehicle price history", async () => {
    const { t, orgId, vehicleId, managerId, asSalesperson, asManager } = await setup();

    const requestId = await asSalesperson.mutation(api.vehicleEdits.requestUpdate, {
      orgId,
      vehicleId,
      payload: { sellingPrice: 16500 },
    });
    await asManager.mutation(api.vehicleEdits.resolve, {
      orgId,
      requestId,
      status: "APPROVED",
    });

    const history = await t.run((ctx) =>
      ctx.db
        .query("vehiclePriceHistory")
        .filter((q) => q.eq(q.field("vehicleId"), vehicleId))
        .collect()
    );
    expect(history).toHaveLength(1);
    expect(history[0].oldPrice).toBe(18000);
    expect(history[0].newPrice).toBe(16500);
    expect(history[0].changedBy).toBe(managerId);
  });

  it("a request cannot be resolved twice", async () => {
    const { orgId, vehicleId, asSalesperson, asManager } = await setup();

    const requestId = await asSalesperson.mutation(api.vehicleEdits.requestUpdate, {
      orgId,
      vehicleId,
      payload: { sellingPrice: 17000 },
    });
    await asManager.mutation(api.vehicleEdits.resolve, {
      orgId,
      requestId,
      status: "REJECTED",
    });

    await expect(
      asManager.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" })
    ).rejects.toThrow("Request is already resolved.");
  });

  it("a salesperson without edit:vehicles cannot resolve their own request", async () => {
    const { t, orgId, vehicleId, asSalesperson } = await setup();

    const requestId = await asSalesperson.mutation(api.vehicleEdits.requestUpdate, {
      orgId,
      vehicleId,
      payload: { sellingPrice: 17000 },
    });

    await expect(
      asSalesperson.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" })
    ).rejects.toThrow("Forbidden: Missing required permissions");

    const vehicle = await t.run((ctx) => ctx.db.get(vehicleId));
    expect(vehicle?.sellingPrice).toBe(18000);
  });

  it("a manager cannot resolve a request belonging to another org", async () => {
    const { t, orgId, vehicleId, managerId, asSalesperson, asManager } = await setup();

    const requestId = await asSalesperson.mutation(api.vehicleEdits.requestUpdate, {
      orgId,
      vehicleId,
      payload: { sellingPrice: 17000 },
    });

    // Same caller, legitimately a manager in a second org — naming that org
    // must not let them resolve the first org's request.
    const otherOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Edits Org", createdAt: Date.now() })
    );
    const otherRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId: otherOrgId,
        name: "MANAGER",
        permissions: ["view:vehicles", "edit:vehicles"],
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("memberships", { orgId: otherOrgId, userId: managerId, roleId: otherRoleId })
    );

    await expect(
      asManager.mutation(api.vehicleEdits.resolve, {
        orgId: otherOrgId,
        requestId,
        status: "APPROVED",
      })
    ).rejects.toThrow("Request not found.");

    const vehicle = await t.run((ctx) => ctx.db.get(vehicleId));
    expect(vehicle?.sellingPrice).toBe(18000);
  });

  it("approving an UPDATE for a soft-deleted vehicle is refused", async () => {
    const { t, orgId, vehicleId, asSalesperson, asManager } = await setup();

    const requestId = await asSalesperson.mutation(api.vehicleEdits.requestUpdate, {
      orgId,
      vehicleId,
      payload: { sellingPrice: 17000 },
    });

    await t.run((ctx) =>
      ctx.db.patch(vehicleId, { isDeleted: true, deletedAt: Date.now() })
    );

    await expect(
      asManager.mutation(api.vehicleEdits.resolve, { orgId, requestId, status: "APPROVED" })
    ).rejects.toThrow("Vehicle not found.");
  });

  it("a CREATE raised through requestCreate is applied on approval", async () => {
    // The other CREATE tests below insert the vehicleEdits row directly to
    // isolate resolve(); this one goes through the real requestCreate so its
    // permission branch and payload guards are exercised too.
    const { t, orgId, salespersonId, asSalesperson, asManager } = await setup();

    const requestId = await asSalesperson.mutation(api.vehicleEdits.requestCreate, {
      orgId,
      payload: {
        vin: "REQCREATE0001",
        make: "Hyundai",
        model: "Tucson",
        year: 2024,
        mileage: 0,
        color: "White",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 26000,
        status: "AVAILABLE",
      },
    });

    const request = await t.run((ctx) => ctx.db.get(requestId));
    expect(request?.type).toBe("CREATE");
    expect(request?.requestedBy).toBe(salespersonId);
    expect(request?.status).toBe("PENDING");

    // Nothing in inventory until a manager approves.
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("vehicles")
          .filter((q) => q.eq(q.field("vin"), "REQCREATE0001"))
          .first()
      )
    ).toBeNull();

    await asManager.mutation(api.vehicleEdits.resolve, {
      orgId,
      requestId,
      status: "APPROVED",
    });

    const created = await t.run((ctx) =>
      ctx.db
        .query("vehicles")
        .filter((q) => q.eq(q.field("vin"), "REQCREATE0001"))
        .first()
    );
    expect(created?.sellingPrice).toBe(26000);
  });

  it("requestCreate refuses a status the sale and reservation workflows own", async () => {
    const { orgId, asSalesperson } = await setup();

    await expect(
      asSalesperson.mutation(api.vehicleEdits.requestCreate, {
        orgId,
        payload: { vin: "BADSTATUS001", make: "Kia", model: "Ceed", status: "SOLD" },
      })
    ).rejects.toThrow("Complete a sale to mark a vehicle as sold.");
  });

  it("requestCreate refuses a fractional owner count", async () => {
    const { orgId, asSalesperson } = await setup();

    // The direct vehicles.create path rejects this via zod; the request path
    // bypasses that schema, so the guard has to live in vehicleEdits itself.
    await expect(
      asSalesperson.mutation(api.vehicleEdits.requestCreate, {
        orgId,
        payload: { vin: "BADOWNER0001", make: "Kia", model: "Ceed", ownerCount: 1.5 },
      })
    ).rejects.toThrow("Owner count must be a non-negative integer.");
  });

  it("a CREATE request cannot be approved from another org", async () => {
    const { t, orgId, salespersonId, managerId, asManager } = await setup();

    const requestId = await t.run((ctx) =>
      ctx.db.insert("vehicleEdits", {
        orgId,
        requestedBy: salespersonId,
        type: "CREATE",
        payload: { vin: "FOREIGNCRT01", make: "Kia", model: "Picanto", sellingPrice: 12000 },
        status: "PENDING",
        createdAt: Date.now(),
      })
    );

    const otherOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Foreign Create Org", createdAt: Date.now() })
    );
    const otherRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId: otherOrgId,
        name: "MANAGER",
        permissions: ["view:vehicles", "edit:vehicles"],
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("memberships", { orgId: otherOrgId, userId: managerId, roleId: otherRoleId })
    );

    await expect(
      asManager.mutation(api.vehicleEdits.resolve, {
        orgId: otherOrgId,
        requestId,
        status: "APPROVED",
      })
    ).rejects.toThrow("Request not found.");

    expect(
      await t.run((ctx) =>
        ctx.db
          .query("vehicles")
          .filter((q) => q.eq(q.field("vin"), "FOREIGNCRT01"))
          .first()
      )
    ).toBeNull();
  });

  it("approving a CREATE inserts the vehicle into the requesting org", async () => {
    const { t, orgId, salespersonId, managerId, asManager } = await setup();

    const requestId = await t.run((ctx) =>
      ctx.db.insert("vehicleEdits", {
        orgId,
        requestedBy: salespersonId,
        type: "CREATE",
        payload: {
          vin: "NEWVIN000001",
          make: "Kia",
          model: "Sportage",
          year: 2024,
          mileage: 0,
          color: "Grey",
          fuelType: "Petrol",
          transmission: "Automatic",
          sellingPrice: 27000,
          status: "AVAILABLE",
        },
        status: "PENDING",
        createdAt: Date.now(),
      })
    );

    await asManager.mutation(api.vehicleEdits.resolve, {
      orgId,
      requestId,
      status: "APPROVED",
    });

    const created = await t.run((ctx) =>
      ctx.db
        .query("vehicles")
        .filter((q) => q.eq(q.field("vin"), "NEWVIN000001"))
        .first()
    );
    expect(created).not.toBeNull();
    expect(created?.orgId).toBe(orgId);
    expect(created?.sellingPrice).toBe(27000);
    // Credit stays with the requester; the approver is recorded separately.
    expect(created?.addedBy).toBe(salespersonId);
    expect(created?.updatedBy).toBe(managerId);
  });

  it("rejecting a CREATE inserts nothing", async () => {
    const { t, orgId, salespersonId, asManager } = await setup();

    const requestId = await t.run((ctx) =>
      ctx.db.insert("vehicleEdits", {
        orgId,
        requestedBy: salespersonId,
        type: "CREATE",
        payload: { vin: "REJECTVIN001", make: "Kia", model: "Rio", year: 2024, sellingPrice: 15000 },
        status: "PENDING",
        createdAt: Date.now(),
      })
    );

    await asManager.mutation(api.vehicleEdits.resolve, {
      orgId,
      requestId,
      status: "REJECTED",
    });

    const created = await t.run((ctx) =>
      ctx.db
        .query("vehicles")
        .filter((q) => q.eq(q.field("vin"), "REJECTVIN001"))
        .first()
    );
    expect(created).toBeNull();
  });
});
