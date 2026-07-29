/**
 * Verifies that every backend function the mobile app declares actually exists.
 *
 * `apps/mobile/src/convexApi.ts` is a hand-maintained contract: it re-declares
 * each Convex function as `makeFunctionReference<...>("module:function")`
 * because the mobile package cannot import `convex/_generated/api`. Nothing
 * checked those strings against the backend, and `apps/**` is excluded from the
 * root lint, typecheck, and test runs — so a reference to a function that does
 * not exist compiled, shipped, and failed only at runtime, on a real user's
 * phone.
 *
 * That is not hypothetical: the mobile Offers tab called
 * `marketplaceTradeIns.acceptOfferByPublicId` / `declineOfferByPublicId`, and
 * neither existed. Buyer trade-in accept and decline were dead in production.
 *
 * NOTE on the extraction: an earlier version of this check used
 * `/makeFunctionReference<[\s\S]*?>\(/` and silently skipped every declaration
 * whose generic arguments contained a nested `>` — 70 of 193 here, since most
 * are written multi-line with nested generics. It reported clean coverage over
 * a third of the file. `referencePaths` below anchors on the call's string
 * argument instead, and `expectedReferenceCount` pins the total so a future
 * regex change cannot quietly shrink the surface again.
 */
import fs from "node:fs";
import path from "node:path";

export interface BrokenReference {
  /** The declared "module:function" string. */
  reference: string;
  reason: "module-missing" | "export-missing";
  /** Path the module was expected at, relative to the repo root. */
  expectedModule: string;
}

/**
 * Every `"module:function"` string passed to `makeFunctionReference`.
 *
 * Anchors on `makeFunctionReference<` and then takes the first parenthesised
 * string literal after it, so nested generics and multi-line formatting are
 * both handled.
 */
export function referencePaths(source: string): string[] {
  const out: string[] = [];
  const marker = "makeFunctionReference<";
  let from = 0;
  for (;;) {
    const at = source.indexOf(marker, from);
    if (at === -1) break;
    const rest = source.slice(at + marker.length);
    const arg = rest.match(/\(\s*"([^"]+)"\s*\)/);
    if (arg) out.push(arg[1]);
    from = at + marker.length;
  }
  return out;
}

/** Resolves one reference against the backend source tree. */
export function checkReference(convexRoot: string, reference: string): BrokenReference | null {
  const [modulePath, functionName] = reference.split(":");
  const file = path.join(convexRoot, `${modulePath}.ts`);
  const expectedModule = `convex/${modulePath}.ts`;

  if (!fs.existsSync(file)) {
    return { reference, reason: "module-missing", expectedModule };
  }

  const source = fs.readFileSync(file, "utf8");
  // Convex only routes top-level `export const` bindings.
  const exported = new RegExp(`^export const ${functionName}\\b`, "m").test(source);
  return exported ? null : { reference, reason: "export-missing", expectedModule };
}

export function findBrokenReferences(contractSource: string, convexRoot: string): BrokenReference[] {
  return referencePaths(contractSource)
    .map((reference) => checkReference(convexRoot, reference))
    .filter((r): r is BrokenReference => r !== null);
}
