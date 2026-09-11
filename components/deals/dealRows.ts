import type { DealReason, DealRow, DealWaitingOn } from "./DealsListView";

/**
 * Turns the two list queries' rows into ONE deal row each — the mapping is
 * pure so it can be exercised on fixtures, and it is the only place a list
 * fact becomes a queue reason.
 *
 * Reasons are derived from served facts and nothing else. Where a fact is
 * not served (a stage-rail blocker, an aggregate), no reason is invented.
 */

/** The financed-deal row as `applications.list` serves it (the fields read here). */
export type ApplicationListRow = {
  _id: string;
  status: string;
  createdAt: number;
  updatedAt?: number;
  customerName: string;
  vehicleDesc: string;
  companyName: string;
  companyLabelKey: string | null;
  salespersonName: string | undefined;
  financedAmount: number;
  hasPendingDepositResolution: boolean;
  companyId?: string;
  disbursedAt?: number;
  supplierSettlementRoute?: string;
};

/** The sale row as `sales.list` serves it (the fields read here). */
export type SaleListRow = {
  _id: string;
  status: "PENDING" | "COMPLETED" | "CANCELLED";
  saleDate: number;
  salePrice: number;
  customerName: string;
  vehicleSummary: string;
  salespersonName: string;
  applicationId?: string;
};

const APPLICATION_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_DOCS: "PendingDocs",
  UNDER_REVIEW: "UnderReview",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

export function applicationReason(app: ApplicationListRow): { reason: DealReason | null; waitingOn: DealWaitingOn } {
  // A held deposit on a stopped deal is real cash with no owner — first,
  // whatever the status says.
  if (app.hasPendingDepositResolution) return { reason: "DEPOSIT_PENDING", waitingOn: "DEALERSHIP" };
  switch (app.status) {
    case "DRAFT":
    case "PENDING_DOCS":
      return { reason: "DOCS_PENDING", waitingOn: "DEALERSHIP" };
    case "UNDER_REVIEW":
      return { reason: "AWAITING_DECISION", waitingOn: "OTHERS" };
    case "APPROVED":
      return { reason: "READY_FOR_HANDOVER", waitingOn: "DEALERSHIP" };
    case "CLOSED":
      // The dealership receipt is expected only from a NAMED financier settling
      // through the dealership; on the direct route the company pays the
      // supplier and there is nothing here to wait for.
      if (app.companyId && !app.disbursedAt && app.supplierSettlementRoute !== "DIRECT_TO_SUPPLIER") {
        return { reason: "AWAITING_RECEIPT", waitingOn: "OTHERS" };
      }
      return { reason: null, waitingOn: "NONE" };
    default:
      return { reason: null, waitingOn: "NONE" };
  }
}

export function applicationRow(
  app: ApplicationListRow,
  orgId: string,
  t: (key: string) => string,
  formatAmount: (major: number) => string
): DealRow {
  const { reason, waitingOn } = applicationReason(app);
  const statusKey = app.hasPendingDepositResolution ? "DepositPending" : (APPLICATION_STATUS_LABEL[app.status] ?? app.status);
  return {
    key: `app_${app._id}`,
    href: `/${orgId}/applications/${app._id}/deal`,
    kind: "FINANCED",
    customerName: app.customerName,
    vehicleDesc: app.vehicleDesc,
    financierLabel: app.companyLabelKey ? t(app.companyLabelKey) : app.companyName,
    statusLabel: t(statusKey),
    statusTone:
      app.status === "CLOSED"
        ? "done"
        : app.status === "REJECTED" || app.status === "CANCELLED"
          ? "stopped"
          : app.status === "APPROVED" || app.status === "UNDER_REVIEW"
            ? "active"
            : "neutral",
    reason,
    waitingOn,
    since: app.updatedAt ?? app.createdAt,
    salespersonName: app.salespersonName ?? "",
    amountLabel: app.financedAmount > 0 ? formatAmount(app.financedAmount) : null,
  };
}

export function saleRow(
  sale: SaleListRow,
  orgId: string,
  t: (key: string) => string,
  formatAmount: (major: number) => string
): DealRow {
  return {
    key: `sale_${sale._id}`,
    href: `/${orgId}/sales/${sale._id}/deal`,
    kind: "CASH",
    customerName: sale.customerName,
    vehicleDesc: sale.vehicleSummary,
    financierLabel: null,
    statusLabel: t(
      sale.status === "PENDING" ? "SaleStatusPending" : sale.status === "COMPLETED" ? "SaleStatusCompleted" : "Cancelled"
    ),
    statusTone: sale.status === "COMPLETED" ? "done" : sale.status === "CANCELLED" ? "stopped" : "active",
    reason: sale.status === "PENDING" ? "CASH_PENDING" : null,
    waitingOn: sale.status === "PENDING" ? "DEALERSHIP" : "NONE",
    since: sale.saleDate,
    salespersonName: sale.salespersonName,
    amountLabel: formatAmount(sale.salePrice),
  };
}

/**
 * One entry per deal. A financed deal that has been finalized ALSO has a sale
 * row (`sales.applicationId` set); that sale is the same deal and is dropped
 * here so the application row — which the deal screen canonicalizes to the
 * sale URL once the sale exists — is its one entry.
 */
export function mergeDealRows(
  applications: ReadonlyArray<ApplicationListRow>,
  sales: ReadonlyArray<SaleListRow>,
  orgId: string,
  t: (key: string) => string,
  formatAmount: (major: number) => string
): DealRow[] {
  return [
    ...applications.map((app) => applicationRow(app, orgId, t, formatAmount)),
    ...sales.filter((sale) => !sale.applicationId).map((sale) => saleRow(sale, orgId, t, formatAmount)),
  ];
}
