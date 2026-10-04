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
import { validatorProblems } from "./contractTree.mjs";

/**
 * Index a whole function-spec document by function identifier.
 *
 * @param {{ functions?: Array<any> } | Array<any>} spec
 * @returns {Map<string, any>} identifier -> spec entry
 */
export function indexSpec(spec) {
  // ⚠️ ONLY WHAT A CLIENT CAN CALL IS INDEXED (CS2-2). An `internal` function is
  // unreachable through the public `api`; an HttpAction is keyed by path and
  // method, never by identifier. Indexing either made a client call to an
  // internal function look like a call to a live public one.
  return indexCallable(spec, (fn) => fn.visibility?.kind === "public");
}

/** The function types a generated `api.*` reference can name. */
export const CALLABLE_TYPES = new Set(["Query", "Mutation", "Action"]);

/**
 * identifier -> entry for every callable-typed entry that has a string
 * identifier and passes `keep` (the only thing the two public indexes differ in).
 *
 * @param {{ functions?: Array<any> } | Array<any>} spec
 * @param {(fn: any) => boolean} keep
 * @returns {Map<string, any>}
 */
function indexCallable(spec, keep) {
  const list = Array.isArray(spec) ? spec : Array.isArray(spec?.functions) ? spec.functions : [];
  const byId = new Map();
  for (const fn of list) {
    if (fn && typeof fn.identifier === "string" && CALLABLE_TYPES.has(fn.functionType) && keep(fn)) {
      byId.set(fn.identifier, fn);
    }
  }
  return byId;
}

/**
 * Every entry that carries an identifier regardless of visibility. For the
 * comparator only: it needs to tell "the backend has no such function" from
 * "the backend has it but it is internal" — two different breaks.
 *
 * @param {{ functions?: Array<any> } | Array<any>} spec
 * @returns {Map<string, any>}
 */
export function indexAllNamed(spec) {
  return indexCallable(spec, () => true);
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
  /** @type {Set<string>} */
  const seenIdentifiers = new Set();
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
      // A route carries no identifier and no argument validator. An entry that
      // claims to be both a route and a callable function is a document this
      // tool does not understand — and one the comparator would otherwise
      // silently ignore while a function by that name goes unchecked.
      if (fn.identifier !== undefined || fn.args !== undefined) {
        problems.push(
          `an HttpAction entry (${fn.method} ${fn.path}) carries ${fn.identifier !== undefined ? "an `identifier`" : "`args`"}; a route is neither callable nor validated`,
        );
      }
      continue;
    }
    if (!fn || typeof fn !== "object" || typeof fn.identifier !== "string") {
      problems.push("a function entry has no string `identifier`");
      continue;
    }
    if (typeof fn.visibility?.kind !== "string") {
      problems.push(`${fn.identifier}: the entry has no \`visibility.kind\`, so public and internal cannot be told apart`);
    } else if (!VISIBILITY_KINDS.has(fn.visibility.kind)) {
      // Values, not just types: only what Convex emits (modules.d.ts: "public" |
      // "internal") is understood. Anything else would be indexed as neither
      // public nor callable and vanish without a word.
      problems.push(`${fn.identifier}: unknown \`visibility.kind\` ${JSON.stringify(fn.visibility.kind)}`);
    }
    if (!FUNCTION_TYPES.has(fn.functionType)) {
      problems.push(`${fn.identifier}: unknown \`functionType\` ${JSON.stringify(fn.functionType)}`);
    }
    const normalizedId = normalizeIdentifier(fn.identifier);
    if (seenIdentifiers.has(normalizedId)) {
      problems.push(`${normalizedId}: appears more than once in the document`);
    }
    seenIdentifiers.add(normalizedId);

    // ⚠️ SCRUM-178 v2 batch 3 (SPEC-1, D-27). `if (args === undefined || args ===
    // null) continue;` USED TO SIT HERE, so a function whose `args` key was
    // MISSING skipped every check and was then compared as `any` — a truncated or
    // foreign document read as a function that accepts anything. The two cases
    // are different and are no longer merged:
    //   · `args` ABSENT      -> not the shape this control understands: a problem.
    //   · `args: null`       -> Convex rendered "no validator known" (legitimate).
    //                           Indexed as an unknown-validator function: a call
    //                           to it is an unwaivable coverage gap (compare.mjs),
    //                           an uncalled one costs nothing.
    if (!("args" in fn)) {
      problems.push(`${fn.identifier}: the entry has no \`args\` key (an absent validator is not the same as \`args: null\`)`);
      continue;
    }
    const args = fn.args;
    if (args === null) continue;
    const type = typeof args === "object" ? args.type : undefined;
    if (type !== "object" && type !== "any") {
      problems.push(`${fn.identifier}: args is a ${JSON.stringify(type ?? typeof args)} validator, not an object`);
      continue;
    }
    // The whole tree, not just its top: a nested malformed validator reads as
    // `any` further down, which is a quiet pass.
    problems.push(...validatorProblems(args, `${fn.identifier} args`));
  }
  return problems;
}

/** Every function type `convex function-spec` renders (the pinned package's UdfType). */
const FUNCTION_TYPES = new Set(["Query", "Mutation", "Action", "HttpAction"]);
/** Every visibility the pinned package emits (convex/dist/esm-types/cli/lib/deployApi/modules.d.ts). */
const VISIBILITY_KINDS = new Set(["public", "internal"]);

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
