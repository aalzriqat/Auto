import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { AP_AFFECTING_EVENT_TYPES, hasPendingAffectingPosting } from "../accountingReports";
import { SYSTEM_KEYS } from "./defaultChart";
import { toMinorUnits } from "./money";
import { settlementView } from "./supplierSettlement";
import { STATEMENT_FAMILY_LIMIT } from "./supplierObligationDue";
import { readBoundedStream, type HeadroomCtx } from "./transactionReadHeadroom";

/**
 * SCRUM-869 per-supplier payments reconciliation (ADR docs/adr/2026-11-04-supplier-payments-gl-reconciliation.md).
 * Compares the cash the subledger says was paid to one supplier with the net debit to GL 2400 posted against that
 * supplier's payables. The credit side (what was owed) cannot be attributed to a supplier, so it is not compared.
 */
export type PaymentsReconciliationUnavailableReason =
  | "OVER_LIMIT"
  | "PENDING_POSTINGS"
  | "NO_CONTROL_ACCOUNT"
  | "INCONSISTENT_REFERENCE";

export type PaymentsReconciliationCurrency = {
  currency: string;
  subledgerPaidMinor: number;
  glPaidMinor: number;
  differenceMinor: number;
};

export type PaymentsReconciliationDifference = {
  payableId: Id<"vehicleSupplierPayables">;
  currency: string;
  subledgerPaidMinor: number;
  glPaidMinor: number;
};

export type PaymentsReconciliation = {
  status: "AVAILABLE" | "UNAVAILABLE";
  unavailableReason?: PaymentsReconciliationUnavailableReason;
  currencies: PaymentsReconciliationCurrency[];
  isReconciled: boolean;
  differences: PaymentsReconciliationDifference[];
  excludedOpeningRows: number;
  /** The obligation side has no supplier dimension on the ledger; it is never given a number here. */
  creditSide: "NOT_ATTRIBUTABLE";
};

/** Journal entries read across all of the supplier's payables. Each costs two index ranges; Convex allows 4,096 per function. */
const ENTRY_BUDGET = 1000;
const OUTBOX_READ_LIMIT = 400;
const LINES_PER_ENTRY_LIMIT = 50;

type PayableStatus = Doc<"vehicleSupplierPayables">["status"];
// Every status is read; a cancelled row may still carry payments. The record type makes a new status a compile error here.
const PAYABLE_STATUS_SET: Record<PayableStatus, true> = {
  PENDING: true,
  NOT_YET_DUE: true,
  DUE_ON_SALE: true,
  PARTIALLY_PAID: true,
  DISPUTED: true,
  PAID: true,
  CANCELLED: true,
};
const PAYABLE_STATUSES = Object.keys(PAYABLE_STATUS_SET) as PayableStatus[];

const unavailable = (unavailableReason: PaymentsReconciliationUnavailableReason): PaymentsReconciliation => ({
  status: "UNAVAILABLE",
  unavailableReason,
  currencies: [],
  isReconciled: false,
  differences: [],
  excludedOpeningRows: 0,
  creditSide: "NOT_ATTRIBUTABLE",
});

/**
 * The caller must already have proved the supplier belongs to `orgId`.
 *
 * Every read below goes through `readBoundedStream`: a row cap bounds documents, not bytes, and one function may read 16 MiB
 * (https://docs.convex.dev/production/state/limits). A read the transaction has no room for answers UNAVAILABLE / OVER_LIMIT with
 * no totals, the same refusal as a row cap, instead of throwing "Read too much data" (#764 round 4).
 */
export async function readSupplierPaymentsReconciliation(
  ctx: Pick<QueryCtx, "db"> & HeadroomCtx,
  args: { orgId: Id<"organizations">; supplierId: Id<"suppliers"> },
): Promise<PaymentsReconciliation> {
  const { orgId, supplierId } = args;

  // 1. Postings still in flight: the GL is about to move, so a comparison now is not the truth.
  // In turn, not together: each document's headroom check must see what the reads before it spent.
  const inFlight: Doc<"pendingAccountingEvents">[] = [];
  for (const status of ["PENDING", "FAILED"] as const) {
    const read = await readBoundedStream(
      ctx,
      ctx.db.query("pendingAccountingEvents").withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", status)),
      OUTBOX_READ_LIMIT,
    );
    if (read.outOfHeadroom || read.docs.length > OUTBOX_READ_LIMIT) return unavailable("OVER_LIMIT");
    inFlight.push(...read.docs);
  }
  // A queued reversal of a supplier payment is typed JOURNAL_REVERSAL, which the AP classification marks false:
  // unknown must not read as safe, so any queued reversal makes this unavailable.
  if (
    inFlight.some((event) => event.eventType === "JOURNAL_REVERSAL") ||
    (await hasPendingAffectingPosting(ctx, inFlight, AP_AFFECTING_EVENT_TYPES))
  ) {
    return unavailable("PENDING_POSTINGS");
  }

  // 2. Every payable of the supplier under one bound; past it nothing is summed (W14).
  const payables: Doc<"vehicleSupplierPayables">[] = [];
  for (const status of PAYABLE_STATUSES) {
    const read = await readBoundedStream(
      ctx,
      ctx.db
        .query("vehicleSupplierPayables")
        .withIndex("by_org_and_supplierId_and_status", (q) =>
          q.eq("orgId", orgId).eq("supplierId", supplierId).eq("status", status),
        ),
      STATEMENT_FAMILY_LIMIT,
    );
    if (read.outOfHeadroom) return unavailable("OVER_LIMIT");
    payables.push(...read.docs);
    if (payables.length > STATEMENT_FAMILY_LIMIT) return unavailable("OVER_LIMIT");
  }

  // Opening-basis payables settle against opening accounts, not 2400: out of both sides, and counted.
  const native = payables.filter((p) => p.origin !== "OPENING");
  const excludedOpeningRows = payables.length - native.length;

  const controlAccount = await ctx.db
    .query("chartOfAccounts")
    .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS))
    .unique();

  // 3. Subledger paid and GL paid, per payable.
  const perPayable: PaymentsReconciliationDifference[] = [];
  let entriesRead = 0;
  for (const payable of native) {
    const subledgerPaidMinor = toMinorUnits(settlementView(payable).amountPaid, payable.currency);
    let glPaidMinor = 0;
    if (controlAccount) {
      const budget = ENTRY_BUDGET - entriesRead;
      const entryRead = await readBoundedStream(
        ctx,
        ctx.db
          .query("journalEntries")
          .withIndex("by_org_source", (q) =>
            q.eq("orgId", orgId).eq("sourceType", "vehicleSupplierPayables").eq("sourceId", payable._id),
          ),
        Math.max(budget, 0),
      );
      const entries = entryRead.docs;
      if (entryRead.outOfHeadroom || entries.length > budget) return unavailable("OVER_LIMIT");
      entriesRead += entries.length;
      for (const entry of entries) {
        if (entry.status !== "POSTED" && entry.status !== "REVERSED") continue;
        const lineRead = await readBoundedStream(
          ctx,
          ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)),
          LINES_PER_ENTRY_LIMIT,
        );
        const lines = lineRead.docs;
        if (lineRead.outOfHeadroom || lines.length > LINES_PER_ENTRY_LIMIT) return unavailable("OVER_LIMIT");
        for (const line of lines) {
          if (line.orgId !== orgId) return unavailable("INCONSISTENT_REFERENCE");
          if (line.accountId !== controlAccount._id) continue;
          if (line.currency !== payable.currency) return unavailable("INCONSISTENT_REFERENCE");
          glPaidMinor += line.debitMinor - line.creditMinor;
        }
      }
    } else if (subledgerPaidMinor !== 0) {
      return unavailable("NO_CONTROL_ACCOUNT");
    }
    perPayable.push({ payableId: payable._id, currency: payable.currency, subledgerPaidMinor, glPaidMinor });
  }

  // 4. Per currency, never blended (W7).
  const totals = new Map<string, PaymentsReconciliationCurrency>();
  for (const row of perPayable) {
    const total = totals.get(row.currency) ?? {
      currency: row.currency,
      subledgerPaidMinor: 0,
      glPaidMinor: 0,
      differenceMinor: 0,
    };
    total.subledgerPaidMinor += row.subledgerPaidMinor;
    total.glPaidMinor += row.glPaidMinor;
    total.differenceMinor = total.subledgerPaidMinor - total.glPaidMinor;
    totals.set(row.currency, total);
  }
  const currencies = [...totals.values()].filter((c) => c.subledgerPaidMinor !== 0 || c.glPaidMinor !== 0);
  const differences = perPayable.filter((row) => row.subledgerPaidMinor !== row.glPaidMinor);
  return {
    status: "AVAILABLE",
    currencies,
    isReconciled: differences.length === 0,
    differences,
    excludedOpeningRows,
    creditSide: "NOT_ATTRIBUTABLE",
  };
}
