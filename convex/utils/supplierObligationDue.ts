import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { toMinorUnits } from "./money";
import { settlementView } from "./supplierSettlement";
import {
  agingFor,
  ammanDateString,
  deriveDueDate,
  type AgingBucket,
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
}

type Reader = Pick<QueryCtx, "db">;

async function ownedSale(ctx: Reader, orgId: Id<"organizations">, saleId: Id<"sales"> | undefined) {
  if (!saleId) return null;
  const sale = await ctx.db.get(saleId);
  return sale && sale.orgId === orgId ? sale : null;
}

/** The explicit delivery record: financed `handoverStatus === HANDED_OVER` with its timestamp. */
async function recordedDeliveryAt(
  ctx: Reader,
  orgId: Id<"organizations">,
  sale: Doc<"sales"> | null
): Promise<number | undefined> {
  if (!sale?.applicationId) return undefined;
  const application = await ctx.db.get(sale.applicationId);
  if (!application || application.orgId !== orgId) return undefined;
  if (application.handoverStatus !== "HANDED_OVER") return undefined;
  return application.vehicleHandoverAt;
}

async function payableFacts(ctx: Reader, orgId: Id<"organizations">, row: Doc<"vehicleSupplierPayables">): Promise<Outstanding | null> {
  const view = settlementView(row);
  // Settled rows drop out through a zero remainder, not through the stored status: a status that
  // disagrees with the amounts must not hide open money.
  if (view.status === "CANCELLED") return null;
  const outstandingMinor = toMinorUnits(view.remainingAmount, row.currency);
  if (outstandingMinor <= 0) return null;
  const sale = await ownedSale(ctx, orgId, "saleId" in row ? row.saleId : undefined);
  return {
    outstandingMinor,
    disputed: view.status === "DISPUTED",
    agreedDueAt: row.paymentDueDate,
    model: sale?.supplierSettlementRoute === "THROUGH_DEALERSHIP" ? "SOURCED_THROUGH_DEALERSHIP_PAYABLE" : "OWNED_ON_ACCOUNT_PAYABLE",
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
    agreedDueAt: row.agreedDueDate,
    model: "SOURCED_DIRECT_RECEIVABLE",
    deliveredAt: await recordedDeliveryAt(ctx, orgId, sale),
  };
}

function recoveryFacts(row: Doc<"supplierCostRecoveries">): Outstanding | null {
  if (row.status === "REVERSED") return null;
  const outstandingMinor = Math.max(0, row.amountDueMinor - row.amountRecoveredMinor);
  if (outstandingMinor <= 0) return null;
  return { outstandingMinor, disputed: false, agreedDueAt: row.agreedDueDate, model: "COST_RECOVERY" };
}

function toRow(
  kind: ObligationKind,
  id: string,
  currency: string,
  facts: Outstanding,
  nowMs: number
): ObligationRow {
  const derived = deriveDueDate(facts.model, { agreedDueAt: facts.agreedDueAt, deliveredAt: facts.deliveredAt });
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

export async function readObligationPage(
  ctx: Reader,
  args: {
    orgId: Id<"organizations">;
    kind: ObligationKind;
    cursor: string | null;
    limit: number;
    nowMs: number;
  }
): Promise<ObligationPage> {
  const { orgId, kind, cursor, nowMs } = args;
  const numItems = Math.min(Math.max(Math.trunc(args.limit), 1), OBLIGATION_PAGE_MAX);
  const rows: ObligationRow[] = [];
  let isDone: boolean;
  let continueCursor: string;

  if (kind === "PAYABLE") {
    const page = await ctx.db.query("vehicleSupplierPayables").withIndex("by_org", (q) => q.eq("orgId", orgId)).paginate({ cursor, numItems });
    for (const row of page.page) {
      const facts = await payableFacts(ctx, orgId, row);
      if (facts) rows.push(toRow(kind, row._id, row.currency, facts, nowMs));
    }
    ({ isDone, continueCursor } = page);
  } else if (kind === "RECEIVABLE") {
    const page = await ctx.db.query("vehicleSupplierReceivables").withIndex("by_org", (q) => q.eq("orgId", orgId)).paginate({ cursor, numItems });
    for (const row of page.page) {
      const facts = await receivableFacts(ctx, orgId, row);
      if (facts) rows.push(toRow(kind, row._id, row.currency, facts, nowMs));
    }
    ({ isDone, continueCursor } = page);
  } else {
    const page = await ctx.db.query("supplierCostRecoveries").withIndex("by_org", (q) => q.eq("orgId", orgId)).paginate({ cursor, numItems });
    for (const row of page.page) {
      const facts = recoveryFacts(row);
      if (facts) rows.push(toRow(kind, row._id, row.currency, facts, nowMs));
    }
    ({ isDone, continueCursor } = page);
  }

  return { rows, totals: totalsOf(rows), complete: isDone, continueCursor };
}
