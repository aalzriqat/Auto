import { convexTestWithComponents, registerHandover } from "./convexTest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

/**
 * The owner's worked example for a financed deal (SCRUM-435 / SCRUM-413 PR-B):
 * G = 12,500 approved, H = 200 deposit held, C = 1,375 dealership contribution.
 * Shared by the suites that drive a deal from a quote to a finalized (CLOSED)
 * financed deal through the real mutations.
 */
export const G = 12_500_000; // minor units, JOD (3 decimals)
export const H = 200_000;
export const C = 1_375_000;
export const SCALE = 1_000;

/** The v1 recognition fingerprint a pre-v2 deal carries. */
const V1_FINGERPRINT = "v1;JOD;L12500000;G12500000;N12500000;P0;C0;H0";

interface SeedOptions<K extends string> {
  /** The suite's own `import.meta.glob("./**\/*.ts")` of the convex tree. */
  modules: Record<string, () => Promise<unknown>>;
  /** Permissions of the two owner-status identities (`owner` drives the deal, `approver` approves it). */
  ownerPerms: readonly string[];
  /**
   * The non-owner actors, keyed by name. The lower-cased key is the identity
   * suffix (clerk id, email, role name), and the result is keyed the same way.
   */
  actors: Record<K, readonly string[]>;
  /** Appears in the organization name and the vehicle VIN. */
  label: string;
  vinPrefix: string;
  /** A SOURCED (consigned) vehicle instead of a STOCK one. */
  sourced?: boolean;
}

/** An organization with an owner, an approver, the requested actors, an open period and a finance company. */
export async function seedFinancedDealership<K extends string>(tag: string, opts: SeedOptions<K>) {
  const t = convexTestWithComponents(schema, opts.modules);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `${opts.label} ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const mkUser = async (suffix: string, perms: readonly string[], owner: boolean) => {
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `${tag}_${suffix}`, email: `${tag}.${suffix}@example.com`, name: suffix })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: suffix.toUpperCase(), permissions: [...perms], ...(owner ? { isSystemOwnerRole: true } : {}) })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    return { userId, as: t.withIdentity({ subject: `${tag}_${suffix}`, clerkId: `${tag}_${suffix}` }) };
  };
  const owner = await mkUser("owner", opts.ownerPerms, true);
  const approver = await mkUser("appr", opts.ownerPerms, true);
  const actors = {} as Record<K, typeof owner>;
  for (const key of Object.keys(opts.actors) as K[]) {
    actors[key] = await mkUser(key.toLowerCase(), opts.actors[key], false);
  }
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"] })
  );
  await owner.as.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await owner.as.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear,
    periodNumber: 1,
  });
  const period = (await owner.as.query(api.accountingPeriods.list, { orgId }))[0];
  await owner.as.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  const customerStatusId = await t.run((ctx) =>
    ctx.db.insert("orgCustomerStatuses", { orgId, label: "Eligible", isActive: true, order: 1 })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `${opts.vinPrefix}${tag}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
      color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: G / SCALE, status: "AVAILABLE",
      ...(opts.sourced
        ? { sourceType: "SOURCED" as const, sourcedFromName: "Amman Importer Co", sourceCost: 9_000 }
        : { sourceType: "STOCK" as const, purchasePrice: 9_000 }),
    })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId, name: "Jordan Auto Finance", profitRate: 5, maxTermMonths: 60,
      gracePeriodMonths: 0, isActive: true, defaultLtvPercent: 100, adminFees: 0,
    })
  );
  return { t, orgId, customerId, customerStatusId, vehicleId, companyId, owner, approver, actors, fiscalYear };
}

/** The slice of a seeded dealership the deal drivers below use. */
interface DealSeed {
  t: Awaited<ReturnType<typeof seedFinancedDealership>>["t"];
  orgId: Id<"organizations">;
  customerId: Id<"customers">;
  customerStatusId: Id<"orgCustomerStatuses">;
  vehicleId: Id<"vehicles">;
  companyId: Id<"financeCompanies">;
  owner: Awaited<ReturnType<typeof seedFinancedDealership>>["owner"];
  approver: Awaited<ReturnType<typeof seedFinancedDealership>>["approver"];
}

export async function newApplication(s: DealSeed) {
  const quoteId = await s.owner.as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId,
    vehiclePrice: G / SCALE, downPayment: 0, termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY", companyId: s.companyId,
    customerEligibilityStatusIds: [s.customerStatusId], totalFinancedAmount: G / SCALE,
  });
  const applicationId = await s.owner.as.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
  return { quoteId, applicationId };
}

export async function underReview(s: DealSeed) {
  const { applicationId } = await newApplication(s);
  await s.owner.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
  return applicationId;
}

export async function approved(s: DealSeed) {
  const applicationId = await underReview(s);
  await s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
  return applicationId;
}

/** Approved, with a held deposit H and a dealership contribution C, ready to finalize. */
export async function readyDeal(s: DealSeed) {
  const { quoteId, applicationId } = await newApplication(s);
  await s.owner.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
  await s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
  await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId: s.orgId, applicationId, submittedQuotationMinor: G, source: "MANUAL_ENTRY",
  });
  await s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId: s.orgId, applicationId, approvedAmountMinor: G, basis: "MANUAL", notes: "Approved at the quotation.",
  });
  await registerHandover(s.owner.as, api, s.orgId, applicationId);
  await s.owner.as.mutation(api.applications.registerExpectedPayment, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  await s.owner.as.mutation(api.financeDealCosts.recordLegalInvoice, {
    orgId: s.orgId, applicationId, legalInvoiceAmountMinor: G, legalInvoiceNumber: `INV-${applicationId}`,
    legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY",
  });
  const feeId = await s.owner.as.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId,
    feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER", accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false, actualAmountMinor: 0, description: "No closing costs.",
  });
  await s.owner.as.mutation(api.financeDealCosts.reconcileDealFee, { orgId: s.orgId, feeId, notes: "Matched." });
  // The deposit H the dealership holds for this customer and car, and the contribution C.
  await s.t.run(async (ctx) => {
    await ctx.db.insert("deposits", {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, quoteId,
      amount: H / SCALE, amountMinor: H, currency: "JOD", method: "CASH", status: "HELD", holdActive: true,
      createdBy: (await ctx.db.query("users").first())!._id, createdAt: Date.now(),
    } as never);
    await ctx.db.patch(applicationId, { customerFirstPaymentMinor: H, dealerContributionMinor: C });
  });
  return { applicationId, quoteId };
}

/** Finalizes a ready deal as the owner. */
export async function finalizeAsOwner(s: DealSeed, applicationId: Id<"financeApplications">) {
  await s.owner.as.mutation(api.applications.finalizeDeal, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId,
  });
}

/** Rewrites a finalized deal as a pre-v2 (v1) deal: no v2 marker, the v1 fingerprint. */
export async function downgradeToV1(s: Pick<DealSeed, "t">, applicationId: Id<"financeApplications">) {
  await s.t.run((ctx) =>
    ctx.db.patch(applicationId, {
      financedSalePlanVersion: undefined, financeCompanyForwardDueMinor: undefined,
      financedSaleRecognitionFingerprint: V1_FINGERPRINT,
    })
  );
}

export function refusalMessageOfError(error: unknown): string {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "object" && data !== null && typeof (data as { message?: unknown }).message === "string") {
    return (data as { message: string }).message;
  }
  return String(data ?? (error as Error)?.message ?? error);
}

/** The refusal message of a call, or null when it was accepted. */
export async function refusalMessageOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
  } catch (error) {
    return refusalMessageOfError(error);
  }
  return null;
}
