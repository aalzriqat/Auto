import type { Doc } from "../_generated/dataModel";
import type { SettledRow } from "./supplierObligationDue";
import { toMinorUnits } from "./money";
import { settlementView } from "./supplierSettlement";

export type SupplierObligation = Doc<"vehicleSupplierPayables"> | Doc<"vehicleSupplierReceivables"> | Doc<"supplierCostRecoveries">;
export type WithSupplierDocument<T> = T & { document: SupplierObligation };

export type DatedSettledRow = { createdAt: number; row: SettledRow };

export function settledPayableRows(docs: Doc<"vehicleSupplierPayables">[]): SettledRow[] {
  const rows: SettledRow[] = [];
  for (const row of docs) {
    // The same view every other reader uses: a PAID row with no recorded payments was paid in full before `amountPaid` existed.
    const settledMinor = toMinorUnits(settlementView(row).amountPaid, row.currency);
    if (settledMinor <= 0) continue;
    const dueMinor = toMinorUnits(row.amountDue, row.currency);
    rows.push({
      kind: "PAYABLE",
      id: row._id,
      document: row,
      currency: row.currency,
      status: row.status,
      dueMinor,
      settledMinor,
      // Payments are the whole of what settles a payable, so here cash against the obligation is the completion.
      settlement: settledMinor >= dueMinor ? "COMPLETE" : "PARTIAL",
      lastChangedAt: row.updatedAt,
      basis: row.status === "PAID" && (row.amountPaid ?? 0) === 0 ? "INFERRED_FROM_PAID_STATUS" : "RECORDED",
    });
  }
  return rows;
}

export function settledRecoveryRows(docs: Doc<"supplierCostRecoveries">[]): DatedSettledRow[] {
  const rows: DatedSettledRow[] = [];
  for (const row of docs) {
    if (row.amountRecoveredMinor <= 0) continue;
    rows.push({
      createdAt: row._creationTime,
      row: {
        kind: "RECOVERY",
        id: row._id,
        document: row,
        currency: row.currency,
        status: row.status,
        dueMinor: row.amountDueMinor,
        settledMinor: row.amountRecoveredMinor,
        settlement: row.amountRecoveredMinor >= row.amountDueMinor ? "COMPLETE" : "PARTIAL",
        lastChangedAt: row.updatedAt,
        basis: "RECORDED",
      },
    });
  }
  return rows;
}

export function settledClaimRow(claim: Doc<"vehicleSupplierReceivables">, receipts: { minor: number; reversed: boolean }): DatedSettledRow {
  return {
    createdAt: claim._creationTime,
    row: {
      kind: "RECEIVABLE",
      id: claim._id,
      document: claim,
      currency: claim.currency,
      status: claim.status,
      dueMinor: toMinorUnits(claim.amountDue, claim.currency),
      settledMinor: receipts.minor,
      // The claim's own record decides (`recordReceipt` sets PAID when deposit + receipts reach the claim), not the cash figure,
      // which leaves the deposit out. A reversed receipt means that record overstates what was collected, so it is not "in full".
      settlement: claim.status === "PAID" && !receipts.reversed ? "COMPLETE" : "PARTIAL",
      lastChangedAt: claim.updatedAt,
      basis: "RECORDED",
    },
  };
}
