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

/**
 * SCRUM-100. `listMyPendingApprovals` authorises against `args.orgId` but reads
 * `by_salesperson` on a GLOBAL user id and never filters by org, so a user who
 * belongs to two dealerships sees the other one's approvals — including
 * `requestedProfit`, `minimumProfit` and the foreign org's vehicle. Multi-org
 * membership is first-class here (`organizations.listMine` collects every
 * membership and the org switcher is built on it), and at least six production
 * users hold two.
 *
 * ⚠️ Which of these are regression tests, and which are not — established by
 * reverting each fix and re-running, not assumed:
 *
 *  - FAIL without their fix (genuine regression tests). Verified by rebuilding
 *    the pre-fix handler — unscoped `by_salesperson` plus a JS cutoff — and
 *    re-running: exactly these three fail.
 *      "returns only the queried org's rows"        — the leak itself
 *      "keeps APPROVED rows"                        — the index-shape trap
 *      "preserves the previous implementation's ordering" — it expects
 *          [1000, 1100]; unscoped, Org B's rows join it as [1000, 1100, 9000,
 *          9100], so it fails on content as well as on order
 *      "does not disclose a vehicle ... enrichment" — REWRITTEN, see below
 *      "checkPendingApproval never returns another org's request" — the same
 *          leak in a sibling function; pre-fix it returns Org B's row, so
 *          `result.orgId` is Org B
 *      "requestProfitApproval never overwrites another org's request" —
 *          pre-fix, Org B's row reads 555 instead of 4242
 *      "listPendingApprovals sanitises a foreign vehicle without hiding the
 *          row" — reverting the guard to its cosmetic form leaves the VIN and
 *          the foreign `vehicleId` in the response
 *      "the pending badge never disagrees with the manager's queue" — dropping
 *          the row instead of sanitising it gives count 1 against list 0
 *      "respondToApproval does not put a foreign vehicle into the
 *          notification" — reverting the guard puts Org B's car in the email
 *  - Pass with and without: the salesperson, 7-day-edge, server-clock window,
 *    tied-createdAt and countPending cases. They pin real properties but prove
 *    nothing about the tenancy defect — `countPending` was already org-scoped
 *    through `by_org`, and tied-createdAt really asserts a Convex engine
 *    guarantee, kept only because a pagination-based rewrite could break it.
 *
 * ⚠️ The ordering case sat in the wrong bucket until an independent review
 * caught it. It was classified when it asserted ascending `createdAt`; the
 * rewrite to insertion order changed what it detects, and the classification
 * was not re-derived. Re-derive this table when a test body changes, not only
 * when a test is added.
 *
 * ⚠️ Re-derived again, for exactly that reason. An independent cross-family
 * review found that the enrichment guard was cosmetic: it masked
 * `vehicleSummary` while `...r` still spread the foreign `vehicleId`, and the
 * sales page feeds that id straight into `buildInitialDraftFromApproval` on
 * resume. The test asserted the masked LABEL and therefore certified a hole it
 * was written to close. Its body now asserts the row is dropped entirely and
 * that no returned row carries the foreign id — a different detection, so it
 * gets a fresh classification rather than an inherited one.
 *
 * A second sibling, `checkPendingApproval`, carried the identical defect and
 * was missed by the original sibling scan: that scan searched for uses of
 * `by_salesperson`, and this one reads `by_vehicle`. Scan for the SHAPE — a
 * caller-supplied id resolved on a global index — not for the index name.
 *
 * ⚠️ Re-derived a THIRD time, and the previous accounting was wrong in two
 * ways at once: it claimed 10 tests when the block held 11, and it left the
 * cross-tenant-WRITE case out of BOTH buckets. An independent review caught it
 * by doing the thing this table claims was done — reverting to `origin/main`
 * and re-running — and got 6 failures against the 5 listed. A table that says
 * "established by reverting, not assumed" has to survive someone actually
 * reverting.
 *
 * ⚠️ REACHABILITY, corrected. The cross-tenant WRITE and both foreign-vehicle
 * cases all require a row whose `orgId` and whose vehicle's `orgId` disagree,
 * and every such row here is seeded with a direct `ctx.db.insert` that bypasses
 * mutation validation. `requestProfitApproval` is the only writer and it
 * validates the correspondence; nothing repoints a vehicle's `orgId`; vehicles
 * are hard-deleted only by superadmin teardown or the raw-JSON admin editor.
 * So these guards are DEFENCE-IN-DEPTH against an admin edit or a future writer
 * that skips validation — not protection against a live, user-reachable
 * exploit. The earlier wording said "reproduced", which reads as end-to-end
 * reachability and overstated it. The confirmed live defect in this ticket is
 * the READ leak, which needs only ordinary two-org membership.
 *
 * That is all 14 tests in this block accounted for: 9 originally, plus
 * `checkPendingApproval`, `requestProfitApproval`, the two
 * `listPendingApprovals` cases and the `respondToApproval` case.
 */
describe("SCRUM-100: listMyPendingApprovals tenancy and bounds", () => {
  const DAY = 24 * 60 * 60 * 1000;

  /** One salesperson, member of two orgs, holding approvals in both. */
  async function seedMultiOrg(t: ReturnType<typeof convexTestWithComponents>) {
    return await t.run(async (ctx: any) => {
      const orgA = await ctx.db.insert("organizations", { name: "Dealer A", createdAt: Date.now() });
      const orgB = await ctx.db.insert("organizations", { name: "Dealer B", createdAt: Date.now() });

      const userId = await ctx.db.insert("users", {
        clerkId: "multi_org_sales",
        email: "multi@test.com",
        name: "Multi Org Salesperson",
      });

      for (const orgId of [orgA, orgB]) {
        const roleId = await ctx.db.insert("roles", {
          orgId,
          name: "SALES",
          permissions: ["view:vehicles"],
        });
        await ctx.db.insert("memberships", { orgId, userId, roleId });
      }

      const addVehicle = (orgId: any, vin: string, make: string) =>
        ctx.db.insert("vehicles", {
          orgId,
          make,
          model: "Model",
          status: "AVAILABLE",
          vin,
          year: 2022,
          mileage: 1000,
          color: "Black",
          fuelType: "Petrol",
          transmission: "Automatic",
          sellingPrice: 20000,
        });

      const vehA = await addVehicle(orgA, "VINORGA0000000001", "Toyota");
      const vehB = await addVehicle(orgB, "VINORGB0000000001", "Honda");

      const now = Date.now();
      const addRequest = (
        orgId: any,
        vehicleId: any,
        status: "PENDING" | "APPROVED" | "REJECTED",
        requestedProfit: number,
        createdAt: number
      ) =>
        ctx.db.insert("profitApprovalRequests", {
          orgId,
          vehicleId,
          requestedProfit,
          minimumProfit: 500,
          salespersonId: userId,
          status,
          createdAt,
        });

      // Org A: one of each status, all inside the 7-day window.
      await addRequest(orgA, vehA, "PENDING", 1000, now - 1 * DAY);
      await addRequest(orgA, vehA, "APPROVED", 1100, now - 2 * DAY);
      await addRequest(orgA, vehA, "REJECTED", 1200, now - 3 * DAY);

      // Org B: the rows that must never surface when Org A is queried.
      await addRequest(orgB, vehB, "PENDING", 9000, now - 1 * DAY);
      await addRequest(orgB, vehB, "APPROVED", 9100, now - 2 * DAY);

      return { orgA, orgB, userId };
    });
  }

  it("returns only the queried org's rows — never the other org the user also belongs to", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgA, orgB } = await seedMultiOrg(t);
    const asUser = t.withIdentity({ subject: "multi_org_sales" });

    const rows = await asUser.query(api.approvals.listMyPendingApprovals, { orgId: orgA });

    // ⚠️ Positive assertion FIRST. `every`, `some` and `not.toContain` below are
    // all satisfied by an empty array, so a query that returned nothing at all
    // would pass every isolation check without proving Org A's own approvals
    // are still reachable. Pin what must be present before pinning what must
    // not be.
    const profitsPresent = rows.map((r: any) => r.requestedProfit).sort((a: number, b: number) => a - b);
    expect(profitsPresent).toEqual([1000, 1100]); // Org A's PENDING + APPROVED

    // The leak: every returned row must belong to the org that was asked for.
    expect(rows.every((r: any) => r.orgId === orgA)).toBe(true);
    expect(rows.some((r: any) => r.orgId === orgB)).toBe(false);

    // Org B's margin figures must not appear at all.
    const profits = rows.map((r: any) => r.requestedProfit);
    expect(profits).not.toContain(9000);
    expect(profits).not.toContain(9100);

    // Nor may Org B's vehicle be read and summarised back to the caller.
    const summaries = rows.map((r: any) => r.vehicleSummary);
    expect(summaries.some((s: string) => s.includes("Honda"))).toBe(false);
  });

  it("keeps APPROVED rows — they are the resume-after-approval flow — and drops REJECTED", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgA } = await seedMultiOrg(t);
    const asUser = t.withIdentity({ subject: "multi_org_sales" });

    const rows = await asUser.query(api.approvals.listMyPendingApprovals, { orgId: orgA });
    const statuses = rows.map((r: any) => r.status).sort();

    // Exactly Org A's PENDING + APPROVED. An index pinned to status === "PENDING"
    // would drop the APPROVED row and break resuming an already-approved deal.
    expect(statuses).toEqual(["APPROVED", "PENDING"]);
  });

  it("excludes another salesperson's rows in the same org", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgA } = await seedMultiOrg(t);

    await t.run(async (ctx: any) => {
      const otherUser = await ctx.db.insert("users", {
        clerkId: "other_sales",
        email: "other@test.com",
        name: "Other Salesperson",
      });
      const role = await ctx.db
        .query("roles")
        .filter((q: any) => q.eq(q.field("orgId"), orgA))
        .first();
      await ctx.db.insert("memberships", { orgId: orgA, userId: otherUser, roleId: role._id });

      const veh = await ctx.db
        .query("vehicles")
        .filter((q: any) => q.eq(q.field("orgId"), orgA))
        .first();
      await ctx.db.insert("profitApprovalRequests", {
        orgId: orgA,
        vehicleId: veh._id,
        requestedProfit: 7777,
        minimumProfit: 500,
        salespersonId: otherUser,
        status: "PENDING",
        createdAt: Date.now() - DAY,
      });
    });

    const asUser = t.withIdentity({ subject: "multi_org_sales" });
    const rows = await asUser.query(api.approvals.listMyPendingApprovals, { orgId: orgA });

    expect(rows.map((r: any) => r.requestedProfit)).not.toContain(7777);
  });

  it("applies the 7-day window at both edges", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgA } = await seedMultiOrg(t);

    await t.run(async (ctx: any) => {
      const veh = await ctx.db
        .query("vehicles")
        .filter((q: any) => q.eq(q.field("orgId"), orgA))
        .first();
      const user = await ctx.db
        .query("users")
        .filter((q: any) => q.eq(q.field("clerkId"), "multi_org_sales"))
        .first();
      const now = Date.now();
      // Just inside the window, and just outside it.
      await ctx.db.insert("profitApprovalRequests", {
        orgId: orgA,
        vehicleId: veh._id,
        requestedProfit: 6001,
        minimumProfit: 500,
        salespersonId: user._id,
        status: "PENDING",
        createdAt: now - 7 * DAY + 60_000,
      });
      await ctx.db.insert("profitApprovalRequests", {
        orgId: orgA,
        vehicleId: veh._id,
        requestedProfit: 6002,
        minimumProfit: 500,
        salespersonId: user._id,
        status: "PENDING",
        createdAt: now - 7 * DAY - 60_000,
      });
    });

    const asUser = t.withIdentity({ subject: "multi_org_sales" });
    const rows = await asUser.query(api.approvals.listMyPendingApprovals, { orgId: orgA });
    const profits = rows.map((r: any) => r.requestedProfit);

    expect(profits).toContain(6001); // inside the window
    expect(profits).not.toContain(6002); // outside it
  });

  it("does not drop or duplicate rows that share an identical createdAt", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgA } = await seedMultiOrg(t);

    const tied = Date.now() - 2 * DAY;
    await t.run(async (ctx: any) => {
      const veh = await ctx.db
        .query("vehicles")
        .filter((q: any) => q.eq(q.field("orgId"), orgA))
        .first();
      const user = await ctx.db
        .query("users")
        .filter((q: any) => q.eq(q.field("clerkId"), "multi_org_sales"))
        .first();
      for (const profit of [8001, 8002, 8003]) {
        await ctx.db.insert("profitApprovalRequests", {
          orgId: orgA,
          vehicleId: veh._id,
          requestedProfit: profit,
          minimumProfit: 500,
          salespersonId: user._id,
          status: "PENDING",
          createdAt: tied,
        });
      }
    });

    const asUser = t.withIdentity({ subject: "multi_org_sales" });
    const rows = await asUser.query(api.approvals.listMyPendingApprovals, { orgId: orgA });
    const profits = rows.map((r: any) => r.requestedProfit);

    for (const profit of [8001, 8002, 8003]) {
      expect(profits.filter((p: number) => p === profit)).toHaveLength(1);
    }
  });

  it("countPending counts only the queried org", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgA, orgB } = await seedMultiOrg(t);

    // Grant approve rights by widening the user's EXISTING role in each org.
    // Adding a second membership instead would make requireTenantAuth reject the
    // caller, and countPending's fail-closed catch would report 0 — hiding the
    // very thing this test is checking.
    await t.run(async (ctx: any) => {
      for (const orgId of [orgA, orgB]) {
        const role = await ctx.db
          .query("roles")
          .filter((q: any) => q.eq(q.field("orgId"), orgId))
          .first();
        await ctx.db.patch(role._id, {
          permissions: ["view:vehicles", "approve:requests"],
        });
      }
    });

    const asUser = t.withIdentity({ subject: "multi_org_sales" });
    expect(await asUser.query(api.approvals.countPending, { orgId: orgA })).toBe(1);
    expect(await asUser.query(api.approvals.countPending, { orgId: orgB })).toBe(1);
  });

  /**
   * The cutoff is server-derived, so no caller can move the window in either
   * direction. An earlier revision took it from a client-supplied `now`; that
   * could be pushed back to widen the read, and — the reason it was removed
   * entirely — pushed FORWARD by an ordinarily fast browser clock to shrink it,
   * silently hiding APPROVED rows the sales page turns into "Resume Deal".
   */
  it("applies the 7-day window from the server clock, not the caller's", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgA } = await seedMultiOrg(t);

    await t.run(async (ctx: any) => {
      const veh = await ctx.db
        .query("vehicles")
        .filter((q: any) => q.eq(q.field("orgId"), orgA))
        .first();
      const user = await ctx.db
        .query("users")
        .filter((q: any) => q.eq(q.field("clerkId"), "multi_org_sales"))
        .first();
      for (const [profit, age] of [[4242, 730], [4343, 40], [5150, 30]] as const) {
        await ctx.db.insert("profitApprovalRequests", {
          orgId: orgA,
          vehicleId: veh._id,
          requestedProfit: profit,
          minimumProfit: 500,
          salespersonId: user._id,
          status: "PENDING",
          createdAt: Date.now() - age * DAY,
        });
      }
    });

    const asUser = t.withIdentity({ subject: "multi_org_sales" });
    const rows = await asUser.query(api.approvals.listMyPendingApprovals, { orgId: orgA });
    const profits = rows.map((r: any) => r.requestedProfit);

    expect(profits).toContain(1000); // in-window PENDING
    expect(profits).toContain(1100); // in-window APPROVED — the Resume Deal row
    for (const stale of [4242, 4343, 5150]) {
      expect(profits).not.toContain(stale);
    }
  });

  /**
   * ⚠️ Independent review finding. The index range proves the APPROVAL row is in
   * the caller's org. It proves nothing about the VEHICLE that row points at.
   * The enrichment step does a bare `ctx.db.get(r.vehicleId)` and renders
   * year/make/model — and in `listPendingApprovals`, the VIN as well.
   *
   * `requestProfitApproval` refuses a foreign vehicle, so a malformed reference
   * should not arise through the normal writer. "Should not arise" is a claim
   * about reachability, not a guarantee, and this is a confidentiality read: it
   * has to fail closed on its own.
   */
  it("does not disclose a vehicle belonging to another org via enrichment", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgA, orgB } = await seedMultiOrg(t);

    await t.run(async (ctx: any) => {
      const user = await ctx.db
        .query("users")
        .filter((q: any) => q.eq(q.field("clerkId"), "multi_org_sales"))
        .first();
      // Org B's vehicle — the one that must never be described back.
      const foreignVehicle = await ctx.db
        .query("vehicles")
        .filter((q: any) => q.eq(q.field("orgId"), orgB))
        .first();
      // A malformed but in-org approval row pointing at it.
      await ctx.db.insert("profitApprovalRequests", {
        orgId: orgA,
        vehicleId: foreignVehicle._id,
        requestedProfit: 3131,
        minimumProfit: 500,
        salespersonId: user._id,
        status: "PENDING",
        createdAt: Date.now() - 1 * DAY,
      });
    });

    const asUser = t.withIdentity({ subject: "multi_org_sales" });
    const foreignVehicleId = await t.run(async (ctx: any) => {
      const v = await ctx.db
        .query("vehicles")
        .filter((q: any) => q.eq(q.field("orgId"), orgB))
        .first();
      return v._id;
    });
    const rows = await asUser.query(api.approvals.listMyPendingApprovals, { orgId: orgA });

    // ⚠️ CONTRACT CHANGED, and the previous version of this test is why it
    // needed to. It asserted the malformed row was still RETURNED with
    // `vehicleSummary: "Unknown Vehicle"`, and called that failing closed. It
    // was not: the handler spread the whole row, so the foreign `vehicleId`
    // went to the client untouched and only its LABEL was hidden. The sales
    // page feeds exactly that id to `buildInitialDraftFromApproval` when a
    // salesperson resumes, so the guard masked the description while leaving
    // the actionable part live — hiding the evidence rather than closing the
    // hole.
    //
    // A row pointing at another org's vehicle is unusable by definition: there
    // is no legitimate way to resume a deal on a car this dealership does not
    // have. So it is dropped, not decorated.
    expect(rows.find((r: any) => r.requestedProfit === 3131)).toBeUndefined();

    // Org A's own approvals must still be there — the drop has to be surgical,
    // not a bulk failure that would pass an absence-only assertion.
    expect(rows.map((r: any) => r.requestedProfit).sort((a: number, b: number) => a - b))
      .toEqual([1000, 1100]);

    // The identifier itself, not just its description, must not cross.
    expect(rows.some((r: any) => r.vehicleId === foreignVehicleId)).toBe(false);
    expect(JSON.stringify(rows)).not.toContain("Honda");
  });

  /**
   * Seeds an in-org PENDING approval whose vehicle belongs to the OTHER org,
   * and returns the ids needed to assert on it.
   *
   * ⚠️ Written through a direct `ctx.db.insert`, which bypasses mutation
   * validation — and that is the honest description of this state.
   * `requestProfitApproval` is the only writer and it validates
   * `vehicle.orgId === args.orgId`, no path repoints a vehicle's `orgId`, and
   * vehicles are only hard-deleted by superadmin teardown or the raw-JSON admin
   * editor. So this row cannot arise from ordinary multi-org usage. The guards
   * below are defence-in-depth against an admin edit or a future writer that
   * skips validation, NOT protection against a live user-reachable exploit.
   */
  async function seedForeignVehicleApproval(
    t: ReturnType<typeof convexTestWithComponents>,
    orgA: any,
    orgB: any,
    requestedProfit: number
  ) {
    return await t.run(async (ctx: any) => {
      const user = await ctx.db
        .query("users")
        .filter((q: any) => q.eq(q.field("clerkId"), "multi_org_sales"))
        .first();
      const foreignVehicle = await ctx.db
        .query("vehicles")
        .filter((q: any) => q.eq(q.field("orgId"), orgB))
        .first();
      const requestId = await ctx.db.insert("profitApprovalRequests", {
        orgId: orgA,
        vehicleId: foreignVehicle._id,
        requestedProfit,
        minimumProfit: 500,
        salespersonId: user._id,
        status: "PENDING",
        createdAt: Date.now(),
      });
      return { requestId, foreignVehicleId: foreignVehicle._id, userId: user._id };
    });
  }

  it("listPendingApprovals sanitises a foreign vehicle without hiding the row", async () => {
    // The manager-facing queue, which returns the VIN as well — so an unchecked
    // foreign reference discloses strictly more than the salesperson list does.
    // This guard existed with NO test: an independent review reverted it to the
    // pre-fix cosmetic form and all 22 tests still passed. A surviving mutant on
    // a security guard is itself the finding.
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgA, orgB } = await seedMultiOrg(t);
    const { requestId, foreignVehicleId } = await seedForeignVehicleApproval(t, orgA, orgB, 3131);

    await t.run(async (ctx: any) => {
      const user = await ctx.db
        .query("users")
        .filter((q: any) => q.eq(q.field("clerkId"), "multi_org_sales"))
        .first();
      const role = await ctx.db
        .query("roles")
        .filter((q: any) => q.eq(q.field("orgId"), orgA))
        .first();
      await ctx.db.patch(role._id, { permissions: ["view:vehicles", "approve:requests"] });
      return user;
    });

    const asManager = t.withIdentity({ subject: "multi_org_sales" });
    const rows = await asManager.query(api.approvals.listPendingApprovals, { orgId: orgA });
    const malformed = rows.find((r: any) => r.requestedProfit === 3131) as any;

    // The row STAYS, so the manager can still reject it and the badge count
    // cannot drift away from the list. Dropping it created a phantom queue.
    expect(malformed).toBeDefined();
    expect(malformed._id).toBe(requestId);

    // ...but nothing of Org B's crosses: no description, no VIN, and above all
    // no actionable id.
    //
    // ⚠️ `vehicleId` is absent from the sanitised branch's TYPE as well, not
    // merely from its value — `tsc` rejected an earlier version of this
    // assertion with "Property 'vehicleId' does not exist", which is a stronger
    // guarantee than the runtime check below and the reason the cast is scoped
    // to this variable rather than applied to the query.
    expect(malformed.vehicleMakeModel).toBe("Unknown Vehicle");
    expect(malformed.vehicleVin).toBe("N/A");
    expect(malformed.vehicleId).toBeUndefined();
    expect(JSON.stringify(malformed)).not.toContain(foreignVehicleId);
    expect(JSON.stringify(malformed)).not.toContain("Honda");
  });

  it("the pending badge never disagrees with the manager's queue", async () => {
    // The phantom queue, stated as the invariant rather than as one symptom:
    // countPending drives a navigation badge and listPendingApprovals draws the
    // page. If they can ever disagree, a manager sees work that does not exist
    // and has no way to clear it.
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgA, orgB } = await seedMultiOrg(t);
    await seedForeignVehicleApproval(t, orgA, orgB, 3131);

    await t.run(async (ctx: any) => {
      const role = await ctx.db
        .query("roles")
        .filter((q: any) => q.eq(q.field("orgId"), orgA))
        .first();
      await ctx.db.patch(role._id, { permissions: ["view:vehicles", "approve:requests"] });
    });

    const asManager = t.withIdentity({ subject: "multi_org_sales" });
    const count = await asManager.query(api.approvals.countPending, { orgId: orgA });
    const rows = await asManager.query(api.approvals.listPendingApprovals, { orgId: orgA });

    expect(count).toBe(rows.length);
  });

  it("respondToApproval does not put a foreign vehicle into the notification", async () => {
    // The one path that EMAILS the vehicle description rather than rendering
    // it. Also had no test: reverting the guard left all 22 passing.
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgA, orgB } = await seedMultiOrg(t);
    const { requestId } = await seedForeignVehicleApproval(t, orgA, orgB, 3131);

    await t.run(async (ctx: any) => {
      const role = await ctx.db
        .query("roles")
        .filter((q: any) => q.eq(q.field("orgId"), orgA))
        .first();
      await ctx.db.patch(role._id, { permissions: ["view:vehicles", "approve:requests"] });
    });

    const asManager = t.withIdentity({ subject: "multi_org_sales" });
    await asManager.mutation(api.approvals.respondToApproval, {
      orgId: orgA,
      requestId,
      status: "APPROVED",
    });

    const notifications = await t.run(async (ctx: any) =>
      await ctx.db.query("notifications").collect()
    );
    const serialised = JSON.stringify(notifications);
    expect(notifications.length).toBeGreaterThan(0);
    expect(serialised).not.toContain("Honda");
  });

  it("requestProfitApproval never overwrites another org's request — cross-tenant WRITE", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgA, orgB } = await seedMultiOrg(t);

    const { vehAId, foreignRequestId } = await t.run(async (ctx: any) => {
      const user = await ctx.db
        .query("users")
        .filter((q: any) => q.eq(q.field("clerkId"), "multi_org_sales"))
        .first();

      // ⚠️ A FRESH Org A vehicle with no requests of its own. The first version
      // of this test reused the seeded vehicle, which already carries an Org A
      // PENDING row inserted before the foreign one — so `.first()` returned
      // Org A's row, the handler patched the correct record, and the test
      // passed against the UNFIXED code. It proved nothing. The foreign row has
      // to be the only candidate for the dedup lookup to be the thing under
      // test.
      const vehA2 = await ctx.db.insert("vehicles", {
        orgId: orgA,
        make: "Mazda",
        model: "Model",
        status: "AVAILABLE",
        vin: "VINORGA0000000002",
        year: 2023,
        mileage: 500,
        color: "Blue",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 21000,
      });

      // Org B's PENDING request against ORG A's vehicle, same salesperson, and
      // the only PENDING row for that vehicle anywhere.
      const foreign = await ctx.db.insert("profitApprovalRequests", {
        orgId: orgB,
        vehicleId: vehA2,
        requestedProfit: 4242,
        minimumProfit: 500,
        salespersonId: user._id,
        status: "PENDING",
        createdAt: Date.now(),
      });
      return { vehAId: vehA2, foreignRequestId: foreign };
    });

    const asUser = t.withIdentity({ subject: "multi_org_sales" });
    await asUser.mutation(api.approvals.requestProfitApproval, {
      orgId: orgA,
      vehicleId: vehAId,
      requestedProfit: 555,
      minimumProfit: 500,
      wizardSnapshot: {
        paymentType: "CASH",
        vehiclePrice: 20000,
        desiredProfit: 555,
        downPayment: 0,
        termMonths: 0,
      },
    });

    // The dedup lookup reads `by_vehicle` — a GLOBAL vehicle key — narrowed
    // only by salesperson and status. Nothing constrains the request's org, so
    // Org B's row satisfies it and the handler PATCHES that row instead of
    // creating one for Org A.
    //
    // This is the same shape as the read defect, but it writes: Org A's
    // requested profit and wizard snapshot land in Org B's record, and Org A
    // gets no approval at all. Worse in both directions than the leak this
    // ticket was opened for.
    const foreign = await t.run(async (ctx: any) => await ctx.db.get(foreignRequestId)) as any;
    expect(foreign.orgId).toBe(orgB);
    expect(foreign.requestedProfit).toBe(4242);

    const orgARequests = await t.run(async (ctx: any) =>
      (await ctx.db.query("profitApprovalRequests").collect()).filter(
        (r: any) => r.orgId === orgA && r.requestedProfit === 555
      )
    );
    expect(orgARequests).toHaveLength(1);
  });

  it("checkPendingApproval never returns another org's request for an in-org vehicle", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgA, orgB } = await seedMultiOrg(t);

    await t.run(async (ctx: any) => {
      const user = await ctx.db
        .query("users")
        .filter((q: any) => q.eq(q.field("clerkId"), "multi_org_sales"))
        .first();
      const vehA = await ctx.db
        .query("vehicles")
        .filter((q: any) => q.eq(q.field("orgId"), orgA))
        .first();

      // Org B's approval, pointing at ORG A's vehicle, and NEWER than Org A's
      // own — so the handler's "most recent wins" sort selects it. The read is
      // `by_vehicle`, which is keyed on the global vehicle id and filtered only
      // by salesperson, so nothing in the query constrains the request's org.
      await ctx.db.insert("profitApprovalRequests", {
        orgId: orgB,
        vehicleId: vehA._id,
        requestedProfit: 7777,
        minimumProfit: 500,
        salespersonId: user._id,
        status: "PENDING",
        createdAt: Date.now(),
      });
    });

    const asUser = t.withIdentity({ subject: "multi_org_sales" });
    const result = await asUser.query(api.approvals.checkPendingApproval, {
      orgId: orgA,
      vehicleId: await t.run(async (ctx: any) => {
        const v = await ctx.db
          .query("vehicles")
          .filter((q: any) => q.eq(q.field("orgId"), orgA))
          .first();
        return v._id;
      }),
    });

    // Verifying the VEHICLE is in-org proves nothing about the REQUEST that
    // references it — the same distinction that produced this ticket one
    // function away. My own sibling scan for this defect missed it, because it
    // searched for uses of `by_salesperson` rather than for the shape.
    expect(result).not.toBeNull();
    expect(result!.orgId).toBe(orgA);
    expect(result!.requestedProfit).not.toBe(7777);
  });

  /**
   * ⚠️ Ordering equivalence, and the earlier version of this test asserted the
   * WRONG contract — it pinned ascending `createdAt` and described that as "what
   * the previous implementation did". It was not.
   *
   * Convex appends `_creationTime` to every index as the final ordering field.
   * The old read used `by_salesperson` = ["salespersonId"], so with the
   * salesperson fixed by equality the rows came back in **`_creationTime`**
   * order — insertion order. The new read uses
   * ["orgId","salespersonId","createdAt"], so with org and salesperson fixed it
   * comes back in **`createdAt`** order.
   *
   * Those are different contracts, and `createdAt` is an application field that
   * need not agree with insertion order. `sales/page.tsx` renders this list with
   * a bare `.map()`, so the difference is visible on screen.
   *
   * The seed is deliberately a counterexample: 1000 is inserted FIRST but
   * carries the NEWER `createdAt` (−1 day), 1100 second with −2 days. So
   * insertion order is [1000, 1100] while `createdAt` order is [1100, 1000] —
   * exactly reversed. Asserting insertion order therefore fails against a
   * `createdAt`-ordered implementation, which is what makes this a real
   * equivalence test rather than a restatement of whatever the new code emits.
   */
  it("preserves the previous implementation's ordering when createdAt disagrees with insertion order", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgA } = await seedMultiOrg(t);

    const asUser = t.withIdentity({ subject: "multi_org_sales" });
    const rows = await asUser.query(api.approvals.listMyPendingApprovals, { orgId: orgA });
    const profits = rows.map((r: any) => r.requestedProfit);

    // Insertion order, NOT createdAt order.
    expect(profits).toEqual([1000, 1100]);

    // And state the invariant directly, so the intent survives a fixture change.
    const creationTimes = rows.map((r: any) => r._creationTime);
    expect(creationTimes).toEqual([...creationTimes].sort((a: number, b: number) => a - b));
    expect(creationTimes.length).toBeGreaterThan(1); // ordering over <2 rows is vacuous
  });
});
