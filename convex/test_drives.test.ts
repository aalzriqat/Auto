import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = [
  "create:sales",
  "view:sales",
  "edit:sales",
  "create:vehicles",
  "view:vehicles",
  "edit:vehicles",
  "create:leads",
  "edit:leads",
  "view:leads",
  "view:customers",
  "view:users",
];

async function setup() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_td1", email: "td@test.com", name: "TD User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: "user_td1", clerkId: "user_td1" });

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A555555",
      make: "Nissan",
      model: "Altima",
      year: 2023,
      color: "Black",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 2000,
      sellingPrice: 17000,
      status: "AVAILABLE",
    })
  );
  const otherVehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A666666",
      make: "Nissan",
      model: "Sentra",
      year: 2023,
      color: "White",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 1000,
      sellingPrice: 14000,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Huda", lastName: "Mansour" })
  );

  return { t, orgId, userId, customerId, vehicleId, otherVehicleId, asUser };
}

describe("test_drives.create salesperson tenancy", () => {
  test("refuses a salespersonId that is not a member of the org", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();

    // A real user, but in a different dealership. `create` verified the vehicle
    // and the customer against the org and never the salesperson — and then
    // notified them, pushing this org's vehicle label and a link into its
    // dashboard to an outsider.
    const outsiderId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "user_outsider", email: "outsider@other.com", name: "Outsider" })
    );

    await expect(
      asUser.mutation(api.test_drives.create, {
        orgId,
        vehicleId,
        customerId,
        salespersonId: outsiderId,
        startTime: Date.now(),
      })
    ).rejects.toThrow(/not a member/i);

    const rows = await t.run((ctx) => ctx.db.query("test_drives").collect());
    expect(rows).toHaveLength(0);
    const notifications = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notifications).toHaveLength(0);
  });

  test("still accepts a salesperson who is a member", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser } = await setup();

    const id = await asUser.mutation(api.test_drives.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      startTime: Date.now(),
    });

    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.salespersonId).toBe(userId);
  });

  test("refuses a salesperson whose membership is being offboarded", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();

    // `requireTenantAuth` already refuses to authenticate a membership carrying
    // an offboardingStatus, so a row that merely *exists* is not proof of an
    // active member. Assigning work to one — and notifying them — would keep
    // feeding org data to somebody already on the way out.
    const leaverId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "user_leaver", email: "leaver@test.com", name: "Leaver" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "Sales", permissions: PERMISSIONS })
    );
    await t.run((ctx) =>
      ctx.db.insert("memberships", {
        orgId,
        userId: leaverId,
        roleId,
        offboardingStatus: "PENDING_EXTERNAL_REMOVAL",
        offboardingRequestedAt: Date.now(),
      })
    );

    await expect(
      asUser.mutation(api.test_drives.create, {
        orgId,
        vehicleId,
        customerId,
        salespersonId: leaverId,
        startTime: Date.now(),
      })
    ).rejects.toThrow(/not a member/i);

    const rows = await t.run((ctx) => ctx.db.query("test_drives").collect());
    expect(rows).toHaveLength(0);
    const notifications = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notifications).toHaveLength(0);
  });
});

describe("test_drives.complete notification targeting", () => {
  test("suppresses the completion notification for an offboarded salesperson", async () => {
    const { t, orgId, customerId, vehicleId, userId, asUser } = await setup();

    // A second, active member takes the booking; the admin completes it. The
    // caller has to be somebody else, because an offboarded membership can no
    // longer authenticate at all.
    const leaverId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "user_leaver2", email: "leaver2@test.com", name: "Leaver" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "Sales", permissions: PERMISSIONS })
    );
    const membershipId = await t.run((ctx) =>
      ctx.db.insert("memberships", { orgId, userId: leaverId, roleId })
    );

    const testDriveId = await asUser.mutation(api.test_drives.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: leaverId,
      startTime: Date.now(),
    });

    // Offboarding starts *after* the test drive was booked, which is the normal
    // case: the row is legitimate history, the person is on their way out.
    // Completing it must still succeed — it just must not notify them.
    await t.run((ctx) =>
      ctx.db.patch(membershipId, {
        offboardingStatus: "PENDING_EXTERNAL_REMOVAL",
        offboardingRequestedAt: Date.now(),
      })
    );
    const before = await t.run((ctx) => ctx.db.query("notifications").collect());

    await asUser.mutation(api.test_drives.complete, {
      orgId,
      testDriveId,
      endTime: Date.now(),
    });

    const row = await t.run((ctx) => ctx.db.get(testDriveId));
    expect(row?.endTime).toBeGreaterThan(0);
    const after = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(after).toHaveLength(before.length);
  });
});

describe("test_drives.create lead stage advance", () => {
  test("advances an open lead for the same customer+vehicle to TEST_DRIVE", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId,
      customerId,
      vehicleId,
      source: "Walk-in",
    });

    await asUser.mutation(api.test_drives.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      startTime: Date.now(),
    });

    await t.run(async (ctx) => {
      const lead = await ctx.db.get(leadId);
      expect(lead?.stage).toBe("TEST_DRIVE");
    });
  });

  test("advances a vehicle-agnostic open lead too", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId,
      customerId,
      source: "Walk-in",
    });

    await asUser.mutation(api.test_drives.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      startTime: Date.now(),
    });

    await t.run(async (ctx) => {
      const lead = await ctx.db.get(leadId);
      expect(lead?.stage).toBe("TEST_DRIVE");
    });
  });

  test("does not touch a lead pinned to a different vehicle", async () => {
    const { t, orgId, userId, customerId, vehicleId, otherVehicleId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId,
      customerId,
      vehicleId: otherVehicleId,
      source: "Walk-in",
    });

    await asUser.mutation(api.test_drives.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      startTime: Date.now(),
    });

    await t.run(async (ctx) => {
      const lead = await ctx.db.get(leadId);
      expect(lead?.stage).toBe("NEW");
    });
  });

  test("does not move a lead backward or touch WON/LOST leads", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser } = await setup();

    const negotiatingLeadId = await asUser.mutation(api.leads.create, {
      orgId,
      customerId,
      vehicleId,
      source: "Walk-in",
    });
    await t.run((ctx) => ctx.db.patch(negotiatingLeadId, { stage: "NEGOTIATION" }));

    const customer2Id = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Samer", lastName: "Odeh" })
    );
    const lostLeadId = await asUser.mutation(api.leads.create, {
      orgId,
      customerId: customer2Id,
      vehicleId,
      source: "Walk-in",
    });
    await t.run((ctx) => ctx.db.patch(lostLeadId, { stage: "LOST" }));

    await asUser.mutation(api.test_drives.create, {
      orgId,
      vehicleId,
      customerId,
      salespersonId: userId,
      startTime: Date.now(),
    });
    await asUser.mutation(api.test_drives.create, {
      orgId,
      vehicleId,
      customerId: customer2Id,
      salespersonId: userId,
      startTime: Date.now(),
    });

    await t.run(async (ctx) => {
      const negotiating = await ctx.db.get(negotiatingLeadId);
      expect(negotiating?.stage).toBe("NEGOTIATION");

      const lost = await ctx.db.get(lostLeadId);
      expect(lost?.stage).toBe("LOST");
    });
  });
});
