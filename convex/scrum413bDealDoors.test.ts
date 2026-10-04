/**
 * SCRUM-413 PR-B (decision D-32) - the deal doors move off finalize:financed_deal.
 *
 * Invariant: only ROUTE (manage:supplier_settlement) holders record a financed
 * application's supplier route, and only CANCEL_CLOSED (cancel:closed_deal)
 * holders reverse a CLOSED financed deal, through any door. No default template
 * grants either to SALES, and the retired finalize:financed_deal never mints
 * an active authority. Owner status is unchanged.
 *
 * Role x status x door matrix. Each cell is an OUTCOME (ALLOWED / REFUSED), so a
 * failure prints the whole row rather than the first wrong cell.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime and not production data.
 */
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES, PERMISSIONS } from "./utils/permissions";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

const ROUTE = PERMISSIONS.MANAGE_SUPPLIER_SETTLEMENT;
const CANCEL_CLOSED = PERMISSIONS.CANCEL_CLOSED_DEAL;
const CREATE = PERMISSIONS.CREATE_FINANCE_APPLICATION;
const CONFIRM = PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT;
/** A literal on purpose: the retired permission is no longer in PERMISSIONS. */
const LEGACY_FINALIZE = "finalize:financed_deal";

const template = (name: string): string[] =>
  [...(DEFAULT_ROLE_TEMPLATES.find((r) => r.name === name)?.permissions ?? [])];

/** What every door needs before it ever reaches the permission under test. */
const DOOR_BASE = [
  "view:finance_applications", "view:sales", "edit:sales", "approve:requests", "view:vehicles", "view:customers",
];

type RoleKey =
  | "SALES" | "MANAGER" | "ACCOUNTANT" | "ROUTE_ONLY" | "CANCEL_ONLY" | "CANCEL_PLUS_CONFIRM"
  | "FINALIZE_ONLY" | "OWNER";

/**
 * ROUTE_ONLY and FINALIZE_ONLY deliberately hold CREATE and CONFIRM as well:
 * they would pass every OTHER gate, so a refusal is about the authority under
 * test and nothing else. CANCEL_ONLY holds no CREATE - the point of D-32.
 */
const ROLE_PERMS: Record<Exclude<RoleKey, "OWNER">, string[]> = {
  SALES: template("SALES"),
  MANAGER: template("MANAGER"),
  ACCOUNTANT: template("ACCOUNTANT"),
  ROUTE_ONLY: [ROUTE, CREATE, CONFIRM, "view:finance"],
  CANCEL_ONLY: [CANCEL_CLOSED],
  CANCEL_PLUS_CONFIRM: [CANCEL_CLOSED, CONFIRM],
  FINALIZE_ONLY: [LEGACY_FINALIZE, CREATE, CONFIRM],
};
const ROLE_KEYS = [...Object.keys(ROLE_PERMS), "OWNER"] as RoleKey[];

const G = 12_500_000; // minor units, JOD (3 decimals)
const H = 200_000;
const C = 1_375_000;
const SCALE = 1_000;

async function seed(tag: string, opts: { sourced?: boolean } = {}) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S413b ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const mkUser = async (suffix: string, perms: string[], owner: boolean) => {
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: `${tag}_${suffix}`, email: `${tag}.${suffix}@example.com`, name: suffix })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId, name: suffix.toUpperCase(), permissions: [...new Set([...perms, ...(owner ? [] : DOOR_BASE)])],
        ...(owner ? { isSystemOwnerRole: true } : {}),
      })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    return { userId, as: t.withIdentity({ subject: `${tag}_${suffix}`, clerkId: `${tag}_${suffix}` }) };
  };
  // `owner` drives the deal; `approver` is a SECOND owner-status identity (the
  // OWNER matrix row), because sale cancellation refuses the sale's own salesperson.
  const owner = await mkUser("owner", [...ALL_PERMISSIONS], true);
  const approver = await mkUser("appr", [...ALL_PERMISSIONS], true);
  const actors = {} as Record<RoleKey, { userId: Id<"users">; as: typeof owner.as }>;
  for (const key of Object.keys(ROLE_PERMS) as Exclude<RoleKey, "OWNER">[]) {
    actors[key] = await mkUser(key.toLowerCase(), ROLE_PERMS[key], false);
  }
  actors.OWNER = approver;

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
      orgId, vin: `VIN413B${tag}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
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
  return { t, orgId, customerId, customerStatusId, vehicleId, companyId, owner, approver, actors };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

async function newApplication(s: Seeded) {
  const quoteId = await s.owner.as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId,
    vehiclePrice: G / SCALE, downPayment: 0, termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY", companyId: s.companyId,
    customerEligibilityStatusIds: [s.customerStatusId], totalFinancedAmount: G / SCALE,
  });
  const applicationId = await s.owner.as.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
  return { quoteId, applicationId };
}

async function underReview(s: Seeded) {
  const { applicationId } = await newApplication(s);
  await s.owner.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
  return applicationId;
}

async function approved(s: Seeded) {
  const applicationId = await underReview(s);
  await s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
  return applicationId;
}

/** Approved, with a held deposit H and a dealership contribution C, ready to finalize. */
async function finalizedDeal(tag: string, version: 1 | 2 = 2) {
  const s = await seed(tag);
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
  await s.t.run(async (ctx) => {
    await ctx.db.insert("deposits", {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, quoteId,
      amount: H / SCALE, amountMinor: H, currency: "JOD", method: "CASH", status: "HELD", holdActive: true,
      createdBy: (await ctx.db.query("users").first())!._id, createdAt: Date.now(),
    } as never);
    await ctx.db.patch(applicationId, { customerFirstPaymentMinor: H, dealerContributionMinor: C });
  });
  await s.owner.as.mutation(api.applications.finalizeDeal, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId,
  });
  if (version === 1) {
    await s.t.run((ctx) =>
      ctx.db.patch(applicationId, {
        financedSalePlanVersion: undefined, financeCompanyForwardDueMinor: undefined,
        financedSaleRecognitionFingerprint: "v1;JOD;L12500000;G12500000;N12500000;P0;C0;H0",
      })
    );
  }
  return { s, applicationId };
}

function messageOf(error: unknown): string {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "object" && data !== null && typeof (data as { message?: unknown }).message === "string") {
    return (data as { message: string }).message;
  }
  return String(data ?? (error as Error)?.message ?? error);
}
async function refusalOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
  } catch (error) {
    return messageOf(error);
  }
  return null;
}

type Outcome = "ALLOWED" | "REFUSED";
/** Runs `attempt` as each role in order and returns the outcome row. */
async function row(
  roles: RoleKey[],
  attempt: (role: RoleKey) => Promise<unknown>
): Promise<Partial<Record<RoleKey, Outcome>>> {
  const out: Partial<Record<RoleKey, Outcome>> = {};
  for (const role of roles) out[role] = (await refusalOf(attempt(role))) === null ? "ALLOWED" : "REFUSED";
  return out;
}

const cancelAs = (
  s: Seeded, applicationId: Id<"financeApplications">, role: RoleKey, idempotencyKey: string = crypto.randomUUID()
) =>
  s.actors[role].as.mutation(api.applications.cancelApplication, {
    orgId: s.orgId, applicationId, reason: "Customer withdrew.", idempotencyKey,
  });

describe("SCRUM-413 PR-B D-a - setSupplierSettlementRoute takes ROUTE", () => {
  test("only ROUTE holders (and the owner) record the route; SALES, CANCEL_CLOSED and legacy FINALIZE are refused", async () => {
    const s = await seed("route", { sourced: true });
    const applicationId = await approved(s);
    const outcomes = await row(ROLE_KEYS, (role) =>
      s.actors[role].as.mutation(api.applications.setSupplierSettlementRoute, {
        orgId: s.orgId, applicationId, route: "THROUGH_DEALERSHIP",
      })
    );
    expect(outcomes).toEqual({
      SALES: "REFUSED",
      MANAGER: "ALLOWED",
      ACCOUNTANT: "ALLOWED",
      ROUTE_ONLY: "ALLOWED",
      CANCEL_ONLY: "REFUSED",
      CANCEL_PLUS_CONFIRM: "REFUSED",
      FINALIZE_ONLY: "REFUSED",
      OWNER: "ALLOWED",
    });
  });

  test("the refusal names the missing authority", async () => {
    const s = await seed("routemsg", { sourced: true });
    const applicationId = await approved(s);
    const refusal = await refusalOf(
      s.actors.FINALIZE_ONLY.as.mutation(api.applications.setSupplierSettlementRoute, {
        orgId: s.orgId, applicationId, route: "THROUGH_DEALERSHIP",
      })
    );
    expect(refusal).toMatch(/manage:supplier_settlement/);
  });
});

describe("SCRUM-413 PR-B D-b - cancelApplication, CLOSED v2", () => {
  test("refused: SALES, ACCOUNTANT, ROUTE_ONLY, FINALIZE_ONLY, and CANCEL_CLOSED without CONFIRM names the manager", async () => {
    const { s, applicationId } = await finalizedDeal("b2r");
    const outcomes = await row(["SALES", "ACCOUNTANT", "ROUTE_ONLY", "FINALIZE_ONLY", "CANCEL_ONLY"], (role) =>
      cancelAs(s, applicationId, role)
    );
    expect(outcomes).toEqual({
      SALES: "REFUSED", ACCOUNTANT: "REFUSED", ROUTE_ONLY: "REFUSED", FINALIZE_ONLY: "REFUSED", CANCEL_ONLY: "REFUSED",
    });
    expect(await refusalOf(cancelAs(s, applicationId, "CANCEL_ONLY"))).toBe("A manager cancels a finalized deal.");
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");
  });

  test("CANCEL_CLOSED + CONFIRM cancels WITHOUT create:finance_application", async () => {
    const { s, applicationId } = await finalizedDeal("b2c");
    expect(s.actors.CANCEL_PLUS_CONFIRM.as).toBeDefined();
    expect(await refusalOf(cancelAs(s, applicationId, "CANCEL_PLUS_CONFIRM"))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
  });

  test("the default MANAGER cancels", async () => {
    const { s, applicationId } = await finalizedDeal("b2m");
    expect(await refusalOf(cancelAs(s, applicationId, "MANAGER"))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
  });

  test("the owner cancels", async () => {
    const { s, applicationId } = await finalizedDeal("b2o");
    expect(await refusalOf(cancelAs(s, applicationId, "OWNER"))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
  });
});

describe("SCRUM-413 PR-B D-b - cancelApplication, CLOSED v1, replay and non-CLOSED", () => {
  test("CLOSED v1: SALES, ROUTE_ONLY and FINALIZE_ONLY are refused; CANCEL_CLOSED alone cancels without CREATE", async () => {
    const { s, applicationId } = await finalizedDeal("b1", 1);
    const refused = await row(["SALES", "ACCOUNTANT", "ROUTE_ONLY", "FINALIZE_ONLY"], (role) =>
      cancelAs(s, applicationId, role)
    );
    expect(refused).toEqual({ SALES: "REFUSED", ACCOUNTANT: "REFUSED", ROUTE_ONLY: "REFUSED", FINALIZE_ONLY: "REFUSED" });
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");

    const key = crypto.randomUUID();
    expect(await refusalOf(cancelAs(s, applicationId, "CANCEL_ONLY", key))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");

    // Certified cancel-replay rule: the matching replay is served ...
    expect(await refusalOf(cancelAs(s, applicationId, "CANCEL_ONLY", key))).toBeNull();
    // ... a FRESH key on an already-CANCELLED application needs CREATE, which CANCEL_ONLY does not hold ...
    expect(await refusalOf(cancelAs(s, applicationId, "CANCEL_ONLY"))).not.toBeNull();
    // ... a CREATE holder is still served the idempotent already-cancelled path ...
    expect(await refusalOf(cancelAs(s, applicationId, "SALES"))).toBeNull();
    // ... and a caller holding neither authority cannot ride the stored key.
    expect(await refusalOf(cancelAs(s, applicationId, "ACCOUNTANT", key))).not.toBeNull();
  });

  test("non-CLOSED keeps CREATE: a CREATE holder cancels, CANCEL_CLOSED alone cannot", async () => {
    const s = await seed("nc");
    const applicationId = await underReview(s);
    expect(await refusalOf(cancelAs(s, applicationId, "CANCEL_PLUS_CONFIRM"))).not.toBeNull();
    expect(await refusalOf(cancelAs(s, applicationId, "CANCEL_ONLY"))).not.toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("UNDER_REVIEW");
    expect(await refusalOf(cancelAs(s, applicationId, "SALES"))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
  });
});

describe("SCRUM-413 PR-B D-c - sales.update cancel of a linked sale", () => {
  test("a v2 sale cancel is gated on CANCEL_CLOSED + CONFIRM, never FINALIZE", async () => {
    const { s, applicationId } = await finalizedDeal("c2");
    const saleId = (await s.t.run((ctx) => ctx.db.get(applicationId)))!.finalizedSaleId!;
    const attempt = (role: RoleKey) =>
      s.actors[role].as.mutation(api.sales.update, { orgId: s.orgId, saleId, status: "CANCELLED" });
    const gate = "A manager cancels a finalized deal.";
    const passes = /cancel this deal from the deal screen/;

    // Roles refused AT the manager gate.
    for (const role of ["SALES", "ACCOUNTANT", "ROUTE_ONLY", "FINALIZE_ONLY", "CANCEL_ONLY"] as RoleKey[]) {
      expect(await refusalOf(attempt(role)), role).toBe(gate);
    }
    // Roles that clear it reach the standing "cancel from the deal screen" refusal.
    for (const role of ["CANCEL_PLUS_CONFIRM", "MANAGER", "OWNER"] as RoleKey[]) {
      expect(await refusalOf(attempt(role)), role).toMatch(passes);
    }
  });
});

describe("SCRUM-413 PR-B D-d - the cockpit projection mirrors the door", () => {
  const mayCancel = async (s: Seeded, applicationId: Id<"financeApplications">, role: RoleKey) => {
    const cockpit = await s.actors[role].as.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
    return cockpit?.forward.mayCancelFinalized;
  };

  test("CLOSED v2: CANCEL_CLOSED + CONFIRM (no CREATE) is offered; FINALIZE-only, SALES, ROUTE-only are not", async () => {
    const { s, applicationId } = await finalizedDeal("d2");
    const out: Partial<Record<RoleKey, boolean | undefined>> = {};
    for (const role of ROLE_KEYS) out[role] = await mayCancel(s, applicationId, role);
    expect(out).toEqual({
      SALES: false, MANAGER: true, ACCOUNTANT: false, ROUTE_ONLY: false,
      CANCEL_ONLY: false, CANCEL_PLUS_CONFIRM: true, FINALIZE_ONLY: false, OWNER: true,
    });
  });

  test("CLOSED v1: CANCEL_CLOSED alone is offered, without CREATE or CONFIRM", async () => {
    const { s, applicationId } = await finalizedDeal("d1", 1);
    const out: Partial<Record<RoleKey, boolean | undefined>> = {};
    for (const role of ROLE_KEYS) out[role] = await mayCancel(s, applicationId, role);
    expect(out.CANCEL_ONLY).toBe(true);
    expect(out.CANCEL_PLUS_CONFIRM).toBe(true);
    expect(out.MANAGER).toBe(true);
    expect(out.OWNER).toBe(true);
    expect(out.FINALIZE_ONLY).toBe(false);
    expect(out.ROUTE_ONLY).toBe(false);
    expect(out.SALES).toBe(false);
  });

  test("non-CLOSED: CREATE is what offers the cancel", async () => {
    const s = await seed("dnc");
    const applicationId = await underReview(s);
    expect(await mayCancel(s, applicationId, "SALES")).toBe(true);
    expect(await mayCancel(s, applicationId, "CANCEL_ONLY")).toBe(false);
    expect(await mayCancel(s, applicationId, "OWNER")).toBe(true);
  });
});
