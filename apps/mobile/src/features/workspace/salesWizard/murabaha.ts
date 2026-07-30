/**
 * The unified Murabaha calculation, re-exported from `@autoflow/shared`.
 *
 * This file used to be a hand-maintained *port* of `lib/financing.ts`, carrying
 * the comment "keep the math identical to the web wizard — any change must land
 * in both." That instruction is the failure mode, not a safeguard: nothing
 * enforced it, and a third copy in `moduleShared.tsx` had already drifted away
 * from both. The math now lives in one place that web, mobile and the Convex
 * backend all import.
 *
 * Kept as a module rather than deleted so the existing import path in
 * SalesWizardScreen keeps working.
 */
export {
  calculateUnifiedMurabaha,
  calculateMaximumAffordableVehiclePrice,
  calculateDBR,
} from "@autoflow/shared/financing";
export type {
  UnifiedMurabahaInput,
  UnifiedMurabahaResult,
} from "@autoflow/shared/financing";
