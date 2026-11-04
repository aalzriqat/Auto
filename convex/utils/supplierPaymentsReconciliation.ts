import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { AP_AFFECTING_EVENT_TYPES, hasPendingAffectingPosting } from "../accountingReports";
import { SYSTEM_KEYS } from "./defaultChart";
import { toMinorUnits } from "./money";
import { settlementView } from "./supplierSettlement";
import { STATEMENT_FAMILY_LIMIT } from "./supplierObligationDue";

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

const PAYABLE_STATUS_READ = {
  PENDING: true,
  NOT_YET_DUE: true,
  DUE_ON_SALE: true,
  PARTIALLY_PAID: true,
  DISPUTED: true,
  PAID: true,
  // A cancelled row may still carry payments, so it is read too.
  CANCELLED: true,
} satisfies Record<Doc<"vehicleSupplierPayables">["status"], boolean>;
const PAYABLE_STATUSES = (Object.keys(PAYABLE_STATUS_READ) as Array<keyof typeof PAYABLE_STATUS_READ>).filter(
  (status) => PAYABLE_STATUS_READ[status],
);

const unavailable = (unavailableReason: PaymentsReconciliationUnavailableReason): PaymentsReconciliation => ({
  status: "UNAVAILABLE",
  unavailableReason,
  currencies: [],
  isReconciled: false,
  differences: [],
  excludedOpeningRows: 0,
  creditSide: "NOT_ATTRIBUTABLE",
});

/** The caller must already have proved the supplier belongs to `orgId`. */
export async function readSupplierPaymentsReconciliation(
  ctx: Pick<QueryCtx, "db">,
  args: { orgId: Id<"organizations">; supplierId: Id<"suppliers"> },
): Promise<PaymentsReconciliation> {
  const { orgId, supplierId } = args;

  // 1. Postings still in flight: the GL is about to move, so a comparison now is not the truth.
  const [queued, failed] = await Promise.all(
    (["PENDING", "FAILED"] as const).map((status) =>
      ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", status))
        .take(OUTBOX_READ_LIMIT + 1),
    ),
  );
  if (queued.length > OUTBOX_READ_LIMIT || failed.length > OUTBOX_READ_LIMIT) return unavailable("OVER_LIMIT");
  if (await hasPendingAffectingPosting(ctx as QueryCtx, [...queued, ...failed], AP_AFFECTING_EVENT_TYPES)) {
    return unavailable("PENDING_POSTINGS");
  }

  // 2. Every payable of the supplier under one bound; past it nothing is summed (W14).
  const payables = (
    await Promise.all(
      PAYABLE_STATUSES.map((status) =>
        ctx.db
          .query("vehicleSupplierPayables")
          .withIndex("by_org_and_supplierId_and_status", (q) =>
            q.eq("orgId", orgId).eq("supplierId", supplierId).eq("status", status),
          )
          .take(STATEMENT_FAMILY_LIMIT + 1),
      ),
    )
  ).flat();
  if (payables.length > STATEMENT_FAMILY_LIMIT) return unavailable("OVER_LIMIT");

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
      const entries = await ctx.db
        .query("journalEntries")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "vehicleSupplierPayables").eq("sourceId", payable._id),
        )
        .take(budget + 1);
      if (entries.length > budget) return unavailable("OVER_LIMIT");
      entriesRead += entries.length;
      for (const entry of entries) {
        if (entry.status !== "POSTED") continue;
        const lines = await ctx.db
          .query("journalLines")
          .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id))
          .take(51);
        if (lines.length > 50) return unavailable("OVER_LIMIT");
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
