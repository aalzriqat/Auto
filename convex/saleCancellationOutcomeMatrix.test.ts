/**
 * SCRUM-704 - the OUTCOME MATRIX of cancelling a completed sale, by entry point.
 *
 * Two public doors reverse a COMPLETED sale and both end in the same shared
 * teardown (`hookSaleCancelled` -> deposit-survival check ->
 * `cancelCompletedSaleOperationalRecords` + `reverseCommissionForSale`), but they
 * run those steps in a different ORDER and wrap them differently:
 *
 *   (a) `applications.cancelApplication` on a CLOSED financed deal
 *       (`cancelClosedApplicationTeardown`): CANCELLED patch -> sale reversal ->
 *       deposit gate -> commission reversal -> operational teardown, inside
 *       `runWithIdempotency` (keyed).
 *   (b) `sales.update({ status: "CANCELLED" })` on a CASH sale: sale reversal ->
 *       deposit gate -> operational teardown -> commission reversal -> CANCELLED
 *       patch last. No idempotency key; a repeat is a plain re-entry.
 *
 * The paid-deal unwind (`dealUnwind.finishDealUnwind`, SCRUM-693) reuses the
 * door-(a) teardown and has its own suite (`dealUnwind.test.ts`); it is NOT
 * repeated here.
 *
 * ⚠️ THIS IS A CHARACTERISATION. The order difference is not known to be wrong,
 * so every assertion below pins what the code DOES, compared as end STATE
 * (full row content, ordered by _id) and never as row counts. Where the two
 * doors disagree the disagreement is pinned in a test whose name starts with
 * "FINDING" and described in its comment; nothing is normalised away.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime (no OCC, no paginated-query limit) and not production data.
 */
import { finalizeAsOwner, readyDeal, refusalMessageOf, seedFinancedDealership } from "../test-utils/financedDealFixture";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { settleOutbox } from "../test-utils/outboxWork";
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

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
  "reopen:accounting_periods",
];

const COMMISSION = 250;
const PRICE = 12_500;
const DEPOSIT = 200;
const DEPOSIT_MINOR = DEPOSIT * 1_000;

type Dealership = Awaited<ReturnType<typeof seedFinancedDealership<never>>>;

// ── a deal, per entry point ─────────────────────────────────────────────────

interface Deal {
  s: Dealership;
  saleId: Id<"sales">;
  /** Cancels through this flow's own public door. `key` is only meaningful for door (a). */
  cancel: (key?: string) => Promise<unknown>;
}
interface Flow {
  /** Which door this is, for failure messages. */
  door: string;
  make: (tag: string, opts?: { deposit?: boolean }) => Promise<Deal>;
}

async function setManualCommissionMode(s: Dealership) {
  await s.t.run(async (ctx) => {
    const settings = await ctx.db.query("orgSettings").first();
    await ctx.db.patch(settings!._id, { commissionMode: "MANUAL" });
  });
}

/** Door (a): a finalized (CLOSED) financed deal, the FINANCED_SALE_CONSIDERATION deposit applied. */
async function financedDeal(tag: string, opts: { deposit?: boolean } = {}): Promise<Deal> {
  const withDeposit = opts.deposit ?? true;
  const s = await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: OWNER_PERMS, label: "S704", vinPrefix: "V704", actors: {},
  });
  const { applicationId } = await readyDeal(s);
  if (!withDeposit) {
    // The fixture's own deposit H, taken back out before finalization so the deal
    // is otherwise identical but has nothing applied to it.
    await s.t.run(async (ctx) => {
      for (const deposit of await ctx.db.query("deposits").collect()) await ctx.db.delete(deposit._id);
      await ctx.db.patch(applicationId, { customerFirstPaymentMinor: 0 });
    });
  }
  await setManualCommissionMode(s);
  await finalizeAsOwner(s, applicationId);
  const saleId = (await s.t.run((ctx) => ctx.db.get(applicationId)))!.finalizedSaleId!;
  await s.owner.as.mutation(api.sales.setCommissionAmount, { orgId: s.orgId, saleId, commissionAmount: COMMISSION });
  return {
    s,
    saleId,
    cancel: (key = "cancel-key-1") =>
      s.owner.as.mutation(api.applications.cancelApplication, {
        orgId: s.orgId, applicationId, reason: "Customer withdrew.", idempotencyKey: key,
      }),
  };
}

/** Door (b): a cash sale through the real doors, the deposit taken and applied by the sale. */
async function cashDeal(tag: string, opts: { deposit?: boolean } = {}): Promise<Deal> {
  const withDeposit = opts.deposit ?? true;
  const s = await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: OWNER_PERMS, label: "S704", vinPrefix: "V704", actors: {},
  });
  await setManualCommissionMode(s);
  const quoteId = await s.owner.as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId,
    mode: "CASH", vehiclePrice: PRICE, downPayment: 0, termMonths: 0,
  });
  if (withDeposit) {
    await s.owner.as.mutation(api.deposits.create, {
      orgId: s.orgId, quoteId, amount: DEPOSIT, method: "CASH", idempotencyKey: `dep-${tag}`,
    });
  }
  const saleId = (await s.owner.as.mutation(api.sales.create, {
    idempotencyKey: `sale-${tag}`, orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
    salespersonId: s.owner.userId, salePrice: PRICE, saleDate: Date.now(), status: "COMPLETED", quoteId,
  })) as Id<"sales">;
  await s.owner.as.mutation(api.sales.setCommissionAmount, { orgId: s.orgId, saleId, commissionAmount: COMMISSION });
  return {
    s,
    saleId,
    // Cancellation is a two-person control: the approver is not the salesperson.
    cancel: () => s.approver.as.mutation(api.sales.update, { orgId: s.orgId, saleId, status: "CANCELLED" }),
  };
}

const FLOWS: Flow[] = [
  { door: "(a) applications.cancelApplication on a CLOSED financed deal", make: financedDeal },
  { door: "(b) sales.update(CANCELLED) on a cash sale", make: cashDeal },
];

// ── observation ─────────────────────────────────────────────────────────────

/**
 * EVERY table in the schema, read whole. A hand-picked list silently omits the
 * table a cancellation happens to patch (`depositVehicleHolds` and
 * `accountBalanceSnapshots` were both missing), so a refusal that modified one
 * of them stayed green. One dealership per test, so no org filter is needed -
 * and none is wanted: a row written under another org would be exactly the kind
 * of leak a snapshot comparison should catch.
 */
const SNAPSHOT_TABLES = Object.keys(schema.tables);

type Snapshot = Awaited<ReturnType<typeof dbSnapshot>>;

/** Full row CONTENT of every table, ordered by _id. */
async function snapshot(s: Dealership): Promise<Snapshot> {
  return await dbSnapshot(s.t, SNAPSHOT_TABLES);
}

/** Tables whose content differs between two snapshots - empty means nothing moved. */
function changedTables(before: Snapshot, after: Snapshot): string[] {
  return SNAPSHOT_TABLES.filter((table) => JSON.stringify(before[table]) !== JSON.stringify(after[table]));
}

type SnapshotBalances = Record<string, { debit: number; credit: number }>;

/**
 * Running balance per `account|currency|period`, summed across the random shards
 * of `accountBalanceSnapshots` - the rows a closed period's trial balance reads.
 */
async function snapshotBalances(s: Dealership): Promise<SnapshotBalances> {
  return await s.t.run(async (ctx) => {
    const out: SnapshotBalances = {};
    for (const row of await ctx.db.query("accountBalanceSnapshots").collect()) {
      const account = await ctx.db.get(row.accountId);
      const key = `${account?.systemKey ?? account?.code ?? String(row.accountId)}|${row.currency}|${row.periodId}`;
      const cur = out[key] ?? { debit: 0, credit: 0 };
      cur.debit += row.runningDebitMinor;
      cur.credit += row.runningCreditMinor;
      out[key] = cur;
    }
    return out;
  });
}

/** Net (debit - credit) per `account|currency` across all periods; zero entries dropped. */
function netPerAccount(balances: SnapshotBalances): Record<string, number> {
  const net: Record<string, number> = {};
  for (const [key, b] of Object.entries(balances)) {
    const k = key.split("|").slice(0, 2).join("|");
    net[k] = (net[k] ?? 0) + b.debit - b.credit;
  }
  return Object.fromEntries(Object.entries(net).filter(([, v]) => v !== 0));
}

/**
 * The CONSUMER: the public trial balance as of the end of the last period, which
 * reads `accountBalanceSnapshots` for every period (`getCumulativeBalancesAsOf`)
 * rather than scanning journal lines. Rows keyed by account code (ids differ per org).
 */
async function trialBalanceRows(s: Dealership) {
  const periods = await s.owner.as.query(api.accountingPeriods.list, { orgId: s.orgId });
  const toDate = Math.max(...periods.map((p) => p.endDate));
  const tb = await s.owner.as.query(api.accountingReports.trialBalance, { orgId: s.orgId, toDate });
  return {
    isBalanced: tb.isBalanced,
    rows: tb.rows.map((r) => ({ code: r.code, currency: r.currency, debit: r.debitMinor, credit: r.creditMinor })),
  };
}

/** Net debit-minus-credit per system account over every journal line; zero entries dropped. */
async function netByAccount(s: Dealership): Promise<Record<string, number>> {
  return await s.t.run(async (ctx) => {
    const net: Record<string, number> = {};
    for (const line of await ctx.db.query("journalLines").collect()) {
      const account = await ctx.db.get(line.accountId);
      const key = account?.systemKey ?? String(line.accountId);
      net[key] = (net[key] ?? 0) + line.debitMinor - line.creditMinor;
    }
    return Object.fromEntries(Object.entries(net).filter(([, value]) => value !== 0));
  });
}

/** The accounts that carry the DEPOSIT's own money rather than the sale's. */
const DEPOSIT_ACCOUNTS = ["CASH_ON_HAND", "CUSTOMER_DEPOSITS_LIABILITY"];
const withoutDepositAccounts = (net: Record<string, number>) =>
  Object.fromEntries(Object.entries(net).filter(([key]) => !DEPOSIT_ACCOUNTS.includes(key)));

/** Everything a cancellation is supposed to settle, as plain comparable state. */
async function outcome(d: Deal) {
  return await d.s.t.run(async (ctx) => {
    const sale = (await ctx.db.get(d.saleId))!;
    const vehicle = (await ctx.db.get(sale.vehicleId))!;
    const events = await ctx.db.query("accountingEvents").collect();
    const statusOf = (eventType: string) => events.filter((e) => e.eventType === eventType).map((e) => e.status).sort();
    const entries = await ctx.db.query("journalLines").collect();
    return {
      sale: { status: sale.status, commissionAmount: sale.commissionAmount, commissionPaidAt: sale.commissionPaidAt },
      vehicle: { status: vehicle.status, soldBySaleId: vehicle.soldBySaleId, preHoldStatus: vehicle.preHoldStatus },
      deposits: (await ctx.db.query("deposits").collect()).map((dep) => ({
        status: dep.status, holdActive: dep.holdActive, amountMinor: dep.amountMinor, resolutionSaleId: dep.resolutionSaleId,
      })),
      depositApplications: (await ctx.db.query("depositApplications").collect()).map((a) => a.status).sort(),
      saleEvents: statusOf("SALE_COMPLETED"),
      commissionEvents: statusOf("COMMISSION_ACCRUED"),
      pending: (await ctx.db.query("pendingAccountingEvents").collect()).map((p) => `${p.kind}:${p.status}`).sort(),
      liveAllocations: (await ctx.db.query("paymentAllocations").collect()).filter((a) => a.status === "ACTIVE").length,
      openReceivables: (await ctx.db.query("receivableDocuments").collect()).filter((r) => r.status !== "CANCELLED").length,
      liveCashflowRows: (await ctx.db.query("transactions").collect()).filter(
        (row) => row.saleId === d.saleId && row.isDeleted !== true
      ).length,
      ledgerBalanced: entries.reduce((sum, l) => sum + l.debitMinor - l.creditMinor, 0) === 0,
    };
  });
}

async function closeTheYear(s: Dealership) {
  const period = (await s.owner.as.query(api.accountingPeriods.list, { orgId: s.orgId }))[0];
  const checklist = await s.owner.as.query(api.accountingPeriods.closeChecklist, { orgId: s.orgId, periodId: period._id });
  await s.owner.as.mutation(api.accountingPeriods.close, {
    orgId: s.orgId, periodId: period._id, acknowledgedWarnings: checklist.warnings,
    overrideReason: checklist.canClose ? undefined : "SCRUM-704 fixture: month-end before the cancellation",
  });
  return period._id;
}

const payCommission = (d: Deal) =>
  d.s.owner.as.mutation(api.sales.markCommissionPaid, {
    idempotencyKey: crypto.randomUUID(), orgId: d.s.orgId, saleId: d.saleId, paymentMethod: "CASH",
  });

// ═════════════════════════════════════════════════════════════════════════════

describe.each(FLOWS)("SCRUM-704 outcome matrix - $door", ({ make }) => {
  test("(1) a completed sale with a posted journal, an accrued commission, an applied deposit and a SOLD car starts in the state the matrix assumes", async () => {
    const d = await make("pre");
    const before = await outcome(d);
    expect(before.sale).toEqual({ status: "COMPLETED", commissionAmount: COMMISSION, commissionPaidAt: undefined });
    expect(before.vehicle).toMatchObject({ status: "SOLD", soldBySaleId: d.saleId });
    expect(before.saleEvents).toEqual(["POSTED"]);
    expect(before.commissionEvents).toEqual(["POSTED"]);
    expect(before.depositApplications).toEqual(["APPLIED"]);
    expect(before.deposits).toEqual([expect.objectContaining({ status: "APPLIED", amountMinor: DEPOSIT_MINOR })]);
    const net = await netByAccount(d.s);
    expect(net.SALES_REVENUE).toBeLessThan(0);
    expect(net.COMMISSION_PAYABLE).toBe(-COMMISSION * 1_000);
  });

  test("(2) cancel: sale CANCELLED, every journal reversed to zero, commission backed out, deposit back on hold, car restored and disowned, nothing stranded", async () => {
    const d = await make("end");
    await d.cancel();
    const after = await outcome(d);

    // The sale and its commission AS HISTORY: the amount is kept, only the money is backed out.
    expect(after.sale).toEqual({ status: "CANCELLED", commissionAmount: COMMISSION, commissionPaidAt: undefined });
    expect(after.saleEvents).toEqual(["REVERSED"]);
    expect(after.commissionEvents).toEqual(["REVERSED"]);
    expect(after.pending).toEqual([]);

    // Sale journal reversed, commission reversed: every sale-side account nets to zero.
    expect(withoutDepositAccounts(await netByAccount(d.s))).toEqual({});
    expect(after.ledgerBalanced).toBe(true);

    // The deposit is the customer's money; cancelling the sale gives it back as an active hold.
    expect(after.depositApplications).toEqual(["REVERSED"]);
    expect(after.deposits).toEqual([
      { status: "HELD", holdActive: true, amountMinor: DEPOSIT_MINOR, resolutionSaleId: undefined },
    ]);

    // Ownership cleared; the held deposit keeps the car RESERVED rather than putting it back on sale.
    expect(after.vehicle).toEqual({ status: "RESERVED", soldBySaleId: undefined, preHoldStatus: "AVAILABLE" });

    // Nothing stranded: no live allocation, no open receivable, no live cashflow row.
    expect(after.liveAllocations).toBe(0);
    expect(after.openReceivables).toBe(0);
    expect(after.liveCashflowRows).toBe(0);
  });

  test("(v) the held deposit survives the cancellation: same money, same quote, never refunded or forfeited", async () => {
    const d = await make("surv");
    const before = await d.s.t.run((ctx) => ctx.db.query("deposits").collect());
    await d.cancel();
    const after = await d.s.t.run((ctx) => ctx.db.query("deposits").collect());
    expect(after.map((dep) => dep._id)).toEqual(before.map((dep) => dep._id));
    expect(after[0]).toMatchObject({ amountMinor: DEPOSIT_MINOR, quoteId: before[0].quoteId, status: "HELD", holdActive: true });
    // No refund / forfeit event was posted on the way past.
    const types = await d.s.t.run(async (ctx) => (await ctx.db.query("accountingEvents").collect()).map((e) => e.eventType));
    expect(types.filter((type) => /REFUND|FORFEIT/.test(type))).toEqual([]);
  });

  test("(ii) a PAID commission refuses the cancellation and leaves every row exactly as it was", async () => {
    const d = await make("paid");
    await payCommission(d);
    const before = await snapshot(d.s);
    expect(await refusalMessageOf(d.cancel())).toMatch(/after commission has been paid/);
    expect(changedTables(before, await snapshot(d.s))).toEqual([]);
    expect(await snapshot(d.s)).toEqual(before);
  });

  test("(ii-b) the snapshot reads every schema table and sees an in-place patch to a snapshot row", async () => {
    const d = await make("snapsee");
    expect(SNAPSHOT_TABLES).toEqual(expect.arrayContaining(["accountBalanceSnapshots", "depositVehicleHolds"]));
    const before = await snapshot(d.s);
    await d.s.t.run(async (ctx) => {
      const row = (await ctx.db.query("accountBalanceSnapshots").first())!;
      await ctx.db.patch(row._id, { runningDebitMinor: row.runningDebitMinor + 1 });
    });
    expect(changedTables(before, await snapshot(d.s))).toEqual(["accountBalanceSnapshots"]);
  });

  test("(iv) re-entry on an already CANCELLED sale: the SALE-side books do not move", async () => {
    const d = await make("reenter");
    await d.cancel("first");
    const before = await snapshot(d.s);
    const net = await netByAccount(d.s);
    // The same call again (door (a): same key; door (b): same arguments).
    await d.cancel("first");
    const after = await snapshot(d.s);
    expect(changedTables(before, after)).toEqual([]);
    expect(await netByAccount(d.s)).toEqual(net);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (iii) the period is closed and the reversal cannot post
// ═════════════════════════════════════════════════════════════════════════════

describe("SCRUM-704 (iii) a closed period: the reversal cannot post today", () => {
  test("door (a) with a FINANCED_SALE_CONSIDERATION deposit: REFUSED, every row untouched", async () => {
    const d = await financedDeal("a_closed");
    await closeTheYear(d.s);
    const before = await snapshot(d.s);
    expect(await refusalMessageOf(d.cancel())).toMatch(/period is closed.*Open an accounting period/s);
    expect(await snapshot(d.s)).toEqual(before);
  });

  test("FINDING: door (b) on a deal with an ordinary deposit is NOT refused - it DEFERS the three reversals and frees the car now (the two doors differ by deposit treatment, not by design of the door)", async () => {
    const d = await cashDeal("b_closed");
    await closeTheYear(d.s);
    await d.cancel();
    const after = await outcome(d);

    // CANCELLED immediately, the commission amount kept... and (SCRUM-712) the car
    // stays locked RESERVED, because the customer's deposit share is PENDING a
    // refund-or-forfeit decision, not free to be sold on.
    expect(after.sale.status).toBe("CANCELLED");
    expect(after.vehicle).toEqual({ status: "RESERVED", soldBySaleId: undefined, preHoldStatus: "AVAILABLE" });
    // ...but the books still carry the sale, the commission AND the deposit application: three queued reversals.
    expect(after.saleEvents).toEqual(["POSTED"]);
    expect(after.commissionEvents).toEqual(["POSTED"]);
    expect(after.pending).toEqual(["REVERSE:PENDING", "REVERSE:PENDING", "REVERSE:PENDING"]);
    expect((await netByAccount(d.s)).SALES_REVENUE).toBeLessThan(0);
    // The deposit is HELD again but its hold stays OFF and its application REVERSING until the journal posts.
    expect(after.depositApplications).toEqual(["REVERSING"]);
    expect(after.deposits).toEqual([
      { status: "HELD", holdActive: false, amountMinor: DEPOSIT_MINOR, resolutionSaleId: undefined },
    ]);
  });

  test("door (b) with no deposit defers the same two reversals and frees the car; nothing refuses", async () => {
    const d = await cashDeal("b_closed_nodep", { deposit: false });
    await closeTheYear(d.s);
    await d.cancel();
    const after = await outcome(d);
    expect(after.sale.status).toBe("CANCELLED");
    expect(after.vehicle.status).toBe("AVAILABLE");
    expect(after.pending).toEqual(["REVERSE:PENDING", "REVERSE:PENDING"]);
    expect(after.saleEvents).toEqual(["POSTED"]);
  });

  test("door (a) with no deposit defers exactly like door (b): same pending reversals, same car, same sale", async () => {
    const a = await financedDeal("a_closed_nodep", { deposit: false });
    const b = await cashDeal("b_closed_nodep2", { deposit: false });
    await closeTheYear(a.s);
    await closeTheYear(b.s);
    await a.cancel();
    await b.cancel();
    const [outA, outB] = [await outcome(a), await outcome(b)];
    expect(outA.sale).toEqual(outB.sale);
    expect(outA.vehicle).toEqual(outB.vehicle);
    expect(outA.saleEvents).toEqual(outB.saleEvents);
    expect(outA.commissionEvents).toEqual(outB.commissionEvents);
    // Door (a) also owns the finance-company disbursement reversal, so its pending set is a superset.
    expect(outA.pending.filter((p) => p === "REVERSE:PENDING").length).toBeGreaterThanOrEqual(outB.pending.length);
  });

  test("a deferred cancellation converges: reopening the period and draining the outbox books match the immediate cancel; operational hold state does not (FINDING F3)", async () => {
    // Immediate reference, open period.
    const immediate = await cashDeal("conv_ref");
    await immediate.cancel();
    const reference = await outcome(immediate);
    const referenceNet = await netByAccount(immediate.s);

    // Deferred: close, cancel, reopen, drain.
    const deferred = await cashDeal("conv_def");
    const periodId = await closeTheYear(deferred.s);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      await deferred.cancel();
      await deferred.s.owner.as.mutation(api.accountingPeriods.reopen, {
        orgId: deferred.s.orgId, periodId, reason: "SCRUM-704: let the cancellation reversal post",
      });
      await deferred.s.t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    await settleOutbox(deferred.s.t, deferred.s.orgId);

    const drained = await outcome(deferred);
    // The BOOKS converge: sale, commission and deposit application reverse to the same state.
    expect(drained.sale).toEqual(reference.sale);
    expect(drained.saleEvents).toEqual(reference.saleEvents);
    expect(drained.commissionEvents).toEqual(reference.commissionEvents);
    expect(drained.depositApplications).toEqual(reference.depositApplications);
    expect(drained.ledgerBalanced).toBe(true);
    expect(drained.pending).toEqual(["REVERSE:POSTED", "REVERSE:POSTED", "REVERSE:POSTED"]);
    expect(await netByAccount(deferred.s)).toEqual(referenceNet);

    // The CONSUMER agrees too. A closed period's trial balance reads the running
    // snapshots, not the journal lines, so a reversal that inserted its lines but
    // missed the snapshot update would pass every journal-line assertion above.
    const refTb = await trialBalanceRows(immediate.s);
    const defTb = await trialBalanceRows(deferred.s);
    expect(refTb.rows.length).toBeGreaterThan(0);
    expect(defTb).toEqual(refTb);
    expect(defTb.isBalanced).toBe(true);
    // And the snapshot rows themselves, per account/currency (summed over shards and periods),
    // equal the reference's and the journal-line net.
    const defNet = netPerAccount(await snapshotBalances(deferred.s));
    expect(defNet).toEqual(netPerAccount(await snapshotBalances(immediate.s)));
    const lineNet: Record<string, number> = {};
    for (const [key, value] of Object.entries(defNet)) {
      const account = key.split("|")[0];
      lineNet[account] = (lineNet[account] ?? 0) + value;
    }
    expect(lineNet).toEqual(referenceNet);

    // FINDING (SCRUM-704 F3): the OPERATIONAL state does NOT converge. The immediate cancel leaves the
    // deposit's hold ACTIVE and the car RESERVED for that customer; the deferred cancel, even after the
    // drain has posted every reversal, leaves the deposit HELD with holdActive=false and the car
    // AVAILABLE - i.e. the customer's held deposit no longer protects the car and nothing re-syncs it.
    expect(reference.deposits).toEqual([expect.objectContaining({ status: "HELD", holdActive: true })]);
    expect(reference.vehicle).toMatchObject({ status: "RESERVED", preHoldStatus: "AVAILABLE" });
    expect(drained.deposits).toEqual([expect.objectContaining({ status: "HELD", holdActive: false })]);
    // SCRUM-712 closes the car-protection half of F3: the deposit hold is still
    // off, but the PENDING share written by the cancellation keeps the car locked
    // on both paths until it is decided.
    expect(drained.vehicle.status).toBe("RESERVED");
    expect(drained.vehicle.soldBySaleId).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (i) replay with a NEW idempotency key
// ═════════════════════════════════════════════════════════════════════════════

describe("SCRUM-704 (i) replaying a cancellation after it succeeded", () => {
  test("door (a), SAME key: a verbatim replay changes nothing at all", async () => {
    const d = await financedDeal("a_same");
    await d.cancel("k");
    const before = await snapshot(d.s);
    await d.cancel("k");
    expect(await snapshot(d.s)).toEqual(before);
  });

  test("door (b): a second cancel of the same sale changes nothing at all", async () => {
    const d = await cashDeal("b_twice");
    await d.cancel();
    const before = await snapshot(d.s);
    await d.cancel();
    expect(await snapshot(d.s)).toEqual(before);
  });

  test("FINDING: door (a), a DIFFERENT key on the already-CANCELLED deal is not a no-op - it releases the customer's deposit hold and frees the car; door (b) never does", async () => {
    // First cancel of a CLOSED deal leaves the reinstated deposit holding the car
    // (RESERVED, hold active). `cancelApplication`'s already-CANCELLED branch then
    // runs `releaseHoldForApplicationQuote`, so the number of cancel CALLS - not
    // the deal - decides whether the car is on sale. A cash sale cancelled twice
    // never leaves that state (see the previous test and the cross-check below).
    const a = await financedDeal("a_newkey");
    await a.cancel("first");
    const afterFirst = await outcome(a);
    expect(afterFirst.vehicle.status).toBe("RESERVED");
    expect(afterFirst.deposits).toEqual([expect.objectContaining({ status: "HELD", holdActive: true })]);

    const books = await netByAccount(a.s);
    const before = await snapshot(a.s);
    await a.cancel("second");
    const after = await snapshot(a.s);

    // SCRUM-712: the second call still drops the deposit hold, but the PENDING
    // share keeps the car locked, so the vehicle row no longer changes.
    expect(changedTables(before, after).sort()).toEqual(["commandIdempotency", "deposits"]);
    const afterSecond = await outcome(a);
    expect(afterSecond.vehicle.status).toBe("RESERVED");
    expect(afterSecond.deposits).toEqual([expect.objectContaining({ status: "HELD", holdActive: false })]);
    // The books and the sale did not move; only the hold did.
    expect(await netByAccount(a.s)).toEqual(books);
    expect(afterSecond.sale).toEqual(afterFirst.sale);

    // Door (b) has no such second state: the same second call leaves the hold in place.
    const b = await cashDeal("b_newkey");
    await b.cancel();
    await b.cancel();
    expect((await outcome(b)).vehicle.status).toBe("RESERVED");
  });

  test("a replay does not reach a LATER sale of the same car (door (a), new key, after the car was resold)", async () => {
    const a = await financedDeal("a_resold", { deposit: false });
    await a.cancel("first");
    expect((await outcome(a)).vehicle.status).toBe("AVAILABLE");
    const second = await a.s.t.run((ctx) =>
      ctx.db.insert("customers", { orgId: a.s.orgId, firstName: "Second", lastName: "Buyer" })
    );
    const laterSale = (await a.s.owner.as.mutation(api.sales.create, {
      idempotencyKey: "later-sale", orgId: a.s.orgId, vehicleId: a.s.vehicleId, customerId: second,
      salespersonId: a.s.owner.userId, salePrice: PRICE, saleDate: Date.now(), status: "COMPLETED",
    })) as Id<"sales">;
    const before = await snapshot(a.s);
    await a.cancel("second");
    expect(changedTables(before, await snapshot(a.s)).filter((t) => t !== "commandIdempotency")).toEqual([]);
    const vehicle = await a.s.t.run((ctx) => ctx.db.get(a.s.vehicleId));
    expect(vehicle).toMatchObject({ status: "SOLD", soldBySaleId: laterSale });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// (a) vs (b): equivalent deals must end in the same economic state
// ═════════════════════════════════════════════════════════════════════════════

describe("SCRUM-704 cross-comparison of the two doors", () => {
  test.each([
    { label: "with an applied deposit", deposit: true },
    { label: "with no deposit", deposit: false },
  ])("equivalent deals $label end in the same sale, commission, vehicle, deposit and sale-side GL state", async ({ deposit }) => {
    const a = await financedDeal(`x_a_${deposit}`, { deposit });
    const b = await cashDeal(`x_b_${deposit}`, { deposit });
    await a.cancel();
    await b.cancel();
    const [outA, outB] = [await outcome(a), await outcome(b)];

    expect(outA.sale).toEqual(outB.sale);
    expect(outA.vehicle).toEqual(outB.vehicle);
    expect(outA.deposits).toEqual(outB.deposits);
    expect(outA.depositApplications).toEqual(outB.depositApplications);
    expect(outA.saleEvents).toEqual(outB.saleEvents);
    expect(outA.commissionEvents).toEqual(outB.commissionEvents);
    expect(outA.pending).toEqual(outB.pending);
    expect(outA.liveAllocations).toBe(outB.liveAllocations);
    expect(outA.openReceivables).toBe(outB.openReceivables);
    expect(outA.liveCashflowRows).toBe(outB.liveCashflowRows);
    expect(outA.ledgerBalanced).toBe(true);
    expect(outB.ledgerBalanced).toBe(true);
    // Every account the sale or its commission touched is back to zero in BOTH.
    expect(withoutDepositAccounts(await netByAccount(a.s))).toEqual({});
    expect(withoutDepositAccounts(await netByAccount(b.s))).toEqual({});
  });

  test("the two doors account for the deposit's own money consistently: it stays on the books exactly when a receipt was posted", async () => {
    const a = await financedDeal("dep_a");
    const b = await cashDeal("dep_b");
    await a.cancel();
    await b.cancel();
    // Door (b)'s deposit came in through `deposits.create`, so it has a posted receipt and its
    // liability stays standing for the held deposit. Door (a)'s fixture deposit is inserted
    // directly (no receipt event), so it contributes nothing to either account and nets to zero.
    expect(await netByAccount(b.s)).toEqual({ CASH_ON_HAND: DEPOSIT_MINOR, CUSTOMER_DEPOSITS_LIABILITY: -DEPOSIT_MINOR });
    expect(await netByAccount(a.s)).toEqual({});
  });
});
