/**
 * Re-export of the dealer-side financing economics engine, which lives in
 * `packages/shared` so web, mobile, the Convex backend and the tests all run
 * the same formulas.
 *
 * Same reason this shim exists as for `lib/financing.ts`: Convex resolves
 * relative paths out of `convex/` without needing the workspace package to be
 * resolvable by its own bundler, so backend callers import
 * `../lib/financingEconomics` and web callers `@/lib/financingEconomics`.
 */
export {
  FinancingEconomicsError,
  computeFundingComposition,
  computeSubmittedQuotation,
  computeAppraisalGap,
  validateGapShares,
  classifyGapResolution,
  computeExpectedRemittance,
  computeDealerProceeds,
  evaluateQuotationException,
  reconcileEmployeeCustody,
  reconcileSettlement,
} from "@autoflow/shared/financingEconomics";
export type {
  FundingCompositionInput,
  FundingComposition,
  SubmittedQuotationInput,
  SubmittedQuotationSuggestion,
  AppraisalGapInput,
  AppraisalGap,
  GapShareSettlement,
  GapShareViolation,
  GapResolutionOutcome,
  DealerContributionSettlement,
  CustomerContributionSettlement,
  ExpectedRemittanceInput,
  ExpectedRemittance,
  DealerProceedsInput,
  DealerProceeds,
  QuotationExceptionInput,
  QuotationExceptionEvaluation,
  CustodyReconciliationInput,
  CustodyReconciliation,
  SettlementReconciliationInput,
  SettlementReconciliation,
} from "@autoflow/shared/financingEconomics";
