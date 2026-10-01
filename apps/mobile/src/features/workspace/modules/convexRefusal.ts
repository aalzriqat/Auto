/**
 * Whether a rejected Convex call is the server's own refusal (`ConvexError`)
 * rather than a transport failure. A `ConvexError` is thrown inside the mutation
 * and rolls it back, so nothing was committed; anything else (a plain "Server
 * Error", a dropped connection, a timeout) may have committed before the response
 * was lost. Mirrors `isConvexError` in the web app's `lib/errors.ts` (SCRUM-530).
 */
const CONVEX_ERROR_MARKER = Symbol.for("ConvexError");

export function isConvexRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Record<PropertyKey, unknown>;
  return candidate[CONVEX_ERROR_MARKER] === true || candidate.name === "ConvexError";
}
