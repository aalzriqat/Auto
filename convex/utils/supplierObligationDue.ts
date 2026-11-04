import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { supportedCurrencyScale, toMinorUnits } from "./money";
import { settlementView } from "./supplierSettlement";
import { OPEN_RECOVERY_STATUSES } from "./costBearer";
import { SYSTEM_KEYS } from "./defaultChart";
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

async function ownedSale(ctx: Reader, orgId: Id<"organizations">, saleId: Id<"sales"> | undefined) {
  if (!saleId) return null;
  const sale = await ctx.db.get(saleId);
  return sale && sale.orgId === orgId ? sale : null;
}

/** The deal's finance application, only when it is this organisation's: a foreign or missing one is a missing fact. */
async function ownedApplication(
  ctx: Reader,
  orgId: Id<"organizations">,
  sale: Doc<"sales"> | null
): Promise<Doc<"financeApplications"> | null> {
  if (!sale?.applicationId) return null;
  const application = await ctx.db.get(sale.applicationId);
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

async function payableFacts(ctx: Reader, orgId: Id<"organizations">, row: Doc<"vehicleSupplierPayables">): Promise<Outstanding | null> {
  const view = settlementView(row);
  // Settled rows drop out through a zero remainder, not through the stored status: a status that
  // disagrees with the amounts must not hide open money.
  if (view.status === "CANCELLED") return null;
  const outstandingMinor = toMinorUnits(view.remainingAmount, row.currency);
  if (outstandingMinor <= 0) return null;
  const sale = await ownedSale(ctx, orgId, "saleId" in row ? row.saleId : undefined);
  const throughDealership = sale?.supplierSettlementRoute === "THROUGH_DEALERSHIP";
  return {
    outstandingMinor,
    disputed: view.status === "DISPUTED",
    agreedDueAt: renderableDate("paymentDueDate", row.paymentDueDate),
    model: throughDealership ? "SOURCED_THROUGH_DEALERSHIP_PAYABLE" : "OWNED_ON_ACCOUNT_PAYABLE",
    // Read only for the model that uses it: one extra bounded `get` per through-dealership row.
    ...(throughDealership ? { financierFunding: financierFundingFact(sale, await ownedApplication(ctx, orgId, sale)) } : {}),
  };
}

async function receivableFacts(ctx: Reader, orgId: Id<"organizations">, row: Doc<"vehicleSupplierReceivables">): Promise<Outstanding | null> {
  if (row.status === "CANCELLED") return null;
  const outstandingMinor = Math.max(
    0,
    toMinorUnits(row.amountDue, row.currency) - toMinorUnits(row.amountReceived ?? 0, row.currency)
  );
  if (outstandingMinor <= 0) return null;
  const sale = await ownedSale(ctx, orgId, row.saleId);
  return {
    outstandingMinor,
    disputed: row.status === "DISPUTED",
    agreedDueAt: renderableDate("agreedDueDate", row.agreedDueDate),
    model: "SOURCED_DIRECT_RECEIVABLE",
    deliveredAt: recordedDeliveryAt(await ownedApplication(ctx, orgId, sale)),
  };
}

function recoveryFacts(row: Doc<"supplierCostRecoveries">): Outstanding | null {
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
async function readRow(
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

export async function readObligationPage(
  ctx: Reader,
  args: {
    orgId: Id<"organizations">;
    kind: ObligationKind;
    cursor: string | null;
    limit: number;
    nowMs: number;
    /** Supplied by a writer that must decide before it writes anything (the due-alert worker). */
    onUnreadableRow?: (row: UnreadableRow) => void;
  }
): Promise<ObligationPage> {
  const { orgId, kind, cursor, nowMs, onUnreadableRow } = args;
  const numItems = Math.min(Math.max(Math.trunc(args.limit), 1), OBLIGATION_PAGE_MAX);
  const rows: ObligationRow[] = [];
  let isDone: boolean;
  let continueCursor: string;

  if (kind === "PAYABLE") {
    const page = await ctx.db.query("vehicleSupplierPayables").withIndex("by_org", (q) => q.eq("orgId", orgId)).paginate({ cursor, numItems });
    for (const row of page.page) {
      const read = await readRow(kind, row._id, row.currency, nowMs, () => payableFacts(ctx, orgId, row), onUnreadableRow);
      if (read) rows.push(read);
    }
    ({ isDone, continueCursor } = page);
  } else if (kind === "RECEIVABLE") {
    const page = await ctx.db.query("vehicleSupplierReceivables").withIndex("by_org", (q) => q.eq("orgId", orgId)).paginate({ cursor, numItems });
    for (const row of page.page) {
      const read = await readRow(kind, row._id, row.currency, nowMs, () => receivableFacts(ctx, orgId, row), onUnreadableRow);
      if (read) rows.push(read);
    }
    ({ isDone, continueCursor } = page);
  } else {
    const page = await ctx.db.query("supplierCostRecoveries").withIndex("by_org", (q) => q.eq("orgId", orgId)).paginate({ cursor, numItems });
    for (const row of page.page) {
      const read = await readRow(kind, row._id, row.currency, nowMs, () => recoveryFacts(row), onUnreadableRow);
      if (read) rows.push(read);
    }
    ({ isDone, continueCursor } = page);
  }

  return { rows, totals: totalsOf(rows), complete: isDone, continueCursor };
}

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
  rows: ObligationRow[];
  /** One total per currency; currencies are never added together. */
  totals: StatementTotal[];
  /** False when the family held more rows than the read bound: the rows and totals are then partial. */
  complete: boolean;
}

function statementSection(rows: ObligationRow[], complete: boolean): StatementSection {
  const byCurrency = new Map<string, StatementTotal>();
  for (const row of rows) {
    const total = byCurrency.get(row.currency) ?? { currency: row.currency, grossMinor: 0, disputedMinor: 0, overdueMinor: 0 };
    total.grossMinor += row.outstandingMinor;
    total.disputedMinor += row.disputedMinor;
    if (row.daysOverdue !== null && row.daysOverdue > 0) total.overdueMinor += row.outstandingMinor;
    byCurrency.set(row.currency, total);
  }
  return { rows, totals: [...byCurrency.values()], complete };
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

/** One bounded read per open status, run together and concatenated; callers compare the length with the limit. */
async function readByStatuses<S extends string, D>(statuses: readonly S[], read: (status: S) => Promise<D[]>): Promise<D[]> {
  return (await Promise.all(statuses.map(read))).flat();
}
/**
 * SCRUM-869 slice 1 - one supplier's outstanding obligations as two sections that are never
 * combined: `payable` (A/P, what the dealership owes) and `receivable` (A/R, what the supplier
 * owes: margin receivables and cost recoveries). Rows come from the supplier-keyed index and use
 * the same row reader as the aging screen, so a line shows the same figure on both. The caller
 * must already have proved the supplier belongs to `orgId`.
 */
export async function readSupplierOutstanding(
  ctx: Reader,
  args: { orgId: Id<"organizations">; supplierId: Id<"suppliers">; nowMs: number }
): Promise<{ payable: StatementSection; receivable: StatementSection }> {
  const { orgId, supplierId, nowMs } = args;
  // Settled families are left out by index, not read and discarded, so a supplier with a long
  // paid history cannot push open rows past the bound. A row whose stored status says settled
  // while its amounts say otherwise is a data defect for the reconciliation slice, not this read.
  const payableDocs = await readByStatuses(OPEN_PAYABLE_STATUSES, (status) =>
    ctx.db
      .query("vehicleSupplierPayables")
      .withIndex("by_org_and_supplierId_and_status", (q) => q.eq("orgId", orgId).eq("supplierId", supplierId).eq("status", status))
      .take(STATEMENT_FAMILY_LIMIT + 1)
  );
  const receivableDocs = await readByStatuses(OPEN_RECEIVABLE_STATUSES, (status) =>
    ctx.db
      .query("vehicleSupplierReceivables")
      .withIndex("by_org_and_supplierId_and_status", (q) => q.eq("orgId", orgId).eq("supplierId", supplierId).eq("status", status))
      .take(STATEMENT_FAMILY_LIMIT + 1)
  );
  const recoveryDocs = await readByStatuses(OPEN_RECOVERY_STATUSES, (status) =>
    ctx.db
      .query("supplierCostRecoveries")
      .withIndex("by_org_and_supplierId_and_status", (q) => q.eq("orgId", orgId).eq("supplierId", supplierId).eq("status", status))
      .take(STATEMENT_FAMILY_LIMIT + 1)
  );
  const payableRows: ObligationRow[] = [];
  for (const row of payableDocs.slice(0, STATEMENT_FAMILY_LIMIT)) {
    const read = await readRow("PAYABLE", row._id, row.currency, nowMs, () => payableFacts(ctx, orgId, row), undefined);
    if (read) payableRows.push(read);
  }
  const receivableRows: ObligationRow[] = [];
  for (const row of receivableDocs.slice(0, STATEMENT_FAMILY_LIMIT)) {
    const read = await readRow("RECEIVABLE", row._id, row.currency, nowMs, () => receivableFacts(ctx, orgId, row), undefined);
    if (read) receivableRows.push(read);
  }
  for (const row of recoveryDocs.slice(0, STATEMENT_FAMILY_LIMIT)) {
    const read = await readRow("RECOVERY", row._id, row.currency, nowMs, () => recoveryFacts(row), undefined);
    if (read) receivableRows.push(read);
  }

  return {
    payable: statementSection(payableRows, payableDocs.length <= STATEMENT_FAMILY_LIMIT),
    receivable: statementSection(
      receivableRows,
      receivableDocs.length <= STATEMENT_FAMILY_LIMIT && recoveryDocs.length <= STATEMENT_FAMILY_LIMIT
    ),
  };
}

/**
 * Where a row's settled amount comes from. RECORDED: payments or receipts the system recorded. INFERRED_FROM_PAID_STATUS: a
 * payable stored PAID with no `amountPaid` (a row from before payments were recorded); every other reader treats it as fully
 * paid (`settlementView`), so the amount is shown, but it is labelled as inferred because no payment record backs it.
 */
export type SettledBasis = "RECORDED" | "INFERRED_FROM_PAID_STATUS";

export interface SettledRow {
  kind: ObligationKind;
  id: string;
  currency: string;
  /** The stored status of the row, so a part-settled line is not mistaken for a closed one. */
  status: string;
  /** The full amount of the obligation. */
  dueMinor: number;
  /** Cash actually paid (A/P) or received from the supplier (A/R) so far, in minor units of `currency`. */
  settledMinor: number;
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

function settledSection(rows: SettledRow[], withinBound: boolean, unverifiedCount = 0): SettledSection {
  // W14: a partial list never presents a partial sum as a total.
  const complete = withinBound && unverifiedCount === 0;
  const byCurrency = new Map<string, SettledTotal>();
  for (const row of complete ? rows : []) {
    const total = byCurrency.get(row.currency) ?? { currency: row.currency, settledMinor: 0 };
    total.settledMinor += row.settledMinor;
    byCurrency.set(row.currency, total);
  }
  return { rows, totals: [...byCurrency.values()], complete, unverifiedCount };
}

/** Ledger reads per supplier for receipt provenance: entries, and lines per entry (a receipt posts two lines). */
const RECEIPT_ENTRY_BUDGET = 1000;
const RECEIPT_LINES_PER_ENTRY = 10;

/**
 * The cash the supplier actually paid against one margin claim, established from the receipts' own postings
 * (`SUPPLIER_RECEIVABLE_COLLECTED`: Dr cash or bank, Cr 1240, journal source = the claim). `amountReceived` cannot be the
 * source: it also holds the customer deposit applied to the settlement when the claim was opened (`openSupplierReceivable`'s
 * `alreadyReceivedAmount`), which is the dealership's margin in customer cash, not a supplier payment. Net of reversals
 * (a reversal entry carries the same source with the lines inverted). Returns null when the cash cannot be established:
 * `receiptSeq` counts recorded receipts, so fewer posted entries than that means a receipt is missing from the ledger.
 */
async function supplierReceiptsMinor(
  ctx: Reader,
  args: { orgId: Id<"organizations">; claim: Doc<"vehicleSupplierReceivables">; controlAccountId: Id<"chartOfAccounts"> | null; entriesLeft: number },
): Promise<{ minor: number; entriesRead: number } | null> {
  const { orgId, claim, controlAccountId, entriesLeft } = args;
  const recorded = claim.receiptSeq ?? 0;
  // No receipt was ever recorded and no posting exists: whatever `amountReceived` holds is the deposit seed.
  const entries = await ctx.db
    .query("journalEntries")
    .withIndex("by_org_source", (q) => q.eq("orgId", orgId).eq("sourceType", "vehicleSupplierReceivables").eq("sourceId", claim._id))
    .take(Math.max(entriesLeft, 0) + 1);
  if (entries.length > entriesLeft) return null;
  const posted = entries.filter((entry) => entry.status === "POSTED" || entry.status === "REVERSED");
  if (posted.filter((entry) => entry.category !== "REVERSAL").length < recorded) return null;
  if (posted.length === 0) return { minor: 0, entriesRead: entries.length };
  if (!controlAccountId) return null;
  let minor = 0;
  for (const entry of posted) {
    const lines = await ctx.db
      .query("journalLines")
      .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id))
      .take(RECEIPT_LINES_PER_ENTRY + 1);
    if (lines.length > RECEIPT_LINES_PER_ENTRY) return null;
    for (const line of lines) {
      if (line.orgId !== orgId) return null;
      if (line.accountId !== controlAccountId) continue;
      if (line.currency !== claim.currency) return null;
      minor += line.creditMinor - line.debitMinor;
    }
  }
  return minor < 0 ? null : { minor, entriesRead: entries.length };
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
 * The caller must already have proved the supplier belongs to `orgId`.
 */
export async function readSupplierSettled(
  ctx: Reader,
  args: { orgId: Id<"organizations">; supplierId: Id<"suppliers"> },
): Promise<{ payable: SettledSection; receivable: SettledSection }> {
  const { orgId, supplierId } = args;
  const [payableDocs, receivableDocs, recoveryDocs] = await Promise.all([
  readByStatuses(SETTLED_PAYABLE_STATUSES, (status) =>
    ctx.db
      .query("vehicleSupplierPayables")
      .withIndex("by_org_and_supplierId_and_status", (q) =>
        q.eq("orgId", orgId).eq("supplierId", supplierId).eq("status", status),
      )
      .order("desc")
      .take(STATEMENT_FAMILY_LIMIT + 1),
  ),
  readByStatuses(SETTLED_RECEIVABLE_STATUSES, (status) =>
    ctx.db
      .query("vehicleSupplierReceivables")
      .withIndex("by_org_and_supplierId_and_status", (q) =>
        q.eq("orgId", orgId).eq("supplierId", supplierId).eq("status", status),
      )
      .order("desc")
      .take(STATEMENT_FAMILY_LIMIT + 1),
  ),
  readByStatuses(SETTLED_RECOVERY_STATUSES, (status) =>
    ctx.db
      .query("supplierCostRecoveries")
      .withIndex("by_org_and_supplierId_and_status", (q) =>
        q.eq("orgId", orgId).eq("supplierId", supplierId).eq("status", status),
      )
      .order("desc")
      .take(STATEMENT_FAMILY_LIMIT + 1),
  ),
  ]);
  const payableRows: SettledRow[] = [];
  for (const row of newest(payableDocs)) {
    // The same view every other reader uses: a PAID row with no recorded payments was paid in full before `amountPaid` existed.
    const settledMinor = toMinorUnits(settlementView(row).amountPaid, row.currency);
    if (settledMinor <= 0) continue;
    payableRows.push({
      kind: "PAYABLE",
      id: row._id,
      currency: row.currency,
      status: row.status,
      dueMinor: toMinorUnits(row.amountDue, row.currency),
      settledMinor,
      lastChangedAt: row.updatedAt,
      basis: row.status === "PAID" && (row.amountPaid ?? 0) === 0 ? "INFERRED_FROM_PAID_STATUS" : "RECORDED",
    });
  }

  // A/R rows from both families, merged newest-created first (the ADR's order), whatever the family.
  const receivableRows: { createdAt: number; row: SettledRow }[] = [];
  const claims = newest(receivableDocs);
  // The control account is read only when some claim holds money that might be a receipt.
  const controlAccountId = claims.some((claim) => (claim.amountReceived ?? 0) > 0)
    ? ((
        await ctx.db
          .query("chartOfAccounts")
          .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS))
          .unique()
      )?._id ?? null)
    : null;
  let entriesLeft = RECEIPT_ENTRY_BUDGET;
  let unverifiedCount = 0;
  for (const claim of claims) {
    // Nothing was ever applied to the claim: nothing to attribute, and no ledger read.
    if (toMinorUnits(claim.amountReceived ?? 0, claim.currency) <= 0) continue;
    const receipts = await supplierReceiptsMinor(ctx, { orgId, claim, controlAccountId, entriesLeft });
    if (receipts === null) {
      unverifiedCount += 1;
      entriesLeft = 0;
      continue;
    }
    entriesLeft -= receipts.entriesRead;
    if (receipts.minor <= 0) continue; // deposit only, or every receipt reversed: no supplier cash
    receivableRows.push({
      createdAt: claim._creationTime,
      row: {
        kind: "RECEIVABLE",
        id: claim._id,
        currency: claim.currency,
        status: claim.status,
        dueMinor: toMinorUnits(claim.amountDue, claim.currency),
        settledMinor: receipts.minor,
        lastChangedAt: claim.updatedAt,
        basis: "RECORDED",
      },
    });
  }
  for (const row of newest(recoveryDocs)) {
    if (row.amountRecoveredMinor <= 0) continue;
    receivableRows.push({
      createdAt: row._creationTime,
      row: {
        kind: "RECOVERY",
        id: row._id,
        currency: row.currency,
        status: row.status,
        dueMinor: row.amountDueMinor,
        settledMinor: row.amountRecoveredMinor,
        lastChangedAt: row.updatedAt,
        basis: "RECORDED",
      },
    });
  }
  receivableRows.sort((a, b) => b.createdAt - a.createdAt);
  return {
    payable: settledSection(payableRows, payableDocs.length <= STATEMENT_FAMILY_LIMIT),
    receivable: settledSection(
      receivableRows.map((entry) => entry.row),
      receivableDocs.length <= STATEMENT_FAMILY_LIMIT && recoveryDocs.length <= STATEMENT_FAMILY_LIMIT,
      unverifiedCount,
    ),
  };
}