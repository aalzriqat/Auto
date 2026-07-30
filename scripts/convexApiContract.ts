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
 * NOTE on the extraction — it has been wrong twice, in the same way:
 *   1. `/makeFunctionReference<[\s\S]*?>\(/` terminated at the first `>` and
 *      skipped every declaration with a nested generic.
 *   2. Anchoring on `\("…"\)` skipped every declaration whose argument carries
 *      a Prettier trailing comma — 70 of 193 — and because each of those then
 *      matched the NEXT declaration's string, the total stayed at 193 and the
 *      count pin never fired. Real coverage was 123/193 while the test asserted
 *      full coverage.
 * Both times the count looked right. That is why `findDuplicateReferences` now
 * backs the count: this file never declares one backend function twice, so a
 * duplicate is proof the extractor mis-parsed something.
 */
import fs from "node:fs";
import path from "node:path";

export interface BrokenReference {
  /** The declared "module:function" string. */
  reference: string;
  reason: "malformed-reference" | "module-missing" | "export-missing" | "not-client-reachable";
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
    // The `,?` is load-bearing — see the note at the top of this file.
    const arg = rest.match(/\(\s*"([^"]+)"\s*,?\s*\)/);
    if (arg) out.push(arg[1]);
    from = at + marker.length;
  }
  return out;
}

/**
 * Declarations that did not yield their own reference.
 *
 * A count cannot detect the extraction drifting, because the failure mode is
 * duplication rather than loss: a skipped declaration picks up its neighbour's
 * string, so the length stays exactly right. `convexApi.ts` never declares the
 * same backend function twice, so any duplicate means a mis-parse.
 */
export function findDuplicateReferences(references: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const reference of references) {
    if (seen.has(reference)) duplicates.add(reference);
    seen.add(reference);
  }
  return [...duplicates];
}

/**
 * A well-formed reference: `path/to/module:functionName`, both segments made of
 * identifier-safe characters only.
 *
 * Validating the shape is load-bearing, not defensive tidiness. `split(":")`
 * discards extra segments, so `quotes:saveQuote:stale` would be checked as
 * `quotes:saveQuote` and pass while the actual mobile binding is broken. And an
 * unvalidated function segment goes straight into a `RegExp`, so `quotes:.+`
 * would match some unrelated export and pass.
 */
const WELL_FORMED_REFERENCE = /^[A-Za-z0-9_/]+:[A-Za-z0-9_]+$/;

/** Resolves one reference against the backend source tree. */
export function checkReference(convexRoot: string, reference: string): BrokenReference | null {
  if (!WELL_FORMED_REFERENCE.test(reference)) {
    return { reference, reason: "malformed-reference", expectedModule: "—" };
  }

  const [modulePath, functionName] = reference.split(":");
  const file = path.join(convexRoot, `${modulePath}.ts`);
  const expectedModule = `convex/${modulePath}.ts`;

  if (!fs.existsSync(file)) {
    return { reference, reason: "module-missing", expectedModule };
  }

  // Block comments are stripped first: `/^export const x\b/m` matches happily
  // inside `/* ... */`, so commenting a function out left the gate green while
  // the mobile binding was dead. Line comments never match the anchor.
  const source = stripBlockComments(fs.readFileSync(file, "utf8"));

  // Convex only routes top-level `export const` bindings. `functionName` is
  // known identifier-safe by the check above, so it carries no metacharacters.
  const anchor = new RegExp(String.raw`^export const ${functionName}\b`, "m").exec(source);
  if (!anchor) {
    return { reference, reason: "export-missing", expectedModule };
  }

  // Slice to the next top-level export by index rather than by a regex
  // lookahead. JS has no `\Z`, so a lookahead written that way silently fails to
  // match the LAST export in a file and reports it missing — which is exactly
  // what happened to the two functions this whole check was built for.
  const bodyStart = anchor.index + anchor[0].length;
  const nextExport = source.indexOf("\nexport const ", bodyStart);
  const body = source.slice(bodyStart, nextExport === -1 ? undefined : nextExport);

  // `internal*` functions exist and are exported but are NOT reachable from a
  // client, so a mobile reference to one type-checks, passes an existence check,
  // and then fails at runtime on a device — the exact class this file exists to
  // catch.
  if (/^\s*=\s*internal(Query|Mutation|Action)\s*\(/.test(body)) {
    return { reference, reason: "not-client-reachable", expectedModule };
  }

  return null;
}

/** Removes block-comment spans so a commented-out export cannot satisfy the check. */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

export function findBrokenReferences(contractSource: string, convexRoot: string): BrokenReference[] {
  return referencePaths(contractSource)
    .map((reference) => checkReference(convexRoot, reference))
    .filter((r): r is BrokenReference => r !== null);
}
