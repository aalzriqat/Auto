import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, PERMISSIONS } from "./utils/permissions";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { deriveRecommendedCustody } from "./financeDealCosts";
import { drainEntries } from "./accountingOutbox";
import { hookCustodyFeePaid, hookCustodyFeeReversed } from "./accounting/workflowHooks";
import { getDocumentSize } from "convex/values";
import {
  assertStoredVersion,
  CUSTODY_PROOF_CALLER_RESERVE_BYTES,
  CUSTODY_PROOF_CALLER_RESERVE_DOCUMENTS,
  CUSTODY_PROOF_CALLER_RESERVE_QUERIES,
  CUSTODY_CASH_EVENT_TYPE,
  CUSTODY_CASH_EVENT_VERSION,
  custodyCanonicalIdentityRefusal,
  CustodyLedgerReadBudget,
  custodyLedgerFamilyRefusal,
  custodyLedgerFamilyRowRefusal,
  custodyPositionDependencies,
  custodyPostingBlockedReason,
  documentBytes,
  foldAbandonedPayableDeltas,
  isStoredVersion,
  loadCustodyPostedLines,
  MAX_CUSTODY_LEDGER_PROOFS,
  MAX_CUSTODY_LEDGER_READ_BYTES,
  MAX_CUSTODY_POSTED_LINES,
  MAX_CUSTODY_READ_BATCH,
  nextStoredVersion,
  parseCustodyDependencies,
  PLATFORM_DOCUMENT_BYTES,
  PLATFORM_TRANSACTION_READ_BYTES,
} from "./utils/custodySourceLedger";
import { financedSaleRecognitionDate } from "./utils/financedSaleRecognition";

/**
 * Employee cash custody ON THE BOOKS (AF-80).
 *
 * Every custody movement and every custody-paid handover cost posts through
 * the canonical hooks against DEAL_CUSTODY_CLEARING (1250), and every way to
 * un-happen one of them (ACC-3) posts the canonical inverse. These prove the
 * journals per account, the clearing balance's parity with the shared
 * reconciliation engine, the full reversal matrix, the open/closed-period
 * behaviour, the lost-response replays (Sol H1), the post-finalization
 * freeze (Sol H2), tenancy, permission-shaped reads, and the planned/actual
 * split — against the real mutations, never a stub.
 */

type TestConvex = ConvexTestInstance<typeof schema>;
type AuthenticatedTestConvex = ReturnType<TestConvex["withIdentity"]>;
const MODULES = import.meta.glob("./**/*.*s");
const jod = (major: number): number => Math.round(major * 1000);
const DAY = 24 * 60 * 60 * 1000;

interface Seed {
  t: TestConvex;
  orgId: Id<"organizations">;
  otherOrgId: Id<"organizations">;
  userId: Id<"users">;
  employeeId: Id<"users">;
  viewerId: Id<"users">;
  vehicleId: Id<"vehicles">;
  applicationId: Id<"financeApplications">;
  periodId: Id<"accountingPeriods">;
  asUser: AuthenticatedTestConvex;
  asViewer: AuthenticatedTestConvex;
}

/** The finance company's frozen policy: one fee the EMPLOYEE pays at the counter, one the dealer settles. */
const TEMPLATES = [
  {
    feeType: "LICENSING" as const,
    description: "Plates and registration",
    estimatedAmountMinor: jod(90),
    paidBy: "EMPLOYEE" as const,
    paidTo: "GOVERNMENT" as const,
    includedInQuotation: false,
    deductedFromSettlement: false,
    refundable: false,
    accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE" as const,
  },
  {
    feeType: "APPRAISAL_FEE" as const,
    description: "Valuation",
    estimatedAmountMinor: jod(40),
    paidBy: "DEALER" as const,
    paidTo: "APPRAISER" as const,
    includedInQuotation: false,
    deductedFromSettlement: true,
    refundable: false,
    accountingTreatment: "APPRAISAL_EXPENSE" as const,
  },
];

async function seedDeal(
  suffix: string,
  opts: { chart?: boolean; sourceType?: "STOCK" | "SOURCED"; templates?: boolean } = {}
): Promise<Seed> {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Custody ${suffix}`, createdAt: Date.now() }));
  const otherOrgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Other ${suffix}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `cu_user_${suffix}`, email: `cu${suffix}@x.com`, name: "Rana" }));
  // The custodian has NO display name on purpose: the read must not fall
  // back to the address.
  const employeeId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `cu_emp_${suffix}`, email: `secret.${suffix}@x.com` }));
  const viewerId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `cu_view_${suffix}`, email: `view${suffix}@x.com`, name: "Viewer" }));
  const ownerRole = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true })
  );
  const viewerRole = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "VIEWER", permissions: [PERMISSIONS.VIEW_FINANCE_APPLICATIONS] })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId: ownerRole }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: employeeId, roleId: ownerRole }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: viewerId, roleId: viewerRole }));
  const { vehicleId, applicationId } = await t.run(async (ctx) => {
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: `CUVIN${suffix}`, make: "Toyota", model: "Camry", year: 2024,
      mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
      sellingPrice: 10_500, status: "AVAILABLE",
      ...(opts.sourceType === "SOURCED"
        ? { sourceType: "SOURCED" as const, sourcedFromName: "Importer", sourceCost: 9_000 }
        : {}),
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "CU", lastName: "Customer" });
    const quoteId = await ctx.db.insert("quotes", {
      orgId, customerId, vehicleId, vehiclePrice: 10_500, downPayment: 500,
      termMonths: 48, status: "ACCEPTED", createdBy: userId, createdAt: Date.now(),
    });
    const applicationId = await ctx.db.insert("financeApplications", {
      orgId, quoteId, customerId, vehicleId, salespersonId: userId,
      status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
      ...(opts.templates === false
        ? {}
        : { companyRuleSnapshot: { ruleVersion: 1, companyName: "JAF", feeTemplates: TEMPLATES } }),
    });
    return { vehicleId, applicationId };
  });
  const asUser = t.withIdentity({ subject: `cu_user_${suffix}` });
  const asViewer = t.withIdentity({ subject: `cu_view_${suffix}` });
  let periodId = "" as Id<"accountingPeriods">;
  if (opts.chart !== false) {
    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
    const year = new Date().getUTCFullYear();
    await asUser.mutation(api.accountingPeriods.create, {
      orgId, fiscalYear: year, periodNumber: 1,
      startDate: Date.UTC(year - 1, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
      openImmediately: true,
    });
    periodId = (await asUser.query(api.accountingPeriods.list, { orgId }))[0]._id;
  }
  return { t, orgId, otherOrgId, userId, employeeId, viewerId, vehicleId, applicationId, periodId, asUser, asViewer };
}

async function openCustody(seed: Seed, issued = jod(700), extra: { method?: "CASH" | "BANK_TRANSFER"; occurredAt?: number; idempotencyKey?: string } = {}) {
  return await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
    idempotencyKey: extra.idempotencyKey ?? crypto.randomUUID(),
    orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.employeeId,
    issuedMinor: issued, method: extra.method ?? "CASH", occurredAt: extra.occurredAt,
  });
}

async function move(
  seed: Seed,
  custodyId: Id<"financeDealCustody">,
  kind: "ISSUED" | "RETURNED" | "REIMBURSED",
  amountMinor: number,
  extra: { method?: "CASH" | "BANK_TRANSFER"; occurredAt?: number; idempotencyKey?: string } = {}
) {
  return await seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
    orgId: seed.orgId, custodyId, kind, amountMinor, method: extra.method ?? "CASH",
    occurredAt: extra.occurredAt, idempotencyKey: extra.idempotencyKey ?? crypto.randomUUID(),
  });
}

async function reverse(seed: Seed, custodyId: Id<"financeDealCustody">, entryId: Id<"financeDealCustodyEntries">, amountMinor: number, idempotencyKey: string = crypto.randomUUID()) {
  return await seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
    orgId: seed.orgId, custodyId, kind: "REVERSAL", reversesEntryId: entryId, amountMinor, note: "typo", idempotencyKey,
  });
}

async function employeeFee(seed: Seed, custodyId: Id<"financeDealCustody"> | undefined, actualAmountMinor: number, extra: Partial<{
  accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE" | "CAPITALIZED_TO_VEHICLE" | "CUSTOMER_RECEIVABLE" | "SELLING_EXPENSE";
  paidBy: "EMPLOYEE" | "DEALER";
  deductedFromSettlement: boolean;
  paidAt: number;
  idempotencyKey: string;
}> = {}) {
  return await seed.asUser.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: extra.idempotencyKey ?? crypto.randomUUID(),
    orgId: seed.orgId, applicationId: seed.applicationId,
    feeType: "LICENSING", paidBy: extra.paidBy ?? "EMPLOYEE", paidTo: "GOVERNMENT",
    accountingTreatment: extra.accountingTreatment ?? "OWNERSHIP_TRANSFER_EXPENSE",
    deductedFromSettlement: extra.deductedFromSettlement ?? false,
    actualAmountMinor, custodyId, paidAt: extra.paidAt,
  });
}

async function entries(seed: Seed, custodyId: Id<"financeDealCustody">) {
  return await seed.t.run((ctx) =>
    ctx.db.query("financeDealCustodyEntries").withIndex("by_custody", (q) => q.eq("custodyId", custodyId)).collect()
  );
}

/** Net debit-positive movement per system key over POSTED and REVERSED entries — the way the reports read. */
async function ledger(seed: Seed): Promise<Record<string, number>> {
  return await seed.t.run(async (ctx) => {
    const accounts = (await ctx.db.query("chartOfAccounts").collect()).filter((a) => a.orgId === seed.orgId);
    const keyByAccount = new Map<string, string>();
    for (const a of accounts) if (a.systemKey) keyByAccount.set(a._id, a.systemKey);
    const totals: Record<string, number> = {};
    for (const entry of (await ctx.db.query("journalEntries").collect()).filter((e) => e.orgId === seed.orgId)) {
      if (entry.status !== "POSTED" && entry.status !== "REVERSED") continue;
      const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)).collect();
      for (const l of lines) {
        const key = keyByAccount.get(l.accountId);
        if (key) totals[key] = (totals[key] ?? 0) + l.debitMinor - l.creditMinor;
      }
    }
    return totals;
  });
}

async function events(seed: Seed, eventType?: string) {
  return await seed.t.run(async (ctx) =>
    (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", seed.orgId)).collect()).filter(
      (e) => eventType === undefined || e.eventType === eventType
    )
  );
}

async function pending(seed: Seed) {
  return await seed.t.run(async (ctx) =>
    (await ctx.db.query("pendingAccountingEvents").collect()).filter((r) => r.orgId === seed.orgId)
  );
}

const clearing = (l: Record<string, number>) => l[SYSTEM_KEYS.DEAL_CUSTODY_CLEARING] ?? 0;
const cash = (l: Record<string, number>) => l[SYSTEM_KEYS.CASH_ON_HAND] ?? 0;
const bank = (l: Record<string, number>) => l[SYSTEM_KEYS.BANK_ACCOUNT] ?? 0;
const transferExpense = (l: Record<string, number>) => l[SYSTEM_KEYS.OWNERSHIP_TRANSFER_EXPENSE] ?? 0;
/** Debit-positive, so a liability the dealership carries reads NEGATIVE here. */
const payable = (l: Record<string, number>) => l[SYSTEM_KEYS.EMPLOYEE_REIMBURSEMENTS_PAYABLE] ?? 0;

const readCosts = (seed: Seed) =>
  seed.asUser.query(api.financeDealCosts.listDealCosts, { orgId: seed.orgId, applicationId: seed.applicationId });

// ---------------------------------------------------------------------------

describe("the ledger boundary: no chart, no cash", () => {
  test("without a chart every money action is refused, nothing is written, and the read says why", async () => {
    const seed = await seedDeal("nochart", { chart: false });
    await expect(openCustody(seed)).rejects.toThrow(/chart of accounts has not been initialized/);
    expect(await seed.t.run((ctx) => ctx.db.query("financeDealCustody").collect())).toEqual([]);
    expect(await seed.t.run((ctx) => ctx.db.query("commandIdempotency").collect())).toEqual([]);
    const costs = await readCosts(seed);
    expect(costs.custodyAccounting).toEqual({ ready: false, reason: "CHART_NOT_INITIALIZED" });
    // A fee can still be itemized; it just cannot be charged to custody.
    const feeId = await employeeFee(seed, undefined, jod(50));
    expect(feeId).toBeTruthy();
  });

  test("a custom account squatting on 1250 is reported as a conflict, and the movement is refused", async () => {
    const seed = await seedDeal("conflict");
    await seed.t.run(async (ctx) => {
      const row = (await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", seed.orgId).eq("systemKey", SYSTEM_KEYS.DEAL_CUSTODY_CLEARING)).collect())[0];
      // A legacy chart: the key is absent and somebody hand-made an account on its code.
      await ctx.db.patch(row._id, { systemKey: undefined, name: "Petty cash — showroom" });
    });
    const costs = await readCosts(seed);
    expect(costs.custodyAccounting).toEqual({ ready: false, reason: "ACCOUNT_CODE_CONFLICT", systemKey: SYSTEM_KEYS.DEAL_CUSTODY_CLEARING });
    await expect(openCustody(seed)).rejects.toThrow(/custom account on the code reserved/);
  });

  test("a legacy chart that merely lacks 1250 self-heals on the first movement", async () => {
    const seed = await seedDeal("selfheal");
    await seed.t.run(async (ctx) => {
      const row = (await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", seed.orgId).eq("systemKey", SYSTEM_KEYS.DEAL_CUSTODY_CLEARING)).collect())[0];
      await ctx.db.delete(row._id);
    });
    expect((await readCosts(seed)).custodyAccounting).toEqual({ ready: true });
    await openCustody(seed, jod(100));
    const l = await ledger(seed);
    expect(clearing(l)).toBe(jod(100));
    const row = await seed.t.run((ctx) =>
      ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", seed.orgId).eq("systemKey", SYSTEM_KEYS.DEAL_CUSTODY_CLEARING)).collect()
    );
    expect(row).toHaveLength(1);
    expect(row[0].code).toBe("1250");
  });
});

describe("what each movement posts", () => {
  test("issuing cash: Dr custody clearing / Cr cash on hand (CASH) or bank (BANK_TRANSFER)", async () => {
    const seed = await seedDeal("issue");
    const custodyId = await openCustody(seed, jod(700), { method: "CASH" });
    let l = await ledger(seed);
    expect(clearing(l)).toBe(jod(700));
    expect(cash(l)).toBe(-jod(700));
    expect(bank(l)).toBe(0);

    await move(seed, custodyId, "ISSUED", jod(100), { method: "BANK_TRANSFER" });
    l = await ledger(seed);
    expect(clearing(l)).toBe(jod(800));
    expect(bank(l)).toBe(-jod(100));

    const issued = await events(seed, "CUSTODY_CASH_ISSUED");
    expect(issued).toHaveLength(2);
    expect(issued.every((e) => e.status === "POSTED" && e.sourceType === "financeDealCustodyEntries")).toBe(true);
  });

  test("a custody-paid fee: Dr the fee's canonical expense / Cr custody clearing — exactly once, and the clearing balance mirrors the engine", async () => {
    const seed = await seedDeal("fee");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(650));
    const l = await ledger(seed);
    expect(transferExpense(l)).toBe(jod(650));
    expect(clearing(l)).toBe(jod(50));
    const costs = await readCosts(seed);
    const s = costs.custody[0].summary!;
    // Engine parity: issued − returned − expenses + reimbursed.
    expect(s.employeeOwesDealerMinor).toBe(jod(50));
    expect(clearing(l)).toBe(s.employeeOwesDealerMinor);
    const fee = await seed.t.run((ctx) => ctx.db.get(feeId));
    expect(fee?.custodyPosted).toEqual({ version: 1, amountMinor: jod(650), custodyId });
    expect(await events(seed, "CUSTODY_FEE_PAID")).toHaveLength(1);
  });

  test("returning cash and reimbursing the employee: the clearing balance closes to zero and the record reconciles", async () => {
    const seed = await seedDeal("cycle");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(750));
    let l = await ledger(seed);
    // The employee laid out 50 of their own: a LIABILITY, never a credit
    // sitting on the clearing asset (Codex AF-CUST-01).
    expect(clearing(l)).toBe(0);
    expect(payable(l)).toBe(-jod(50));
    expect((await readCosts(seed)).custody[0].summary!.reimbursementOutstandingMinor).toBe(jod(50));

    await move(seed, custodyId, "REIMBURSED", jod(50), { method: "BANK_TRANSFER" });
    l = await ledger(seed);
    expect(clearing(l)).toBe(0);
    expect(payable(l)).toBe(0);
    expect(bank(l)).toBe(-jod(50));
    expect(transferExpense(l)).toBe(jod(750));
    expect(await events(seed, "CUSTODY_REIMBURSED")).toHaveLength(1);

    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "Receipts on file." });
    const row = await seed.t.run((ctx) => ctx.db.get(custodyId));
    expect(row?.status).toBe("RECONCILED");
    expect(row?.writeOffPosted).toBeUndefined();
    // Reconciling a balanced record posts nothing of its own.
    expect(await events(seed, "CUSTODY_WRITTEN_OFF")).toHaveLength(0);
  });

  test("a partial return: Dr cash / Cr clearing", async () => {
    const seed = await seedDeal("return");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(600));
    await move(seed, custodyId, "RETURNED", jod(100));
    const l = await ledger(seed);
    expect(cash(l)).toBe(-jod(600));
    expect(clearing(l)).toBe(0);
    expect(await events(seed, "CUSTODY_CASH_RETURNED")).toHaveLength(1);
  });

  test("a write-off: Dr cash over/short / Cr clearing for exactly the unaccounted residual; reopening reverses it", async () => {
    const seed = await seedDeal("writeoff");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(650));
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(),
      orgId: seed.orgId, custodyId, notes: "Counted twice.", writeOffReason: "50 could not be traced.",
    });
    let l = await ledger(seed);
    expect(l[SYSTEM_KEYS.CASH_OVER_SHORT]).toBe(jod(50));
    expect(clearing(l)).toBe(0);
    let row = await seed.t.run((ctx) => ctx.db.get(custodyId));
    expect(row?.status).toBe("WRITTEN_OFF");
    expect(row?.writeOffPosted).toEqual({ version: 1, amountMinor: jod(50) });

    await seed.asUser.mutation(api.financeDealCosts.reopenDealCustody, { orgId: seed.orgId, custodyId, reason: "The receipt turned up." });
    l = await ledger(seed);
    expect(l[SYSTEM_KEYS.CASH_OVER_SHORT]).toBe(0);
    expect(clearing(l)).toBe(jod(50));
    row = await seed.t.run((ctx) => ctx.db.get(custodyId));
    expect(row?.status).toBe("OPEN");
    expect(row?.writeOffPosted).toBeUndefined();
    expect(row?.writeOffPostingVersion).toBe(1);
    expect(await events(seed, "JOURNAL_REVERSAL")).toHaveLength(1);

    // Written off again: a NEW version, never a reuse of the reversed one.
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(),
      orgId: seed.orgId, custodyId, notes: "Still short.", writeOffReason: "It did not turn up after all.",
    });
    row = await seed.t.run((ctx) => ctx.db.get(custodyId));
    expect(row?.writeOffPosted?.version).toBe(2);
    expect(clearing(await ledger(seed))).toBe(0);
  });

  test("a write-off cannot absorb an over-return, and a balanced record is never written off", async () => {
    const seed = await seedDeal("writeoff-guard");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(700));
    // Balanced: a write-off reason is ignored and the record is RECONCILED.
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(),
      orgId: seed.orgId, custodyId, notes: "Exact.", writeOffReason: "nothing to write off",
    });
    const row = await seed.t.run((ctx) => ctx.db.get(custodyId));
    expect(row?.status).toBe("RECONCILED");
    expect(await events(seed, "CUSTODY_WRITTEN_OFF")).toHaveLength(0);
  });
});

describe("the reversal matrix (ACC-3): every movement's inverse is the canonical JOURNAL_REVERSAL of its own journal", () => {
  test("reversing an ISSUED entry", async () => {
    const seed = await seedDeal("rev-issued");
    const custodyId = await openCustody(seed, jod(700));
    const [issued] = await entries(seed, custodyId);
    await reverse(seed, custodyId, issued._id, jod(700));
    const l = await ledger(seed);
    expect(clearing(l)).toBe(0);
    expect(cash(l)).toBe(0);
    const reversal = await events(seed, "JOURNAL_REVERSAL");
    expect(reversal).toHaveLength(1);
    expect(reversal[0].sourceId).toBe(String(issued._id));
    const original = (await events(seed, "CUSTODY_CASH_ISSUED"))[0];
    expect(original.status).toBe("REVERSED");
    // And the operational totals agree.
    expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))?.issuedMinor).toBe(0);
  });

  test("reversing a RETURNED and a REIMBURSED entry", async () => {
    const seed = await seedDeal("rev-ret");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(750));
    await move(seed, custodyId, "REIMBURSED", jod(50));
    await move(seed, custodyId, "RETURNED", jod(10)); // a mistaken return on top
    const all = await entries(seed, custodyId);
    const reimbursed = all.find((e) => e.kind === "REIMBURSED")!;
    const returned = all.find((e) => e.kind === "RETURNED")!;
    await reverse(seed, custodyId, returned._id, jod(10));
    await reverse(seed, custodyId, reimbursed._id, jod(50));
    const l = await ledger(seed);
    // Back to: issued 700, expense 750 → the 50 shortfall is a payable again
    // (the split follows the position the reversals left); cash −700 net.
    expect(clearing(l)).toBe(0);
    expect(payable(l)).toBe(-jod(50));
    expect(cash(l)).toBe(-jod(700));
    expect(await events(seed, "JOURNAL_REVERSAL")).toHaveLength(2);
    const s = (await readCosts(seed)).custody[0].summary!;
    expect(s.reimbursementOutstandingMinor).toBe(jod(50));
    expect(s.overReturnedMinor).toBe(0);
  });

  test("a reversal entry has no forward posting of its own, and cannot itself be reversed", async () => {
    const seed = await seedDeal("rev-rev");
    const custodyId = await openCustody(seed, jod(700));
    const [issued] = await entries(seed, custodyId);
    await reverse(seed, custodyId, issued._id, jod(700));
    const rev = (await entries(seed, custodyId)).find((e) => e.kind === "REVERSAL")!;
    expect((await events(seed)).filter((e) => e.sourceId === String(rev._id))).toEqual([]);
    await expect(reverse(seed, custodyId, rev._id, jod(700))).rejects.toThrow(/cannot itself be reversed/);
  });

  test("editing a fee's actual: the live version is reversed and the next version posted — never two forward entries", async () => {
    const seed = await seedDeal("fee-edit");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(650));
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: seed.orgId, feeId, actualAmountMinor: jod(700), expectedCurrency: "JOD",
    });
    const l = await ledger(seed);
    expect(transferExpense(l)).toBe(jod(700));
    expect(clearing(l)).toBe(0);
    const fee = await seed.t.run((ctx) => ctx.db.get(feeId));
    expect(fee?.custodyPosted).toEqual({ version: 2, amountMinor: jod(700), custodyId });
    const paid = await events(seed, "CUSTODY_FEE_PAID");
    expect(paid.map((e) => [e.eventVersion, e.status]).sort()).toEqual([[1, "REVERSED"], [2, "POSTED"]]);
    // An unchanged re-record posts nothing more.
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: seed.orgId, feeId, actualAmountMinor: jod(700), expectedCurrency: "JOD",
    });
    expect(await events(seed, "CUSTODY_FEE_PAID")).toHaveLength(2);
  });

  test("voiding a custody-paid fee reverses its posting and hands the cash back to the employee's balance", async () => {
    const seed = await seedDeal("fee-void");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(650));
    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "Wrong deal." });
    const l = await ledger(seed);
    expect(transferExpense(l)).toBe(0);
    expect(clearing(l)).toBe(jod(700));
    expect((await seed.t.run((ctx) => ctx.db.get(feeId)))?.custodyPosted).toBeUndefined();
    expect((await readCosts(seed)).custody[0].summary!.employeeOwesDealerMinor).toBe(jod(700));
  });

  test("charging an existing employee-paid line to custody, then releasing it, then re-charging: versions 1 → reversed → 2", async () => {
    const seed = await seedDeal("fee-attach");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, undefined, jod(300));
    expect(clearing(await ledger(seed))).toBe(jod(700));

    await seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId, custodyId });
    expect(clearing(await ledger(seed))).toBe(jod(400));
    expect(transferExpense(await ledger(seed))).toBe(jod(300));

    await seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId });
    expect(clearing(await ledger(seed))).toBe(jod(700));
    expect(transferExpense(await ledger(seed))).toBe(0);
    expect((await seed.t.run((ctx) => ctx.db.get(feeId)))?.custodyId).toBeUndefined();

    await seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId, custodyId });
    const fee = await seed.t.run((ctx) => ctx.db.get(feeId));
    expect(fee?.custodyPosted?.version).toBe(2);
    // A replay of the same attach (lost response) changes nothing.
    await seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId, custodyId });
    expect(await events(seed, "CUSTODY_FEE_PAID")).toHaveLength(2);
    expect(clearing(await ledger(seed))).toBe(jod(400));
  });

  test("the classification is withdrawn when a cost moves onto custody", async () => {
    const seed = await seedDeal("fee-attach-class");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, undefined, jod(300));
    await seed.t.run((ctx) => ctx.db.patch(seed.applicationId, { accountingClassification: "CLASSIFIED" }));
    await seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId, custodyId });
    expect((await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))?.accountingClassification).toBe("PENDING_CLASSIFICATION");
  });
});

describe("eligibility: what may be paid out of custody", () => {
  test("a settlement-deducted line is refused — it is recognized by the sale plan, and would post twice", async () => {
    const seed = await seedDeal("elig-deducted");
    const custodyId = await openCustody(seed, jod(700));
    await expect(employeeFee(seed, custodyId, jod(50), { deductedFromSettlement: true })).rejects.toThrow(/deducted from the finance company's settlement/);
    expect(await events(seed, "CUSTODY_FEE_PAID")).toHaveLength(0);
  });

  test("a capitalizable or receivable treatment is refused with the reason, not mapped to a near-enough account", async () => {
    const seed = await seedDeal("elig-treatment");
    const custodyId = await openCustody(seed, jod(700));
    await expect(employeeFee(seed, custodyId, jod(50), { accountingTreatment: "CAPITALIZED_TO_VEHICLE" })).rejects.toThrow(/cannot be paid out of an employee's custody/);
    await expect(employeeFee(seed, custodyId, jod(50), { accountingTreatment: "CUSTOMER_RECEIVABLE" })).rejects.toThrow(/cannot be paid out of an employee's custody/);
    // The read names the same rule per line.
    const feeId = await employeeFee(seed, undefined, jod(50), { accountingTreatment: "CAPITALIZED_TO_VEHICLE" });
    const costs = await readCosts(seed);
    expect(costs.fees.find((f) => f._id === feeId)?.custodyEligible).toBe(false);
    const eligibleId = await employeeFee(seed, undefined, jod(50), { accountingTreatment: "SELLING_EXPENSE" });
    expect((await readCosts(seed)).fees.find((f) => f._id === eligibleId)?.custodyEligible).toBe(true);
  });

  test("a SOURCED (consignment) vehicle's handover expense posts as a dealer expense — never into inventory (ACC-1)", async () => {
    const seed = await seedDeal("sourced", { sourceType: "SOURCED" });
    const custodyId = await openCustody(seed, jod(200));
    await employeeFee(seed, custodyId, jod(90));
    const l = await ledger(seed);
    expect(transferExpense(l)).toBe(jod(90));
    expect(l[SYSTEM_KEYS.VEHICLE_INVENTORY] ?? 0).toBe(0);
    expect(l[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS] ?? 0).toBe(0);
  });

  test("a dealer-paid line cannot be charged, and a line of another deal's custody is refused", async () => {
    const seed = await seedDeal("elig-payer");
    const custodyId = await openCustody(seed, jod(700));
    await expect(employeeFee(seed, custodyId, jod(50), { paidBy: "DEALER" })).rejects.toThrow(/paid by that employee/);
    const dealerFee = await employeeFee(seed, undefined, jod(50), { paidBy: "DEALER" });
    await expect(seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId: dealerFee, custodyId })).rejects.toThrow(/paid by that employee/);
  });
});

describe("lost responses replay stored success (Sol H1)", () => {
  test("a RETURNED that filled the advance replays its own success instead of refusing on the state it created", async () => {
    const seed = await seedDeal("replay-returned");
    const custodyId = await openCustody(seed, jod(700));
    const key = "ret-1";
    const first = await move(seed, custodyId, "RETURNED", jod(700), { idempotencyKey: key });
    const again = await move(seed, custodyId, "RETURNED", jod(700), { idempotencyKey: key });
    expect(again).toBe(first);
    expect((await entries(seed, custodyId)).filter((e) => e.kind === "RETURNED")).toHaveLength(1);
    expect(await events(seed, "CUSTODY_CASH_RETURNED")).toHaveLength(1);
    expect(clearing(await ledger(seed))).toBe(0);
    // The same key with a different amount is a different intent: refused.
    await expect(move(seed, custodyId, "RETURNED", jod(1), { idempotencyKey: key })).rejects.toThrow(/reused with different request content/);
  });

  test("a REVERSAL replays its success instead of 'already reversed'", async () => {
    const seed = await seedDeal("replay-reversal");
    const custodyId = await openCustody(seed, jod(700));
    const [issued] = await entries(seed, custodyId);
    const key = "rev-1";
    await reverse(seed, custodyId, issued._id, jod(700), key);
    await expect(reverse(seed, custodyId, issued._id, jod(700), key)).resolves.toBe(custodyId);
    expect((await entries(seed, custodyId)).filter((e) => e.kind === "REVERSAL")).toHaveLength(1);
    expect(await events(seed, "JOURNAL_REVERSAL")).toHaveLength(1);
    // A NEW key against the same target is genuinely refused.
    await expect(reverse(seed, custodyId, issued._id, jod(700))).rejects.toThrow(/already been reversed/);
  });

  test("a movement replayed after the record was reconciled returns its stored result, not 'already closed'", async () => {
    const seed = await seedDeal("replay-closed");
    const custodyId = await openCustody(seed, jod(700));
    const key = "ret-2";
    await move(seed, custodyId, "RETURNED", jod(700), { idempotencyKey: key });
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "All back." });
    await expect(move(seed, custodyId, "RETURNED", jod(700), { idempotencyKey: key })).resolves.toBe(custodyId);
    expect((await entries(seed, custodyId)).filter((e) => e.kind === "RETURNED")).toHaveLength(1);
    // A fresh movement on the closed record is still refused.
    await expect(move(seed, custodyId, "RETURNED", jod(1))).rejects.toThrow(/already closed/);
  });

  test("a movement replayed after the chart was torn down still returns its stored result", async () => {
    const seed = await seedDeal("replay-chart");
    const custodyId = await openCustody(seed, jod(700));
    const key = "reimb-1";
    await employeeFee(seed, custodyId, jod(750));
    await move(seed, custodyId, "REIMBURSED", jod(50), { idempotencyKey: key });
    await seed.t.run(async (ctx) => {
      for (const row of await ctx.db.query("chartOfAccounts").withIndex("by_org", (q) => q.eq("orgId", seed.orgId)).collect()) {
        await ctx.db.delete(row._id);
      }
    });
    await expect(move(seed, custodyId, "REIMBURSED", jod(50), { idempotencyKey: key })).resolves.toBe(custodyId);
    expect((await entries(seed, custodyId)).filter((e) => e.kind === "REIMBURSED")).toHaveLength(1);
    await expect(move(seed, custodyId, "REIMBURSED", jod(1))).rejects.toThrow(/chart of accounts has not been initialized/);
  });

  test("opening custody replays the stored record id and posts once", async () => {
    const seed = await seedDeal("replay-open");
    const key = "open-1";
    const first = await openCustody(seed, jod(700), { idempotencyKey: key });
    const again = await openCustody(seed, jod(700), { idempotencyKey: key });
    expect(again).toBe(first);
    expect(await events(seed, "CUSTODY_CASH_ISSUED")).toHaveLength(1);
    expect(clearing(await ledger(seed))).toBe(jod(700));
  });

  test("a custody-paid fee replays its line and posts once", async () => {
    const seed = await seedDeal("replay-fee");
    const custodyId = await openCustody(seed, jod(700));
    const key = "fee-1";
    const first = await employeeFee(seed, custodyId, jod(650), { idempotencyKey: key });
    const again = await employeeFee(seed, custodyId, jod(650), { idempotencyKey: key });
    expect(again).toBe(first);
    expect(await events(seed, "CUSTODY_FEE_PAID")).toHaveLength(1);
    expect(transferExpense(await ledger(seed))).toBe(jod(650));
  });
});

describe("input that is not a figure is refused before anything is fingerprinted or written", () => {
  test("NaN, fractional and negative amounts and dates", async () => {
    const seed = await seedDeal("nan");
    const custodyId = await openCustody(seed, jod(700));
    await expect(move(seed, custodyId, "RETURNED", Number.NaN)).rejects.toThrow();
    await expect(move(seed, custodyId, "RETURNED", 10.5)).rejects.toThrow();
    await expect(move(seed, custodyId, "RETURNED", -1)).rejects.toThrow();
    await expect(move(seed, custodyId, "RETURNED", jod(1), { occurredAt: Number.NaN })).rejects.toThrow(/real timestamp/);
    await expect(move(seed, custodyId, "RETURNED", jod(1), { occurredAt: -5 })).rejects.toThrow(/real timestamp/);
    await expect(openCustody(seed, jod(1), { occurredAt: 1.5 })).rejects.toThrow(/real timestamp/);
    await expect(employeeFee(seed, custodyId, jod(1), { paidAt: Number.NaN })).rejects.toThrow(/real timestamp/);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
        orgId: seed.orgId, feeId: await employeeFee(seed, undefined, jod(1)), actualAmountMinor: jod(2), expectedCurrency: "JOD", paidAt: Number.POSITIVE_INFINITY,
      })
    ).rejects.toThrow(/real timestamp/);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.planCustodyHandler, { orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.employeeId, amountMinor: Number.NaN })
    ).rejects.toThrow();
    // Only the one issuance is on the record.
    expect(await entries(seed, custodyId)).toHaveLength(1);
    expect(await events(seed)).toHaveLength(1);
    const commands = await seed.t.run((ctx) => ctx.db.query("commandIdempotency").collect());
    expect(commands.filter((c) => c.operation === "financeDealCosts.recordCustodyMovement")).toEqual([]);
  });

  test("a movement in a currency other than the deal's is refused", async () => {
    const seed = await seedDeal("currency");
    const custodyId = await openCustody(seed, jod(700));
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordDealFee, {
        expectedCurrency: "USD", idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId,
        feeType: "LICENSING", paidBy: "EMPLOYEE", paidTo: "GOVERNMENT", accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
        actualAmountMinor: 5000, custodyId,
      })
    ).rejects.toThrow(/kept in JOD/);
    expect(await events(seed, "CUSTODY_FEE_PAID")).toHaveLength(0);
  });
});

describe("periods: a closed month is never rewritten (ACC-2)", () => {
  async function closeSeededPeriod(seed: Seed) {
    await seed.t.run((ctx) => ctx.db.patch(seed.periodId, { status: "CLOSED", closedAt: Date.now(), closedBy: seed.userId }));
  }

  test("a movement dated into a closed period queues to the outbox — nothing posts, nothing is silently dropped", async () => {
    const seed = await seedDeal("closed-issue");
    await closeSeededPeriod(seed);
    const custodyId = await openCustody(seed, jod(700), { occurredAt: Date.now() - 2 * DAY });
    expect(await events(seed)).toHaveLength(0);
    const queued = await pending(seed);
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe("POST");
    expect(queued[0].status).toBe("PENDING");
    expect(queued[0].idempotencyKey).toMatch(/^custody_entry_/);
    // Reversing that queued movement cancels the queued post: net nothing.
    const [issued] = await entries(seed, custodyId);
    await reverse(seed, custodyId, issued._id, jod(700));
    const after = await pending(seed);
    expect(after.filter((r) => r.status === "PENDING")).toEqual([]);
    expect(await events(seed)).toHaveLength(0);
  });

  test("a correction after the period closes posts in the OPEN period and leaves the closed journal untouched", async () => {
    const seed = await seedDeal("closed-correction");
    // Two periods: an earlier one that will close, and the current one.
    const boundary = Date.now() - 30 * DAY;
    const earlierId = await seed.t.run(async (ctx) => {
      await ctx.db.patch(seed.periodId, { startDate: boundary, periodNumber: 2 });
      return await ctx.db.insert("accountingPeriods", {
        orgId: seed.orgId, startDate: boundary - 400 * DAY, endDate: boundary - 1,
        fiscalYear: new Date().getUTCFullYear(), periodNumber: 1, status: "OPEN", createdAt: Date.now(),
      });
    });
    const paidAt = boundary - 5 * DAY;
    const custodyId = await openCustody(seed, jod(700), { occurredAt: paidAt });
    const feeId = await employeeFee(seed, custodyId, jod(650), { paidAt });
    const earlierEntriesBefore = await seed.t.run(async (ctx) =>
      (await ctx.db.query("journalEntries").withIndex("by_org_period", (q) => q.eq("orgId", seed.orgId).eq("periodId", earlierId)).collect())
    );
    expect(earlierEntriesBefore).toHaveLength(2);
    await seed.t.run((ctx) => ctx.db.patch(earlierId, { status: "CLOSED", closedAt: Date.now(), closedBy: seed.userId }));

    // The correction: the receipt really said 700.
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, {
      orgId: seed.orgId, feeId, actualAmountMinor: jod(700), expectedCurrency: "JOD",
    });
    const earlierEntriesAfter = await seed.t.run(async (ctx) =>
      (await ctx.db.query("journalEntries").withIndex("by_org_period", (q) => q.eq("orgId", seed.orgId).eq("periodId", earlierId)).collect())
    );
    // Same two entries in the closed month: the original is marked REVERSED
    // (status only — its lines are not rewritten), nothing new landed there.
    expect(earlierEntriesAfter.map((e) => e._id).sort()).toEqual(earlierEntriesBefore.map((e) => e._id).sort());
    expect(earlierEntriesAfter.map((e) => e.status).sort()).toEqual(["POSTED", "REVERSED"]);
    // The reversal is dated NOW, in the open period.
    const reversal = (await events(seed, "JOURNAL_REVERSAL"))[0];
    expect(reversal.accountingDate).toBeGreaterThanOrEqual(boundary);
    const reversalEntry = await seed.t.run((ctx) => ctx.db.get(reversal.journalEntryId!));
    expect(reversalEntry?.periodId).toBe(seed.periodId);
    // The re-post keeps the receipt's own date, which is closed: it waits.
    const queued = (await pending(seed)).filter((r) => r.status === "PENDING");
    expect(queued).toHaveLength(1);
    expect(queued[0].idempotencyKey).toBe(`custody_fee_paid_${feeId}_v2`);
    expect(queued[0].accountingDate).toBe(paidAt);
    // What the books say right now: the old 650 backed out, the 700 not yet in.
    const l = await ledger(seed);
    expect(transferExpense(l)).toBe(0);
    expect(clearing(l)).toBe(jod(700));
  });
});

describe("un-happening the deal itself", () => {
  test("cancellation is refused while custody is open, allowed once settled, and the paid expense stays on the books", async () => {
    const seed = await seedDeal("cancel");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(700));
    await expect(
      seed.asUser.mutation(api.applications.cancelApplication, { orgId: seed.orgId, applicationId: seed.applicationId, idempotencyKey: "c1" })
    ).rejects.toThrow(/still holds cash custody/);
    expect((await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))?.status).toBe("APPROVED");

    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "Receipt matches." });
    await seed.asUser.mutation(api.applications.cancelApplication, { orgId: seed.orgId, applicationId: seed.applicationId, idempotencyKey: "c2" });
    expect((await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))?.status).toBe("CANCELLED");
    const l = await ledger(seed);
    expect(transferExpense(l)).toBe(jod(700));
    expect(cash(l)).toBe(-jod(700));
    expect((await events(seed, "CUSTODY_FEE_PAID"))[0].status).toBe("POSTED");
  });

  test("after finalization every posting-bearing edit is refused, settling existing custody is not (Sol H2)", async () => {
    const seed = await seedDeal("frozen");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(650));
    const otherFee = await employeeFee(seed, undefined, jod(10));
    const saleId = await seed.t.run(async (ctx) => {
      const app = await ctx.db.get(seed.applicationId);
      return await ctx.db.insert("sales", {
        orgId: seed.orgId, vehicleId: seed.vehicleId, customerId: app!.customerId,
        salespersonId: seed.userId, salePrice: 10_500, saleDate: Date.now(), status: "COMPLETED",
      } as never);
    });
    await seed.t.run((ctx) => ctx.db.patch(seed.applicationId, { status: "CLOSED", finalizedSaleId: saleId }));
    expect((await readCosts(seed)).economicsFrozen).toEqual({ frozen: true, reason: "SALE_FINALIZED" });

    const frozen = /finalized/;
    await expect(employeeFee(seed, custodyId, jod(1))).rejects.toThrow(frozen);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordTemplateFeeActual, {
        orgId: seed.orgId, applicationId: seed.applicationId, templateIndex: 0, feeType: "LICENSING",
        actualAmountMinor: jod(90), expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(frozen);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(700), expectedCurrency: "JOD" })
    ).rejects.toThrow(frozen);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(650), expectedCurrency: "JOD", paidAt: Date.now() - DAY })
    ).rejects.toThrow(frozen);
    await expect(seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "x" })).rejects.toThrow(frozen);
    await expect(seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId: otherFee, custodyId })).rejects.toThrow(frozen);
    await expect(seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId })).rejects.toThrow(frozen);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
        orgId: seed.orgId, applicationId: seed.applicationId, legalInvoiceAmountMinor: jod(10_500),
        legalInvoiceNumber: "INV", legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY",
      })
    ).rejects.toThrow(frozen);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
        idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.viewerId, issuedMinor: jod(1),
      })
    ).rejects.toThrow(frozen);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.planCustodyHandler, { orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.employeeId })
    ).rejects.toThrow(/closed or stopped/);
    // More cash against the EXISTING open record is new cash too (Sonnet
    // F1-CUSTODY-FREEZE-BYPASS): refused, and nothing posts.
    await expect(move(seed, custodyId, "ISSUED", jod(500))).rejects.toThrow(frozen);
    expect(await events(seed, "CUSTODY_CASH_ISSUED")).toHaveLength(1);
    expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))?.issuedMinor).toBe(jod(700));
    expect(await events(seed, "CUSTODY_FEE_PAID")).toHaveLength(1);

    // Settling what already exists is still possible: return the 50, reconcile.
    await move(seed, custodyId, "RETURNED", jod(50));
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "Settled after close." });
    expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))?.status).toBe("RECONCILED");
    expect(clearing(await ledger(seed))).toBe(0);
  });
});

describe("Codex round 1 (7c21d6008): the boundaries a direct caller could walk around", () => {
  test("AF-CUST-02: a reimbursement pays exactly what is owed — nothing owed, or more than owed, is refused before any write", async () => {
    const seed = await seedDeal("reimb-bound");
    const custodyId = await openCustody(seed, jod(700));
    await expect(move(seed, custodyId, "REIMBURSED", jod(10))).rejects.toThrow(/Nothing is owed/);
    await employeeFee(seed, custodyId, jod(750));
    await expect(move(seed, custodyId, "REIMBURSED", jod(51))).rejects.toThrow(/against 50000 owed/);
    expect((await entries(seed, custodyId)).filter((e) => e.kind === "REIMBURSED")).toEqual([]);
    expect(await events(seed, "CUSTODY_REIMBURSED")).toHaveLength(0);
    // A partial, then the rest.
    await move(seed, custodyId, "REIMBURSED", jod(20));
    await move(seed, custodyId, "REIMBURSED", jod(30));
    expect(clearing(await ledger(seed))).toBe(0);
    await expect(move(seed, custodyId, "REIMBURSED", jod(1))).rejects.toThrow(/Nothing is owed/);
  });

  test("AF-CUST-04: cost-entry authority cannot post, re-post or reverse a custody journal; custody authority can", async () => {
    const seed = await seedDeal("authority");
    const custodyId = await openCustody(seed, jod(700));
    await seed.t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "cu_sales_authority", email: "s@x.com", name: "Sales" });
      const roleId = await ctx.db.insert("roles", {
        orgId: seed.orgId, name: "SALES",
        permissions: [PERMISSIONS.VIEW_FINANCE_APPLICATIONS, PERMISSIONS.CREATE_FINANCE_APPLICATION],
      });
      await ctx.db.insert("memberships", { orgId: seed.orgId, userId, roleId });
      return userId;
    });
    const asSales = seed.t.withIdentity({ subject: "cu_sales_authority" });
    const line = (extra: Record<string, unknown>) => ({
      expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId,
      feeType: "LICENSING" as const, paidBy: "EMPLOYEE" as const, paidTo: "GOVERNMENT" as const,
      accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE" as const, actualAmountMinor: jod(50), ...extra,
    });
    // Ordinary cost entry still works for SALES...
    const plainFee = await asSales.mutation(api.financeDealCosts.recordDealFee, line({}));
    expect(plainFee).toBeTruthy();
    // ...but nothing that touches custody.
    await expect(asSales.mutation(api.financeDealCosts.recordDealFee, line({ custodyId }))).rejects.toThrow(/confirm finance disbursements/);
    await expect(
      asSales.mutation(api.financeDealCosts.recordTemplateFeeActual, {
        orgId: seed.orgId, applicationId: seed.applicationId, templateIndex: 0, feeType: "LICENSING",
        actualAmountMinor: jod(90), expectedCurrency: "JOD", custodyId, idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/confirm finance disbursements/);
    await expect(
      asSales.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId: plainFee, actualAmountMinor: jod(60), expectedCurrency: "JOD", custodyId })
    ).rejects.toThrow(/confirm finance disbursements/);
    const charged = await employeeFee(seed, custodyId, jod(100));
    await expect(
      asSales.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId: charged, actualAmountMinor: jod(120), expectedCurrency: "JOD" })
    ).rejects.toThrow(/confirm finance disbursements/);
    await expect(asSales.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId: charged, reason: "x" })).rejects.toThrow(/confirm finance disbursements/);
    await expect(asSales.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId: plainFee, custodyId })).rejects.toThrow();
    expect(await events(seed, "CUSTODY_FEE_PAID")).toHaveLength(1);
    expect((await events(seed, "CUSTODY_FEE_PAID"))[0].status).toBe("POSTED");
    // SALES can still void its own plain line.
    await asSales.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId: plainFee, reason: "typo" });
  });

  test("AF-CUST-05: the plan is served at the disbursement tier only; an application viewer is told it is withheld, not that there is none", async () => {
    const seed = await seedDeal("plan-tier");
    await seed.asUser.mutation(api.financeDealCosts.planCustodyHandler, {
      orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.employeeId, amountMinor: jod(100), note: "Monday",
    });
    const viewer = await seed.asViewer.query(api.financeDealCosts.listDealCosts, { orgId: seed.orgId, applicationId: seed.applicationId });
    expect(viewer.plannedCustody).toBeNull();
    expect(viewer.plannedCustodyWithheld).toBe(true);
    expect(JSON.stringify(viewer)).not.toContain("Monday");
    expect(JSON.stringify(viewer)).not.toContain(String(seed.employeeId));
    const owner = await readCosts(seed);
    expect(owner.plannedCustodyWithheld).toBe(false);
    expect(owner.plannedCustody?.amountMinor).toBe(jod(100));
  });

  test("AF-CUST-06: an issuance or a custody-charged line replays its stored success even after the recipient offboards or the deal freezes", async () => {
    const seed = await seedDeal("replay-mutable");
    const openKey = "open-mutable";
    const custodyId = await openCustody(seed, jod(700), { idempotencyKey: openKey });
    const feeKey = "fee-mutable";
    const feeId = await employeeFee(seed, custodyId, jod(100), { idempotencyKey: feeKey });
    // The world moves on: the recipient starts offboarding and the deal finalizes.
    await seed.t.run(async (ctx) => {
      const membership = (await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", seed.orgId)).collect()).find((m) => m.userId === seed.employeeId)!;
      await ctx.db.patch(membership._id, { offboardingStatus: "PENDING_EXTERNAL_REMOVAL" });
      const app = await ctx.db.get(seed.applicationId);
      const saleId = await ctx.db.insert("sales", {
        orgId: seed.orgId, vehicleId: seed.vehicleId, customerId: app!.customerId,
        salespersonId: seed.userId, salePrice: 10_500, saleDate: Date.now(), status: "COMPLETED",
      } as never);
      await ctx.db.patch(seed.applicationId, { status: "CLOSED", finalizedSaleId: saleId });
    });
    await expect(openCustody(seed, jod(700), { idempotencyKey: openKey })).resolves.toBe(custodyId);
    await expect(employeeFee(seed, custodyId, jod(100), { idempotencyKey: feeKey })).resolves.toBe(feeId);
    expect(await events(seed, "CUSTODY_CASH_ISSUED")).toHaveLength(1);
    expect(await events(seed, "CUSTODY_FEE_PAID")).toHaveLength(1);
    // A NEW intent is still refused under the new state.
    await expect(openCustody(seed, jod(700))).rejects.toThrow();
    await expect(employeeFee(seed, custodyId, jod(100))).rejects.toThrow(/finalized/);
  });

  test("AF-CUST-07: a custody record from before ledger posting refuses every money command and is reported as legacy", async () => {
    const seed = await seedDeal("legacy");
    const legacyId = await seed.t.run(async (ctx) => {
      const custodyId = await ctx.db.insert("financeDealCustody", {
        orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.employeeId, currency: "JOD",
        issuedMinor: jod(700), returnedMinor: 0, reimbursedMinor: 0, status: "OPEN",
        createdBy: seed.userId, createdAt: Date.now(), updatedAt: Date.now(),
      });
      await ctx.db.insert("financeDealCustodyEntries", {
        orgId: seed.orgId, custodyId, kind: "ISSUED", amountMinor: jod(700), occurredAt: Date.now(), recordedBy: seed.userId, recordedAt: Date.now(),
      });
      return custodyId;
    });
    const costs = await readCosts(seed);
    expect(costs.custody[0].legacy).toBe(true);
    const legacyRefusal = /predates ledger posting/;
    await expect(move(seed, legacyId, "RETURNED", jod(100))).rejects.toThrow(legacyRefusal);
    await expect(move(seed, legacyId, "ISSUED", jod(100))).rejects.toThrow(legacyRefusal);
    await expect(employeeFee(seed, legacyId, jod(50))).rejects.toThrow(legacyRefusal);
    const plain = await employeeFee(seed, undefined, jod(50));
    await expect(seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId: plain, custodyId: legacyId })).rejects.toThrow(legacyRefusal);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId: legacyId, notes: "short", writeOffReason: "lost" })
    ).rejects.toThrow(legacyRefusal);
    expect(await events(seed)).toHaveLength(0);
    expect(await pending(seed)).toHaveLength(0);
    // A record opened by the product carries the marker and is not legacy
    // (for another member — the legacy record already holds this one's).
    const fresh = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.viewerId, issuedMinor: jod(10), method: "CASH",
    });
    expect((await seed.t.run((ctx) => ctx.db.get(fresh)))?.ledgerPosting).toBe("CANONICAL");
    expect((await readCosts(seed)).custody.find((r) => r._id === fresh)?.legacy).toBe(false);
  });
});

describe("the employee's shortfall is a liability, never a credit on the asset (Codex AF-CUST-01)", () => {
  test("the split follows the position whatever order cash and receipts arrive, and reversals restore it", async () => {
    // Order A: issue 50, then a 100 receipt.
    const a = await seedDeal("payable-a");
    const custodyA = await openCustody(a, jod(50));
    const feeA = await employeeFee(a, custodyA, jod(100));
    let l = await ledger(a);
    expect(clearing(l)).toBe(0);
    expect(payable(l)).toBe(-jod(50));
    expect(transferExpense(l)).toBe(jod(100));
    // The primary journals are untouched; the split is its own delta event.
    expect(await events(a, "CUSTODY_PAYABLE_RECLASSIFIED")).toHaveLength(1);
    // More cash than the shortfall: the liability is released, the asset carries the rest.
    await move(a, custodyA, "ISSUED", jod(80));
    l = await ledger(a);
    expect(clearing(l)).toBe(jod(30));
    expect(payable(l)).toBe(0);
    // Reverse the top-up: back to a 50 payable — by a NEW delta, never by
    // touching the reclass that came before.
    const topUp = (await entries(a, custodyA)).find((e) => e.kind === "ISSUED" && e.amountMinor === jod(80))!;
    await reverse(a, custodyA, topUp._id, jod(80));
    l = await ledger(a);
    expect(clearing(l)).toBe(0);
    expect(payable(l)).toBe(-jod(50));
    const reclass = await events(a, "CUSTODY_PAYABLE_RECLASSIFIED");
    expect(reclass.map((e) => e.status)).toEqual(["POSTED", "POSTED", "POSTED"]);
    // Void the receipt: no shortfall at all, the 50 is back in the employee's hands.
    await a.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: a.orgId, feeId: feeA, reason: "wrong deal" });
    l = await ledger(a);
    expect(clearing(l)).toBe(jod(50));
    expect(payable(l)).toBe(0);
    expect(transferExpense(l)).toBe(0);

    // Order B: issue 50, receipt 100, then a further 20 — a partial cover.
    const b = await seedDeal("payable-b");
    const custodyB = await openCustody(b, jod(50));
    await employeeFee(b, custodyB, jod(100));
    await move(b, custodyB, "ISSUED", jod(20));
    l = await ledger(b);
    expect(clearing(l)).toBe(0);
    expect(payable(l)).toBe(-jod(30));
    expect((await readCosts(b)).custody[0].summary!.reimbursementOutstandingMinor).toBe(jod(30));
    await move(b, custodyB, "REIMBURSED", jod(30));
    l = await ledger(b);
    expect(payable(l)).toBe(0);
    expect(clearing(l)).toBe(0);
    await b.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(), orgId: b.orgId, custodyId: custodyB, notes: "Receipts checked." });
    expect((await b.t.run((ctx) => ctx.db.get(custodyB)))?.status).toBe("RECONCILED");
  });

  test("two employees never net against each other: one holds cash, the other is owed, both gross", async () => {
    const seed = await seedDeal("payable-two");
    const first = await openCustody(seed, jod(1000));
    const second = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.viewerId, issuedMinor: jod(100), method: "CASH",
    });
    await employeeFee(seed, second, jod(1000));
    const l = await ledger(seed);
    expect(clearing(l)).toBe(jod(1000));
    expect(payable(l)).toBe(-jod(900));
    const rows = (await readCosts(seed)).custody;
    expect(rows.find((r) => r._id === first)?.summary?.employeeOwesDealerMinor).toBe(jod(1000));
    expect(rows.find((r) => r._id === second)?.summary?.reimbursementOutstandingMinor).toBe(jod(900));
  });

  test("a written-off record leaves zero in BOTH accounts", async () => {
    const seed = await seedDeal("payable-zero");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(650));
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(),
      orgId: seed.orgId, custodyId, notes: "Short.", writeOffReason: "Untraceable 50",
    });
    const l = await ledger(seed);
    expect(clearing(l)).toBe(0);
    expect(payable(l)).toBe(0);
    expect(l[SYSTEM_KEYS.CASH_OVER_SHORT]).toBe(jod(50));
  });
});

describe("the custodian never moves or closes their own custody", () => {
  test("the holder is refused on every movement kind and on closure; the issuer is refused as recipient", async () => {
    const seed = await seedDeal("self");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(750));
    // The employee holds the money AND the money permission (owner role in this seed).
    const asHolder = seed.t.withIdentity({ subject: "cu_emp_self" });
    const holderMove = (kind: "ISSUED" | "RETURNED" | "REIMBURSED") =>
      asHolder.mutation(api.financeDealCosts.recordCustodyMovement, { orgId: seed.orgId, custodyId, kind, amountMinor: jod(10), idempotencyKey: crypto.randomUUID() });
    const refusal = /somebody other than the person holding the cash/;
    await expect(holderMove("ISSUED")).rejects.toThrow(refusal);
    await expect(holderMove("REIMBURSED")).rejects.toThrow(refusal);
    await expect(holderMove("RETURNED")).rejects.toThrow(refusal);
    const [issued] = await entries(seed, custodyId);
    await expect(
      asHolder.mutation(api.financeDealCosts.recordCustodyMovement, { orgId: seed.orgId, custodyId, kind: "REVERSAL", reversesEntryId: issued._id, amountMinor: jod(700), idempotencyKey: crypto.randomUUID() })
    ).rejects.toThrow(refusal);
    await expect(
      asHolder.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "mine", writeOffReason: "mine" })
    ).rejects.toThrow(refusal);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
        idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.userId, issuedMinor: jod(1),
      })
    ).rejects.toThrow(/somebody other than the person receiving/);
    expect(await entries(seed, custodyId)).toHaveLength(1);
  });
});

describe("tenancy and permission-shaped reads (TEN-1, ACC-10)", () => {
  test("another organization's custody, fee or entry ids are 'not found'", async () => {
    const seed = await seedDeal("tenant");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(50));
    const [issued] = await entries(seed, custodyId);
    const asOther = seed.t.withIdentity({ subject: "cu_other" });
    await seed.t.run(async (ctx) => {
      const otherUser = await ctx.db.insert("users", { clerkId: "cu_other", email: "o@x.com", name: "Other" });
      const role = await ctx.db.insert("roles", { orgId: seed.otherOrgId, name: "OWNER", permissions: ALL_PERMISSIONS, isSystemOwnerRole: true });
      await ctx.db.insert("memberships", { orgId: seed.otherOrgId, userId: otherUser, roleId: role });
    });
    await expect(
      asOther.mutation(api.financeDealCosts.recordCustodyMovement, { orgId: seed.otherOrgId, custodyId, kind: "RETURNED", amountMinor: jod(1), idempotencyKey: "x1" })
    ).rejects.toThrow(/not found/);
    await expect(
      asOther.mutation(api.financeDealCosts.recordCustodyMovement, { orgId: seed.otherOrgId, custodyId, kind: "REVERSAL", reversesEntryId: issued._id, amountMinor: jod(700), idempotencyKey: "x2" })
    ).rejects.toThrow(/not found/);
    await expect(asOther.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.otherOrgId, feeId, custodyId })).rejects.toThrow(/not found/);
    await expect(asOther.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(), orgId: seed.otherOrgId, custodyId, notes: "n" })).rejects.toThrow(/not found/);
    await expect(
      asOther.mutation(api.financeDealCosts.planCustodyHandler, { orgId: seed.otherOrgId, applicationId: seed.applicationId, userId: seed.employeeId })
    ).rejects.toThrow(/not found/);
    expect(await events(seed)).toHaveLength(2);
  });

  test("a viewer reads the record but never an address; the disbursement permission is required to move money or plan", async () => {
    const seed = await seedDeal("perm");
    const custodyId = await openCustody(seed, jod(700));
    const costs = await seed.asViewer.query(api.financeDealCosts.listDealCosts, { orgId: seed.orgId, applicationId: seed.applicationId });
    expect(costs.custody[0].userName).toBe("");
    expect(JSON.stringify(costs)).not.toContain("secret.perm@x.com");
    const log = await seed.asViewer.query(api.financeDealCosts.listCustodyMovements, { orgId: seed.orgId, custodyId, paginationOpts: { numItems: 10, cursor: null } });
    expect(JSON.stringify(log)).not.toContain("@x.com");
    await expect(
      seed.asViewer.mutation(api.financeDealCosts.recordCustodyMovement, { orgId: seed.orgId, custodyId, kind: "RETURNED", amountMinor: jod(1), idempotencyKey: "v1" })
    ).rejects.toThrow();
    await expect(
      seed.asViewer.mutation(api.financeDealCosts.planCustodyHandler, { orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.employeeId })
    ).rejects.toThrow();
    await expect(
      seed.asViewer.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId: await employeeFee(seed, undefined, jod(1)), custodyId })
    ).rejects.toThrow();
  });
});

describe("who may be handed the cash (frozen-candidate finding 3)", () => {
  test("the candidate list marks the caller, so the issuance picker can withhold the one recipient the server refuses; the plan may still name them", async () => {
    const seed = await seedDeal("candidates-actor");
    const { candidates } = await seed.asUser.query(api.financeDealCosts.listCustodyCandidates, { orgId: seed.orgId });
    const byId = new Map(candidates.map((c) => [c.userId, c]));
    expect(byId.get(seed.userId)?.isActor).toBe(true);
    expect(byId.get(seed.employeeId)?.isActor).toBe(false);
    expect(byId.get(seed.viewerId)?.isActor).toBe(false);
    // The server's own line, which the marker mirrors: self-issuance refused; self-planning allowed.
    await expect(
      seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
        idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId,
        userId: seed.userId, issuedMinor: jod(100), method: "CASH",
      })
    ).rejects.toThrow(/somebody other than the person receiving it/);
    await seed.asUser.mutation(api.financeDealCosts.planCustodyHandler, { orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.userId, amountMinor: jod(100) });
    expect((await readCosts(seed)).plannedCustody?.userId).toBe(seed.userId);
    // Another operator asking sees the marker move with them.
    const asEmployee = seed.t.withIdentity({ subject: `cu_emp_candidates-actor` });
    const theirs = await asEmployee.query(api.financeDealCosts.listCustodyCandidates, { orgId: seed.orgId });
    expect(theirs.candidates.find((c) => c.userId === seed.employeeId)?.isActor).toBe(true);
    expect(theirs.candidates.find((c) => c.userId === seed.userId)?.isActor).toBe(false);
  });
});

describe("planned versus actual", () => {
  test("the plan names a person before any cash moves, the recommendation follows the employee-paid policy, and the plan is frozen once custody is open", async () => {
    const seed = await seedDeal("plan");
    let costs = await readCosts(seed);
    expect(costs.plannedCustody).toBeNull();
    expect(costs.recommendedCustody).toEqual({ recommendedMinor: jod(90), reason: null, outstandingCount: 1 });

    await seed.asUser.mutation(api.financeDealCosts.planCustodyHandler, {
      orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.employeeId, amountMinor: jod(100), note: "Licensing run on Monday",
    });
    costs = await readCosts(seed);
    expect(costs.plannedCustody?.userId).toBe(seed.employeeId);
    expect(costs.plannedCustody?.userName).toBe("");
    expect(costs.plannedCustody?.amountMinor).toBe(jod(100));
    expect(costs.custody).toEqual([]);
    expect(await events(seed)).toHaveLength(0);

    // Not a member → refused; a non-positive amount → refused.
    await expect(
      seed.asUser.mutation(api.financeDealCosts.planCustodyHandler, { orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.viewerId, amountMinor: 0 })
    ).rejects.toThrow(/greater than zero/);
    const stranger = await seed.t.run((ctx) => ctx.db.insert("users", { clerkId: "cu_stranger", email: "s@x.com" }));
    await expect(
      seed.asUser.mutation(api.financeDealCosts.planCustodyHandler, { orgId: seed.orgId, applicationId: seed.applicationId, userId: stranger })
    ).rejects.toThrow(/not a member/);

    const custodyId = await openCustody(seed, jod(100));
    await expect(
      seed.asUser.mutation(api.financeDealCosts.planCustodyHandler, { orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.userId })
    ).rejects.toThrow(/already in an employee's custody/);

    // Recording the configured fee's actual from custody empties the recommendation.
    await seed.asUser.mutation(api.financeDealCosts.recordTemplateFeeActual, {
      orgId: seed.orgId, applicationId: seed.applicationId, templateIndex: 0, feeType: "LICENSING",
      actualAmountMinor: jod(95), expectedCurrency: "JOD", custodyId, idempotencyKey: crypto.randomUUID(),
    });
    costs = await readCosts(seed);
    expect(costs.recommendedCustody).toEqual({ recommendedMinor: 0, reason: null, outstandingCount: 0 });
    expect(transferExpense(await ledger(seed))).toBe(jod(95));
    expect(costs.custody[0].summary?.reimbursementOutstandingMinor).toBe(0);
    expect(costs.custody[0].summary?.employeeOwesDealerMinor).toBe(jod(5));

    // Withdrawing the plan is audited.
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "5 returned in coins.", writeOffReason: "coins" });
    await seed.asUser.mutation(api.financeDealCosts.planCustodyHandler, { orgId: seed.orgId, applicationId: seed.applicationId });
    expect((await readCosts(seed)).plannedCustody).toBeNull();
    const overrides = await seed.t.run((ctx) =>
      ctx.db.query("financeApplicationOverrides").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).collect()
    );
    expect(overrides.filter((o) => o.field === "plannedCustody")).toHaveLength(2);
  });

  test("the recommendation is withheld, never partial, when nothing is configured or an estimate is unreadable", () => {
    const ROW = { paidBy: "EMPLOYEE" as const, deductedFromSettlement: false, accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE" as const };
    expect(deriveRecommendedCustody({ source: "NO_SNAPSHOT", rows: [] })).toEqual({ recommendedMinor: null, reason: "NOT_CONFIGURED", outstandingCount: 0 });
    expect(
      deriveRecommendedCustody({ source: "COMPANY_RULE_SNAPSHOT", rows: [{ ...ROW, paidBy: "DEALER", expectedAmountMinor: 5, actual: null }] })
    ).toEqual({ recommendedMinor: null, reason: "NO_EMPLOYEE_PAID_FEES", outstandingCount: 0 });
    expect(
      deriveRecommendedCustody({
        source: "COMPANY_RULE_SNAPSHOT",
        rows: [
          { ...ROW, expectedAmountMinor: 5, actual: null },
          { ...ROW, expectedAmountMinor: null, actual: null },
        ],
      })
    ).toEqual({ recommendedMinor: null, reason: "UNSAFE_AMOUNT", outstandingCount: 2 });
    expect(
      deriveRecommendedCustody({
        source: "COMPANY_RULE_SNAPSHOT",
        rows: [
          { ...ROW, expectedAmountMinor: 5, actual: null },
          { ...ROW, expectedAmountMinor: null, actual: { feeId: "x" as never, actualAmountMinor: 1, currency: "JOD", status: "RECORDED" as never } },
          // Withheld from the remittance, or not custody-postable: never recommended cash.
          { ...ROW, deductedFromSettlement: true, expectedAmountMinor: 500, actual: null },
          { ...ROW, accountingTreatment: "CAPITALIZED_TO_VEHICLE" as never, expectedAmountMinor: 500, actual: null },
        ],
      })
    ).toEqual({ recommendedMinor: 5, reason: null, outstandingCount: 1 });
  });
});

// ---------------------------------------------------------------------------
// Final review round on 3700559f6 (PR #316): A–F
// ---------------------------------------------------------------------------

/** Two periods: an earlier one (closed by the caller when needed) and the current one. */
async function splitPeriods(seed: Seed): Promise<{ earlierId: Id<"accountingPeriods">; boundary: number }> {
  const boundary = Date.now() - 30 * DAY;
  const earlierId = await seed.t.run(async (ctx) => {
    await ctx.db.patch(seed.periodId, { startDate: boundary, periodNumber: 2 });
    return await ctx.db.insert("accountingPeriods", {
      orgId: seed.orgId, startDate: boundary - 400 * DAY, endDate: boundary - 1,
      fiscalYear: new Date().getUTCFullYear(), periodNumber: 1, status: "OPEN", createdAt: Date.now(),
    });
  });
  return { earlierId, boundary };
}

/** Runs the scheduler chain to a fixed point (mirrors accountingOutboxAtomicity's `pump`). */
async function pump(t: TestConvex) {
  for (let pass = 0; pass < 10; pass += 1) {
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const queued = (await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect())).filter(
      (f) => f.state.kind === "pending" || f.state.kind === "inProgress"
    ).length;
    if (queued === 0) break;
  }
}

/**
 * ONE real outbox attempt per due row — dispatch, claim, worker, observer —
 * exactly as the cron would drive it. Held and backed-off rows are made due
 * again first, standing in for the minute the cron would otherwise wait.
 */
async function drainOnce(seed: Seed) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  try {
    await seed.t.run(async (ctx) => {
      const rows = (await ctx.db.query("pendingAccountingEvents").withIndex("by_org_status", (q) => q.eq("orgId", seed.orgId).eq("status", "PENDING")).take(50));
      for (const row of rows) if (row.dispatchState === undefined) await ctx.db.patch(row._id, { nextActionAt: undefined });
      return await drainEntries(ctx, await ctx.db.query("pendingAccountingEvents").withIndex("by_org_status", (q) => q.eq("orgId", seed.orgId).eq("status", "PENDING")).take(50));
    });
    await pump(seed.t);
    const claimed = await seed.t.run(async (ctx) =>
      (await ctx.db.query("pendingAccountingEvents").withIndex("by_org_status", (q) => q.eq("orgId", seed.orgId).eq("status", "PENDING")).take(50))
        .filter((r) => r.dispatchState === "DISPATCHED")
        .map((r) => r._id)
    );
    for (const rowId of claimed) await seed.t.mutation(internal.accountingOutbox.observeOutboxAttempt, { rowId });
    await pump(seed.t);
  } finally {
    vi.useRealTimers();
  }
}

/** Debit-positive movement per system key inside ONE period, read from the period's balance snapshots — the consumer's view (ACC-2). */
async function snapshotByKey(seed: Seed, periodId: Id<"accountingPeriods">): Promise<Record<string, number>> {
  return await seed.t.run(async (ctx) => {
    const keyByAccount = new Map<string, string>();
    for (const a of (await ctx.db.query("chartOfAccounts").collect()).filter((a) => a.orgId === seed.orgId)) {
      if (a.systemKey) keyByAccount.set(a._id, a.systemKey);
    }
    const totals: Record<string, number> = {};
    for (const s of await ctx.db.query("accountBalanceSnapshots").withIndex("by_org_period", (q) => q.eq("orgId", seed.orgId).eq("periodId", periodId)).collect()) {
      const key = keyByAccount.get(s.accountId);
      if (key) totals[key] = (totals[key] ?? 0) + s.runningDebitMinor - s.runningCreditMinor;
    }
    return totals;
  });
}

async function commandRows(seed: Seed, operation: string) {
  return await seed.t.run(async (ctx) =>
    (await ctx.db.query("commandIdempotency").collect()).filter((c) => c.orgId === seed.orgId && c.operation === operation)
  );
}

describe("A — the payable reclassification chain posts in order across a closed month", () => {
  test("an open-period release is queued behind its closed-period recognition, and the books never carry a debit on the payable", async () => {
    const seed = await seedDeal("chain");
    const { earlierId, boundary } = await splitPeriods(seed);
    // The earlier month closes BEFORE the receipt from it is recorded.
    await seed.t.run((ctx) => ctx.db.patch(earlierId, { status: "CLOSED", closedAt: Date.now(), closedBy: seed.userId }));
    const custodyId = await openCustody(seed, jod(700));
    const paidAt = boundary - 5 * DAY;
    const feeId = await employeeFee(seed, custodyId, jod(900), { paidAt });
    // The receipt and the 200 it puts the employee out of pocket by are
    // dated into the closed month: both wait. Nothing about the payable is
    // on the books yet.
    const queued = (await pending(seed)).filter((r) => r.status === "PENDING").map((r) => r.idempotencyKey).sort();
    expect(queued).toEqual([`custody_fee_paid_${feeId}_v1`, `custody_payable_reclass_${custodyId}_v1`].sort());
    expect(payable(await ledger(seed))).toBe(0);
    let row = (await readCosts(seed)).custody.find((r) => r._id === custodyId)!;
    expect(row.payableTargetMinor).toBe(jod(200));
    expect(row.payableAwaitingPost).toBe(true);

    // The dealership reimburses the 200 today. The cash leg posts now; the
    // release of the payable (v2, a DEBIT) does NOT — its credit (v1) is not
    // on the books, so it is queued behind it with the reason on the row.
    await move(seed, custodyId, "REIMBURSED", jod(200));
    expect(await events(seed, "CUSTODY_REIMBURSED")).toHaveLength(1);
    expect(await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).toHaveLength(0);
    const v2 = (await pending(seed)).find((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v2`);
    expect(v2?.status).toBe("PENDING");
    expect(v2?.reason).toMatch(/custody payable reclassification v1/);
    let l = await ledger(seed);
    expect(payable(l)).toBe(0);
    expect(clearing(l)).toBe(jod(900));
    row = (await readCosts(seed)).custody.find((r) => r._id === custodyId)!;
    expect(row.payableTargetMinor).toBe(0);
    expect(row.payableAwaitingPost).toBe(true);

    // The real outbox worker, one attempt per row: the closed-month rows
    // cannot post, and v2 is HELD by the dependency guard — no attempt
    // burned, the reason recorded — rather than posted ahead of v1.
    await drainOnce(seed);
    const afterFirst = await pending(seed);
    const heldV2 = afterFirst.find((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v2`)!;
    expect(heldV2.status).toBe("PENDING");
    expect(heldV2.attempts).toBe(0);
    expect(heldV2.lastError).toMatch(/Waiting to post: custody payable reclassification v1/);
    expect(await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).toHaveLength(0);
    expect(payable(await ledger(seed))).toBe(0);

    // The month reopens: v1 posts into it, then v2 posts into the current
    // month — in that order, whatever order the worker picked them up in.
    await seed.t.run((ctx) => ctx.db.patch(earlierId, { status: "OPEN", closedAt: undefined, closedBy: undefined }));
    for (let round = 0; round < 3; round += 1) {
      await drainOnce(seed);
      if ((await pending(seed)).every((r) => r.status === "POSTED")) break;
    }
    expect((await pending(seed)).map((r) => r.status)).toEqual(["POSTED", "POSTED", "POSTED"]);
    const reclass = await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED");
    expect(reclass.map((e) => e.eventVersion).sort()).toEqual([1, 2]);
    expect(reclass.every((e) => e.status === "POSTED")).toBe(true);
    l = await ledger(seed);
    expect(payable(l)).toBe(0);
    expect(clearing(l)).toBe(0);
    expect(transferExpense(l)).toBe(jod(900));
    // The consumer's view: the closed month's snapshot carries the 200 owed
    // (a CREDIT), the current month's carries its release (a DEBIT), and
    // the two sum to what the ledger says — no month ever held the release
    // without the debt.
    expect(payable(await snapshotByKey(seed, earlierId))).toBe(-jod(200));
    expect(payable(await snapshotByKey(seed, seed.periodId))).toBe(jod(200));
    row = (await readCosts(seed)).custody.find((r) => r._id === custodyId)!;
    expect(row.payableAwaitingPost).toBe(false);
    expect(row.payableTargetMinor).toBe(0);
  });

  test("the chain is the row's TARGET, not its ledger balance: the next delta measures from where the chain lands", async () => {
    const seed = await seedDeal("chain-target");
    const { earlierId, boundary } = await splitPeriods(seed);
    await seed.t.run((ctx) => ctx.db.patch(earlierId, { status: "CLOSED", closedAt: Date.now(), closedBy: seed.userId }));
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(900), { paidAt: boundary - 5 * DAY });
    // The dealership reimburses 100 today: −100 owed (v2), dated today,
    // queued behind v1 — and measured from v1's 200, not from the ledger's 0.
    // (v1 still waits on a receipt that is queued, not cancelled, so it is
    // left standing rather than folded.)
    await move(seed, custodyId, "REIMBURSED", jod(100));
    const rows = (await pending(seed)).filter((r) => r.idempotencyKey.startsWith(`custody_payable_reclass_${custodyId}`));
    expect(rows.map((r) => [r.eventVersion, (r.payload as { deltaMinor: number; payableAfterMinor: number }).deltaMinor, (r.payload as { payableAfterMinor: number }).payableAfterMinor]).sort()).toEqual([
      [1, jod(200), jod(200)],
      [2, -jod(100), jod(100)],
    ]);
    expect(rows.every((r) => r.status === "PENDING")).toBe(true);
    expect(payable(await ledger(seed))).toBe(0);
  });
});

describe("B — a custody family is on the books completely, or the deal does not classify or finalize", () => {
  /** A record written BEFORE custody posted, exactly as the base schema left it: no marker, no postings, already reconciled. */
  async function seedLegacyFamily(seed: Seed, opts: { status?: "RECONCILED" | "OPEN" | "WRITTEN_OFF"; issued?: number; returned?: number; actual?: number; writeOffReason?: string } = {}) {
    const issued = opts.issued ?? jod(700);
    const returned = opts.returned ?? jod(50);
    const actual = opts.actual ?? jod(650);
    const t0 = Date.now() - 10 * DAY;
    return await seed.t.run(async (ctx) => {
      const custodyId = await ctx.db.insert("financeDealCustody", {
        orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.employeeId, currency: "JOD",
        issuedMinor: issued, returnedMinor: returned, reimbursedMinor: 0, status: opts.status ?? "RECONCILED",
        reconciledAt: t0 + 3 * DAY, reconciledBy: seed.userId, reconciliationNotes: "legacy close",
        writeOffReason: opts.writeOffReason,
        createdBy: seed.userId, createdAt: t0, updatedAt: t0,
      });
      const issuedId = await ctx.db.insert("financeDealCustodyEntries", {
        orgId: seed.orgId, custodyId, kind: "ISSUED", amountMinor: issued, method: "CASH", occurredAt: t0, recordedBy: seed.userId, recordedAt: t0,
      });
      const returnedId = returned > 0
        ? await ctx.db.insert("financeDealCustodyEntries", {
            orgId: seed.orgId, custodyId, kind: "RETURNED", amountMinor: returned, method: "CASH", occurredAt: t0 + 2 * DAY, recordedBy: seed.userId, recordedAt: t0 + 2 * DAY,
          })
        : undefined;
      const feeId = await ctx.db.insert("financeDealFees", {
        orgId: seed.orgId, applicationId: seed.applicationId, feeType: "LICENSING", currency: "JOD",
        actualAmountMinor: actual, paidBy: "EMPLOYEE", paidTo: "GOVERNMENT", accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
        includedInQuotation: false, deductedFromSettlement: false, refundable: false, custodyId, paidAt: t0 + DAY,
        reconciledAt: t0 + 3 * DAY, reconciledBy: seed.userId, reconciliationNotes: "receipt on file",
        source: "MANUAL", createdBy: seed.userId, createdAt: t0 + DAY, updatedAt: t0 + DAY,
      });
      await ctx.db.patch(seed.applicationId, {
        legalInvoiceAmountMinor: jod(10_500), legalInvoiceNumber: "INV-LEGACY", legalInvoiceDate: t0, legalInvoiceIssuedTo: "FINANCE_COMPANY",
      });
      return { custodyId, issuedId, returnedId, feeId, t0 };
    });
  }
  const classify = (seed: Seed) =>
    seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, { orgId: seed.orgId, applicationId: seed.applicationId, notes: "established" });
  const migrate = (seed: Seed, custodyId: Id<"financeDealCustody">, idempotencyKey = crypto.randomUUID()) =>
    seed.asUser.mutation(api.financeDealCosts.migrateLegacyCustodyToLedger, { orgId: seed.orgId, custodyId, idempotencyKey });

  test("seed → refusal → migration posts the family exactly once → the deal classifies, and reporting agrees", async () => {
    const seed = await seedDeal("legacy-family", { templates: false });
    const { custodyId, feeId } = await seedLegacyFamily(seed);
    // The base-schema record reads as balanced and closed — and is refused
    // anyway, because none of it is on the books.
    expect((await readCosts(seed)).custody[0].legacy).toBe(true);
    await expect(classify(seed)).rejects.toThrow(/predates ledger posting/);
    expect(await events(seed)).toHaveLength(0);

    const key = crypto.randomUUID();
    const result = await migrate(seed, custodyId, key);
    expect(result).toEqual({ custodyId, cashLegs: 2, reversals: 0, feesPosted: 1, writeOffPosted: false });
    const posted = await events(seed);
    expect(posted.map((e) => e.eventType).sort()).toEqual(["CUSTODY_CASH_ISSUED", "CUSTODY_CASH_RETURNED", "CUSTODY_FEE_PAID"]);
    expect(posted.every((e) => e.status === "POSTED")).toBe(true);
    // Dated when the record says the money moved, never today.
    const now = Date.now();
    expect(posted.every((e) => e.accountingDate < now - 5 * DAY)).toBe(true);
    const l = await ledger(seed);
    expect(clearing(l)).toBe(0);
    expect(cash(l)).toBe(-jod(650));
    expect(transferExpense(l)).toBe(jod(650));
    expect(payable(l)).toBe(0);
    const fee = await seed.t.run((ctx) => ctx.db.get(feeId));
    expect(fee?.custodyPosted).toEqual({ version: 1, amountMinor: jod(650), custodyId });
    const custody = await seed.t.run((ctx) => ctx.db.get(custodyId));
    expect(custody?.ledgerPosting).toBe("CANONICAL");
    expect(custody?.status).toBe("RECONCILED");
    expect((await readCosts(seed)).custody[0].legacy).toBe(false);

    // Exactly once: the same key replays the stored result and posts nothing
    // more; a fresh key finds nothing left to migrate.
    expect(await migrate(seed, custodyId, key)).toEqual(result);
    await expect(migrate(seed, custodyId)).rejects.toThrow(/already on the ledger/);
    expect(await events(seed)).toHaveLength(3);
    expect(await pending(seed)).toHaveLength(0);

    await classify(seed);
    expect((await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))?.accountingClassification).toBe("CLASSIFIED");
  });

  test("a legacy OPEN record with an out-of-pocket position migrates its payable too; a written-off one posts its shortage", async () => {
    const seed = await seedDeal("legacy-open", { templates: false });
    const { custodyId } = await seedLegacyFamily(seed, { status: "OPEN", returned: 0, actual: jod(900) });
    const result = await migrate(seed, custodyId);
    expect(result).toMatchObject({ cashLegs: 1, feesPosted: 1, writeOffPosted: false });
    const l = await ledger(seed);
    expect(clearing(l)).toBe(0);
    expect(payable(l)).toBe(-jod(200));
    const row = (await readCosts(seed)).custody[0];
    expect(row.legacy).toBe(false);
    expect(row.payableTargetMinor).toBe(jod(200));
    expect(row.payableAwaitingPost).toBe(false);

    const off = await seedDeal("legacy-writeoff", { templates: false });
    const legacy = await seedLegacyFamily(off, { status: "WRITTEN_OFF", returned: 0, actual: jod(600), writeOffReason: "lost 100" });
    expect(await migrate(off, legacy.custodyId)).toMatchObject({ cashLegs: 1, feesPosted: 1, writeOffPosted: true });
    const lo = await ledger(off);
    expect(clearing(lo)).toBe(0);
    expect(lo[SYSTEM_KEYS.CASH_OVER_SHORT]).toBe(jod(100));
    expect((await off.t.run((ctx) => ctx.db.get(legacy.custodyId)))?.writeOffPosted).toEqual({ version: 1, amountMinor: jod(100) });
  });

  test("a record that contradicts itself is refused whole — nothing posts, it stays legacy, and the deal stays refused", async () => {
    const seed = await seedDeal("legacy-contradiction", { templates: false });
    const { custodyId } = await seedLegacyFamily(seed);
    // The stored total disagrees with the log the migration would post from.
    await seed.t.run((ctx) => ctx.db.patch(custodyId, { issuedMinor: jod(800) }));
    await expect(migrate(seed, custodyId)).rejects.toThrow(/do not match its own movement log/);
    expect(await events(seed)).toHaveLength(0);
    expect(await pending(seed)).toHaveLength(0);
    expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))?.ledgerPosting).toBeUndefined();
    expect(await commandRows(seed, "financeDealCosts.migrateLegacyCustodyToLedger")).toEqual([]);
    await expect(classify(seed)).rejects.toThrow(/predates ledger posting/);
    // The holder never migrates their own record.
    const asHolder = seed.t.withIdentity({ subject: "cu_emp_legacy-contradiction" });
    await expect(
      asHolder.mutation(api.financeDealCosts.migrateLegacyCustodyToLedger, { orgId: seed.orgId, custodyId, idempotencyKey: crypto.randomUUID() })
    ).rejects.toThrow(/somebody other than the person holding the cash/);
  });

  test("the family predicate, shared by classification and finalization: a stale or missing fee posting refuses even on a CANONICAL record", async () => {
    const seed = await seedDeal("family-predicate");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(650));
    const rows = () => seed.t.run(async (ctx) => ({
      custody: (await ctx.db.query("financeDealCustody").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).collect()),
      fees: (await ctx.db.query("financeDealFees").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).collect()),
    }));
    let { custody, fees } = await rows();
    expect(custodyLedgerFamilyRowRefusal(custody, fees, "closing")).toBeNull();
    // A line whose posting no longer matches its actual (raw-edited).
    await seed.t.run((ctx) => ctx.db.patch(feeId, { actualAmountMinor: jod(700) }));
    ({ custody, fees } = await rows());
    expect(custodyLedgerFamilyRowRefusal(custody, fees, "closing")).toMatch(/not on the books at its recorded amount/);
    // A line charged to custody with no posting at all.
    await seed.t.run((ctx) => ctx.db.patch(feeId, { actualAmountMinor: jod(650), custodyPosted: undefined }));
    ({ custody, fees } = await rows());
    expect(custodyLedgerFamilyRowRefusal(custody, fees, "closing")).toMatch(/not on the books/);
    // A posting for an actual the line no longer records.
    await seed.t.run((ctx) => ctx.db.patch(feeId, { actualAmountMinor: undefined, custodyPosted: { version: 1, amountMinor: jod(650), custodyId } }));
    ({ custody, fees } = await rows());
    expect(custodyLedgerFamilyRowRefusal(custody, fees, "closing")).toMatch(/actual it no longer records/);
    // The marker missing on the record itself.
    await seed.t.run((ctx) => ctx.db.patch(feeId, { actualAmountMinor: jod(650) }));
    await seed.t.run((ctx) => ctx.db.patch(custodyId, { ledgerPosting: undefined }));
    ({ custody, fees } = await rows());
    expect(custodyLedgerFamilyRowRefusal(custody, fees, "closing")).toMatch(/predates ledger posting/);
  });
});

describe("C — an economic date past the server's clock is refused, with no tolerance and no partial state", () => {
  const CLOCK = Date.UTC(2026, 8, 15, 22, 30, 0, 0);

  test("now−1 and now pass; now+1 is refused on every date-bearing command, leaving no row, event, key or queue entry", async () => {
    const seed = await seedDeal("future");
    const custodyId = await openCustody(seed, jod(700));
    const before = {
      entries: (await entries(seed, custodyId)).length,
      events: (await events(seed)).length,
      pending: (await pending(seed)).length,
      commands: (await seed.t.run((ctx) => ctx.db.query("commandIdempotency").collect())).length,
      fees: (await readCosts(seed)).fees.length,
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(CLOCK));
      const future = /cannot be in the future/;
      // A custody movement.
      await expect(move(seed, custodyId, "RETURNED", jod(1), { occurredAt: CLOCK + 1 })).rejects.toThrow(future);
      // A fresh custody record.
      await expect(
        seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
          idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.viewerId, issuedMinor: jod(1), occurredAt: CLOCK + 1,
        })
      ).rejects.toThrow(future);
      // A typed cost, a configured fee's actual, and a re-recorded actual.
      await expect(employeeFee(seed, undefined, jod(1), { paidAt: CLOCK + 1 })).rejects.toThrow(future);
      await expect(
        seed.asUser.mutation(api.financeDealCosts.recordTemplateFeeActual, {
          orgId: seed.orgId, applicationId: seed.applicationId, templateIndex: 0, feeType: "LICENSING",
          actualAmountMinor: jod(90), expectedCurrency: "JOD", paidAt: CLOCK + 1, idempotencyKey: crypto.randomUUID(),
        })
      ).rejects.toThrow(future);
      const plain = await employeeFee(seed, undefined, jod(5), { paidAt: CLOCK });
      await expect(
        seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId: plain, actualAmountMinor: jod(6), expectedCurrency: "JOD", paidAt: CLOCK + 1 })
      ).rejects.toThrow(future);
      // The legal invoice, with the old 24-hour window gone.
      const invoice = { orgId: seed.orgId, applicationId: seed.applicationId, legalInvoiceAmountMinor: jod(10_500), legalInvoiceNumber: "INV", issuedTo: "FINANCE_COMPANY" as const };
      await expect(seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, { ...invoice, legalInvoiceDate: CLOCK + 1 })).rejects.toThrow(future);
      await expect(seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, { ...invoice, legalInvoiceDate: CLOCK + 60 * 60 * 1000 })).rejects.toThrow(future);
      expect((await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))?.legalInvoiceDate).toBeUndefined();

      // Nothing partial survives a refusal: one accepted line (the 5 above), nothing else.
      expect((await entries(seed, custodyId)).length).toBe(before.entries);
      expect((await events(seed)).length).toBe(before.events);
      expect((await pending(seed)).length).toBe(before.pending);
      expect((await readCosts(seed)).fees.length).toBe(before.fees + 1);
      const commands = await seed.t.run((ctx) => ctx.db.query("commandIdempotency").collect());
      expect(commands.length).toBe(before.commands + 1);

      // The boundary itself: equal to the server's instant passes, one before it passes.
      await move(seed, custodyId, "RETURNED", jod(1), { occurredAt: CLOCK });
      await move(seed, custodyId, "RETURNED", jod(1), { occurredAt: CLOCK - 1 });
      await seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, { ...invoice, legalInvoiceDate: CLOCK });
      await seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, { ...invoice, legalInvoiceDate: CLOCK - 1 });
      expect((await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))?.legalInvoiceDate).toBe(CLOCK - 1);
      // Legitimate history is untouched.
      await move(seed, custodyId, "RETURNED", jod(1), { occurredAt: CLOCK - 400 * DAY });
      expect((await entries(seed, custodyId)).length).toBe(before.entries + 3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("calendar dates: today's UTC midnight passes once the day has begun, tomorrow's is refused, and a date-only value in the past is history", async () => {
    const seed = await seedDeal("calendar");
    const custodyId = await openCustody(seed, jod(700));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // 22:30Z on the 15th. For a user in Amman (+3) the local date is already
      // the 16th, and the UTC midnight of that local day is a future instant:
      // the server refuses it; the client sends the current instant instead
      // (`economicDateInputToMs`). The UTC midnight of the 15th has begun and passes.
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 15, 22, 30)));
      await expect(move(seed, custodyId, "RETURNED", jod(1), { occurredAt: Date.UTC(2026, 8, 16) })).rejects.toThrow(/cannot be in the future/);
      await move(seed, custodyId, "RETURNED", jod(1), { occurredAt: Date.UTC(2026, 8, 15) });
      await move(seed, custodyId, "RETURNED", jod(1), { occurredAt: Date.now() });
      const invoice = { orgId: seed.orgId, applicationId: seed.applicationId, legalInvoiceAmountMinor: jod(10_500), legalInvoiceNumber: "INV", issuedTo: "FINANCE_COMPANY" as const };
      await expect(seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, { ...invoice, legalInvoiceDate: Date.UTC(2026, 8, 16) })).rejects.toThrow(/cannot be in the future/);
      await seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, { ...invoice, legalInvoiceDate: Date.UTC(2026, 8, 15) });
      await seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, { ...invoice, legalInvoiceDate: Date.UTC(2026, 7, 1) });
      expect((await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))?.legalInvoiceDate).toBe(Date.UTC(2026, 7, 1));
      // The pure finalization rule has no window either.
      expect(() => financedSaleRecognitionDate({ legalInvoiceDate: Date.now() + 1 }, Date.now())).toThrow(/dated in the future/);
      expect(financedSaleRecognitionDate({ legalInvoiceDate: Date.now() }, Date.now())).toBe(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("D — a fingerprint is every persisted intent field: a note- or reason-only change under the same key conflicts", () => {
  test("issuance, movement, reversal and closure", async () => {
    const seed = await seedDeal("fingerprint");
    const conflict = /Idempotency key reused with different request content/;
    const openKey = crypto.randomUUID();
    const open = (note: string) =>
      seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
        idempotencyKey: openKey, orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.employeeId, issuedMinor: jod(700), method: "CASH", note,
      });
    const custodyId = await open("first handover");
    expect(await open("first handover")).toBe(custodyId);
    expect(await open("  first handover  ")).toBe(custodyId);
    await expect(open("second handover")).rejects.toThrow(conflict);

    const moveKey = crypto.randomUUID();
    const returned = (note?: string) =>
      seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
        orgId: seed.orgId, custodyId, kind: "RETURNED", amountMinor: jod(50), method: "CASH", note, idempotencyKey: moveKey,
      });
    await returned("coins");
    await returned("coins");
    await expect(returned("notes")).rejects.toThrow(conflict);
    await expect(returned(undefined)).rejects.toThrow(conflict);
    expect((await entries(seed, custodyId)).filter((e) => e.kind === "RETURNED")).toHaveLength(1);

    // A reversal's note is the reason its reversing journal carries.
    const reverseKey = crypto.randomUUID();
    const returnedEntry = (await entries(seed, custodyId)).find((e) => e.kind === "RETURNED")!;
    const reverseReturn = (note: string) =>
      seed.asUser.mutation(api.financeDealCosts.recordCustodyMovement, {
        orgId: seed.orgId, custodyId, kind: "REVERSAL", reversesEntryId: returnedEntry._id, amountMinor: jod(50), note, idempotencyKey: reverseKey,
      });
    await reverseReturn("typo");
    await reverseReturn("typo");
    await expect(reverseReturn("wrong person")).rejects.toThrow(conflict);
    expect((await entries(seed, custodyId)).filter((e) => e.kind === "REVERSAL")).toHaveLength(1);

    // Closure: the record now balances (700 issued, fee 700).
    await employeeFee(seed, custodyId, jod(700));
    const closeKey = crypto.randomUUID();
    const close = (notes: string, writeOffReason?: string) =>
      seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: seed.orgId, custodyId, notes, writeOffReason, idempotencyKey: closeKey });
    expect(await close("receipts on file")).toBe(custodyId);
    expect(await close("receipts on file")).toBe(custodyId);
    await expect(close("receipts on file", "shortage")).rejects.toThrow(conflict);
    await expect(close("receipts checked")).rejects.toThrow(conflict);
    expect(await commandRows(seed, "financeDealCosts.reconcileDealCustody")).toHaveLength(1);
  });
});

describe("E — the custody holder never links, unlinks, records, changes, voids, certifies or reopens against their own custody", () => {
  test("every reachable path refuses the holder before any write, and the second-person workflow still runs", async () => {
    const seed = await seedDeal("holder");
    const custodyId = await openCustody(seed, jod(700));
    const linked = await employeeFee(seed, custodyId, jod(300));
    const plain = await employeeFee(seed, undefined, jod(100));
    const asHolder = seed.t.withIdentity({ subject: "cu_emp_holder" });
    const refusal = /somebody other than the person holding the cash/;
    const snapshot = async () => ({
      fees: await seed.t.run((ctx) => ctx.db.query("financeDealFees").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).collect()),
      custody: await seed.t.run((ctx) => ctx.db.get(custodyId)),
      events: (await events(seed)).length,
      pending: (await pending(seed)).length,
      overrides: (await seed.t.run((ctx) => ctx.db.query("financeApplicationOverrides").collect())).filter((o) => o.orgId === seed.orgId).length,
      commands: (await seed.t.run((ctx) => ctx.db.query("commandIdempotency").collect())).filter((c) => c.orgId === seed.orgId).length,
    });
    const before = await snapshot();

    // recordDealFee against own custody.
    await expect(
      asHolder.mutation(api.financeDealCosts.recordDealFee, {
        expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId,
        feeType: "LICENSING", paidBy: "EMPLOYEE", paidTo: "GOVERNMENT", accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE", actualAmountMinor: jod(10), custodyId,
      })
    ).rejects.toThrow(refusal);
    // recordTemplateFeeActual against own custody.
    await expect(
      asHolder.mutation(api.financeDealCosts.recordTemplateFeeActual, {
        orgId: seed.orgId, applicationId: seed.applicationId, templateIndex: 0, feeType: "LICENSING", actualAmountMinor: jod(90), expectedCurrency: "JOD", custodyId, idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(refusal);
    // recordActualFeeAmount: on a line already on own custody, and charging a plain line to it.
    await expect(
      asHolder.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId: linked, actualAmountMinor: jod(400), expectedCurrency: "JOD" })
    ).rejects.toThrow(refusal);
    await expect(
      asHolder.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId: plain, actualAmountMinor: jod(100), expectedCurrency: "JOD", custodyId })
    ).rejects.toThrow(refusal);
    // setFeeCustody: link and unlink.
    await expect(asHolder.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId: plain, custodyId })).rejects.toThrow(refusal);
    await expect(asHolder.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId: linked })).rejects.toThrow(refusal);
    // voidDealFee and reconcileDealFee on a line on own custody.
    await expect(asHolder.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId: linked, reason: "mine" })).rejects.toThrow(refusal);
    await expect(asHolder.mutation(api.financeDealCosts.reconcileDealFee, { orgId: seed.orgId, feeId: linked, notes: "looks right to me" })).rejects.toThrow(refusal);
    expect(await snapshot()).toEqual(before);

    // A second person closes the record after the return, and the holder cannot reopen it.
    await move(seed, custodyId, "RETURNED", jod(400));
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: seed.orgId, custodyId, notes: "balanced", idempotencyKey: crypto.randomUUID() });
    const closed = await snapshot();
    await expect(asHolder.mutation(api.financeDealCosts.reopenDealCustody, { orgId: seed.orgId, custodyId, reason: "mine" })).rejects.toThrow(refusal);
    expect(await snapshot()).toEqual(closed);
    expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))?.status).toBe("RECONCILED");

    // The second-person workflow is untouched: another disbursement confirmer
    // reopens, re-records, voids and re-links freely.
    await seed.asUser.mutation(api.financeDealCosts.reopenDealCustody, { orgId: seed.orgId, custodyId, reason: "late receipt" });
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId: linked, actualAmountMinor: jod(310), expectedCurrency: "JOD" });
    await seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId: plain, custodyId });
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, { orgId: seed.orgId, feeId: plain, notes: "checked" });
    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId: plain, reason: "duplicate" });
    expect((await seed.t.run((ctx) => ctx.db.get(linked)))?.custodyPosted).toEqual({ version: 2, amountMinor: jod(310), custodyId });
  });
});

describe("F — closing a custody record is an idempotent command", () => {
  test("an exact replay returns the stored result; the same key with a changed intent conflicts; a fresh key after closure fails on state", async () => {
    const seed = await seedDeal("close-idem");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(650));
    const key = crypto.randomUUID();
    const close = (args: { notes: string; writeOffReason?: string; idempotencyKey: string }) =>
      seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: seed.orgId, custodyId, ...args });
    // A shortage of 50, written off: the closure posts a journal.
    expect(await close({ notes: "short 50", writeOffReason: "lost", idempotencyKey: key })).toBe(custodyId);
    expect(await events(seed, "CUSTODY_WRITTEN_OFF")).toHaveLength(1);
    // The lost-response replay: the SAME answer, no second write-off, even though the record is now closed.
    expect(await close({ notes: "short 50", writeOffReason: "lost", idempotencyKey: key })).toBe(custodyId);
    expect(await close({ notes: "  short 50 ", writeOffReason: " lost ", idempotencyKey: key })).toBe(custodyId);
    expect(await events(seed, "CUSTODY_WRITTEN_OFF")).toHaveLength(1);
    // Same key, different intent.
    await expect(close({ notes: "short 50", writeOffReason: "stolen", idempotencyKey: key })).rejects.toThrow(/Idempotency key reused/);
    await expect(close({ notes: "short 50", idempotencyKey: key })).rejects.toThrow(/Idempotency key reused/);
    // A genuinely new command against a closed record fails on the state.
    await expect(close({ notes: "again", writeOffReason: "lost", idempotencyKey: crypto.randomUUID() })).rejects.toThrow(/already closed/);
    expect(await commandRows(seed, "financeDealCosts.reconcileDealCustody")).toHaveLength(1);
    expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))?.writeOffPosted).toEqual({ version: 1, amountMinor: jod(50) });
    // The holder is refused on a replay as on a first attempt.
    const asHolder = seed.t.withIdentity({ subject: "cu_emp_close-idem" });
    await expect(
      asHolder.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: seed.orgId, custodyId, notes: "short 50", writeOffReason: "lost", idempotencyKey: key })
    ).rejects.toThrow(/somebody other than the person holding the cash/);
  });
});

// ---------------------------------------------------------------------------
// Consolidated round on 2a6a15f1c: items 1 (POSTED-only family), 2 (a
// replacement never overtakes a deferred reversal) and 3 (an economic date is
// the exact calendar date the operator picked).
// ---------------------------------------------------------------------------

/** The gate's own predicate, asked over the same bounded rows the gates read. */
async function familyRefusal(seed: Seed, action = "closing") {
  return await seed.t.run(async (ctx) => {
    const custody = await ctx.db.query("financeDealCustody").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).collect();
    const fees = await ctx.db.query("financeDealFees").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).collect();
    return await custodyLedgerFamilyRefusal(ctx, seed.orgId, seed.applicationId, custody, fees.filter((f) => f.voidedAt === undefined), action);
  });
}

/** Drains the outbox until nothing is left PENDING or the rounds run out; returns the statuses. */
async function drainUntilSettled(seed: Seed, rounds = 4) {
  for (let round = 0; round < rounds; round += 1) {
    await drainOnce(seed);
    if ((await pending(seed)).every((r) => r.status === "POSTED")) break;
  }
  return (await pending(seed)).map((r) => r.status);
}

const closePeriod = (seed: Seed, periodId: Id<"accountingPeriods">) =>
  seed.t.run((ctx) => ctx.db.patch(periodId, { status: "CLOSED", closedAt: Date.now(), closedBy: seed.userId }));
const reopenPeriod = (seed: Seed, periodId: Id<"accountingPeriods">) =>
  seed.t.run((ctx) => ctx.db.patch(periodId, { status: "OPEN", closedAt: undefined, closedBy: undefined }));

describe("G1 — the family gate proves the LEDGER, not the rows: only the exact POSTED family passes", () => {
  test("a CANONICAL record whose postings are queued for a closed month is refused; it passes once the outbox has posted them", async () => {
    const seed = await seedDeal("posted-only", { templates: false });
    const { earlierId, boundary } = await splitPeriods(seed);
    await closePeriod(seed, earlierId);
    const custodyId = await openCustody(seed, jod(700));
    // Paid in the closed month: the fee posting queues (700 = the issued cash, so no payable delta).
    const feeId = await employeeFee(seed, custodyId, jod(700), { paidAt: boundary - 5 * DAY });
    // Every row says "posted": the marker is CANONICAL, the line carries its
    // custodyPosted version. The row half of the predicate passes.
    const rows = await seed.t.run(async (ctx) => ({
      custody: await ctx.db.get(custodyId),
      fee: await ctx.db.get(feeId),
    }));
    expect(rows.custody?.ledgerPosting).toBe("CANONICAL");
    expect(rows.fee?.custodyPosted).toEqual({ version: 1, amountMinor: jod(700), custodyId });
    expect(custodyLedgerFamilyRowRefusal([rows.custody!], [rows.fee!], "closing")).toBeNull();
    // The ledger half does not.
    expect(await familyRefusal(seed)).toMatch(/not on the books/);

    // Wired into the classification door: closed, reconciled, invoiced — and still refused on the ledger.
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, { orgId: seed.orgId, feeId, notes: "receipt" });
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "balanced" });
    await seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId: seed.orgId, applicationId: seed.applicationId, legalInvoiceAmountMinor: jod(10_500), legalInvoiceNumber: "INV-G1", issuedTo: "FINANCE_COMPANY", legalInvoiceDate: Date.now() - DAY,
    });
    const classify = () =>
      seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, { orgId: seed.orgId, applicationId: seed.applicationId, notes: "established" });
    await expect(classify()).rejects.toThrow(/not on the books/);
    expect((await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))?.accountingClassification).not.toBe("CLASSIFIED");

    // The month reopens and the outbox posts the family; the same rows now pass.
    await reopenPeriod(seed, earlierId);
    expect(await drainUntilSettled(seed)).toEqual(["POSTED"]);
    expect(await familyRefusal(seed)).toBeNull();
    await classify();
    expect((await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))?.accountingClassification).toBe("CLASSIFIED");
  }, 30_000);

  test("a posting that is PENDING, FAILED, absent, REVERSED, or at a version the row does not name is refused", async () => {
    const seed = await seedDeal("posted-status");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(650));
    expect(await familyRefusal(seed)).toBeNull();
    const feeEvent = (await events(seed, "CUSTODY_FEE_PAID"))[0];
    const issuedEvent = (await events(seed, "CUSTODY_CASH_ISSUED"))[0];
    const setStatus = (id: Id<"accountingEvents">, status: "PENDING" | "POSTED" | "FAILED" | "REVERSED") =>
      seed.t.run((ctx) => ctx.db.patch(id, { status }));

    for (const status of ["PENDING", "FAILED", "REVERSED"] as const) {
      await setStatus(feeEvent._id, status);
      expect(await familyRefusal(seed)).toMatch(/custody on this deal is not on the books/);
      await setStatus(issuedEvent._id, status);
      expect(await familyRefusal(seed)).toMatch(/custody movement on this deal is not on the books/);
      await setStatus(issuedEvent._id, "POSTED");
    }
    await setStatus(feeEvent._id, "POSTED");
    expect(await familyRefusal(seed)).toBeNull();

    // A stale version: the row names v2, the ledger carries v1 (raw-edited row).
    await seed.t.run((ctx) => ctx.db.patch(feeId, { custodyPosted: { version: 2, amountMinor: jod(650), custodyId } }));
    expect(await familyRefusal(seed)).toMatch(/custody on this deal is not on the books/);
    await seed.t.run((ctx) => ctx.db.patch(feeId, { custodyPosted: { version: 1, amountMinor: jod(650), custodyId } }));
    expect(await familyRefusal(seed)).toBeNull();
    // An absent event: the movement's ledger row is gone.
    await seed.t.run((ctx) => ctx.db.delete(issuedEvent._id));
    expect(await familyRefusal(seed)).toMatch(/custody movement on this deal is not on the books \(no ledger event exists/);
  }, 30_000);

  test("a reversed cash leg is off the books or the deal is refused; a payable delta the ledger does not carry refuses; a reopened record whose write-off is still posted refuses", async () => {
    const seed = await seedDeal("posted-reversal");
    const custodyId = await openCustody(seed, jod(700));
    const issued = (await entries(seed, custodyId))[0];
    await reverse(seed, custodyId, issued._id, jod(700));
    // Reversed in an open period: the forward is REVERSED, the family passes.
    expect((await events(seed, "CUSTODY_CASH_ISSUED"))[0].status).toBe("REVERSED");
    expect(await familyRefusal(seed)).toBeNull();
    // The same reversal DEFERRED would leave the forward POSTED: refused.
    const issuedEventId = (await events(seed, "CUSTODY_CASH_ISSUED"))[0]._id;
    await seed.t.run((ctx) => ctx.db.patch(issuedEventId, { status: "POSTED" }));
    expect(await familyRefusal(seed)).toMatch(/cancelled custody movement on this deal is still on the books/);

    // A payable delta the row says it issued but the ledger does not carry.
    const chain = await seedDeal("posted-payable");
    const chainCustody = await openCustody(chain, jod(700));
    await employeeFee(chain, chainCustody, jod(900));
    expect((await chain.t.run((ctx) => ctx.db.get(chainCustody)))?.payableReclassVersion).toBe(1);
    expect(await familyRefusal(chain)).toBeNull();
    const reclassEventId = (await events(chain, "CUSTODY_PAYABLE_RECLASSIFIED"))[0]._id;
    // Not POSTED and not in the outbox either: nothing will ever post it, so
    // the exact chain reading (R6, F2) names it as missing rather than waiting.
    await chain.t.run((ctx) => ctx.db.patch(reclassEventId, { status: "PENDING" }));
    expect(await familyRefusal(chain)).toMatch(/payable reclassification v1 is neither on the ledger nor waiting in the outbox/);

    // A written-off record whose write-off is on the books passes; reopened
    // with the reversal deferred (write-off still POSTED) it is refused, and
    // passes again once the outbox has posted the reversal.
    const off = await seedDeal("posted-writeoff");
    const offCustody = await openCustody(off, jod(700));
    await employeeFee(off, offCustody, jod(600));
    await off.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(), orgId: off.orgId, custodyId: offCustody, notes: "short", writeOffReason: "lost 100" });
    expect(await familyRefusal(off)).toBeNull();
    await closePeriod(off, off.periodId);
    await off.asUser.mutation(api.financeDealCosts.reopenDealCustody, { orgId: off.orgId, custodyId: offCustody, reason: "receipt found" });
    expect((await events(off, "CUSTODY_WRITTEN_OFF"))[0].status).toBe("POSTED");
    expect(await familyRefusal(off)).toMatch(/reopened custody record on this deal still has its write-off on the books/);
    await reopenPeriod(off, off.periodId);
    expect(await drainUntilSettled(off)).toEqual(["POSTED"]);
    expect((await events(off, "CUSTODY_WRITTEN_OFF"))[0].status).toBe("REVERSED");
    expect(await familyRefusal(off)).toBeNull();
  }, 30_000);
});

describe("G2 — a replacement version never overtakes a deferred reversal (fee posting and write-off)", () => {
  test("no open period: the corrected fee's v2 is queued behind v1's deferred reversal, held by the worker until the reversal posts, and the books never carry both", async () => {
    const seed = await seedDeal("replace-fee");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(650));
    expect(transferExpense(await ledger(seed))).toBe(jod(650));
    // Every period closes; the correction's reversal has nowhere to post.
    await closePeriod(seed, seed.periodId);
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(700), expectedCurrency: "JOD" });
    // v1 is STILL POSTED; its reversal is queued; v2 is queued BEHIND it, not posted.
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    const queued = await pending(seed);
    const reversalRow = queued.find((r) => r.kind === "REVERSE" && r.idempotencyKey === `custody_fee_reversal_${feeId}_v1`);
    const v2 = queued.find((r) => r.idempotencyKey === `custody_fee_paid_${feeId}_v2`);
    expect(reversalRow?.status).toBe("PENDING");
    expect(v2?.status).toBe("PENDING");
    expect(v2?.reason).toMatch(/Waiting on a predecessor: custody fee posting v1/);
    expect(transferExpense(await ledger(seed))).toBe(jod(650));
    expect((await seed.t.run((ctx) => ctx.db.get(feeId)))?.custodyPosted).toEqual({ version: 2, amountMinor: jod(700), custodyId });
    // The gate reads the ledger: two versions in play, only one on the books, refused.
    expect(await familyRefusal(seed)).toMatch(/not on the books/);

    // The worker re-proves the dependency on the row itself, independent of the hook's reason.
    expect(await seed.t.run((ctx) => custodyPostingBlockedReason(ctx, v2!))).toMatch(/custody fee posting v1 it replaces is still on the books/);

    // Period still closed: one real attempt; nothing posts, v2 is not consumed.
    await drainOnce(seed);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    expect((await pending(seed)).find((r) => r.idempotencyKey === `custody_fee_paid_${feeId}_v2`)?.attempts).toBe(0);

    // The period reopens: the reversal lands, then v2 — never v2 first.
    await reopenPeriod(seed, seed.periodId);
    await drainUntilSettled(seed);
    expect((await pending(seed)).every((r) => r.status === "POSTED")).toBe(true);
    const after = await events(seed, "CUSTODY_FEE_PAID");
    expect(after.map((e) => [e.eventVersion, e.status]).sort()).toEqual([[1, "REVERSED"], [2, "POSTED"]]);
    const l = await ledger(seed);
    expect(transferExpense(l)).toBe(jod(700));
    expect(clearing(l)).toBe(0);
    expect(await familyRefusal(seed)).toBeNull();
    expect(await seed.t.run((ctx) => custodyPostingBlockedReason(ctx, v2!))).toBeNull();
  }, 30_000);

  test("the worker holds a queued replacement on the LEDGER alone: with the reversal row removed, v2 stays held while v1 is POSTED and posts once v1 is REVERSED", async () => {
    const seed = await seedDeal("replace-worker");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(650));
    await closePeriod(seed, seed.periodId);
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(700), expectedCurrency: "JOD" });
    // Take the reversal row out of the queue, so nothing can post it for v2
    // to wait on — only the ledger's own state can release v2.
    const reversalRow = (await pending(seed)).find((r) => r.kind === "REVERSE")!;
    await seed.t.run((ctx) => ctx.db.delete(reversalRow._id));
    await reopenPeriod(seed, seed.periodId);
    await drainOnce(seed);
    const v2 = (await pending(seed)).find((r) => r.idempotencyKey === `custody_fee_paid_${feeId}_v2`)!;
    expect(v2.status).toBe("PENDING");
    expect(v2.attempts).toBe(0);
    expect(v2.lastError).toMatch(/custody fee posting v1 it replaces is still on the books/);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    // The reversal reaches the books another way (here: the ledger says so); v2 is released.
    const v1EventId = (await events(seed, "CUSTODY_FEE_PAID"))[0]._id;
    await seed.t.run((ctx) => ctx.db.patch(v1EventId, { status: "REVERSED" }));
    await drainUntilSettled(seed);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status]).sort()).toEqual([[1, "REVERSED"], [2, "POSTED"]]);
  }, 30_000);

  test("no open period: a reopened write-off's reversal defers, the re-closure's v2 queues behind it, and Cash Over/Short never doubles", async () => {
    const seed = await seedDeal("replace-writeoff");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(600));
    const close = (reason: string) =>
      seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "short", writeOffReason: reason });
    await close("lost 100");
    expect((await ledger(seed))[SYSTEM_KEYS.CASH_OVER_SHORT]).toBe(jod(100));
    await closePeriod(seed, seed.periodId);
    await seed.asUser.mutation(api.financeDealCosts.reopenDealCustody, { orgId: seed.orgId, custodyId, reason: "recount" });
    // v1 still POSTED under a deferred reversal.
    expect((await events(seed, "CUSTODY_WRITTEN_OFF")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    await close("still lost 100");
    const v2 = (await pending(seed)).find((r) => r.idempotencyKey === `custody_written_off_${custodyId}_v2`);
    expect(v2?.status).toBe("PENDING");
    expect(v2?.reason).toMatch(/Waiting on a predecessor: custody write-off v1/);
    expect((await events(seed, "CUSTODY_WRITTEN_OFF")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    expect((await ledger(seed))[SYSTEM_KEYS.CASH_OVER_SHORT]).toBe(jod(100));
    expect(await seed.t.run((ctx) => custodyPostingBlockedReason(ctx, v2!))).toMatch(/custody write-off v1 it replaces is still on the books/);
    expect(await familyRefusal(seed)).toMatch(/not on the books/);

    await drainOnce(seed);
    expect((await ledger(seed))[SYSTEM_KEYS.CASH_OVER_SHORT]).toBe(jod(100));
    expect((await pending(seed)).find((r) => r.idempotencyKey === `custody_written_off_${custodyId}_v2`)?.attempts).toBe(0);

    await reopenPeriod(seed, seed.periodId);
    await drainUntilSettled(seed);
    expect((await pending(seed)).every((r) => r.status === "POSTED")).toBe(true);
    expect((await events(seed, "CUSTODY_WRITTEN_OFF")).map((e) => [e.eventVersion, e.status]).sort()).toEqual([[1, "REVERSED"], [2, "POSTED"]]);
    expect((await ledger(seed))[SYSTEM_KEYS.CASH_OVER_SHORT]).toBe(jod(100));
    expect(await familyRefusal(seed)).toBeNull();
  }, 30_000);
});

describe("G3 — an economic date is the exact calendar date the operator picked, judged on the server's clock", () => {
  test("the UTC calendar day's midnight is accepted and dated exactly there — across a month boundary, never shifted to the instant of recording", async () => {
    const seed = await seedDeal("calendar-exact");
    const custodyId = await openCustody(seed, jod(700));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // 00:30Z on 1 October: the client's UTC today is 1 October and it sends
      // that day's UTC midnight (`economicDateInputToMs`), never `Date.now()`.
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 0, 30)));
      const picked = Date.UTC(2026, 9, 1);
      await move(seed, custodyId, "RETURNED", jod(1), { occurredAt: picked });
      const returned = await events(seed, "CUSTODY_CASH_RETURNED");
      expect(returned.map((e) => e.accountingDate)).toEqual([picked]);
      expect(new Date(returned[0].accountingDate).getUTCMonth()).toBe(9);
      // A user ahead of UTC at 22:30Z on 30 September has a LOCAL date of
      // 1 October; its UTC midnight has not begun on the server's clock and
      // is refused with no tolerance — the client offers the UTC today instead.
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 30, 22, 30)));
      await expect(move(seed, custodyId, "RETURNED", jod(1), { occurredAt: Date.UTC(2026, 9, 1) })).rejects.toThrow(/cannot be in the future/);
      await move(seed, custodyId, "RETURNED", jod(1), { occurredAt: Date.UTC(2026, 8, 30) });
      expect((await events(seed, "CUSTODY_CASH_RETURNED")).map((e) => new Date(e.accountingDate).getUTCMonth()).sort()).toEqual([8, 9]);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});

describe("G4 — a line that no longer carries a custody charge must be OFF the books: a voided line's deferred reversal refuses until it posts", () => {
  test("posted custody fee → no open period → void defers the reversal → classification (same predicate as finalization) refused → reopen + drain → proceeds", async () => {
    const seed = await seedDeal("void-deferred", { templates: false });
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(700));
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, { orgId: seed.orgId, feeId, notes: "receipt" });
    // A dealer-paid line stays live so classification reaches the custody
    // family gate rather than refusing on "no costs itemized".
    const dealerFee = await employeeFee(seed, undefined, jod(40), { paidBy: "DEALER" });
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, { orgId: seed.orgId, feeId: dealerFee, notes: "receipt" });
    await seed.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId: seed.orgId, applicationId: seed.applicationId, legalInvoiceAmountMinor: jod(10_500), legalInvoiceNumber: "INV-G4", issuedTo: "FINANCE_COMPANY", legalInvoiceDate: Date.now() - DAY,
    });
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => e.status)).toEqual(["POSTED"]);
    expect(await familyRefusal(seed)).toBeNull();

    // Every period closes, then the line is removed: the reversal has nowhere
    // to post and is DEFERRED; the forward CUSTODY_FEE_PAID stays POSTED.
    await closePeriod(seed, seed.periodId);
    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "wrong line" });
    const voided = await seed.t.run((ctx) => ctx.db.get(feeId));
    expect(voided?.voidedAt).toBeDefined();
    expect(voided?.custodyPosted).toBeUndefined();
    expect(voided?.custodyPostingVersion).toBe(1);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => e.status)).toEqual(["POSTED"]);
    expect((await pending(seed)).map((r) => [r.kind, r.status])).toEqual([["REVERSE", "PENDING"]]);
    expect(transferExpense(await ledger(seed))).toBe(jod(700));
    // The live rows say nothing is charged; the ledger still carries the
    // charge. The gate reads the ledger through the ever-posted index.
    expect(await familyRefusal(seed)).toMatch(/no longer charged to an employee's custody on this deal .* still on the books/);
    const classify = () =>
      seed.asUser.mutation(api.financeDealCosts.classifyDealAccounting, { orgId: seed.orgId, applicationId: seed.applicationId, notes: "established" });
    await expect(classify()).rejects.toThrow(/no longer charged to an employee's custody on this deal .* still on the books/);
    expect((await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))?.accountingClassification).not.toBe("CLASSIFIED");
    // One real worker attempt with the period still closed changes nothing.
    await drainOnce(seed);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => e.status)).toEqual(["POSTED"]);
    expect(await familyRefusal(seed)).toMatch(/still on the books/);

    // The period reopens and the outbox posts the reversal: the forward is
    // REVERSED, the charge is off the books, and the deal may proceed.
    await reopenPeriod(seed, seed.periodId);
    expect(await drainUntilSettled(seed)).toEqual(["POSTED"]);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => e.status)).toEqual(["REVERSED"]);
    expect(transferExpense(await ledger(seed))).toBe(0);
    expect(await familyRefusal(seed)).toBeNull();
    await move(seed, custodyId, "RETURNED", jod(700));
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "all back" });
    await classify();
    expect((await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))?.accountingClassification).toBe("CLASSIFIED");
  }, 30_000);

  test("an unlinked line is held to the same proof; the ever-posted read is bounded and refuses past its cap, never a prefix", async () => {
    const seed = await seedDeal("unlink-deferred");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(650));
    await closePeriod(seed, seed.periodId);
    // Unlinked from custody (kept live as a dealer-paid line): its reversal defers.
    await seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId, custodyId: undefined });
    expect((await seed.t.run((ctx) => ctx.db.get(feeId)))?.custodyId).toBeUndefined();
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    expect(await familyRefusal(seed)).toMatch(/no longer charged to an employee's custody on this deal .* still on the books/);
    await reopenPeriod(seed, seed.periodId);
    await drainUntilSettled(seed);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "REVERSED"]]);
    expect(await familyRefusal(seed)).toBeNull();

    // The bound: past MAX_CUSTODY_POSTED_LINES ever-posted lines the proof refuses, never a prefix.
    await seed.t.run(async (ctx) => {
      const fee = (await ctx.db.get(feeId))!;
      for (let n = 0; n < MAX_CUSTODY_POSTED_LINES; n += 1) {
        const { _id: _drop, _creationTime: _ct, ...rest } = fee;
        await ctx.db.insert("financeDealFees", { ...rest, voidedAt: Date.now(), custodyPostingVersion: 1 });
      }
    });
    await expect(familyRefusal(seed)).rejects.toThrow(new RegExp(`more than ${MAX_CUSTODY_POSTED_LINES} cost lines that have posted a custody charge`));
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Frozen-candidate review on 4b32dd50e: findings 1 (a payable delta never
// overtakes the fee reversal or replacement it is a consequence of) and 2 (the
// family proof bounds the DOCUMENTS it reads, not the sources it names).
// ---------------------------------------------------------------------------

describe("G5 — a payable reclassification is chained behind the fee reversal and replacement it reflects", () => {
  test("payable v1 on the books, no open current period, paid date in an open earlier month: the correction's fee v2 AND payable v2 wait behind v1's deferred reversal, and neither balance nor snapshot moves until it posts", async () => {
    const seed = await seedDeal("payable-behind-fee");
    const { earlierId, boundary } = await splitPeriods(seed);
    const custodyId = await openCustody(seed, jod(700));
    const paidAt = boundary - 5 * DAY;
    // 900 paid out of 700 handed over: the employee is 200 out of pocket, and
    // payable v1 (a CREDIT of 200) is on the books, dated with the receipt.
    const feeId = await employeeFee(seed, custodyId, jod(900), { paidAt });
    let l = await ledger(seed);
    expect(payable(l)).toBe(-jod(200));
    expect(clearing(l)).toBe(0);
    expect(transferExpense(l)).toBe(jod(900));
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);

    // Today's month closes; the receipt's month stays open. The receipt is
    // corrected to 950: v1's reversal (dated today) has nowhere to post and
    // DEFERS, so v1 stays on the books.
    await closePeriod(seed, seed.periodId);
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(950), expectedCurrency: "JOD" });
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);

    // The finding: fee v2 (dated into the OPEN earlier month) is queued
    // behind the reversal — and so is payable v2 (+50, also dated there),
    // which used to post at once, moving the liability to the corrected
    // position while the clearing account still carried the old charge.
    const queued = await pending(seed);
    const reversalRow = queued.find((r) => r.kind === "REVERSE" && r.idempotencyKey === `custody_fee_reversal_${feeId}_v1`);
    const feeV2 = queued.find((r) => r.idempotencyKey === `custody_fee_paid_${feeId}_v2`);
    const payableV2 = queued.find((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v2`);
    expect(reversalRow?.status).toBe("PENDING");
    expect(feeV2?.status).toBe("PENDING");
    expect(feeV2?.reason).toMatch(/Waiting on a predecessor: custody fee posting v1/);
    expect(payableV2?.status).toBe("PENDING");
    expect(payableV2?.reason).toMatch(new RegExp(`Waiting on a predecessor: the custody posting it replaces \\(custody_fee_paid_${feeId}_v1\\) is still on the books`));
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    l = await ledger(seed);
    expect(payable(l)).toBe(-jod(200));
    expect(clearing(l)).toBe(0);
    expect(transferExpense(l)).toBe(jod(900));
    // The row states the chain's target and that the ledger is behind it.
    let row = (await readCosts(seed)).custody.find((r) => r._id === custodyId)!;
    expect(row.payableTargetMinor).toBe(jod(250));
    expect(row.payableAwaitingPost).toBe(true);
    // The gate reads the ledger: refused until the family has settled.
    expect(await familyRefusal(seed)).toMatch(/payable reclassification \(v2\) that has not posted to the ledger yet/);

    // The worker re-proves the dependency off the queued row's own payload —
    // both the fee v2 rule and the payable's, independent of the hook's reason.
    expect(await seed.t.run((ctx) => custodyPostingBlockedReason(ctx, feeV2!))).toMatch(/custody fee posting v1 it replaces is still on the books/);
    expect(await seed.t.run((ctx) => custodyPostingBlockedReason(ctx, payableV2!))).toMatch(
      /custody_fee_paid_.*_v1\) is still on the books; its reversal has not posted yet, so this would move an Employee Reimbursements Payable balance ahead of the custody posting it reflects/
    );

    // One real attempt with today's month still closed: the reversal cannot
    // post; fee v2 and payable v2 are HELD (no attempt consumed), never posted
    // ahead of it. The earlier month's snapshot — the consumer's view — still
    // carries exactly the position the primary journals support.
    await drainOnce(seed);
    const held = await pending(seed);
    for (const key of [`custody_fee_paid_${feeId}_v2`, `custody_payable_reclass_${custodyId}_v2`]) {
      const heldRow = held.find((r) => r.idempotencyKey === key)!;
      expect(heldRow.status).toBe("PENDING");
      expect(heldRow.attempts).toBe(0);
      expect(heldRow.lastError).toMatch(/Waiting to post:/);
    }
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    // (The 700 was handed over today, so the earlier month's clearing shows
    // the receipt and the 200 recognised against it: −900 + 200.)
    let earlier = await snapshotByKey(seed, earlierId);
    expect(payable(earlier)).toBe(-jod(200));
    expect(clearing(earlier)).toBe(-jod(700));
    expect(transferExpense(earlier)).toBe(jod(900));

    // Today's month reopens: the reversal lands, then fee v2, then payable v2
    // — in that order, whatever order the worker picked them up in.
    await reopenPeriod(seed, seed.periodId);
    await drainUntilSettled(seed, 6);
    expect((await pending(seed)).every((r) => r.status === "POSTED")).toBe(true);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status]).sort()).toEqual([[1, "REVERSED"], [2, "POSTED"]]);
    const reclass = await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED");
    expect(reclass.map((e) => [e.eventVersion, e.status]).sort()).toEqual([[1, "POSTED"], [2, "POSTED"]]);
    l = await ledger(seed);
    expect(payable(l)).toBe(-jod(250));
    expect(clearing(l)).toBe(0);
    expect(transferExpense(l)).toBe(jod(950));
    // Snapshot-safe: the earlier month carries the corrected receipt and both
    // deltas (all dated there); today's month carries only v1's reversal; the
    // two months sum to the ledger on every account.
    earlier = await snapshotByKey(seed, earlierId);
    const current = await snapshotByKey(seed, seed.periodId);
    expect(payable(earlier)).toBe(-jod(250));
    expect(payable(current)).toBe(0);
    expect(transferExpense(earlier) + transferExpense(current)).toBe(jod(950));
    expect(clearing(earlier) + clearing(current)).toBe(0);
    row = (await readCosts(seed)).custody.find((r) => r._id === custodyId)!;
    expect(row.payableTargetMinor).toBe(jod(250));
    expect(row.payableAwaitingPost).toBe(false);
    expect(await familyRefusal(seed)).toBeNull();
  }, 45_000);

  test("the worker holds a queued payable delta on the LEDGER alone: with the reversal row gone, v2 stays held while the replaced fee version is POSTED and posts once it is REVERSED and v2 of the fee is on the books", async () => {
    const seed = await seedDeal("payable-worker");
    const { boundary } = await splitPeriods(seed);
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(900), { paidAt: boundary - 5 * DAY });
    await closePeriod(seed, seed.periodId);
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(950), expectedCurrency: "JOD" });
    // Nothing can post the reversal for the deltas to wait on — only the
    // ledger's own state can release them.
    const reversalRow = (await pending(seed)).find((r) => r.kind === "REVERSE")!;
    await seed.t.run((ctx) => ctx.db.delete(reversalRow._id));
    await reopenPeriod(seed, seed.periodId);
    await drainOnce(seed);
    const payableV2 = (await pending(seed)).find((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v2`)!;
    expect(payableV2.status).toBe("PENDING");
    expect(payableV2.attempts).toBe(0);
    expect(payableV2.lastError).toMatch(/is still on the books; its reversal has not posted yet/);
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    // The reversal reaches the books another way; fee v2 is released, and
    // payable v2 follows it — never before it.
    const v1EventId = (await events(seed, "CUSTODY_FEE_PAID")).find((e) => e.eventVersion === 1)!._id;
    await seed.t.run((ctx) => ctx.db.patch(v1EventId, { status: "REVERSED" }));
    await drainUntilSettled(seed, 6);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status]).sort()).toEqual([[1, "REVERSED"], [2, "POSTED"]]);
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => [e.eventVersion, e.status]).sort()).toEqual([[1, "POSTED"], [2, "POSTED"]]);
    expect(payable(await ledger(seed))).toBe(-jod(250));
  }, 45_000);

  test("a payable delta waits for the REPLACEMENT too: with fee v2's forward dead-lettered, payable v2 is held on that alone, and follows once it posts", async () => {
    const seed = await seedDeal("payable-behind-replacement");
    const { boundary } = await splitPeriods(seed);
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(900), { paidAt: boundary - 5 * DAY });
    await closePeriod(seed, seed.periodId);
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(950), expectedCurrency: "JOD" });
    // The reversal is on the books (patched as the worker would leave it);
    // fee v2's forward row is dead-lettered, so the only thing the payable
    // can be waiting on is the replacement it reflects — still on its way.
    const v1EventId = (await events(seed, "CUSTODY_FEE_PAID")).find((e) => e.eventVersion === 1)!._id;
    await seed.t.run((ctx) => ctx.db.patch(v1EventId, { status: "REVERSED" }));
    const feeV2Row = (await pending(seed)).find((r) => r.idempotencyKey === `custody_fee_paid_${feeId}_v2`)!;
    await seed.t.run((ctx) => ctx.db.patch(feeV2Row._id, { status: "FAILED" }));
    const payableV2 = (await pending(seed)).find((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v2`)!;
    expect(await seed.t.run((ctx) => custodyPostingBlockedReason(ctx, payableV2))).toMatch(
      new RegExp(`the custody posting it follows \\(custody_fee_paid_${feeId}_v2\\) has not posted to the ledger yet`)
    );
    await reopenPeriod(seed, seed.periodId);
    await drainUntilSettled(seed, 3);
    expect((await pending(seed)).find((r) => r._id === payableV2._id)?.status).toBe("PENDING");
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => e.eventVersion)).toEqual([1]);
    // The fee is redriven and posts; the payable follows it.
    await seed.t.run((ctx) => ctx.db.patch(feeV2Row._id, { status: "PENDING", attempts: 0 }));
    await drainUntilSettled(seed, 4);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status]).sort()).toEqual([[1, "REVERSED"], [2, "POSTED"]]);
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => e.eventVersion).sort()).toEqual([1, 2]);
    expect(payable(await ledger(seed))).toBe(-jod(250));
  }, 45_000);

  test("a version a later correction CANCELS before it ever posted is neither awaited forever nor posted: its delta is folded into the replacement's, and two corrections under a closed month converge once it reopens", async () => {
    const seed = await seedDeal("payable-cancelled-version");
    const { boundary } = await splitPeriods(seed);
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(900), { paidAt: boundary - 5 * DAY });
    await closePeriod(seed, seed.periodId);
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(950), expectedCurrency: "JOD" });
    // Corrected again: v2 never posted, so its queued forward is CANCELLED
    // (the row is dropped) and v3 replaces it; payable v2 named v2 and is
    // dropped with it — re-issued as ONE delta (+80) to the final position,
    // never a +50 to a position no journal will ever support (H3).
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(980), expectedCurrency: "JOD" });
    const keys = (await pending(seed)).filter((r) => r.status === "PENDING").map((r) => r.idempotencyKey).sort();
    expect(keys).toEqual([
      `custody_fee_paid_${feeId}_v3`,
      `custody_fee_reversal_${feeId}_v1`,
      `custody_payable_reclass_${custodyId}_v2`,
    ].sort());
    // Until v1 is off the books nothing derived moves; payable v2 is held on v1.
    const payableV2 = (await pending(seed)).find((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v2`)!;
    expect(await seed.t.run((ctx) => custodyPostingBlockedReason(ctx, payableV2))).toMatch(new RegExp(`\\(custody_fee_paid_${feeId}_v1\\) is still on the books`));
    await reopenPeriod(seed, seed.periodId);
    await drainUntilSettled(seed, 8);
    expect((await pending(seed)).every((r) => r.status === "POSTED")).toBe(true);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status]).sort()).toEqual([[1, "REVERSED"], [3, "POSTED"]]);
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => e.eventVersion).sort()).toEqual([1, 2]);
    const l = await ledger(seed);
    expect(payable(l)).toBe(-jod(280));
    expect(transferExpense(l)).toBe(jod(980));
    expect(clearing(l)).toBe(0);
    expect(await familyRefusal(seed)).toBeNull();
  }, 45_000);

  test("a voided or unlinked line's payable release waits for the charge to leave the books", async () => {
    const seed = await seedDeal("payable-behind-void");
    const { boundary } = await splitPeriods(seed);
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(900), { paidAt: boundary - 5 * DAY });
    expect(payable(await ledger(seed))).toBe(-jod(200));
    await closePeriod(seed, seed.periodId);
    // Voided today: the reversal defers; the release of the 200 (v2, a
    // DEBIT) is dated today too, so the period holds it — and the worker's
    // own guard holds it on the ledger as well.
    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "duplicate" });
    const payableV2 = (await pending(seed)).find((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v2`)!;
    expect(payableV2.reason).toMatch(/is still on the books/);
    expect(await seed.t.run((ctx) => custodyPostingBlockedReason(ctx, payableV2))).toMatch(
      new RegExp(`\\(custody_fee_paid_${feeId}_v1\\) is still on the books`)
    );
    // The reversal row is gone; the period reopens; the release is still held.
    const reversalRow = (await pending(seed)).find((r) => r.kind === "REVERSE")!;
    await seed.t.run((ctx) => ctx.db.delete(reversalRow._id));
    await reopenPeriod(seed, seed.periodId);
    await drainOnce(seed);
    expect((await pending(seed)).find((r) => r._id === payableV2._id)?.status).toBe("PENDING");
    expect(payable(await ledger(seed))).toBe(-jod(200));
    // The charge leaves the books; the release follows.
    const v1EventId = (await events(seed, "CUSTODY_FEE_PAID"))[0]._id;
    await seed.t.run((ctx) => ctx.db.patch(v1EventId, { status: "REVERSED" }));
    await drainUntilSettled(seed, 3);
    expect(payable(await ledger(seed))).toBe(0);
  }, 45_000);

  test("same family, cash side: a reversed ISSUED leg's deferred reversal holds the payable delta that follows it", async () => {
    const seed = await seedDeal("payable-behind-cash-reversal");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(900));
    expect(payable(await ledger(seed))).toBe(-jod(200));
    await closePeriod(seed, seed.periodId);
    // Reversing the issuance puts the employee 900 out of pocket: delta +700.
    const issued = (await entries(seed, custodyId)).find((e) => e.kind === "ISSUED")!;
    await reverse(seed, custodyId, issued._id, jod(700));
    const payableV2 = (await pending(seed)).find((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v2`)!;
    expect(payableV2.reason).toMatch(new RegExp(`\\(custody_entry_${issued._id}\\) is still on the books`));
    // Ledger alone: the reversal row is gone, the period reopens, and the
    // delta stays held while the issuance is still POSTED.
    const reversalRow = (await pending(seed)).find((r) => r.kind === "REVERSE")!;
    await seed.t.run((ctx) => ctx.db.delete(reversalRow._id));
    await reopenPeriod(seed, seed.periodId);
    await drainOnce(seed);
    const heldRow = (await pending(seed)).find((r) => r._id === payableV2._id)!;
    expect(heldRow.status).toBe("PENDING");
    expect(heldRow.attempts).toBe(0);
    expect(heldRow.lastError).toMatch(/is still on the books; its reversal has not posted yet/);
    expect(payable(await ledger(seed))).toBe(-jod(200));
    const issuedEvent = (await events(seed, "CUSTODY_CASH_ISSUED"))[0];
    await seed.t.run((ctx) => ctx.db.patch(issuedEvent._id, { status: "REVERSED" }));
    await drainUntilSettled(seed, 3);
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => [e.eventVersion, e.status]).sort()).toEqual([[1, "POSTED"], [2, "POSTED"]]);
  }, 45_000);

  test("same family, first version: a fresh cash leg's payable v1 waits for the leg itself, so it can never lead it into a reopened month", async () => {
    const seed = await seedDeal("payable-v1-behind-leg");
    const { earlierId, boundary } = await splitPeriods(seed);
    await closePeriod(seed, earlierId);
    const custodyId = await openCustody(seed, jod(700));
    // A receipt today puts the employee out of pocket; a reimbursement dated
    // into the closed month follows. The leg and its delta (v2, a DEBIT)
    // both queue on the period — and the delta ALSO names the leg.
    await employeeFee(seed, custodyId, jod(900));
    await move(seed, custodyId, "REIMBURSED", jod(200), { occurredAt: boundary - 3 * DAY });
    const reimbursedEntry = (await entries(seed, custodyId)).find((e) => e.kind === "REIMBURSED")!;
    const payableV2 = (await pending(seed)).find((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v2`)!;
    expect(await seed.t.run((ctx) => custodyPostingBlockedReason(ctx, payableV2))).toMatch(
      new RegExp(`the custody posting it follows \\(custody_entry_${reimbursedEntry._id}\\) has not posted to the ledger yet`)
    );
    // The leg's row is dead-lettered: the month reopens and the delta is still held on the ledger alone.
    const legRow = (await pending(seed)).find((r) => r.idempotencyKey === `custody_entry_${reimbursedEntry._id}`)!;
    await seed.t.run((ctx) => ctx.db.patch(legRow._id, { status: "FAILED" }));
    await reopenPeriod(seed, earlierId);
    await drainOnce(seed);
    expect((await pending(seed)).find((r) => r._id === payableV2._id)?.status).toBe("PENDING");
    expect(payable(await ledger(seed))).toBe(-jod(200));
    // Redriven: the leg posts, the release follows, the liability clears.
    await seed.t.run((ctx) => ctx.db.patch(legRow._id, { status: "PENDING", attempts: 0 }));
    await drainUntilSettled(seed, 4);
    expect((await pending(seed)).every((r) => r.status === "POSTED")).toBe(true);
    expect(payable(await ledger(seed))).toBe(0);
  }, 45_000);

  test("a legacy family's migration chains its payable behind every leg and line it posted", async () => {
    const seed = await seedDeal("legacy-payable-deps", { templates: false });
    const t0 = Date.now() - 10 * DAY;
    const custodyId = await seed.t.run(async (ctx) => {
      const custodyId = await ctx.db.insert("financeDealCustody", {
        orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.employeeId, currency: "JOD",
        issuedMinor: jod(700), returnedMinor: 0, reimbursedMinor: 0, status: "OPEN",
        createdBy: seed.userId, createdAt: t0, updatedAt: t0,
      });
      await ctx.db.insert("financeDealCustodyEntries", {
        orgId: seed.orgId, custodyId, kind: "ISSUED", amountMinor: jod(700), method: "CASH", occurredAt: t0, recordedBy: seed.userId, recordedAt: t0,
      });
      await ctx.db.insert("financeDealFees", {
        orgId: seed.orgId, applicationId: seed.applicationId, feeType: "LICENSING", currency: "JOD",
        actualAmountMinor: jod(900), paidBy: "EMPLOYEE", paidTo: "GOVERNMENT", accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
        includedInQuotation: false, deductedFromSettlement: false, refundable: false, custodyId, paidAt: t0 + DAY,
        source: "MANUAL", createdBy: seed.userId, createdAt: t0 + DAY, updatedAt: t0 + DAY,
      });
      return custodyId;
    });
    // Every period closed: the whole family queues, the payable with it.
    await closePeriod(seed, seed.periodId);
    await seed.asUser.mutation(api.financeDealCosts.migrateLegacyCustodyToLedger, { orgId: seed.orgId, custodyId, idempotencyKey: crypto.randomUUID() });
    const payableV1 = (await pending(seed)).find((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v1`)!;
    const deps = parseCustodyDependencies(payableV1.payload);
    expect(deps?.map((d) => d.must)).toEqual(["SETTLED", "SETTLED"]);
    expect(deps?.map((d) => d.idempotencyKey).sort()).toEqual(
      (await pending(seed)).filter((r) => r.kind === "POST" && r._id !== payableV1._id).map((r) => r.idempotencyKey).sort()
    );
    expect(await seed.t.run((ctx) => custodyPostingBlockedReason(ctx, payableV1))).toMatch(/has not posted to the ledger yet/);
    await reopenPeriod(seed, seed.periodId);
    await drainUntilSettled(seed, 6);
    expect((await pending(seed)).every((r) => r.status === "POSTED")).toBe(true);
    expect(payable(await ledger(seed))).toBe(-jod(200));
    expect(await familyRefusal(seed)).toBeNull();
  }, 45_000);

  test("dependencies the worker cannot read fail CLOSED, and a delta that names none is released by the chain rule alone", async () => {
    const seed = await seedDeal("payable-deps-parse");
    const custodyId = await openCustody(seed, jod(700));
    // The row as the hook queues it — under its canonical key, which the
    // worker now proves before anything else (R8, F3).
    const base = { orgId: seed.orgId, idempotencyKey: `custody_payable_reclass_${custodyId}_v1`, eventType: "CUSTODY_PAYABLE_RECLASSIFIED", eventVersion: 1, sourceType: "financeDealCustody", sourceId: custodyId.toString() };
    const blocked = (payload: unknown) => seed.t.run((ctx) => custodyPostingBlockedReason(ctx, { ...base, payload }));
    expect(await blocked({ custodyId })).toBeNull();
    expect(await blocked({ custodyId, ledgerDependencies: [] })).toBeNull();
    for (const bad of ["x", [{ must: "SETTLED" }], [{ must: "POSTED", idempotencyKey: "k" }], [{ must: "SETTLED", idempotencyKey: "" }], [null]]) {
      expect(await blocked({ custodyId, ledgerDependencies: bad })).toMatch(/ledger dependencies that cannot be read/);
    }
    expect(parseCustodyDependencies({ ledgerDependencies: [{ must: "OFF_BOOKS", idempotencyKey: "k" }] })).toEqual([{ must: "OFF_BOOKS", idempotencyKey: "k" }]);
    expect(parseCustodyDependencies(undefined)).toEqual([]);
    expect(parseCustodyDependencies({ ledgerDependencies: 3 })).toBeNull();
  });
});

describe("G6 — the family proof bounds the DOCUMENTS it reads, refusing before platform-scale reads", () => {
  test("a handful of lines whose ledger families are event-heavy refuse at the document budget, not at a per-source count", async () => {
    const seed = await seedDeal("event-heavy");
    const custodyId = await openCustody(seed, jod(700));
    const feeIds: Id<"financeDealFees">[] = [];
    for (let n = 0; n < 5; n += 1) feeIds.push(await employeeFee(seed, custodyId, jod(100)));
    expect(await familyRefusal(seed)).toBeNull();
    // Each line's family grows by 350 FAILED attempts at later versions —
    // rows the row-by-row judgement ignores (not POSTED), which is exactly
    // why the previous budget (one unit per line) admitted all 1,750 of them.
    const perLine = 350;
    const template = (await events(seed, "CUSTODY_FEE_PAID"))[0];
    await seed.t.run(async (ctx) => {
      for (const feeId of feeIds) {
        for (let version = 2; version < 2 + perLine; version += 1) {
          const { _id: _drop, _creationTime: _ct, journalEntryId: _j, ...rest } = template;
          await ctx.db.insert("accountingEvents", {
            ...rest, sourceId: feeId.toString(), eventVersion: version, status: "FAILED",
            idempotencyKey: `custody_fee_paid_${feeId}_v${version}`,
          });
        }
      }
    });
    expect(5 * (perLine + 1)).toBeGreaterThan(MAX_CUSTODY_LEDGER_PROOFS);
    await expect(familyRefusal(seed)).rejects.toThrow(new RegExp(`more than ${MAX_CUSTODY_LEDGER_PROOFS} ledger postings`));
  }, 45_000);

  test("the budget charges what each read returns and sizes the next read to one past what is left", () => {
    const budget = new CustodyLedgerReadBudget(10, "the test");
    const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));
    expect(budget.take(500)).toBe(11);
    budget.charge(docs(4));
    expect(budget.take(500)).toBe(7);
    expect(budget.take(2)).toBe(3);
    budget.charge(docs(6));
    expect(budget.documentsRead).toBe(10);
    // Exhausted: the next read may fetch exactly one document, and that one refuses.
    expect(budget.take(500)).toBe(1);
    expect(() => budget.charge(docs(1))).toThrow(/more than 10 ledger postings, which is past what the test can verify/);
    expect(() => budget.charge(docs(0))).toThrow();
  });

  test("a family under the budget still reads every document and passes; the count is the documents, not the sources", async () => {
    const seed = await seedDeal("event-light");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(650));
    // 1 custody row + 1 ever-posted line + 1 entry + the entry's forward event
    // + the custody source family (payable v1... none here: 650 < 700) + the
    // fee's family (1 event): a few documents, well under the bound.
    const spent = await seed.t.run(async (ctx) => {
      const budget = new CustodyLedgerReadBudget(MAX_CUSTODY_LEDGER_PROOFS, "counting");
      const rows = await loadCustodyPostedLines(ctx, seed.applicationId, "counting", budget);
      expect(rows).toHaveLength(1);
      return budget.documentsRead;
    });
    // One line at one version: the probe that finds version 1, the batch
    // that reads the line, and the empty probe past it (R7, F1 — the
    // ever-posted lines are read version by version, in batches).
    expect(spent).toBe(3);
    expect(await familyRefusal(seed)).toBeNull();
  });
});

describe("G7 — a write-off is derived too: it never overtakes the receipt whose shortage it absorbs", () => {
  test("a receipt queued into a closed month, then a write-off today: the write-off is queued behind the receipt, held by the worker, and Cash Over/Short only moves once the receipt is on the books", async () => {
    const seed = await seedDeal("writeoff-behind-fee");
    const { earlierId, boundary } = await splitPeriods(seed);
    await closePeriod(seed, earlierId);
    const custodyId = await openCustody(seed, jod(700));
    // 600 paid in the closed month: the receipt waits; the clearing account
    // still shows the full 700 as held.
    const feeId = await employeeFee(seed, custodyId, jod(600), { paidAt: boundary - 5 * DAY });
    expect((await events(seed, "CUSTODY_FEE_PAID"))).toHaveLength(0);
    expect(clearing(await ledger(seed))).toBe(jod(700));
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
      idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "short", writeOffReason: "lost 100",
    });
    // The write-off is dated today (open) — and still does not post: the
    // shortage it absorbs is what a receipt the ledger does not carry leaves.
    expect(await events(seed, "CUSTODY_WRITTEN_OFF")).toHaveLength(0);
    expect((await ledger(seed))[SYSTEM_KEYS.CASH_OVER_SHORT] ?? 0).toBe(0);
    const writeOff = (await pending(seed)).find((r) => r.idempotencyKey === `custody_written_off_${custodyId}_v1`)!;
    expect(writeOff.status).toBe("PENDING");
    expect(writeOff.reason).toMatch(new RegExp(`Waiting on a predecessor: the custody posting it follows \\(custody_fee_paid_${feeId}_v1\\) has not posted`));
    expect(parseCustodyDependencies(writeOff.payload)?.map((d) => d.idempotencyKey)).toEqual(
      expect.arrayContaining([`custody_fee_paid_${feeId}_v1`])
    );
    expect(await seed.t.run((ctx) => custodyPostingBlockedReason(ctx, writeOff))).toMatch(/so this would absorb a shortage the clearing account does not yet show/);
    // One real attempt: the receipt cannot post (closed month); the write-off is held, no attempt consumed.
    await drainOnce(seed);
    const held = (await pending(seed)).find((r) => r._id === writeOff._id)!;
    expect(held.status).toBe("PENDING");
    expect(held.attempts).toBe(0);
    expect(held.lastError).toMatch(/Waiting to post:/);
    expect(await events(seed, "CUSTODY_WRITTEN_OFF")).toHaveLength(0);
    // The month reopens: receipt, then write-off. The books close to zero.
    await reopenPeriod(seed, earlierId);
    await drainUntilSettled(seed, 6);
    expect((await pending(seed)).every((r) => r.status === "POSTED")).toBe(true);
    const l = await ledger(seed);
    expect(clearing(l)).toBe(0);
    expect(transferExpense(l)).toBe(jod(600));
    expect(l[SYSTEM_KEYS.CASH_OVER_SHORT]).toBe(jod(100));
    expect(await familyRefusal(seed)).toBeNull();
  }, 45_000);

  test("a write-off with every leg and line on the books posts at once, as before", async () => {
    const seed = await seedDeal("writeoff-ready");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(600));
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
      idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "short", writeOffReason: "lost 100",
    });
    expect((await events(seed, "CUSTODY_WRITTEN_OFF")).map((e) => e.status)).toEqual(["POSTED"]);
    expect((await ledger(seed))[SYSTEM_KEYS.CASH_OVER_SHORT]).toBe(jod(100));
  });
});

// ---------------------------------------------------------------------------
// Follow-up audit on 50466e63c: H1 the family proof charges every document
// it was handed; H2 a write-off waits for a removed line's charge to leave
// the books; H3 a payable delta for a version cancelled before it posted is
// folded into the version that replaces it, never posted on its own.
// ---------------------------------------------------------------------------

describe("H1 — the family proof charges the live lines it was handed, so its document bound is literal", () => {
  test("live dealer-paid lines that never posted still count: a family that reads exactly the budget without them refuses with them", async () => {
    const seed = await seedDeal("budget-live-lines");
    const custodyId = await openCustody(seed, jod(700));
    const custodyLines = 4;
    const feeIds: Id<"financeDealFees">[] = [];
    for (let n = 0; n < custodyLines; n += 1) feeIds.push(await employeeFee(seed, custodyId, jod(100)));
    // Documents the proof reads besides the dealer lines below: 1 custody
    // row, the 4 live custody lines, the 4 ever-posted lines plus the two
    // version probes that enumerate them (R7, F1: the probe that finds
    // version 1 and the empty probe past it), 1 movement, its forward
    // event, the custody's own family (empty: 400 < 700 leaves no payable),
    // and each fee's family — its POSTED v1 plus `perLine` FAILED attempts
    // at later versions (under the per-source cap).
    const dealerLines = 10;
    const fixed = 1 + custodyLines + (custodyLines + 2) + 1 + 1 + 0 + custodyLines;
    const perLine = Math.floor((MAX_CUSTODY_LEDGER_PROOFS - fixed) / custodyLines);
    const remainder = MAX_CUSTODY_LEDGER_PROOFS - fixed - custodyLines * perLine;
    const template = (await events(seed, "CUSTODY_FEE_PAID"))[0];
    await seed.t.run(async (ctx) => {
      for (const feeId of feeIds) {
        const count = perLine + (feeId === feeIds[0] ? remainder : 0);
        for (let version = 2; version < 2 + count; version += 1) {
          const { _id: _drop, _creationTime: _ct, journalEntryId: _j, ...rest } = template;
          await ctx.db.insert("accountingEvents", {
            ...rest, sourceId: feeId.toString(), eventVersion: version, status: "FAILED", idempotencyKey: `custody_fee_paid_${feeId}_v${version}`,
          });
        }
      }
    });
    // Control: exactly the budget, and the proof passes.
    expect(fixed + custodyLines * perLine + remainder).toBe(MAX_CUSTODY_LEDGER_PROOFS);
    expect(await familyRefusal(seed)).toBeNull();
    // Ten live dealer-paid lines — handed to the proof, never posted — take
    // it past the budget: it must refuse, not read them for free.
    for (let n = 0; n < dealerLines; n += 1) await employeeFee(seed, undefined, jod(1), { paidBy: "DEALER" });
    await expect(familyRefusal(seed)).rejects.toThrow(new RegExp(`more than ${MAX_CUSTODY_LEDGER_PROOFS} ledger postings`));
  }, 45_000);
});

describe("H2 — a write-off is chained behind the reversal of every charge the record no longer carries", () => {
  test("voided line, deferred reversal: the write-off is held on v1 OFF_BOOKS at the hook and by the worker on the ledger alone; it posts once v1 is REVERSED, and reopen → re-close converges", async () => {
    const seed = await seedDeal("writeoff-behind-void");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(900));
    expect(payable(await ledger(seed))).toBe(-jod(200));
    await closePeriod(seed, seed.periodId);
    // The line is removed: its reversal defers (v1 stays POSTED) and the row
    // now says the employee holds 700 unaccounted for.
    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "wrong line" });
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    // The dependencies a derived posting on this record is chained behind
    // name the removed line's live version as OFF the books.
    const deps = await seed.t.run(async (ctx) => {
      const custody = (await ctx.db.get(custodyId))!;
      return await custodyPositionDependencies(ctx, custody, "the test");
    });
    expect(deps).toEqual(expect.arrayContaining([{ must: "OFF_BOOKS", idempotencyKey: `custody_fee_paid_${feeId}_v1` }]));
    expect(deps.filter((d) => d.idempotencyKey === `custody_fee_paid_${feeId}_v1`)).toHaveLength(1);

    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
      idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "short", writeOffReason: "lost 700",
    });
    const writeOff = (await pending(seed)).find((r) => r.idempotencyKey === `custody_written_off_${custodyId}_v1`)!;
    expect(writeOff.status).toBe("PENDING");
    expect(writeOff.reason).toMatch(new RegExp(`Waiting on a predecessor: the custody posting it replaces \\(custody_fee_paid_${feeId}_v1\\) is still on the books`));
    expect(parseCustodyDependencies(writeOff.payload)).toEqual(expect.arrayContaining([{ must: "OFF_BOOKS", idempotencyKey: `custody_fee_paid_${feeId}_v1` }]));
    expect(await seed.t.run((ctx) => custodyPostingBlockedReason(ctx, writeOff))).toMatch(
      new RegExp(`\\(custody_fee_paid_${feeId}_v1\\) is still on the books.*so this would absorb a shortage the clearing account does not yet show`)
    );

    // Ledger alone: the reversal row is gone and the month reopens. The
    // write-off (dated today, postable by period) must stay held while the
    // charge it no longer carries is still POSTED — otherwise Cash Over/Short
    // absorbs 700 while the 900 expense is still on the books.
    const reversalRow = (await pending(seed)).find((r) => r.kind === "REVERSE")!;
    await seed.t.run((ctx) => ctx.db.delete(reversalRow._id));
    await reopenPeriod(seed, seed.periodId);
    await drainOnce(seed);
    const held = (await pending(seed)).find((r) => r._id === writeOff._id)!;
    expect(held.status).toBe("PENDING");
    expect(held.attempts).toBe(0);
    expect(held.lastError).toMatch(/is still on the books; its reversal has not posted yet/);
    expect(await events(seed, "CUSTODY_WRITTEN_OFF")).toHaveLength(0);
    expect((await ledger(seed))[SYSTEM_KEYS.CASH_OVER_SHORT] ?? 0).toBe(0);

    // The charge leaves the books; the write-off follows, and the payable
    // release (also held on v1) with it.
    const v1EventId = (await events(seed, "CUSTODY_FEE_PAID"))[0]._id;
    await seed.t.run((ctx) => ctx.db.patch(v1EventId, { status: "REVERSED" }));
    await drainUntilSettled(seed, 4);
    expect((await pending(seed)).every((r) => r.status === "POSTED")).toBe(true);
    expect((await events(seed, "CUSTODY_WRITTEN_OFF")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    expect((await ledger(seed))[SYSTEM_KEYS.CASH_OVER_SHORT]).toBe(jod(700));
    expect(payable(await ledger(seed))).toBe(0);

    // Reopen: the write-off is reversed at once (open period); the record
    // re-closes at v2 with the same dependencies and posts at once; nothing
    // doubles.
    await seed.asUser.mutation(api.financeDealCosts.reopenDealCustody, { orgId: seed.orgId, custodyId, reason: "recount" });
    expect((await events(seed, "CUSTODY_WRITTEN_OFF")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "REVERSED"]]);
    expect((await ledger(seed))[SYSTEM_KEYS.CASH_OVER_SHORT]).toBe(0);
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
      idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "short again", writeOffReason: "still lost",
    });
    expect((await events(seed, "CUSTODY_WRITTEN_OFF")).map((e) => [e.eventVersion, e.status]).sort()).toEqual([[1, "REVERSED"], [2, "POSTED"]]);
    expect((await ledger(seed))[SYSTEM_KEYS.CASH_OVER_SHORT]).toBe(jod(700));
  }, 60_000);

  test("a line re-charged to another record: the first record's dependencies name the version that was charged to it as OFF the books, and no fee as settled", async () => {
    const seed = await seedDeal("writeoff-behind-recharge");
    const custodyA = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyA, jod(600));
    // A second custodian on the deal: the line moves to their record.
    const otherId = await seed.t.run((ctx) => ctx.db.insert("users", { clerkId: "cu_other_recharge", email: "other.recharge@x.com", name: "Omar" }));
    const ownerRole = (await seed.t.run((ctx) => ctx.db.query("roles").collect())).find((r) => r.orgId === seed.orgId && r.name === "OWNER")!;
    await seed.t.run((ctx) => ctx.db.insert("memberships", { orgId: seed.orgId, userId: otherId, roleId: ownerRole._id }));
    const custodyB = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId, userId: otherId, issuedMinor: jod(600), method: "CASH",
    });
    await closePeriod(seed, seed.periodId);
    await seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId, custodyId: custodyB });
    // v1 (on A) is still POSTED under a deferred reversal; v2 (on B) is queued behind it.
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    const deps = await seed.t.run(async (ctx) => {
      const custody = (await ctx.db.get(custodyA))!;
      return await custodyPositionDependencies(ctx, custody, "the test");
    });
    expect(deps).toEqual(expect.arrayContaining([{ must: "OFF_BOOKS", idempotencyKey: `custody_fee_paid_${feeId}_v1` }]));
    expect(deps.some((d) => d.must === "SETTLED" && d.idempotencyKey.startsWith("custody_fee_paid_"))).toBe(false);
  }, 45_000);
});

describe("H3 — a payable delta for a version cancelled before it posted is folded into its replacement, never posted on its own", () => {
  test("two corrections under a closed month: after v1's reversal lands, the payable never moves to the cancelled v2's position while v3 is still off the books", async () => {
    const seed = await seedDeal("payable-cancelled-transient");
    const { boundary } = await splitPeriods(seed);
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(900), { paidAt: boundary - 5 * DAY });
    await closePeriod(seed, seed.periodId);
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(950), expectedCurrency: "JOD" });
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(980), expectedCurrency: "JOD" });
    // Fee v3 is dead-lettered: the only thing that can reach the books when
    // the month reopens is v1's reversal.
    const feeV3 = (await pending(seed)).find((r) => r.idempotencyKey === `custody_fee_paid_${feeId}_v3`)!;
    await seed.t.run((ctx) => ctx.db.patch(feeV3._id, { status: "FAILED" }));
    await reopenPeriod(seed, seed.periodId);
    await drainUntilSettled(seed, 3);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "REVERSED"]]);
    // The transient the audit named: with v1 off and v3 not on, no primary
    // supports any payable but v1's 200 — a delta to the cancelled v2's 250
    // (or anywhere else) must not have posted.
    // (Clearing carries the 700 issued and v1's own 200 reclassification —
    // the primaries' inverse leaves the derived posting standing until the
    // next delta corrects it; what must NOT be there is any further delta.)
    const l = await ledger(seed);
    expect(payable(l)).toBe(-jod(200));
    expect(transferExpense(l)).toBe(0);
    expect(clearing(l)).toBe(jod(900));
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    expect(payable(await snapshotByKey(seed, seed.periodId))).toBe(0);
    // v3 is redriven: it posts, and ONE delta follows it to the final position.
    await seed.t.run((ctx) => ctx.db.patch(feeV3._id, { status: "PENDING", attempts: 0 }));
    await drainUntilSettled(seed, 4);
    expect((await pending(seed)).every((r) => r.status === "POSTED")).toBe(true);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status]).sort()).toEqual([[1, "REVERSED"], [3, "POSTED"]]);
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => [e.eventVersion, e.status]).sort()).toEqual([[1, "POSTED"], [2, "POSTED"]]);
    const final = await ledger(seed);
    expect(payable(final)).toBe(-jod(280));
    expect(transferExpense(final)).toBe(jod(980));
    expect(clearing(final)).toBe(0);
    const row = (await readCosts(seed)).custody.find((r) => r._id === custodyId)!;
    expect(row.payableTargetMinor).toBe(jod(280));
    expect(row.payableReclassVersion).toBe(2);
    expect(row.payableAwaitingPost).toBe(false);
    expect(await familyRefusal(seed)).toBeNull();
  }, 60_000);

  test("the shape: the cancelled version's delta is dropped and its replacement carries the whole position's dependencies from the last posted base", async () => {
    const seed = await seedDeal("payable-cancelled-shape");
    const { boundary } = await splitPeriods(seed);
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(900), { paidAt: boundary - 5 * DAY });
    await closePeriod(seed, seed.periodId);
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(950), expectedCurrency: "JOD" });
    const before = (await pending(seed)).find((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v2`)!;
    expect((before.payload as { deltaMinor: number }).deltaMinor).toBe(jod(50));
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(980), expectedCurrency: "JOD" });
    const keys = (await pending(seed)).filter((r) => r.status === "PENDING").map((r) => r.idempotencyKey).sort();
    expect(keys).toEqual([
      `custody_fee_paid_${feeId}_v3`,
      `custody_fee_reversal_${feeId}_v1`,
      `custody_payable_reclass_${custodyId}_v2`,
    ].sort());
    const folded = (await pending(seed)).find((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v2`)!;
    expect(folded._id).not.toBe(before._id);
    expect((folded.payload as { deltaMinor: number; payableAfterMinor: number }).deltaMinor).toBe(jod(80));
    expect((folded.payload as { payableAfterMinor: number }).payableAfterMinor).toBe(jod(280));
    const deps = parseCustodyDependencies(folded.payload)!;
    expect(deps).toEqual(expect.arrayContaining([
      { must: "OFF_BOOKS", idempotencyKey: `custody_fee_paid_${feeId}_v1` },
      { must: "SETTLED", idempotencyKey: `custody_fee_paid_${feeId}_v3` },
    ]));
    // The cancelled version is never AWAITED: named OFF the books at most
    // (trivially true of a version that never posted), never SETTLED.
    expect(deps.some((d) => d.must === "SETTLED" && d.idempotencyKey === `custody_fee_paid_${feeId}_v2`)).toBe(false);
    const row = (await readCosts(seed)).custody.find((r) => r._id === custodyId)!;
    expect(row.payableReclassVersion).toBe(2);
    expect(row.payableTargetMinor).toBe(jod(280));
    // Held on v1 by the worker, exactly as an ordinary delta would be.
    expect(await seed.t.run((ctx) => custodyPostingBlockedReason(ctx, folded))).toMatch(new RegExp(`\\(custody_fee_paid_${feeId}_v1\\) is still on the books`));
  }, 45_000);

  test("a version the row says it issued that is neither on the ledger nor in the outbox refuses the next movement — the chain is never re-based on a link nobody can see", async () => {
    const seed = await seedDeal("payable-untraceable");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(900));
    expect(payable(await ledger(seed))).toBe(-jod(200));
    // v1 is POSTED; the row claims a v2 that exists nowhere.
    await seed.t.run((ctx) => ctx.db.patch(custodyId, { payableReclassVersion: 2, payableTargetMinor: jod(250) }));
    await expect(move(seed, custodyId, "REIMBURSED", jod(100))).rejects.toThrow(/payable reclassification v2 is neither on the ledger nor waiting in the outbox/);
    expect((await entries(seed, custodyId)).filter((e) => e.kind === "REIMBURSED")).toHaveLength(0);
    expect(payable(await ledger(seed))).toBe(-jod(200));
  });

  test("cash side: a queued leg's delta is dropped when the leg is reversed before it posted, and the position posts straight to what the ledger supports", async () => {
    const seed = await seedDeal("payable-cancelled-leg");
    const { earlierId, boundary } = await splitPeriods(seed);
    await closePeriod(seed, earlierId);
    // Cash handed over in the closed month: the leg and the record's first
    // delta both wait. A receipt today posts at once.
    const custodyId = await openCustody(seed, jod(700), { occurredAt: boundary - 3 * DAY });
    await employeeFee(seed, custodyId, jod(900));
    expect(payable(await ledger(seed))).toBe(0);
    expect((await pending(seed)).filter((r) => r.status === "PENDING").map((r) => r.idempotencyKey)).toEqual(
      expect.arrayContaining([`custody_payable_reclass_${custodyId}_v1`])
    );
    // The issuance was a mistake and is reversed before it ever posted: the
    // employee is 900 out of pocket, and nothing the ledger carries supports
    // the 200 that v1 would have credited.
    const issued = (await entries(seed, custodyId)).find((e) => e.kind === "ISSUED")!;
    await reverse(seed, custodyId, issued._id, jod(700));
    // The queued v1 (+200 behind a leg that will never post) is dropped and
    // v1 is re-issued as the whole position from a base of nothing: +900,
    // with nothing left to wait for, so it posts at once.
    expect((await pending(seed)).filter((r) => r.status === "PENDING")).toEqual([]);
    const reclass = await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED");
    expect(reclass.map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    expect((reclass[0].payload as { deltaMinor: number }).deltaMinor).toBe(jod(900));
    expect(payable(await ledger(seed))).toBe(-jod(900));
    expect(clearing(await ledger(seed))).toBe(0);
    expect(await familyRefusal(seed)).toBeNull();
  }, 45_000);
});

// ---------------------------------------------------------------------------
// R5 — the exact-SHA re-review of 9636b295d (Sonnet + Codex, CHANGES REQUESTED)
// ---------------------------------------------------------------------------

/** A second custodian on the deal — an org member the issuer can hand cash to. */
async function secondCustodian(seed: Seed, suffix: string): Promise<Id<"users">> {
  const otherId = await seed.t.run((ctx) => ctx.db.insert("users", { clerkId: `cu_other_${suffix}`, email: `other.${suffix}@x.com`, name: "Omar" }));
  const ownerRole = (await seed.t.run((ctx) => ctx.db.query("roles").collect())).find((r) => r.orgId === seed.orgId && r.name === "OWNER")!;
  await seed.t.run((ctx) => ctx.db.insert("memberships", { orgId: seed.orgId, userId: otherId, roleId: ownerRole._id }));
  return otherId;
}

const writeOff = (seed: Seed, custodyId: Id<"financeDealCustody">, reason: string) =>
  seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
    idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "checked", writeOffReason: reason,
  });

describe("R5-F1 — a reopened record's write-off that is still on the books holds every derived posting that follows it", () => {
  test("write-off posted → month closed → reopen defers the reversal → a fee paid in an open earlier month: the fee posts, its payable delta is held on the write-off OFF_BOOKS by the hook and by the worker, no snapshot moves, and it converges once the reversal lands", async () => {
    const seed = await seedDeal("r5-writeoff-reopen");
    const { earlierId, boundary } = await splitPeriods(seed);
    const custodyId = await openCustody(seed, jod(700));
    await writeOff(seed, custodyId, "lost 700");
    expect((await ledger(seed))[SYSTEM_KEYS.CASH_OVER_SHORT]).toBe(jod(700));
    await closePeriod(seed, seed.periodId);
    await seed.asUser.mutation(api.financeDealCosts.reopenDealCustody, { orgId: seed.orgId, custodyId, reason: "receipt found" });
    // The reversal is deferred: v1 is STILL POSTED, the row no longer names it.
    expect((await events(seed, "CUSTODY_WRITTEN_OFF")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))!.writeOffPosted).toBeUndefined();

    // The receipt turns up, paid in the earlier month, which is open: the
    // primary posts there at once...
    await employeeFee(seed, custodyId, jod(900), { paidAt: boundary - 5 * DAY });
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    // ...and the derived delta (the employee is now 200 out of pocket) must
    // NOT: the clearing account still carries the write-off's credit.
    const reclass = (await pending(seed)).find((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v1`);
    expect(reclass?.status).toBe("PENDING");
    expect(reclass?.reason).toMatch(new RegExp(`\\(custody_written_off_${custodyId}_v1\\) is still on the books`));
    expect(parseCustodyDependencies(reclass!.payload)).toEqual(
      expect.arrayContaining([{ must: "OFF_BOOKS", idempotencyKey: `custody_written_off_${custodyId}_v1` }])
    );
    expect(await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).toHaveLength(0);
    expect(payable(await ledger(seed))).toBe(0);
    expect(payable(await snapshotByKey(seed, earlierId))).toBe(0);
    // The worker re-proves it off the row: dated into the OPEN month, only the
    // dependency holds it.
    expect(await seed.t.run((ctx) => custodyPostingBlockedReason(ctx, reclass!))).toMatch(
      new RegExp(`\\(custody_written_off_${custodyId}_v1\\) is still on the books`)
    );
    await drainOnce(seed);
    expect((await pending(seed)).find((r) => r._id === reclass!._id)?.status).toBe("PENDING");
    expect(payable(await ledger(seed))).toBe(0);
    expect(await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).toHaveLength(0);
    expect(await familyRefusal(seed)).toMatch(/still has its write-off on the books/);

    // The month reopens: the reversal posts, then the delta, and the family is whole.
    await reopenPeriod(seed, seed.periodId);
    await drainUntilSettled(seed, 4);
    expect((await pending(seed)).every((r) => r.status === "POSTED")).toBe(true);
    expect((await events(seed, "CUSTODY_WRITTEN_OFF")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "REVERSED"]]);
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    const l = await ledger(seed);
    expect(l[SYSTEM_KEYS.CASH_OVER_SHORT]).toBe(0);
    expect(payable(l)).toBe(-jod(200));
    expect(clearing(l)).toBe(0);
    expect(transferExpense(l)).toBe(jod(900));
    expect(await familyRefusal(seed)).toBeNull();
    // And paying the shortfall afterwards finds nothing left to wait for.
    await move(seed, custodyId, "REIMBURSED", jod(200));
    expect((await pending(seed)).filter((r) => r.status === "PENDING")).toEqual([]);
    expect(payable(await ledger(seed))).toBe(0);
  }, 60_000);

  test("the position names every other POSTED write-off version OFF the books, and never the version the row still claims", async () => {
    const seed = await seedDeal("r5-writeoff-deps");
    const custodyId = await openCustody(seed, jod(700));
    await writeOff(seed, custodyId, "lost 700");
    const closed = (await seed.t.run((ctx) => ctx.db.get(custodyId)))!;
    expect(closed.writeOffPosted?.version).toBe(1);
    const claimed = await seed.t.run((ctx) => custodyPositionDependencies(ctx, closed, "the test"));
    expect(claimed.some((d) => d.idempotencyKey.startsWith("custody_written_off_"))).toBe(false);
    await closePeriod(seed, seed.periodId);
    await seed.asUser.mutation(api.financeDealCosts.reopenDealCustody, { orgId: seed.orgId, custodyId, reason: "recount" });
    const reopened = (await seed.t.run((ctx) => ctx.db.get(custodyId)))!;
    const deps = await seed.t.run((ctx) => custodyPositionDependencies(ctx, reopened, "the test"));
    expect(deps.filter((d) => d.idempotencyKey.startsWith("custody_written_off_"))).toEqual([
      { must: "OFF_BOOKS", idempotencyKey: `custody_written_off_${custodyId}_v1` },
    ]);
  }, 30_000);
});

describe("R5-F2 — a record's position depends on the charges attributed to IT, never on another custodian's live charge", () => {
  test("recharge A → B under a closed month, reopen, drain: v1 reverses, v2 posts on B, and every later movement, write-off and finalization proof on A completes with nothing left queued", async () => {
    const seed = await seedDeal("r5-recharge-converges");
    const custodyA = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyA, jod(900));
    expect(payable(await ledger(seed))).toBe(-jod(200));
    const otherId = await secondCustodian(seed, "r5-recharge");
    const custodyB = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId, userId: otherId, issuedMinor: jod(600), method: "CASH",
    });
    await closePeriod(seed, seed.periodId);
    await seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId, custodyId: custodyB });
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    await reopenPeriod(seed, seed.periodId);
    await drainUntilSettled(seed, 4);
    expect((await pending(seed)).every((r) => r.status === "POSTED")).toBe(true);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status]).sort()).toEqual([[1, "REVERSED"], [2, "POSTED"]]);
    // A released its 200; B is owed 300 on the line it now carries.
    expect(payable(await ledger(seed))).toBe(-jod(300));

    // A's position is its own: B's live v2 is not something A waits on.
    const depsA = await seed.t.run(async (ctx) => custodyPositionDependencies(ctx, (await ctx.db.get(custodyA))!, "the test"));
    expect(depsA.some((d) => d.idempotencyKey.startsWith("custody_fee_paid_"))).toBe(false);
    // B's names its own version SETTLED and nothing of A's.
    const depsB = await seed.t.run(async (ctx) => custodyPositionDependencies(ctx, (await ctx.db.get(custodyB))!, "the test"));
    expect(depsB.filter((d) => d.idempotencyKey.startsWith("custody_fee_paid_"))).toEqual([
      { must: "SETTLED", idempotencyKey: `custody_fee_paid_${feeId}_v2` },
    ]);

    // A new charge on A posts at once, with its payable delta — nothing queues.
    const feeA = await employeeFee(seed, custodyA, jod(800));
    expect((await pending(seed)).filter((r) => r.status === "PENDING")).toEqual([]);
    expect(payable(await ledger(seed))).toBe(-jod(400));
    // Removing it releases at once.
    await seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId: feeA, reason: "wrong line" });
    expect((await pending(seed)).filter((r) => r.status === "PENDING")).toEqual([]);
    expect(payable(await ledger(seed))).toBe(-jod(300));
    // And A's shortage is written off at once — the derived posting the
    // review named as deadlocked behind B's legitimate charge.
    await writeOff(seed, custodyA, "lost 700");
    expect((await pending(seed)).filter((r) => r.status === "PENDING")).toEqual([]);
    expect((await events(seed, "CUSTODY_WRITTEN_OFF")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    expect((await ledger(seed))[SYSTEM_KEYS.CASH_OVER_SHORT]).toBe(jod(700));
    expect((await seed.t.run((ctx) => ctx.db.get(custodyA)))!.status).toBe("WRITTEN_OFF");
    // B settles too, and the deal's family proves whole.
    await move(seed, custodyB, "REIMBURSED", jod(300));
    expect((await pending(seed)).filter((r) => r.status === "PENDING")).toEqual([]);
    expect(payable(await ledger(seed))).toBe(0);
    expect(await familyRefusal(seed)).toBeNull();
  }, 90_000);

  test("attribution is read from the ledger, never guessed: a POSTED charge whose event names no custody, one that is not an id, or one on a record not of this deal refuses the proof and the write-off behind it", async () => {
    const seed = await seedDeal("r5-recharge-attribution");
    const custodyA = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyA, jod(900));
    const otherId = await secondCustodian(seed, "r5-attr");
    const custodyB = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId, userId: otherId, issuedMinor: jod(600), method: "CASH",
    });
    await seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId, custodyId: custodyB });
    const v2 = (await events(seed, "CUSTODY_FEE_PAID")).find((e) => e.eventVersion === 2)!;
    expect(v2.status).toBe("POSTED");
    const original = v2.payload as Record<string, unknown>;
    const depsOf = (custodyId: Id<"financeDealCustody">) =>
      seed.t.run(async (ctx) => custodyPositionDependencies(ctx, (await ctx.db.get(custodyId))!, "writing off a custody shortage"));
    const foreignCustody = await seed.t.run((ctx) =>
      ctx.db.insert("financeDealCustody", {
        orgId: seed.otherOrgId, applicationId: seed.applicationId, userId: otherId, currency: "JOD",
        issuedMinor: 0, returnedMinor: 0, reimbursedMinor: 0, status: "OPEN", createdBy: seed.userId, createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    for (const payload of [
      Object.fromEntries(Object.entries(original).filter(([key]) => key !== "custodyId")),
      { ...original, custodyId: "not-an-id" },
      { ...original, custodyId: 7 },
      { ...original, custodyId: foreignCustody.toString() },
    ]) {
      await seed.t.run((ctx) => ctx.db.patch(v2._id, { payload }));
      await expect(depsOf(custodyA)).rejects.toThrow(/cannot be attributed to a custody record/);
      // The mutation boundary: nothing is written.
      await expect(writeOff(seed, custodyA, "lost 700")).rejects.toThrow(/cannot be attributed to a custody record/);
      expect((await seed.t.run((ctx) => ctx.db.get(custodyA)))!.status).toBe("OPEN");
      expect(await events(seed, "CUSTODY_WRITTEN_OFF")).toHaveLength(0);
    }
    // Restored, the proof is clean and the write-off posts.
    await seed.t.run((ctx) => ctx.db.patch(v2._id, { payload: original }));
    expect((await depsOf(custodyA)).some((d) => d.idempotencyKey.startsWith("custody_fee_paid_"))).toBe(false);
    await writeOff(seed, custodyA, "lost 700");
    expect((await events(seed, "CUSTODY_WRITTEN_OFF")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
  }, 60_000);
});

describe("R5-F3 — a stopped deal takes no NEW custody cash, judged inside the command", () => {
  test.each(["CANCELLED", "REJECTED"] as const)(
    "%s: opening custody and issuing more are refused with nothing written; settling existing custody and exact replays still work; the read says why",
    async (status) => {
      const seed = await seedDeal(`r5-stop-${status}`);
      const custodyId = await openCustody(seed, jod(700), { idempotencyKey: "open-1" });
      await move(seed, custodyId, "ISSUED", jod(100), { idempotencyKey: "issue-1" });
      expect((await readCosts(seed)).acceptsNewCustodyCash).toEqual({ accepts: true });
      await seed.t.run((ctx) => ctx.db.patch(seed.applicationId, { status }));
      expect((await readCosts(seed)).acceptsNewCustodyCash).toEqual({ accepts: false, reason: `APPLICATION_${status}` });

      const refusal = status === "CANCELLED" ? /cancelled/i : /rejected/i;
      await expect(
        seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
          idempotencyKey: "open-2", orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.viewerId, issuedMinor: jod(50), method: "CASH",
        })
      ).rejects.toThrow(refusal);
      await expect(move(seed, custodyId, "ISSUED", jod(50), { idempotencyKey: "issue-2" })).rejects.toThrow(refusal);
      // Nothing written: one record, two issuances, two journals, one command each.
      const rows = await seed.t.run((ctx) => ctx.db.query("financeDealCustody").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).collect());
      expect(rows).toHaveLength(1);
      expect((await entries(seed, custodyId)).filter((e) => e.kind === "ISSUED")).toHaveLength(2);
      expect(await events(seed, "CUSTODY_CASH_ISSUED")).toHaveLength(2);
      expect(await commandRows(seed, "financeDealCosts.openDealCustody")).toHaveLength(1);
      expect(await commandRows(seed, "financeDealCosts.recordCustodyMovement")).toHaveLength(1);
      expect(clearing(await ledger(seed))).toBe(jod(800));

      // Exact replays of what succeeded before the stop return their stored results.
      expect(await openCustody(seed, jod(700), { idempotencyKey: "open-1" })).toBe(custodyId);
      expect(await move(seed, custodyId, "ISSUED", jod(100), { idempotencyKey: "issue-1" })).toBe(custodyId);
      expect(await events(seed, "CUSTODY_CASH_ISSUED")).toHaveLength(2);
      expect(clearing(await ledger(seed))).toBe(jod(800));

      // What the employee already holds still settles.
      await move(seed, custodyId, "RETURNED", jod(800));
      await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "returned in full" });
      expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))!.status).toBe("RECONCILED");
      expect(clearing(await ledger(seed))).toBe(0);
    },
    45_000
  );
});

describe("R5-F3 follow-up — an ISSUED movement whose parent application cannot be loaded is refused, never let through", () => {
  test("a custody record orphaned of its deal takes no NEW cash: nothing is written; an exact replay of the earlier issuance still returns its stored result", async () => {
    const seed = await seedDeal("r5-orphan");
    const custodyId = await openCustody(seed, jod(700), { idempotencyKey: "open-1" });
    await move(seed, custodyId, "ISSUED", jod(100), { idempotencyKey: "issue-1" });
    expect(clearing(await ledger(seed))).toBe(jod(800));

    // Only the parent application goes; the custody record, its entries and
    // its journals stay exactly as they were.
    await seed.t.run((ctx) => ctx.db.delete(seed.applicationId));

    // The lifecycle gate has no application to judge. A missing anchor is a
    // refusal, not a pass — before this fix the `if (parentApp)` branch let
    // fresh cash post against the orphaned record.
    await expect(move(seed, custodyId, "ISSUED", jod(50), { idempotencyKey: "issue-2" })).rejects.toThrow(
      /Finance application not found in this organization/
    );
    // Two issuances (the opening one and issue-1), two journals, one movement command.
    expect((await entries(seed, custodyId)).filter((e) => e.kind === "ISSUED")).toHaveLength(2);
    expect(await events(seed, "CUSTODY_CASH_ISSUED")).toHaveLength(2);
    expect(await commandRows(seed, "financeDealCosts.recordCustodyMovement")).toHaveLength(1);
    expect(clearing(await ledger(seed))).toBe(jod(800));

    // Replay ordering is unchanged: the stored result answers before the gate runs.
    expect(await move(seed, custodyId, "ISSUED", jod(100), { idempotencyKey: "issue-1" })).toBe(custodyId);
    expect(await events(seed, "CUSTODY_CASH_ISSUED")).toHaveLength(2);
    expect(await commandRows(seed, "financeDealCosts.recordCustodyMovement")).toHaveLength(1);
    expect(clearing(await ledger(seed))).toBe(jod(800));
  }, 45_000);
});

describe("R5-F4 — a cost and the custody record it is charged to share one currency, or the charge is refused before any write", () => {
  test("a legacy USD line on a JOD deal: it is ineligible, attaching it, re-recording it onto a record and charging a line at creation to a foreign-currency record all refuse, and nothing posts or moves", async () => {
    const seed = await seedDeal("r5-currency-attach");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, undefined, jod(300));

    // A record in another currency (legacy) takes no line at creation: the
    // deal's own denomination proof refuses any foreign money fact before the
    // line exists, and the custody currency guard stands behind it in the
    // same command.
    const otherId = await secondCustodian(seed, "r5-currency");
    const foreign = await seed.asUser.mutation(api.financeDealCosts.openDealCustody, {
      idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, applicationId: seed.applicationId, userId: otherId, issuedMinor: jod(100), method: "CASH",
    });
    await seed.t.run((ctx) => ctx.db.patch(foreign, { currency: "USD" }));
    const before = await seed.t.run((ctx) => ctx.db.query("financeDealFees").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).collect());
    await expect(employeeFee(seed, foreign, jod(200))).rejects.toThrow(/USD/);
    const after = await seed.t.run((ctx) => ctx.db.query("financeDealFees").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).collect());
    expect(after).toHaveLength(before.length);
    expect(await events(seed, "CUSTODY_FEE_PAID")).toHaveLength(0);
    await seed.t.run((ctx) => ctx.db.patch(foreign, { currency: "JOD" }));

    await seed.t.run((ctx) => ctx.db.patch(feeId, { currency: "USD" }));
    expect((await readCosts(seed)).fees.find((f) => f._id === feeId)!.custodyEligible).toBe(false);

    // Refused at the ATTACH door itself (the action it names), not by the
    // position summary after the link and its posting were written.
    const attachRefusal = /USD.*JOD.*charging this cost to the custody record is refused/;
    await expect(seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId, custodyId })).rejects.toThrow(attachRefusal);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: 31_000, expectedCurrency: "USD", custodyId })
    ).rejects.toThrow(attachRefusal);
    const fee = (await seed.t.run((ctx) => ctx.db.get(feeId)))!;
    expect(fee.custodyId).toBeUndefined();
    expect(fee.custodyPosted).toBeUndefined();
    expect(fee.actualAmountMinor).toBe(jod(300));
    expect(await events(seed, "CUSTODY_FEE_PAID")).toHaveLength(0);
    expect(await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).toHaveLength(0);
    expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))!.payableReclassVersion).toBeUndefined();
  }, 45_000);

  test("an existing link in another currency: re-recording refuses before the row or the ledger moves, the record's own money commands refuse rather than sum cents into fils, and releasing the line restores it", async () => {
    const seed = await seedDeal("r5-currency-linked");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(600));
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    await seed.t.run((ctx) => ctx.db.patch(feeId, { currency: "USD" }));

    // Refused at the RE-RECORD door (the action it names), before the row is
    // patched and the charge re-posted.
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: 65_000, expectedCurrency: "USD" })
    ).rejects.toThrow(/USD.*JOD.*re-recording a cost charged to this custody record is refused/);
    const fee = (await seed.t.run((ctx) => ctx.db.get(feeId)))!;
    expect(fee.actualAmountMinor).toBe(jod(600));
    expect(fee.custodyPosted?.version).toBe(1);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    expect((await pending(seed)).filter((r) => r.status === "PENDING")).toEqual([]);

    // The record cannot state its position while it carries the line.
    await expect(move(seed, custodyId, "RETURNED", jod(100))).rejects.toThrow(/USD.*JOD.*reclassifying this custody record's balance is refused/);
    expect((await entries(seed, custodyId)).filter((e) => e.kind === "RETURNED")).toHaveLength(0);
    expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))!.returnedMinor).toBe(0);
    await expect(writeOff(seed, custodyId, "lost")).rejects.toThrow(/USD.*JOD.*closing this custody record is refused/);
    expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))!.status).toBe("OPEN");
    expect(await events(seed, "CUSTODY_WRITTEN_OFF")).toHaveLength(0);
    expect(clearing(await ledger(seed))).toBe(jod(100));

    // The exit: release the line. Its charge reverses, and the record reads again.
    await seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId });
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "REVERSED"]]);
    expect(clearing(await ledger(seed))).toBe(jod(700));
    await move(seed, custodyId, "RETURNED", jod(700));
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "returned" });
    expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))!.status).toBe("RECONCILED");
    expect(clearing(await ledger(seed))).toBe(0);
  }, 45_000);
});

describe("R5-F5 — the payable chain is proven link by link before it is extended or re-based", () => {
  test("a POSTED v2 over an absent v1 is a broken chain, not an intact prefix: the next movement refuses, nothing is written, the ledger is untouched", async () => {
    const seed = await seedDeal("r5-chain-gap");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(900));
    await seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(950), expectedCurrency: "JOD" });
    const reclass = await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED");
    expect(reclass.map((e) => [e.eventVersion, e.status]).sort()).toEqual([[1, "POSTED"], [2, "POSTED"]]);
    await seed.t.run((ctx) => ctx.db.delete(reclass.find((e) => e.eventVersion === 1)!._id));
    await expect(move(seed, custodyId, "REIMBURSED", jod(100))).rejects.toThrow(/payable reclassification v1 is neither on the ledger nor waiting in the outbox/);
    expect((await entries(seed, custodyId)).filter((e) => e.kind === "REIMBURSED")).toHaveLength(0);
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => e.eventVersion)).toEqual([2]);
    expect((await pending(seed)).filter((r) => r.status === "PENDING")).toEqual([]);
    expect(payable(await ledger(seed))).toBe(-jod(250));
  }, 30_000);

  test("a queued link that is not what the chain says — wrong version, wrong source, unreadable delta, unreadable dependencies — refuses; a link with no dependency field at all (from before dependencies existed) stands, and posts by the chain rule", async () => {
    const seed = await seedDeal("r5-chain-links");
    const { earlierId, boundary } = await splitPeriods(seed);
    await closePeriod(seed, earlierId);
    // Cash handed over in the closed month: the leg waits, and so does the
    // delta the fee below produces (chained behind the leg).
    const custodyId = await openCustody(seed, jod(700), { occurredAt: boundary - 3 * DAY });
    await employeeFee(seed, custodyId, jod(900));
    const v1 = (await pending(seed)).find((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v1`)!;
    expect(v1.status).toBe("PENDING");
    const returned = () => move(seed, custodyId, "RETURNED", jod(100));
    const untouched = async () => {
      expect((await entries(seed, custodyId)).filter((e) => e.kind === "RETURNED")).toHaveLength(0);
      expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))!.returnedMinor).toBe(0);
      expect((await pending(seed)).filter((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v2`)).toEqual([]);
    };
    const { _id, _creationTime, ...row } = v1;
    void _creationTime;
    const restore = () => seed.t.run((ctx) => ctx.db.replace(_id, row));

    // Re-versioned to 7: the exact chain reading (R6, F2) meets it as a link
    // queued past the version the record issued, before the key is looked up.
    await seed.t.run((ctx) => ctx.db.patch(_id, { eventVersion: 7 }));
    await expect(returned()).rejects.toThrow(/v7 is waiting in the outbox past the version the record says it issued/);
    await untouched();
    await restore();

    await seed.t.run((ctx) => ctx.db.patch(_id, { sourceId: "somebody-else" }));
    await expect(returned()).rejects.toThrow(/v1 is not the reclassification the chain expects/);
    await untouched();
    await restore();

    await seed.t.run((ctx) => ctx.db.patch(_id, { payload: { ...(row.payload as object), deltaMinor: "200" } }));
    await expect(returned()).rejects.toThrow(/v1 carries no readable delta/);
    await untouched();
    await restore();

    await seed.t.run((ctx) => ctx.db.patch(_id, { payload: { ...(row.payload as object), ledgerDependencies: "x" } }));
    await expect(returned()).rejects.toThrow(/v1 carries ledger dependencies that cannot be read/);
    await untouched();
    expect((await pending(seed)).find((r) => r._id === _id)?.status).toBe("PENDING");
    await restore();

    // The compatibility rule: a row from before dependencies existed names
    // none, is neither folded nor refused, and the next version queues
    // behind it. Once the month reopens both post in order.
    const { ledgerDependencies, ...legacyPayload } = row.payload as Record<string, unknown>;
    void ledgerDependencies;
    await seed.t.run((ctx) => ctx.db.patch(_id, { payload: legacyPayload }));
    await returned();
    expect((await pending(seed)).find((r) => r._id === _id)?.status).toBe("PENDING");
    const v2 = (await pending(seed)).find((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v2`)!;
    expect(v2.status).toBe("PENDING");
    expect(v2.reason).toMatch(/custody payable reclassification v1 has not posted yet/);
    await reopenPeriod(seed, earlierId);
    await drainUntilSettled(seed, 4);
    expect((await pending(seed)).every((r) => r.status === "POSTED")).toBe(true);
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => [e.eventVersion, e.status]).sort()).toEqual([[1, "POSTED"], [2, "POSTED"]]);
    const l = await ledger(seed);
    expect(payable(l)).toBe(-jod(300));
    expect(clearing(l)).toBe(0);
    expect(await familyRefusal(seed)).toBeNull();
  }, 60_000);

  test("the row's target must be what the posted and queued deltas add up to: a target the chain does not reach refuses the next movement", async () => {
    const seed = await seedDeal("r5-chain-arithmetic");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(900));
    expect(payable(await ledger(seed))).toBe(-jod(200));
    await seed.t.run((ctx) => ctx.db.patch(custodyId, { payableTargetMinor: jod(250) }));
    await expect(move(seed, custodyId, "REIMBURSED", jod(100))).rejects.toThrow(/does not add up to the target the row carries/);
    expect((await entries(seed, custodyId)).filter((e) => e.kind === "REIMBURSED")).toHaveLength(0);
    expect(payable(await ledger(seed))).toBe(-jod(200));
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => e.eventVersion)).toEqual([1]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// R6 — the exact-SHA re-review of 6387a856a (Sonnet + Codex, CHANGES REQUESTED)
// ---------------------------------------------------------------------------

type RunCtx = Parameters<Parameters<TestConvex["run"]>[0]>[0];

/** A ctx whose reads are COUNTED: every `db.query` call is one platform read, whatever it returns. */
function countingCtx(ctx: RunCtx): { ctx: RunCtx; reads: () => number } {
  type Db = RunCtx["db"];
  let reads = 0;
  const db = {
    get: (...args: Parameters<Db["get"]>) => ctx.db.get(...args),
    query: (...args: Parameters<Db["query"]>) => {
      reads += 1;
      return ctx.db.query(...args);
    },
    normalizeId: (...args: Parameters<Db["normalizeId"]>) => ctx.db.normalizeId(...args),
    insert: (...args: Parameters<Db["insert"]>) => ctx.db.insert(...args),
    patch: (...args: Parameters<Db["patch"]>) => ctx.db.patch(...args),
    replace: (...args: Parameters<Db["replace"]>) => ctx.db.replace(...args),
    delete: (...args: Parameters<Db["delete"]>) => ctx.db.delete(...args),
    system: ctx.db.system,
  };
  return { ctx: { ...ctx, db } as unknown as RunCtx, reads: () => reads };
}

/**
 * A payable chain with `versions` links, v1 real and PENDING (cash handed
 * over in a closed month), v2.. cloned from it, each naming EVERY earlier
 * link's primary as SETTLED — the accumulated shape a long-lived record
 * legitimately reaches, and the one whose dependency reads grew as the
 * square of the tail.
 */
async function accumulatedQueuedChain(seed: Seed, versions: number) {
  const { earlierId, boundary } = await splitPeriods(seed);
  await closePeriod(seed, earlierId);
  const custodyId = await openCustody(seed, jod(700), { occurredAt: boundary - 3 * DAY });
  await employeeFee(seed, custodyId, jod(900));
  const v1 = (await pending(seed)).find((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v1`)!;
  expect(v1.status).toBe("PENDING");
  const leg = (await pending(seed)).find((r) => r.idempotencyKey.startsWith("custody_entry_"))!;
  const { _id: _v1Id, _creationTime: _v1Ct, ...template } = v1;
  const { _id: _legId, _creationTime: _legCt, ...legTemplate } = leg;
  void _v1Id; void _v1Ct; void _legId; void _legCt;
  const baseDeps = parseCustodyDependencies(v1.payload)!;
  const perLink = jod(1);
  let target = (v1.payload as { deltaMinor: number }).deltaMinor;
  await seed.t.run(async (ctx) => {
    for (let version = 2; version <= versions; version += 1) {
      // The primary this link follows: a further leg, queued like the first.
      await ctx.db.insert("pendingAccountingEvents", { ...legTemplate, idempotencyKey: `custody_entry_fake_${version}` });
      const settled = Array.from({ length: version - 1 }, (_, n) => ({ must: "SETTLED" as const, idempotencyKey: `custody_entry_fake_${n + 2}` }));
      target += perLink;
      await ctx.db.insert("pendingAccountingEvents", {
        ...template,
        idempotencyKey: `custody_payable_reclass_${custodyId}_v${version}`,
        eventVersion: version,
        payload: { ...(template.payload as object), deltaMinor: perLink, payableAfterMinor: target, ledgerDependencies: [...baseDeps, ...settled] },
      });
    }
    await ctx.db.patch(custodyId, { payableReclassVersion: versions, payableTargetMinor: target });
  });
  return { custodyId, target, earlierId };
}

describe("R6-F1 — re-basing a queued payable chain proves each primary ONCE, under one document budget, never once per link that names it", () => {
  test("100 accumulated links (4,950 dependency mentions) are re-proven with reads linear in the unique primaries, and the chain is left intact", async () => {
    const seed = await seedDeal("r6-fold-scale");
    const versions = 100;
    const { custodyId, target } = await accumulatedQueuedChain(seed, versions);
    const mentions = (await pending(seed))
      .filter((r) => r.idempotencyKey.startsWith(`custody_payable_reclass_${custodyId}_`))
      .reduce((sum, r) => sum + (parseCustodyDependencies(r.payload)?.filter((d) => d.must === "SETTLED").length ?? 0), 0);
    expect(mentions).toBeGreaterThan(4950);
    const budget = new CustodyLedgerReadBudget(MAX_CUSTODY_LEDGER_PROOFS, "the test");
    const { result, reads } = await seed.t.run(async (raw) => {
      const counted = countingCtx(raw);
      const custody = (await raw.db.get(custodyId))!;
      const result = await foldAbandonedPayableDeltas(counted.ctx, custody, "the test", budget);
      return { result, reads: counted.reads() };
    });
    // Nothing is abandoned: every primary is queued, so the chain stands as issued.
    expect(result).toEqual({ nextVersion: versions + 1, baseTargetMinor: target });
    // Two reads per UNIQUE primary (ledger, outbox) plus the family and the
    // outbox enumeration — not two per mention. Before the fix this was ~10,400.
    expect(reads).toBeLessThanOrEqual(3 * versions + 8);
    expect(budget.documentsRead).toBeLessThanOrEqual(MAX_CUSTODY_LEDGER_PROOFS);
    expect((await pending(seed)).filter((r) => r.idempotencyKey.startsWith(`custody_payable_reclass_${custodyId}_`))).toHaveLength(versions);
    // The product path over the same record: one more movement extends the
    // chain by one link and nothing is dropped.
    await move(seed, custodyId, "RETURNED", jod(100));
    expect((await pending(seed)).filter((r) => r.idempotencyKey.startsWith(`custody_payable_reclass_${custodyId}_`))).toHaveLength(versions + 1);
    expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))!.payableReclassVersion).toBe(versions + 1);
  }, 90_000);

  test("the re-proof refuses at its document budget with a named reason rather than reading on", async () => {
    const seed = await seedDeal("r6-fold-budget");
    const { custodyId } = await accumulatedQueuedChain(seed, 12);
    await expect(
      seed.t.run(async (ctx) => foldAbandonedPayableDeltas(ctx, (await ctx.db.get(custodyId))!, "the test", new CustodyLedgerReadBudget(20, "the test")))
    ).rejects.toThrow(/more than 20 ledger postings, which is past what the test can verify completely/);
    // A refusal drops nothing.
    expect((await pending(seed)).filter((r) => r.idempotencyKey.startsWith(`custody_payable_reclass_${custodyId}_`))).toHaveLength(12);
  }, 45_000);
});

describe("R6-F2 — the family gate certifies the EXACT payable chain, with the same validator the fold uses", () => {
  test("posted side: a duplicate version, a version past what the row issued, an unreadable delta and a target the deltas do not reach are each refused; the intact chain passes", async () => {
    const seed = await seedDeal("r6-family-posted");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(900));
    expect(await familyRefusal(seed)).toBeNull();
    const v1 = (await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED"))[0];
    expect(v1.eventVersion).toBe(1);

    // Two POSTED events at v1: a Set of versions saw one.
    const { _id: _dropId, _creationTime: _dropCt, journalEntryId: _dropJournal, ...clone } = v1;
    void _dropId; void _dropCt; void _dropJournal;
    const duplicateId = await seed.t.run((ctx) => ctx.db.insert("accountingEvents", { ...clone, idempotencyKey: `${v1.idempotencyKey}_dup` }));
    expect(await familyRefusal(seed)).toMatch(/payable reclassification v1 is on the ledger more than once, so closing is refused/);
    await seed.t.run((ctx) => ctx.db.delete(duplicateId));
    expect(await familyRefusal(seed)).toBeNull();

    // A POSTED v1 on a row that says it issued nothing: a tail the row does not own.
    await seed.t.run((ctx) => ctx.db.patch(custodyId, { payableReclassVersion: 0, payableTargetMinor: 0 }));
    expect(await familyRefusal(seed)).toMatch(/payable reclassification v1 is on the ledger past the version the record says it issued/);
    await seed.t.run((ctx) => ctx.db.patch(custodyId, { payableReclassVersion: 1, payableTargetMinor: jod(200) }));
    expect(await familyRefusal(seed)).toBeNull();

    // A posted delta nobody can read is not a payable anybody can certify.
    await seed.t.run((ctx) => ctx.db.patch(v1._id, { payload: { ...(v1.payload as object), deltaMinor: "200" } }));
    expect(await familyRefusal(seed)).toMatch(/payable reclassification v1 carries no readable delta/);
    await seed.t.run((ctx) => ctx.db.patch(v1._id, { payload: v1.payload }));
    expect(await familyRefusal(seed)).toBeNull();

    // The row's target and the chain's arithmetic disagree.
    await seed.t.run((ctx) => ctx.db.patch(custodyId, { payableTargetMinor: jod(250) }));
    expect(await familyRefusal(seed)).toMatch(/\(200000 posted, 0 waiting\) does not add up to the target the row carries \(250000\)/);
    await seed.t.run((ctx) => ctx.db.patch(custodyId, { payableTargetMinor: jod(200) }));
    expect(await familyRefusal(seed)).toBeNull();

    // Stored numbers that are not versions or amounts (CVX-4: `v.number()`
    // admits NaN). A NaN issued count made every range comparison false and
    // the tail empty, so the chain passed and the fold would have issued
    // "version NaN"; a NaN or zero event version was neither counted as the
    // prefix nor refused as a stray.
    await seed.t.run((ctx) => ctx.db.patch(custodyId, { payableReclassVersion: NaN }));
    expect(await familyRefusal(seed)).toMatch(/payable reclassification count \(NaN\) is not a whole number of versions/);
    await expect(move(seed, custodyId, "REIMBURSED", jod(100))).rejects.toThrow(/payable reclassification count \(NaN\) is not a whole number of versions/);
    expect((await entries(seed, custodyId)).filter((e) => e.kind === "REIMBURSED")).toHaveLength(0);
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => e.eventVersion)).toEqual([1]);
    await seed.t.run((ctx) => ctx.db.patch(custodyId, { payableReclassVersion: 1 }));
    await seed.t.run((ctx) => ctx.db.patch(custodyId, { payableTargetMinor: NaN }));
    expect(await familyRefusal(seed)).toMatch(/payable target \(NaN\) is not a readable amount/);
    await seed.t.run((ctx) => ctx.db.patch(custodyId, { payableTargetMinor: jod(200) }));
    for (const bad of [NaN, 0, 1.5]) {
      await seed.t.run((ctx) => ctx.db.patch(v1._id, { eventVersion: bad }));
      expect(await familyRefusal(seed)).toMatch(new RegExp(`payable reclassification event carries a version that is not a positive whole number \\(${bad}\\)`));
      await seed.t.run((ctx) => ctx.db.patch(v1._id, { eventVersion: 1 }));
    }
    expect(await familyRefusal(seed)).toBeNull();
  }, 45_000);

  test("queued side: a well-shaped waiting link is refused as waiting; unreadable dependencies, a duplicate queued version and a queued link past the issued version are refused by name — and the fold refuses to extend such a chain", async () => {
    const seed = await seedDeal("r6-family-queued");
    const { boundary } = await splitPeriods(seed);
    const custodyId = await openCustody(seed, jod(700));
    // Paid in the closed month: the fee's posting waits, and the record's v1 waits behind it.
    await closePeriod(seed, seed.periodId);
    await employeeFee(seed, custodyId, jod(900), { paidAt: boundary + 5 * DAY });
    const v1 = (await pending(seed)).find((r) => r.idempotencyKey === `custody_payable_reclass_${custodyId}_v1`)!;
    expect(v1.status).toBe("PENDING");
    expect(await familyRefusal(seed)).toMatch(/payable reclassification \(v1\) that has not posted to the ledger yet/);

    const { _id, _creationTime: _ct, ...row } = v1;
    void _ct;
    await seed.t.run((ctx) => ctx.db.patch(_id, { payload: { ...(row.payload as object), ledgerDependencies: "x" } }));
    expect(await familyRefusal(seed)).toMatch(/payable reclassification v1 carries ledger dependencies that cannot be read/);
    await seed.t.run((ctx) => ctx.db.replace(_id, row));

    const duplicateId = await seed.t.run((ctx) => ctx.db.insert("pendingAccountingEvents", { ...row, idempotencyKey: `${row.idempotencyKey}_dup` }));
    expect(await familyRefusal(seed)).toMatch(/payable reclassification v1 is waiting in the outbox more than once/);
    await seed.t.run((ctx) => ctx.db.delete(duplicateId));

    // v1 on the ledger (a POSTED event cloned from the open-period cash leg)
    // while its outbox row still reads as waiting: two witnesses that
    // disagree about one version.
    const leg = (await events(seed, "CUSTODY_CASH_ISSUED"))[0];
    const { _id: _legId, _creationTime: _legCt, journalEntryId: _legJournal, ...legClone } = leg;
    void _legId; void _legCt; void _legJournal;
    const postedTwinId = await seed.t.run((ctx) =>
      ctx.db.insert("accountingEvents", {
        ...legClone, eventType: "CUSTODY_PAYABLE_RECLASSIFIED", eventVersion: 1, sourceType: "financeDealCustody",
        sourceId: custodyId.toString(), idempotencyKey: row.idempotencyKey, payload: { ...(row.payload as object), deltaMinor: jod(200) },
      })
    );
    expect(await familyRefusal(seed)).toMatch(/payable reclassification v1 is waiting in the outbox although it is already on the ledger/);
    await seed.t.run((ctx) => ctx.db.delete(postedTwinId));

    // A queued row whose version is not one (CVX-4): refused for that, not
    // mistaken for a stray under the chain's key.
    for (const bad of [NaN, 0]) {
      await seed.t.run((ctx) => ctx.db.patch(_id, { eventVersion: bad }));
      expect(await familyRefusal(seed)).toMatch(new RegExp(`payable reclassification outbox row carries a version that is not a positive whole number \\(${bad}\\)`));
    }
    await seed.t.run((ctx) => ctx.db.replace(_id, row));

    // The row says it issued nothing while v1 waits: refused at the gate,
    // and the next movement refuses to build on it rather than re-issuing v1.
    await seed.t.run((ctx) => ctx.db.patch(custodyId, { payableReclassVersion: 0, payableTargetMinor: 0 }));
    expect(await familyRefusal(seed)).toMatch(/payable reclassification v1 is waiting in the outbox past the version the record says it issued/);
    await expect(move(seed, custodyId, "RETURNED", jod(100))).rejects.toThrow(
      /payable reclassification v1 is waiting in the outbox past the version the record says it issued, so reclassifying this custody record's balance cannot be chained behind it/
    );
    expect((await entries(seed, custodyId)).filter((e) => e.kind === "RETURNED")).toHaveLength(0);
    expect((await pending(seed)).filter((r) => r.idempotencyKey.startsWith(`custody_payable_reclass_${custodyId}_`))).toHaveLength(1);
    await seed.t.run((ctx) => ctx.db.patch(custodyId, { payableReclassVersion: 1, payableTargetMinor: jod(200) }));
    expect(await familyRefusal(seed)).toMatch(/payable reclassification \(v1\) that has not posted to the ledger yet/);
  }, 45_000);
});

describe("R6-F3 — a cost whose parent application cannot be loaded for this org never changes, moves, voids or posts", () => {
  const APPLICATION_MISSING = /Finance application not found in this organization/;

  /** Every door a fee line's custody charge can move through, each against a fee whose parent is gone or foreign. */
  async function everyDoorRefuses(seed: Seed, custodyId: Id<"financeDealCustody">, chargedFeeId: Id<"financeDealFees">, looseFeeId: Id<"financeDealFees">) {
    const before = {
      events: (await events(seed)).length,
      pending: (await pending(seed)).length,
      charged: (await seed.t.run((ctx) => ctx.db.get(chargedFeeId)))!,
      loose: (await seed.t.run((ctx) => ctx.db.get(looseFeeId)))!,
    };
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId: chargedFeeId, actualAmountMinor: jod(350), expectedCurrency: "JOD" })
    ).rejects.toThrow(APPLICATION_MISSING);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId: chargedFeeId, reason: "gone" })
    ).rejects.toThrow(APPLICATION_MISSING);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId: chargedFeeId })
    ).rejects.toThrow(APPLICATION_MISSING);
    await expect(
      seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId: looseFeeId, custodyId })
    ).rejects.toThrow(APPLICATION_MISSING);
    // Nothing moved: no journal, no queued row, both rows exactly as they were.
    expect((await events(seed)).length).toBe(before.events);
    expect((await pending(seed)).length).toBe(before.pending);
    expect(await seed.t.run((ctx) => ctx.db.get(chargedFeeId))).toEqual(before.charged);
    expect(await seed.t.run((ctx) => ctx.db.get(looseFeeId))).toEqual(before.loose);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
  }

  test("orphaned: the deal was deleted under a charged line and an uncharged one", async () => {
    const seed = await seedDeal("r6-orphan-fees");
    const custodyId = await openCustody(seed, jod(700));
    const chargedFeeId = await employeeFee(seed, custodyId, jod(300));
    const looseFeeId = await employeeFee(seed, undefined, jod(100));
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    await seed.t.run((ctx) => ctx.db.delete(seed.applicationId));
    await everyDoorRefuses(seed, custodyId, chargedFeeId, looseFeeId);
  }, 45_000);

  test("foreign: the lines were re-pointed at another organization's deal", async () => {
    const seed = await seedDeal("r6-foreign-fees");
    const custodyId = await openCustody(seed, jod(700));
    const chargedFeeId = await employeeFee(seed, custodyId, jod(300));
    const looseFeeId = await employeeFee(seed, undefined, jod(100));
    const foreignAppId = await foreignApplication(seed);
    await seed.t.run(async (ctx) => {
      await ctx.db.patch(chargedFeeId, { applicationId: foreignAppId });
      await ctx.db.patch(looseFeeId, { applicationId: foreignAppId });
    });
    await everyDoorRefuses(seed, custodyId, chargedFeeId, looseFeeId);
  }, 45_000);

  /** Another organization's deal, as a raw-edited row could point at it. */
  async function foreignApplication(seed: Seed): Promise<Id<"financeApplications">> {
    const ours = (await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))!;
    return await seed.t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId: seed.otherOrgId, quoteId: ours.quoteId, customerId: ours.customerId, vehicleId: ours.vehicleId,
        salespersonId: seed.userId, status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
  }

  /** A record from before ledger posting, with one leg and one linked line — the migration's input. */
  async function legacyRecord(seed: Seed) {
    const t0 = Date.now() - 10 * DAY;
    return await seed.t.run(async (ctx) => {
      const custodyId = await ctx.db.insert("financeDealCustody", {
        orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.employeeId, currency: "JOD",
        issuedMinor: jod(700), returnedMinor: 0, reimbursedMinor: 0, status: "OPEN",
        createdBy: seed.userId, createdAt: t0, updatedAt: t0,
      });
      await ctx.db.insert("financeDealCustodyEntries", {
        orgId: seed.orgId, custodyId, kind: "ISSUED", amountMinor: jod(700), method: "CASH", occurredAt: t0, recordedBy: seed.userId, recordedAt: t0,
      });
      const feeId = await ctx.db.insert("financeDealFees", {
        orgId: seed.orgId, applicationId: seed.applicationId, feeType: "LICENSING", currency: "JOD",
        actualAmountMinor: jod(650), paidBy: "EMPLOYEE", paidTo: "GOVERNMENT", accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
        includedInQuotation: false, deductedFromSettlement: false, refundable: false, custodyId, paidAt: t0 + DAY,
        source: "MANUAL", createdBy: seed.userId, createdAt: t0 + DAY, updatedAt: t0 + DAY,
      });
      return { custodyId, feeId };
    });
  }

  async function migrationRefusesEntirely(seed: Seed, custodyId: Id<"financeDealCustody">, feeId: Id<"financeDealFees">) {
    await expect(
      seed.asUser.mutation(api.financeDealCosts.migrateLegacyCustodyToLedger, { orgId: seed.orgId, custodyId, idempotencyKey: "migrate-1" })
    ).rejects.toThrow(APPLICATION_MISSING);
    // Nothing posted, nothing queued, no marker, no line posting, no stored command.
    expect(await events(seed)).toHaveLength(0);
    expect(await pending(seed)).toHaveLength(0);
    expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))!.ledgerPosting).toBeUndefined();
    expect((await seed.t.run((ctx) => ctx.db.get(feeId)))!.custodyPosted).toBeUndefined();
    expect(await commandRows(seed, "financeDealCosts.migrateLegacyCustodyToLedger")).toHaveLength(0);
  }

  test("the legacy migration posts nothing for a record whose deal is gone", async () => {
    const seed = await seedDeal("r6-legacy-orphan", { templates: false });
    const { custodyId, feeId } = await legacyRecord(seed);
    await seed.t.run((ctx) => ctx.db.delete(seed.applicationId));
    await migrationRefusesEntirely(seed, custodyId, feeId);
  }, 45_000);

  test("the legacy migration posts nothing for a record re-pointed at another organization's deal", async () => {
    const seed = await seedDeal("r6-legacy-foreign", { templates: false });
    const { custodyId, feeId } = await legacyRecord(seed);
    const foreignAppId = await foreignApplication(seed);
    await seed.t.run((ctx) => ctx.db.patch(custodyId, { applicationId: foreignAppId }));
    await migrationRefusesEntirely(seed, custodyId, feeId);
  }, 45_000);
});

// ---------------------------------------------------------------------------
// R7 — the exact-SHA re-review of 9dc7f6c38 (Codex, CHANGES REQUESTED)
// ---------------------------------------------------------------------------

/** Every custody-family ledger event of one org whose `sourceId` is `sourceId`, in index order. */
async function familyOf(seed: Seed, sourceId: string, eventType?: string) {
  return (await events(seed, eventType)).filter((e) => e.sourceId === sourceId);
}

/** A second POSTED copy of `event`, under `idempotencyKey` (its own by default) — a raw duplicate. */
async function duplicateEvent(seed: Seed, event: Doc<"accountingEvents">, idempotencyKey = event.idempotencyKey) {
  const { _id: _dropId, _creationTime: _dropCt, journalEntryId: _dropJournal, ...clone } = event;
  void _dropId; void _dropCt; void _dropJournal;
  return await seed.t.run((ctx) => ctx.db.insert("accountingEvents", { ...clone, status: "POSTED", idempotencyKey }));
}

/**
 * A ctx whose queries are STRUCTURALLY bounded: every `.take(n)` is recorded
 * and `.collect()` / `.first()` / `.unique()` / `.paginate()` throw — so a
 * proof that asked one query for a large or unbounded batch fails here, not
 * on the platform. Everything else delegates to the real harness.
 */
function batchPinnedCtx(ctx: RunCtx): { ctx: RunCtx; maxTake: () => number; takes: () => number } {
  let maxTake = 0;
  let takes = 0;
  const wrapQuery = (query: object): object =>
    new Proxy(query, {
      get(target, prop, receiver) {
        if (prop === "take") {
          return (n: number) => {
            takes += 1;
            maxTake = Math.max(maxTake, n);
            return (target as { take: (n: number) => unknown }).take(n);
          };
        }
        if (prop === "collect" || prop === "first" || prop === "unique" || prop === "paginate") {
          return () => {
            throw new Error(`a custody proof asked a query for an unbounded batch (${String(prop)})`);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          return result !== null && typeof result === "object" && typeof (result as { take?: unknown }).take === "function"
            ? wrapQuery(result)
            : result;
        };
      },
    });
  type Db = RunCtx["db"];
  const db = {
    ...ctx.db,
    get: (...args: Parameters<Db["get"]>) => ctx.db.get(...args),
    query: (...args: Parameters<Db["query"]>) => wrapQuery(ctx.db.query(...args)),
    normalizeId: (...args: Parameters<Db["normalizeId"]>) => ctx.db.normalizeId(...args),
    insert: (...args: Parameters<Db["insert"]>) => ctx.db.insert(...args),
    patch: (...args: Parameters<Db["patch"]>) => ctx.db.patch(...args),
    delete: (...args: Parameters<Db["delete"]>) => ctx.db.delete(...args),
    system: ctx.db.system,
  };
  return { ctx: { ...ctx, db } as unknown as RunCtx, maxTake: () => maxTake, takes: () => takes };
}

describe("R7-F1 — the family proof bounds the BYTES it reads, exactly and per batch, against the transaction's real headroom", () => {
  test("the derivation holds: the proof's own budget, one worst-case batch and the caller's reserve fit under the platform's transaction read limit", () => {
    expect(MAX_CUSTODY_READ_BATCH * PLATFORM_DOCUMENT_BYTES + CUSTODY_PROOF_CALLER_RESERVE_BYTES + MAX_CUSTODY_LEDGER_READ_BYTES).toBeLessThanOrEqual(PLATFORM_TRANSACTION_READ_BYTES);
    // Every keyed point-read in the module takes at most one batch.
    expect(MAX_CUSTODY_READ_BATCH).toBeGreaterThanOrEqual(8);
  });

  test("the budget charges every document at its EXACT platform size (`getDocumentSize`) and refuses at its byte bound with a named reason, before its document bound", () => {
    const budget = new CustodyLedgerReadBudget(100, "the test", 1_000);
    const small = { _id: "a", n: 1 };
    budget.charge([small, small]);
    expect(budget.documentsRead).toBe(2);
    expect(budget.bytesRead).toBe(2 * getDocumentSize(small));
    expect(documentBytes(small)).toBe(getDocumentSize(small));
    // An empty point-read costs a document and no bytes; a value that is not
    // a document is charged one maximum document, never nothing.
    budget.chargeRead([]);
    expect(budget.documentsRead).toBe(3);
    expect(budget.bytesRead).toBe(2 * getDocumentSize(small));
    expect(documentBytes(null)).toBe(PLATFORM_DOCUMENT_BYTES);
    // One 1,000-character document: well under 100 documents, past 1,000 bytes.
    expect(() => budget.charge([{ text: "x".repeat(1_000) }])).toThrow(/more than 1,000 bytes of ledger postings, which is past what the test can verify completely/);
    // A refusal is final: the budget does not read on after it.
    expect(() => budget.charge([small])).toThrow(/more than 1,000 bytes/);
  });

  test("the headroom check refuses by name when the transaction could not take one worst-case batch plus the caller's reserve, or when its metrics cannot be read", async () => {
    const budget = new CustodyLedgerReadBudget(100, "the test");
    const metric = (remaining: number, used = 0) => ({ used, remaining });
    const ample = {
      bytesRead: metric(PLATFORM_TRANSACTION_READ_BYTES), bytesWritten: metric(1), databaseQueries: metric(4_096),
      documentsRead: metric(32_000), documentsWritten: metric(1), functionsScheduled: metric(1), scheduledFunctionArgsBytes: metric(1),
    };
    const ctxWith = (metrics: typeof ample) => ({ meta: { getTransactionMetrics: async () => metrics } });
    await expect(budget.assertHeadroom(ctxWith(ample))).resolves.toBeUndefined();
    const exact = MAX_CUSTODY_READ_BATCH * PLATFORM_DOCUMENT_BYTES + CUSTODY_PROOF_CALLER_RESERVE_BYTES;
    await expect(budget.assertHeadroom(ctxWith({ ...ample, bytesRead: metric(exact) }))).resolves.toBeUndefined();
    await expect(budget.assertHeadroom(ctxWith({ ...ample, bytesRead: metric(exact - 1, 6_291_457) }))).rejects.toThrow(
      /This transaction has read too much for the test to verify this deal's custody completely \(6,291,457 bytes/
    );
    await expect(budget.assertHeadroom(ctxWith({ ...ample, documentsRead: metric(MAX_CUSTODY_READ_BATCH + CUSTODY_PROOF_CALLER_RESERVE_DOCUMENTS - 1) }))).rejects.toThrow(/read too much/);
    await expect(budget.assertHeadroom(ctxWith({ ...ample, databaseQueries: metric(CUSTODY_PROOF_CALLER_RESERVE_QUERIES) }))).rejects.toThrow(/read too much/);
    await expect(budget.assertHeadroom({})).rejects.toThrow(/read headroom cannot be measured/);
    await expect(budget.assertHeadroom({ meta: {} })).rejects.toThrow(/read headroom cannot be measured/);
  });

  test("no query inside any proof asks for more than one batch, none is unbounded, and a family larger than a batch is still read in full", async () => {
    const seed = await seedDeal("r7-batches");
    const custodyId = await openCustody(seed, jod(700));
    for (let n = 0; n < 12; n += 1) await move(seed, custodyId, "ISSUED", jod(10));
    const feeId = await employeeFee(seed, custodyId, jod(900));
    // A fee family of 20 events (one live, the rest FAILED), a movement log
    // of 13 legs, a payable chain: every enumeration exceeds one batch.
    const template = (await events(seed, "CUSTODY_FEE_PAID"))[0];
    const { _id: _drop, _creationTime: _ct, journalEntryId: _j, ...rest } = template;
    void _drop; void _ct; void _j;
    await seed.t.run(async (ctx) => {
      for (let version = 2; version <= 20; version += 1) {
        await ctx.db.insert("accountingEvents", { ...rest, eventVersion: version, status: "FAILED", idempotencyKey: `custody_fee_paid_${feeId}_v${version}` });
      }
    });
    expect((await familyOf(seed, feeId.toString(), "CUSTODY_FEE_PAID")).length).toBe(20);
    const pinned = await seed.t.run(async (raw) => {
      const bounded = batchPinnedCtx(raw);
      const custody = await raw.db.query("financeDealCustody").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).collect();
      const fees = await raw.db.query("financeDealFees").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).collect();
      const refusal = await custodyLedgerFamilyRefusal(bounded.ctx, seed.orgId, seed.applicationId, custody, fees, "closing");
      const dependencies = await custodyPositionDependencies(bounded.ctx, custody[0], "the test");
      const fold = await foldAbandonedPayableDeltas(bounded.ctx, custody[0], "the test");
      const budget = new CustodyLedgerReadBudget(MAX_CUSTODY_LEDGER_PROOFS, "the test");
      const lines = await loadCustodyPostedLines(bounded.ctx, seed.applicationId, "the test", budget);
      return { refusal, dependencies: dependencies.length, fold, lines: lines.length, maxTake: bounded.maxTake(), takes: bounded.takes() };
    });
    expect(pinned.refusal).toBeNull();
    // 13 legs SETTLED + the live charge SETTLED: the whole log was read, past one batch.
    expect(pinned.dependencies).toBe(14);
    expect(pinned.fold).toEqual({ nextVersion: 2, baseTargetMinor: jod(80) });
    expect(pinned.lines).toBe(1);
    expect(pinned.maxTake).toBeLessThanOrEqual(MAX_CUSTODY_READ_BATCH);
    expect(pinned.takes).toBeGreaterThan(20 / MAX_CUSTODY_READ_BATCH);
  }, 45_000);

  test("a handful of near-maximum documents refuse at the byte bound, batch by batch, and the transaction's own metrics agree; a transaction that has already read too much refuses on headroom before the first batch; the same family with ordinary payloads passes", async () => {
    // convex-test tracks bytesRead with the platform's size formula but does
    // NOT enforce the limit here, so this proves the budget's accounting, the
    // batching (one batch of overshoot at most) and the headroom arithmetic
    // against the harness's metrics — never that a real transaction would
    // have failed. Only a real-platform run proves the runtime metrics.
    const seed = await seedDeal("r7-bytes");
    const custodyId = await openCustody(seed, jod(700));
    const feeIds: Id<"financeDealFees">[] = [];
    for (let n = 0; n < 5; n += 1) feeIds.push(await employeeFee(seed, custodyId, jod(100)));
    expect(await familyRefusal(seed)).toBeNull();
    const template = (await events(seed, "CUSTODY_FEE_PAID"))[0];
    const { _id: _drop, _creationTime: _ct, journalEntryId: _j, ...rest } = template;
    void _drop; void _ct; void _j;
    // Five FAILED attempts, each a document just under the platform's 1 MiB:
    // ten documents in all, far under the document bound, 4.5 MiB in bytes.
    const bulk = "x".repeat(900_000);
    const bulkBytes = getDocumentSize({ ...rest, payload: { ...(rest.payload as object), bulk } });
    expect(bulkBytes).toBeLessThan(PLATFORM_DOCUMENT_BYTES);
    expect(5 * bulkBytes).toBeGreaterThan(MAX_CUSTODY_LEDGER_READ_BYTES);
    const inserted = await seed.t.run(async (ctx) => {
      const ids: Id<"accountingEvents">[] = [];
      for (const feeId of feeIds) {
        ids.push(
          await ctx.db.insert("accountingEvents", {
            ...rest, sourceId: feeId.toString(), eventVersion: 2, status: "FAILED",
            idempotencyKey: `custody_fee_paid_${feeId}_v2`, payload: { ...(rest.payload as object), bulk },
          })
        );
      }
      return ids;
    });
    const outcome = await seed.t.run(async (ctx) => {
      const custody = await ctx.db.query("financeDealCustody").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).collect();
      const fees = await ctx.db.query("financeDealFees").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).collect();
      const before = await ctx.meta.getTransactionMetrics();
      let refusal: string | null = null;
      try {
        await custodyLedgerFamilyRefusal(ctx, seed.orgId, seed.applicationId, custody, fees, "closing");
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      const after = await ctx.meta.getTransactionMetrics();
      return { refusal, readByProof: after.bytesRead.used - before.bytesRead.used };
    });
    expect(outcome.refusal).toMatch(/bytes of ledger postings, which is past what closing can verify completely/);
    // The platform's own accounting of what the proof read: past the budget
    // (it refused for that), and by no more than the two small families it
    // read before the bulk ones plus one batch — never the whole family.
    expect(outcome.readByProof).toBeGreaterThan(MAX_CUSTODY_LEDGER_READ_BYTES);
    expect(outcome.readByProof).toBeLessThan(MAX_CUSTODY_LEDGER_READ_BYTES + MAX_CUSTODY_READ_BATCH * PLATFORM_DOCUMENT_BYTES);

    // A transaction that has already spent its headroom: the proof refuses
    // on the platform's metrics before it fetches anything of its own.
    const headroom = await seed.t.run(async (ctx) => {
      for (let pass = 0; pass < 3; pass += 1) {
        await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", seed.orgId)).collect();
      }
      const used = (await ctx.meta.getTransactionMetrics()).bytesRead.used;
      const custody = await ctx.db.query("financeDealCustody").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).collect();
      const fees = await ctx.db.query("financeDealFees").withIndex("by_application", (q) => q.eq("applicationId", seed.applicationId)).collect();
      try {
        await custodyLedgerFamilyRefusal(ctx, seed.orgId, seed.applicationId, custody, fees, "closing");
        return { used, refusal: null as string | null };
      } catch (error) {
        return { used, refusal: error instanceof Error ? error.message : String(error) };
      }
    });
    expect(headroom.used).toBeGreaterThan(PLATFORM_TRANSACTION_READ_BYTES - MAX_CUSTODY_READ_BATCH * PLATFORM_DOCUMENT_BYTES - CUSTODY_PROOF_CALLER_RESERVE_BYTES);
    expect(headroom.refusal).toMatch(/This transaction has read too much for closing to verify this deal's custody completely/);

    await seed.t.run(async (ctx) => {
      for (const id of inserted) await ctx.db.patch(id, { payload: rest.payload });
    });
    expect(await familyRefusal(seed)).toBeNull();
  }, 60_000);
});

describe("R7-F2 — the family proof requires EXACTLY ONE canonical POSTED forward event per family member, and no other live one", () => {
  test("a duplicate POSTED cash leg, custody-paid fee and write-off at the claimed version are each refused; a stray live event beside the posting is refused; the exact family passes", async () => {
    const seed = await seedDeal("r7-duplicates");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(600));
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
      idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "short", writeOffReason: "lost 100",
    });
    expect(await familyRefusal(seed)).toBeNull();
    const feeEvent = (await familyOf(seed, feeId.toString(), "CUSTODY_FEE_PAID"))[0];
    const writeOffEvent = (await familyOf(seed, custodyId.toString(), "CUSTODY_WRITTEN_OFF"))[0];
    const issuedEvent = (await events(seed, "CUSTODY_CASH_ISSUED"))[0];
    expect([feeEvent.status, writeOffEvent.status, issuedEvent.status]).toEqual(["POSTED", "POSTED", "POSTED"]);

    // Two POSTED copies at the claimed version: `find` saw one and passed.
    let dup = await duplicateEvent(seed, feeEvent);
    expect(await familyRefusal(seed)).toMatch(/custody on this deal is on the books more than once/);
    await seed.t.run((ctx) => ctx.db.delete(dup));
    dup = await duplicateEvent(seed, writeOffEvent);
    expect(await familyRefusal(seed)).toMatch(/custody write-off on this deal is on the books more than once/);
    await seed.t.run((ctx) => ctx.db.delete(dup));
    dup = await duplicateEvent(seed, issuedEvent);
    expect(await familyRefusal(seed)).toMatch(/custody movement on this deal is on the books more than once/);
    await seed.t.run((ctx) => ctx.db.delete(dup));
    expect(await familyRefusal(seed)).toBeNull();

    // A live event beside the posting, at the same version but not under the
    // posting's own key — a second journal the row cannot account for.
    dup = await duplicateEvent(seed, feeEvent, `${feeEvent.idempotencyKey}_stray`);
    expect(await familyRefusal(seed)).toMatch(/custody on this deal is on the books more than once/);
    await seed.t.run((ctx) => ctx.db.patch(dup, { status: "PENDING" }));
    expect(await familyRefusal(seed)).toMatch(/custody on this deal is on the books more than once/);
    // FAILED and REVERSED copies are not live and never were.
    await seed.t.run((ctx) => ctx.db.patch(dup, { status: "FAILED" }));
    expect(await familyRefusal(seed)).toBeNull();
    await seed.t.run((ctx) => ctx.db.patch(dup, { status: "REVERSED" }));
    expect(await familyRefusal(seed)).toBeNull();
    await seed.t.run((ctx) => ctx.db.delete(dup));

    // The posting at the claimed version under a key that is not its own is
    // not the canonical posting: refused as not on the books, never accepted
    // because the version matched.
    await seed.t.run((ctx) => ctx.db.patch(feeEvent._id, { idempotencyKey: `${feeEvent.idempotencyKey}_renamed` }));
    expect(await familyRefusal(seed)).toMatch(/custody on this deal is not on the books/);
    await seed.t.run((ctx) => ctx.db.patch(feeEvent._id, { idempotencyKey: feeEvent.idempotencyKey }));
    await seed.t.run((ctx) => ctx.db.patch(writeOffEvent._id, { idempotencyKey: `${writeOffEvent.idempotencyKey}_renamed` }));
    expect(await familyRefusal(seed)).toMatch(/custody write-off on this deal is not on the books/);
    await seed.t.run((ctx) => ctx.db.patch(writeOffEvent._id, { idempotencyKey: writeOffEvent.idempotencyKey }));
    expect(await familyRefusal(seed)).toBeNull();
  }, 45_000);

  test("a cash leg's posting is its KIND's event type at version 1: a POSTED event under the leg's key and source but of another custody cash type, or another version, is not the leg on the books", async () => {
    const seed = await seedDeal("r7-cash-identity");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(750));
    await move(seed, custodyId, "REIMBURSED", jod(50));
    await move(seed, custodyId, "RETURNED", jod(10));
    expect(await familyRefusal(seed)).toBeNull();
    const issued = (await events(seed, "CUSTODY_CASH_ISSUED"))[0];
    expect([issued.eventVersion, issued.status]).toEqual([1, "POSTED"]);
    // Wrong custody cash type under the right key, source, version and status.
    await seed.t.run((ctx) => ctx.db.patch(issued._id, { eventType: "CUSTODY_CASH_RETURNED" }));
    expect(await familyRefusal(seed)).toMatch(/custody movement on this deal is not on the books/);
    await seed.t.run((ctx) => ctx.db.patch(issued._id, { eventType: issued.eventType }));
    expect(await familyRefusal(seed)).toBeNull();
    // Wrong version under the right key, source, type and status.
    for (const version of [2, 0]) {
      await seed.t.run((ctx) => ctx.db.patch(issued._id, { eventVersion: version }));
      expect(await familyRefusal(seed)).toMatch(/custody movement on this deal is not on the books/);
    }
    await seed.t.run((ctx) => ctx.db.patch(issued._id, { eventVersion: issued.eventVersion }));
    expect(await familyRefusal(seed)).toBeNull();
    // A live wrong-type event BESIDE the canonical one is a second journal.
    const stray = await duplicateEvent(seed, { ...issued, eventType: "CUSTODY_CASH_RETURNED" });
    expect(await familyRefusal(seed)).toMatch(/custody movement on this deal is on the books more than once/);
    await seed.t.run((ctx) => ctx.db.delete(stray));
    expect(await familyRefusal(seed)).toBeNull();
    // A full key batch is never judged: the canonical row plus seven dead
    // ones fill the batch, and a ninth LIVE duplicate sits beyond it where
    // a prefix judgement would never see it — refused as unverifiable.
    const filler: Id<"accountingEvents">[] = [];
    for (let n = 0; n < MAX_CUSTODY_READ_BATCH - 2; n += 1) {
      filler.push(await duplicateEvent(seed, { ...issued, status: "FAILED" }));
      await seed.t.run((ctx) => ctx.db.patch(filler[n], { status: "FAILED" }));
    }
    // Seven rows under the key (under the batch): still judged exactly, and exact.
    expect(await familyRefusal(seed)).toBeNull();
    filler.push(await duplicateEvent(seed, { ...issued, status: "FAILED" }));
    await seed.t.run((ctx) => ctx.db.patch(filler[filler.length - 1], { status: "FAILED" }));
    const hidden = await duplicateEvent(seed, issued);
    expect((await familyOf(seed, issued.sourceId)).length).toBe(MAX_CUSTODY_READ_BATCH + 1);
    await expect(familyRefusal(seed)).rejects.toThrow(new RegExp(`has ${MAX_CUSTODY_READ_BATCH} or more ledger rows under its key, which is more than one posting can have`));
    await seed.t.run((ctx) => ctx.db.delete(hidden));
    // Exactly a full batch with nothing beyond: still unverifiable, still refused.
    await expect(familyRefusal(seed)).rejects.toThrow(/or more ledger rows under its key/);
    await seed.t.run(async (ctx) => {
      for (const id of filler) await ctx.db.delete(id);
    });
    expect(await familyRefusal(seed)).toBeNull();

    // The module's table is what the hook actually posts, kind by kind, at
    // the version it posts at — the two cannot drift apart unnoticed.
    const legs = await entries(seed, custodyId);
    for (const kind of ["ISSUED", "RETURNED", "REIMBURSED"] as const) {
      const leg = legs.find((e) => e.kind === kind)!;
      const event = (await events(seed)).find((e) => e.sourceId === leg._id.toString())!;
      expect([event.eventType, event.eventVersion, event.status]).toEqual([CUSTODY_CASH_EVENT_TYPE[kind], CUSTODY_CASH_EVENT_VERSION, "POSTED"]);
    }
  }, 45_000);
});

describe("R7-F3 — a STORED custody link is proven this org's, on this deal, before anything reverses, re-posts or reclassifies against it", () => {
  const LINK_MISSING = /linked to a custody record that is not in this organization/;
  const LINK_OTHER_DEAL = /linked to a custody record on a different deal/;

  /** A canonical custody record of another organization, as a raw-edited link could name it. */
  async function foreignCustody(seed: Seed): Promise<Id<"financeDealCustody">> {
    const ours = (await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))!;
    return await seed.t.run(async (ctx) => {
      const applicationId = await ctx.db.insert("financeApplications", {
        orgId: seed.otherOrgId, quoteId: ours.quoteId, customerId: ours.customerId, vehicleId: ours.vehicleId,
        salespersonId: seed.userId, status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
      });
      return await ctx.db.insert("financeDealCustody", {
        orgId: seed.otherOrgId, applicationId, userId: seed.employeeId, currency: "JOD",
        issuedMinor: jod(700), returnedMinor: 0, reimbursedMinor: 0, status: "OPEN", ledgerPosting: "CANONICAL",
        createdBy: seed.userId, createdAt: Date.now(), updatedAt: Date.now(),
      });
    });
  }

  /** A canonical custody record on ANOTHER deal of the same organization. */
  async function siblingDealCustody(seed: Seed): Promise<Id<"financeDealCustody">> {
    const ours = (await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))!;
    return await seed.t.run(async (ctx) => {
      const applicationId = await ctx.db.insert("financeApplications", {
        orgId: seed.orgId, quoteId: ours.quoteId, customerId: ours.customerId, vehicleId: ours.vehicleId,
        salespersonId: seed.userId, status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(),
      });
      return await ctx.db.insert("financeDealCustody", {
        orgId: seed.orgId, applicationId, userId: seed.employeeId, currency: "JOD",
        issuedMinor: jod(700), returnedMinor: 0, reimbursedMinor: 0, status: "OPEN", ledgerPosting: "CANONICAL",
        createdBy: seed.userId, createdAt: Date.now(), updatedAt: Date.now(),
      });
    });
  }

  /** Every door through which a line's STORED link is acted on, each refusing by name and changing nothing. */
  async function everyDoorRefuses(seed: Seed, feeId: Id<"financeDealFees">, refusal: RegExp) {
    const before = {
      events: (await events(seed)).length,
      pending: (await pending(seed)).length,
      fee: (await seed.t.run((ctx) => ctx.db.get(feeId)))!,
      custody: await seed.t.run((ctx) => ctx.db.query("financeDealCustody").collect()),
    };
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(350), expectedCurrency: "JOD" })
    ).rejects.toThrow(refusal);
    await expect(seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "gone" })).rejects.toThrow(refusal);
    await expect(seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId })).rejects.toThrow(refusal);
    await expect(seed.asUser.mutation(api.financeDealCosts.reconcileDealFee, { orgId: seed.orgId, feeId, notes: "checked" })).rejects.toThrow(refusal);
    expect((await events(seed)).length).toBe(before.events);
    expect((await pending(seed)).length).toBe(before.pending);
    expect(await seed.t.run((ctx) => ctx.db.get(feeId))).toEqual(before.fee);
    expect(await seed.t.run((ctx) => ctx.db.query("financeDealCustody").collect())).toEqual(before.custody);
  }

  test("the current link (`custodyId`) names a record that is gone, another organization's, or another deal's", async () => {
    const seed = await seedDeal("r7-current-link");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(300));
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);

    const foreign = await foreignCustody(seed);
    await seed.t.run((ctx) => ctx.db.patch(feeId, { custodyId: foreign }));
    await everyDoorRefuses(seed, feeId, LINK_MISSING);

    const sibling = await siblingDealCustody(seed);
    await seed.t.run((ctx) => ctx.db.patch(feeId, { custodyId: sibling }));
    await everyDoorRefuses(seed, feeId, LINK_OTHER_DEAL);

    await seed.t.run((ctx) => ctx.db.patch(feeId, { custodyId }));
    await seed.t.run(async (ctx) => {
      for (const entry of await ctx.db.query("financeDealCustodyEntries").withIndex("by_custody", (q) => q.eq("custodyId", custodyId)).collect()) await ctx.db.delete(entry._id);
      await ctx.db.delete(custodyId);
    });
    await everyDoorRefuses(seed, feeId, LINK_MISSING);
  }, 60_000);

  test("the prior link (`custodyPosted.custodyId`) is proven before the reversal and the payable sync it drives: a foreign record's payable never moves", async () => {
    const seed = await seedDeal("r7-prior-link");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(300));
    const foreign = await foreignCustody(seed);
    const posted = (await seed.t.run((ctx) => ctx.db.get(feeId)))!.custodyPosted!;
    await seed.t.run((ctx) => ctx.db.patch(feeId, { custodyPosted: { ...posted, custodyId: foreign } }));
    const before = { events: (await events(seed)).length, foreign: (await seed.t.run((ctx) => ctx.db.get(foreign)))! };
    // Re-recording the amount, voiding and releasing all reverse the prior
    // version and reclassify the record it was charged to.
    await expect(
      seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(350), expectedCurrency: "JOD" })
    ).rejects.toThrow(LINK_MISSING);
    await expect(seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "gone" })).rejects.toThrow(LINK_MISSING);
    await expect(seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId })).rejects.toThrow(LINK_MISSING);
    expect((await events(seed)).length).toBe(before.events);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    expect(await seed.t.run((ctx) => ctx.db.get(foreign))).toEqual(before.foreign);
    expect((await seed.t.run((ctx) => ctx.db.get(feeId)))!.custodyPosted).toEqual({ ...posted, custodyId: foreign });
    // Nothing of the other organization's was touched — no event, no outbox row.
    expect(await seed.t.run(async (ctx) => (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", seed.otherOrgId)).collect()).length)).toBe(0);
    expect((await seed.t.run((ctx) => ctx.db.query("pendingAccountingEvents").collect())).filter((r) => r.orgId === seed.otherOrgId)).toHaveLength(0);

    const sibling = await siblingDealCustody(seed);
    await seed.t.run((ctx) => ctx.db.patch(feeId, { custodyPosted: { ...posted, custodyId: sibling } }));
    await expect(seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "gone" })).rejects.toThrow(LINK_OTHER_DEAL);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    expect((await seed.t.run((ctx) => ctx.db.get(feeId)))!.voidedAt).toBeUndefined();
  }, 60_000);
});

describe("R7-F4 — a stored posting version is a positive whole number or the door refuses (CVX-4: `v.number()` admits NaN, Infinity and fractions)", () => {
  const NOT_A_VERSION = /posting version that is not a positive whole number/;
  const BAD_VERSIONS = [NaN, Infinity, -Infinity, 1.5, 0.5, -1] as const;

  test("the shared validator names every non-version; `nextStoredVersion` counts from nothing or from a whole number only", () => {
    expect(isStoredVersion(1)).toBe(true);
    expect(isStoredVersion(Number.MAX_SAFE_INTEGER)).toBe(true);
    for (const bad of [...BAD_VERSIONS, 0, Number.MAX_SAFE_INTEGER + 2, "1", null, undefined]) expect(isStoredVersion(bad)).toBe(false);
    expect(nextStoredVersion(undefined, "the line", "the test")).toBe(1);
    expect(nextStoredVersion(0, "the line", "the test")).toBe(1);
    expect(nextStoredVersion(3, "the line", "the test")).toBe(4);
    for (const bad of BAD_VERSIONS) {
      expect(() => nextStoredVersion(bad, "the line", "the test")).toThrow(new RegExp(`the line carries a posting version that is not a positive whole number \\(${bad}\\), so the test`));
      expect(() => assertStoredVersion(bad, "the line", "the test")).toThrow(NOT_A_VERSION);
    }
    expect(() => nextStoredVersion(Number.MAX_SAFE_INTEGER, "the line", "the test")).toThrow(NOT_A_VERSION);
  });

  test("producer: a line whose stored counter is not a version is never re-posted at 'version NaN'", async () => {
    const seed = await seedDeal("r7-version-producer");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(300));
    for (const bad of [NaN, Infinity, 1.5]) {
      await seed.t.run((ctx) => ctx.db.patch(feeId, { custodyPostingVersion: bad }));
      const before = (await seed.t.run((ctx) => ctx.db.get(feeId)))!;
      await expect(
        seed.asUser.mutation(api.financeDealCosts.recordActualFeeAmount, { orgId: seed.orgId, feeId, actualAmountMinor: jod(350), expectedCurrency: "JOD" })
      ).rejects.toThrow(NOT_A_VERSION);
      expect(await seed.t.run((ctx) => ctx.db.get(feeId))).toEqual(before);
      expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    }
    // The hooks refuse the same number whichever door computed it.
    await seed.t.run(async (ctx) => {
      const fee = (await ctx.db.get(feeId))!;
      for (const bad of BAD_VERSIONS) {
        await expect(
          hookCustodyFeePaid(ctx, { orgId: seed.orgId, fee, custodyId, vehicleId: seed.vehicleId, version: bad, amountMinor: jod(1), actorId: seed.userId, occurredAt: Date.now() })
        ).rejects.toThrow(NOT_A_VERSION);
        await expect(
          hookCustodyFeeReversed(ctx, { orgId: seed.orgId, feeId, version: bad, reason: "r", actorId: seed.userId, reversalDate: Date.now() })
        ).rejects.toThrow(NOT_A_VERSION);
      }
    });
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
  }, 45_000);

  test("reversal: a line or record whose CLAIMED version is not a version is neither voided over a charge left on the books nor reopened over a write-off left on them", async () => {
    const seed = await seedDeal("r7-version-reversal");
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(300));
    const posted = (await seed.t.run((ctx) => ctx.db.get(feeId)))!.custodyPosted!;
    for (const bad of [NaN, Infinity, 1.5]) {
      await seed.t.run((ctx) => ctx.db.patch(feeId, { custodyPosted: { ...posted, version: bad } }));
      await expect(seed.asUser.mutation(api.financeDealCosts.voidDealFee, { orgId: seed.orgId, feeId, reason: "gone" })).rejects.toThrow(NOT_A_VERSION);
      await expect(seed.asUser.mutation(api.financeDealCosts.setFeeCustody, { orgId: seed.orgId, feeId })).rejects.toThrow(NOT_A_VERSION);
      expect((await seed.t.run((ctx) => ctx.db.get(feeId)))!.voidedAt).toBeUndefined();
      expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    }
    await seed.t.run((ctx) => ctx.db.patch(feeId, { custodyPosted: posted }));

    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
      idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "short", writeOffReason: "lost 400",
    });
    const writeOff = (await seed.t.run((ctx) => ctx.db.get(custodyId)))!.writeOffPosted!;
    for (const bad of [NaN, Infinity, 1.5]) {
      await seed.t.run((ctx) => ctx.db.patch(custodyId, { writeOffPosted: { ...writeOff, version: bad } }));
      await expect(seed.asUser.mutation(api.financeDealCosts.reopenDealCustody, { orgId: seed.orgId, custodyId, reason: "found" })).rejects.toThrow(NOT_A_VERSION);
      expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))!.status).toBe("WRITTEN_OFF");
      expect((await events(seed, "CUSTODY_WRITTEN_OFF")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    }
    await seed.t.run((ctx) => ctx.db.patch(custodyId, { writeOffPosted: writeOff }));
    // The write-off producer, over a counter that is not a version.
    await seed.asUser.mutation(api.financeDealCosts.reopenDealCustody, { orgId: seed.orgId, custodyId, reason: "found" });
    for (const bad of [NaN, Infinity, 1.5]) {
      await seed.t.run((ctx) => ctx.db.patch(custodyId, { writeOffPostingVersion: bad }));
      await expect(
        seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { idempotencyKey: crypto.randomUUID(), orgId: seed.orgId, custodyId, notes: "short", writeOffReason: "lost 400" })
      ).rejects.toThrow(NOT_A_VERSION);
      expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))!.status).toBe("OPEN");
    }
    expect((await events(seed, "CUSTODY_WRITTEN_OFF")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "REVERSED"]]);
  }, 60_000);

  test("enumeration: a deal whose ever-posted lines include one at a counter that is not a version refuses the family proof rather than stopping short of the lines after it", async () => {
    const seed = await seedDeal("r7-version-enumeration");
    const custodyId = await openCustody(seed, jod(700));
    const first = await employeeFee(seed, custodyId, jod(100));
    await employeeFee(seed, custodyId, jod(100));
    expect(await familyRefusal(seed)).toBeNull();
    for (const bad of [NaN, Infinity, 1.5]) {
      await seed.t.run((ctx) => ctx.db.patch(first, { custodyPostingVersion: bad }));
      await expect(familyRefusal(seed)).rejects.toThrow(/custody posting version that is not a positive whole number/);
      await expect(
        seed.t.run((ctx) => loadCustodyPostedLines(ctx, seed.applicationId, "the test", new CustodyLedgerReadBudget(MAX_CUSTODY_LEDGER_PROOFS, "the test")))
      ).rejects.toThrow(/custody posting version that is not a positive whole number/);
    }
    await seed.t.run((ctx) => ctx.db.patch(first, { custodyPostingVersion: 1 }));
    expect(await familyRefusal(seed)).toBeNull();
  }, 45_000);

  test("migration: a legacy line whose counter is not a version refuses the whole record, and nothing posts", async () => {
    const seed = await seedDeal("r7-version-migration", { templates: false });
    const t0 = Date.now() - 10 * DAY;
    for (const bad of [NaN, Infinity, 1.5]) {
      const { custodyId, feeId } = await seed.t.run(async (ctx) => {
        const custodyId = await ctx.db.insert("financeDealCustody", {
          orgId: seed.orgId, applicationId: seed.applicationId, userId: seed.employeeId, currency: "JOD",
          issuedMinor: jod(700), returnedMinor: 0, reimbursedMinor: 0, status: "OPEN",
          createdBy: seed.userId, createdAt: t0, updatedAt: t0,
        });
        await ctx.db.insert("financeDealCustodyEntries", {
          orgId: seed.orgId, custodyId, kind: "ISSUED", amountMinor: jod(700), method: "CASH", occurredAt: t0, recordedBy: seed.userId, recordedAt: t0,
        });
        const feeId = await ctx.db.insert("financeDealFees", {
          orgId: seed.orgId, applicationId: seed.applicationId, feeType: "LICENSING", currency: "JOD",
          actualAmountMinor: jod(650), paidBy: "EMPLOYEE", paidTo: "GOVERNMENT", accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
          includedInQuotation: false, deductedFromSettlement: false, refundable: false, custodyId, paidAt: t0 + DAY,
          custodyPostingVersion: bad, source: "MANUAL", createdBy: seed.userId, createdAt: t0 + DAY, updatedAt: t0 + DAY,
        });
        return { custodyId, feeId };
      });
      await expect(
        seed.asUser.mutation(api.financeDealCosts.migrateLegacyCustodyToLedger, { orgId: seed.orgId, custodyId, idempotencyKey: crypto.randomUUID() })
      ).rejects.toThrow(NOT_A_VERSION);
      expect(await events(seed)).toHaveLength(0);
      expect(await pending(seed)).toHaveLength(0);
      expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))!.ledgerPosting).toBeUndefined();
      expect((await seed.t.run((ctx) => ctx.db.get(feeId)))!.custodyPosted).toBeUndefined();
      await seed.t.run(async (ctx) => {
        await ctx.db.delete(feeId);
        for (const entry of await ctx.db.query("financeDealCustodyEntries").withIndex("by_custody", (q) => q.eq("custodyId", custodyId)).collect()) await ctx.db.delete(entry._id);
        await ctx.db.delete(custodyId);
      });
    }
  }, 60_000);
});

describe("R7-F5 — a POSTED payable link is held to the same identity and payload contract as a queued one", () => {
  test("a posted link under a key that is not the chain's, or whose dependencies cannot be read, is refused by the family gate and by the fold alike", async () => {
    const seed = await seedDeal("r7-posted-link");
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(900));
    expect(await familyRefusal(seed)).toBeNull();
    const v1 = (await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED"))[0];
    expect([v1.eventVersion, v1.status]).toEqual([1, "POSTED"]);

    await seed.t.run((ctx) => ctx.db.patch(v1._id, { idempotencyKey: `${v1.idempotencyKey}_other` }));
    expect(await familyRefusal(seed)).toMatch(/payable reclassification v1 is not the reclassification the chain expects \(its ledger event names another event, source or version\)/);
    await expect(move(seed, custodyId, "REIMBURSED", jod(100))).rejects.toThrow(/payable reclassification v1 is not the reclassification the chain expects/);
    expect((await entries(seed, custodyId)).filter((e) => e.kind === "REIMBURSED")).toHaveLength(0);
    await seed.t.run((ctx) => ctx.db.patch(v1._id, { idempotencyKey: v1.idempotencyKey }));
    expect(await familyRefusal(seed)).toBeNull();

    await seed.t.run((ctx) => ctx.db.patch(v1._id, { payload: { ...(v1.payload as object), ledgerDependencies: "junk" } }));
    expect(await familyRefusal(seed)).toMatch(/payable reclassification v1 carries ledger dependencies that cannot be read/);
    await expect(move(seed, custodyId, "REIMBURSED", jod(100))).rejects.toThrow(/payable reclassification v1 carries ledger dependencies that cannot be read/);
    expect((await entries(seed, custodyId)).filter((e) => e.kind === "REIMBURSED")).toHaveLength(0);
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => e.eventVersion)).toEqual([1]);
    await seed.t.run((ctx) => ctx.db.patch(v1._id, { payload: v1.payload }));
    expect(await familyRefusal(seed)).toBeNull();
    await move(seed, custodyId, "REIMBURSED", jod(100));
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => e.eventVersion)).toEqual([1, 2]);
  }, 45_000);
});

// ---------------------------------------------------------------------------
// R8 — the exact-SHA final review of 141f26a16 (Sonnet + Sol, CHANGES REQUESTED)
// ---------------------------------------------------------------------------

describe("R8-F2 — reopening a record whose parent application cannot be loaded for this org writes nothing: no override, no reversal, no status change, no classification withdrawn", () => {
  const APPLICATION_MISSING = /Finance application not found in this organization/;

  /** Another organization's CLASSIFIED deal, as a raw-edited custody row could point at it. */
  async function foreignClassifiedApplication(seed: Seed): Promise<Id<"financeApplications">> {
    const ours = (await seed.t.run((ctx) => ctx.db.get(seed.applicationId)))!;
    return await seed.t.run((ctx) =>
      ctx.db.insert("financeApplications", {
        orgId: seed.otherOrgId, quoteId: ours.quoteId, customerId: ours.customerId, vehicleId: ours.vehicleId,
        salespersonId: seed.userId, status: "APPROVED", accountingClassification: "CLASSIFIED",
        createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
  }

  /** A record closed with a written-off shortage of 50 — the closure whose reopening reverses a posted journal. */
  async function writtenOffRecord(seed: Seed) {
    const custodyId = await openCustody(seed, jod(700));
    await employeeFee(seed, custodyId, jod(650));
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
      orgId: seed.orgId, custodyId, notes: "short 50", writeOffReason: "lost", idempotencyKey: crypto.randomUUID(),
    });
    expect((await events(seed, "CUSTODY_WRITTEN_OFF")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    expect((await seed.t.run((ctx) => ctx.db.get(custodyId)))?.status).toBe("WRITTEN_OFF");
    return custodyId;
  }

  async function overrides(seed: Seed) {
    return await seed.t.run((ctx) => ctx.db.query("financeApplicationOverrides").collect());
  }

  async function reopenRefusesEntirely(seed: Seed, custodyId: Id<"financeDealCustody">) {
    const before = {
      custody: (await seed.t.run((ctx) => ctx.db.get(custodyId)))!,
      overrides: (await overrides(seed)).length,
      events: (await events(seed)).length,
      pending: (await pending(seed)).length,
      apps: await seed.t.run((ctx) => ctx.db.query("financeApplications").collect()),
    };
    await expect(
      seed.asUser.mutation(api.financeDealCosts.reopenDealCustody, { orgId: seed.orgId, custodyId, reason: "late receipt" })
    ).rejects.toThrow(APPLICATION_MISSING);
    // Nothing happened: the record is still closed, no audit row was written
    // against any deal, the write-off is still on the books and no deal —
    // least of all another organization's — lost its classification.
    expect(await seed.t.run((ctx) => ctx.db.get(custodyId))).toEqual(before.custody);
    expect((await overrides(seed)).length).toBe(before.overrides);
    expect((await events(seed)).length).toBe(before.events);
    expect((await pending(seed)).length).toBe(before.pending);
    expect((await events(seed, "CUSTODY_WRITTEN_OFF")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    expect(await seed.t.run((ctx) => ctx.db.query("financeApplications").collect())).toEqual(before.apps);
  }

  test("foreign: the closed record was re-pointed at another organization's classified deal", async () => {
    const seed = await seedDeal("r8-reopen-foreign");
    const custodyId = await writtenOffRecord(seed);
    const foreignAppId = await foreignClassifiedApplication(seed);
    await seed.t.run((ctx) => ctx.db.patch(custodyId, { applicationId: foreignAppId }));
    await reopenRefusesEntirely(seed, custodyId);
  }, 45_000);

  test("orphaned: the deal was deleted under the closed record", async () => {
    const seed = await seedDeal("r8-reopen-orphan");
    const custodyId = await writtenOffRecord(seed);
    await seed.t.run((ctx) => ctx.db.delete(seed.applicationId));
    await reopenRefusesEntirely(seed, custodyId);
  }, 45_000);
});

describe("R8-F3 — the worker proves a queued custody row IS the posting its key promises before it posts; a contradiction is held with nothing written", () => {
  type Queued = Doc<"pendingAccountingEvents">;
  const NOT_PROMISED = /not the posting its key promises|cannot be traced|not the delta its key promises/;

  /** One queued custody row, by key — the row as the worker will read it. */
  async function queuedRow(seed: Seed, idempotencyKey: string): Promise<Queued> {
    const row = (await pending(seed)).find((r) => r.idempotencyKey === idempotencyKey);
    expect(row?.status).toBe("PENDING");
    return row!;
  }

  /** A cash leg dated into a CLOSED month: queued, canonical, waiting only on the period. */
  async function queuedCashLeg(seed: Seed) {
    const { earlierId, boundary } = await splitPeriods(seed);
    await closePeriod(seed, earlierId);
    const custodyId = await openCustody(seed, jod(700), { occurredAt: boundary - 3 * DAY });
    const entry = (await entries(seed, custodyId)).find((e) => e.kind === "ISSUED")!;
    const row = await queuedRow(seed, `custody_entry_${entry._id}`);
    expect([row.eventType, row.eventVersion, row.sourceType, row.sourceId]).toEqual(["CUSTODY_CASH_ISSUED", 1, "financeDealCustodyEntries", entry._id]);
    return { earlierId, custodyId, entry, row };
  }

  /** The worker's whole guard, asked over an EDITED copy of a real queued row. */
  const guard = (seed: Seed, row: Queued, edit: Partial<Queued>) =>
    seed.t.run((ctx) => custodyPostingBlockedReason(ctx, { ...row, ...edit }));

  /**
   * ONE real worker attempt against the edited row, with the month open so
   * only the identity check stands between the row and the ledger: the row
   * must stay PENDING with no attempt burned and the contradiction named,
   * and the ledger, the journal and every other row exactly as they were.
   */
  async function workerWritesNothing(seed: Seed, row: Queued, edit: Partial<Queued>) {
    await seed.t.run((ctx) => ctx.db.patch(row._id, edit));
    const before = {
      events: await events(seed),
      journals: await seed.t.run(async (ctx) =>
        (await ctx.db.query("journalEntries").withIndex("by_org_period", (q) => q.eq("orgId", seed.orgId)).collect()).length
      ),
      pending: (await pending(seed)).map((r) => [r._id, r.status, r.attempts]),
    };
    await drainOnce(seed);
    const after = (await pending(seed)).find((r) => r._id === row._id)!;
    expect(after.status).toBe("PENDING");
    expect(after.attempts).toBe(0);
    expect(after.lastError).toMatch(NOT_PROMISED);
    expect(await events(seed)).toEqual(before.events);
    expect(
      await seed.t.run(async (ctx) =>
        (await ctx.db.query("journalEntries").withIndex("by_org_period", (q) => q.eq("orgId", seed.orgId)).collect()).length
      )
    ).toBe(before.journals);
    expect((await pending(seed)).map((r) => [r._id, r.status, r.attempts])).toEqual(before.pending);
    // Restored to the shape its key promises, the same row posts on the next attempt.
    const { _id: _drop, _creationTime: _dropCt, ...original } = row;
    void _drop; void _dropCt;
    await seed.t.run((ctx) => ctx.db.replace(row._id, original));
  }

  test("the identity predicate, from the row alone: every contradiction between key, event type, source and version is named, and every canonical row passes", async () => {
    const seed = await seedDeal("r8-identity-pure");
    const { entry, row } = await queuedCashLeg(seed);
    const custodyId = row.payload && (row.payload as { custodyId: string }).custodyId;
    // Canonical shapes pass — each family's, as the hooks mint them.
    expect(custodyCanonicalIdentityRefusal(row)).toBeNull();
    expect(custodyCanonicalIdentityRefusal({ idempotencyKey: `custody_fee_paid_${entry._id}_v3`, eventType: "CUSTODY_FEE_PAID", eventVersion: 3, sourceType: "financeDealFees", sourceId: entry._id })).toBeNull();
    expect(custodyCanonicalIdentityRefusal({ idempotencyKey: `custody_written_off_${custodyId}_v2`, eventType: "CUSTODY_WRITTEN_OFF", eventVersion: 2, sourceType: "financeDealCustody", sourceId: custodyId as string })).toBeNull();
    expect(custodyCanonicalIdentityRefusal({ idempotencyKey: `custody_payable_reclass_${custodyId}_v1`, eventType: "CUSTODY_PAYABLE_RECLASSIFIED", eventVersion: 1, sourceType: "financeDealCustody", sourceId: custodyId as string, payload: { custodyId } })).toBeNull();
    // A row that is nobody's custody posting is none of this guard's business.
    expect(custodyCanonicalIdentityRefusal({ idempotencyKey: "sale_recognized_x", eventType: "SALE_RECOGNIZED", eventVersion: 1, sourceType: "vehicleSales", sourceId: "x" })).toBeNull();
    // A cash leg at any version but 1, of another custody type, on another
    // source, under another leg's key, or with no readable version.
    expect(custodyCanonicalIdentityRefusal({ ...row, eventVersion: 2 })).toMatch(/posts once, at version 1/);
    expect(custodyCanonicalIdentityRefusal({ ...row, eventType: "CUSTODY_FEE_PAID" })).toMatch(/keyed on financeDealCustodyEntries rather than financeDealFees/);
    expect(custodyCanonicalIdentityRefusal({ ...row, sourceType: "financeDealCustody" })).toMatch(/keyed on financeDealCustody rather than financeDealCustodyEntries/);
    expect(custodyCanonicalIdentityRefusal({ ...row, idempotencyKey: `custody_entry_${custodyId}` })).toMatch(/queued under custody_entry_/);
    expect(custodyCanonicalIdentityRefusal({ ...row, sourceId: custodyId as string })).toMatch(/queued under custody_entry_/);
    for (const bad of [undefined, NaN, Infinity, 1.5, 0]) {
      expect(custodyCanonicalIdentityRefusal({ ...row, eventVersion: bad })).toMatch(/version that is not a positive whole number/);
    }
    // A custody key carrying a foreign event type, or no type; a custody type under a foreign key.
    expect(custodyCanonicalIdentityRefusal({ ...row, eventType: "SALE_RECOGNIZED" })).toMatch(/carries a SALE_RECOGNIZED event, so it is not the posting its key promises/);
    expect(custodyCanonicalIdentityRefusal({ ...row, eventType: undefined })).toMatch(/carries no event type/);
    expect(custodyCanonicalIdentityRefusal({ ...row, idempotencyKey: "sale_recognized_x" })).toMatch(/under a key that is not a custody posting's/);
    // A fee posting whose key names another version, or another line, than the row does — at v1 too, where the order check never looked.
    expect(custodyCanonicalIdentityRefusal({ idempotencyKey: `custody_fee_paid_${entry._id}_v1`, eventType: "CUSTODY_FEE_PAID", eventVersion: 2, sourceType: "financeDealFees", sourceId: entry._id })).toMatch(/at version 2, whose posting is keyed custody_fee_paid_.*_v2, but it is queued under custody_fee_paid_.*_v1/);
    expect(custodyCanonicalIdentityRefusal({ idempotencyKey: `custody_fee_paid_${entry._id}_v1`, eventType: "CUSTODY_FEE_PAID", eventVersion: 1, sourceType: "financeDealCustody", sourceId: entry._id })).toMatch(/keyed on financeDealCustody rather than financeDealFees/);
    // A payable delta whose payload follows another record's chain.
    expect(custodyCanonicalIdentityRefusal({ idempotencyKey: `custody_payable_reclass_${custodyId}_v1`, eventType: "CUSTODY_PAYABLE_RECLASSIFIED", eventVersion: 1, sourceType: "financeDealCustody", sourceId: custodyId as string, payload: { custodyId: entry._id } })).toMatch(/whose payload names/);
    expect(custodyCanonicalIdentityRefusal({ idempotencyKey: `custody_payable_reclass_${custodyId}_v1`, eventType: "CUSTODY_PAYABLE_RECLASSIFIED", eventVersion: 1, sourceType: "financeDealCustody", sourceId: custodyId as string, payload: {} })).toMatch(/names no custody record/);
    // The worker's guard runs the same predicate FIRST: the contradiction is
    // the reason, ahead of any period, predecessor or dependency reading.
    expect(await guard(seed, row, { eventVersion: 2 })).toMatch(/posts once, at version 1/);
    expect(await guard(seed, row, { eventType: "CUSTODY_PAYABLE_RECLASSIFIED", sourceType: "financeDealCustody", sourceId: custodyId as string, eventVersion: 1 })).toMatch(/queued under custody_entry_/);
    expect(await guard(seed, row, {})).toBeNull();
  }, 45_000);

  test("worker, cash leg: a queued leg whose version, type or key contradict one another is held, and posts unchanged once restored", async () => {
    const seed = await seedDeal("r8-identity-leg");
    const { earlierId, row } = await queuedCashLeg(seed);
    await reopenPeriod(seed, earlierId);
    await workerWritesNothing(seed, row, { eventVersion: 2 });
    await workerWritesNothing(seed, row, { eventType: "CUSTODY_FEE_PAID" });
    await workerWritesNothing(seed, row, { idempotencyKey: `custody_entry_${row.sourceId}x` });
    await drainOnce(seed);
    expect((await pending(seed)).find((r) => r._id === row._id)?.status).toBe("POSTED");
    expect((await events(seed, "CUSTODY_CASH_ISSUED")).map((e) => [e.idempotencyKey, e.eventVersion, e.status])).toEqual([[row.idempotencyKey, 1, "POSTED"]]);
    expect(await familyRefusal(seed)).toBeNull();
  }, 60_000);

  test("worker, fee posting and payable delta: a v1 keyed on the wrong source, a version the key does not name, a delta on another record's chain — each held, nothing written, and the family posts once restored", async () => {
    const seed = await seedDeal("r8-identity-fee");
    const { earlierId, boundary } = await splitPeriods(seed);
    await closePeriod(seed, earlierId);
    const custodyId = await openCustody(seed, jod(700));
    const feeId = await employeeFee(seed, custodyId, jod(900), { paidAt: boundary - 5 * DAY });
    const fee = await queuedRow(seed, `custody_fee_paid_${feeId}_v1`);
    const delta = await queuedRow(seed, `custody_payable_reclass_${custodyId}_v1`);
    await reopenPeriod(seed, earlierId);
    // The delta is chained behind the fee (SETTLED), so while the fee is
    // held for its identity the delta is held for its dependency: the
    // fee's contradictions are what these attempts prove.
    await workerWritesNothing(seed, fee, { sourceType: "financeDealCustody" });
    await workerWritesNothing(seed, fee, { eventVersion: 2 });
    await workerWritesNothing(seed, fee, { eventType: "CUSTODY_WRITTEN_OFF" });
    // The fee posts and frees the delta in the same drain — so the delta's
    // first contradiction is already in place when it does, and the delta's
    // own identity is what stands between it and the ledger.
    await seed.t.run((ctx) => ctx.db.patch(delta._id, { payload: { ...(delta.payload as object), custodyId: feeId } }));
    await drainOnce(seed);
    expect((await events(seed, "CUSTODY_FEE_PAID")).map((e) => [e.eventVersion, e.status])).toEqual([[1, "POSTED"]]);
    expect(await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).toHaveLength(0);
    const heldDelta = (await pending(seed)).find((r) => r._id === delta._id)!;
    expect([heldDelta.status, heldDelta.attempts]).toEqual(["PENDING", 0]);
    expect(heldDelta.lastError).toMatch(/whose payload names/);
    await seed.t.run((ctx) => ctx.db.patch(delta._id, { payload: delta.payload }));
    await workerWritesNothing(seed, delta, { eventType: "CUSTODY_CASH_ISSUED", sourceType: "financeDealCustodyEntries" });
    await workerWritesNothing(seed, delta, { eventVersion: 2 });
    await drainUntilSettled(seed);
    expect((await pending(seed)).every((r) => r.status === "POSTED")).toBe(true);
    expect((await events(seed, "CUSTODY_PAYABLE_RECLASSIFIED")).map((e) => [e.idempotencyKey, e.eventVersion, e.status])).toEqual([[delta.idempotencyKey, 1, "POSTED"]]);
    expect(payable(await ledger(seed))).toBe(-jod(200));
    expect(await familyRefusal(seed)).toBeNull();
  }, 90_000);
});
