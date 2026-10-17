import { ConvexError } from "convex/values";
import { convexTestWithComponents, registerHandover } from "./convexTest";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";
import { prospectiveForwardPlan } from "../convex/applications";
import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";

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

/**
 * SCRUM-54: a physical bank the finance company's transfer can be received
 * into. Called EXPLICITLY at each BANK_TRANSFER / CHEQUE `confirmDisbursement`
 * (the id is passed in the call); a CASH receipt takes none. It is not seeded
 * with the dealership, so no test gets a bank it did not ask for.
 */
export async function insertReceiptBank(
  s: { t: ForwardPayerSeed["t"]; orgId: Id<"organizations">; owner: { userId: Id<"users"> } },
  over: { currency?: string } = {}
): Promise<Id<"bankAccounts">> {
  const now = Date.now();
  return await s.t.run((ctx) =>
    ctx.db.insert("bankAccounts", {
      orgId: s.orgId, name: "Receiving bank", currency: over.currency ?? "JOD",
      openingBalanceMinor: 0, openingBalanceDate: now, isActive: true, isReconciliationTarget: false,
      createdBy: s.owner.userId, createdAt: now, updatedAt: now,
    })
  );
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

/**
 * What recording the pre-finalize payment needs of a seeded dealership. Structural, so
 * suites that build their own `convexTest` instance (a different instance type from
 * `seedFinancedDealership`'s) can use it.
 */
interface ForwardPayerSeed {
  t: { run: <T>(fn: (ctx: MutationCtx) => Promise<T>) => Promise<T> };
  orgId: Id<"organizations">;
}

export async function newApplication(s: DealSeed, opts: { gapMinor?: number } = {}) {
  const quoteId = await s.owner.as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId,
    // A customer gap R is what the quoted price exceeds the approved amount by.
    vehiclePrice: (G + (opts.gapMinor ?? 0)) / SCALE, downPayment: 0, termMonths: 48,
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

/**
 * Approved, with a held deposit H and a dealership contribution C, ready to finalize.
 * `gapMinor` is the customer gap R owed to the showroom on top of the approved amount;
 * `route` is the consigned car's settlement route (a SOURCED car cannot finalize without one).
 */
export async function readyDeal(
  s: DealSeed,
  opts: {
    gapMinor?: number;
    contributionMinor?: number;
    route?: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER";
    /** false: no reservation deposit is held. Defaults to true. */
    deposit?: boolean;
  } = {}
) {
  const { quoteId, applicationId } = await newApplication(s, { gapMinor: opts.gapMinor });
  await s.owner.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
  await s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
  if (opts.route) {
    await s.owner.as.mutation(api.applications.setSupplierSettlementRoute, {
      orgId: s.orgId, applicationId, route: opts.route,
    });
  }
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
  const feeId = await s.owner.as.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId,
    feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER", accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false, actualAmountMinor: 0, description: "No closing costs.",
  });
  await s.owner.as.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId: s.orgId, feeId, notes: "Matched.", expectedActualAmountMinor: 0, expectedActualEvidenceRevision: 0,
  });
  // The deposit H the dealership holds for this customer and car, and the contribution C.
  const holdsDeposit = opts.deposit !== false;
  await s.t.run(async (ctx) => {
    if (holdsDeposit) {
      await ctx.db.insert("deposits", {
        orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, quoteId,
        amount: H / SCALE, amountMinor: H, currency: "JOD", method: "CASH", status: "HELD", holdActive: true,
        createdBy: (await ctx.db.query("users").first())!._id, createdAt: Date.now(),
      } as never);
    }
    await ctx.db.patch(applicationId, {
      ...(holdsDeposit ? { customerFirstPaymentMinor: H } : {}),
      dealerContributionMinor: opts.contributionMinor ?? C,
      ...(opts.gapMinor ? { customerGapCashToDealerMinor: opts.gapMinor } : {}),
    });
  });
  return { applicationId, quoteId };
}

/**
 * What the dealership owes the finance company onward (H + D) according to the plan
 * finalize WOULD freeze now, or 0 when no forward plan covers the deal or the deal is
 * not ready to close (finalize then refuses for its own reason, which the caller sees).
 */
async function prospectiveForwardDueMinor(s: ForwardPayerSeed, applicationId: Id<"financeApplications">): Promise<number> {
  return await s.t.run(async (ctx) => {
    const app = await ctx.db.get(applicationId);
    if (app === null) return 0;
    try {
      return (await prospectiveForwardPlan(ctx, app, true))?.forwardDueMinor ?? 0;
    } catch (error) {
      // Only the deliberate "not ready to close" refusal; a fixture or code defect must surface.
      if (error instanceof ConvexError) return 0;
      throw error;
    }
  });
}

/**
 * SCRUM-411 P2-01: the deposit and the contribution are paid to the finance company
 * BEFORE the deal is finalized. Records that payment through the real mutation as
 * `payer` (an identity that may move finance money), for the amount the deal is about
 * to freeze; null when nothing is owed. For suites that seed their own dealership.
 */
export async function payForwardBeforeFinalize(
  s: ForwardPayerSeed,
  payer: DealSeed["owner"]["as"],
  applicationId: Id<"financeApplications">
): Promise<Id<"financeCompanyForwards"> | null> {
  // A payment already on file (a test that paid explicitly, then finalizes through
  // `finalizeAsOwner`) is the payment: a second one would be refused as a duplicate.
  const live = await s.t.run(async (ctx) =>
    (await ctx.db.query("financeCompanyForwards").withIndex("by_org_application", (q) => q.eq("orgId", s.orgId).eq("applicationId", applicationId)).take(10)).filter(
      (row) => row.reversalRequestedAt === undefined
    )
  );
  if (live.length > 0) return null;
  const expectedAmountMinor = await prospectiveForwardDueMinor(s, applicationId);
  if (expectedAmountMinor <= 0) return null;
  return await payer.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", paidAt: Date.now(),
    expectedAmountMinor, idempotencyKey: crypto.randomUUID(),
  });
}

/** The same payment, recorded as the seeded owner. */
export async function payForwardAsOwner(
  s: DealSeed,
  applicationId: Id<"financeApplications">
): Promise<Id<"financeCompanyForwards"> | null> {
  return await payForwardBeforeFinalize(s, s.owner.as, applicationId);
}

/**
 * Finalizes a ready deal as the owner. Pays the forward first when one is owed
 * (finalize refuses until it is on the books); `payForward: false` finalizes as is,
 * for the tests that assert that refusal.
 */
export async function finalizeAsOwner(
  s: DealSeed,
  applicationId: Id<"financeApplications">,
  opts: { payForward?: boolean } = {}
) {
  if (opts.payForward !== false) await payForwardAsOwner(s, applicationId);
  await s.owner.as.mutation(api.applications.finalizeDeal, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId,
  });
}

/**
 * A CLOSED deal whose forward is due again: paid, finalized, then the payment taken
 * back. Finalize now refuses an unpaid forward, so this is the only way a CLOSED
 * deal reaches DUE (a manager who voids a recorded-in-error payment).
 */
export async function finalizeThenTakeForwardBack(s: DealSeed, applicationId: Id<"financeApplications">) {
  const forwardId = await payForwardAsOwner(s, applicationId);
  await finalizeAsOwner(s, applicationId, { payForward: false });
  if (forwardId !== null) {
    await s.owner.as.mutation(api.financeCompanyForward.reverseFinanceCompanyForward, {
      orgId: s.orgId, applicationId, forwardId, reason: "Recorded in error.", idempotencyKey: crypto.randomUUID(),
    });
  }
  return forwardId;
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

/**
 * Creates the previous fiscal year's period, opens it and CLOSES it through the
 * real mutations (checklist warnings acknowledged as the close dialog does), so
 * a handover dated in it meets a genuinely CLOSED period rather than a missing
 * one. Returns a handover timestamp inside that period.
 */
export async function closePriorYearPeriod(
  s: Pick<DealSeed, "orgId" | "owner"> & { fiscalYear: number }
): Promise<{ periodId: Id<"accountingPeriods">; handoverAt: number }> {
  const year = s.fiscalYear - 1;
  const periodId = await s.owner.as.mutation(api.accountingPeriods.create, {
    orgId: s.orgId,
    startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    fiscalYear: year,
    periodNumber: 1,
    openImmediately: true,
  });
  const checklist = await s.owner.as.query(api.accountingPeriods.closeChecklist, { orgId: s.orgId, periodId });
  await s.owner.as.mutation(api.accountingPeriods.close, {
    orgId: s.orgId, periodId, acknowledgedWarnings: checklist.warnings,
  });
  return { periodId, handoverAt: Date.UTC(year, 5, 15) };
}

/** The `{ code, message }` a refused call carried, or null when it was accepted. */
export async function refusalDataOf(promise: Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  try {
    await promise;
  } catch (error) {
    const data = (error as { data?: unknown })?.data;
    if (typeof data === "object" && data !== null) {
      const { code, message } = data as { code?: unknown; message?: unknown };
      return {
        ...(typeof code === "string" ? { code } : {}),
        message: typeof message === "string" ? message : refusalMessageOfError(error),
      };
    }
    return { message: refusalMessageOfError(error) };
  }
  return null;
}

/**
 * Rewrites a finalized deal as a CLOSED v2 deal (the plan version live before
 * server-derived economics): the v2 marker and the v2 fingerprint prefix. Every
 * other frozen figure of a non-direct deal is the same under v2 and v3, so the
 * forward fields stay as finalize froze them.
 */
export async function downgradeToV2(s: Pick<DealSeed, "t">, applicationId: Id<"financeApplications">) {
  await s.t.run(async (ctx) => {
    const app = await ctx.db.get(applicationId);
    const fingerprint = app?.financedSaleRecognitionFingerprint;
    if (typeof fingerprint !== "string" || !fingerprint.startsWith("v3;")) {
      throw new Error("downgradeToV2 expects a deal finalized under plan v3");
    }
    await ctx.db.patch(applicationId, {
      financedSalePlanVersion: 2,
      financedSaleRecognitionFingerprint: `v2;${fingerprint.slice(3)}`,
    });
  });
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
