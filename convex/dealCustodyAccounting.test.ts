import { TestConvex as ConvexTestInstance } from "convex-test";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS, PERMISSIONS } from "./utils/permissions";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { deriveRecommendedCustody } from "./financeDealCosts";

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

    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: seed.orgId, custodyId, notes: "Receipts on file." });
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
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
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
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
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
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
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
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: seed.orgId, custodyId, notes: "All back." });
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

    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: seed.orgId, custodyId, notes: "Receipt matches." });
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
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: seed.orgId, custodyId, notes: "Settled after close." });
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
      seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: seed.orgId, custodyId: legacyId, notes: "short", writeOffReason: "lost" })
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
    await b.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: b.orgId, custodyId: custodyB, notes: "Receipts checked." });
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
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, {
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
      asHolder.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: seed.orgId, custodyId, notes: "mine", writeOffReason: "mine" })
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
    await expect(asOther.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: seed.otherOrgId, custodyId, notes: "n" })).rejects.toThrow(/not found/);
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
    await seed.asUser.mutation(api.financeDealCosts.reconcileDealCustody, { orgId: seed.orgId, custodyId, notes: "5 returned in coins.", writeOffReason: "coins" });
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
