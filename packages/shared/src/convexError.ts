/**
 * Convex stamps this on every `ConvexError`. Preferred over `instanceof`
 * because more than one copy of the `convex` package can be resolved at once
 * (pnpm keeps one per peer set), and `instanceof` fails across those copies.
 */
const CONVEX_ERROR_MARKER = Symbol.for("ConvexError");

/**
 * Whether a caught value is the server's own refusal (`ConvexError`) rather
 * than a transport failure. The distinction matters to a caller deciding what
 * it knows: a `ConvexError` is thrown inside the mutation and rolls it back,
 * so nothing was committed; anything else may have committed before the
 * response was lost.
 */
export function isConvexError(error: unknown): error is { data: unknown } {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Record<PropertyKey, unknown>;
  return candidate[CONVEX_ERROR_MARKER] === true || candidate.name === "ConvexError";
}