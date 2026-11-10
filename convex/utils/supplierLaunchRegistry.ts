/** Shared, runtime-neutral P7 census vocabulary, also imported by Node's release guard. */
export const SUPPLIER_LAUNCH_TABLES = [
  "vehicleSupplierPayables", "vehicleSupplierReceivables", "supplierCostRecoveries",
  "supplierCostRecoveryReceipts", "openingPayablePayments", "vehicles", "vehicleOwnershipConversions",
  "financeApplications", "expenses", "vehicleEdits", "openingBalanceDrafts",
] as const;
export const SUPPLIER_LAUNCH_REASONS = [
  "MISSING_SUPPLIER_ID", "MISSING_PAYEE_ID", "MISSING_BEARER_ID", "MISSING_SOURCE",
] as const;
export type SupplierLaunchTable = typeof SUPPLIER_LAUNCH_TABLES[number];
export type SupplierLaunchReason = typeof SUPPLIER_LAUNCH_REASONS[number];
export type SupplierLaunchCounts = Record<SupplierLaunchReason, number>;
export const emptySupplierLaunchCounts = (): SupplierLaunchCounts =>
  Object.fromEntries(SUPPLIER_LAUNCH_REASONS.map(reason => [reason, 0])) as SupplierLaunchCounts;
/** 1,001 scan reads plus <=1,000 parent reads; <=1,001 index ranges. Bytes remain separately bounded. */
export const SUPPLIER_LAUNCH_PAGE_SIZE = 1000;
