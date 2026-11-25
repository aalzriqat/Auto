/**
 * Re-export of the approved-financing-amount rules (SCRUM-613), which live in
 * `packages/shared` beside the financing economics engine. Same shim reason as
 * `lib/financingEconomics.ts`: backend callers import `../lib/approvedFinancing`
 * and web callers `@/lib/approvedFinancing`.
 */
export {
  splitAroundApprovedFinancing,
  validateApprovedFinancingAmount,
  deriveApprovedFinancingFigures,
} from "@autoflow/shared/approvedFinancing";
export type {
  ApprovedFinancingSplit,
  ApprovedFinancingValidation,
  ApprovedFinancingFigures,
} from "@autoflow/shared/approvedFinancing";
