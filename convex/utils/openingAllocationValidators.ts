import { v } from "convex/values";

// Schema and both public preparation routes share this exact bounded shape.
// Business limits, ownership and reconciliation remain in the backend writer.
export const openingAllocationValidator = v.union(v.object({
  kind: v.literal("CUSTOMER_RECEIVABLE"),
  rowKey: v.string(),
  accountId: v.id("chartOfAccounts"),
  customerId: v.id("customers"),
  amountMinor: v.number(),
  title: v.string(),
  dueDate: v.number(),
}), v.object({
  kind: v.literal("VEHICLE_INVENTORY"),
  rowKey: v.string(),
  accountId: v.id("chartOfAccounts"),
  vehicleId: v.id("vehicles"),
  amountMinor: v.number(),
}), v.object({
  kind: v.literal("EMPLOYEE_ADVANCE"),
  rowKey: v.string(),
  accountId: v.id("chartOfAccounts"),
  userId: v.id("users"),
  amountMinor: v.number(),
  note: v.optional(v.string()),
}), v.object({
  kind: v.literal("PARTNER_CAPITAL"),
  rowKey: v.string(),
  accountId: v.id("chartOfAccounts"),
  partnerId: v.id("partnerEquity"),
  amountMinor: v.number(),
}), v.object({
  kind: v.literal("PREPAID_EXPENSE"),
  rowKey: v.string(),
  accountId: v.id("chartOfAccounts"),
  amountMinor: v.number(),
  title: v.string(),
  expenseSystemKey: v.string(),
  startYearMonth: v.string(),
  termMonths: v.number(),
  attestedUnexpiredBenefit: v.literal(true),
}),
v.object({kind:v.literal("SUPPLIER_RECOVERABLE"),rowKey:v.string(),accountId:v.id("chartOfAccounts"),amountMinor:v.number(),counterpartyName:v.string(),title:v.string(),purpose:v.union(v.literal("CLAIM"),v.literal("REFUNDABLE_DEPOSIT"))}),
v.object({kind:v.literal("SUPPLIER_PAYABLE"),rowKey:v.string(),accountId:v.id("chartOfAccounts"),amountMinor:v.number(),counterpartyName:v.string(),title:v.string()}),
v.object({kind:v.literal("OTHER_PAYABLE"),rowKey:v.string(),accountId:v.id("chartOfAccounts"),amountMinor:v.number(),counterpartyName:v.string(),title:v.string()}),
v.object({kind:v.literal("EMPLOYEE_COMMISSION"),rowKey:v.string(),accountId:v.id("chartOfAccounts"),amountMinor:v.number(),userId:v.id("users")}),
v.object({kind:v.literal("UNALLOCATED_LIABILITY"),rowKey:v.string(),accountId:v.id("chartOfAccounts"),amountMinor:v.number(),purpose:v.union(v.literal("CUSTOMER_DEPOSIT"),v.literal("UNIDENTIFIED_RECEIPT")),title:v.string()}),
v.object({kind:v.literal("CUSTOMER_DEPOSIT"),rowKey:v.string(),accountId:v.id("chartOfAccounts"),amountMinor:v.number(),customerId:v.id("customers"),depositKind:v.union(v.literal("SECURITY"),v.literal("RESERVATION")),vehicleId:v.optional(v.id("vehicles")),title:v.string()}));

export const openingAllocationResultValidator = v.union(v.object({
  kind: v.literal("CUSTOMER_RECEIVABLE"),
  rowKey: v.string(),
  receivableId: v.id("receivables"),
  canonicalReceivableDocumentId: v.id("receivableDocuments"),
}), v.object({
  kind: v.literal("VEHICLE_INVENTORY"),
  rowKey: v.string(),
  vehicleId: v.id("vehicles"),
}), v.object({
  kind: v.literal("EMPLOYEE_ADVANCE"),
  rowKey: v.string(),
  advanceId: v.id("employeeAdvances"),
}), v.object({
  kind: v.literal("PARTNER_CAPITAL"),
  rowKey: v.string(),
  partnerId: v.id("partnerEquity"),
}), v.object({
  kind: v.literal("PREPAID_EXPENSE"),
  rowKey: v.string(),
  scheduleId: v.id("prepaidExpenseSchedules"),
}),
v.object({kind:v.literal("SUPPLIER_RECOVERABLE"),rowKey:v.string(),recoveryId:v.id("supplierCostRecoveries")}),
v.object({kind:v.literal("SUPPLIER_PAYABLE"),rowKey:v.string(),payableId:v.id("vehicleSupplierPayables")}),
v.object({kind:v.literal("OTHER_PAYABLE"),rowKey:v.string(),payableId:v.id("vehicleSupplierPayables")}),
v.object({kind:v.literal("EMPLOYEE_COMMISSION"),rowKey:v.string(),openingCommissionLiabilityId:v.id("openingCommissionLiabilities")}),
v.object({kind:v.literal("UNALLOCATED_LIABILITY"),rowKey:v.string(),purpose:v.union(v.literal("CUSTOMER_DEPOSIT"),v.literal("UNIDENTIFIED_RECEIPT"))}),
v.object({kind:v.literal("CUSTOMER_DEPOSIT"),rowKey:v.string(),depositId:v.id("deposits")}));
