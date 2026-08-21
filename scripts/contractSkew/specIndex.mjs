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

/** `api.vehicles.importBulk` -> `vehicles:importBulk` */
export function apiPathToIdentifier(segments) {
  if (segments.length < 2) return null;
  const fn = segments[segments.length - 1];
  const modulePath = segments.slice(0, -1).join("/");
  return `${modulePath}:${fn}`;
}
