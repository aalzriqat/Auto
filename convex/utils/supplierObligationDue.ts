import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { supportedCurrencyScale, toMinorUnits } from "./money";
import { settlementView } from "./supplierSettlement";
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
