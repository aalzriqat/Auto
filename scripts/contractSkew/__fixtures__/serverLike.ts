/**
 * A backend-shaped module, imported by the client fixture so the TypeScript
 * program pulls it in — exactly how `convex/*.ts` ended up being scanned.
 *
 * It must NOT be scanned. `ctx.runMutation` is a Convex-to-Convex call: caller
 * and callee ship in the same `convex deploy`, so they are never separately
 * deployed and cannot skew by the mechanism this control detects. Counting them
 * inflated the coverage denominator by 28% and pointed readers at backend files
 * for client problems.
 */
declare const ctx: { runMutation: (fn: unknown, args: unknown) => Promise<unknown> };
declare const internal: Record<string, Record<string, unknown>>;

export const SERVER_MARKER = "server";

export async function serverSideCaller() {
  // If this call is attributed to a client call site, the scan escaped its scope.
  // A function name used NOWHERE else in the fixtures, so that a scope escape
  // kills only the scope test and does not contaminate the other pins.
  return ctx.runMutation(internal.serverOnly.reconcileLedger, {
    orgId: "o",
    serverOnlyField: true,
  });
}
