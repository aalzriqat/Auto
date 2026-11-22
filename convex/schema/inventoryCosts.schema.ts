import { defineTable } from "convex/server";
import { v } from "convex/values";
import { paymentMethodValidator } from "../utils/paymentMethods";

export const inventoryCostsTables = {
  vehicleLandedCosts: defineTable({
    vehicleId: v.id("vehicles"),
    orgId: v.id("organizations"),
    items: v.array(v.object({
      label: v.string(),
      amount: v.number(),
      // Which account this specific line was paid from — persisted per item
      // (not one picker for the whole edit) so a later reduction/removal
      // reverses against the account it actually came from, not whatever's
      // selected on that later call. Optional/backward compatible: rows
      // written before this field existed have none, treated as CASH (the
      // old normalizePaymentMethod default) wherever it's read.
      paymentMethod: v.optional(paymentMethodValidator),
      bankAccountId: v.optional(v.id("bankAccounts")),
    })),
    total: v.number(),
    updatedAt: v.number(),
    updatedBy: v.id("users"),
  }).index("by_org_vehicle", ["orgId", "vehicleId"]),

  // Audit trail for vehicles.correctAcquisitionCost — preserves the original
  // value whenever a vehicle's already-posted acquisition cost is corrected,
  // since the GL adjustment alone (VEHICLE_ACQUISITION_COST_CORRECTED) doesn't
  // by itself explain why purchasePrice changed after the fact.
  vehicleCostCorrections: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    bankAccountId: v.optional(v.id("bankAccounts")),
    previousCost: v.number(),
    newCost: v.number(),
    reason: v.string(),
    // Drives the GL counter-account (see ruleVehicleAcquisitionCostCorrected)
    // — optional/backward compatible for corrections that predate this field.
    correctionType: v.optional(v.union(
      v.literal("PRIOR_PERIOD_RESTATEMENT"),
      v.literal("SUPPLIER_INVOICE_ERROR"),
      v.literal("CASH_REFUND"),
      v.literal("VENDOR_CREDIT"),
    )),
    // Set only when the correction rewrote a supplier payable (SUPPLIER_INVOICE_ERROR /
    // VENDOR_CREDIT): which row, and the amountDue it held before. SCRUM-650.
    payableId: v.optional(v.id("vehicleSupplierPayables")),
    previousAmountDue: v.optional(v.number()),
    correctedBy: v.id("users"),
    createdAt: v.number(),
  }).index("by_org_vehicle", ["orgId", "vehicleId"]),
};
