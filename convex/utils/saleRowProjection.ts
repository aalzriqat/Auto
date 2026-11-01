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
 *  - COST: a figure that reveals the vehicle's cost (SCRUM-886). Served only to a caller who may
 *    read vehicle cost (`view:cost_price` or a system owner), the same rule the vehicle readers
 *    apply to `sourceCost` and `purchasePrice`. A field belongs here also when a value DERIVED from
 *    served fields would disclose the cost: `financedNetRevenue` is `K - E - contra` on a consigned
 *    financed sale and K is public. `view:finance` alone does not grant it: no client
 *    screen reads these fields from a sale row, and the server-side finance readers read the stored
 *    row directly, so withholding them breaks no legitimate reader.
 */
import type { Doc } from "../_generated/dataModel";
import { mayReadFinanceEconomics } from "./financeApplicationProjection";
import { canReadVehicleCost } from "./vehicleCostVisibility";

export type SaleFieldVisibility = "PUBLIC_LEGACY" | "FINANCE" | "COST";

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
  // SCRUM-886 (OWASP API3:2023): COST-tier. The entitlement IS the vehicle's frozen supplier cost, and
  // the margin is the sale price minus it, so either one gives a view:sales caller the cost the
  // vehicle readers withhold. They reach only a caller who may read vehicle cost.
  consignedMarginMinor: "COST",
  consignedMarginCurrency: "PUBLIC_LEGACY",
  // SCRUM-886 round 2 (OWASP API3:2023). `commissionBase` is the finance company's approved amount and the
  // showroom's contribution: the same two figures the application projection already classifies FINANCE
  // (`contributionMinor`, financeApplicationProjection.ts). No client reads it.
  commissionBase: "FINANCE",
  // On a consigned financed sale completion freezes `minor = K - E - contra` beside `considerationMinor = K`
  // (saleCompletion.ts, frozenNetRevenueMinor), so `considerationMinor - minor` is the supplier cost E plus
  // the contra revenue, which is E exactly when there is no showroom contribution. K is public (`salePrice`
  // and `considerationMinor`), so serving this to a caller without cost permission discloses E by
  // subtraction. COST tier: the whole object is withheld, because `minor` and `considerationMinor` both
  // take part in the subtraction. No client reads it; server finance readers read the stored row.
  financedNetRevenue: "COST",
  consignedSupplierEntitlementMinor: "COST",
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

function fieldsInTier(wanted: SaleFieldVisibility): ReadonlySet<string> {
  return new Set(
    Object.entries(SALE_FIELD_VISIBILITY)
      .filter(([, tier]) => tier === wanted)
      .map(([field]) => field)
  );
}

const FINANCE_SALE_FIELDS = fieldsInTier("FINANCE");
const COST_SALE_FIELDS = fieldsInTier("COST");

/**
 * The sale row as this caller may read it. A caller who may read finance economics gets the
 * row untouched; any other caller gets it WITHOUT the FINANCE-tier keys (absent, never
 * zeroed: a zero would read as "no concession", which is a claim). Allowlist by tier, so a
 * field added to the table later defaults to a classification, never to "visible".
 */
export function projectSaleRow<T extends object>(sale: T, role: Doc<"roles">): T {
  const withheld: ReadonlySet<string>[] = [];
  if (!mayReadFinanceEconomics(role)) withheld.push(FINANCE_SALE_FIELDS);
  if (!canReadVehicleCost(role)) withheld.push(COST_SALE_FIELDS);
  if (withheld.length === 0) return sale;
  return Object.fromEntries(
    Object.entries(sale).filter(([field]) => !withheld.some((tier) => tier.has(field)))
  ) as T;
}
