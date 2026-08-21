/**
 * The contract as a TREE, not as a bag of path strings.
 *
 * ⚠️ WHY THIS EXISTS. The first implementation flattened a validator tree into
 * `Map<pathString, metadata>` and compared the two sides path by path. Six
 * defects across three adversarial rounds turned out to be one defect: a flat
 * map cannot say what a tree says. It cannot express
 *
 *   · which union branch a field came from, so a payload combining fields from
 *     mutually exclusive branches read as compatible;
 *   · that a field is required *within its parent* rather than of the payload,
 *     so `{ profile: {} }` passed against `v.optional(v.object({bio:
 *     v.string()}))`, which Convex rejects;
 *   · that an array ELEMENT is an object in its own right, so
 *     `compare.mjs` had to skip every `[*]` path in the missing-required-field
 *     direction, and an element omitting a required field passed while the same
 *     object one level up correctly failed;
 *   · that `v.null()` enumerates one value rather than widening a literal union
 *     open;
 *   · the difference between an object whose KEYS are unknown and a value whose
 *     TYPE is unknown.
 *
 * Each was patched individually and two of the patches caused the next defect,
 * which is what fired the circuit breaker. The representation was the fault.
 *
 * ⚠️ PATH STRINGS ARE DIAGNOSTICS ONLY. They are built during traversal so a
 * finding can name where it is, and are never consulted to decide anything. The
 * authority is the node.
 */

// ── Validator side ───────────────────────────────────────────────────────────

/** Convex validator kinds that mean "anything goes". */
const DYNAMIC = new Set(["any", "unknown", "bytes", "record"]);

/**
 * Convex's rendered spec is already a tree; this only normalizes it.
 *
 * ⚠️ `v.null()` becomes a LITERAL whose value is null. It accepts exactly one
 * value, so it belongs in an enumeration rather than being a reason to abandon
 * one — the old model treated it as a widening branch and thereby made a
 * nullable enum MORE permissive than the same enum without null.
 */
export function validatorTree(node) {
  if (!node || typeof node !== "object") return { kind: "any" };
  const type = node.type;

  if (DYNAMIC.has(type)) return { kind: "any" };
  if (type === "null") return { kind: "literal", value: null };
  if (type === "literal") return { kind: "literal", value: node.value };

  if (type === "object") {
    const fields = new Map();
    const raw = node.value && typeof node.value === "object" ? node.value : {};
    for (const [name, entry] of Object.entries(raw)) {
      fields.set(name, {
        node: validatorTree(entry?.fieldType),
        optional: Boolean(entry && entry.optional),
      });
    }
    return { kind: "object", fields };
  }

  if (type === "array") return { kind: "array", element: validatorTree(node.value) };

  if (type === "union") {
    const branches = (Array.isArray(node.value) ? node.value : []).map(validatorTree);
    return branches.length ? { kind: "union", branches } : { kind: "any" };
  }

  if (type === "id") return { kind: "id", table: node.tableName };
  return { kind: "scalar", type: type ?? "unknown" };
}

// ── Client side ──────────────────────────────────────────────────────────────

/**
 * Builders for the payload tree the extractor produces.
 *
 * ⚠️ `keysComplete` is the distinction that makes the missing-required-field
 * direction sound. It says "these are ALL the keys this object has", which is
 * knowable for an object literal and unknowable for a value that crossed an
 * `any` boundary or a `Record<string, T>`. A required field may only be
 * *demanded* of an object whose keys are complete — otherwise absence from our
 * map is absence of evidence, not evidence of absence.
 */
export const clientNode = {
  object: (fields, keysComplete) => ({ kind: "object", fields, keysComplete }),
  array: (element) => ({ kind: "array", element }),
  literal: (values) => ({ kind: "literal", values }),
  scalar: (type) => ({ kind: "scalar", type }),
  /** The VALUE is unknown; we may still know it is present. */
  opaqueValue: () => ({ kind: "opaqueValue" }),
  /** The KEY SET is unknown; we cannot enumerate what is or is not sent. */
  opaqueKeys: () => ({ kind: "object", fields: new Map(), keysComplete: false }),
};

// ── Comparison ───────────────────────────────────────────────────────────────

export const SEVERITY = {
  BREAKING: "BREAKING",
  SHAPE_UNKNOWN: "SHAPE_UNKNOWN",
  TYPE_UNKNOWN: "TYPE_UNKNOWN",
};

/** Coarse scalar compatibility, used only when nothing sharper is available. */
const SCALAR_OK = {
  string: new Set(["string"]),
  number: new Set(["number"]),
  float64: new Set(["number"]),
  int64: new Set(["number", "bigint"]),
  boolean: new Set(["boolean"]),
  bytes: new Set(["string"]),
};

const joinPath = (path, segment) => (path ? `${path}${segment}` : segment.replace(/^\./, ""));

/**
 * @typedef {{ severity: string, dimension: string, path: string, detail: string,
 *             identifier?: string, file?: string, line?: number }} Finding
 */

/**
 * Compare one client node against one validator node.
 *
 * @returns {{findings: Finding[], compatible: boolean}} `compatible` is used by
 *   union-branch selection: it means "nothing here PROVES a mismatch", which is
 *   deliberately weaker than "proven correct".
 */
export function compareNode(client, validator, path, ctx) {
  const findings = [];
  const add = (severity, dimension, detail, at = path) => {
    findings.push({ severity, dimension, path: at || "<root>", detail, ...ctx.site });
  };

  // A validator that accepts anything ends the comparison.
  if (validator.kind === "any") return { findings, compatible: true };

  // An unresolvable client VALUE: we know it is sent, not what it is.
  if (client.kind === "opaqueValue") {
    add(SEVERITY.TYPE_UNKNOWN, "VALUE", "the client value is opaque, so it is not verified against the declared type");
    return { findings, compatible: true };
  }

  if (validator.kind === "union") return compareUnion(client, validator, path, ctx);

  if (validator.kind === "object") {
    if (client.kind !== "object") {
      add(SEVERITY.BREAKING, "SHAPE", `the backend declares an object here and the client sends ${client.kind}`);
      return { findings, compatible: false };
    }
    let compatible = true;

    // Direction 1 — the client sends something the backend does not declare.
    for (const [name, sent] of client.fields) {
      const declared = validator.fields.get(name);
      const at = joinPath(path, `.${name}`);
      if (!declared) {
        add(SEVERITY.BREAKING, "SHAPE", "the live backend declares no such field — Convex rejects undeclared fields", at);
        compatible = false;
        continue;
      }
      const nested = compareNode(sent.node, declared.node, at, ctx);
      findings.push(...nested.findings);
      if (!nested.compatible) compatible = false;
    }

    // Direction 2 — the backend requires something the client does not send.
    //
    // ⚠️ Gated on `keysComplete`, and on nothing else. This is the whole reason
    // for the redesign: the requirement lives on the FIELD inside THIS object,
    // so it is answerable exactly when this object's key set is known — whether
    // that object is a top-level argument, a nested optional object, or an
    // array element. The flat model could not ask the question at an array
    // element at all, and had to skip every `[*]` path.
    if (client.keysComplete) {
      for (const [name, declared] of validator.fields) {
        if (declared.optional) continue;
        if (client.fields.has(name)) continue;
        if (ctx.frameworkSupplied?.(joinPath(path, `.${name}`))) continue;
        add(SEVERITY.BREAKING, "SHAPE", "the live backend requires this field and the client does not send it", joinPath(path, `.${name}`));
        compatible = false;
      }
    } else if (validator.fields.size > 0) {
      const missing = [...validator.fields].some(([name, d]) => !d.optional && !client.fields.has(name));
      if (missing) {
        add(SEVERITY.SHAPE_UNKNOWN, "SHAPE", "the backend requires fields here and the client object's key set could not be resolved");
      }
    }
    return { findings, compatible };
  }

  if (validator.kind === "array") {
    if (client.kind !== "array") {
      add(SEVERITY.BREAKING, "SHAPE", `the backend declares an array here and the client sends ${client.kind}`);
      return { findings, compatible: false };
    }
    // ⚠️ The element is a node, not a `[*]` path segment. Everything that works
    // for an object works for an element, because it IS an object.
    return compareNode(client.element, validator.element, joinPath(path, "[*]"), ctx);
  }

  if (validator.kind === "literal") return compareValues(client, new Set([validator.value]), path, ctx);
  if (validator.kind === "id") {
    if (client.kind === "object" || client.kind === "array") {
      add(SEVERITY.BREAKING, "SHAPE", `the backend declares an id here and the client sends ${client.kind}`);
      return { findings, compatible: false };
    }
    return { findings, compatible: true };
  }

  // Scalar.
  if (client.kind === "literal") {
    const bad = [...client.values].filter((v) => !SCALAR_OK[validator.type]?.has(typeof v));
    if (SCALAR_OK[validator.type] && bad.length) {
      add(SEVERITY.BREAKING, "VALUE", `the backend declares ${validator.type} and the client can send ${describe(bad)}`);
      return { findings, compatible: false };
    }
    return { findings, compatible: true };
  }
  if (client.kind === "object" || client.kind === "array") {
    add(SEVERITY.BREAKING, "SHAPE", `the backend declares ${validator.type} here and the client sends ${client.kind}`);
    return { findings, compatible: false };
  }
  if (SCALAR_OK[validator.type] && client.kind === "scalar" && !SCALAR_OK[validator.type].has(client.type)) {
    add(SEVERITY.BREAKING, "VALUE", `the backend declares ${validator.type} and the client sends ${client.type}`);
    return { findings, compatible: false };
  }
  return { findings, compatible: true };
}

/**
 * A union is satisfied by ONE branch, so the client is compared against each.
 *
 * ⚠️ This is what a flat map could not do. Merging every branch's fields into
 * one map made `{type:"CASH", cardNumber:"..."}` look compatible with
 * `v.union(v.object({type:literal("CARD"), cardNumber}), v.object({type:
 * literal("CASH")}))`, because both keys existed *somewhere* in the merge.
 * Evaluating branch by branch answers the question Convex actually asks.
 */
function compareUnion(client, union, path, ctx) {
  // A union of literals is an enumeration; compare values, not shapes.
  if (union.branches.every((b) => b.kind === "literal")) {
    return compareValues(client, new Set(union.branches.map((b) => b.value)), path, ctx);
  }

  const attempts = union.branches.map((branch) => compareNode(client, branch, path, ctx));

  // Satisfying any branch outright is enough.
  const clean = attempts.find((a) => a.compatible && a.findings.length === 0);
  if (clean) return clean;

  // Otherwise prefer a branch that is merely unproven over one that is broken.
  const unproven = attempts.find((a) => a.compatible);
  if (unproven) return unproven;

  // No branch can accept this payload. Report the least noisy explanation
  // rather than every branch's complaints.
  const fewest = attempts.reduce((best, a) => (a.findings.length < best.findings.length ? a : best), attempts[0]);
  return fewest ?? { findings: [], compatible: true };
}

/** Value-domain comparison against an exhaustive accepted set. */
function compareValues(client, accepted, path, ctx) {
  const findings = [];
  const add = (severity, detail) =>
    findings.push({ severity, dimension: "VALUE", path: path || "<root>", detail, ...ctx.site });

  if (client.kind === "literal") {
    const rejected = [...client.values].filter((v) => !accepted.has(v));
    if (rejected.length) {
      add(SEVERITY.BREAKING, `client can send ${describe(rejected)}; backend accepts only ${describe([...accepted])}`);
      return { findings, compatible: false };
    }
    return { findings, compatible: true };
  }
  if (client.kind === "object" || client.kind === "array") {
    add(SEVERITY.BREAKING, `backend accepts only ${describe([...accepted])} and the client sends ${client.kind}`);
    return { findings, compatible: false };
  }
  // A widened scalar cannot be proven a subset of an enumeration.
  add(SEVERITY.TYPE_UNKNOWN, `backend accepts only ${describe([...accepted])}; the client type is wider than an enumeration, so the value is NOT verified`);
  return { findings, compatible: true };
}

/**
 * ⚠️ Renders `null` as "null" rather than as an empty string. `join(", ")`
 * coerces null to "", which printed "accepts only [ACTIVE, ]" — a diagnostic
 * that hides the very value it is talking about.
 */
export function describe(values) {
  return `[${values.map((v) => (v === null ? "null" : String(v))).join(", ")}]`;
}
