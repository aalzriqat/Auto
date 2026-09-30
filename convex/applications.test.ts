import { convexTestWithComponents } from "../test-utils/convexTest";
import { registerHandover } from "../test-utils/convexTest";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { transferFinancedAmountFromCustomerReceivable } from "./applications";
import { DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";

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
  "view:finance",
  "verify:finance_documents",
  "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance",
];

async function setup() {
  const t = convexTestWithComponents(schema, MODULES);
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
  const customerStatusId = await t.run((ctx) =>
    ctx.db.insert("orgCustomerStatuses", {
      orgId,
      label: "Eligible",
      isActive: true,
      order: 1,
    })
  );

  return {
    t,
    orgId,
    userId,
    approverId,
    customerId,
    customerStatusId,
    vehicleId,
    asUser,
    asApprover,
  };
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

    await registerHandover(asUser, api, orgId, applicationId);
    await asUser.mutation(api.applications.registerExpectedPayment, {
      orgId,
      applicationId,
      method: "CASH",
      expectedDate: Date.now(),
    });
    await asUser.mutation(api.applications.finalizeDeal, { idempotencyKey: crypto.randomUUID(), orgId, applicationId });

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

  test("an approved application cannot be closed through a bare status update", async () => {
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

    // finalizeDeal is what closes an application: it creates the sale, marks the
    // vehicle sold and posts the accounting, then sets CLOSED together with
    // finalizedSaleId. Letting updateStatus set CLOSED on its own skipped all of
    // that and produced an application that finalizeDeal then refuses forever
    // (it requires APPROVED), stranding the deal.
    await expect(
      asUser.mutation(api.applications.updateStatus, {
        orgId,
        applicationId,
        status: "CLOSED",
      })
    ).rejects.toThrow(/finalizing the deal/i);

    const app = await asUser.query(api.applications.get, { orgId, applicationId });
    expect(app?.status).toBe("APPROVED");
    expect(app?.finalizedSaleId).toBeUndefined();
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
    const depositId = await asUser.mutation(api.deposits.create, { method: "CASH", idempotencyKey: crypto.randomUUID(),
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
      idempotencyKey: crypto.randomUUID(),
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
    const applicationId = await asUser.mutation(api.applications.createFromQuote, {
      orgId,
      quoteId,
      // SCRUM-195: this financed deal CONTINUES the reservation that is holding
      // the car. The reservation is NAMED; the authority verifies it is the one
      // the holding root actually came from. It is never inferred from the
      // customer and the vehicle happening to match.
      adoptReservationId: reservationId,
    });

    await asUser.mutation(api.applications.cancelApplication, { idempotencyKey: crypto.randomUUID(),
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

    const reservationId = await asUser.mutation(api.vehicles.createReservation, { depositMethod: "CASH",
      idempotencyKey: crypto.randomUUID(),
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
    // SCRUM-444 R-B: `createFromQuote` no longer ADOPTS a funded reservation, so
    // this HISTORICAL shape — a funded reservation whose deal was already
    // re-headed onto the quote by the pre-fix adoption — is built the way that
    // adoption left it (root.headQuoteId = quote). The quote then JOINS the root
    // by lineage, and cancelling still has to lift the reservation deposit hold.
    await t.run(async (ctx) => {
      const root = await ctx.db
        .query("commitmentRoots")
        .withIndex("by_org_vehicle_status", (q) =>
          q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("status", "OPEN")
        )
        .unique();
      await ctx.db.patch(root!._id, { headQuoteId: quoteId });
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, {
      orgId,
      quoteId,
    });

    await asUser.mutation(api.applications.cancelApplication, { idempotencyKey: crypto.randomUUID(),
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

  test("explicitly repairs a pre-fix in-flight application's missing quote lineage", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 14_200,
      downPayment: 1_955,
      termMonths: 48,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, {
      orgId,
      quoteId,
    });
    // Reproduce a row created by the prior production code while preserving its
    // modern workflow/rule fields.
    await t.run((ctx) =>
      ctx.db.patch(applicationId, {
        economicsCurrency: undefined,
        targetSellingAmountMinor: undefined,
        targetNetProceedsMinor: undefined,
        customerFirstPaymentMinor: undefined,
        estimatedDealerBorneExpensesMinor: undefined,
        estimatedClosingExpensesMinor: undefined,
      })
    );

    const dryRun = await asUser.mutation(api.applications.repairQuoteEconomicsLineage, {
      orgId,
      applicationId,
      expectedCurrency: "JOD",
      dryRun: true,
    });
    expect(dryRun.applied).toBe(false);
    expect(dryRun.expected.targetSellingAmountMinor).toBe(14_200_000);
    expect(dryRun.expected.customerFirstPaymentMinor).toBe(1_955_000);
    expect((await t.run((ctx) => ctx.db.get(applicationId)))?.targetNetProceedsMinor).toBeUndefined();

    const applied = await asUser.mutation(api.applications.repairQuoteEconomicsLineage, {
      orgId,
      applicationId,
      expectedCurrency: "JOD",
      dryRun: false,
    });
    expect(applied.applied).toBe(true);
    const repaired = await t.run((ctx) => ctx.db.get(applicationId));
    expect(repaired).toMatchObject({
      economicsCurrency: "JOD",
      targetSellingAmountMinor: 14_200_000,
      targetNetProceedsMinor: 14_200_000,
      customerFirstPaymentMinor: 1_955_000,
      estimatedDealerBorneExpensesMinor: 0,
      estimatedClosingExpensesMinor: 0,
    });

    const rerun = await asUser.mutation(api.applications.repairQuoteEconomicsLineage, {
      orgId,
      applicationId,
      expectedCurrency: "JOD",
      dryRun: false,
    });
    expect(rerun).toMatchObject({ applied: false, missing: [] });
  });

  test.each([
    {
      name: "refuses repair when application status is terminal (not in-flight)",
      patch: { status: "CANCELLED" as const },
      expectedError: "Only an in-flight finance application can have quote lineage repaired.",
    },
    {
      name: "refuses repair when downstream milestone evidence (submitted quotation) exists",
      patch: { submittedQuotationMinor: 10_000_000 },
      expectedError: "Quotation, approval, disbursement, or finalization evidence already exists. Reconcile this application manually.",
    },
    {
      name: "refuses repair when downstream milestone evidence (approved purchase) exists",
      patch: { approvedDealerPurchaseAmountMinor: 10_000_000 },
      expectedError: "Quotation, approval, disbursement, or finalization evidence already exists. Reconcile this application manually.",
    },
    {
      name: "refuses repair when requested currency does not match organization currency",
      patch: {},
      requestedCurrency: "USD",
      expectedError: "Expected denomination USD does not match the organization denomination JOD.",
    },
    {
      name: "refuses repair when application already denominated in a different currency",
      patch: { economicsCurrency: "USD" },
      requestedCurrency: "JOD",
      expectedError: "The application is already denominated in USD; it cannot be repaired as JOD.",
    },
    {
      name: "refuses repair when company-backed application is missing its frozen rule snapshot",
      patch: { companyRuleSnapshot: undefined },
      withCompany: true,
      expectedError: "The application's frozen finance-company policy is missing. Reconcile the policy snapshot before repairing quotation economics.",
    },
  ])("repairQuoteEconomicsLineage fail-closed: $name", async ({ patch, expectedError, requestedCurrency, withCompany }) => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    let companyId: Id<"financeCompanies"> | undefined;
    if (withCompany) {
      companyId = await t.run((ctx) =>
        ctx.db.insert("financeCompanies", {
          orgId,
          name: "Test Financier",
          isActive: true,
          profitRate: 5.5,
          maxTermMonths: 72,
          gracePeriodMonths: 3,
        })
      );
    }
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 14_200,
      downPayment: 1_955,
      termMonths: 48,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, {
      orgId,
      quoteId,
    });

    await t.run((ctx) =>
      ctx.db.patch(applicationId, {
        targetSellingAmountMinor: undefined,
        targetNetProceedsMinor: undefined,
        customerFirstPaymentMinor: undefined,
        estimatedDealerBorneExpensesMinor: undefined,
        estimatedClosingExpensesMinor: undefined,
        ...(withCompany ? { companyId } : {}),
        ...patch,
      })
    );

    const snapshotBefore = await t.run((ctx) => ctx.db.get(applicationId));

    await expect(
      asUser.mutation(api.applications.repairQuoteEconomicsLineage, {
        orgId,
        applicationId,
        expectedCurrency: requestedCurrency ?? "JOD",
        dryRun: false,
      })
    ).rejects.toThrow(expectedError);

    const snapshotAfter = await t.run((ctx) => ctx.db.get(applicationId));
    expect(snapshotAfter).toEqual(snapshotBefore);
  });

  test("rerunning cancellation on an already-cancelled application releases stale reservations", async () => {
    const { t, orgId, userId, customerId, vehicleId, asUser } = await setup();

    const reservationId = await asUser.mutation(api.vehicles.createReservation, {
      idempotencyKey: crypto.randomUUID(),
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
    const applicationId = await asUser.mutation(api.applications.createFromQuote, {
      orgId,
      quoteId,
      // SCRUM-195: this financed deal CONTINUES the reservation that is holding
      // the car. The reservation is NAMED; the authority verifies it is the one
      // the holding root actually came from. It is never inferred from the
      // customer and the vehicle happening to match.
      adoptReservationId: reservationId,
    });

    await t.run((ctx) => ctx.db.patch(applicationId, { status: "CANCELLED" }));

    await asUser.mutation(api.applications.cancelApplication, { idempotencyKey: crypto.randomUUID(),
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
      asUser.mutation(api.applications.cancelApplication, { idempotencyKey: crypto.randomUUID(), orgId, applicationId: otherApplicationId })
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
      asLimited.mutation(api.applications.cancelApplication, { idempotencyKey: crypto.randomUUID(),
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
      asUser.mutation(api.applications.cancelApplication, { idempotencyKey: crypto.randomUUID(),
        orgId,
        applicationId: approvedApplicationId,
      })
    ).rejects.toThrow(/disbursement has already been confirmed/i);
  });

  // NOTE: this fixture has no chart of accounts and no accounting period, so
  // nothing here can post to the ledger and no reversal can be asserted from
  // it. The name used to promise otherwise. What it actually pins is that
  // cancelling a finalized deal cancels the SALE — the reversal itself is
  // covered against real books in convex/commissionAccrualTiming.test.ts
  // ("voiding a sale backs the whole commission out of the ledger"), which
  // exercises the same reverseCommissionForSale through the other call site.
  test("cancelling a closed deal with a commission cancels the underlying sale", async () => {
    const { t, orgId, applicationId, asUser } = await setupFinalizedFinancedDeal();
    await t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      if (!app?.finalizedSaleId) throw new Error("Expected finalized sale");
      await ctx.db.patch(app.finalizedSaleId, { commissionAmount: 250 });
    });

    await asUser.mutation(api.applications.cancelApplication, { idempotencyKey: crypto.randomUUID(),
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

  test("TASK-DEAL-05: cancelApplication persists failureReason and appraisalFeeResponsibility", async () => {
    const { t, orgId, applicationId, asUser } = await setupFinalizedFinancedDeal();

    await asUser.mutation(api.applications.cancelApplication, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      applicationId,
      reason: "Customer withdrew after appraisal",
      failureReason: "CUSTOMER_WITHDREW",
      failureNotes: "Customer chose different vehicle elsewhere",
      appraisalFeeResponsibility: "CUSTOMER",
      appraisalFeeResponsibilityReason: "Customer cancelled post-approval without cause",
    });

    await t.run(async (ctx) => {
      const app = await ctx.db.get(applicationId);
      expect(app?.status).toBe("CANCELLED");
      expect(app?.failureReason).toBe("CUSTOMER_WITHDREW");
      expect(app?.failureNotes).toBe("Customer chose different vehicle elsewhere");
      expect(app?.failedAt).toBeGreaterThan(0);
      expect(app?.failedBy).toBeDefined();
      expect(app?.appraisalFeeResponsibility).toBe("CUSTOMER");
      expect(app?.appraisalFeeResponsibilityReason).toBe(
        "Customer cancelled post-approval without cause"
      );
    });

    // Also test default mapping when responsibility is omitted
    const deal2 = await setupFinalizedFinancedDeal();
    await deal2.asUser.mutation(api.applications.cancelApplication, {
      idempotencyKey: crypto.randomUUID(),
      orgId: deal2.orgId,
      applicationId: deal2.applicationId,
      failureReason: "APPRAISAL_TOO_LOW",
    });

    await deal2.t.run(async (ctx) => {
      const app = await ctx.db.get(deal2.applicationId);
      expect(app?.status).toBe("CANCELLED");
      expect(app?.failureReason).toBe("APPRAISAL_TOO_LOW");
      expect(app?.appraisalFeeResponsibility).toBe("DEALER");
    });
  });
});

/** Seeds a finance company, quote, and application, then walks it to a finalized deal. */

/**
 * Puts a financed deal in the state finalization now requires.
 *
 * Before SCRUM-192 these fixtures finalized on the legacy no-quotation carve-out,
 * and the deal posted from the customer's financing principal. Finalization now
 * needs the figures the settlement actually posts from — what the company
 * approved, and a classified accounting basis — so the fixture drives the same
 * writers an operator would.
 */
async function recordFinancedDealEconomics(
  ids: { orgId: any; applicationId: any; asUser: any; asApprover: any },
  vehiclePrice: number
) {
  const { orgId, applicationId, asUser, asApprover } = ids;
  await asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId,
    applicationId,
    submittedQuotationMinor: vehiclePrice * 1000,
    source: "MANUAL_ENTRY",
  });
  await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId,
    applicationId,
    approvedAmountMinor: vehiclePrice * 1000,
    basis: "MANUAL",
    notes: "Approved at the quotation.",
  });
}

/** The legal invoice and a reconciled cost basis — what classification requires. */
async function classifyFinancedDeal(
  ids: { orgId: any; applicationId: any; asUser: any },
  vehiclePrice: number
) {
  const { orgId, applicationId, asUser } = ids;
  await asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
    orgId,
    applicationId,
    legalInvoiceAmountMinor: vehiclePrice * 1000,
    legalInvoiceNumber: `INV-${applicationId}`,
    legalInvoiceDate: Date.now(),
    issuedTo: "FINANCE_COMPANY",
  });
  const feeId = await asUser.mutation(api.financeDealCosts.recordDealFee, { expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(),
    orgId,
    applicationId,
    feeType: "OTHER_CLOSING_EXPENSE",
    paidBy: "DEALER",
    paidTo: "OTHER",
    accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false,
    actualAmountMinor: 0,
    description: "The dealership bore no closing costs on this deal.",
  });
  await asUser.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId,
    feeId,
    notes: "Nothing to match.",
  });
  // SCRUM-407: no manual classification step — finalization checks readiness itself.
}
async function setupFinalizedFinancedDeal() {
  const base = await setup();
  const { t, orgId, customerId, customerStatusId, vehicleId, asUser, asApprover } = base;

  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name: "Jordan Auto Finance",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
      adminFees: 0,
      // The quotation solver refuses a company with no LTV, and the application
      // freezes the company's rules at creation. At 100% the company funds the
      // whole approval, which keeps these tests about the receivable rather than
      // about the funding split.
      defaultLtvPercent: 100,
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
    customerEligibilityStatusIds: [customerStatusId],
    totalFinancedAmount: 17000,
  });

  const depositId = await asUser.mutation(api.deposits.create, { method: "CASH", idempotencyKey: crypto.randomUUID(),
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
  // Before handover, which seals the approved amount.
  await recordFinancedDealEconomics({ orgId, applicationId, asUser, asApprover }, 20000);
  await registerHandover(asUser, api, orgId, applicationId);
  await asUser.mutation(api.applications.registerExpectedPayment, {
    orgId,
    applicationId,
    method: "BANK_TRANSFER",
    expectedDate: Date.now(),
  });
  await classifyFinancedDeal({ orgId, applicationId, asUser }, 20000);
  await asUser.mutation(api.applications.finalizeDeal, { idempotencyKey: crypto.randomUUID(), orgId, applicationId });

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

  // SCRUM-435: a v2 deal is paid out only after the dealership has recorded the
  // deposit and contribution it owes the finance company back.
  const recordForward = async () => {
    const due = await t.run(async (ctx) => (await ctx.db.get(applicationId))?.financeCompanyForwardDueMinor ?? 0);
    if (due > 0) {
      // The forward posts to the ledger, so the books must exist. finalizeDeal
      // queued its own posts before this point; only the forward is drained here.
      const fiscalYear = new Date().getUTCFullYear();
      await t.run((ctx) =>
        ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
      );
      await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
      await asUser.mutation(api.accountingPeriods.create, {
        orgId,
        startDate: Date.UTC(fiscalYear, 0, 1),
        endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
        fiscalYear,
        periodNumber: 1,
      });
      const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
      await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
      await asUser.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
        orgId,
        applicationId,
        method: "BANK_TRANSFER",
        paidAt: Date.now(),
        expectedAmountMinor: due,
        idempotencyKey: crypto.randomUUID(),
      });
      // The chart and an open period exist, so the forward posts synchronously.
      // Assert it rather than force it: confirmDisbursement gates on this proof.
      const forwardEvents = await t.run(async (ctx) =>
        (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()).filter(
          (e) => e.eventType === "FINANCE_COMPANY_FORWARD_PAID"
        )
      );
      expect(forwardEvents.map((e) => e.status)).toEqual(["POSTED"]);
    }
    return due;
  };

  return { ...base, companyId, quoteId, applicationId, depositId, getFinanceReceivable, getCustomerReceivable, recordForward };
}

describe("applications finance-company canonical receivable", () => {
  test("finalizeDeal opens a FINANCE_COMPANY receivable and confirmDisbursement settles it by allocation", async () => {
    const { t, orgId, companyId, applicationId, asUser, getFinanceReceivable, getCustomerReceivable, recordForward } =
      await setupFinalizedFinancedDeal();

    // Finalizing must open a canonical receivable owed BY the finance company.
    // SCRUM-435 (Option A): the company sends the FULL approved amount, 20,000,
    // and never deducts the customer's deposit. The deposit (3,000) goes back to
    // the company from the dealership, recorded before the transfer.
    const receivableAfterFinalize = await getFinanceReceivable();
    expect(receivableAfterFinalize).not.toBeNull();
    expect(receivableAfterFinalize?.payerType).toBe("FINANCE_COMPANY");
    expect(receivableAfterFinalize?.financeCompanyId).toBe(companyId);
    expect(receivableAfterFinalize?.originalAmountMinor).toBe(20_000_000);
    expect(receivableAfterFinalize?.status).toBe("OPEN");

    const customerReceivableAfterFinalize = await getCustomerReceivable();
    expect(customerReceivableAfterFinalize?.payerType).toBe("CUSTOMER");
    // This expected 3,000,000 — `salePrice - financedAmount`, left behind by the
    // old transfer and then paid off by the deposit. Under direct recognition the
    // car is invoiced to the financing company, so the customer is billed nothing
    // for it and their deposit is consideration rather than a debt they settle.
    // Both models end with the customer owing nothing; only this one says so
    // without routing the money through a receivable that was never theirs.
    expect(customerReceivableAfterFinalize?.originalAmountMinor).toBe(0);

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
      expect(customerOutstanding + financeOutstanding).toBe(20_000_000);
    });

    // The transfer is refused until the forward is recorded, then confirms the
    // full approved amount.
    await expect(
      asUser.mutation(api.applications.confirmDisbursement, { idempotencyKey: crypto.randomUUID(),
        orgId,
        applicationId,
        disbursedAmountMinor: 20_000_000,
      })
    ).rejects.toThrow(/have not been paid yet/i);
    expect(await recordForward()).toBe(3_000_000);
    await asUser.mutation(api.applications.confirmDisbursement, { idempotencyKey: crypto.randomUUID(),
      orgId,
      applicationId,
      disbursedAmountMinor: 20_000_000,
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
      expect(payment?.amountMinor).toBe(20_000_000);

      const allocations = await ctx.db
        .query("paymentAllocations")
        .withIndex("by_payment", (q) => q.eq("paymentId", payment!._id))
        .collect();
      expect(allocations).toHaveLength(1);
      expect(allocations[0].status).toBe("ACTIVE");
      expect(allocations[0].amountMinor).toBe(20_000_000);
    });
  });

  test("confirmDisbursement rejects an amount that is not what the company owes", async () => {
    const { orgId, applicationId, asUser, recordForward } = await setupFinalizedFinancedDeal();
    await recordForward();

    await expect(
      asUser.mutation(api.applications.confirmDisbursement, { idempotencyKey: crypto.randomUUID(),
        orgId,
        applicationId,
        disbursedAmountMinor: 19_999_999,
      })
    // SCRUM-435: the yardstick is the FULL approved amount the company sends
    // (20,000,000). It never deducts the deposit, so the old net (17,000,000)
    // is refused too, by the message and not by the number.
    ).rejects.toThrow(/is not what this financing company owes/i);
    await expect(
      asUser.mutation(api.applications.confirmDisbursement, { idempotencyKey: crypto.randomUUID(),
        orgId,
        applicationId,
        disbursedAmountMinor: 17_000_000,
      })
    ).rejects.toThrow(/is not what this financing company owes/i);
  });

  test("voiding a finalized (undisbursed) deal cancels the finance-company receivable", async () => {
    const { t, orgId, applicationId, depositId, asUser, getFinanceReceivable, getCustomerReceivable } =
      await setupFinalizedFinancedDeal();

    await asUser.mutation(api.applications.cancelApplication, { idempotencyKey: crypto.randomUUID(),
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

      // The deposit no longer pays down a customer receivable, because direct
      // recognition raises none for the vehicle leg — so there is no allocation to
      // reverse. What must come back is the application row and the hold, and each
      // exactly once: reversing twice would return the money to a customer whose
      // deposit is still held.
      const applications = await ctx.db.query("depositApplications").collect();
      expect(applications).toHaveLength(1);
      expect(applications[0].status).toBe("REVERSED");
      expect(applications[0].treatment).toBe("FINANCED_SALE_CONSIDERATION");

      const allocations = await ctx.db
        .query("paymentAllocations")
        .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", customerReceivable!._id))
        .collect();
      expect(allocations).toHaveLength(0);
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

  // SCRUM-37: getLog authorised the org the caller named, then read the status
  // log of whatever application id it was given.
  async function seedForeignApplication(t: Awaited<ReturnType<typeof setup>>["t"]) {
    const foreignOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );
    const foreignUserId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "foreign_log_owner", email: "foreign.owner@test.com", name: "Foreign Owner" })
    );
    const foreignRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId: foreignOrgId, name: "Admin", permissions: PERMISSIONS })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId: foreignOrgId, userId: foreignUserId, roleId: foreignRoleId }));
    const asForeign = t.withIdentity({ subject: "foreign_log_owner", clerkId: "foreign_log_owner" });
    const foreignVehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: foreignOrgId,
        vin: "1HGCM82633A333333",
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
    const foreignCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId: foreignOrgId, firstName: "Foreign", lastName: "Buyer" })
    );
    const foreignQuoteId = await asForeign.mutation(api.quotes.saveQuote, {
      orgId: foreignOrgId,
      customerId: foreignCustomerId,
      vehicleId: foreignVehicleId,
      vehiclePrice: 20000,
      downPayment: 3000,
      termMonths: 48,
    });
    const foreignApplicationId = await asForeign.mutation(api.applications.createFromQuote, {
      orgId: foreignOrgId,
      quoteId: foreignQuoteId,
    });
    return { foreignOrgId, foreignApplicationId, asForeign };
  }

  test("getLog refuses another org's application id (SCRUM-37)", async () => {
    const { t, orgId, asUser } = await setup();
    const { foreignOrgId, foreignApplicationId, asForeign } = await seedForeignApplication(t);

    // Control: the foreign org's own history is real and non-empty.
    const own = await asForeign.query(api.applications.getLog, { orgId: foreignOrgId, applicationId: foreignApplicationId });
    expect(own.length).toBeGreaterThan(0);

    await expect(
      asUser.query(api.applications.getLog, { orgId, applicationId: foreignApplicationId })
    ).rejects.toThrow("Finance application not found in this organization.");
  });

  test("getLog answers a missing application exactly as a foreign one (SCRUM-37)", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId, customerId, vehicleId, vehiclePrice: 20000, downPayment: 3000, termMonths: 48,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    await t.run((ctx) => ctx.db.delete(applicationId));

    await expect(
      asUser.query(api.applications.getLog, { orgId, applicationId })
    ).rejects.toThrow("Finance application not found in this organization.");
  });

  /** An owned application carrying one stray log row stamped with another org. */
  async function seedStrayForeignLogRow(changedByName?: string) {
    const fixture = await setup();
    const { t, orgId, customerId, vehicleId, userId, asUser } = fixture;
    const foreignOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );
    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId, customerId, vehicleId, vehiclePrice: 20000, downPayment: 3000, termMonths: 48,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    const changedBy = changedByName
      ? await t.run((ctx) =>
          ctx.db.insert("users", { clerkId: "foreign_actor", email: "foreign.actor@test.com", name: changedByName })
        )
      : userId;
    await t.run((ctx) =>
      ctx.db.insert("applicationStatusLog", {
        orgId: foreignOrgId,
        applicationId,
        fromStatus: "PENDING_DOCS",
        toStatus: "UNDER_REVIEW",
        changedBy,
        changedAt: Date.now(),
        note: "foreign note",
      })
    );
    return { ...fixture, applicationId };
  }

  test("getLog never returns a log row stamped with another org, even under an owned application (SCRUM-37)", async () => {
    const { orgId, asUser, applicationId } = await seedStrayForeignLogRow();

    const log = await asUser.query(api.applications.getLog, { orgId, applicationId });
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((entry) => entry.orgId === orgId)).toBe(true);
  });

  test("dealCockpit's timeline never shows a log row stamped with another org (Sol on PR #343)", async () => {
    const { orgId, asUser, applicationId } = await seedStrayForeignLogRow("Foreign Actor");

    const cockpit = await asUser.query(api.applications.dealCockpit, { orgId, applicationId });
    const timeline = cockpit?.timeline ?? [];
    // Control: the application's own creation entry is still there.
    expect(timeline.length).toBeGreaterThan(0);
    expect(timeline.some((entry) => entry.note === "foreign note")).toBe(false);
    expect(timeline.some((entry) => entry.actorName === "Foreign Actor")).toBe(false);
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
      asUser.mutation(api.applications.finalizeDeal, { idempotencyKey: crypto.randomUUID(), orgId, applicationId })
    ).rejects.toThrow(/register the vehicle handover/i);

    await registerHandover(asUser, api, orgId, applicationId);
    await expect(
      asUser.mutation(api.applications.finalizeDeal, { idempotencyKey: crypto.randomUUID(), orgId, applicationId })
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
    await expect(asUser.mutation(api.applications.finalizeDeal, { idempotencyKey: crypto.randomUUID(), orgId, applicationId })).resolves.toBe(closedSaleId);

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
    await registerHandover(mismatched.asUser, api, mismatched.orgId, applicationIdToMismatch);
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
      mismatched.asUser.mutation(api.applications.finalizeDeal, { idempotencyKey: crypto.randomUUID(),
        orgId: mismatched.orgId,
        applicationId: applicationIdToMismatch,
      })
    ).rejects.toThrow(/quote does not match/i);
  });

  test("finalizeDeal rejects finance company mismatch between application and quote", async () => {
    const { t, orgId, customerId, customerStatusId, vehicleId, asUser, asApprover } = await setup();
    const companyIds = await t.run(async (ctx) => {
      const firstCompanyId = await ctx.db.insert("financeCompanies", {
        orgId,
        name: "First Finance",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
        adminFees: 0,
      });
      const secondCompanyId = await ctx.db.insert("financeCompanies", {
        orgId,
        name: "Second Finance",
        profitRate: 6,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
        adminFees: 0,
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
      customerEligibilityStatusIds: [customerStatusId],
      totalFinancedAmount: 17000,
    });
    const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
    await asUser.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
    await asApprover.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
    await registerHandover(asUser, api, orgId, applicationId);
    await asUser.mutation(api.applications.registerExpectedPayment, {
      orgId,
      applicationId,
      method: "BANK_TRANSFER",
      expectedDate: Date.now(),
    });
    await t.run((ctx) => ctx.db.patch(quoteId, { companyId: companyIds.secondCompanyId }));

    await expect(
      asUser.mutation(api.applications.finalizeDeal, { idempotencyKey: crypto.randomUUID(), orgId, applicationId })
    ).rejects.toThrow(/finance company does not match/i);
  });
});

/** Seeds a finalized financed deal whose expected payment method is CHEQUE. */
async function setupFinalizedFinancedDealWithCheque() {
  const base = await setup();
  const { t, orgId, customerId, customerStatusId, vehicleId, asUser, asApprover } = base;

  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name: "Jordan Auto Finance",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
      // The quotation solver refuses a company with no LTV, and the application
      // freezes the company's rules at creation. At 100% the company funds the
      // whole approval, which keeps these tests about the receivable rather than
      // about the funding split.
      defaultLtvPercent: 100,
      adminFees: 0,
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
    customerEligibilityStatusIds: [customerStatusId],
    totalFinancedAmount: 17000,
  });

  const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
  await asUser.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
  await asApprover.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
  // Before handover, which seals the approved amount.
  await recordFinancedDealEconomics({ orgId, applicationId, asUser, asApprover }, 20000);
  await registerHandover(asUser, api, orgId, applicationId);
  await asUser.mutation(api.applications.registerExpectedPayment, {
    orgId,
    applicationId,
    method: "CHEQUE",
    expectedDate: Date.now(),
    chequeDetails: { bank: "Arab Bank", chequeNumber: "CHQ-001" },
    faceAmount: "20000",
  });
  await classifyFinancedDeal({ orgId, applicationId, asUser }, 20000);
  await asUser.mutation(api.applications.finalizeDeal, { idempotencyKey: crypto.randomUUID(), orgId, applicationId });

  const getCheque = () =>
    t.run((ctx) =>
      ctx.db
        .query("postDatedCheques")
        .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
        .order("desc")
        .first()
    );

  return { ...base, companyId, quoteId, applicationId, getCheque };
}

describe("applications.confirmDisbursement cheque linking", () => {
  test("confirmDisbursement transitions the linked postDatedCheques row to CLEARED", async () => {
    const { orgId, applicationId, asUser, getCheque } = await setupFinalizedFinancedDealWithCheque();

    const chequeBefore = await getCheque();
    expect(chequeBefore?.status).toBe("HELD");

    await asUser.mutation(api.applications.confirmDisbursement, { idempotencyKey: crypto.randomUUID(),
      orgId,
      applicationId,
      disbursedAmountMinor: 20_000_000,
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
      asUser.mutation(api.applications.confirmDisbursement, { idempotencyKey: crypto.randomUUID(),
        orgId,
        applicationId,
        disbursedAmountMinor: 20_000_000,
      })
    ).rejects.toThrow(/returned or cancelled\. Correct the expected payment, then register the new payment/i);
  });

  test("clearCheque refuses to clear a cheque that belongs to a finance application", async () => {
    const { orgId, asUser, getCheque } = await setupFinalizedFinancedDealWithCheque();
    const cheque = await getCheque();

    await expect(
      asUser.mutation(api.collections.clearCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId: cheque!._id })
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
      faceAmount: "20000",
    });

    await asUser.mutation(api.applications.confirmDisbursement, { idempotencyKey: crypto.randomUUID(),
      orgId,
      applicationId,
      disbursedAmountMinor: 20_000_000,
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
      asUser.mutation(api.applications.confirmDisbursement, { idempotencyKey: crypto.randomUUID(),
        orgId,
        applicationId,
        disbursedAmountMinor: 20_000_000,
      })
    ).rejects.toThrow(/cheque record not found/i);
  });
});

/**
 * SCRUM-447 — finance-company cheque lineage, face and lifecycle.
 *
 * Each test states the invariant it defends. Fixtures walk a real financed deal
 * (economics, handover, register the cheque) so the writers are exercised, not
 * hand-seeded rows, except where a LEGACY shape is the point.
 */
async function setupApprovedDealWithCheque(opts: { face?: string; chequeNumber?: string } = {}) {
  const base = await setup();
  const { t, orgId, customerId, customerStatusId, vehicleId, asUser, asApprover } = base;
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name: "Jordan Auto Finance",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
      defaultLtvPercent: 100,
      adminFees: 0,
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
    customerEligibilityStatusIds: [customerStatusId],
    totalFinancedAmount: 17000,
  });
  const applicationId = await asUser.mutation(api.applications.createFromQuote, { orgId, quoteId });
  await asUser.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
  await asApprover.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
  await recordFinancedDealEconomics({ orgId, applicationId, asUser, asApprover }, 20000);
  await registerHandover(asUser, api, orgId, applicationId);

  const registerCheque = (face: string | undefined, chequeNumber: string) =>
    asUser.mutation(api.applications.registerExpectedPayment, {
      orgId,
      applicationId,
      method: "CHEQUE",
      expectedDate: Date.now(),
      chequeDetails: { bank: "Arab Bank", chequeNumber },
      ...(face === undefined ? {} : { faceAmount: face }),
    });
  await registerCheque(opts.face ?? "20000", opts.chequeNumber ?? "CHQ-447-1");

  const rows = () =>
    t.run(async (ctx) => {
      const all = await ctx.db
        .query("postDatedCheques")
        .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
        .collect();
      return all.sort((a, b) => a._creationTime - b._creationTime);
    });
  const finalize = async () => {
    await classifyFinancedDeal({ orgId, applicationId, asUser }, 20000);
    await asUser.mutation(api.applications.finalizeDeal, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      applicationId,
    });
  };
  const confirm = () =>
    asUser.mutation(api.applications.confirmDisbursement, {
      idempotencyKey: crypto.randomUUID(),
      orgId,
      applicationId,
      disbursedAmountMinor: 20_000_000,
    });
  return { ...base, companyId, applicationId, registerCheque, rows, finalize, confirm };
}

describe("SCRUM-447 D0/D1/D2 lineage is permanent and the face is exact", () => {
  test("a new deal cheque records its drawer, lineage and exact minor-unit face", async () => {
    const { rows, companyId, applicationId } = await setupApprovedDealWithCheque({ face: "20000.000" });
    const [cheque] = await rows();
    expect(cheque).toMatchObject({
      applicationId,
      originApplicationId: applicationId,
      drawerType: "FINANCE_COMPANY",
      financeCompanyId: companyId,
      amountMinor: 20_000_000,
      currency: "JOD",
      status: "HELD",
    });
  });

  test("the face is refused when missing, over-precise, zero or not a plain decimal", async () => {
    const s = await setupApprovedDealWithCheque();
    // Retire the first cheque so a second registration reaches the face check.
    await s.asUser.mutation(api.applications.correctExpectedPayment, {
      orgId: s.orgId,
      applicationId: s.applicationId,
      reason: "wrong instrument",
    });
    for (const bad of [undefined, "", "0", "-5", "1e3", "20000.0001", "abc"]) {
      await expect(s.registerCheque(bad, "CHQ-BAD")).rejects.toThrow(/face amount/i);
    }
    expect(await s.rows()).toHaveLength(1);
  });

  test("replace keeps lineage on the old row and copies drawer, lineage and face to the successor", async () => {
    const { orgId, asUser, rows, applicationId, companyId } = await setupApprovedDealWithCheque();
    const [original] = await rows();
    const newId = await asUser.mutation(api.collections.replaceCheque, {
      orgId,
      chequeId: original._id,
      bank: "Cairo Amman Bank",
      chequeNumber: "CHQ-447-2",
      chequeDate: Date.now(),
      faceAmount: "20000",
    });
    const [oldRow, newRow] = await rows();
    expect(oldRow).toMatchObject({ status: "REPLACED", applicationId, originApplicationId: applicationId });
    expect(oldRow.replacementChequeId).toBe(newId);
    expect(newRow).toMatchObject({
      _id: newId,
      status: "HELD",
      applicationId,
      originApplicationId: applicationId,
      drawerType: "FINANCE_COMPANY",
      financeCompanyId: companyId,
      amountMinor: 20_000_000,
    });
  });

  test("REPLACED is terminal for replacement (D9a) and a replacement needs its own face", async () => {
    const { orgId, asUser, rows } = await setupApprovedDealWithCheque();
    const [original] = await rows();
    await expect(
      asUser.mutation(api.collections.replaceCheque, {
        orgId,
        chequeId: original._id,
        bank: "B",
        chequeNumber: "X-1",
        chequeDate: Date.now(),
      })
    ).rejects.toThrow(/face amount/i);
    await asUser.mutation(api.collections.replaceCheque, {
      orgId,
      chequeId: original._id,
      bank: "B",
      chequeNumber: "X-2",
      chequeDate: Date.now(),
      faceAmount: "20000",
    });
    await expect(
      asUser.mutation(api.collections.replaceCheque, {
        orgId,
        chequeId: original._id,
        bank: "B",
        chequeNumber: "X-3",
        chequeDate: Date.now(),
        faceAmount: "20000",
      })
    ).rejects.toThrow(/already replaced/i);
    expect(await rows()).toHaveLength(2);
  });

  test("clear, returnCleared and replace refuse finance-company lineage, including a detached pre-v4 successor", async () => {
    const { t, orgId, userId, asUser, applicationId, customerId } = await setupApprovedDealWithCheque();
    const now = Date.now();
    const shape = { orgId, customerId, bank: "Old", chequeDate: now, amount: 100, createdBy: userId, createdAt: now, updatedAt: now };
    // A successor written by the pre-v4 replaceCheque: applicationId cleared, only the
    // lineage anchor (or only the drawer) survives.
    const detachedOrigin = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", { ...shape, chequeNumber: "D-1", status: "HELD", originApplicationId: applicationId })
    );
    const detachedDrawer = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", { ...shape, chequeNumber: "D-2", status: "HELD", drawerType: "FINANCE_COMPANY" })
    );
    const clearedFc = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", { ...shape, chequeNumber: "D-3", status: "CLEARED", clearedAt: now, drawerType: "FINANCE_COMPANY" })
    );
    for (const chequeId of [detachedOrigin, detachedDrawer]) {
      await expect(
        asUser.mutation(api.collections.clearCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId })
      ).rejects.toThrow(/disbursement|deal/i);
      await expect(
        asUser.mutation(api.collections.replaceCheque, {
          orgId,
          chequeId,
          bank: "B",
          chequeNumber: "Z",
          chequeDate: now,
          amount: 100,
        })
      ).rejects.toThrow();
    }
    await expect(
      asUser.mutation(api.collections.returnClearedCheque, { idempotencyKey: crypto.randomUUID(), orgId, chequeId: clearedFc })
    ).rejects.toThrow(/deal|finance/i);
    // Nothing moved.
    const after = await t.run(async (ctx) => [await ctx.db.get(detachedOrigin), await ctx.db.get(detachedDrawer), await ctx.db.get(clearedFc)]);
    expect(after.map((r) => r?.status)).toEqual(["HELD", "HELD", "CLEARED"]);
  });

  test("a cheque for a cancelled deal cannot be deposited", async () => {
    const { t, orgId, asUser, rows, applicationId } = await setupApprovedDealWithCheque();
    const [cheque] = await rows();
    await t.run((ctx) => ctx.db.patch(applicationId, { status: "CANCELLED" }));
    await expect(
      asUser.mutation(api.collections.depositCheque, { orgId, chequeId: cheque._id })
    ).rejects.toThrow(/cancelled finance deal/i);
  });
});

describe("SCRUM-447 D1 confirmDisbursement clears only an exactly-equal, recorded face", () => {
  test("a face that differs from the receipt is refused before any write", async () => {
    const s = await setupApprovedDealWithCheque({ face: "19999.500" });
    await s.finalize();
    await expect(s.confirm()).rejects.toThrow(/does not equal/i);
    const [cheque] = await s.rows();
    const app = await s.t.run((ctx) => ctx.db.get(s.applicationId));
    expect(cheque.status).toBe("HELD");
    expect(app?.disbursedAt).toBeUndefined();
  });

  test("a wrong currency on the recorded face is refused", async () => {
    const s = await setupApprovedDealWithCheque();
    await s.finalize();
    const [cheque] = await s.rows();
    await s.t.run((ctx) => ctx.db.patch(cheque._id, { currency: "USD" }));
    await expect(s.confirm()).rejects.toThrow(/does not equal/i);
  });

  test("a legacy row with no recorded face is refused, then accepted once attested", async () => {
    const s = await setupApprovedDealWithCheque();
    await s.finalize();
    const [cheque] = await s.rows();
    // The pre-447 shape: only the display `amount`, no minor face.
    await s.t.run((ctx) =>
      ctx.db.patch(cheque._id, { amountMinor: undefined, currency: undefined, amount: 17000 })
    );
    await expect(s.confirm()).rejects.toThrow(/attest/i);

    // B4: the operator must say why the face is right; a missing, blank or
    // over-long note is refused and nothing is written.
    for (const bad of ["", "   \n ", "x".repeat(501)]) {
      await expect(
        s.asUser.mutation(api.applications.attestChequeFace, {
          orgId: s.orgId,
          chequeId: cheque._id,
          faceAmount: "20000",
          note: bad,
        })
      ).rejects.toThrow(/note/i);
    }
    expect((await s.rows())[0].amountMinor).toBeUndefined();

    await s.asUser.mutation(api.applications.attestChequeFace, {
      orgId: s.orgId,
      chequeId: cheque._id,
      faceAmount: "20000",
      note: "  Read off the printed instrument, matches the finance company's letter.  ",
    });
    const attested = (await s.rows())[0];
    expect(attested).toMatchObject({
      amountMinor: 20_000_000,
      currency: "JOD",
      faceAttestedBy: s.userId,
      faceAttestationNote: "Read off the printed instrument, matches the finance company's letter.",
    });
    expect(attested.faceAttestedAt).toBeGreaterThan(0);
    // The legacy display figure is never rewritten.
    expect(attested.amount).toBe(17000);

    // An attested face is never edited.
    await expect(
      s.asUser.mutation(api.applications.attestChequeFace, {
        orgId: s.orgId,
        chequeId: cheque._id,
        faceAmount: "1",
        note: "again",
      })
    ).rejects.toThrow(/already recorded/i);

    await s.confirm();
    expect((await s.rows())[0].status).toBe("CLEARED");

    const audit = await s.t.run((ctx) => ctx.db.query("financialAuditLog").collect());
    const event = audit.find((row) => row.actionType === "ATTEST_CHEQUE_FACE");
    expect(event?.before).toMatchObject({ amount: 17000 });
    expect(event?.description).toContain("Read off the printed instrument");
  });

  test("exactly one live row: a second live cheque for the deal is refused", async () => {
    const s = await setupApprovedDealWithCheque();
    await s.finalize();
    const [first] = await s.rows();
    const now = Date.now();
    await s.t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId: s.orgId,
        customerId: s.customerId,
        applicationId: s.applicationId,
        bank: "Dup",
        chequeNumber: "DUP-1",
        chequeDate: now,
        amount: 20000,
        amountMinor: 20_000_000,
        currency: "JOD",
        status: "HELD",
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      })
    );
    await expect(s.confirm()).rejects.toThrow(/more than one live/i);
    expect((await s.rows()).find((r) => r._id === first._id)?.status).toBe("HELD");
  });

  test("attest is refused for a cheque that is not linked to a finance deal", async () => {
    const s = await setupApprovedDealWithCheque();
    const now = Date.now();
    const unlinked = await s.t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId: s.orgId,
        customerId: s.customerId,
        bank: "U",
        chequeNumber: "U-1",
        chequeDate: now,
        amount: 5,
        status: "HELD",
        createdBy: s.userId,
        createdAt: now,
        updatedAt: now,
      })
    );
    await expect(
      s.asUser.mutation(api.applications.attestChequeFace, { orgId: s.orgId, chequeId: unlinked, faceAmount: "5", note: "n" })
    ).rejects.toThrow(/finance-deal cheque/i);
  });
});

describe("SCRUM-447 D3 correcting the expected payment", () => {
  test("HELD: the cheque is cancelled, keeps its lineage, the payment is cleared and audited, and a repeat is refused", async () => {
    const s = await setupApprovedDealWithCheque();
    const [cheque] = await s.rows();
    await s.asUser.mutation(api.applications.correctExpectedPayment, {
      orgId: s.orgId,
      applicationId: s.applicationId,
      reason: "wrong bank",
    });
    const [after] = await s.rows();
    expect(after).toMatchObject({ _id: cheque._id, status: "CANCELLED", applicationId: s.applicationId });
    expect(after.cancelledAt).toBeGreaterThan(0);
    const app = await s.t.run((ctx) => ctx.db.get(s.applicationId));
    expect(app?.expectedPaymentMethod).toBeUndefined();
    expect(app?.expectedPaymentDate).toBeUndefined();
    expect(app?.expectedPaymentRegisteredAt).toBeUndefined();
    const audit = await s.t.run((ctx) => ctx.db.query("financialAuditLog").collect());
    const event = audit.find((row) => row.actionType === "CORRECT_EXPECTED_PAYMENT");
    expect(event?.before).toMatchObject({ expectedPaymentMethod: "CHEQUE" });
    await expect(
      s.asUser.mutation(api.applications.correctExpectedPayment, {
        orgId: s.orgId,
        applicationId: s.applicationId,
        reason: "again",
      })
    ).rejects.toThrow(/nothing registered/i);
    // And the deal can register again.
    await s.registerCheque("20000", "CHQ-447-NEW");
    const live = (await s.rows()).filter((r) => r.status === "HELD");
    expect(live).toHaveLength(1);
    expect(live[0].chequeNumber).toBe("CHQ-447-NEW");
  });

  test("RETURNED is allowed as it is; DEPOSITED and CLEARED are refused", async () => {
    const returned = await setupApprovedDealWithCheque();
    const [r] = await returned.rows();
    await returned.asUser.mutation(api.collections.returnCheque, { orgId: returned.orgId, chequeId: r._id, returnReason: "NSF" });
    await returned.asUser.mutation(api.applications.correctExpectedPayment, {
      orgId: returned.orgId,
      applicationId: returned.applicationId,
      reason: "returned",
    });
    expect((await returned.rows())[0].status).toBe("RETURNED");

    const deposited = await setupApprovedDealWithCheque();
    const [d] = await deposited.rows();
    await deposited.asUser.mutation(api.collections.depositCheque, { orgId: deposited.orgId, chequeId: d._id });
    await expect(
      deposited.asUser.mutation(api.applications.correctExpectedPayment, {
        orgId: deposited.orgId,
        applicationId: deposited.applicationId,
        reason: "x",
      })
    ).rejects.toThrow(/record its return first|deposited/i);
    expect((await deposited.rows())[0].status).toBe("DEPOSITED");

    const cleared = await setupApprovedDealWithCheque();
    const [c] = await cleared.rows();
    await cleared.t.run((ctx) => ctx.db.patch(c._id, { status: "CLEARED", clearedAt: Date.now() }));
    await expect(
      cleared.asUser.mutation(api.applications.correctExpectedPayment, {
        orgId: cleared.orgId,
        applicationId: cleared.applicationId,
        reason: "x",
      })
    ).rejects.toThrow(/cleared/i);
  });

  test("a CLOSED, not-disbursed deal can correct and re-register, then disburse against the new cheque", async () => {
    const s = await setupApprovedDealWithCheque({ face: "15000" });
    await s.finalize();
    const closed = await s.t.run((ctx) => ctx.db.get(s.applicationId));
    expect(closed?.status).toBe("CLOSED");
    await expect(s.confirm()).rejects.toThrow(/does not equal/i);

    await s.asUser.mutation(api.applications.correctExpectedPayment, {
      orgId: s.orgId,
      applicationId: s.applicationId,
      reason: "face typed wrong",
    });
    await s.registerCheque("20000", "CHQ-447-FIXED");
    await s.confirm();
    const rows = await s.rows();
    expect(rows.map((r) => r.status)).toEqual(["CANCELLED", "CLEARED"]);
    const app = await s.t.run((ctx) => ctx.db.get(s.applicationId));
    expect(app?.disbursedAt).toBeGreaterThan(0);
  });

  test("B1: after correcting a CLOSED deal, confirmDisbursement refuses with zero writes until a payment is re-registered", async () => {
    const s = await setupApprovedDealWithCheque({ face: "20000" });
    await s.finalize();
    await s.asUser.mutation(api.applications.correctExpectedPayment, {
      orgId: s.orgId,
      applicationId: s.applicationId,
      reason: "wrong instrument",
    });
    const snapshot = () =>
      s.t.run(async (ctx) => ({
        cheques: await ctx.db.query("postDatedCheques").collect(),
        payments: await ctx.db.query("canonicalPayments").collect(),
        allocations: await ctx.db.query("paymentAllocations").collect(),
        events: await ctx.db.query("accountingEvents").collect(),
        journals: await ctx.db.query("journalEntries").collect(),
        app: await ctx.db.get(s.applicationId),
      }));
    const before = await snapshot();
    await expect(s.confirm()).rejects.toThrow(/Register the expected payment \(method and date\)/);
    expect(await snapshot()).toEqual(before);
    expect(before.app?.disbursedAt).toBeUndefined();
  });

  test("B1: correct then re-register CHEQUE (new face) confirms; correct then BANK_TRANSFER confirms; a live cheque refuses a non-cheque method", async () => {
    const cheque = await setupApprovedDealWithCheque({ face: "15000" });
    await cheque.finalize();
    await cheque.asUser.mutation(api.applications.correctExpectedPayment, {
      orgId: cheque.orgId,
      applicationId: cheque.applicationId,
      reason: "face",
    });
    await cheque.registerCheque("20000", "CHQ-B1-NEW");
    await cheque.confirm();
    expect((await cheque.rows()).map((r) => r.status)).toEqual(["CANCELLED", "CLEARED"]);

    const bank = await setupApprovedDealWithCheque({ face: "20000" });
    await bank.finalize();
    await bank.asUser.mutation(api.applications.correctExpectedPayment, {
      orgId: bank.orgId,
      applicationId: bank.applicationId,
      reason: "switch to transfer",
    });
    await bank.asUser.mutation(api.applications.registerExpectedPayment, {
      orgId: bank.orgId,
      applicationId: bank.applicationId,
      method: "BANK_TRANSFER",
      expectedDate: Date.now(),
    });
    await bank.confirm();
    const bankApp = await bank.t.run((ctx) => ctx.db.get(bank.applicationId));
    expect(bankApp?.disbursedAt).toBeGreaterThan(0);

    // A stored non-cheque method beside a still-live FC cheque is refused.
    const mixed = await setupApprovedDealWithCheque({ face: "20000" });
    await mixed.finalize();
    await mixed.t.run((ctx) => ctx.db.patch(mixed.applicationId, { expectedPaymentMethod: "BANK_TRANSFER" }));
    await expect(mixed.confirm()).rejects.toThrow(/still has a live finance-company cheque/i);
    expect((await mixed.rows())[0].status).toBe("HELD");
  });

  describe("B2 closed-deal re-registration is completable by the role that corrects", () => {
    const memberWith = async (
      s: Awaited<ReturnType<typeof setupApprovedDealWithCheque>>,
      roleName: string,
      orgId = s.orgId
    ) => {
      const template = DEFAULT_ROLE_TEMPLATES.find((r) => r.name === roleName);
      if (!template) throw new Error(`no template ${roleName}`);
      const clerkId = `user_b2_${roleName}_${orgId}`;
      const userId = await s.t.run((ctx) =>
        ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: roleName })
      );
      const roleId = await s.t.run((ctx) =>
        ctx.db.insert("roles", { orgId, name: roleName, permissions: template.permissions })
      );
      await s.t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
      return s.t.withIdentity({ subject: clerkId, clerkId });
    };
    const registerBank = (as: Awaited<ReturnType<typeof memberWith>>, s: { orgId: Id<"organizations">; applicationId: Id<"financeApplications"> }) =>
      (as.mutation as unknown as (fn: unknown, args: unknown) => Promise<unknown>)(api.applications.registerExpectedPayment, {
        orgId: s.orgId,
        applicationId: s.applicationId,
        method: "BANK_TRANSFER",
        expectedDate: Date.now(),
      });

    test("ACCOUNTANT: correct, register (CLOSED), confirm all succeed", async () => {
      const s = await setupApprovedDealWithCheque({ face: "20000" });
      await s.finalize();
      const asAccountant = await memberWith(s, "ACCOUNTANT");
      await asAccountant.mutation(api.applications.correctExpectedPayment, {
        orgId: s.orgId,
        applicationId: s.applicationId,
        reason: "fix",
      });
      await registerBank(asAccountant, s);
      await asAccountant.mutation(api.applications.confirmDisbursement, {
        idempotencyKey: crypto.randomUUID(),
        orgId: s.orgId,
        applicationId: s.applicationId,
        disbursedAmountMinor: 20_000_000,
      });
      const app = await s.t.run((ctx) => ctx.db.get(s.applicationId));
      expect(app?.disbursedAt).toBeGreaterThan(0);
    });

    test("ACCOUNTANT is still refused on the APPROVED flow; MANAGER registers there and on CLOSED", async () => {
      const approved = await setupApprovedDealWithCheque({ face: "20000" });
      await approved.asUser.mutation(api.applications.correctExpectedPayment, {
        orgId: approved.orgId,
        applicationId: approved.applicationId,
        reason: "fix",
      });
      const acct = await memberWith(approved, "ACCOUNTANT");
      await expect(registerBank(acct, approved)).rejects.toThrow(/Missing required permissions/);
      const mgr = await memberWith(approved, "MANAGER");
      await registerBank(mgr, approved);
      expect((await approved.t.run((ctx) => ctx.db.get(approved.applicationId)))?.expectedPaymentMethod).toBe("BANK_TRANSFER");

      const closed = await setupApprovedDealWithCheque({ face: "20000" });
      await closed.finalize();
      await closed.asUser.mutation(api.applications.correctExpectedPayment, {
        orgId: closed.orgId,
        applicationId: closed.applicationId,
        reason: "fix",
      });
      await registerBank(await memberWith(closed, "MANAGER"), closed);
      expect((await closed.t.run((ctx) => ctx.db.get(closed.applicationId)))?.expectedPaymentMethod).toBe("BANK_TRANSFER");
    });

    test("a member of another organization is refused on a CLOSED deal", async () => {
      const s = await setupApprovedDealWithCheque({ face: "20000" });
      await s.finalize();
      await s.asUser.mutation(api.applications.correctExpectedPayment, {
        orgId: s.orgId,
        applicationId: s.applicationId,
        reason: "fix",
      });
      const otherOrg = await s.t.run((ctx) => ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() }));
      const foreign = await memberWith(s, "ACCOUNTANT", otherOrg);
      await expect(
        foreign.mutation(api.applications.registerExpectedPayment, {
          orgId: otherOrg,
          applicationId: s.applicationId,
          method: "BANK_TRANSFER",
          expectedDate: Date.now(),
        })
      ).rejects.toThrow(/Application not found/);
      expect((await s.t.run((ctx) => ctx.db.get(s.applicationId)))?.expectedPaymentMethod).toBeUndefined();
    });
  });

  test("L1: a CLEARED cheque on an undisbursed deal gets the specific accounting-review message", async () => {
    const s = await setupApprovedDealWithCheque({ face: "20000" });
    await s.finalize();
    const [cheque] = await s.rows();
    await s.t.run((ctx) => ctx.db.patch(cheque._id, { status: "CLEARED", clearedAt: Date.now() }));
    await expect(s.confirm()).rejects.toThrow(/already marked cleared but the disbursement was never confirmed/i);
  });

  describe("SCRUM-447 N1-B: any CLEARED linked cheque is refused first, as an accounting review", () => {
    async function withSecondRow(status: "HELD" | "RETURNED") {
      const s = await setupApprovedDealWithCheque({ face: "20000" });
      await s.finalize();
      const [cheque] = await s.rows();
      const { _id, _creationTime, ...rest } = cheque;
      await s.t.run(async (ctx) => {
        await ctx.db.patch(_id, { status: "CLEARED", clearedAt: Date.now() });
        await ctx.db.insert("postDatedCheques", { ...rest, chequeNumber: "CHQ-447-2", status });
      });
      return s;
    }
    const snapshotOf = (s: Awaited<ReturnType<typeof withSecondRow>>) =>
      s.t.run(async (ctx) => ({
        cheques: await ctx.db.query("postDatedCheques").collect(),
        payments: await ctx.db.query("canonicalPayments").collect(),
        allocations: await ctx.db.query("paymentAllocations").collect(),
        events: await ctx.db.query("accountingEvents").collect(),
        app: await ctx.db.get(s.applicationId),
      }));

    test("CLEARED + a live HELD cheque: accounting-review message, zero writes", async () => {
      const s = await withSecondRow("HELD");
      const before = await snapshotOf(s);
      await expect(s.confirm()).rejects.toThrow(/already marked cleared but the disbursement was never confirmed/i);
      expect(await snapshotOf(s)).toEqual(before);
    });

    test("CLEARED + a RETURNED cheque: accounting-review message, not the correct-payment one", async () => {
      const s = await withSecondRow("RETURNED");
      const before = await snapshotOf(s);
      await expect(s.confirm()).rejects.toThrow(/already marked cleared but the disbursement was never confirmed/i);
      expect(await snapshotOf(s)).toEqual(before);
    });

    test("CONTROL: a single live HELD cheque still confirms", async () => {
      const s = await setupApprovedDealWithCheque({ face: "20000" });
      await s.finalize();
      await s.confirm();
      expect((await s.rows()).map((r) => r.status)).toEqual(["CLEARED"]);
    });
  });
  test("L-b: a legacy CLOSED row with a method but no registeredAt cannot be silently re-registered", async () => {
    const s = await setupApprovedDealWithCheque({ face: "20000" });
    await s.finalize();
    await s.asUser.mutation(api.applications.correctExpectedPayment, {
      orgId: s.orgId,
      applicationId: s.applicationId,
      reason: "fix",
    });
    await s.t.run((ctx) =>
      ctx.db.patch(s.applicationId, { expectedPaymentMethod: "BANK_TRANSFER", expectedPaymentDate: Date.now() })
    );
    const before = await s.t.run((ctx) => ctx.db.get(s.applicationId));
    expect(before?.expectedPaymentRegisteredAt).toBeUndefined();
    await expect(
      s.asUser.mutation(api.applications.registerExpectedPayment, {
        orgId: s.orgId,
        applicationId: s.applicationId,
        method: "BANK_TRANSFER",
        expectedDate: Date.now() + 86_400_000,
      })
    ).rejects.toThrow(/already been registered/i);
    const after = await s.t.run((ctx) => ctx.db.get(s.applicationId));
    expect(after?.expectedPaymentDate).toBe(before?.expectedPaymentDate);
    expect(after?.expectedPaymentRegisteredAt).toBeUndefined();
  });

  test("B1: a same-key replay of a successful confirmation returns the original result", async () => {
    const s = await setupApprovedDealWithCheque({ face: "20000" });
    await s.finalize();
    const key = crypto.randomUUID();
    const args = { idempotencyKey: key, orgId: s.orgId, applicationId: s.applicationId, disbursedAmountMinor: 20_000_000 };
    const first = await s.asUser.mutation(api.applications.confirmDisbursement, args);
    const second = await s.asUser.mutation(api.applications.confirmDisbursement, args);
    expect(second).toEqual(first);
  });

  test("a disbursed or cancelled deal cannot be corrected; a missing reason is refused", async () => {
    const s = await setupApprovedDealWithCheque();
    await expect(
      s.asUser.mutation(api.applications.correctExpectedPayment, {
        orgId: s.orgId,
        applicationId: s.applicationId,
        reason: "   ",
      })
    ).rejects.toThrow(/reason/i);
    await s.finalize();
    await s.confirm();
    await expect(
      s.asUser.mutation(api.applications.correctExpectedPayment, {
        orgId: s.orgId,
        applicationId: s.applicationId,
        reason: "too late",
      })
    ).rejects.toThrow(/already been confirmed/i);
  });

  test("finalizeDeal refuses a registered cheque whose live row is gone", async () => {
    const s = await setupApprovedDealWithCheque();
    const [cheque] = await s.rows();
    await s.t.run((ctx) => ctx.db.patch(cheque._id, { status: "RETURNED", returnedAt: Date.now() }));
    await classifyFinancedDeal({ orgId: s.orgId, applicationId: s.applicationId, asUser: s.asUser }, 20000);
    await expect(
      s.asUser.mutation(api.applications.finalizeDeal, {
        idempotencyKey: crypto.randomUUID(),
        orgId: s.orgId,
        applicationId: s.applicationId,
      })
    ).rejects.toThrow(/no longer live/i);
  });

  test("the cockpit's expectedPaymentRegistered follows the LIVE cheque, not the stored method", async () => {
    const s = await setupApprovedDealWithCheque();
    const before = await s.asUser.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId: s.applicationId });
    expect(before?.expectedPaymentRegistered).toBe(true);
    const [cheque] = await s.rows();
    await s.asUser.mutation(api.collections.returnCheque, { orgId: s.orgId, chequeId: cheque._id, returnReason: "NSF" });
    const after = await s.asUser.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId: s.applicationId });
    expect(after?.expectedPaymentRegistered).toBe(false);
  });

  describe("cockpit cheque recovery flags", () => {
    const flags = async (s: Awaited<ReturnType<typeof setupApprovedDealWithCheque>>) => {
      const deal = await s.asUser.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId: s.applicationId });
      return {
        needsCorrection: deal?.chequeNeedsCorrection,
        accountingReview: deal?.chequeNeedsAccountingReview,
      };
    };

    test("T1: a returned cheque needs correction until the payment is corrected; a live HELD cheque does not", async () => {
      const control = await setupApprovedDealWithCheque();
      expect(await flags(control)).toEqual({ needsCorrection: false, accountingReview: false });

      const s = await setupApprovedDealWithCheque();
      const [cheque] = await s.rows();
      await s.asUser.mutation(api.collections.returnCheque, { orgId: s.orgId, chequeId: cheque._id, returnReason: "NSF" });
      expect(await flags(s)).toEqual({ needsCorrection: true, accountingReview: false });
      await s.asUser.mutation(api.applications.correctExpectedPayment, {
        orgId: s.orgId,
        applicationId: s.applicationId,
        reason: "returned",
      });
      expect(await flags(s)).toEqual({ needsCorrection: false, accountingReview: false });
    });

    test("F6: a CLEARED, undisbursed cheque asks for accounting review and is never offered Correct", async () => {
      const s = await setupApprovedDealWithCheque();
      const [cheque] = await s.rows();
      await s.t.run((ctx) => ctx.db.patch(cheque._id, { status: "CLEARED", clearedAt: Date.now() }));
      expect(await flags(s)).toEqual({ needsCorrection: false, accountingReview: true });
    });

    test("F6: CLEARED beside a RETURNED row takes precedence over correction", async () => {
      const s = await setupApprovedDealWithCheque();
      const [cheque] = await s.rows();
      const now = Date.now();
      await s.t.run((ctx) => ctx.db.patch(cheque._id, { status: "CLEARED", clearedAt: now }));
      await s.t.run((ctx) =>
        ctx.db.insert("postDatedCheques", {
          orgId: s.orgId,
          customerId: s.customerId,
          applicationId: s.applicationId,
          bank: "B",
          chequeNumber: "RET-1",
          chequeDate: now,
          amount: 5,
          status: "RETURNED",
          createdBy: s.userId,
          createdAt: now,
          updatedAt: now,
        })
      );
      expect(await flags(s)).toEqual({ needsCorrection: false, accountingReview: true });
    });

    test("F6: a DEPOSITED cheque is live, so neither flag is raised", async () => {
      const s = await setupApprovedDealWithCheque();
      const [cheque] = await s.rows();
      await s.asUser.mutation(api.collections.depositCheque, { orgId: s.orgId, chequeId: cheque._id });
      expect(await flags(s)).toEqual({ needsCorrection: false, accountingReview: false });
    });
  });
});

describe("SCRUM-447 D4 a cheque never outlives its deal", () => {
  test("cancelApplication cancels a HELD cheque", async () => {
    const s = await setupApprovedDealWithCheque();
    await s.asUser.mutation(api.applications.cancelApplication, {
      idempotencyKey: crypto.randomUUID(),
      orgId: s.orgId,
      applicationId: s.applicationId,
      reason: "customer walked",
    });
    const [cheque] = await s.rows();
    expect(cheque.status).toBe("CANCELLED");
    expect(cheque.cancellationReason).toBe("customer walked");
    expect(cheque.applicationId).toBe(s.applicationId);
  });

  test("cancelApplication refuses a DEPOSITED cheque and changes nothing", async () => {
    const s = await setupApprovedDealWithCheque();
    const [cheque] = await s.rows();
    await s.asUser.mutation(api.collections.depositCheque, { orgId: s.orgId, chequeId: cheque._id });
    await expect(
      s.asUser.mutation(api.applications.cancelApplication, {
        idempotencyKey: crypto.randomUUID(),
        orgId: s.orgId,
        applicationId: s.applicationId,
        reason: "x",
      })
    ).rejects.toThrow(/deposited/i);
    expect((await s.rows())[0].status).toBe("DEPOSITED");
    const app = await s.t.run((ctx) => ctx.db.get(s.applicationId));
    expect(app?.status).toBe("APPROVED");
  });
});

describe("SCRUM-447 D7'' read-only lineage audit", () => {
  test("names each class, states its denominator, and never turns UNKNOWN into a pass", async () => {
    const s = await setupApprovedDealWithCheque();
    const { t, orgId, userId, customerId, applicationId } = s;
    const auditRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "Auditor", permissions: ["view:finance"] })
    );
    const auditorId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "user_auditor", email: "aud@test.com", name: "Auditor" })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: auditorId, roleId: auditRoleId }));
    const asAuditor = t.withIdentity({ subject: "user_auditor", clerkId: "user_auditor" });

    const now = Date.now();
    const shape = { orgId, customerId, bank: "A", chequeDate: now, amount: 1, createdBy: userId, createdAt: now, updatedAt: now };
    const drawerless = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", { ...shape, chequeNumber: "A-1", status: "HELD", applicationId })
    );
    const legacyCleared = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        ...shape,
        chequeNumber: "A-2",
        status: "CLEARED",
        clearedAt: now,
        drawerType: "FINANCE_COMPANY",
        originApplicationId: applicationId,
      })
    );
    // DEFENSIVE class: no known writer produces a marked predecessor pointing at
    // an unmarked successor (the pre-v4 writer did the opposite, see B3 below).
    const successorOnly = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", { ...shape, chequeNumber: "A-3", status: "HELD" })
    );
    await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        ...shape,
        chequeNumber: "A-4",
        status: "REPLACED",
        replacementChequeId: successorOnly,
        drawerType: "FINANCE_COMPANY",
        originApplicationId: applicationId,
      })
    );
    await t.run((ctx) => ctx.db.patch(applicationId, { status: "CANCELLED" }));

    const result = await asAuditor.query(api.chequeLineageAudit.auditFinanceCompanyCheques, {
      orgId,
      paginationOpts: { numItems: 50, cursor: null },
    });
    const classesOf = (id: string) => result.findings.filter((f) => f.chequeId === id).map((f) => f.class);
    expect(result.isDone).toBe(true);
    // 1 registered by the writer + 4 seeded above.
    expect(result.denominator.examined).toBe(5);
    expect(classesOf(drawerless)).toEqual(expect.arrayContaining(["DRAWER_UNVERIFIED", "LIVE_ON_CANCELLED_DEAL", "SEVERAL_LIVE_ROWS_FOR_APPLICATION"]));
    expect(classesOf(legacyCleared)).toEqual(
      expect.arrayContaining(["CLEARED_OUTSIDE_CONFIRM_DISBURSEMENT", "CLEARED_LEGACY_FACE_UNAVAILABLE"])
    );
    expect(classesOf(successorOnly)).toEqual(["LINEAGE_UNKNOWN_REACHABLE_ONLY_VIA_REPLACEMENT"]);
    expect(result.unknownCount).toBeGreaterThanOrEqual(2);
    // UNKNOWN is reported, never folded into a clean verdict.
    expect(result.findings.filter((f) => f.verdict === "UNKNOWN").length).toBe(result.unknownCount);
    expect(result.note).toMatch(/UNKNOWN is not PASS/);
  });

  describe("B3 detached historical lineage (pre-v4 replaceCheque residue)", () => {
    const seed = async () => {
      const s = await setupApprovedDealWithCheque();
      const { t, orgId, userId, customerId, applicationId } = s;
      const auditRoleId = await t.run((ctx) =>
        ctx.db.insert("roles", { orgId, name: "Auditor", permissions: ["view:finance"] })
      );
      const auditorId = await t.run((ctx) =>
        ctx.db.insert("users", { clerkId: "user_auditor_b3", email: "aud3@test.com", name: "Auditor" })
      );
      await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: auditorId, roleId: auditRoleId }));
      const asAuditor = t.withIdentity({ subject: "user_auditor_b3", clerkId: "user_auditor_b3" });
      const now = Date.now();
      const shape = { orgId, customerId, bank: "B", chequeDate: now, amount: 1, createdBy: userId, createdAt: now, updatedAt: now };
      const insert = (over: Record<string, unknown>) =>
        t.run((ctx) => ctx.db.insert("postDatedCheques", { ...shape, ...over } as never));
      const audit = (numItems = 50) =>
        asAuditor.query(api.chequeLineageAudit.auditFinanceCompanyCheques, {
          orgId,
          paginationOpts: { numItems, cursor: null },
        });
      const classesOf = (result: Awaited<ReturnType<typeof audit>>, id: string) =>
        result.findings.filter((f) => f.chequeId === id).map((f) => f.class);
      return { ...s, shape, insert, audit, classesOf, applicationId };
    };

    test("the BASE writer's shape: an unmarked REPLACED row whose successor carries the lineage is reported UNKNOWN", async () => {
      const x = await seed();
      // origin/main replaceCheque copied applicationId to the successor and
      // cleared it from the old row, which became REPLACED -> successor.
      const successor = await x.insert({ chequeNumber: "S-1", status: "HELD", applicationId: x.applicationId, drawerType: "FINANCE_COMPANY", originApplicationId: x.applicationId });
      const old = await x.insert({ chequeNumber: "O-1", status: "REPLACED", replacementChequeId: successor });
      const result = await x.audit();
      expect(x.classesOf(result, old)).toEqual(["LINEAGE_DETACHED_BY_LEGACY_REPLACEMENT"]);
      expect(result.findings.find((f) => f.chequeId === old)?.verdict).toBe("UNKNOWN");
    });

    test("L-f: a NaN page size falls back to the default page size instead of surviving", async () => {
      const x = await seed();
      for (let i = 0; i < 55; i += 1) await x.insert({ chequeNumber: `N-${i}`, status: "HELD" });
      const result = await x.audit(Number.NaN);
      expect(result.denominator.pageSize).toBe(50);
    });

    test("a three-row chain reaching an FC row flags every unmarked link; a customer-only chain flags nothing", async () => {
      const x = await seed();
      const tail = await x.insert({ chequeNumber: "T-3", status: "HELD", applicationId: x.applicationId, drawerType: "FINANCE_COMPANY", originApplicationId: x.applicationId });
      const mid = await x.insert({ chequeNumber: "T-2", status: "REPLACED", replacementChequeId: tail });
      const head = await x.insert({ chequeNumber: "T-1", status: "REPLACED", replacementChequeId: mid });
      const custTail = await x.insert({ chequeNumber: "C-2", status: "HELD" });
      const custHead = await x.insert({ chequeNumber: "C-1", status: "REPLACED", replacementChequeId: custTail });
      const result = await x.audit();
      expect(x.classesOf(result, head)).toEqual(["LINEAGE_DETACHED_BY_LEGACY_REPLACEMENT"]);
      expect(x.classesOf(result, mid)).toEqual(["LINEAGE_DETACHED_BY_LEGACY_REPLACEMENT"]);
      expect(x.classesOf(result, custHead)).toEqual([]);
      expect(x.classesOf(result, custTail)).toEqual([]);
    });

    test("a cycle, a missing successor, a foreign-org successor and an over-deep chain are UNRESOLVED, never a pass", async () => {
      const x = await seed();
      const p = await x.insert({ chequeNumber: "P", status: "REPLACED" });
      const q = await x.insert({ chequeNumber: "Q", status: "REPLACED", replacementChequeId: p });
      await x.t.run((ctx) => ctx.db.patch(p, { replacementChequeId: q }));

      const gone = await x.insert({ chequeNumber: "G-2", status: "HELD" });
      const missing = await x.insert({ chequeNumber: "G-1", status: "REPLACED", replacementChequeId: gone });
      await x.t.run((ctx) => ctx.db.delete(gone));

      const otherOrg = await x.t.run((ctx) => ctx.db.insert("organizations", { name: "Other", createdAt: Date.now() }));
      const foreignCustomer = await x.t.run((ctx) => ctx.db.insert("customers", { orgId: otherOrg, firstName: "F", lastName: "O" }));
      const foreignSucc = await x.t.run((ctx) =>
        ctx.db.insert("postDatedCheques", { ...x.shape, orgId: otherOrg, customerId: foreignCustomer, chequeNumber: "F-2", status: "HELD", drawerType: "FINANCE_COMPANY" })
      );
      const foreign = await x.insert({ chequeNumber: "F-1", status: "REPLACED", replacementChequeId: foreignSucc });

      let prev = await x.insert({ chequeNumber: "D-end", status: "HELD" });
      let deepHead = prev;
      for (let i = 0; i < 10; i += 1) {
        deepHead = await x.insert({ chequeNumber: `D-${i}`, status: "REPLACED", replacementChequeId: prev });
        prev = deepHead;
      }

      const result = await x.audit(100);
      for (const id of [p, q, missing, foreign, deepHead]) {
        expect(x.classesOf(result, id)).toEqual(["LINEAGE_CHAIN_UNRESOLVED"]);
        expect(result.findings.find((f) => f.chequeId === id)?.verdict).toBe("UNKNOWN");
      }
    });

    test("a caller-supplied page size is capped", async () => {
      const x = await seed();
      for (let i = 0; i < 210; i += 1) {
        await x.insert({ chequeNumber: `N-${i}`, status: "HELD" });
      }
      const result = await x.audit(100_000);
      expect(result.denominator.pageSize).toBeLessThanOrEqual(200);
      expect(result.isDone).toBe(false);
    });
  });

  test("a caller without finance visibility is refused", async () => {
    const s = await setupApprovedDealWithCheque();
    const roleId = await s.t.run((ctx) => ctx.db.insert("roles", { orgId: s.orgId, name: "Nobody", permissions: [] }));
    const nobody = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "user_nobody", email: "n@test.com", name: "N" }));
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.orgId, userId: nobody, roleId }));
    const asNobody = s.t.withIdentity({ subject: "user_nobody", clerkId: "user_nobody" });
    await expect(
      asNobody.query(api.chequeLineageAudit.auditFinanceCompanyCheques, {
        orgId: s.orgId,
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).rejects.toThrow();
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
      manualAdminFees: 0,
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
      manualAdminFees: 0,
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
      manualAdminFees: 0,
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
