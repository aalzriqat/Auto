/**
 * Import limits shared by the Convex mutation and the client that calls it.
 *
 * Deliberately a shared module rather than a matching pair of literals. The
 * client already imports from `convex/utils` (see `vin.ts`), so the dependency
 * direction is proven and adds no new registration — and two hand-synced numbers
 * are exactly the drift that produces a button offering what the server refuses.
 */

/**
 * The maximum number of rows in a PURCHASE import.
 *
 * This is a limit on the whole FILE, not a chunk size. A PURCHASE import is ONE
 * Convex mutation, and a mutation is atomic, so the import records every car and
 * every journal entry or records nothing.
 *
 * That is architectural, not a conservative number. Chunking a money-posting
 * import puts whole-FILE invariants inside per-CHUNK transactions, and two
 * defect classes follow from the mismatch — both measured on this branch before
 * the rule was adopted: a duplicate split across chunks escapes a per-chunk
 * duplicate check entirely, and a bound evaluated per chunk can be crossed
 * mid-file, committing an import into a state where its own retry is refused.
 *
 * OPENING_STOCK is unaffected and still chunks: it posts nothing, so it has no
 * money-shaped invariant to preserve across a boundary.
 */
export const PURCHASE_IMPORT_MAX_ROWS = 25;
