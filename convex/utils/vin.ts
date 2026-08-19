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
 * The canonical form of a VIN: uppercase, with every character outside
 * `[A-Z0-9]` removed.
 *
 * This is NOT a replacement for `hasNonCanonicalVinCharacters`, and it is
 * deliberately not applied to what gets STORED. Canonicalizing the write side
 * alone would stop matching the rows already stored and break the dedup that
 * works today — that whole-codebase change plus its backfill is SCRUM-94.
 *
 * What this is for is narrower: letting a PURCHASE import ask "is there already
 * a vehicle in this org that is the same car under a differently-spelled VIN?"
 * so it can REFUSE rather than insert a second document and capitalize the same
 * physical car twice. Refusal needs no migration; rewriting stored VINs does.
 */
export function canonicalVin(vin: string | undefined): string {
  return (
    (vin ?? "")
      // NFKC first, so a fullwidth `ＡＢＣ１２３` becomes the ASCII `ABC123` it
      // is a presentation form OF, and therefore lands on the same canonical
      // key as the car already stored under the plain spelling.
      .normalize("NFKC")
      .trim()
      .toUpperCase()
      // Strip FORMATTING only — punctuation, separators, whitespace.
      //
      // ⚠️ Deliberately NOT `[^A-Z0-9]`. That version deleted every character
      // outside ASCII, so a VIN written in Arabic-Indic digits (`١٢٣`) — which
      // NFKC does NOT map to ASCII — collapsed to the EMPTY string. An empty
      // canonical key is skipped when the collision map is built, so the stored
      // car became invisible to the guard and a later import inserted a second
      // vehicle and posted a second acquisition for it.
      //
      // Keeping letters and numbers of ANY script means such a VIN gets a
      // non-empty key of its own. It does not collide with `123`, which is
      // correct — they are not proven to be the same car — and, critically, it
      // no longer vanishes. Admissibility is a separate question, answered by
      // `hasNonCanonicalVinCharacters`, which refuses anything outside plain
      // `[A-Z0-9]` on the path that posts.
      .replace(/[^\p{L}\p{N}]/gu, "")
  );
}
