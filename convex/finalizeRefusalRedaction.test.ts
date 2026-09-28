import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_ROLE_TEMPLATES, PERMISSIONS } from "./utils/permissions";
import { WITHHELD_READINESS_REASON_FALLBACK } from "../lib/closingReadinessReasonCodes";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

/**
 * SCRUM-414 R1 / S414-RED-1: `finalizeDeal` authorizes on
 * `confirm:finance_disbursement`, which the default MANAGER template holds
 * WITHOUT `view:finance`. For such a caller `getClosingReadiness` serves only
 * WITHHELD_* codes; a REFUSED finalize must not serve more. Both throw sites
 * are exercised: the input refusal (currency drift) and the evaluator's check
 * refusal. The finance tier keeps the full coded payload.
 */
const MODULES = import.meta.glob("./**/*.ts");
const JOD_SCALE = 1000;
const FEE_LABEL = "Zebra courier";

const OWNER_PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "finalize:financed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:reports", "manage:settings",
];

const MANAGER_TEMPLATE = DEFAULT_ROLE_TEMPLATES.find((template) => template.name === "MANAGER")!;

/** Rows a finalize writes; a refusal must leave every count where it was. */
const WRITTEN_TABLES = [
  "sales",
  "journalEntries",
  "receivables",
  "receivableDocuments",
  "accountingEvents",
  "pendingAccountingEvents",
  "commandIdempotency",
] as const;

type Scenario = "CURRENCY_DRIFT" | "COSTS_AWAITING_RECONCILIATION";

async function seedDeal(scenario: Scenario) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Redaction Co", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );

  const ownerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: OWNER_PERMS, isSystemOwnerRole: true })
  );
  const managerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: MANAGER_TEMPLATE.permissions })
  );
  const confirmOnlyRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "CONFIRM_ONLY", permissions: [PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT] })
  );
  const member = async (clerkId: string, roleId: Id<"roles">) => {
    const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId, email: `${clerkId}@x.com` }));
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    return t.withIdentity({ subject: clerkId, clerkId });
  };
  const asOwner = await member("owner_u", ownerRoleId);
  const asApprover = await member("appr_u", ownerRoleId);
  const asManager = await member("mgr_u", managerRoleId);
  const asConfirmOnly = await member("confirm_u", confirmOnlyRoleId);

  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"] })
  );
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear,
    periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: "Redact" }));
  const customerStatusId = await t.run((ctx) =>
    ctx.db.insert("orgCustomerStatuses", { orgId, label: "Eligible", isActive: true, order: 1 })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: "VINREDACT1", make: "Kia", model: "Sportage", year: 2024, mileage: 10,
      color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: 20000, status: "AVAILABLE", sourceType: "STOCK", purchasePrice: 15000,
    })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId, name: "Redact Finance", profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 0, isActive: true,
      defaultLtvPercent: 100, adminFees: 0,
    })
  );

  const quoteId = await asOwner.mutation(api.quotes.saveQuote, {
    orgId, customerId, vehicleId, vehiclePrice: 20000, downPayment: 0, termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY", companyId,
    customerEligibilityStatusIds: [customerStatusId], totalFinancedAmount: 20000,
  });
  const applicationId = await asOwner.mutation(api.applications.createFromQuote, { orgId, quoteId });
  await asOwner.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
  await asApprover.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
  await asOwner.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId, applicationId, submittedQuotationMinor: 20000 * JOD_SCALE, source: "MANUAL_ENTRY",
  });
  await asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId, applicationId, approvedAmountMinor: 20000 * JOD_SCALE, basis: "MANUAL", notes: "Approved.",
  });
  await registerHandover(asOwner, api, orgId, applicationId);
  await asOwner.mutation(api.applications.registerExpectedPayment, {
    orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  await asOwner.mutation(api.financeDealCosts.recordLegalInvoice, {
    orgId, applicationId, legalInvoiceAmountMinor: 20000 * JOD_SCALE,
    legalInvoiceNumber: "INV-" + applicationId, legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY",
  });
  const feeId = await asOwner.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", orgId, applicationId, feeType: "OTHER_CLOSING_EXPENSE",
    paidBy: "DEALER", paidTo: "OTHER", accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false, actualAmountMinor: 25 * JOD_SCALE, description: FEE_LABEL,
    idempotencyKey: "redact-fee:" + applicationId,
  });

  if (scenario === "CURRENCY_DRIFT") {
    await asOwner.mutation(api.financeDealCosts.reconcileDealFee, { orgId, feeId, notes: "Matched." });
    const settings = await t.run((ctx) =>
      ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
    );
    await t.run((ctx) => ctx.db.patch(settings!._id, { currency: "USD", currencySymbol: "USD" }));
  }
  // COSTS_AWAITING_RECONCILIATION: the fee is left unreconciled — one line.

  const counts = async () =>
    await t.run(async (ctx) => {
      const out: Record<string, number> = {};
      for (const table of WRITTEN_TABLES) out[table] = (await ctx.db.query(table).collect()).length;
      return out;
    });

  return { t, orgId, applicationId, asOwner, asManager, asConfirmOnly, counts };
}

type Caller = Awaited<ReturnType<typeof seedDeal>>["asOwner"];

async function refusalOf(caller: Caller, orgId: Id<"organizations">, applicationId: Id<"financeApplications">) {
  try {
    await caller.mutation(api.applications.finalizeDeal, {
      orgId, applicationId, idempotencyKey: "redact-finalize:" + applicationId,
    });
  } catch (error) {
    return error as { data?: unknown; message?: string };
  }
  throw new Error("finalizeDeal was expected to refuse");
}

/** Everything a caller receives from the refusal, serialized. */
const serialized = (error: { data?: unknown; message?: string }) => JSON.stringify({ data: error.data, message: error.message });

describe("finalizeDeal refusals are redacted below the finance tier (SCRUM-414 R1)", () => {
  const belowFinanceTier = [
    ["the default MANAGER template", "asManager"],
    ["a custom role holding only confirm:finance_disbursement", "asConfirmOnly"],
  ] as const;

  test.each(belowFinanceTier)("currency drift (input refusal) as %s: WITHHELD_UNAVAILABLE, no params, no currency", async (_label, who) => {
    const s = await seedDeal("CURRENCY_DRIFT");
    const before = await s.counts();
    const error = await refusalOf(s[who], s.orgId, s.applicationId);

    expect(error.data).toEqual({ code: "WITHHELD_UNAVAILABLE", message: WITHHELD_READINESS_REASON_FALLBACK });
    expect(serialized(error)).not.toMatch(/JOD|USD|params|recorded in/);
    expect(await s.counts()).toEqual(before);
  });

  test.each(belowFinanceTier)("a parameterized check refusal as %s: WITHHELD_<CHECK>, no params, no count or label", async (_label, who) => {
    const s = await seedDeal("COSTS_AWAITING_RECONCILIATION");
    const before = await s.counts();
    const error = await refusalOf(s[who], s.orgId, s.applicationId);

    expect(error.data).toEqual({ code: "WITHHELD_COSTS_CLOSABLE", message: WITHHELD_READINESS_REASON_FALLBACK });
    expect(serialized(error)).not.toMatch(/params|count|cost\(s\)|reconcile|Zebra/i);
    expect(await s.counts()).toEqual(before);
  });

  test("the manager's refusal matches what the readiness query serves the same manager", async () => {
    const s = await seedDeal("COSTS_AWAITING_RECONCILIATION");
    const readiness = await s.asManager.query(api.applications.getClosingReadiness, {
      orgId: s.orgId, applicationId: s.applicationId,
    });
    const blocked = readiness.checks.find((check) => check.status === "BLOCKED" || check.status === "UNAVAILABLE");
    const error = await refusalOf(s.asManager, s.orgId, s.applicationId);
    expect(blocked).toMatchObject({ key: "COSTS_CLOSABLE", reasonCode: "WITHHELD_COSTS_CLOSABLE" });
    expect(error.data).toEqual({ code: blocked!.reasonCode, message: blocked!.reason });
  });

  test("control — the finance tier keeps the full coded payload on both throw sites", async () => {
    const drift = await seedDeal("CURRENCY_DRIFT");
    const driftBefore = await drift.counts();
    expect((await refusalOf(drift.asOwner, drift.orgId, drift.applicationId)).data).toEqual({
      code: "READINESS_CURRENCY_DRIFT",
      params: { recordedCurrency: "JOD", orgCurrency: "USD" },
      message: expect.stringContaining("recorded in JOD, but the organization's currency is now USD"),
    });
    expect(await drift.counts()).toEqual(driftBefore);

    const costs = await seedDeal("COSTS_AWAITING_RECONCILIATION");
    const costsBefore = await costs.counts();
    expect((await refusalOf(costs.asOwner, costs.orgId, costs.applicationId)).data).toEqual({
      code: "COSTS_AWAITING_RECONCILIATION",
      params: { count: 1 },
      message: expect.stringContaining("1 cost(s) on this deal have an amount nobody has checked"),
    });
    expect(await costs.counts()).toEqual(costsBefore);
  });
});
