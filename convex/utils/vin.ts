/**
 * VIN admissibility, defined once for the server guard and the client preflight.
 *
 * Deliberately a shared module rather than a matching pair of literals. The
 * importer already carries one hand-synchronized copy of `isPlaceholderVin`
 * (convex/vehicles.ts and components/vehicles/VehicleImportDialog.tsx), and a
 * client preflight that silently disagrees with the server guard it mirrors is
 * exactly the drift that produces a button offering what the server refuses.
 * This lives in `convex/utils` because the client already imports from there
 * (`vehicleStatusGuards`), so there is a proven path and no new registration.
 */

/**
 * True when a VIN carries anything outside `[A-Z0-9]` once trimmed and
 * upper-cased — a dash, a space, a stray period.
 *
 * A real VIN is 17 characters drawn from an alphanumeric alphabet, so any such
 * character is a formatting artifact rather than part of the identifier. The
 * product nonetheless treats `1HGCM826-33A000001` and `1HGCM82633A000001` as two
 * different cars everywhere, because every VIN path normalizes with
 * `trim().toUpperCase()` and nothing more (SCRUM-94).
 *
 * That is pre-existing and codebase-wide, and fixing it properly means
 * canonicalizing every writer and reader together plus a backfill that must ship
 * in the same deploy — canonicalizing the write side alone would stop matching
 * the rows already stored and break the dedup that works today.
 *
 * What this predicate is for is narrower and provable: refuse these on the one
 * path that POSTS, so every VIN that path accepts already equals its own
 * canonical form. Exact `by_org_vin` matching is then canonical matching among
 * the accepted rows, and the import's retry safety — which IS that dedup — holds
 * without touching what "the same car" means anywhere else.
 *
 * The residual, which this does not close: a clean VIN imported here still will
 * not match a vehicle already stored with a punctuated one. That half is
 * SCRUM-94.
 */
export function hasNonCanonicalVinCharacters(vin: string | undefined): boolean {
  const normalized = (vin ?? "").trim().toUpperCase();
  if (!normalized) return false;
  return /[^A-Z0-9]/.test(normalized);
}
