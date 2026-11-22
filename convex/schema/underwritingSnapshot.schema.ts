import { v } from "convex/values";

export const underwritingSnapshotValidator = v.object({
  salaryAtSubmission: v.optional(v.number()),
  employerAtSubmission: v.optional(v.string()),
  jobTitleAtSubmission: v.optional(v.string()),
  totalMonthlyDebtAtSubmission: v.optional(v.number()),
  proposedMonthlyInstallment: v.optional(v.number()),
  dbrAtSubmission: v.optional(v.number()),
  guarantorsAtSubmission: v.optional(v.array(v.object({
    guarantorId: v.id("guarantors"),
    firstName: v.string(),
    lastName: v.string(),
    nationalIdLastFour: v.string(),
    phone: v.string(),
    income: v.optional(v.number()),
    relationship: v.optional(v.string()),
  }))),
  customerStatusAtSubmission: v.optional(v.string()),
  // NOTE: a vehicleValuations row, which is a mutable per-(vehicle, company)
  // number with no provider, date or document — NOT an independent
  // appraisal. And ltvAtSubmission is financedAmount ÷ that number, a
  // derived ratio rather than the company's applied LTV rule. The
  // financeAppraisals table and appliedLtvPercent below are the real ones;
  // these two stay for the historical record and are never read as either.
  vehicleValuationAtSubmission: v.optional(v.number()),
  ltvAtSubmission: v.optional(v.number()),
});
