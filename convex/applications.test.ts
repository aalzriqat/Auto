import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const PERMISSIONS = [
  "create:sales",
  "view:sales",
  "edit:vehicles",
  "approve:requests",
  "view:finance_applications",
  "create:finance_application",
  "review:finance_application",
  "approve:finance_application",
  "finalize:financed_deal",
  "confirm:finance_disbursement",
  "verify:finance_documents",
];

async function setup() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_app_1", email: "app@test.com", name: "App User" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_app_approver", email: "app.approver@test.com", name: "App Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const asUser = t.withIdentity({ subject: "user_app_1", clerkId: "user_app_1" });
  const asApprover = t.withIdentity({ subject: "user_app_approver", clerkId: "user_app_approver" });

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A222222",
      make: "Kia",
      model: "Sportage",
      year: 2023,
      color: "Blue",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 1000,
      sellingPrice: 20000,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Sam", lastName: "Lee" })
  );

  return { t, orgId, userId, approverId, customerId, vehicleId, asUser, asApprover };
}

describe("applications.finalizeDeal", () => {
  test("closes the quote's lead as WON and stamps quoteId/leadId on the sale", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();

    const leadId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId, vehicleId, source: "Walk-in", stage: "NEGOTIATION" })
    );

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      leadId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });

    const applicationId = await asUser.mutation(api.applications.createFromQuote, {
      orgId,
      quoteId,
    });

    await asUser.mutation(api.applications.updateStatus, {
      orgId,
      applicationId,
      status: "UNDER_REVIEW",
    });

    await asApprover.mutation(api.applications.updateStatus, {
      orgId,
      applicationId,
      status: "APPROVED",
    });

    await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });

    await t.run(async (ctx) => {
      const lead = await ctx.db.get(leadId);
      expect(lead?.stage).toBe("WON");

      const vehicle = await ctx.db.get(vehicleId);
      expect(vehicle?.status).toBe("SOLD");

      const sale = await ctx.db
        .query("sales")
        .withIndex("by_lead", (q) => q.eq("leadId", leadId))
        .first();
      expect(sale).not.toBeNull();
      expect(sale?.quoteId).toBe(quoteId);
      expect(sale?.applicationId).toBe(applicationId);
    });
  });
});
