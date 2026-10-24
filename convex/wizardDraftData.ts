import { v } from "convex/values";

/** One contract for autosave arguments and persisted resumable state. */
export const wizardDraftDataValidator = v.object({
  vehicleId: v.string(),
  vehiclePrice: v.number(),
  desiredProfit: v.number(),
  downPayment: v.number(),
  termMonths: v.number(),
  selectedCompanyId: v.optional(v.string()),
  manualProfitRate: v.optional(v.number()),
  manualInsuranceRate: v.optional(v.number()),
  manualExecutionCommission: v.optional(v.number()),
  manualExecutionFees: v.optional(v.number()),
  manualIncludesCommissionInDebt: v.optional(v.boolean()),
  recipientName: v.optional(v.string()),
  customerStatuses: v.optional(v.array(v.string())),
  leadId: v.optional(v.string()),
  vehicleItems: v.optional(v.array(v.object({ vehicleId: v.string(), unitPrice: v.number() }))),
});
