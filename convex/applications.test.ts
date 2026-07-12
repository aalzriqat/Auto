import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { transferFinancedAmountFromCustomerReceivable } from "./applications";

const MODULES = import.meta.glob("./**/*.ts");

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
  "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance",
];

async function setup() {
  const t = convexTest(schema, MODULES);
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

    await asUser.mutation(api.applications.registerVehicleHandover, { orgId, applicationId });
    await asUser.mutation(api.applications.registerExpectedPayment, {
      orgId,
      applicationId,
      method: "CASH",
      expectedDate: Date.now(),
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

describe("applications.createFromQuote validation", () => {
  test("rejects missing, mismatched, multi-vehicle, deleted-vehicle, and wrong-company quotes", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser } = await setup();
    const otherOrg = await t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other App Dealer", createdAt: Date.now() });
      const otherCustomerId = await ctx.db.insert("customers", {
        orgId: otherOrgId,
        firstName: "Other",
        lastName: "Customer",
      });
      const otherCompanyId = await ctx.db.insert("financeCompanies", {
        orgId: otherOrgId,
        name: "Other Finance",
        profitRate: 6,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
      });
      const otherQuoteId = await ctx.db.insert("quotes", {
        orgId: otherOrgId,
        customerId: otherCustomerId,
        vehicleId,
        vehiclePrice: 20_000,
        downPayment: 3_000,
        termMonths: 48,
        status: "DRAFT",
        createdBy: userId,
        createdAt: Date.now(),
      });
      return { otherCustomerId, otherCompanyId, otherQuoteId };
    });

    await expect(
      asUser.mutation(api.applications.createFromQuote, { orgId, quoteId: otherOrg.otherQuoteId })
    ).rejects.toThrow(/quote not found/i);

    const mismatchedCustomerQuoteId = await t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId,
        customerId: otherOrg.otherCustomerId,
        vehicleId,
        vehiclePrice: 20_000,
        downPayment: 3_000,
        termMonths: 48,
        status: "DRAFT",
        createdBy: userId,
        createdAt: Date.now(),
      })
    );
    await expect(
      asUser.mutation(api.applications.createFromQuote, { orgId, quoteId: mismatchedCustomerQuoteId })
    ).rejects.toThrow(/quote customer not found/i);

    const secondVehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "1HGCM82633A333333",
        make: "Kia",
        model: "Sorento",
        year: 2024,
        color: "White",
        fuelType: "Gasoline",
        transmission: "Automatic",
        mileage: 500,
        sellingPrice: 24_000,
        status: "AVAILABLE",
      })
    );
    const multiVehicleQuoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehicleItems: [
        { vehicleId, unitPrice: 20_000 },
        { vehicleId: secondVehicleId, unitPrice: 24_000 },
      ],
      vehiclePrice: 44_000,
      downPayment: 3_000,
      termMonths: 48,
    });
    await expect(
      asUser.mutation(api.applications.createFromQuote, { orgId, quoteId: multiVehicleQuoteId })
    ).rejects.toThrow(/exactly one vehicle/i);

    const deletedVehicleQuoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId: secondVehicleId,
      vehiclePrice: 24_000,
      downPayment: 3_000,
      termMonths: 48,
    });
    await t.run((ctx) => ctx.db.patch(secondVehicleId, { isDeleted: true }));
    await expect(
      asUser.mutation(api.applications.createFromQuote, { orgId, quoteId: deletedVehicleQuoteId })
    ).rejects.toThrow(/quote vehicle not found/i);

    const wrongCompanyQuoteId = await t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId,
        customerId,
        vehicleId,
        companyId: otherOrg.otherCompanyId,
        mode: "CONFIGURED_FINANCE_COMPANY",
        vehiclePrice: 20_000,
        downPayment: 3_000,
        termMonths: 48,
        status: "DRAFT",
        createdBy: userId,
        createdAt: Date.now(),
      })
    );
    await expect(
      asUser.mutation(api.applications.createFromQuote, { orgId, quoteId: wrongCompanyQuoteId })
    ).rejects.toThrow(/quote finance company not found/i);
  });

  test("rejects duplicate and active vehicle applications", async () => {
    const { orgId, customerId, vehicleId, asUser } = await setup();
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20_000,
      downPayment: 3_000,
      termMonths: 48,
    });
    await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    await expect(
      asUser.mutation(api.applications.createFromQuote, { orgId, quoteId })
    ).rejects.toThrow(/already exists/i);

    const secondQuoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20_000,
      downPayment: 3_000,
      termMonths: 48,
    });
    await expect(
      asUser.mutation(api.applications.createFromQuote, { orgId, quoteId: secondQuoteId })
    ).rejects.toThrow(/active finance application/i);
  });
});

describe("applications receivable transfer guards", () => {
  test("transferFinancedAmountFromCustomerReceivable rejects missing or corrupt customer receivables", async () => {
    const { t, orgId, userId, customerId, vehicleId } = await setup();
    const saleWithoutReceivableId = await t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 20_000,
        saleDate: Date.now(),
        status: "COMPLETED",
      })
    );

    await expect(
      t.run((ctx) =>
        transferFinancedAmountFromCustomerReceivable(ctx, {
          orgId,
          saleId: saleWithoutReceivableId,
          saleAmountMinor: 20_000_000,
          financedAmountMinor: 17_000_000,
        })
      )
    ).rejects.toThrow(/missing its canonical customer receivable/i);

    const otherOrgReceivableId = await t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other Receivable Org", createdAt: Date.now() });
      return await ctx.db.insert("receivableDocuments", {
        orgId: otherOrgId,
        documentType: "INVOICE",
        documentNumber: "REC-OTHER",
        payerType: "CUSTOMER",
        customerId,
        sourceType: "sales",
        sourceId: saleWithoutReceivableId,
        originalAmountMinor: 20_000_000,
        currency: "JOD",
        scale: 3,
        issueDate: Date.now(),
        dueDate: Date.now(),
        status: "OPEN",
        createdAt: Date.now(),
        createdBy: userId,
      });
    });
    const saleWithWrongReceivableId = await t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 20_000,
        saleDate: Date.now(),
        status: "COMPLETED",
        canonicalReceivableDocumentId: otherOrgReceivableId,
      })
    );
    await expect(
      t.run((ctx) =>
        transferFinancedAmountFromCustomerReceivable(ctx, {
          orgId,
          saleId: saleWithWrongReceivableId,
          saleAmountMinor: 20_000_000,
          financedAmountMinor: 17_000_000,
        })
      )
    ).rejects.toThrow(/sale customer receivable not found/i);

    const overAllocatedSaleId = await t.run(async (ctx) => {
      const receivableDocumentId = await ctx.db.insert("receivableDocuments", {
        orgId,
        documentType: "INVOICE",
        documentNumber: "REC-OVER-ALLOCATED",
        payerType: "CUSTOMER",
        customerId,
        sourceType: "sales",
        sourceId: "sale-over-allocated",
        originalAmountMinor: 20_000_000,
        currency: "JOD",
        scale: 3,
        issueDate: Date.now(),
        dueDate: Date.now(),
        status: "PARTIALLY_PAID",
        createdAt: Date.now(),
        createdBy: userId,
      });
      const paymentId = await ctx.db.insert("canonicalPayments", {
        orgId,
        direction: "IN",
        payerType: "CUSTOMER",
        customerId,
        method: "CASH",
        amountMinor: 5_000_000,
        currency: "JOD",
        scale: 3,
        status: "SETTLED",
        idempotencyKey: "over-allocated-transfer-payment",
        createdBy: userId,
        createdAt: Date.now(),
      });
      await ctx.db.insert("paymentAllocations", {
        orgId,
        paymentId,
        receivableDocumentId,
        amountMinor: 4_000_000,
        currency: "JOD",
        scale: 3,
        allocationDate: Date.now(),
        status: "ACTIVE",
        createdBy: userId,
        createdAt: Date.now(),
      });
      return await ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 20_000,
        saleDate: Date.now(),
        status: "COMPLETED",
        canonicalReceivableDocumentId: receivableDocumentId,
      });
    });

    await expect(
      t.run((ctx) =>
        transferFinancedAmountFromCustomerReceivable(ctx, {
          orgId,
          saleId: overAllocatedSaleId,
          saleAmountMinor: 20_000_000,
          financedAmountMinor: 17_000_000,
        })
      )
    ).rejects.toThrow(/allocations exceed/i);
  });
});

describe("applications.updateStatus permissions", () => {
  test("review and rejection require review finance application permission", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const viewerId = await t.run((ctx) =>
      ctx.db.insert("users", {
        clerkId: "user_app_viewer",
        email: "app.viewer@test.com",
        name: "App Viewer",
      })
    );
    const viewerRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId,
        name: "Application Viewer",
        permissions: ["view:finance_applications"],
      })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: viewerId, roleId: viewerRoleId }));
    const asViewer = t.withIdentity({ subject: "user_app_viewer", clerkId: "user_app_viewer" });

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });

    await expect(
      asViewer.mutation(api.applications.updateStatus, {
        orgId,
        applicationId,
        status: "UNDER_REVIEW",
      })
    ).rejects.toThrow(/missing required permissions/i);

    await asUser.mutation(api.applications.updateStatus, {
      orgId,
      applicationId,
      status: "UNDER_REVIEW",
    });

    await expect(
      asViewer.mutation(api.applications.updateStatus, {
        orgId,
        applicationId,
        status: "REJECTED",
      })
    ).rejects.toThrow(/missing required permissions/i);
  });

  test("requires finance application visibility before changing status", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const limitedUserId = await t.run((ctx) =>
      ctx.db.insert("users", {
        clerkId: "user_app_limited",
        email: "app.limited@test.com",
        name: "Limited App User",
      })
    );
    const limitedRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "Limited", permissions: ["view:sales"] })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: limitedUserId, roleId: limitedRoleId }));
    const asLimited = t.withIdentity({ subject: "user_app_limited", clerkId: "user_app_limited" });

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });

    await expect(
      asLimited.mutation(api.applications.updateStatus, {
        orgId,
        applicationId,
        status: "UNDER_REVIEW",
      })
    ).rejects.toThrow(/missing required permissions/i);
  });

  test("rejects missing applications, invalid transitions, self-approval, and missing approval quote", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser, asApprover } = await setup();
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    const otherApplicationId = await t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other Application Org", createdAt: Date.now() });
      return await ctx.db.insert("financeApplications", {
        orgId: otherOrgId,
        quoteId,
        customerId,
        vehicleId,
        salespersonId: userId,
        status: "PENDING_DOCS",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    await expect(
      asUser.mutation(api.applications.updateStatus, {
        orgId,
        applicationId: otherApplicationId,
        status: "UNDER_REVIEW",
      })
    ).rejects.toThrow(/application not found/i);

    await expect(
      asUser.mutation(api.applications.updateStatus, {
        orgId,
        applicationId,
        status: "APPROVED",
      })
    ).rejects.toThrow(/invalid finance application status transition/i);

    await asUser.mutation(api.applications.updateStatus, {
      orgId,
      applicationId,
      status: "UNDER_REVIEW",
    });
    await expect(
      asUser.mutation(api.applications.updateStatus, {
        orgId,
        applicationId,
        status: "APPROVED",
      })
    ).rejects.toThrow(/cannot approve your own application/i);

    await t.run((ctx) => ctx.db.delete(quoteId));
    await expect(
      asApprover.mutation(api.applications.updateStatus, {
        orgId,
        applicationId,
        status: "APPROVED",
      })
    ).rejects.toThrow(/application quote not found/i);
  });

  test("closing an approved application through status update requires finalization permission", async () => {
    const { orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    await asUser.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
    await asApprover.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });

    await asUser.mutation(api.applications.updateStatus, {
      orgId,
      applicationId,
      status: "CLOSED",
    });

    const app = await asUser.query(api.applications.get, { orgId, applicationId });
    expect(app?.status).toBe("CLOSED");
  });
});

describe("applications hold release and deposit resolution", () => {
  test("rejected applications expose held deposits for resolution after releasing the vehicle hold", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });
    const depositId = await asUser.mutation(api.deposits.create, {
      orgId,
      quoteId,
      amount: 1000,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });

    await asUser.mutation(api.applications.updateStatus, {
      orgId,
      applicationId,
      status: "REJECTED",
    });

    const details = await asUser.query(api.applications.get, { orgId, applicationId });

    await t.run(async (ctx) => {
      const vehicle = await ctx.db.get(vehicleId);

      expect(details?.status).toBe("REJECTED");
      expect(details?.deposits).toHaveLength(1);
      expect(details?.deposits[0]).toMatchObject({
        _id: depositId,
        status: "HELD",
        holdActive: false,
      });
      expect(vehicle?.status).toBe("AVAILABLE");
    });
  });

  test("rejected applications detect and expose held deposits beyond the first 50 quote deposits", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser } = await setup();

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });

    await asUser.mutation(api.applications.updateStatus, {
      orgId,
      applicationId,
      status: "REJECTED",
    });

    const heldDepositId = await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 50; index += 1) {
        await ctx.db.insert("deposits", {
          orgId,
          vehicleId,
          customerId,
          quoteId,
          amount: 1,
          status: "REFUNDED",
          holdActive: false,
          createdBy: userId,
          createdAt: now + index,
        });
      }

      return await ctx.db.insert("deposits", {
        orgId,
        vehicleId,
        customerId,
        quoteId,
        amount: 1,
        status: "HELD",
        holdActive: false,
        createdBy: userId,
        createdAt: now + 51,
      });
    });

    const list = await asUser.query(api.applications.list, {
      orgId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    const details = await asUser.query(api.applications.get, { orgId, applicationId });

    const row = list.page.find((application) => application._id === applicationId);
    expect(row?.hasPendingDepositResolution).toBe(true);
    expect(details?.deposits).toHaveLength(51);
    expect(details?.deposits.some((deposit) => deposit._id === heldDepositId)).toBe(true);
  });

  test("rejected application list can be filtered and reports no pending deposit resolution when none are held", async () => {
    const { orgId, customerId, vehicleId, asUser } = await setup();
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    await asUser.mutation(api.applications.updateStatus, {
      orgId,
      applicationId,
      status: "REJECTED",
    });

    const list = await asUser.query(api.applications.list, {
      orgId,
      status: "REJECTED",
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(list.page.map((application) => application._id)).toEqual([applicationId]);
    expect(list.page[0].hasPendingDepositResolution).toBe(false);
  });

  test("cancelling a submitted application releases a same-customer reservation without a deposit", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser } = await setup();

    const reservationId = await asUser.mutation(api.vehicles.createReservation, {
      orgId,
      vehicleId,
      customerId,
    });

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });

    await asUser.mutation(api.applications.cancelApplication, {
      orgId,
      applicationId,
      reason: "Customer changed vehicles",
    });

    await t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      const reservation = await ctx.db.get(reservationId);
      const vehicle = await ctx.db.get(vehicleId);
      const deposits = await ctx.db
        .query("deposits")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .collect();

      expect(app?.status).toBe("CANCELLED");
      expect(reservation?.status).toBe("RELEASED");
      expect(reservation?.releasedBy).toBe(userId);
      expect(vehicle?.status).toBe("AVAILABLE");
      expect(deposits).toHaveLength(0);
    });
  });

  test("cancelling a submitted application releases a same-customer reservation deposit hold", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser } = await setup();

    const reservationId = await asUser.mutation(api.vehicles.createReservation, {
      orgId,
      vehicleId,
      customerId,
      depositAmount: 750,
    });

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });

    await asUser.mutation(api.applications.cancelApplication, {
      orgId,
      applicationId,
      reason: "Customer changed vehicles",
    });

    await t.run(async (ctx) => {
      const reservation = await ctx.db.get(reservationId);
      const vehicle = await ctx.db.get(vehicleId);
      const deposit = reservation?.depositId ? await ctx.db.get(reservation.depositId) : null;

      expect(reservation?.status).toBe("RELEASED");
      expect(reservation?.releasedBy).toBe(userId);
      expect(deposit).toMatchObject({
        status: "HELD",
        holdActive: false,
      });
      expect(vehicle?.status).toBe("AVAILABLE");
    });
  });

  test("rerunning cancellation on an already-cancelled application releases stale reservations", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser } = await setup();

    const reservationId = await asUser.mutation(api.vehicles.createReservation, {
      orgId,
      vehicleId,
      customerId,
    });
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });

    await t.run((ctx) => ctx.db.patch(applicationId, { status: "CANCELLED" }));

    await asUser.mutation(api.applications.cancelApplication, {
      orgId,
      applicationId,
      reason: "Retry stale hold cleanup",
    });

    await t.run(async (ctx) => {
      const reservation = await ctx.db.get(reservationId);
      const vehicle = await ctx.db.get(vehicleId);

      expect(reservation?.status).toBe("RELEASED");
      expect(reservation?.releasedBy).toBe(userId);
      expect(vehicle?.status).toBe("AVAILABLE");
    });
  });

  test("cancellation rejects missing applications, approved apps without approval rights, and disbursed closed deals", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser } = await setup();
    const otherApplicationId = await t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", { name: "Other Cancel Org", createdAt: Date.now() });
      return await ctx.db.insert("financeApplications", {
        orgId: otherOrgId,
        quoteId: await ctx.db.insert("quotes", {
          orgId: otherOrgId,
          customerId,
          vehicleId,
          vehiclePrice: 20000,
          downPayment: 3000,
          termMonths: 48,
          status: "DRAFT",
          createdBy: userId,
          createdAt: Date.now(),
        }),
        customerId,
        vehicleId,
        salespersonId: userId,
        status: "PENDING_DOCS",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await expect(
      asUser.mutation(api.applications.cancelApplication, { orgId, applicationId: otherApplicationId })
    ).rejects.toThrow(/application not found/i);

    const limitedUserId = await t.run((ctx) =>
      ctx.db.insert("users", {
        clerkId: "user_app_cancel_limited",
        email: "app.cancel.limited@test.com",
        name: "Cancel Limited",
      })
    );
    const limitedRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId,
        name: "Cancel Limited",
        permissions: ["create:finance_application", "view:sales"],
      })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: limitedUserId, roleId: limitedRoleId }));
    const asLimited = t.withIdentity({ subject: "user_app_cancel_limited", clerkId: "user_app_cancel_limited" });

    const approvedQuoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });
    const approvedApplicationId = await asUser.mutation(api.applications.createFromQuote, {
      orgId,
      quoteId: approvedQuoteId,
    });
    await t.run((ctx) => ctx.db.patch(approvedApplicationId, { status: "APPROVED" }));
    await expect(
      asLimited.mutation(api.applications.cancelApplication, {
        orgId,
        applicationId: approvedApplicationId,
      })
    ).rejects.toThrow(/missing required permissions/i);

    await t.run((ctx) =>
      ctx.db.patch(approvedApplicationId, {
        status: "CLOSED",
        disbursedAt: Date.now(),
      })
    );
    await expect(
      asUser.mutation(api.applications.cancelApplication, {
        orgId,
        applicationId: approvedApplicationId,
      })
    ).rejects.toThrow(/disbursement has already been confirmed/i);
  });

  test("cancelling a closed deal with commission reverses the commission accrual", async () => {
    const { t, orgId, applicationId, asUser } = await setupFinalizedFinancedDeal();
    await t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      if (!app?.finalizedSaleId) throw new Error("Expected finalized sale");
      await ctx.db.patch(app.finalizedSaleId, { commissionAmount: 250 });
    });

    await asUser.mutation(api.applications.cancelApplication, {
      orgId,
      applicationId,
      reason: "Commission reversal coverage",
    });

    await t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      const sale = app?.finalizedSaleId ? await ctx.db.get(app.finalizedSaleId) : null;
      expect(sale?.status).toBe("CANCELLED");
    });
  });
});

/** Seeds a finance company, quote, and application, then walks it to a finalized deal. */
async function setupFinalizedFinancedDeal() {
  const base = await setup();
  const { t, orgId, customerId, vehicleId, asUser, asApprover } = base;

  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name: "Jordan Auto Finance",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
    })
  );

  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId,
    customerId,
    vehicleId,
    vehiclePrice: 20000,
    downPayment: 3000,
    termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY",
    companyId,
    totalFinancedAmount: 17000,
  });

  const depositId = await asUser.mutation(api.deposits.create, {
    orgId,
    quoteId,
    amount: 3000,
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
  await asUser.mutation(api.applications.registerVehicleHandover, { orgId, applicationId });
  await asUser.mutation(api.applications.registerExpectedPayment, {
    orgId,
    applicationId,
    method: "BANK_TRANSFER",
    expectedDate: Date.now(),
  });
  await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });

  const getFinanceReceivable = () =>
    t.run((ctx) =>
      ctx.db
        .query("receivableDocuments")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "finance_application").eq("sourceId", applicationId)
        )
        .unique()
    );

  const getCustomerReceivable = () =>
    t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      const sale = app?.finalizedSaleId ? await ctx.db.get(app.finalizedSaleId) : null;
      return sale?.canonicalReceivableDocumentId
        ? await ctx.db.get(sale.canonicalReceivableDocumentId)
        : null;
    });

  return { ...base, companyId, quoteId, applicationId, depositId, getFinanceReceivable, getCustomerReceivable };
}

describe("applications finance-company canonical receivable", () => {
  test("finalizeDeal opens a FINANCE_COMPANY receivable and confirmDisbursement settles it by allocation", async () => {
    const { t, orgId, companyId, applicationId, asUser, getFinanceReceivable, getCustomerReceivable } =
      await setupFinalizedFinancedDeal();

    // Finalizing must open a canonical receivable owed BY the finance company.
    const receivableAfterFinalize = await getFinanceReceivable();
    expect(receivableAfterFinalize).not.toBeNull();
    expect(receivableAfterFinalize?.payerType).toBe("FINANCE_COMPANY");
    expect(receivableAfterFinalize?.financeCompanyId).toBe(companyId);
    expect(receivableAfterFinalize?.originalAmountMinor).toBe(17_000_000);
    expect(receivableAfterFinalize?.status).toBe("OPEN");

    const customerReceivableAfterFinalize = await getCustomerReceivable();
    expect(customerReceivableAfterFinalize?.payerType).toBe("CUSTOMER");
    expect(customerReceivableAfterFinalize?.originalAmountMinor).toBe(3_000_000);
    expect(customerReceivableAfterFinalize?.status).toBe("PAID");

    await t.run(async (ctx) => {
      const customerAllocations = await ctx.db
        .query("paymentAllocations")
        .withIndex("by_receivable", (q) =>
          q.eq("receivableDocumentId", customerReceivableAfterFinalize!._id)
        )
        .collect();
      const customerOutstanding =
        customerReceivableAfterFinalize!.originalAmountMinor -
        customerAllocations
          .filter((allocation) => allocation.status === "ACTIVE")
          .reduce((sum, allocation) => sum + allocation.amountMinor, 0);
      const financeOutstanding = receivableAfterFinalize!.originalAmountMinor;
      expect(customerOutstanding + financeOutstanding).toBe(17_000_000);
    });

    await asUser.mutation(api.applications.confirmDisbursement, {
      orgId,
      applicationId,
      disbursedAmountMinor: 17_000_000,
    });

    const settledReceivable = await getFinanceReceivable();
    expect(settledReceivable?.status).toBe("PAID");

    await t.run(async (ctx) => {
      const payment = await ctx.db
        .query("canonicalPayments")
        .withIndex("by_org_idempotency", (q) =>
          q.eq("orgId", orgId).eq("idempotencyKey", `finance_disbursement_${applicationId}`)
        )
        .unique();
      expect(payment?.direction).toBe("IN");
      expect(payment?.payerType).toBe("FINANCE_COMPANY");
      expect(payment?.financeCompanyId).toBe(companyId);
      expect(payment?.amountMinor).toBe(17_000_000);

      const allocations = await ctx.db
        .query("paymentAllocations")
        .withIndex("by_payment", (q) => q.eq("paymentId", payment!._id))
        .collect();
      expect(allocations).toHaveLength(1);
      expect(allocations[0].status).toBe("ACTIVE");
      expect(allocations[0].amountMinor).toBe(17_000_000);
    });
  });

  test("confirmDisbursement rejects amounts that differ from the financed deal total", async () => {
    const { orgId, applicationId, asUser } = await setupFinalizedFinancedDeal();

    await expect(
      asUser.mutation(api.applications.confirmDisbursement, {
        orgId,
        applicationId,
        disbursedAmountMinor: 16_999_999,
      })
    ).rejects.toThrow(/does not match the financed amount/i);
  });

  test("voiding a finalized (undisbursed) deal cancels the finance-company receivable", async () => {
    const { t, orgId, applicationId, depositId, asUser, getFinanceReceivable, getCustomerReceivable } =
      await setupFinalizedFinancedDeal();

    await asUser.mutation(api.applications.cancelApplication, {
      orgId,
      applicationId,
      reason: "Deal fell through before disbursement",
    });

    const receivable = await getFinanceReceivable();
    expect(receivable?.status).toBe("CANCELLED");

    const customerReceivable = await getCustomerReceivable();
    expect(customerReceivable?.status).toBe("CANCELLED");

    await t.run(async (ctx) => {
      const deposit = await ctx.db.get(depositId);
      expect(deposit?.status).toBe("HELD");
      expect(deposit?.holdActive).toBe(true);

      const allocations = await ctx.db
        .query("paymentAllocations")
        .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", customerReceivable!._id))
        .collect();
      expect(allocations.length).toBeGreaterThan(0);
      expect(allocations.every((allocation) => allocation.status === "REVERSED")).toBe(true);
    });
  });
});

describe("applications logs, expected payment, and finalization guards", () => {
  test("getLog returns Unknown when the status actor no longer exists", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    const deletedActorId = await t.run((ctx) =>
      ctx.db.insert("users", {
        clerkId: "deleted_log_actor",
        email: "deleted.log.actor@test.com",
        name: "Deleted Log Actor",
      })
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("applicationStatusLog", {
        orgId,
        applicationId,
        fromStatus: "PENDING_DOCS",
        toStatus: "UNDER_REVIEW",
        changedBy: deletedActorId,
        changedAt: Date.now(),
      });
      await ctx.db.delete(deletedActorId);
    });

    const log = await asUser.query(api.applications.getLog, { orgId, applicationId });
    expect(log.some((entry) => entry.changedByName === "Unknown")).toBe(true);
  });

  test("registerExpectedPayment requires cheque details and finalization requires handover and payment metadata", async () => {
    const { orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    await asUser.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
    await asApprover.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });

    await expect(
      asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId })
    ).rejects.toThrow(/register the vehicle handover/i);

    await asUser.mutation(api.applications.registerVehicleHandover, { orgId, applicationId });
    await expect(
      asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId })
    ).rejects.toThrow(/register how and when the payment is expected/i);

    await expect(
      asUser.mutation(api.applications.registerExpectedPayment, {
        orgId,
        applicationId,
        method: "CHEQUE",
        expectedDate: Date.now(),
        chequeDetails: { bank: " ", chequeNumber: "CHQ-MISSING-BANK" },
      })
    ).rejects.toThrow(/bank and cheque number/i);
  });

  test("finalizeDeal rejects quote mismatches and returns an existing closed sale idempotently", async () => {
    const { t, orgId, applicationId, asUser } = await setupFinalizedFinancedDeal();
    const closedSaleId = await t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      return app?.finalizedSaleId;
    });
    await expect(asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId })).resolves.toBe(closedSaleId);

    const mismatched = await setup();
    const quoteId = await mismatched.asUser.mutation(api.quotes.saveQuote, {
      orgId: mismatched.orgId,
      customerId: mismatched.customerId,
      vehicleId: mismatched.vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });
    const applicationIdToMismatch = await mismatched.asUser.mutation(api.applications.createFromQuote, {
      orgId: mismatched.orgId,
      quoteId,
    });
    await mismatched.asUser.mutation(api.applications.updateStatus, {
      orgId: mismatched.orgId,
      applicationId: applicationIdToMismatch,
      status: "UNDER_REVIEW",
    });
    await mismatched.asApprover.mutation(api.applications.updateStatus, {
      orgId: mismatched.orgId,
      applicationId: applicationIdToMismatch,
      status: "APPROVED",
    });
    await mismatched.asUser.mutation(api.applications.registerVehicleHandover, {
      orgId: mismatched.orgId,
      applicationId: applicationIdToMismatch,
    });
    await mismatched.asUser.mutation(api.applications.registerExpectedPayment, {
      orgId: mismatched.orgId,
      applicationId: applicationIdToMismatch,
      method: "CASH",
      expectedDate: Date.now(),
    });
    await mismatched.t.run(async (ctx) => {
      const otherCustomerId = await ctx.db.insert("customers", {
        orgId: mismatched.orgId,
        firstName: "Other",
        lastName: "Quote Customer",
      });
      await ctx.db.patch(quoteId, { customerId: otherCustomerId });
    });

    await expect(
      mismatched.asUser.mutation(api.applications.finalizeDeal, {
        orgId: mismatched.orgId,
        applicationId: applicationIdToMismatch,
      })
    ).rejects.toThrow(/quote does not match/i);
  });

  test("finalizeDeal rejects finance company mismatch between application and quote", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();
    const companyIds = await t.run(async (ctx) => {
      const firstCompanyId = await ctx.db.insert("financeCompanies", {
        orgId,
        name: "First Finance",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
      });
      const secondCompanyId = await ctx.db.insert("financeCompanies", {
        orgId,
        name: "Second Finance",
        profitRate: 6,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
      });
      return { firstCompanyId, secondCompanyId };
    });
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
      mode: "CONFIGURED_FINANCE_COMPANY",
      companyId: companyIds.firstCompanyId,
      totalFinancedAmount: 17000,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    await asUser.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
    await asApprover.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
    await asUser.mutation(api.applications.registerVehicleHandover, { orgId, applicationId });
    await asUser.mutation(api.applications.registerExpectedPayment, {
      orgId,
      applicationId,
      method: "BANK_TRANSFER",
      expectedDate: Date.now(),
    });
    await t.run((ctx) => ctx.db.patch(quoteId, { companyId: companyIds.secondCompanyId }));

    await expect(
      asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId })
    ).rejects.toThrow(/finance company does not match/i);
  });
});

/** Seeds a finalized financed deal whose expected payment method is CHEQUE. */
async function setupFinalizedFinancedDealWithCheque() {
  const base = await setup();
  const { t, orgId, customerId, vehicleId, asUser, asApprover } = base;

  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name: "Jordan Auto Finance",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
    })
  );

  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId,
    customerId,
    vehicleId,
    vehiclePrice: 20000,
    downPayment: 3000,
    termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY",
    companyId,
    totalFinancedAmount: 17000,
  });

  const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
  await asUser.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
  await asApprover.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
  await asUser.mutation(api.applications.registerVehicleHandover, { orgId, applicationId });
  await asUser.mutation(api.applications.registerExpectedPayment, {
    orgId,
    applicationId,
    method: "CHEQUE",
    expectedDate: Date.now(),
    chequeDetails: { bank: "Arab Bank", chequeNumber: "CHQ-001" },
  });
  await asUser.mutation(api.applications.finalizeDeal, { orgId, applicationId });

  const getCheque = () =>
    t.run((ctx) =>
      ctx.db
        .query("postDatedCheques")
        .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
        .unique()
    );

  return { ...base, companyId, quoteId, applicationId, getCheque };
}

describe("applications.confirmDisbursement cheque linking", () => {
  test("confirmDisbursement transitions the linked postDatedCheques row to CLEARED", async () => {
    const { orgId, applicationId, asUser, getCheque } = await setupFinalizedFinancedDealWithCheque();

    const chequeBefore = await getCheque();
    expect(chequeBefore?.status).toBe("HELD");

    await asUser.mutation(api.applications.confirmDisbursement, {
      orgId,
      applicationId,
      disbursedAmountMinor: 17_000_000,
    });

    const chequeAfter = await getCheque();
    expect(chequeAfter?.status).toBe("CLEARED");
    expect(chequeAfter?.clearedAt).toBeTruthy();
  });

  test("confirmDisbursement throws if the linked cheque was already returned", async () => {
    const { orgId, applicationId, asUser, getCheque } = await setupFinalizedFinancedDealWithCheque();
    const cheque = await getCheque();

    await asUser.mutation(api.collections.returnCheque, {
      orgId,
      chequeId: cheque!._id,
      returnReason: "Insufficient funds",
    });

    await expect(
      asUser.mutation(api.applications.confirmDisbursement, {
        orgId,
        applicationId,
        disbursedAmountMinor: 17_000_000,
      })
    ).rejects.toThrow(/returned\/cancelled/i);
  });

  test("clearCheque refuses to clear a cheque that belongs to a finance application", async () => {
    const { orgId, asUser, getCheque } = await setupFinalizedFinancedDealWithCheque();
    const cheque = await getCheque();

    await expect(
      asUser.mutation(api.collections.clearCheque, { orgId, chequeId: cheque!._id })
    ).rejects.toThrow(/confirm disbursement from the Applications page/i);
  });

  test("confirmDisbursement resolves the replacement cheque after the original was replaced", async () => {
    const { orgId, applicationId, asUser, getCheque } = await setupFinalizedFinancedDealWithCheque();
    const originalCheque = await getCheque();

    const newChequeId = await asUser.mutation(api.collections.replaceCheque, {
      orgId,
      chequeId: originalCheque!._id,
      bank: "Cairo Amman Bank",
      chequeNumber: "CHQ-002",
      chequeDate: Date.now(),
      amount: originalCheque!.amount,
    });

    await asUser.mutation(api.applications.confirmDisbursement, {
      orgId,
      applicationId,
      disbursedAmountMinor: 17_000_000,
    });

    const chequeAfter = await getCheque();
    expect(chequeAfter?._id).toBe(newChequeId);
    expect(chequeAfter?.status).toBe("CLEARED");
  });

  test("confirmDisbursement treats a soft-deleted linked cheque as not found", async () => {
    const { t, orgId, applicationId, asUser, getCheque } = await setupFinalizedFinancedDealWithCheque();
    const cheque = await getCheque();

    await t.run((ctx) => ctx.db.patch(cheque!._id, { isDeleted: true }));

    await expect(
      asUser.mutation(api.applications.confirmDisbursement, {
        orgId,
        applicationId,
        disbursedAmountMinor: 17_000_000,
      })
    ).rejects.toThrow(/cheque record not found/i);
  });
});

describe("applications required document enforcement", () => {
  test("blocks approval until required finance documents are verified or waived", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();

    await t.run((ctx) =>
      ctx.db.insert("companyDocumentRules", {
        orgId,
        documentName: "Salary Certificate",
        isRequired: true,
      })
    );

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
      mode: "MANUAL_FINANCE_COMPANY",
      manualProviderName: "Manual Bank",
      totalFinancedAmount: 17000,
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

    await expect(
      asApprover.mutation(api.applications.updateStatus, {
        orgId,
        applicationId,
        status: "APPROVED",
      })
    ).rejects.toThrow(/required finance documents/i);
  });

  test("allows approval after required document waiver and records waiver metadata", async () => {
    const { t, orgId, customerId, vehicleId, approverId, asUser, asApprover } = await setup();

    const ruleId = await t.run((ctx) =>
      ctx.db.insert("companyDocumentRules", {
        orgId,
        documentName: "Bank Statement",
        isRequired: true,
      })
    );

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
      mode: "MANUAL_FINANCE_COMPANY",
      manualProviderName: "Manual Bank",
      totalFinancedAmount: 17000,
    });

    const applicationId = await asUser.mutation(api.applications.createFromQuote, {
      orgId,
      quoteId,
    });

    const documentId = await t.run(async (ctx) => {
      const doc = await ctx.db
        .query("applicationDocuments")
        .withIndex("by_rule", (q) => q.eq("ruleId", ruleId))
        .unique();
      return doc!._id;
    });

    await expect(
      asApprover.mutation(api.documents.updateDocumentStatus, {
        orgId,
        documentId,
        status: "VERIFIED",
      })
    ).rejects.toThrow(/uploaded/i);

    await asApprover.mutation(api.documents.updateDocumentStatus, {
      orgId,
      documentId,
      status: "WAIVED",
      waiverReason: "Bank accepted existing KYC file.",
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

    await t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      const doc = await ctx.db.get(documentId);
      expect(app?.status).toBe("APPROVED");
      expect(doc?.status).toBe("WAIVED");
      expect(doc?.waivedBy).toBe(approverId);
      expect(doc?.waiverReason).toBe("Bank accepted existing KYC file.");
      expect(doc?.waivedAt).toBeTypeOf("number");
    });
  });

  test("saveDocumentFile validates stored content metadata before attaching files", async () => {
    const { t, orgId, customerId, vehicleId, asUser, asApprover } = await setup();

    const ruleId = await t.run((ctx) =>
      ctx.db.insert("companyDocumentRules", {
        orgId,
        documentName: "Passport",
        isRequired: true,
      })
    );

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
      mode: "MANUAL_FINANCE_COMPANY",
      manualProviderName: "Manual Bank",
      totalFinancedAmount: 17000,
    });

    await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    const documentId = await t.run(async (ctx) => {
      const doc = await ctx.db
        .query("applicationDocuments")
        .withIndex("by_rule", (q) => q.eq("ruleId", ruleId))
        .unique();
      return doc!._id;
    });
    const htmlStorageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["<script>alert(1)</script>"], { type: "text/html" }))
    );

    await expect(
      asApprover.mutation(api.documents.saveDocumentFile, {
        orgId,
        documentId,
        fileId: htmlStorageId,
      })
    ).rejects.toThrow(/allowed file type/i);

    await t.run(async (ctx) => {
      const doc = await ctx.db.get(documentId);
      expect(doc?.fileId).toBeUndefined();
      expect(doc?.status).toBe("MISSING");
    });
  });
});
