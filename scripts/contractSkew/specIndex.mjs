/**
 * Locate functions inside a rendered `convex function-spec` document.
 *
 * ⚠️ This module USED TO flatten a validator into a set of field path strings,
 * and that flattening was the detector's model of a contract. Six defects over
 * three adversarial rounds came from the same root cause — a flat
 * `Map<pathString, metadata>` cannot express what a tree says — and the last of
 * them was two consumers of one flat record with only one of them updated. The
 * flattener is gone; `contractTree.mjs` is the model. What survives here is the
 * genuinely flat part of the problem: finding a function by identifier and
 * agreeing on how identifiers are spelled.
 *
 * The live spec's shape (verified against the production deployment, not
 * assumed) is:
 *
 *   { type: "object", value: { <name>: { fieldType: <validator>, optional: bool } } }
 *   { type: "array",  value: <element validator> }
 *   { type: "union",  value: [ <validator>, ... ] }
 *   { type: "literal" | "string" | "number" | "boolean" | "id" | "any" | ... }
 */

/**
 * Index a whole function-spec document by function identifier.
 *
 * @param {{ functions?: Array<any> } | Array<any>} spec
 * @returns {Map<string, any>} identifier -> spec entry
 */
export function indexSpec(spec) {
  const list = Array.isArray(spec) ? spec : Array.isArray(spec?.functions) ? spec.functions : [];
  const byId = new Map();
  for (const fn of list) {
    if (fn && typeof fn.identifier === "string") byId.set(fn.identifier, fn);
  }
  return byId;
}

/**
 * ⚠️ A SPEC THIS CONTROL CANNOT READ IS NOT EVIDENCE. The comparator treats a
 * missing or oddly-shaped `args` as "any", which would turn a malformed or
 * truncated document into a quiet pass. Anything whose argument contract is not
 * an object validator (or an explicit `any`) means the document is not the
 * `convex function-spec` shape this tool understands, and the run must say it
 * could not look rather than guess.
 *
 * @param {unknown} spec
 * @returns {string[]} one problem per offending function; empty means usable
 */
export function specProblems(spec) {
  const list = Array.isArray(spec)
    ? spec
    : spec && typeof spec === "object" && Array.isArray(/** @type {any} */ (spec).functions)
      ? /** @type {any} */ (spec).functions
      : null;
  if (!list) return ["the document has no `functions` array"];
  const problems = [];
  for (const fn of list) {
    // `convex function-spec` also lists every http.ts route as
    // `{functionType:"HttpAction", method, path}`. The pinned convex package
    // declares exactly these kinds (UdfType = Query | Mutation | Action |
    // HttpAction; its own `convex run` filters `functionType !== "HttpAction"`).
    // A route has no `identifier` and is not callable through the generated
    // `api`, so it carries no argument contract: accepted here when well-formed,
    // and absent from indexSpec().
    if (fn && typeof fn === "object" && fn.functionType === "HttpAction") {
      if (typeof fn.method !== "string" || typeof fn.path !== "string") {
        problems.push("an HttpAction entry has no string `method` and `path`");
      }
      continue;
    }
    if (!fn || typeof fn !== "object" || typeof fn.identifier !== "string") {
      problems.push("a function entry has no string `identifier`");
      continue;
    }
    const args = fn.args;
    if (args === undefined || args === null) continue;
    const type = typeof args === "object" ? args.type : undefined;
    if (type !== "object" && type !== "any") {
      problems.push(`${fn.identifier}: args is a ${JSON.stringify(type ?? typeof args)} validator, not an object`);
    }
  }
  return problems;
}

/**
 * Convex identifiers in a spec are file-based (`vehicles.js:importBulk`), while
 * client code references `api.vehicles.importBulk`. Normalize both to
 * `vehicles:importBulk` so the two sides can be compared at all.
 *
 * Nested modules keep their path: `api.utils.foo.bar` -> `utils/foo:bar`, which
 * matches the spec's `utils/foo.js:bar`.
 */
export function normalizeIdentifier(identifier) {
  return identifier.replace(/\.js:/, ":").replace(/\.ts:/, ":");
}
