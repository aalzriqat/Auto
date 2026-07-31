declare global {
  interface ImportMeta {
    glob: any;
  }
}
import { describe, it, expect, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import { ConvexError } from "convex/values";

describe("Approvals Permissions", () => {
  it("rejects unauthenticated requests", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const orgId = await t.run(async (ctx) => {
      return await ctx.db.insert("organizations", {
        name: "Test Org",
        createdAt: Date.now(),
      });
    });

    const vehicleId = await t.run(async (ctx) => {
      return await ctx.db.insert("vehicles", {
        orgId,
        make: "Toyota",
        model: "Camry",
        status: "AVAILABLE",
        vin: "FAKEVIN123",
        year: 2020,
        mileage: 10000,
        color: "Black",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 20000,
      });
    });

    // Attempting to request approval without auth should throw
    await expect(
      t.mutation(api.approvals.requestProfitApproval, {
        orgId,
        vehicleId,
        requestedProfit: 1000,
        minimumProfit: 500,
      })
    ).rejects.toThrow("Unauthenticated");
  });

  it("rejects user in Org A from approving requests in Org B", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    
    // Create Org A and Org B
    const orgAId = await t.run(async (ctx) => {
      return await ctx.db.insert("organizations", {
        name: "Org A",
        createdAt: Date.now(),
      });
    });
    
    const orgBId = await t.run(async (ctx) => {
      return await ctx.db.insert("organizations", {
        name: "Org B",
        createdAt: Date.now(),
      });
    });

    // Create a user who is ONLY in Org A
    const asUserA = t.withIdentity({ subject: "user_A" });
    const userAId = await asUserA.run(async (ctx) => {
      return await ctx.db.insert("users", {
        clerkId: "user_A",
        email: "a@test.com",
        name: "User A",
      });
    });

    const roleAId = await asUserA.run(async (ctx) => {
      return await ctx.db.insert("roles", {
        orgId: orgAId,
        name: "SALES",
        permissions: ["view:vehicles"],
      });
    });

    await asUserA.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        orgId: orgAId,
        userId: userAId,
        roleId: roleAId,
      });
    });

    const vehicleInOrgB = await asUserA.run(async (ctx) => {
      return await ctx.db.insert("vehicles", {
        orgId: orgBId,
        make: "Honda",
        model: "Civic",
        status: "AVAILABLE",
        vin: "FAKEVIN456",
        year: 2021,
        mileage: 5000,
        color: "White",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 22000,
      });
    });

    // User A tries to request profit approval for Org B's vehicle
    await expect(
      asUserA.mutation(api.approvals.requestProfitApproval, {
        orgId: orgBId,
        vehicleId: vehicleInOrgB,
        requestedProfit: 1000,
        minimumProfit: 500,
      })
    ).rejects.toThrow("Unauthorized: You are not a member of this organization.");
  });

  it("rejects users without APPROVE_REQUESTS from responding to approvals", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const orgId = await t.run(async (ctx) => {
      return await ctx.db.insert("organizations", {
        name: "Test Org",
        createdAt: Date.now(),
      });
    });

    const asSalesperson = t.withIdentity({ subject: "salesperson" });
    const userId = await asSalesperson.run(async (ctx) => {
      return await ctx.db.insert("users", {
        clerkId: "salesperson",
        email: "sales@test.com",
        name: "Sales Person",
      });
    });

    const salesRoleId = await asSalesperson.run(async (ctx) => {
      return await ctx.db.insert("roles", {
        orgId,
        name: "SALES",
        permissions: ["view:vehicles"],
      });
    });

    await asSalesperson.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        orgId,
        userId,
        roleId: salesRoleId,
      });
    });

    const vehicleId = await asSalesperson.run(async (ctx) => {
      return await ctx.db.insert("vehicles", {
        orgId,
        make: "Ford",
        model: "F150",
        status: "AVAILABLE",
        vin: "FAKEVIN789",
        year: 2022,
        mileage: 15000,
        color: "Red",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 35000,
      });
    });

    const requestId = await asSalesperson.run(async (ctx) => {
      return await ctx.db.insert("profitApprovalRequests", {
        orgId,
        vehicleId,
        requestedProfit: 1000,
        minimumProfit: 500,
        salespersonId: userId,
        status: "PENDING",
        createdAt: Date.now(),
      });
    });

    // Try to approve the request without APPROVE_REQUESTS
    await expect(
      asSalesperson.mutation(api.approvals.respondToApproval, {
        orgId,
        requestId,
        status: "APPROVED",
      })
    ).rejects.toThrow("Forbidden: Missing required permissions");
  });
});

// The permission tests above only prove *who* may call respondToApproval.
// These cover what it actually does to the request row afterwards — approving
// and rejecting had no outcome coverage at all, so a handler that authorised
// correctly and then patched nothing would still have passed CI.
describe("Approvals Outcomes", () => {
  async function setup() {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));

    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Outcome Org", createdAt: Date.now() })
    );

    const salespersonId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "sales_o", email: "sales-o@test.com", name: "Sales O" })
    );
    const salesRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:vehicles"] })
    );
    await t.run((ctx) =>
      ctx.db.insert("memberships", { orgId, userId: salespersonId, roleId: salesRoleId })
    );

    const managerId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "mgr_o", email: "mgr-o@test.com", name: "Manager O" })
    );
    const managerRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId,
        name: "MANAGER",
        permissions: ["view:vehicles", "approve:requests"],
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("memberships", { orgId, userId: managerId, roleId: managerRoleId })
    );

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        make: "Toyota",
        model: "Corolla",
        status: "AVAILABLE",
        vin: "OUTCOMEVIN01",
        year: 2023,
        mileage: 1200,
        color: "Silver",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 25000,
      })
    );

    const requestId = await t.run((ctx) =>
      ctx.db.insert("profitApprovalRequests", {
        orgId,
        vehicleId,
        requestedProfit: 200,
        minimumProfit: 1000,
        salespersonId,
        status: "PENDING",
        createdAt: Date.now(),
      })
    );

    return {
      t,
      orgId,
      vehicleId,
      requestId,
      salespersonId,
      managerId,
      asSalesperson: t.withIdentity({ subject: "sales_o" }),
      asManager: t.withIdentity({ subject: "mgr_o" }),
    };
  }

  it("approving a pending request records APPROVED and who approved it", async () => {
    const { t, orgId, requestId, managerId, asManager } = await setup();

    await asManager.mutation(api.approvals.respondToApproval, {
      orgId,
      requestId,
      status: "APPROVED",
      notes: "Volume deal, margin accepted.",
    });

    const request = await t.run((ctx) => ctx.db.get(requestId));
    expect(request?.status).toBe("APPROVED");
    expect(request?.approvedBy).toBe(managerId);
    expect(request?.notes).toBe("Volume deal, margin accepted.");
  });

  it("rejecting a pending request records REJECTED and who rejected it", async () => {
    const { t, orgId, requestId, managerId, asManager } = await setup();

    await asManager.mutation(api.approvals.respondToApproval, {
      orgId,
      requestId,
      status: "REJECTED",
      notes: "Below floor.",
    });

    const request = await t.run((ctx) => ctx.db.get(requestId));
    expect(request?.status).toBe("REJECTED");
    expect(request?.approvedBy).toBe(managerId);
    expect(request?.notes).toBe("Below floor.");
  });

  it("a resolved request cannot be responded to a second time", async () => {
    const { orgId, requestId, asManager } = await setup();

    await asManager.mutation(api.approvals.respondToApproval, {
      orgId,
      requestId,
      status: "REJECTED",
    });

    // Without this guard a manager could flip an already-rejected deal to
    // APPROVED after the fact, with no trace that it was ever refused.
    await expect(
      asManager.mutation(api.approvals.respondToApproval, {
        orgId,
        requestId,
        status: "APPROVED",
      })
    ).rejects.toThrow("This approval request has already been resolved.");
  });

  it("a manager cannot respond to a request belonging to another org", async () => {
    const { t, requestId, asManager } = await setup();

    // Manager O is a full manager in their own org and in Org B, but the
    // request they name belongs to the first org — passing Org B's id must
    // not launder it through Org B's membership check.
    const otherOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Org", createdAt: Date.now() })
    );
    const otherRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId: otherOrgId,
        name: "MANAGER",
        permissions: ["view:vehicles", "approve:requests"],
      })
    );
    const managerUserId = await t.run(async (ctx) => {
      const u = await ctx.db
        .query("users")
        .filter((q) => q.eq(q.field("clerkId"), "mgr_o"))
        .first();
      return u!._id;
    });
    await t.run((ctx) =>
      ctx.db.insert("memberships", { orgId: otherOrgId, userId: managerUserId, roleId: otherRoleId })
    );

    await expect(
      asManager.mutation(api.approvals.respondToApproval, {
        orgId: otherOrgId,
        requestId,
        status: "APPROVED",
      })
    ).rejects.toThrow("Approval request not found in this organization.");

    const request = await t.run((ctx) => ctx.db.get(requestId));
    expect(request?.status).toBe("PENDING");
  });

  it("listPendingApprovals and countPending drop a request once it is resolved", async () => {
    const { orgId, requestId, asManager } = await setup();

    expect(await asManager.query(api.approvals.countPending, { orgId })).toBe(1);
    const before = await asManager.query(api.approvals.listPendingApprovals, { orgId });
    expect(before).toHaveLength(1);
    expect(before[0].salespersonName).toBe("Sales O");
    expect(before[0].vehicleMakeModel).toBe("Toyota Corolla 2023");

    await asManager.mutation(api.approvals.respondToApproval, {
      orgId,
      requestId,
      status: "APPROVED",
    });

    expect(await asManager.query(api.approvals.countPending, { orgId })).toBe(0);
    expect(await asManager.query(api.approvals.listPendingApprovals, { orgId })).toHaveLength(0);
  });

  it("cancelMyApproval rejects a request the caller did not raise", async () => {
    const { t, orgId, requestId } = await setup();

    const otherSalesId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "sales_p", email: "sales-p@test.com", name: "Sales P" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "SALES2", permissions: ["view:vehicles"] })
    );
    await t.run((ctx) =>
      ctx.db.insert("memberships", { orgId, userId: otherSalesId, roleId })
    );

    await expect(
      t.withIdentity({ subject: "sales_p" }).mutation(api.approvals.cancelMyApproval, {
        orgId,
        requestId,
      })
    ).rejects.toThrow("You can only cancel your own approval requests.");

    const request = await t.run((ctx) => ctx.db.get(requestId));
    expect(request?.status).toBe("PENDING");
  });

  it("cancelMyApproval withdraws the caller's own pending request", async () => {
    const { t, orgId, requestId, asSalesperson } = await setup();

    await asSalesperson.mutation(api.approvals.cancelMyApproval, { orgId, requestId });

    const request = await t.run((ctx) => ctx.db.get(requestId));
    expect(request?.status).toBe("REJECTED");
  });

  it("checkPendingApproval returns the salesperson's most recent request", async () => {
    const { t, orgId, salespersonId, asSalesperson } = await setup();

    // A second vehicle, so setup()'s request is out of the picture and this
    // test controls insertion order completely.
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        make: "Toyota",
        model: "Yaris",
        status: "AVAILABLE",
        vin: "OUTCOMEVIN02",
        year: 2022,
        mileage: 8000,
        color: "White",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 18000,
      })
    );

    // The OLDER request is inserted FIRST, so index order and createdAt order
    // disagree: without the handler's explicit sort, requests[0] is this
    // rejected row and the wizard would resume a deal management already
    // refused. Inserting it second would make the test pass either way.
    await t.run((ctx) =>
      ctx.db.insert("profitApprovalRequests", {
        orgId,
        vehicleId,
        requestedProfit: 50,
        minimumProfit: 1000,
        salespersonId,
        status: "REJECTED",
        createdAt: Date.now() - 60_000,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("profitApprovalRequests", {
        orgId,
        vehicleId,
        requestedProfit: 200,
        minimumProfit: 1000,
        salespersonId,
        status: "PENDING",
        createdAt: Date.now(),
      })
    );

    const latest = await asSalesperson.query(api.approvals.checkPendingApproval, {
      orgId,
      vehicleId,
    });
    expect(latest?.status).toBe("PENDING");
    expect(latest?.requestedProfit).toBe(200);
  });
});
