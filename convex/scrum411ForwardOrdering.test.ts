/**
 * SCRUM-407 c21031/c21033 + SCRUM-411 P2-01/P2-03 - the deposit H and the
 * dealership's contribution D are paid to the finance company BEFORE the deal
 * is finalized, on both routes, and the held deposit is never silently dropped.
 *
 * Worked figures (JOD, 3 decimals; never read back from the code under test):
 *   A approved 12,500   E supplier entitlement 9,000   R customer gap 500
 *   H held deposit 200  D contribution 1,375           forward due H + D = 1,575
 *
 * Direct route, expected sale entry (hand-worked, balanced at 5,575):
 *   Dr supplier claim A - E        3,500     Cr commission  A + R - E   4,000
 *   Dr customer receivable R         500     Cr AP-finance  H + D       1,575
 *   Dr deposit liability H           200
 *   Dr contra-revenue D            1,375
 *   finance receivable 0; net revenue A + R - E - D = 2,625.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime and not production data.
 */
import {
  C, G, H, finalizeAsOwner, readyDeal, refusalDataOf, refusalMessageOf, seedFinancedDealership,
} from "../test-utils/financedDealFixture";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  deriveForwardState,
  forwardFinalizeBlock,
  forwardFinalizeRefusal,
  forwardPostKey,
  type ForwardProof,
  type ForwardState,
  type ForwardVersionState,
} from "./utils/financeCompanyForward";
import { buildFinancedSalePostingPlanV3 } from "./utils/financedSalePostingPlan";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

const ALL_PERMS = [
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

const FORWARD = H + C; // 1,575,000
const R = 500_000;

async function seed(tag: string, sourced: boolean) {
  return await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMS, label: "S411F", vinPrefix: "VIN411F", actors: {}, sourced,
  });
}
type Seeded = Awaited<ReturnType<typeof seed>>;
type AppId = Id<"financeApplications">;

const payForward = (s: Seeded, applicationId: AppId, over: { expected?: number; idempotencyKey?: string } = {}) =>
  s.owner.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", paidAt: Date.now(),
    expectedAmountMinor: over.expected ?? FORWARD, idempotencyKey: over.idempotencyKey ?? crypto.randomUUID(),
  });

const voidForward = (s: Seeded, applicationId: AppId, forwardId: Id<"financeCompanyForwards">) =>
  s.owner.as.mutation(api.financeCompanyForward.reverseFinanceCompanyForward, {
    orgId: s.orgId, applicationId, forwardId, reason: "Recorded in error.", idempotencyKey: crypto.randomUUID(),
  });

const returnForward = (s: Seeded, applicationId: AppId, forwardId: Id<"financeCompanyForwards">) =>
  s.owner.as.mutation(api.financeCompanyForward.reportFinanceCompanyForwardReturned, {
    orgId: s.orgId, applicationId, forwardId, reason: "The company sent it back.", idempotencyKey: crypto.randomUUID(),
  });

// The seeded deposit was created by the owner, who therefore may not refund or forfeit it:
// a deposit treatment is chosen by the second identity (the approver).
const finalize = (s: Seeded, applicationId: AppId, depositResolution?: { treatment: "REFUND_TO_CUSTOMER" | "FORFEITED"; refundMethod?: "CASH" }) =>
  (depositResolution ? s.approver : s.owner).as.mutation(api.applications.finalizeDeal, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId,
    ...(depositResolution ? { depositResolution } : {}),
  });

/** A refusal's text, or a loud marker when the call was accepted (so toMatch fails on a value, not a TypeError). */
const refusedWith = async (promise: Promise<unknown>) => (await refusalMessageOf(promise)) ?? "<<ACCEPTED - NO REFUSAL>>";

const cancel = (s: Seeded, applicationId: AppId) =>
  s.owner.as.mutation(api.applications.cancelApplication, {
    orgId: s.orgId, applicationId, reason: "Customer withdrew.", idempotencyKey: crypto.randomUUID(),
  });

const confirmSupplier = (s: Seeded, applicationId: AppId) =>
  s.owner.as.mutation(api.applications.confirmSupplierDisbursement, {
    orgId: s.orgId, applicationId, disbursedAmountMinor: G, idempotencyKey: crypto.randomUUID(),
  });

/** What the deal screen is told, before the sale, about the payment to the finance company. */
const status = (s: Seeded, applicationId: AppId, as = s.owner.as) =>
  as.query(api.financeCompanyForward.preFinalizeForwardStatus, { orgId: s.orgId, applicationId });

const proofOf = (s: Seeded, applicationId: AppId) =>
  s.t.run(async (ctx) => deriveForwardState(ctx, (await ctx.db.get(applicationId))!));

/** Net debit-positive movement per account across the live events of one type. */
async function netByAccount(s: Seeded, eventType: string) {
  return await s.t.run(async (ctx) => {
    const events = (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).filter(
      (e) => e.eventType === eventType && e.status !== "REVERSED"
    );
    const entries = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    const net = new Map<string, number>();
    for (const event of events) {
      for (const entry of entries.filter((e) => e.accountingEventId === event._id)) {
        const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)).collect();
        for (const line of lines) {
          const account = await ctx.db.get(line.accountId);
          const key = account?.systemKey ?? String(line.accountId);
          net.set(key, (net.get(key) ?? 0) + line.debitMinor - line.creditMinor);
        }
      }
    }
    return Object.fromEntries(net) as Record<string, number>;
  });
}

/** Net movement per account across EVERY journal line in the org, reversals included. */
async function everyLineNet(s: Seeded) {
  return await s.t.run(async (ctx) => {
    const lines = await ctx.db.query("journalLines").collect();
    const net = new Map<string, number>();
    for (const line of lines) {
      const account = await ctx.db.get(line.accountId);
      const key = account?.systemKey ?? String(line.accountId);
      net.set(key, (net.get(key) ?? 0) + line.debitMinor - line.creditMinor);
    }
    return Object.fromEntries(net) as Record<string, number>;
  });
}

const writes = (s: Seeded) =>
  s.t.run(async (ctx) => ({
    sales: (await ctx.db.query("sales").collect()).length,
    events: (await ctx.db.query("accountingEvents").collect()).length,
    forwards: (await ctx.db.query("financeCompanyForwards").collect()).length,
  }));

describe("blocker 1 - the v3 plan carries a held deposit on the direct route", () => {
  const input = {
    currency: "JOD", approvedAmountMinor: G, hasSettlementComponents: false, customerReceivableMinor: R,
    depositLiabilityAppliedMinor: H, dealerContributionMinor: C, customerFirstPaymentMinor: H, settlesDirect: true,
  };

  test("direct + H 200 + D 1,375 + R 500: K 13,000, forward due 1,575, no finance receivable", () => {
    const result = buildFinancedSalePostingPlanV3(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.considerationMinor).toBe(13_000_000);
    expect(result.plan.financeCompanyReceivableMinor).toBe(0);
    expect(result.plan.depositLiabilityAppliedMinor).toBe(200_000);
    expect(result.plan.forwardDepositMinor).toBe(200_000);
    expect(result.plan.forwardContributionMinor).toBe(1_375_000);
    expect(result.plan.forwardDueMinor).toBe(1_575_000);
    expect(result.plan.fingerprint).toBe("v3;JOD;K13000000;G12500000;F1575000;D200000;C1375000;R500000;DIRECT");
  });

  test("a deposit larger than the agreed first payment is still refused on the direct route", () => {
    const result = buildFinancedSalePostingPlanV3({ ...input, customerFirstPaymentMinor: H - 1 });
    expect(result.ok).toBe(false);
  });
});

describe("blocker 1 - the direct-route sale entry with a held deposit", () => {
  test("A 12,500, E 9,000, R 500, H 200, D 1,375: the hand-worked entry posts once and balances", async () => {
    const s = await seed("b1a", true);
    const { applicationId } = await readyDeal(s, { route: "DIRECT_TO_SUPPLIER", gapMinor: R });
    await payForward(s, applicationId);
    await finalizeAsOwner(s, applicationId);

    const app = (await s.t.run((ctx) => ctx.db.get(applicationId)))!;
    expect(app.status).toBe("CLOSED");
    expect(app.financedSaleNetReceivableMinor).toBe(0);
    expect(app.financeCompanyForwardDueMinor).toBe(FORWARD);
    expect(app.forwardDepositPortionMinor).toBe(H);
    expect(app.forwardContributionPortionMinor).toBe(C);

    const net = await netByAccount(s, "SALE_COMPLETED");
    expect(net.RECEIVABLE_FROM_SUPPLIERS).toBe(3_500_000);
    expect(net.ACCOUNTS_RECEIVABLE_CUSTOMERS).toBe(R);
    expect(net.CUSTOMER_DEPOSITS_LIABILITY).toBe(200_000);
    expect(net.SALES_CONSIDERATION_REDUCTIONS).toBe(1_375_000);
    expect(net.CONSIGNMENT_COMMISSION_REVENUE).toBe(-4_000_000);
    expect(net.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-1_575_000);
    expect(net.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES ?? 0).toBe(0);
    expect(Object.values(net).reduce((sum, amount) => sum + amount, 0)).toBe(0);

    // The deposit's discharge is the sale entry's debit above; a second application
    // event would release the same liability twice.
    const events = await s.t.run((ctx) => ctx.db.query("accountingEvents").collect());
    expect(events.filter((e) => e.eventType === "DEPOSIT_APPLIED")).toEqual([]);

    // AP-finance: the sale credits 1,575 and the earlier payment debited 1,575.
    const all = await everyLineNet(s);
    expect(all.ACCOUNTS_PAYABLE_FINANCE_COMPANIES ?? 0).toBe(0);

    const claims = await s.t.run((ctx) => ctx.db.query("vehicleSupplierReceivables").collect());
    expect(claims.map((c) => c.amountDue)).toEqual([3_500]);
    const sale = (await s.t.run((ctx) => ctx.db.get(app.finalizedSaleId!)))!;
    // Net K - E - D = 2,625, beside the consideration K = A + R = 13,000 it was worked from.
    expect(sale.financedNetRevenue).toEqual({ minor: 2_625_000, currency: "JOD", considerationMinor: 13_000_000 });
    const deposits = await s.t.run((ctx) => ctx.db.query("deposits").collect());
    expect(deposits.map((d) => d.status)).toEqual(["APPLIED"]);
  });
});

describe("blocker 2 - the payment precedes finalize and binds to the frozen figures", () => {
  test("finalize without the payment is refused and writes nothing", async () => {
    const s = await seed("b2a", false);
    const { applicationId } = await readyDeal(s);
    const refusal = await refusalDataOf(finalize(s, applicationId));
    expect(refusal?.code).toBe("FORWARD_FINALIZE_UNPAID");
    expect(refusal?.message).toMatch(/payment to the finance company/i);
    expect(refusal?.message).toMatch(/before finalizing/i);
    expect(await writes(s)).toEqual({ sales: 0, events: 0, forwards: 0 });
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("APPROVED");
  });

  test("the payment is recorded against the prospective figures, then finalize closes and the proof is SETTLED", async () => {
    const s = await seed("b2b", false);
    const { applicationId } = await readyDeal(s);
    const forwardId = await payForward(s, applicationId);
    const row = (await s.t.run((ctx) => ctx.db.get(forwardId)))!;
    expect(row.amountMinor).toBe(FORWARD);
    expect(row.depositPortionMinor).toBe(H);
    expect(row.contributionPortionMinor).toBe(C);
    expect(row.planFingerprint).toBe("v3;JOD;K12500000;G12500000;F1575000;D200000;C1375000;R0");

    // Before the sale: Dr AP-finance 1,575 against cash.
    const paid = await netByAccount(s, "FINANCE_COMPANY_FORWARD_PAID");
    expect(paid.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(FORWARD);
    expect(Object.values(paid).reduce((sum, amount) => sum + amount, 0)).toBe(0);

    await finalizeAsOwner(s, applicationId);
    const proof = await proofOf(s, applicationId);
    expect(proof.state).toBe("SETTLED");
    expect(proof.dueMinor).toBe(FORWARD);
    const all = await everyLineNet(s);
    expect(all.ACCOUNTS_PAYABLE_FINANCE_COMPANIES ?? 0).toBe(0);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.financedSaleRecognitionFingerprint).toBe(row.planFingerprint);
  });

  test("a payment is refused until the deal is approved", async () => {
    const s = await seed("b2c", false);
    const { applicationId } = await readyDeal(s);
    await s.t.run((ctx) => ctx.db.patch(applicationId, { status: "UNDER_REVIEW" }));
    expect(await refusalMessageOf(payForward(s, applicationId))).toMatch(/must be approved/i);
    expect((await writes(s)).forwards).toBe(0);
  });

  test("the amount the payer saw is pinned before finalize too", async () => {
    const s = await seed("b2d", false);
    const { applicationId } = await readyDeal(s);
    expect(await refusalMessageOf(payForward(s, applicationId, { expected: FORWARD - 1 }))).toMatch(/changed since you opened/i);
    expect((await writes(s)).forwards).toBe(0);
  });

  test("a contribution changed after the payment invalidates it: finalize refuses until it is taken back and re-recorded", async () => {
    const s = await seed("b2e", false);
    const { applicationId } = await readyDeal(s);
    const first = await payForward(s, applicationId);
    await s.t.run((ctx) => ctx.db.patch(applicationId, { dealerContributionMinor: C + 100_000 }));

    const stale = await refusalDataOf(finalize(s, applicationId));
    expect(stale?.code).toBe("FORWARD_FINALIZE_STALE");
    expect(stale?.message).toMatch(/different figures/i);
    expect(await writes(s)).toMatchObject({ sales: 0 });

    // The old payment is not enough, and a second one cannot sit beside it.
    expect(await refusalMessageOf(payForward(s, applicationId, { expected: FORWARD + 100_000 }))).toMatch(/already recorded|not settled|different figures/i);

    await voidForward(s, applicationId, first);
    await payForward(s, applicationId, { expected: FORWARD + 100_000 });
    await finalizeAsOwner(s, applicationId);
    const app = (await s.t.run((ctx) => ctx.db.get(applicationId)))!;
    expect(app.financeCompanyForwardDueMinor).toBe(FORWARD + 100_000);
    expect((await proofOf(s, applicationId)).state).toBe("SETTLED");
  });

  test("a deposit treatment chosen at finalize that changes H also invalidates the payment", async () => {
    const s = await seed("b2f", false);
    const { applicationId } = await readyDeal(s);
    await payForward(s, applicationId);
    // No first payment is agreed, so forfeiting the deposit is not refused for leaving it unfunded;
    // it makes H 0 and D alone 1,375 - not the 1,575 that was paid, so the payment no longer counts.
    await s.t.run((ctx) => ctx.db.patch(applicationId, { customerFirstPaymentMinor: 0 }));
    const refusal = await refusalDataOf(finalize(s, applicationId, { treatment: "FORFEITED" }));
    expect(refusal?.code).toBe("FORWARD_FINALIZE_STALE");
    expect((await writes(s)).sales).toBe(0);
  });

  test("an agreed first payment is the reason a forfeiture at finalize is refused, before the payment is judged", async () => {
    const s = await seed("b2f2", false);
    const { applicationId } = await readyDeal(s);
    await payForward(s, applicationId);
    const refusal = await refusalDataOf(finalize(s, applicationId, { treatment: "FORFEITED" }));
    expect(refusal?.code).toBe("FIRST_PAYMENT_UNFUNDED");
    expect(refusal?.message).toMatch(/first payment/i);
    expect((await writes(s)).sales).toBe(0);
  });

  test("cancelling before finalize is refused while a payment is on the books, and allowed once it is taken back", async () => {
    const s = await seed("b2g", false);
    const { applicationId } = await readyDeal(s);
    const forwardId = await payForward(s, applicationId);
    expect(await refusalMessageOf(cancel(s, applicationId))).toMatch(/already been paid to the finance company/i);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("APPROVED");

    await voidForward(s, applicationId, forwardId);
    expect(await refusalMessageOf(cancel(s, applicationId))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
    // The payment and its reversal net to nothing.
    const all = await everyLineNet(s);
    expect(all.ACCOUNTS_PAYABLE_FINANCE_COMPANIES ?? 0).toBe(0);
  });

  test("a deal that owes nothing onward needs no payment", async () => {
    const s = await seed("b2h", false);
    const { applicationId } = await readyDeal(s, { contributionMinor: 0, deposit: false });
    await finalizeAsOwner(s, applicationId);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");
    expect((await proofOf(s, applicationId)).state).toBe("NOT_DUE");
  });
});

describe("pre-finalize status - what the deal screen shows before the sale", () => {
  test("UNPAID, then SETTLED, then STALE, then UNPAID again: each state is the refusal finalize makes at that moment", async () => {
    const s = await seed("ps1", false);
    const { applicationId } = await readyDeal(s);

    expect(await status(s, applicationId)).toEqual({
      state: "UNPAID", mayRecord: true, onBooksForwardId: null, blocksCancel: false,
      money: { dueMinor: FORWARD, depositMinor: H, contributionMinor: C, onBooksMinor: 0 },
    });
    expect(await refusedWith(finalize(s, applicationId))).toMatch(/have not been paid yet/i);

    const first = await payForward(s, applicationId);
    expect(await status(s, applicationId)).toEqual({
      state: "SETTLED", mayRecord: true, onBooksForwardId: first, blocksCancel: true,
      money: { dueMinor: FORWARD, depositMinor: H, contributionMinor: C, onBooksMinor: FORWARD },
    });

    await s.t.run((ctx) => ctx.db.patch(applicationId, { dealerContributionMinor: C + 100_000 }));
    expect(await status(s, applicationId)).toEqual({
      state: "STALE", mayRecord: true, onBooksForwardId: first, blocksCancel: true,
      money: { dueMinor: FORWARD + 100_000, depositMinor: H, contributionMinor: C + 100_000, onBooksMinor: FORWARD },
    });
    expect(await refusedWith(finalize(s, applicationId))).toMatch(/different figures/i);

    await voidForward(s, applicationId, first);
    expect(await status(s, applicationId)).toEqual({
      state: "UNPAID", mayRecord: true, onBooksForwardId: null, blocksCancel: false,
      money: { dueMinor: FORWARD + 100_000, depositMinor: H, contributionMinor: C + 100_000, onBooksMinor: 0 },
    });
  });

  test("a caller who may read finance applications but not the economics sees the state, never a figure or a record right", async () => {
    const s = await seed("ps2", false);
    const { applicationId } = await readyDeal(s);
    const userId = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "ps2_view", email: "ps2.view@example.com", name: "viewer" }));
    const roleId = await s.t.run((ctx) => ctx.db.insert("roles", { orgId: s.orgId, name: "VIEWER", permissions: ["view:finance_applications"] }));
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId }));
    const asViewer = s.t.withIdentity({ subject: "ps2_view", clerkId: "ps2_view" });

    expect(await status(s, applicationId, asViewer)).toEqual({ state: "UNPAID", mayRecord: false, onBooksForwardId: null, blocksCancel: false, money: null });
    await payForward(s, applicationId);
    const settled = await status(s, applicationId, asViewer);
    expect(settled?.state).toBe("SETTLED");
    expect(settled?.money).toBeNull();
  });

  test("a deal that owes nothing onward is NOT_OWED; a deal that is not approved or is already finalized has no status", async () => {
    const s = await seed("ps3", false);
    const { applicationId } = await readyDeal(s, { contributionMinor: 0, deposit: false });
    expect((await status(s, applicationId))?.state).toBe("NOT_OWED");

    await finalizeAsOwner(s, applicationId);
    expect(await status(s, applicationId)).toBeNull();

    const other = await seed("ps4", false);
    const second = await readyDeal(other);
    await other.t.run((ctx) => ctx.db.patch(second.applicationId, { status: "UNDER_REVIEW" }));
    expect(await status(other, second.applicationId)).toBeNull();
  });

  test("forwardFinalizeBlock names the refusal for every state a payment can be in", () => {
    const proof = (state: ForwardState, versions: ForwardVersionState[] = []): ForwardProof => ({
      applies: true, dueMinor: FORWARD, state, onBooksForwardId: null, returnedExceptionOpen: false,
      versions: versions.map((versionState, index) => ({
        forwardId: `f${index}` as Id<"financeCompanyForwards">, version: index + 1, state: versionState, amountMinor: FORWARD,
      })),
    });
    expect(forwardFinalizeBlock(proof("NOT_DUE"))).toBeNull();
    expect(forwardFinalizeBlock(proof("SETTLED", ["ON_BOOKS"]))).toBeNull();
    expect(forwardFinalizeBlock(proof("DUE"))).toBe("UNPAID");
    expect(forwardFinalizeBlock(proof("DUE", ["REVERSED"]))).toBe("UNPAID");
    // On the books against other figures: the one state where taking the payment back is the way forward.
    expect(forwardFinalizeBlock(proof("NEEDS_REPAIR", ["ON_BOOKS"]))).toBe("STALE");
    // A record the books do not back is a repair for an accountant, not a stale figure.
    expect(forwardFinalizeBlock(proof("NEEDS_REPAIR", ["NEEDS_REPAIR"]))).toBe("NEEDS_REPAIR");
    expect(forwardFinalizeBlock(proof("NEEDS_REPAIR"))).toBe("NEEDS_REPAIR");
    expect(forwardFinalizeBlock(proof("POSTING_PENDING", ["POSTING_PENDING"]))).toBe("POSTING_PENDING");
    expect(forwardFinalizeBlock(proof("POSTING_FAILED", ["POSTING_FAILED"]))).toBe("POSTING_FAILED");
    expect(forwardFinalizeBlock(proof("REVERSAL_PENDING", ["REVERSAL_PENDING"]))).toBe("REVERSAL_PENDING");
    // The sentence and the code are one derivation: the sentence exists exactly when the code does.
    for (const candidate of [proof("DUE"), proof("NEEDS_REPAIR", ["ON_BOOKS"]), proof("POSTING_PENDING", ["POSTING_PENDING"]), proof("SETTLED", ["ON_BOOKS"])]) {
      expect(forwardFinalizeRefusal(candidate) === null).toBe(forwardFinalizeBlock(candidate) === null);
    }
  });
});

describe("blocker 3 - the company's payment to the supplier needs the forward proof", () => {
  async function closedDirect(tag: string) {
    const s = await seed(tag, true);
    const { applicationId } = await readyDeal(s, { route: "DIRECT_TO_SUPPLIER", gapMinor: R });
    const forwardId = await payForward(s, applicationId);
    await finalizeAsOwner(s, applicationId);
    return { s, applicationId, forwardId };
  }

  test("SETTLED: the supplier payment is recorded", async () => {
    const { s, applicationId } = await closedDirect("b3a");
    expect(await refusalMessageOf(confirmSupplier(s, applicationId))).toBeNull();
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.supplierDisbursementConfirmedAt).toBeDefined();
  });

  test("DUE (payment taken back): refused, names who acts next, never echoes H or D, writes nothing", async () => {
    const { s, applicationId, forwardId } = await closedDirect("b3b");
    await voidForward(s, applicationId, forwardId);
    const refusal = await refusalDataOf(confirmSupplier(s, applicationId));
    expect(refusal?.code).toBe("FORWARD_TRANSFER_UNPAID");
    expect(refusal?.message).toMatch(/manager or accountant records that payment/i);
    expect(refusal?.message).not.toMatch(/200|1[,.]?375|1[,.]?575/);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.supplierDisbursementConfirmedAt).toBeUndefined();
  });

  test("underpaid: a payment smaller than H + D is not proof", async () => {
    const { s, applicationId, forwardId } = await closedDirect("b3c");
    await s.t.run((ctx) => ctx.db.patch(forwardId, { amountMinor: FORWARD - 1 }));
    expect((await proofOf(s, applicationId)).state).toBe("NEEDS_REPAIR");
    const refusal = await refusalDataOf(confirmSupplier(s, applicationId));
    expect(refusal?.code).toBe("FORWARD_TRANSFER_NEEDS_REPAIR");
    expect(refusal?.message).toMatch(/does not match the books/i);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.supplierDisbursementConfirmedAt).toBeUndefined();
  });

  test("duplicate: two payments on the books are not proof", async () => {
    const { s, applicationId, forwardId } = await closedDirect("b3d");
    await s.t.run(async (ctx) => {
      const row = (await ctx.db.get(forwardId))!;
      const { _id, _creationTime, ...rest } = row;
      void _id; void _creationTime;
      await ctx.db.insert("financeCompanyForwards", { ...rest, version: 2 });
      const original = (await ctx.db.query("accountingEvents").collect()).find((e) => e.eventType === "FINANCE_COMPANY_FORWARD_PAID")!;
      const { _id: eventId, _creationTime: eventCreated, ...eventRest } = original;
      void eventId; void eventCreated;
      await ctx.db.insert("accountingEvents", { ...eventRest, eventVersion: 2, idempotencyKey: forwardPostKey(applicationId, 2) });
    });
    expect((await proofOf(s, applicationId)).state).toBe("NEEDS_REPAIR");
    expect(await refusalMessageOf(confirmSupplier(s, applicationId))).toMatch(/does not match the books/i);
  });

  test("a superseded (taken-back) payment alone is not proof either", async () => {
    const { s, applicationId, forwardId } = await closedDirect("b3e");
    await voidForward(s, applicationId, forwardId);
    const proof = await proofOf(s, applicationId);
    expect(proof.versions.map((v) => v.state)).toEqual(["REVERSED"]);
    expect((await refusalDataOf(confirmSupplier(s, applicationId)))?.code).toBe("FORWARD_TRANSFER_UNPAID");
  });
});

describe("blocker 4 - a held deposit that is not applied cannot leave the first payment unfunded", () => {
  const refund = { treatment: "REFUND_TO_CUSTOMER" as const, refundMethod: "CASH" as const };

  test.each([
    ["through the dealership", false, undefined],
    ["direct to the supplier", true, "DIRECT_TO_SUPPLIER" as const],
  ])("%s: a refund at finalize with an agreed first payment of 200 is refused before the first write", async (_name, sourced, route) => {
    const s = await seed(`b4_${String(sourced)}`, sourced);
    const { applicationId } = await readyDeal(s, route ? { route } : {});
    const refusal = await refusalDataOf(finalize(s, applicationId, refund));
    expect(refusal?.code).toBe("FIRST_PAYMENT_UNFUNDED");
    expect(refusal?.message).toMatch(/first payment/i);
    expect(refusal?.message).toMatch(/replac|amend|apply/i);
    expect(await writes(s)).toEqual({ sales: 0, events: 0, forwards: 0 });
    const deposits = await s.t.run((ctx) => ctx.db.query("deposits").collect());
    expect(deposits.map((d) => d.status)).toEqual(["HELD"]);
  });

  test("forfeiting it is refused the same way", async () => {
    const s = await seed("b4f", false);
    const { applicationId } = await readyDeal(s);
    expect((await refusalDataOf(finalize(s, applicationId, { treatment: "FORFEITED" })))?.code).toBe("FIRST_PAYMENT_UNFUNDED");
  });

  test("a deposit already refunded before finalize is refused too: H is zero but the first payment is still owed", async () => {
    const s = await seed("b4g", false);
    const { applicationId } = await readyDeal(s);
    await s.t.run(async (ctx) => {
      const deposit = (await ctx.db.query("deposits").collect())[0];
      await ctx.db.patch(deposit._id, { status: "REFUNDED", holdActive: false, refundedAmountMinor: H, releasedAmountMinor: H });
    });
    expect((await refusalDataOf(finalize(s, applicationId)))?.code).toBe("FIRST_PAYMENT_UNFUNDED");
    expect((await writes(s)).sales).toBe(0);
    // The deal screen is told the same thing before the operator reaches the close: a coded,
    // actionable status, not "not ready" (which the screen reads as no blocker at all).
    expect(await status(s, applicationId)).toEqual({
      state: "FIRST_PAYMENT_UNFUNDED", mayRecord: true, onBooksForwardId: null, blocksCancel: false, money: null,
    });
  });

  test("control: with no first payment agreed the held deposit leaves nothing unfunded", async () => {
    const s = await seed("b4h", false);
    const { applicationId } = await readyDeal(s);
    await s.t.run(async (ctx) => {
      const deposit = (await ctx.db.query("deposits").collect())[0];
      await ctx.db.patch(deposit._id, { status: "REFUNDED", holdActive: false, refundedAmountMinor: H, releasedAmountMinor: H });
      await ctx.db.patch(applicationId, { customerFirstPaymentMinor: 0 });
    });
    // D alone is now due; the refund is not the reason for any refusal - the unpaid forward is.
    const refusal = await refusalDataOf(finalize(s, applicationId));
    expect(refusal?.code).toBe("FORWARD_FINALIZE_UNPAID");
    expect((await status(s, applicationId))?.state).toBe("UNPAID");
  });
});

describe("cancellation sequencing on the direct route with a held deposit", () => {
  async function closedDirect(tag: string) {
    const s = await seed(tag, true);
    const { applicationId } = await readyDeal(s, { route: "DIRECT_TO_SUPPLIER", gapMinor: R });
    const forwardId = await payForward(s, applicationId);
    await finalizeAsOwner(s, applicationId);
    return { s, applicationId, forwardId };
  }

  test("forward on the books refuses the cancel; once the company returns it, the sale reverses and every plan account nets to nothing", async () => {
    const { s, applicationId, forwardId } = await closedDirect("c1");
    expect(await refusalMessageOf(cancel(s, applicationId))).toMatch(/already been paid to the finance company/i);

    await returnForward(s, applicationId, forwardId);
    expect(await refusalMessageOf(cancel(s, applicationId))).toBeNull();

    const app = (await s.t.run((ctx) => ctx.db.get(applicationId)))!;
    expect(app.status).toBe("CANCELLED");
    const all = await everyLineNet(s);
    for (const key of [
      "RECEIVABLE_FROM_SUPPLIERS", "ACCOUNTS_RECEIVABLE_CUSTOMERS", "CUSTOMER_DEPOSITS_LIABILITY", "SALES_CONSIDERATION_REDUCTIONS",
      "CONSIGNMENT_COMMISSION_REVENUE", "ACCOUNTS_PAYABLE_FINANCE_COMPANIES",
    ]) {
      expect(all[key] ?? 0, key).toBe(0);
    }
    expect(Object.values(all).reduce((sum, amount) => sum + amount, 0)).toBe(0);
    // The deposit is the customer's again: held, not consumed by a cancelled sale.
    const deposits = await s.t.run((ctx) => ctx.db.query("deposits").collect());
    expect(deposits.map((d) => d.status)).toEqual(["HELD"]);
  });

  test("the supplier already paid: the cancel stays refused even after the forward is returned", async () => {
    const { s, applicationId, forwardId } = await closedDirect("c2");
    await confirmSupplier(s, applicationId);
    await returnForward(s, applicationId, forwardId);
    expect(await refusalMessageOf(cancel(s, applicationId))).toMatch(/already paid the supplier/i);
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CLOSED");
  });
});
