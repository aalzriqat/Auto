/**
 * Re-export of the canonical Murabaha engine, which now lives in
 * `packages/shared` so the mobile app can import the same code rather than
 * carry a port of it.
 *
 * This file stays because both the web app and the Convex backend import
 * `../lib/financing` / `@/lib/financing` from ~11 call sites, and because
 * Convex resolves relative paths out of `convex/` without needing the
 * workspace package to be resolvable by its own bundler.
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
