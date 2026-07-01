/**
 * Phase 8 tests: sale cancellation reversals, finance disbursement lifecycle,
 * and payment intent/webhook settlement.
 */
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedDealer(tag = "p8") {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Phase8 Dealer ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      clerkId: `${tag}_user`, email: `${tag}@example.com`, name: `${tag} User`,
    })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner",
      permissions: [
        "view:sales", "create:sales", "edit:sales", "delete:sales",
        "view:expenses", "create:expenses", "edit:expenses", "delete:expenses",
        "manage:finance", "view:finance",
        "view:customers", "create:customers",
        "view:vehicles", "create:vehicles", "edit:vehicles",
        "manage:collection", "view:collection",
        "approve:requests",
        "view:finance_applications", "create:finance_application",
        "review:finance_application", "approve:finance_application",
        "finalize:financed_deal", "confirm:finance_disbursement",
        "verify:finance_documents",
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });

  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Customer" })
  );

  return { t, orgId, userId, period, asUser, customerId };
}

// ─── Sale cancellation reversal ───────────────────────────────────────────────

describe("Phase 8 — sale cancellation reversal", () => {
  test("cancelling a sale reverses the SALE_COMPLETED journal entry", async () => {
    const { t, orgId, asUser, userId, customerId } = await seedDealer("cancel");

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "VIN_CANCEL_001", make: "Toyota", model: "Camry", year: 2020,
        mileage: 0, color: "Black", fuelType: "Petrol", transmission: "Automatic",
        purchasePrice: 10000, sellingPrice: 15000, status: "AVAILABLE",
      })
    );

    const saleId = await asUser.mutation(api.sales.create, {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, saleDate: Date.now(),
      status: "COMPLETED", financingType: "CASH",
      idempotencyKey: "cancel_sale_001",
    });

    const beforeEvents = await t.run((ctx) =>
      ctx.db.query("accountingEvents")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("eventType"), "SALE_COMPLETED"))
        .collect()
    );
    expect(beforeEvents).toHaveLength(1);
    expect(beforeEvents[0].status).toBe("POSTED");

    // Approver must be a different user
    const approverId = await t.run((ctx) =>
      ctx.db.insert("users", {
        clerkId: "cancel_approver", email: "approver@cancel.com", name: "Approver",
      })
    );
    const approverRoleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId, name: "Manager",
        permissions: ["view:sales", "edit:sales", "approve:requests"],
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("memberships", { orgId, userId: approverId, roleId: approverRoleId })
    );
    const asApprover = t.withIdentity({ subject: "cancel_approver", clerkId: "cancel_approver" });

    await asApprover.mutation(api.sales.update, { orgId, saleId, status: "CANCELLED" });

    const reversalEvents = await t.run((ctx) =>
      ctx.db.query("accountingEvents")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("eventType"), "JOURNAL_REVERSAL"))
        .collect()
    );
    expect(reversalEvents).toHaveLength(1);

    const originalEvent = await t.run((ctx) => ctx.db.get(beforeEvents[0]._id));
    expect(originalEvent?.status).toBe("REVERSED");
  });
});

// ─── Payment intent settlement ────────────────────────────────────────────────

describe("Phase 8 — payment intent settlement", () => {
  test("creates a payment intent and settles it posting GL entry", async () => {
    const { t, orgId, asUser, customerId } = await seedDealer("pi1");

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId,
      amountMinor: 5000_000, currency: "JOD", provider: "tap",
      idempotencyKey: "pi_tap_001",
    });
    expect(intentId).toBeTruthy();

    const pending = await t.run((ctx) => ctx.db.get(intentId));
    expect(pending?.status).toBe("PENDING");

    await asUser.mutation(api.paymentIntents.markSettled, {
      orgId, intentId, externalId: "tap_charge_abc123",
      idempotencyKey: "settle_tap_001",
    });

    const settled = await t.run((ctx) => ctx.db.get(intentId));
    expect(settled?.status).toBe("SETTLED");
    expect(settled?.externalId).toBe("tap_charge_abc123");
    expect(settled?.canonicalPaymentId).toBeTruthy();
    const canonicalPayment = await t.run(async (ctx) => {
      if (!settled?.canonicalPaymentId) return null;
      return await ctx.db.get(settled.canonicalPaymentId);
    });
    expect(canonicalPayment?.method).toBe("PAYMENT_LINK");
    expect(canonicalPayment?.provider).toBe("tap");
    expect(canonicalPayment?.providerTransactionId).toBe("tap_charge_abc123");

    const glEvents = await t.run((ctx) =>
      ctx.db.query("accountingEvents")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("eventType"), "PAYMENT_LINK_RECEIVED"))
        .collect()
    );
    expect(glEvents).toHaveLength(1);
    expect(glEvents[0].status).toBe("POSTED");
  });

  test("internal settleByExternalId idempotent on duplicate webhook", async () => {
    const { t, orgId, asUser, customerId } = await seedDealer("pi2");

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, amountMinor: 1000_000, currency: "JOD", provider: "stripe",
      externalId: "stripe_pi_abc",
      checkoutUrl: "https://checkout.stripe.com/c/pay/stripe_pi_abc",
      providerAccountId: "acct_phase8",
      idempotencyKey: "pi_stripe_001",
    });

    await t.mutation(internal.paymentIntents.settleByExternalId, {
      provider: "stripe", externalId: "stripe_pi_abc",
      amountMinor: 1000_000,
      currency: "JOD",
      providerSignatureVerifiedAt: Date.now(),
      providerEventId: "evt_phase8_1",
      providerEventType: "payment_intent.succeeded",
      providerAccountId: "acct_phase8",
    });
    await t.mutation(internal.paymentIntents.settleByExternalId, {
      provider: "stripe", externalId: "stripe_pi_abc",
      amountMinor: 1000_000,
      currency: "JOD",
      providerSignatureVerifiedAt: Date.now(),
      providerEventId: "evt_phase8_1",
      providerEventType: "payment_intent.succeeded",
      providerAccountId: "acct_phase8",
    });

    const settled = await t.run((ctx) => ctx.db.get(intentId));
    expect(settled?.status).toBe("SETTLED");
    expect(settled?.providerEventId).toBe("evt_phase8_1");
    expect(settled?.providerAmountMinor).toBe(1000_000);
    expect(settled?.providerCurrency).toBe("JOD");

    const glEvents = await t.run((ctx) =>
      ctx.db.query("accountingEvents")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("eventType"), "PAYMENT_LINK_RECEIVED"))
        .collect()
    );
    expect(glEvents).toHaveLength(1);
  });

  test("internal settleByExternalId rejects signed provider money mismatch before posting", async () => {
    const { t, orgId, asUser, customerId } = await seedDealer("pi_mismatch");

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId,
      customerId,
      amountMinor: 1000_000,
      currency: "JOD",
      provider: "tap",
      externalId: "tap_charge_mismatch",
      checkoutUrl: "https://tap.example/checkout/tap_charge_mismatch",
      providerAccountId: "merchant_123",
      idempotencyKey: "pi_mismatch_001",
    });

    const result = await t.mutation(internal.paymentIntents.settleByExternalId, {
      provider: "tap",
      externalId: "tap_charge_mismatch",
      amountMinor: 999_000,
      currency: "JOD",
      providerSignatureVerifiedAt: Date.now(),
      providerEventId: "tap_charge_mismatch",
      providerEventType: "tap.charge.CAPTURED",
      providerAccountId: "merchant_123",
    });
    expect(result).toBeNull();

    const failed = await t.run((ctx) => ctx.db.get(intentId));
    expect(failed?.status).toBe("FAILED");
    expect(failed?.providerAmountMinor).toBe(999_000);
    expect(failed?.canonicalPaymentId).toBeUndefined();

    const glEvents = await t.run((ctx) =>
      ctx.db.query("accountingEvents")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("eventType"), "PAYMENT_LINK_RECEIVED"))
        .collect()
    );
    expect(glEvents).toHaveLength(0);
  });

  test("settling an intent linked to a receivable allocates the canonical payment", async () => {
    const { t, orgId, asUser, customerId } = await seedDealer("pi_alloc");

    const receivableDocumentId = await asUser.mutation(api.subledger.createReceivable, {
      orgId,
      documentType: "INVOICE",
      payerType: "CUSTOMER",
      customerId,
      sourceType: "test_intent",
      sourceId: "pi_alloc_receivable",
      originalAmountMinor: 1_000_000,
      currency: "JOD",
      issueDate: Date.now(),
      dueDate: Date.now(),
    });

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId,
      customerId,
      receivableDocumentId,
      amountMinor: 400_000,
      currency: "JOD",
      provider: "tap",
      idempotencyKey: "pi_alloc_001",
    });

    await asUser.mutation(api.paymentIntents.markSettled, {
      orgId,
      intentId,
      externalId: "tap_alloc_001",
      idempotencyKey: "settle_tap_alloc_001",
    });

    const settled = await t.run((ctx) => ctx.db.get(intentId));
    expect(settled?.canonicalPaymentId).toBeTruthy();
    expect(settled?.paymentAllocationId).toBeTruthy();

    const allocation = await t.run(async (ctx) => {
      if (!settled?.paymentAllocationId) return null;
      return await ctx.db.get(settled.paymentAllocationId);
    });
    expect(allocation?.amountMinor).toBe(400_000);
    expect(allocation?.receivableDocumentId).toBe(receivableDocumentId);

    const balance = await asUser.query(api.subledger.getReceivableBalance, {
      orgId,
      receivableDocumentId,
    });
    expect(balance?.outstandingMinor).toBe(600_000);
  });

  test("expiring a pending intent marks it EXPIRED without posting GL", async () => {
    const { t, orgId, asUser, customerId } = await seedDealer("pi3");

    const intentId = await asUser.mutation(api.paymentIntents.create, {
      orgId, customerId, amountMinor: 500_000, currency: "JOD", provider: "telr",
    });

    await asUser.mutation(api.paymentIntents.expire, { orgId, intentId });

    const expired = await t.run((ctx) => ctx.db.get(intentId));
    expect(expired?.status).toBe("EXPIRED");

    const glEvents = await t.run((ctx) =>
      ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()
    );
    expect(glEvents).toHaveLength(0);
  });
});

// ─── Finance disbursement lifecycle ──────────────────────────────────────────

describe("Phase 8 — finance disbursement", () => {
  test("confirmDisbursement records disbursement on application", async () => {
    const { t, orgId, asUser, customerId, userId } = await seedDealer("fin1");

    const financeCompanyId = await t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId, name: "Test Bank", isActive: true,
        profitRate: 5.5, maxTermMonths: 72, gracePeriodMonths: 3,
      })
    );
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "VIN_FINANCE_001", make: "Honda", model: "Civic", year: 2021,
        mileage: 0, color: "Blue", fuelType: "Petrol", transmission: "Automatic",
        purchasePrice: 8000, sellingPrice: 12000, status: "AVAILABLE",
      })
    );
    const quoteId = await t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId, vehicleId, customerId, vehiclePrice: 12000, downPayment: 2000,
        totalFinancedAmount: 10000, termMonths: 24, status: "DRAFT",
        companyId: financeCompanyId, createdBy: userId, createdAt: Date.now(),
      })
    );

    const appId = await t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId, customerId, vehicleId, companyId: financeCompanyId,
        quoteId, salespersonId: userId,
        status: "CLOSED",
        createdAt: Date.now(), updatedAt: Date.now(),
      })
    );

    await asUser.mutation(api.applications.confirmDisbursement, {
      orgId, applicationId: appId,
      disbursedAmountMinor: 10_000_000,
      idempotencyKey: "disbursement_001",
    });

    const updated = await t.run((ctx) => ctx.db.get(appId));
    expect(updated?.disbursedAt).toBeTruthy();
    expect(updated?.disbursedAmountMinor).toBe(10_000_000);
  });

  test("confirmDisbursement throws when already confirmed", async () => {
    const { t, orgId, asUser, customerId, userId } = await seedDealer("fin2");

    const financeCompanyId = await t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId, name: "Second Bank", isActive: true,
        profitRate: 4.0, maxTermMonths: 60, gracePeriodMonths: 2,
      })
    );
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "VIN_FINANCE_002", make: "Kia", model: "Optima", year: 2022,
        mileage: 0, color: "Red", fuelType: "Petrol", transmission: "Automatic",
        purchasePrice: 9000, sellingPrice: 13000, status: "AVAILABLE",
      })
    );
    const quoteId = await t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId, vehicleId, customerId, vehiclePrice: 13000, downPayment: 3000,
        totalFinancedAmount: 10000, termMonths: 12, status: "DRAFT",
        companyId: financeCompanyId, createdBy: userId, createdAt: Date.now(),
      })
    );

    const appId = await t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId, customerId, vehicleId, companyId: financeCompanyId,
        quoteId, salespersonId: userId,
        status: "CLOSED",
        disbursedAt: Date.now(), disbursedAmountMinor: 5_000_000,
        createdAt: Date.now(), updatedAt: Date.now(),
      })
    );

    await expect(
      asUser.mutation(api.applications.confirmDisbursement, {
        orgId, applicationId: appId, disbursedAmountMinor: 5_000_000,
      })
    ).rejects.toThrow("Disbursement has already been confirmed");
  });
});

// ─── Schema fields ────────────────────────────────────────────────────────────

describe("Phase 8 — schema fields", () => {
  test("postDatedCheques accepts returnedAfterClearing field", async () => {
    const { t, orgId, customerId, userId } = await seedDealer("schema");

    const chequeId = await t.run((ctx) =>
      ctx.db.insert("postDatedCheques", {
        orgId, customerId,
        bank: "Arab Bank", chequeNumber: "CHQ001",
        chequeDate: Date.now() + 86_400_000,
        amount: 1000, status: "RETURNED",
        returnedAfterClearing: true, bankFeeMinor: 500,
        createdBy: userId, createdAt: Date.now(), updatedAt: Date.now(),
      })
    );

    const cheque = await t.run((ctx) => ctx.db.get(chequeId));
    expect(cheque?.returnedAfterClearing).toBe(true);
    expect(cheque?.bankFeeMinor).toBe(500);
  });

  test("financeApplications accepts disbursement fields", async () => {
    const { t, orgId, customerId, userId } = await seedDealer("schema2");

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: "VIN_SCHEMA_001", make: "Nissan", model: "Altima", year: 2023,
        mileage: 0, color: "White", fuelType: "Petrol", transmission: "Automatic",
        purchasePrice: 11000, sellingPrice: 16000, status: "AVAILABLE",
      })
    );
    const financeCompanyId = await t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId, name: "Schema Bank", isActive: true,
        profitRate: 6.0, maxTermMonths: 48, gracePeriodMonths: 1,
      })
    );
    const quoteId = await t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId, vehicleId, customerId, vehiclePrice: 16000, downPayment: 1000,
        totalFinancedAmount: 15000, termMonths: 36, status: "DRAFT",
        createdBy: userId, createdAt: Date.now(),
      })
    );

    const now = Date.now();
    const appId = await t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId, customerId, vehicleId, companyId: financeCompanyId,
        quoteId, salespersonId: userId, status: "CLOSED",
        disbursedAt: now, disbursedAmountMinor: 15_000_000,
        disbursementIdempotencyKey: "disb_idem_001",
        createdAt: now, updatedAt: now,
      })
    );

    const app = await t.run((ctx) => ctx.db.get(appId));
    expect(app?.disbursedAt).toBe(now);
    expect(app?.disbursedAmountMinor).toBe(15_000_000);
    expect(app?.disbursementIdempotencyKey).toBe("disb_idem_001");
  });
});
