/**
 * Which `sales` fields a caller may read, by tier (SCRUM-766 PR-C; ACC-10).
 *
 * Several queries return the sale row by spreading it (`...sale`) to callers who only hold
 * `view:sales`. A money PERMISSION on a mutation is authority, never secrecy: the sale row
 * is a read path, and a new FINANCE-tier figure added to it would reach every such caller
 * unless the read path withholds it. This table is TOTAL over the schema's sale fields
 * (a new field without a classification is a type error and fails the census test), so
 * adding a money field forces the choice to be made.
 *
 * Tiers:
 *  - PUBLIC_LEGACY: served to every `view:sales` caller as before this table existed. These
 *    were already exposed before SCRUM-766 PR-C; classifying them here records the fact, it
 *    does not endorse it. Narrowing them is a separate, owner-visible change (pending owner
 *    ruling Q8: a view:sales caller can still DERIVE the concession as the vehicle's cost
 *    minus the sale's effective entitlement).
 *  - FINANCE: a figure of the deal's economics. Served only to a caller who may read finance
 *    economics (`view:finance` or a system owner), the same rule the application projection
 *    applies to `supplierGapShareMinor`.
 */
import type { Doc } from "../_generated/dataModel";
import { mayReadFinanceEconomics } from "./financeApplicationProjection";

export type SaleFieldVisibility = "PUBLIC_LEGACY" | "FINANCE";

export const SALE_FIELD_VISIBILITY: Record<keyof Doc<"sales">, SaleFieldVisibility> = {
  _id: "PUBLIC_LEGACY",
  _creationTime: "PUBLIC_LEGACY",
  orgId: "PUBLIC_LEGACY",
  branchId: "PUBLIC_LEGACY",
  vehicleId: "PUBLIC_LEGACY",
  customerId: "PUBLIC_LEGACY",
  salespersonId: "PUBLIC_LEGACY",
  salePrice: "PUBLIC_LEGACY",
  saleDate: "PUBLIC_LEGACY",
  status: "PUBLIC_LEGACY",
  idempotencyKey: "PUBLIC_LEGACY",
  taxRate: "PUBLIC_LEGACY",
  taxAmount: "PUBLIC_LEGACY",
  dealerFees: "PUBLIC_LEGACY",
  downPayment: "PUBLIC_LEGACY",
  tradeInVehicleId: "PUBLIC_LEGACY",
  tradeInValue: "PUBLIC_LEGACY",
  financingType: "PUBLIC_LEGACY",
  loanAmount: "PUBLIC_LEGACY",
  apr: "PUBLIC_LEGACY",
  termMonths: "PUBLIC_LEGACY",
  warrantySold: "PUBLIC_LEGACY",
  gapSold: "PUBLIC_LEGACY",
  warrantyCost: "PUBLIC_LEGACY",
  warrantyTermMonths: "PUBLIC_LEGACY",
  gapCost: "PUBLIC_LEGACY",
  gapTermMonths: "PUBLIC_LEGACY",
  applicationId: "PUBLIC_LEGACY",
  quoteId: "PUBLIC_LEGACY",
  leadId: "PUBLIC_LEGACY",
  supplierSettlementRoute: "PUBLIC_LEGACY",
  consignedMarginMinor: "PUBLIC_LEGACY",
  consignedMarginCurrency: "PUBLIC_LEGACY",
  commissionBase: "PUBLIC_LEGACY",
  financedNetRevenue: "PUBLIC_LEGACY",
  consignedSupplierEntitlementMinor: "PUBLIC_LEGACY",
  // New in SCRUM-766 PR-C. Never served to a caller without finance view.
  consignedSupplierConcessionMinor: "FINANCE",
  consignedSupplierGrossReceiptMinor: "PUBLIC_LEGACY",
  canonicalReceivableDocumentId: "PUBLIC_LEGACY",
  glPostingRequired: "PUBLIC_LEGACY",
  commissionAmount: "PUBLIC_LEGACY",
  commissionAdjustmentSeq: "PUBLIC_LEGACY",
  commissionPaidAt: "PUBLIC_LEGACY",
  commissionPaidBy: "PUBLIC_LEGACY",
  commissionPaymentMethod: "PUBLIC_LEGACY",
  commissionBankAccountId: "PUBLIC_LEGACY",
  commissionPaymentIdempotencyKey: "PUBLIC_LEGACY",
  isDeleted: "PUBLIC_LEGACY",
  deletedAt: "PUBLIC_LEGACY",
  deletedBy: "PUBLIC_LEGACY",
};

const FINANCE_SALE_FIELDS: ReadonlySet<string> = new Set(
  Object.entries(SALE_FIELD_VISIBILITY)
    .filter(([, tier]) => tier === "FINANCE")
    .map(([field]) => field)
);

/**
 * The sale row as this caller may read it. A caller who may read finance economics gets the
 * row untouched; any other caller gets it WITHOUT the FINANCE-tier keys (absent, never
 * zeroed: a zero would read as "no concession", which is a claim). Allowlist by tier, so a
 * field added to the table later defaults to a classification, never to "visible".
 */
export function projectSaleRow<T extends object>(sale: T, role: Doc<"roles">): T {
  if (mayReadFinanceEconomics(role)) return sale;
  return Object.fromEntries(
    Object.entries(sale).filter(([field]) => !FINANCE_SALE_FIELDS.has(field))
  ) as T;
}
