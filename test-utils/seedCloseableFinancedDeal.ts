import { convexTestWithComponents, registerHandover } from "./convexTest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { DEFAULT_ROLE_TEMPLATES } from "../convex/utils/permissions";

/**
 * A financed deal that is closeable but for what the caller adds: approved, handed
 * over, expected payment and legal invoice recorded, one dealer-paid fee recorded
 * (left UNRECONCILED, so the caller reconciles it or not), an open accounting period.
 * Shared by the finalize-refusal suites (SCRUM-414 redaction, SCRUM-420 reconciled gate).
 */
const MODULES = import.meta.glob("../convex/**/*.ts");
const JOD_SCALE = 1000;

const OWNER_PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "manage:supplier_settlement", "cancel:closed_deal", "confirm:finance_disbursement",
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

export interface CloseableDealNames {
  orgName: string;
  buyerLastName: string;
  vin: string;
  companyName: string;
  feeDescription: string;
  /** Amount of the one recorded dealer fee, in minor units. */
  feeAmountMinor: number;
  /** Prefix of the fee's idempotency key. */
  feeKeyPrefix: string;
}

export async function seedCloseableFinancedDeal(names: CloseableDealNames) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: names.orgName, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const ownerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: OWNER_PERMS, isSystemOwnerRole: true })
  );
  const managerRoleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: MANAGER_TEMPLATE.permissions })
  );
  const member = async (clerkId: string, roleId: Id<"roles">) => {
    const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId, email: `${clerkId}@x.com` }));
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    return t.withIdentity({ subject: clerkId, clerkId });
  };
  const asOwner = await member("owner_u", ownerRoleId);
  const asApprover = await member("appr_u", ownerRoleId);
  const asManager = await member("mgr_u", managerRoleId);

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

  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: names.buyerLastName }));
  const customerStatusId = await t.run((ctx) =>
    ctx.db.insert("orgCustomerStatuses", { orgId, label: "Eligible", isActive: true, order: 1 })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: names.vin, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
      color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: 20000, status: "AVAILABLE", sourceType: "STOCK", purchasePrice: 15000,
    })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId, name: names.companyName, profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 0, isActive: true,
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
    deductedFromSettlement: false, actualAmountMinor: names.feeAmountMinor, description: names.feeDescription,
    idempotencyKey: names.feeKeyPrefix + applicationId,
  });

  const counts = async () =>
    await t.run(async (ctx) => {
      const out: Record<string, number> = {};
      for (const table of WRITTEN_TABLES) out[table] = (await ctx.db.query(table).collect()).length;
      return out;
    });

  return { t, orgId, applicationId, feeId, asOwner, asApprover, asManager, member, counts };
}

export type SeededFinancedDeal = Awaited<ReturnType<typeof seedCloseableFinancedDeal>>;
export type DealCaller = SeededFinancedDeal["asOwner"];

/** The error `finalizeDeal` throws for a refused close; fails if it did not refuse. */
export async function refusalOf(caller: DealCaller, orgId: Id<"organizations">, applicationId: Id<"financeApplications">, idempotencyKey: string) {
  try {
    await caller.mutation(api.applications.finalizeDeal, { orgId, applicationId, idempotencyKey });
  } catch (error) {
    return error as { data?: unknown; message?: string };
  }
  throw new Error("finalizeDeal was expected to refuse");
}
