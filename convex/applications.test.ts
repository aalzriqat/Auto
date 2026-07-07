import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

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
