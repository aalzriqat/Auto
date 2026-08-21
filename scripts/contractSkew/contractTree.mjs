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

/**
 * ⚠️ THESE TYPES ARE CHECKED, not decorative. `scripts/contractSkew/tsconfig.json`
 * turns on `checkJs` for exactly this reason: the defect that ended the flat
 * model was a semantic dimension added to one consumer of a shared record and
 * not the other, and a checked shape refuses to compile in that situation.
 *
 * @typedef {{kind: "any"}
 *         | {kind: "literal", value: unknown}
 *         | {kind: "scalar", type: string}
 *         | {kind: "id", table?: string}
 *         | {kind: "object", fields: Map<string, {node: ValidatorNode, optional: boolean}>}
 *         | {kind: "array", element: ValidatorNode}
 *         | {kind: "union", branches: ValidatorNode[]}} ValidatorNode
 *
 * @typedef {{kind: "unresolved"}
 *         | {kind: "opaqueValue"}
 *         | {kind: "literal", values: Set<unknown>}
 *         | {kind: "scalar", type: string}
 *         | {kind: "object", fields: Map<string, ClientField>, keysComplete: boolean}
 *         | {kind: "array", element: ClientNode | null, empty?: boolean}
 *         | {kind: "variants", nodes: ClientNode[]}} ClientNode
 *
 * @typedef {{node: ClientNode, provenance?: string, optional?: boolean}} ClientField
 *
 * @typedef {{site: {identifier: string, file: string, line: number},
 *            frameworkSupplied?: (path: string) => boolean,
 *            unproven?: boolean, withinOptional?: boolean}} CompareCtx
 */

// ── Validator side ───────────────────────────────────────────────────────────

/**
 * Convex validator kinds that mean "anything goes".
 *
 * ⚠️ `bytes` IS NOT ONE OF THEM, and listing it here was a false PASS.
 * `v.bytes()` accepts an ArrayBuffer, not arbitrary values — but mapping it to
 * `any` ended the comparison before anything was checked, which also made the
 * `SCALAR_OK.bytes` entry below unreachable dead code that read as coverage.
 */
const DYNAMIC = new Set(["any", "unknown", "record"]);

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
  /**
   * An array literal with NO elements. Knowledge, not ignorance: Convex
   * validates zero elements, so the element validator cannot refuse anything.
   * Modelling this as `array(unresolved)` fabricated a BREAKING finding at
   * `field[*]` for completely valid code.
   */
  emptyArray: () => ({ kind: "array", element: null, empty: true }),
  literal: (values) => ({ kind: "literal", values }),
  scalar: (type) => ({ kind: "scalar", type }),
  /** The VALUE is unknown; we may still know it is present. */
  opaqueValue: () => ({ kind: "opaqueValue" }),
  /** The KEY SET is unknown; we cannot enumerate what is or is not sent. */
  opaqueKeys: () => ({ kind: "object", fields: new Map(), keysComplete: false }),
  /**
   * The client may send any ONE of these shapes -- a TypeScript union that does
   * not collapse, e.g. `{ a: 1 } | string`. Every variant has to be acceptable,
   * because we cannot tell which one runs.
   */
  variants: (nodes) => (nodes.length === 1 ? nodes[0] : { kind: "variants", nodes }),
  /** Nothing has been learned about this node yet. */
  unresolved: () => ({ kind: "unresolved" }),
};

/**
 * PROVENANCE: HOW DO WE KNOW THIS FIELD IS ACTUALLY SENT?
 *
 * Presence in a shared TypeScript type is not transmission. The first
 * whole-repo run reported `wizardData.vehicleItems` as BREAKING because the
 * type permits it -- while the call site never sets it, so Convex never sees
 * it. An OPTIONAL property nobody assigns is not a defect; claiming otherwise
 * is the detector inventing an outage.
 *
 *   LITERAL        an explicit property in the object literal at the call site
 *   SPREAD         contributed by a resolvable spread
 *   TYPE_REQUIRED  a non-optional property of a resolved type: always present
 *   TYPE_OPTIONAL  an optional property: MAY be sent, unproven
 *
 * Only the first three prove transmission and can justify BREAKING. The
 * strongest provenance seen wins: one route that definitely sends a field is
 * enough to prove it is transmitted.
 */
export const PROVENANCE_RANK = { TYPE_OPTIONAL: 0, TYPE_REQUIRED: 1, SPREAD: 2, LITERAL: 3 };
const PROVEN = new Set(["LITERAL", "SPREAD", "TYPE_REQUIRED"]);

export const strongerProvenance = (a, b) =>
  (PROVENANCE_RANK[b] ?? 0) > (PROVENANCE_RANK[a] ?? 0) ? b : a;

/**
 * Combine two observations of the SAME node -- a union branch, a spread, a
 * second element of an array literal, a second route to one field.
 *
 * Opacity is absorbing. If any route to a value is opaque, the value is opaque:
 * two call paths sending the same field, one typed and one `any`, means the
 * field is not verified. Taking the typed one would report a confidence the
 * code does not support.
 */
export function mergeClientNodes(a, b) {
  if (!a) return b ?? clientNode.unresolved();
  if (!b) return a;
  if (a === b) return a;
  if (a.kind === "unresolved") return b;
  if (b.kind === "unresolved") return a;
  if (a.kind === "opaqueValue" || b.kind === "opaqueValue") return clientNode.opaqueValue();

  if (a.kind === "object" && b.kind === "object") {
    const fields = new Map(a.fields);
    for (const [name, entry] of b.fields) {
      const existing = fields.get(name);
      fields.set(
        name,
        existing
          ? {
              node: mergeClientNodes(existing.node, entry.node),
              provenance: strongerProvenance(existing.provenance, entry.provenance),
            }
          : entry
      );
    }
    // Key completeness is a conjunction: one unenumerable route is enough to
    // make the whole key set unknown.
    return clientNode.object(fields, Boolean(a.keysComplete && b.keysComplete));
  }

  if (a.kind === "array" && b.kind === "array") {
    // Two empty observations stay empty. One empty and one populated is NOT
    // empty — the populated element still has to be checked, because that call
    // site really does transmit elements.
    if (a.empty && b.empty) return clientNode.emptyArray();
    return clientNode.array(mergeClientNodes(a.element, b.element));
  }

  if (a.kind === "literal" && b.kind === "literal") {
    return clientNode.literal(new Set([...a.values, ...b.values]));
  }

  // A literal beside the scalar it belongs to is that scalar, widened: the
  // enumeration stops being a whitelist, so it stops being provable.
  const widened = widenLiteralInto(a, b) ?? widenLiteralInto(b, a);
  if (widened) return widened;

  if (a.kind === "scalar" && b.kind === "scalar" && a.type === b.type) return a;

  // Genuinely different shapes. Keep both rather than collapsing to a label
  // that means neither -- the comparator has to be able to reject the payload
  // if EITHER shape would be rejected.
  const nodes = [
    ...(a.kind === "variants" ? a.nodes : [a]),
    ...(b.kind === "variants" ? b.nodes : [b]),
  ];
  return clientNode.variants(nodes);
}

function widenLiteralInto(literal, scalar) {
  if (literal.kind !== "literal" || scalar.kind !== "scalar") return null;
  const ok = [...literal.values].every((v) => SCALAR_OK[scalar.type]?.has(typeof v));
  return ok ? scalar : null;
}

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
  // ⚠️ `v.int64()` ACCEPTS ONLY bigint. Convex models a 64-bit integer as a
  // JavaScript BigInt, and passing a `number` is refused at runtime — `number`
  // and `bigint` are distinct primitives. Accepting `number` here reported a
  // payload as compatible that the backend rejects: a false PASS, which is the
  // one verdict this control must never produce.
  int64: new Set(["bigint"]),
  boolean: new Set(["boolean"]),
  // `v.bytes()` accepts an ArrayBuffer. The extractor classifies that as an
  // object, so a `string` here is a real mismatch rather than a near-miss.
  bytes: new Set(["object"]),
};

const joinPath = (path, segment) => (path ? `${path}${segment}` : segment.replace(/^\./, ""));

/**
 * ⚠️ `identifier`, `file` and `line` are REQUIRED. A finding nobody can locate
 * is not usable, and the optional form let a `string|undefined` identifier flow
 * all the way into the classifier's `BreakingFinding` before anything noticed —
 * the first thing switching `checkJs` on caught that the tests did not.
 *
 * @typedef {{identifier: string, file: string, line: number}} Site
 * @typedef {{severity: string, dimension: string, path: string, detail: string,
 *            provenance?: string} & Site} Finding
 */

/**
 * Compare one client node against one validator node.
 *
 * @param {import("./contractTree.mjs").ClientNode} client
 * @param {import("./contractTree.mjs").ValidatorNode} validator
 * @param {string} path  diagnostics only — never consulted to decide anything
 * @param {CompareCtx} ctx
 * @returns {{findings: Finding[], compatible: boolean}} `compatible` is used by
 *   union-branch selection: it means "nothing here PROVES a mismatch", which is
 *   deliberately weaker than "proven correct".
 */
export function compareNode(client, validator, path, ctx) {
  const findings = [];
  const add = (severity, dimension, detail, at = path) => {
    findings.push(finding(ctx, severity, dimension, at || path, detail));
  };

  // ⚠️ A MISSING NODE FAILS CLOSED. Reaching here with nothing to compare is a
  // programming error, and the safe answer to "what does this send?" when the
  // answer is absent is "we do not know" — which denies PASS. Throwing would
  // abort the whole scheduled run; claiming compatibility would be a lie.
  if (!client) {
    add(SEVERITY.SHAPE_UNKNOWN, "SHAPE", "no client payload could be resolved for this call");
    return { findings, compatible: true };
  }

  // A validator that accepts anything ends the comparison.
  if (validator.kind === "any") return { findings, compatible: true };

  // ⚠️ AN UNRESOLVED CLIENT NODE PROVES NOTHING IN EITHER DIRECTION.
  //
  // Found independently by both review seats in the first round on this model.
  // There was a branch for `opaqueValue` and none for `unresolved`, so an
  // unresolvable value fell through into the per-validator-kind comparisons and
  // was treated as a definite shape. That produced BOTH failure directions at
  // once, decided by nothing but which validator it happened to meet:
  //
  //   vs scalar / id     a silent PASS with zero findings — a false claim of
  //                      verification, which the module header calls the one
  //                      outcome that would make this control worse than useless
  //   vs object / array  a fabricated BREAKING — a false production-skew alarm,
  //                      which is how a monitor gets muted
  //
  // It is reachable from ordinary code, not a synthetic state: a method
  // shorthand in a payload literal, and an unconstrained generic type parameter
  // reaching a payload field, both produce it.
  if (client.kind === "unresolved") {
    const nested = validator.kind === "object" || validator.kind === "array";
    add(
      nested ? SEVERITY.SHAPE_UNKNOWN : SEVERITY.TYPE_UNKNOWN,
      nested ? "SHAPE" : "VALUE",
      `the client value could not be resolved to a type, so it is NOT verified against the declared ${describeValidator(validator)}`
    );
    return { findings, compatible: true };
  }

  // An unresolvable client VALUE: we know it is sent, not what it is.
  //
  // ⚠️ TWO DIFFERENT ANSWERS, kept apart. An `any` where the backend declares a
  // scalar cannot hide an undeclared KEY, so it is shape-safe and only the
  // value is unverified. An `any` where the backend declares an object or an
  // array is worse: whole undeclared fields can hide inside it.
  if (client.kind === "opaqueValue") {
    const nested = validator.kind === "object" || validator.kind === "array";
    const label = describeValidator(validator);
    if (!path) {
      add(SEVERITY.SHAPE_UNKNOWN, "SHAPE", "the whole payload is opaque (`any`); nothing about this call is verified");
    } else if (nested) {
      add(SEVERITY.SHAPE_UNKNOWN, "SHAPE", `value is \`any\` where the backend declares ${label}: undeclared keys could hide inside it`);
    } else {
      add(SEVERITY.TYPE_UNKNOWN, "VALUE", `key is declared (${label}) but the value is \`any\`: shape-safe, value NOT verified`);
    }
    return { findings, compatible: true };
  }

  if (client.kind === "variants") {
    // The client may send any one of these, so a mismatch in ANY of them is a
    // mismatch. (A validator union is the mirror image: satisfying ONE branch
    // is enough. Collapsing the two directions is what made the flat model
    // accept a payload built from two mutually exclusive branches.)
    const seen = new Set();
    const merged = [];
    let ok = true;
    for (const variant of client.nodes) {
      const attempt = compareNode(variant, validator, path, ctx);
      if (!attempt.compatible) ok = false;
      for (const f of attempt.findings) {
        const key = `${f.severity}|${f.dimension}|${f.path}|${f.detail}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(f);
      }
    }
    return { findings: merged, compatible: ok };
  }

  if (validator.kind === "union") return compareUnion(client, validator, path, ctx);

  if (validator.kind === "object") {
    if (client.kind !== "object") {
      add(SEVERITY.BREAKING, "VALUE", `client sends ${describeClient(client)} where the backend declares object`);
      return { findings, compatible: false };
    }
    let compatible = true;

    // Direction 1 — the client sends something the backend does not declare.
    for (const [name, sent] of client.fields) {
      const declared = validator.fields.get(name);
      const at = joinPath(path, `.${name}`);

      // A field whose transmission is unproven cannot prove a defect, and
      // nothing below it can either. Descending with `unproven` set is what
      // replaces the flat model's one-level parent lookup: the fact travels as
      // far down the tree as it is true, instead of being re-derived from a
      // path string at exactly one depth.
      const childCtx = PROVEN.has(sent.provenance ?? "LITERAL") ? ctx : unprovenCtx(ctx);

      if (!declared) {
        const provenance = sent.provenance ?? "LITERAL";
        if (childCtx === ctx) {
          findings.push({
            ...finding(ctx, SEVERITY.BREAKING, "SHAPE", at,
              "the live backend declares no such field — Convex rejects undeclared fields"),
            provenance,
          });
          compatible = false;
        } else {
          findings.push({
            ...finding(ctx, SEVERITY.SHAPE_UNKNOWN, "SHAPE", at,
              `the live backend declares no such field, but this path is only an OPTIONAL member of the payload type (${provenance}) — it may never be assigned, so transmission is unproven`),
            provenance,
          });
        }
        continue;
      }
      const nested = compareNode(
        sent.node,
        declared.node,
        at,
        declared.optional && !childCtx.withinOptional ? { ...childCtx, withinOptional: true } : childCtx
      );
      findings.push(...nested.findings);
      if (!nested.compatible && childCtx === ctx) compatible = false;
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
        // A CONDITIONAL requirement reads differently from an absolute one:
        // the backend demands this field only because the client chose to send
        // the optional object around it.
        add(
          SEVERITY.BREAKING,
          "SHAPE",
          ctx.withinOptional
            ? "the client sends this optional object but omits a field the live backend requires inside it"
            : "the live backend requires this field and the client does not send it",
          joinPath(path, `.${name}`)
        );
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
      add(SEVERITY.BREAKING, "VALUE", `client sends ${describeClient(client)} where the backend declares array`);
      return { findings, compatible: false };
    }
    // Zero elements are transmitted, so the element validator has nothing to
    // refuse. This is a proven clean result, not an unknown.
    if (client.empty) return { findings, compatible: true };
    // A non-empty array with no element node is a programming error. The safe
    // answer to "what does it send?" when the answer is absent is "unknown",
    // which denies PASS — never a silent clean result.
    if (!client.element) {
      add(SEVERITY.SHAPE_UNKNOWN, "SHAPE", "the array's element could not be resolved, so it is not verified");
      return { findings, compatible: true };
    }
    // ⚠️ The element is a node, not a `[*]` path segment. Everything that works
    // for an object works for an element, because it IS an object.
    return compareNode(client.element, validator.element, joinPath(path, "[*]"), ctx);
  }

  if (validator.kind === "literal") return compareValues(client, new Set([validator.value]), path, ctx);
  if (validator.kind === "id") {
    if (client.kind === "object" || client.kind === "array") {
      add(SEVERITY.BREAKING, "VALUE", `client sends ${describeClient(client)} where the backend declares id`);
      return { findings, compatible: false };
    }
    return { findings, compatible: true };
  }

  // Scalar.
  if (client.kind === "literal") {
    const bad = [...client.values].filter((v) => !SCALAR_OK[validator.type]?.has(typeof v));
    if (SCALAR_OK[validator.type] && bad.length) {
      add(SEVERITY.BREAKING, "VALUE", `client can send ${describe(bad)} where the backend declares ${validator.type}`);
      return { findings, compatible: false };
    }
    return { findings, compatible: true };
  }
  if (client.kind === "object" || client.kind === "array") {
    add(SEVERITY.BREAKING, "VALUE", `client sends ${describeClient(client)} where the backend declares ${validator.type}`);
    return { findings, compatible: false };
  }
  if (SCALAR_OK[validator.type] && client.kind === "scalar" && !SCALAR_OK[validator.type].has(client.type)) {
    add(SEVERITY.BREAKING, "VALUE", `client sends ${client.type} where the backend declares ${validator.type}`);
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

/**
 * A context whose findings can no longer be BREAKING.
 *
 * `unproven` means "we are inside something the client MAY never send". A
 * defect that only manifests if an optional property is assigned has not been
 * demonstrated, so it is reported as an unknown with the reason attached rather
 * than as an outage. This is the rule that removed eight fabricated BREAKING
 * findings from the third whole-repo run.
 */
const unprovenCtx = (ctx) => (ctx.unproven ? ctx : { ...ctx, unproven: true });

/**
 * @param {CompareCtx} ctx
 * @returns {Finding}
 */
function finding(ctx, severity, dimension, path, detail) {
  const at = path || "<root>";
  if (severity === SEVERITY.BREAKING && ctx.unproven) {
    return {
      severity: dimension === "SHAPE" ? SEVERITY.SHAPE_UNKNOWN : SEVERITY.TYPE_UNKNOWN,
      dimension,
      path: at,
      detail: `${detail} — but this path is only an OPTIONAL member of the payload type, so transmission is unproven`,
      ...ctx.site,
    };
  }
  return { severity, dimension, path: at, detail, ...ctx.site };
}

/** Value-domain comparison against an exhaustive accepted set. */
function compareValues(client, accepted, path, ctx) {
  const findings = [];
  const add = (severity, detail) => findings.push(finding(ctx, severity, "VALUE", path, detail));

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
/** The legacy kind label for a validator node, used in diagnostics. */
export function describeValidator(validator) {
  switch (validator.kind) {
    case "object":
    case "array":
    case "literal":
    case "union":
    case "id":
    case "any":
      return validator.kind;
    default:
      return validator.type ?? "unresolved";
  }
}

/** The legacy kind label for a client node. */
export function describeClient(client) {
  switch (client.kind) {
    case "object":
    case "array":
      return client.kind;
    case "opaqueValue":
      return "any";
    case "variants":
      return "union";
    case "unresolved":
      return "unresolved";
    case "literal": {
      const kinds = new Set([...client.values].map((v) => (v === null ? "null" : typeof v)));
      return kinds.size === 1 ? [...kinds][0] : "union";
    }
    default:
      return client.type ?? "unresolved";
  }
}

export function describe(values) {
  return `[${values.map((v) => (v === null ? "null" : String(v))).join(", ")}]`;
}
