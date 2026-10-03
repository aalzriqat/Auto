import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";
import { WITHHELD_READINESS_REASON_FALLBACK } from "../lib/closingReadinessReasonCodes";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

/**
 * SCRUM-420: a financed deal whose application carries
 * `needsFinancingReconciliation === true` can never finalize, by any door.
 * The refusal is the closing-readiness check `FINANCING_RECONCILED`, appended
 * LAST to `evaluateClosingReadiness`, which `finalizeDeal` re-runs through
 * `resolveFinancedSalePlan` before its first write. Clearing the flag goes
 * through the existing `resolveFinancingReconciliation`.
 */
const MODULES = import.meta.glob("./**/*.ts");
const JOD_SCALE = 1000;

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

type FlagState = true | false | undefined;

async function seedDeal(opts: { flag: FlagState; reconcileFee?: boolean }) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Reconciled Gate Co", createdAt: Date.now() }));
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

  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: "Gate" }));
  const customerStatusId = await t.run((ctx) =>
    ctx.db.insert("orgCustomerStatuses", { orgId, label: "Eligible", isActive: true, order: 1 })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: "VINGATE420", make: "Kia", model: "Sportage", year: 2024, mileage: 10,
      color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: 20000, status: "AVAILABLE", sourceType: "STOCK", purchasePrice: 15000,
    })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId, name: "Gate Finance", profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 0, isActive: true,
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
    deductedFromSettlement: false, actualAmountMinor: 0, description: "Courier (dealership bore none)",
    idempotencyKey: "gate-fee:" + applicationId,
  });
  if (opts.reconcileFee !== false) {
    await asOwner.mutation(api.financeDealCosts.reconcileDealFee, { orgId, feeId, notes: "Matched." });
  }
  // The flag is set LAST, so no earlier writer's recompute can move it.
  await t.run((ctx) =>
    ctx.db.patch(applicationId, {
      needsFinancingReconciliation: opts.flag,
      financingReconciliationReason: opts.flag === true ? "SCRUM-420 fixture: figures flagged for review." : undefined,
    })
  );

  const counts = async () =>
    await t.run(async (ctx) => {
      const out: Record<string, number> = {};
      for (const table of WRITTEN_TABLES) out[table] = (await ctx.db.query(table).take(1000)).length;
      return out;
    });
  const readApp = async () => (await t.run((ctx) => ctx.db.get(applicationId)))!;

  return { t, orgId, applicationId, asOwner, asManager, counts, readApp };
}

type Seeded = Awaited<ReturnType<typeof seedDeal>>;
type Caller = Seeded["asOwner"];

const finalize = (caller: Caller, s: Seeded, key = "gate-finalize:" + s.applicationId) =>
  caller.mutation(api.applications.finalizeDeal, { orgId: s.orgId, applicationId: s.applicationId, idempotencyKey: key });

async function refusalOf(caller: Caller, s: Seeded) {
  try {
    await finalize(caller, s);
  } catch (error) {
    return error as { data?: unknown; message?: string };
  }
  throw new Error("finalizeDeal was expected to refuse");
}

const readiness = (caller: Caller, s: Seeded) =>
  caller.query(api.applications.getClosingReadiness, { orgId: s.orgId, applicationId: s.applicationId });

describe("SCRUM-420 — a deal flagged needsFinancingReconciliation cannot finalize", () => {
  test("T7: a flagged, otherwise-closeable financed deal is not ready; FINANCING_RECONCILED is BLOCKED and ordered LAST", async () => {
    const s = await seedDeal({ flag: true });
    const served = await readiness(s.asOwner, s);
    const blocked = served.checks.filter((check) => check.status === "BLOCKED" || check.status === "UNAVAILABLE");

    // The fixture is otherwise closeable: the flag is the ONLY unmet condition.
    expect(blocked.map((check) => check.key)).toEqual(["FINANCING_RECONCILED"]);
    expect(served.state).toBe("BLOCKED");
    expect(served.checks[served.checks.length - 1]).toMatchObject({
      key: "FINANCING_RECONCILED",
      status: "BLOCKED",
      reasonCode: "FINANCING_RECONCILIATION_FLAGGED",
    });
  });

  test("T7: a below-finance-tier caller is served the WITHHELD code, with no figures or reason text", async () => {
    const s = await seedDeal({ flag: true });
    const served = await readiness(s.asManager, s);
    const check = served.checks.find((c) => c.key === "FINANCING_RECONCILED");
    expect(check).toMatchObject({ status: "BLOCKED", reasonCode: "WITHHELD_FINANCING_RECONCILED", reason: WITHHELD_READINESS_REASON_FALLBACK });
    expect(JSON.stringify(check)).not.toMatch(/SCRUM-420 fixture/);
  });

  test("T17: a direct finalizeDeal on a flagged deal is refused with the coded reason, and NOTHING is written", async () => {
    const s = await seedDeal({ flag: true });
    const before = await s.counts();

    const error = await refusalOf(s.asOwner, s);
    expect(error.data).toMatchObject({ code: "FINANCING_RECONCILIATION_FLAGGED", message: expect.stringMatching(/reconcil/i) });

    // No sale, journal, receivable, outbox row or idempotency completion.
    expect(await s.counts()).toEqual(before);
    const app = await s.readApp();
    expect(app.status).toBe("APPROVED");
    expect(app.finalizedSaleId).toBeUndefined();
    expect(app.needsFinancingReconciliation).toBe(true);
  });

  test("T17: the same refusal below the finance tier is the WITHHELD code, and nothing is written", async () => {
    const s = await seedDeal({ flag: true });
    const before = await s.counts();
    const error = await refusalOf(s.asManager, s);
    expect(error.data).toEqual({ code: "WITHHELD_FINANCING_RECONCILED", message: WITHHELD_READINESS_REASON_FALLBACK });
    expect(await s.counts()).toEqual(before);
  });

  test("control: after resolveFinancingReconciliation clears the flag, the check is READY and finalize succeeds", async () => {
    const s = await seedDeal({ flag: true });
    await expect(finalize(s.asOwner, s, "gate-first")).rejects.toThrow();

    await s.asOwner.mutation(api.financingEconomics.resolveFinancingReconciliation, {
      orgId: s.orgId, applicationId: s.applicationId, note: "Checked the figures against the approval letter.",
    });
    expect((await s.readApp()).needsFinancingReconciliation).toBe(false);
    expect((await readiness(s.asOwner, s)).checks.find((c) => c.key === "FINANCING_RECONCILED")).toMatchObject({ status: "READY" });

    const saleId = await finalize(s.asOwner, s, "gate-second");
    expect(saleId).toBeTruthy();
    const app = await s.readApp();
    expect(app.status).toBe("CLOSED");
    expect(app.finalizedSaleId).toBe(saleId);
    expect((await s.counts()).sales).toBe(1);
  });

  test("control: an unflagged deal (flag never set) is unaffected — NOT_APPLICABLE, and finalize succeeds", async () => {
    const s = await seedDeal({ flag: undefined });
    const served = await readiness(s.asOwner, s);
    expect(served.state).toBe("READY");
    expect(served.checks.find((c) => c.key === "FINANCING_RECONCILED")).toMatchObject({ status: "NOT_APPLICABLE" });
    expect(await finalize(s.asOwner, s)).toBeTruthy();
    expect((await s.counts()).sales).toBe(1);
  });

  test("control: a deal whose flag was cleared (false) is unaffected — READY, and finalize succeeds", async () => {
    const s = await seedDeal({ flag: false });
    const served = await readiness(s.asOwner, s);
    expect(served.state).toBe("READY");
    expect(served.checks.find((c) => c.key === "FINANCING_RECONCILED")).toMatchObject({ status: "READY" });
    expect(await finalize(s.asOwner, s)).toBeTruthy();
  });

  test("T18: a flagged deal with an EXISTING unmet check still surfaces the existing reason (the new check is appended LAST)", async () => {
    const s = await seedDeal({ flag: true, reconcileFee: false });
    const served = await readiness(s.asOwner, s);
    const keys = served.checks.map((check) => check.key);
    expect(keys[keys.length - 1]).toBe("FINANCING_RECONCILED");
    expect(served.checks.find((c) => c.key === "COSTS_CLOSABLE")).toMatchObject({
      status: "BLOCKED", reasonCode: "COSTS_AWAITING_RECONCILIATION",
    });
    expect(served.checks.find((c) => c.key === "FINANCING_RECONCILED")).toMatchObject({ status: "BLOCKED" });

    const before = await s.counts();
    const error = await refusalOf(s.asOwner, s);
    expect(error.data).toMatchObject({ code: "COSTS_AWAITING_RECONCILIATION" });
    expect(await s.counts()).toEqual(before);
  });

  test("T17b: resolve, then a recompute re-raises the flag, finalize is refused, resolve again, finalize succeeds (direct-route-independent)", async () => {
    const s = await seedDeal({ flag: true });
    const resolve = (note: string) =>
      s.asOwner.mutation(api.financingEconomics.resolveFinancingReconciliation, {
        orgId: s.orgId, applicationId: s.applicationId, note,
      });
    await resolve("First review.");
    // A writer re-raises the flag (here directly: the recompute does exactly this patch for a company that
    // retains the customer's payment — see `recomputeAndPatchEconomics`).
    await s.t.run((ctx) =>
      ctx.db.patch(s.applicationId, { needsFinancingReconciliation: true, financingReconciliationReason: "re-raised" })
    );
    await expect(finalize(s.asOwner, s, "gate-after-reraise")).rejects.toMatchObject({
      data: { code: "FINANCING_RECONCILIATION_FLAGGED" },
    });
    await resolve("Second review.");
    expect(await finalize(s.asOwner, s, "gate-after-second-resolve")).toBeTruthy();
  });
});
