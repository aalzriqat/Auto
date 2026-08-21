/**
 * Flatten a Convex argument validator (as returned by `convex function-spec`)
 * into the set of field PATHS the deployed backend will actually accept.
 *
 * ⚠️ THE WHOLE POINT IS THE NESTED PATH. The defect this exists to catch was
 * `rowId` — a field added inside `vehicles: v.array(v.object({...}))`, not at
 * the top level. A comparison that only looked at top-level argument names
 * would have seen `vehicles` on both sides, called them equal, and shipped the
 * outage. So paths are emitted as:
 *
 *   orgId                       a top-level field
 *   vehicles[*]                 the array itself, and its element
 *   vehicles[*].rowId           a field inside each element
 *   vehicles[*].valuations[*].companyName
 *
 * The live spec's shape (verified against the production deployment, not
 * assumed) is:
 *
 *   { type: "object", value: { <name>: { fieldType: <validator>, optional: bool } } }
 *   { type: "array",  value: <element validator> }
 *   { type: "union",  value: [ <validator>, ... ] }
 *   { type: "literal" | "string" | "number" | "boolean" | "id" | "any" | ... }
 */

/** Validator node types that accept arbitrary content underneath them. */
const DYNAMIC_TYPES = new Set(["any", "record", "unknown"]);

/**
 * @param {unknown} validator  the `args` value from a function-spec entry
 * @returns {{
 *   paths: Map<string, { optional: boolean, kind: string, literals: Set<string|number|boolean>|null, requiredWithinParent: boolean }>,
 *   dynamicPrefixes: string[],
 *   rootDynamic: boolean,
 * }}
 *
 * `dynamicPrefixes` is the escape hatch that keeps this honest in the other
 * direction: below a `v.any()` or a record, the backend accepts anything, so a
 * client field there is NOT a violation. Reporting one would be a false
 * positive, and a detector that cries wolf gets switched off — which is the
 * failure mode that matters most for a control nobody is forced to read.
 */
export function declaredPaths(validator) {
  // ⚠️ `literals` belongs in this type. It was missing, and a type that does not
  // mention a field makes forgetting to record that field look correct — which
  // is exactly how the array-element path came to drop its enumeration.
  /** @type {Map<string, { optional: boolean, kind: string, literals: Set<string|number|boolean>|null, requiredWithinParent: boolean }>} */
  const paths = new Map();
  const dynamicPrefixes = [];
  let rootDynamic = false;

  /**
   * @param {any} node
   * @param {string} prefix   path accumulated so far ("" at the root)
   * @param {boolean} optional whether the FIELD owning this node was optional
   */
  function walk(node, prefix, optional) {
    if (!node || typeof node !== "object") {
      // A validator we cannot read is not evidence of anything. Treat it as
      // dynamic so it surfaces as UNKNOWN rather than as silent agreement.
      if (prefix === "") rootDynamic = true;
      else dynamicPrefixes.push(prefix);
      return;
    }

    const type = node.type;

    if (DYNAMIC_TYPES.has(type)) {
      if (prefix === "") rootDynamic = true;
      else dynamicPrefixes.push(prefix);
      return;
    }

    if (type === "object") {
      const fields = node.value && typeof node.value === "object" ? node.value : {};
      for (const [name, entry] of Object.entries(fields)) {
        const childPath = prefix ? `${prefix}.${name}` : name;
        // ⚠️ OPTIONALITY IS INHERITED. A required field inside an OPTIONAL
        // parent is required only *if the parent is present* — it is not
        // required of the payload.
        //
        // Found by the first whole-repo run, which reported four BREAKING
        // findings of the form "the backend requires depositResolution.treatment
        // and the client does not send it". Production declares
        // `depositResolution` optional and `treatment` required within it, so
        // omitting the whole object is legitimate and every one of those was a
        // false positive. A control that reports a fabricated outage on its
        // first run is worse than no control, because the second report is the
        // one nobody reads.
        const childOptional = Boolean(entry && entry.optional) || optional;
        // Record the field itself before descending, so that an object-valued
        // field is reachable as a path in its own right.
        record(
          childPath,
          childOptional,
          entry?.fieldType?.type ?? "unknown",
          literalValuesOf(entry?.fieldType),
          // The field OWN declaration, kept alongside the inherited
          // `optional`. Inheritance answers "must the PAYLOAD carry this?";
          // this answers "must the PARENT OBJECT carry it, if present at
          // all?". Collapsing the two lost the second question entirely.
          !(entry && entry.optional)
        );
        walk(entry?.fieldType, childPath, childOptional);
      }
      return;
    }

    if (type === "array") {
      const elementPath = `${prefix}[*]`;
      // The element inherits the array field's optionality: if the array itself
      // may be omitted, so may everything inside it.
      //
      // ⚠️ AND ITS ENUMERATION. Omitting `literalValuesOf` here recorded
      // `literals: null` — "not a whitelist" — for every array of literals, and
      // broke the comparison in BOTH directions: an opaque string inside the
      // array fell through to the coarse table and reported a clean PASS, while
      // an in-enumeration literal reported BREAKING because the subset check was
      // skipped and only the kinds were compared. The same union one level up
      // answered both correctly. `convex/schema.ts` and `convex/websites.ts`
      // both declare `v.array(v.union(v.literal("en"), v.literal("ar")))` today.
      record(elementPath, optional, node.value?.type ?? "unknown", literalValuesOf(node.value));
      walk(node.value, elementPath, optional);
      return;
    }

    if (type === "union") {
      const branches = Array.isArray(node.value) ? node.value : [];
      // A field present in only SOME branches is effectively optional — the
      // caller may legitimately send a payload matching a branch without it.
      // Union branches are therefore walked independently and merged, and
      // `mergeOptional` below keeps the most permissive answer.
      for (const branch of branches) walk(branch, prefix, true);
      return;
    }

    // Leaf scalar (string/number/boolean/literal/id/bytes/null). Nothing to
    // descend into; the field was already recorded by its parent object.
  }

  function record(path, optional, kind, literals = null, requiredWithinParent = false) {
    const existing = paths.get(path);
    if (!existing) {
      paths.set(path, { optional, kind, literals, requiredWithinParent });
      return;
    }
    // Seen through more than one union branch: it is only conditionally
    // required if EVERY branch declaring it requires it.
    existing.requiredWithinParent = existing.requiredWithinParent && requiredWithinParent;
    // Seen via more than one union branch. Optional-in-any-branch wins,
    // because the client only has to satisfy one branch.
    existing.optional = existing.optional || optional;
    if (existing.kind !== kind) existing.kind = "union";
    if (existing.literals && literals) {
      for (const v of literals) existing.literals.add(v);
    } else {
      // One branch accepts arbitrary values of its type, so the enumeration is
      // no longer exhaustive and must not be used as a whitelist.
      existing.literals = null;
    }
  }

  walk(validator, "", false);
  return { paths, dynamicPrefixes, rootDynamic };
}

/**
 * The exhaustive set of values a validator accepts, or `null` when it accepts
 * more than an enumeration.
 *
 * ⚠️ `null` means "not a whitelist" and must never be treated as "empty". A
 * caller that read an empty set as "accepts nothing" would flag every value as
 * breaking; one that read it as "accepts anything" would verify nothing. The
 * distinction is why this returns null rather than an empty Set.
 *
 * This is what makes `"MAYBE"` into `v.union(v.literal("CASH"), …)` a defect
 * rather than a match. Both sides are strings; only the accepted-value set
 * separates them, and "both are strings" is exactly the reasoning that would
 * let it through.
 */
export function literalValuesOf(node) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "literal") return new Set([node.value]);
  // ⚠️ `v.null()` ENUMERATES; it does not widen. Treating it like any other
  // non-literal branch threw away the whole whitelist for the standard nullable
  // enum `v.union(v.literal("A"), v.literal("B"), v.null())`, which then fell
  // through to the coarse table and accepted ANY string — a clean PASS on a
  // payload the backend rejects, and more permissive than the same union
  // without the null branch. A branch that accepts exactly one value belongs in
  // the set, not in the reason for abandoning it.
  if (node.type === "null") return new Set([null]);
  if (node.type === "union") {
    const branches = Array.isArray(node.value) ? node.value : [];
    const values = new Set();
    for (const branch of branches) {
      const branchValues = literalValuesOf(branch);
      if (!branchValues) return null; // a non-literal branch widens it open
      for (const v of branchValues) values.add(v);
    }
    return values.size ? values : null;
  }
  return null;
}

/**
 * Is `path` accepted by a validator that declared `dynamicPrefixes`?
 *
 * `vehicles[*].meta.anything` is accepted when `vehicles[*].meta` is `v.any()`.
 */
export function underDynamicPrefix(path, dynamicPrefixes) {
  return dynamicPrefixes.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`)
  );
}

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
