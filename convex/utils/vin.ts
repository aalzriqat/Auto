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

/**
 * ⚠️ THERE IS DELIBERATELY NO CANONICAL-VIN FUNCTION HERE.
 *
 * Three separate attempts to decide, inside this import, whether a historically
 * stored VIN is the SAME PHYSICAL CAR as a differently-written incoming one each
 * introduced a new identity defect:
 *
 *   1. comparing a NORMALIZED copy of the stored value — a stored `abc123` read
 *      as an exact match for `ABC123`, so the collision went unreported and the
 *      exact index lookup then missed it and posted a second acquisition;
 *   2. stripping everything outside `[A-Z0-9]` — fullwidth and Arabic-Indic
 *      digits collapsed to an EMPTY key, which is dropped when the map is built,
 *      silently removing that stored car from the guard's view;
 *   3. NFKC normalization — fixed fullwidth, but COMPOSED `A`+U+0301 into `Á` so
 *      a stored decomposed VIN stopped matching its ASCII spelling (a case the
 *      previous version had protected), and EXPANDED `Ⅳ` into `IV`, colliding
 *      with a genuinely different car.
 *
 * Each fix created the next defect. That is not a run of bad patches — deciding
 * VIN equivalence needs an explicit domain definition of "the same VIN", a
 * stored indexed representation, and a migration for existing collisions.
 * **SCRUM-94 owns it in full.**
 *
 * The three approaches above are EVIDENCE INPUTS, not candidate
 * implementations. Do not resurrect them from the branch history.
 *
 * What remains here is narrow and provable: `hasNonCanonicalVinCharacters`
 * refuses anything that is not plain `[A-Z0-9]` on the path that POSTS, so among
 * accepted rows the exact `by_org_vin` match IS the identity rule — the same one
 * every writer already uses. A historically stored VIN written differently will
 * not be matched, and that residual is explicitly SCRUM-94's, not something to
 * partially solve here.
 */
