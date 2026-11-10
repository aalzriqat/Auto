import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { supportedCurrencyScale, toMinorUnits } from "./money";
import { settlementView } from "./supplierSettlement";
import { OPEN_RECOVERY_STATUSES } from "./costBearer";
import { SYSTEM_KEYS } from "./defaultChart";
import { inTurn, readBoundedStream, type HeadroomCtx } from "./transactionReadHeadroom";
import { settledPayableRows, settledRecoveryRows, settledClaimRow, type DatedSettledRow, type SupplierObligation, type WithSupplierDocument } from "./supplierSettledRows";
import { createSupplierReadCache, readCached, SupplierReadBudgetExhausted, type SupplierReadCache } from "./supplierReadCache";
import {
  agingFor,
  ammanDateString,
  deriveDueDate,
  type AgingBucket,
  type DueFacts,
  type DueRuleCode,
  type DueTriggerKey,
} from "./supplierDueDates";

/**
 * SCRUM-869 S3a - one bounded page of a supplier obligation family with the server-derived due
 * date, its explanation and its Amman aging (owner ruling SCRUM-869#c23883, OQ-1).
 *
 * Reads only. Every recorded fact is read tenant-scoped: a sale or application that belongs to
 * another organisation is treated as a MISSING fact, never as evidence, so a cross-tenant pointer
 * can neither create a due date nor leak one.
 *
 * Money: payables and receivables hold major-unit floats, cost recoveries hold integer minor
 * units. Everything leaves this module as integer minor units of the row's own currency; rows of
 * different currencies are never added together.
 */

export type ObligationKind = "PAYABLE" | "RECEIVABLE" | "RECOVERY";

export const OBLIGATION_PAGE_DEFAULT = 50;
export const OBLIGATION_PAGE_MAX = 100;

export interface ObligationRow {
  kind: ObligationKind;
  id: string;
  currency: string;
  /** Gross outstanding, disputed amounts included. */
  outstandingMinor: number;
  /** The part of the gross that is under dispute. Never subtracted from the gross. */
  disputedMinor: number;
  dueAt: number | null;
  /** The Amman calendar date of `dueAt`, `YYYY-MM-DD`, or null. */
  dueDate: string | null;
  rule: DueRuleCode;
  explanation: string;
  daysOverdue: number | null;
  bucket: AgingBucket;
}

export interface ObligationTotal {
  currency: string;
  bucket: AgingBucket;
  grossMinor: number;
  disputedMinor: number;
}

export interface ObligationPage {
  rows: ObligationRow[];
  totals: ObligationTotal[];
  /** True only when this page is the last one: the caller has then seen every row. */
  complete: boolean;
  continueCursor: string;
}

interface Outstanding {
  outstandingMinor: number;
  disputed: boolean;
  agreedDueAt: number | undefined;
  model: DueTriggerKey;
  deliveredAt?: number;
  financierFunding?: DueFacts["financierFunding"];
}

type Reader = Pick<QueryCtx, "db">;

/** The largest instant a JavaScript Date can hold, in ms (ECMAScript TimeClip: https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-timeclip). */
const MAX_DATE_MS = 8.64e15;

/**
 * A stored date the row's due date will be formatted from. Past the Date range `new Date(x)` is an
 * Invalid Date and `Intl.DateTimeFormat` throws `RangeError: Invalid time value` from inside the
 * formatter, which is neither a `ConvexError` nor something a reader can tell from an infrastructure
 * fault. So every stored date is checked here, before it is used, and a bad one is a named data fault
 * (an unreadable row). Not-a-number, an infinity and a magnitude past the range are all refused; an
 * absent date is simply absent, and a small zero or negative is still a missing fact, as before.
 */
function renderableDate(field: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_DATE_MS) {
    throw new ConvexError(`Stored date "${field}" is not a renderable instant.`);
  }
  return value;
}

async function ownedSale(ctx: Reader & HeadroomCtx, orgId: Id<"organizations">, saleId: Id<"sales"> | undefined, cache?: SupplierReadCache) {
  if (!saleId) return null;
  const sale = cache ? await readCached(ctx, cache.sales, saleId) : await ctx.db.get(saleId);
  return sale && sale.orgId === orgId ? sale : null;
}

/** The deal's finance application, only when it is this organisation's: a foreign or missing one is a missing fact. */
async function ownedApplication(
  ctx: Reader,
  orgId: Id<"organizations">,
  sale: Doc<"sales"> | null,
  cache?: SupplierReadCache,
): Promise<Doc<"financeApplications"> | null> {
  if (!sale?.applicationId) return null;
  const application = cache ? await readCached(ctx, cache.applications, sale.applicationId) : await ctx.db.get(sale.applicationId);
  return application && application.orgId === orgId ? application : null;
}

/**
 * The recorded vehicle handover to the customer (owner ruling SCRUM-869#c23906): `handoverStatus ===
 * HANDED_OVER` with its `vehicleHandoverAt` timestamp. `applications.registerVehicleHandover` writes
 * both, and `finalizeDeal` refuses to run without it, for a CASH deal exactly as for a financed one;
 * a sale recorded without a deal application has no handover record at all. A completed sale is
 * not delivery, so the sale's own status and date are never read.
 */
function recordedDeliveryAt(application: Doc<"financeApplications"> | null): number | undefined {
  if (application?.handoverStatus !== "HANDED_OVER") return undefined;
  return renderableDate("vehicleHandoverAt", application.vehicleHandoverAt);
}

/**
 * The financier's funding of this deal (owner ruling SCRUM-869#c23906: "cleared proceeds" is the
 * receipt of the financing from the financier).
 *
 * Undefined for a CASH deal, which no financier funds: the ruling does not reach it. Otherwise the
 * fact is present, and `fundedAt` is the application's `disbursedAt` ONLY while the matching
 * `disbursedAmountMinor` is a positive amount. `applications.confirmDisbursement` writes both when
 * the money is received; `applications.returnFinanceDisbursementCheque` clears both when a cleared
 * cheque comes back, and a requested or pending funding has neither. The supplier-direct
 * disbursement fields are a different payment and are never read.
 */
function financierFundingFact(
  sale: Doc<"sales"> | null,
  application: Doc<"financeApplications"> | null
): DueFacts["financierFunding"] {
  if (!sale) return undefined;
  if (sale.financingType === "CASH" || application?.quoteModeAtSubmission === "CASH") return undefined;
  if (sale.financingType === undefined && application === null) return undefined;
  const amount = application?.disbursedAmountMinor;
  const received = typeof amount === "number" && Number.isFinite(amount) && amount > 0;
  return { fundedAt: received ? renderableDate("disbursedAt", application?.disbursedAt) : undefined };
}

export async function payableFacts(ctx: Reader, orgId: Id<"organizations">, row: Doc<"vehicleSupplierPayables">, cache?: SupplierReadCache): Promise<Outstanding | null> {
  const view = settlementView(row);
  // Settled rows drop out through a zero remainder, not through the stored status: a status that
  // disagrees with the amounts must not hide open money.
  if (view.status === "CANCELLED") return null;
  const outstandingMinor = toMinorUnits(view.remainingAmount, row.currency);
  if (outstandingMinor <= 0) return null;
  const sale = await ownedSale(ctx, orgId, "saleId" in row ? row.saleId : undefined, cache);
  const throughDealership = sale?.supplierSettlementRoute === "THROUGH_DEALERSHIP";
  return {
    outstandingMinor,
    disputed: view.status === "DISPUTED",
    agreedDueAt: renderableDate("paymentDueDate", row.paymentDueDate),
    model: throughDealership ? "SOURCED_THROUGH_DEALERSHIP_PAYABLE" : "OWNED_ON_ACCOUNT_PAYABLE",
    // Read only for the model that uses it: one extra bounded `get` per through-dealership row.
    ...(throughDealership ? { financierFunding: financierFundingFact(sale, await ownedApplication(ctx, orgId, sale, cache)) } : {}),
  };
}

export async function receivableFacts(ctx: Reader, orgId: Id<"organizations">, row: Doc<"vehicleSupplierReceivables">, cache?: SupplierReadCache): Promise<Outstanding | null> {
  if (row.status === "CANCELLED") return null;
  const outstandingMinor = Math.max(
    0,
    toMinorUnits(row.amountDue, row.currency) - toMinorUnits(row.amountReceived ?? 0, row.currency)
  );
  if (outstandingMinor <= 0) return null;
  const sale = await ownedSale(ctx, orgId, row.saleId, cache);
  return {
    outstandingMinor,
    disputed: row.status === "DISPUTED",
    agreedDueAt: renderableDate("agreedDueDate", row.agreedDueDate),
    model: "SOURCED_DIRECT_RECEIVABLE",
    deliveredAt: recordedDeliveryAt(await ownedApplication(ctx, orgId, sale, cache)),
  };
}

export function recoveryFacts(row: Doc<"supplierCostRecoveries">): Outstanding | null {
  if (row.status === "REVERSED") return null;
  const outstandingMinor = Math.max(0, row.amountDueMinor - row.amountRecoveredMinor);
  if (outstandingMinor <= 0) return null;
  return { outstandingMinor, disputed: false, agreedDueAt: renderableDate("agreedDueDate", row.agreedDueDate), model: "COST_RECOVERY" };
}

function toRow(
  kind: ObligationKind,
  id: string,
  currency: string,
  facts: Outstanding,
  nowMs: number
): ObligationRow {
  const derived = deriveDueDate(facts.model, {
    agreedDueAt: facts.agreedDueAt,
    deliveredAt: facts.deliveredAt,
    financierFunding: facts.financierFunding,
  });
  const aging = agingFor(derived.dueAt, nowMs);
  return {
    kind,
    id,
    currency,
    outstandingMinor: facts.outstandingMinor,
    disputedMinor: facts.disputed ? facts.outstandingMinor : 0,
    dueAt: derived.dueAt,
    dueDate: derived.dueAt === null ? null : ammanDateString(derived.dueAt),
    rule: derived.rule,
    explanation: derived.explanation,
    daysOverdue: aging.daysOverdue,
    bucket: aging.bucket,
  };
}

export function totalsOf(rows: ObligationRow[]): ObligationTotal[] {
  const byKey = new Map<string, ObligationTotal>();
  for (const row of rows) {
    const key = `${row.currency}|${row.bucket}`;
    const total = byKey.get(key) ?? { currency: row.currency, bucket: row.bucket, grossMinor: 0, disputedMinor: 0 };
    total.grossMinor += row.outstandingMinor;
    total.disputedMinor += row.disputedMinor;
    byKey.set(key, total);
  }
  return [...byKey.values()];
}

/** A row this module could not read: the data itself is unusable, not the infrastructure. */
export interface UnreadableRow {
  kind: ObligationKind;
  id: string;
  reason: string;
}

/**
 * One row, or null when it is not outstanding. A row whose currency AutoFlow cannot vouch for, or
 * whose amounts cannot be converted, is a deterministic data fault: with `onUnreadableRow` it is
 * reported and left out, without it the fault throws as before (the aging screen must fail loudly
 * rather than show a page that silently omits money). Only `ConvexError` data faults are caught; an
 * infrastructure error always propagates.
 */
export async function readRow(
  kind: ObligationKind,
  id: string,
  currency: string,
  nowMs: number,
  facts: () => Promise<Outstanding | null> | Outstanding | null,
  onUnreadableRow: ((row: UnreadableRow) => void) | undefined
): Promise<ObligationRow | null> {
  try {
    if (onUnreadableRow && supportedCurrencyScale(currency) === null) {
      throw new ConvexError(`Unsupported or unrecognised currency code "${currency}".`);
    }
    const resolved = await facts();
    return resolved ? toRow(kind, id, currency, resolved, nowMs) : null;
  } catch (error) {
    if (!onUnreadableRow || !(error instanceof ConvexError)) throw error;
    onUnreadableRow({ kind, id, reason: typeof error.data === "string" ? error.data : "unreadable" });
    return null;
  }
}

export { readObligationPage } from "./supplierObligationPage";

/** Rows read per family for one supplier's statement; one more is fetched to prove the family is not complete. */
export const STATEMENT_FAMILY_LIMIT = 100;

export interface StatementTotal {
  currency: string;
  grossMinor: number;
  disputedMinor: number;
  /** The part of the gross whose due date has passed. Never subtracted from the gross. */
  overdueMinor: number;
}

export interface StatementSection {
  rows: WithSupplierDocument<ObligationRow>[];
  /** One total per currency; currencies are never added together. */
  totals: StatementTotal[];
  /** False when the family held more rows than the read bound or the transaction ran out of read budget: rows and totals are then partial. */
  complete: boolean;
  /** Why the section is incomplete; absent when it is complete. A screen must not call an unread section empty. */
  incompleteReason?: IncompleteReason;
}

/** ROW_LIMIT: more rows than the per-family cap. READ_BUDGET: the transaction had no room left to read them (bytes, not rows). */
export type IncompleteReason = "ROW_LIMIT" | "READ_BUDGET";

function statementSection(rows: WithSupplierDocument<ObligationRow>[], complete: boolean, reason: IncompleteReason = "ROW_LIMIT"): StatementSection {
  const byCurrency = new Map<string, StatementTotal>();
  for (const row of rows) {
    const total = byCurrency.get(row.currency) ?? { currency: row.currency, grossMinor: 0, disputedMinor: 0, overdueMinor: 0 };
    total.grossMinor += row.outstandingMinor;
    total.disputedMinor += row.disputedMinor;
    if (row.daysOverdue !== null && row.daysOverdue > 0) total.overdueMinor += row.outstandingMinor;
    byCurrency.set(row.currency, total);
  }
  // W14: a partial list never presents a partial sum as a total (the settled section does the same).
  return complete ? { rows, totals: [...byCurrency.values()], complete } : { rows, totals: [], complete, incompleteReason: reason };
}

/** Rows read one at a time; stops at the first row the budget cannot cover and reports the cut. */
async function readRowsWithinBudget(
  docs: readonly unknown[],
  read: (index: number) => Promise<WithSupplierDocument<ObligationRow> | null>,
): Promise<{ rows: WithSupplierDocument<ObligationRow>[]; cut: boolean }> {
  const rows: WithSupplierDocument<ObligationRow>[] = [];
  for (let i = 0; i < docs.length; i += 1) {
    try {
      const row = await read(i);
      if (row) rows.push(row);
    } catch (error) {
      if (error instanceof SupplierReadBudgetExhausted) return { rows, cut: true };
      throw error;
    }
  }
  return { rows, cut: false };
}

// Exhaustive on purpose: a status added to the schema fails typecheck until it is classified here,
// so a new open status cannot silently drop out of the statement. Settled statuses are false.
const PAYABLE_STATEMENT_OPEN = {
  PENDING: true, NOT_YET_DUE: true, DUE_ON_SALE: true, PARTIALLY_PAID: true, DISPUTED: true, PAID: false, CANCELLED: false,
} satisfies Record<Doc<"vehicleSupplierPayables">["status"], boolean>;
const RECEIVABLE_STATEMENT_OPEN = {
  OPEN: true, PARTIALLY_PAID: true, DISPUTED: true, PAID: false, CANCELLED: false,
} satisfies Record<Doc<"vehicleSupplierReceivables">["status"], boolean>;
const statusesWhere = <S extends string>(map: Record<S, boolean>): S[] => (Object.keys(map) as S[]).filter((status) => map[status]);
const OPEN_PAYABLE_STATUSES = statusesWhere(PAYABLE_STATEMENT_OPEN);
const OPEN_RECEIVABLE_STATUSES = statusesWhere(RECEIVABLE_STATEMENT_OPEN);

/**
 * SCRUM-869 slice 1 - one supplier's outstanding obligations as two sections that are never
 * combined: `payable` (A/P, what the dealership owes) and `receivable` (A/R, what the supplier
 * owes: margin receivables and cost recoveries). Rows come from the supplier-keyed index and use
 * the same row reader as the aging screen, so a line shows the same figure on both. The caller
 * must already have proved the supplier belongs to `orgId`.
 */
export async function readSupplierOutstanding(
  ctx: Reader & HeadroomCtx,
  args: { orgId: Id<"organizations">; supplierId: Id<"suppliers">; nowMs: number },
  cache = createSupplierReadCache(),
): Promise<{ payable: StatementSection; receivable: StatementSection }> {
  const { orgId, supplierId, nowMs } = args;
  // Settled families are left out by index, not read and discarded, so a supplier with a long
  // paid history cannot push open rows past the bound. A row whose stored status says settled
  // while its amounts say otherwise is a data defect for the reconciliation slice, not this read.
  // Read in turn through the transaction's own headroom (transactionReadHeadroom.ts): a row cap bounds documents, not bytes, and
  // one function may read 16 MiB (https://docs.convex.dev/production/state/limits). A family cut short by the budget is
  // incomplete with its totals withheld, never a thrown read error (#764 round 4).
  const payables = await readSettledFamily(ctx, OPEN_PAYABLE_STATUSES, (status) =>
    ctx.db
      .query("vehicleSupplierPayables")
      .withIndex("by_org_and_supplierId_and_status", (q) => q.eq("orgId", orgId).eq("supplierId", supplierId).eq("status", status))
  );
  const claims = await readSettledFamily(ctx, OPEN_RECEIVABLE_STATUSES, (status) =>
    ctx.db
      .query("vehicleSupplierReceivables")
      .withIndex("by_org_and_supplierId_and_status", (q) => q.eq("orgId", orgId).eq("supplierId", supplierId).eq("status", status))
  );
  const recoveries = await readSettledFamily(ctx, OPEN_RECOVERY_STATUSES, (status) =>
    ctx.db
      .query("supplierCostRecoveries")
      .withIndex("by_org_and_supplierId_and_status", (q) => q.eq("orgId", orgId).eq("supplierId", supplierId).eq("status", status))
  );
  const payableDocs = payables.docs;
  const receivableDocs = claims.docs;
  const recoveryDocs = recoveries.docs;
  const payableDocsShown = payableDocs.slice(0, STATEMENT_FAMILY_LIMIT);
  const payableRead = await readRowsWithinBudget(payableDocsShown, async (i) => {
    const row = payableDocsShown[i]!;
    const read = await readRow("PAYABLE", row._id, row.currency, nowMs, () => payableFacts(ctx, orgId, row, cache), undefined);
    return read ? { ...read, document: row } : null;
  });
  const receivableDocsShown = receivableDocs.slice(0, STATEMENT_FAMILY_LIMIT);
  const receivableRead = await readRowsWithinBudget(receivableDocsShown, async (i) => {
    const row = receivableDocsShown[i]!;
    const read = await readRow("RECEIVABLE", row._id, row.currency, nowMs, () => receivableFacts(ctx, orgId, row, cache), undefined);
    return read ? { ...read, document: row } : null;
  });
  const receivableRows: WithSupplierDocument<ObligationRow>[] = [...receivableRead.rows];
  for (const row of recoveryDocs.slice(0, STATEMENT_FAMILY_LIMIT)) {
    const read = await readRow("RECOVERY", row._id, row.currency, nowMs, () => recoveryFacts(row), undefined);
    if (read) receivableRows.push({ ...read, document: row });
  }

  const payableBudgetCut = payables.cut || payableRead.cut;
  const receivableBudgetCut = claims.cut || recoveries.cut || receivableRead.cut;
  return {
    payable: statementSection(
      payableRead.rows,
      !payableBudgetCut && payableDocs.length <= STATEMENT_FAMILY_LIMIT,
      payableBudgetCut ? "READ_BUDGET" : "ROW_LIMIT",
    ),
    receivable: statementSection(
      receivableRows,
      !receivableBudgetCut && receivableDocs.length <= STATEMENT_FAMILY_LIMIT && recoveryDocs.length <= STATEMENT_FAMILY_LIMIT,
      receivableBudgetCut ? "READ_BUDGET" : "ROW_LIMIT",
    ),
  };
}

/**
 * Where a row's settled amount comes from. RECORDED: payments or receipts the system recorded. INFERRED_FROM_PAID_STATUS: a
 * payable stored PAID with no `amountPaid` (a row from before payments were recorded); every other reader treats it as fully
 * paid (`settlementView`), so the amount is shown, but it is labelled as inferred because no payment record backs it.
 */
export type SettledBasis = "RECORDED" | "INFERRED_FROM_PAID_STATUS";

/**
 * Whether the obligation itself is closed. This is a different fact from `settledMinor`: a margin claim closed by a customer
 * deposit plus a smaller supplier receipt is COMPLETE although the supplier's cash is below the claim, so the two are never
 * derived from each other.
 */
export type SettlementCompletion = "COMPLETE" | "PARTIAL";

export interface SettledRow {
  document: SupplierObligation;
  kind: ObligationKind;
  id: string;
  currency: string;
  /** The stored status of the row, so a part-settled line is not mistaken for a closed one. */
  status: string;
  /** The full amount of the obligation. */
  dueMinor: number;
  /** Cash actually paid (A/P) or received from the supplier (A/R) so far, in minor units of `currency`. */
  settledMinor: number;
  /**
   * Whether the obligation is settled in full, derived on the server from the obligation's own record, never by comparing
   * `settledMinor` with `dueMinor` (which for a margin claim leaves out the customer deposit applied to it).
   */
  settlement: SettlementCompletion;
  /** When the row last changed. For a settled row this is when the last payment was recorded. */
  lastChangedAt: number;
  basis: SettledBasis;
}

export interface SettledTotal {
  currency: string;
  settledMinor: number;
}

export interface SettledSection {
  rows: SettledRow[];
  /** Why the section is incomplete, when a row or read limit is the reason; absent when complete or when only unverified receipts are. */
  incompleteReason?: IncompleteReason;
  /** One total per currency; currencies are never added together. */
  totals: SettledTotal[];
  /** False when a family held more rows than the read bound, or a row's cash could not be established: rows and totals are then partial. */
  complete: boolean;
  /**
   * Margin claims that hold a recorded supplier receipt whose posting could not be read back from the ledger (not posted yet,
   * or the ledger records are unreadable). Their cash is unknown, so they are left out and the totals are withheld.
   */
  unverifiedCount: number;
}

// Statuses whose rows can hold settled cash. Exhaustive like the open maps above: a status added to
// the schema fails typecheck until it is classified. A DISPUTED row can be part-paid, so it is read
// and skipped only when nothing was paid. CANCELLED and REVERSED rows are not settlements.
const PAYABLE_HAS_SETTLED = {
  PENDING: false,
  NOT_YET_DUE: false,
  DUE_ON_SALE: false,
  PARTIALLY_PAID: true,
  DISPUTED: true,
  PAID: true,
  CANCELLED: false,
} satisfies Record<Doc<"vehicleSupplierPayables">["status"], boolean>;
const RECEIVABLE_HAS_SETTLED = {
  OPEN: false,
  PARTIALLY_PAID: true,
  DISPUTED: true,
  PAID: true,
  CANCELLED: false,
} satisfies Record<Doc<"vehicleSupplierReceivables">["status"], boolean>;
const RECOVERY_HAS_SETTLED = {
  OPEN: false,
  PARTIALLY_RECOVERED: true,
  RECOVERED: true,
  REVERSED: false,
} satisfies Record<Doc<"supplierCostRecoveries">["status"], boolean>;
const SETTLED_PAYABLE_STATUSES = statusesWhere(PAYABLE_HAS_SETTLED);
const SETTLED_RECEIVABLE_STATUSES = statusesWhere(RECEIVABLE_HAS_SETTLED);
const SETTLED_RECOVERY_STATUSES = statusesWhere(RECOVERY_HAS_SETTLED);

/**
 * The newest-created STATEMENT_FAMILY_LIMIT rows across the statuses read (the index orders by
 * _creationTime within a status); callers compare the unsliced length with the limit.
 */
function newest<D extends { _creationTime: number }>(docs: D[]): D[] {
  return [...docs].sort((a, b) => b._creationTime - a._creationTime).slice(0, STATEMENT_FAMILY_LIMIT);
}

/** Budget first: it is the one reason a screen must not read as "nothing here". Unverified receipts alone carry no reason. */
function settledIncompleteReason(complete: boolean, withinBound: boolean, budgetCut: boolean): IncompleteReason | undefined {
  if (complete) return undefined;
  if (budgetCut) return "READ_BUDGET";
  return withinBound ? undefined : "ROW_LIMIT";
}

function settledSection(rows: SettledRow[], withinBound: boolean, unverifiedCount = 0, budgetCut = false): SettledSection {
  // W14: a partial list never presents a partial sum as a total.
  const complete = withinBound && unverifiedCount === 0;
  const byCurrency = new Map<string, SettledTotal>();
  for (const row of complete ? rows : []) {
    const total = byCurrency.get(row.currency) ?? { currency: row.currency, settledMinor: 0 };
    total.settledMinor += row.settledMinor;
    byCurrency.set(row.currency, total);
  }
  const incompleteReason = settledIncompleteReason(complete, withinBound, budgetCut);
  return { rows, totals: [...byCurrency.values()], complete, unverifiedCount, ...(incompleteReason ? { incompleteReason } : {}) };
}

/** Ledger reads per supplier for receipt provenance: entries, and lines per entry (a receipt posts two lines). */
const RECEIPT_ENTRY_BUDGET = 1000;
const RECEIPT_LINES_PER_ENTRY = 10;

/**
 * The cash the supplier actually paid against one margin claim, established from the receipts' own postings
 * (`SUPPLIER_RECEIVABLE_COLLECTED`: Dr cash or bank, Cr 1240, journal source = the claim). `amountReceived` cannot be the
 * source: it also holds the customer deposit applied to the settlement when the claim was opened (`openSupplierReceivable`'s
 * `alreadyReceivedAmount`), which is the dealership's margin in customer cash, not a supplier payment. Net of reversals
 * (a reversal entry carries the same source with the lines inverted). `receiptSeq` counts recorded receipts, so fewer posted
 * entries than that means a receipt is missing from the ledger.
 *
 * The outcome says WHY a figure is missing, because the caller must treat the two reasons differently:
 *   - UNVERIFIED: this claim's cash cannot be established from the ledger (a receipt is missing, a line is foreign or in another
 *     currency, a net debit). The entries read for it are spent from the shared entry budget, and the next claim is read normally.
 *   - OUT_OF_BUDGET: the shared entry budget or the transaction's read headroom ran out. Nothing about THIS claim is known, and
 *     no later claim can be read either.
 * `reversed` is true when any receipt posting of the claim has been reversed: the claim row (`status`, `amountReceived`) is not
 * touched by a journal reversal, so a reversed receipt means the claim record overstates what was collected.
 */
type ReceiptRead =
  | { outcome: "READ"; minor: number; entriesRead: number; reversed: boolean }
  | { outcome: "UNVERIFIED"; entriesRead: number }
  | { outcome: "OUT_OF_BUDGET" };

/** Net credit to the control account across one entry's lines, or null when a line is foreign or in another currency. */
function controlCreditMinor(
  lines: Doc<"journalLines">[],
  args: { orgId: Id<"organizations">; controlAccountId: Id<"chartOfAccounts">; currency: string },
): number | null {
  let minor = 0;
  for (const line of lines) {
    if (line.orgId !== args.orgId) return null;
    if (line.accountId !== args.controlAccountId) continue;
    if (line.currency !== args.currency) return null;
    minor += line.creditMinor - line.debitMinor;
  }
  return minor;
}

async function supplierReceiptsMinor(
  ctx: Reader & HeadroomCtx,
  args: { orgId: Id<"organizations">; claim: Doc<"vehicleSupplierReceivables">; controlAccountId: Id<"chartOfAccounts"> | null; entriesLeft: number },
): Promise<ReceiptRead> {
  const { orgId, claim, controlAccountId, entriesLeft } = args;
  const recorded = claim.receiptSeq ?? 0;
  // No receipt was ever recorded and no posting exists: whatever `amountReceived` holds is the deposit seed.
  const read = await readBoundedStream(
    ctx,
    ctx.db
      .query("journalEntries")
      .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicleSupplierReceivables").eq("sourceId", claim._id)),
    Math.max(entriesLeft, 0),
  );
  if (read.outOfHeadroom || read.docs.length > entriesLeft) return { outcome: "OUT_OF_BUDGET" };
  const entries = read.docs;
  const posted = entries.filter((entry) => entry.status === "POSTED" || entry.status === "REVERSED");
  if (posted.filter((entry) => entry.category !== "REVERSAL").length < recorded) return { outcome: "UNVERIFIED", entriesRead: entries.length };
  if (posted.length === 0) return { outcome: "READ", minor: 0, entriesRead: entries.length, reversed: false };
  if (!controlAccountId) return { outcome: "UNVERIFIED", entriesRead: entries.length };
  let minor = 0;
  for (const entry of posted) {
    const lines = await readBoundedStream(
      ctx,
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)),
      RECEIPT_LINES_PER_ENTRY,
    );
    if (lines.outOfHeadroom) return { outcome: "OUT_OF_BUDGET" };
    const entryMinor = lines.docs.length > RECEIPT_LINES_PER_ENTRY ? null : controlCreditMinor(lines.docs, { orgId, controlAccountId, currency: claim.currency });
    if (entryMinor === null) return { outcome: "UNVERIFIED", entriesRead: entries.length };
    minor += entryMinor;
  }
  if (minor < 0) return { outcome: "UNVERIFIED", entriesRead: entries.length };
  const reversed = posted.some((entry) => entry.status === "REVERSED" || entry.category === "REVERSAL");
  return { outcome: "READ", minor, entriesRead: entries.length, reversed };
}

/**
 * One settled family, read one document at a time through the supplier index, newest first within each status. Every document is
 * admitted by the transaction's own read headroom before it is fetched (see transactionReadHeadroom.ts), so a family of large
 * records stops at the budget instead of throwing at the platform's 16 MiB limit. `cut` is true when the transaction ran out of
 * room: `docs` is then partial. The statuses are read in turn, not together, because each read must see what the one before spent.
 * `docs.length > STATEMENT_FAMILY_LIMIT` is the row-cap signal, as before.
 */
async function readSettledFamily<S extends string, D>(
  ctx: HeadroomCtx,
  statuses: readonly S[],
  source: (status: S) => AsyncIterable<D>,
): Promise<{ docs: D[]; cut: boolean }> {
  const docs: D[] = [];
  for (const status of statuses) {
    const read = await readBoundedStream(ctx, source(status), STATEMENT_FAMILY_LIMIT);
    docs.push(...read.docs);
    if (read.outOfHeadroom) return { docs, cut: true };
  }
  return { docs, cut: false };
}

/**
 * SCRUM-869 slice 4 - what one supplier has been paid (A/P) and has paid back (A/R), as two sections
 * that are never combined. Reads only the settled statuses through the supplier index, newest first,
 * so open rows cannot use up the bound. Each side shows what its source actually records:
 * - A/P: the payments on the payable, read through `settlementView` like every other reader, so a legacy row stored PAID with
 *   no `amountPaid` is shown as fully paid (labelled INFERRED_FROM_PAID_STATUS) instead of vanishing while the payments
 *   reconciliation counts it.
 * - A/R: supplier receipts established from their postings, never `amountReceived` (it includes customer deposits applied to
 *   the settlement). A claim whose receipts cannot be read back is counted in `unverifiedCount`, left out, and withholds
 *   the totals.
 * Two limits bound the read, and both end in a truthful incomplete section rather than a throw:
 * - rows: STATEMENT_FAMILY_LIMIT per family, as before;
 * - bytes: every document read, the receipt-provenance ledger reads included, is first admitted by the transaction's own read
 *   headroom (`readBoundedStream`), one shared budget across the three families and the provenance reads. A family cut short by
 *   it is `complete: false` with its totals withheld. A row cap alone does not bound bytes: `receiptNotes` can be ~1 MiB.
 * The caller must already have proved the supplier belongs to `orgId`.
 */
export async function readSupplierSettled(
  ctx: Reader & HeadroomCtx,
  args: { orgId: Id<"organizations">; supplierId: Id<"suppliers"> },
): Promise<{ payable: SettledSection; receivable: SettledSection }> {
  const { orgId, supplierId } = args;
  // Read in turn, not together: each document's headroom check must see what the reads before it spent.
  const payables = await readSettledFamily(ctx, SETTLED_PAYABLE_STATUSES, (status) =>
    ctx.db
      .query("vehicleSupplierPayables")
      .withIndex("by_org_and_supplierId_and_status", (q) =>
        q.eq("orgId", orgId).eq("supplierId", supplierId).eq("status", status),
      )
      .order("desc"),
  );
  const payableDocs = payables.docs;
  const payableRows = settledPayableRows(newest(payableDocs));
  const payable = settledSection(payableRows, !payables.cut && payableDocs.length <= STATEMENT_FAMILY_LIMIT, 0, payables.cut);
  const claimsRead = await readSettledFamily(ctx, SETTLED_RECEIVABLE_STATUSES, (status) =>
    ctx.db
      .query("vehicleSupplierReceivables")
      .withIndex("by_org_and_supplierId_and_status", (q) =>
        q.eq("orgId", orgId).eq("supplierId", supplierId).eq("status", status),
      )
      .order("desc"),
  );
  const recoveries = await readSettledFamily(ctx, SETTLED_RECOVERY_STATUSES, (status) =>
    ctx.db
      .query("supplierCostRecoveries")
      .withIndex("by_org_and_supplierId_and_status", (q) =>
        q.eq("orgId", orgId).eq("supplierId", supplierId).eq("status", status),
      )
      .order("desc"),
  );
  const receivableDocs = claimsRead.docs;
  const recoveryDocs = recoveries.docs;

  // When the claims family itself was cut short by the budget the transaction has no room left for ledger reads either; the
  // section is already incomplete, so provenance is not attempted and no claim is miscounted as an unconfirmed receipt.
  const claims = claimsRead.cut ? [] : newest(receivableDocs);
  const provenance = await readClaimProvenance(ctx, orgId, claims);
  // A/R rows from both families, merged newest-created first (the ADR's order), whatever the family.
  const receivableRows = [...provenance.rows, ...settledRecoveryRows(newest(recoveryDocs))];
  receivableRows.sort((a, b) => b.createdAt - a.createdAt);
  const { unverifiedCount, budgetSpent } = provenance;
  return {
    payable,
    receivable: settledSection(
      receivableRows.map((entry) => entry.row),
      !claimsRead.cut && !recoveries.cut && receivableDocs.length <= STATEMENT_FAMILY_LIMIT && recoveryDocs.length <= STATEMENT_FAMILY_LIMIT,
      unverifiedCount,
      claimsRead.cut || recoveries.cut || (budgetSpent && unverifiedCount > 0),
    ),
  };
}

interface ClaimProvenance {
  rows: DatedSettledRow[];
  entriesLeft: number;
  unverifiedCount: number;
  /**
   * Once the shared entry budget or the transaction's headroom is gone, no later claim can be read: each one that holds money
   * that might be a receipt is counted unconfirmed (it could not be checked) without another read.
   */
  budgetSpent: boolean;
}

async function readClaimProvenance(
  ctx: Reader & HeadroomCtx,
  orgId: Id<"organizations">,
  claims: Doc<"vehicleSupplierReceivables">[],
): Promise<ClaimProvenance> {
  // The control account is read only when some claim holds money that might be a receipt.
  const controlAccountId = claims.some((claim) => (claim.amountReceived ?? 0) > 0)
    ? ((
        await ctx.db
          .query("chartOfAccounts")
          .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS))
          .unique()
      )?._id ?? null)
    : null;
  const state: ClaimProvenance = { rows: [], entriesLeft: RECEIPT_ENTRY_BUDGET, unverifiedCount: 0, budgetSpent: false };
  await inTurn(claims, async (claim) => {
    // Nothing was ever applied to the claim: nothing to attribute, and no ledger read.
    if (toMinorUnits(claim.amountReceived ?? 0, claim.currency) <= 0) return;
    // A claim with no recorded receipt holds only the customer deposit seed: there is no supplier receipt to confirm, so when the
    // budget is gone it is skipped, not counted unverified (#764 round 4, LOW-2). While budget remains it is still read, as before.
    const mayHoldReceipt = (claim.receiptSeq ?? 0) > 0;
    if (state.budgetSpent) {
      if (mayHoldReceipt) state.unverifiedCount += 1;
      return;
    }
    const receipts = await supplierReceiptsMinor(ctx, { orgId, claim, controlAccountId, entriesLeft: state.entriesLeft });
    if (receipts.outcome === "OUT_OF_BUDGET") {
      state.budgetSpent = true;
      if (mayHoldReceipt) state.unverifiedCount += 1;
      return;
    }
    // Entries read for a claim are spent from the shared budget whether or not its cash could be established.
    state.entriesLeft -= receipts.entriesRead;
    if (receipts.outcome === "UNVERIFIED") {
      state.unverifiedCount += 1;
      return;
    }
    if (receipts.minor <= 0) return; // deposit only, or every receipt reversed: no supplier cash
    state.rows.push(settledClaimRow(claim, receipts));
  });
  return state;
}
