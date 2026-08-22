import { describe, expect, test } from "vitest";
import {
  validatorTree,
  clientNode,
  compareNode,
  mergeClientNodes,
  admitsAtLeast,
  describeClient,
  SEVERITY,
} from "./contractTree.mjs";

/**
 * The tree model has to re-establish, from scratch, every case the flat model
 * got wrong — plus the two historical incidents SCRUM-178 exists for. These are
 * written against the model directly so a failure points at the representation
 * rather than at the plumbing around it.
 */

const ctx = { site: { identifier: "w:save", file: "x.tsx", line: 1 } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (client: any, validatorSpec: unknown) =>
  compareNode(client, validatorTree(validatorSpec), "", ctx);

// ── validator spec builders (the shape Convex actually renders) ──────────────
const vObj = (fields: Record<string, [unknown, boolean?]>) => ({
  type: "object",
  value: Object.fromEntries(
    Object.entries(fields).map(([k, [node, optional]]) => [k, { fieldType: node, optional: Boolean(optional) }])
  ),
});
const vArr = (element: unknown) => ({ type: "array", element: undefined, value: element });
const vUnion = (...branches: unknown[]) => ({ type: "union", value: branches });
const vLit = (value: unknown) => ({ type: "literal", value });
const vNull = { type: "null" };
const vStr = { type: "string" };
const vNum = { type: "number" };

// ── client tree builders ────────────────────────────────────────────────────
const cObj = (fields: Record<string, unknown>, keysComplete = true) =>
  clientNode.object(new Map(Object.entries(fields).map(([k, node]) => [k, { node }])), keysComplete);
const cLit = (...values: unknown[]) => clientNode.literal(new Set(values));
const cStr = clientNode.scalar("string");

const breaking = (r: { findings: { severity: string; detail?: string }[] }) =>
  r.findings.filter((f) => f.severity === SEVERITY.BREAKING);
const paths = (r: { findings: { path: string }[] }) => r.findings.map((f) => f.path);

describe("the two incidents this control exists for", () => {
  test("#227: the client sends a top-level field the live backend does not declare", () => {
    const result = run(
      cObj({ orgId: cStr, expectedCurrency: cStr }),
      vObj({ orgId: [vStr] })
    );
    expect(breaking(result)).toHaveLength(1);
    expect(paths(result)).toContain("expectedCurrency");
  });

  test("#235: a NESTED field inside an array element, named as vehicles[*].rowId", () => {
    // The counterexample for regex matching, and the reason the model must
    // descend rather than pattern-match.
    const result = run(
      cObj({ vehicles: clientNode.array(cObj({ vin: cStr, rowId: clientNode.scalar("number") })) }),
      vObj({ vehicles: [vArr(vObj({ vin: [vStr] }))] })
    );
    expect(breaking(result)).toHaveLength(1);
    expect(paths(result)).toContain("vehicles[*].rowId");
  });
});

describe("N2 — a required field of an array ELEMENT", () => {
  /**
   * The finding that fired the circuit breaker. The flat model skipped every
   * `[*]` path in this direction because it could not bind per-element
   * requiredness, so an element omitting a required field PASSED while the same
   * object one level up correctly failed.
   */
  const spec = vObj({ vehicles: [vArr(vObj({ vin: [vStr], make: [vStr, true] }))] });

  test("omitting a required element field is breaking", () => {
    const result = run(cObj({ vehicles: clientNode.array(cObj({ make: cStr })) }), spec);
    expect(breaking(result)).toHaveLength(1);
    expect(paths(result)).toContain("vehicles[*].vin");
  });

  test("and it behaves identically to the same shape outside an array", () => {
    const asObject = run(cObj({ vehicle: cObj({ make: cStr }) }), vObj({ vehicle: [vObj({ vin: [vStr], make: [vStr, true] })] }));
    expect(breaking(asObject)).toHaveLength(1);
    expect(paths(asObject)).toContain("vehicle.vin");
  });

  test("sending it is silent", () => {
    const result = run(cObj({ vehicles: clientNode.array(cObj({ vin: cStr })) }), spec);
    expect(breaking(result)).toHaveLength(0);
  });
});

describe("G-F3 — required inside an optional parent, conditional on presence", () => {
  const spec = vObj({ profile: [vObj({ bio: [vStr] }), true] });

  test("parent sent with known keys, required child omitted -> breaking", () => {
    const result = run(cObj({ profile: cObj({}) }), spec);
    expect(breaking(result)).toHaveLength(1);
    expect(paths(result)).toContain("profile.bio");
  });

  test("parent omitted entirely -> silent", () => {
    expect(breaking(run(cObj({}), spec))).toHaveLength(0);
  });

  test("parent sent but its KEY SET is unresolved -> unknown, never breaking", () => {
    // Absence from our map is absence of evidence, not evidence of absence.
    const result = run(cObj({ profile: cObj({}, false) }), spec);
    expect(breaking(result)).toHaveLength(0);
    expect(result.findings.map((f) => f.severity)).toContain(SEVERITY.SHAPE_UNKNOWN);
  });
});

describe("G-F7 — discriminated unions are satisfied by ONE branch", () => {
  /**
   * The flat model merged every branch's fields into one map, so a payload
   * combining fields from mutually exclusive branches looked compatible because
   * both keys existed somewhere in the merge.
   */
  const spec = vObj({
    payment: [
      vUnion(
        vObj({ type: [vLit("CARD")], cardNumber: [vStr] }),
        vObj({ type: [vLit("CASH")] })
      ),
    ],
  });

  test("a valid branch passes", () => {
    expect(breaking(run(cObj({ payment: cObj({ type: cLit("CARD"), cardNumber: cStr }) }), spec))).toHaveLength(0);
    expect(breaking(run(cObj({ payment: cObj({ type: cLit("CASH") }) }), spec))).toHaveLength(0);
  });

  test("a payload combining two branches satisfies neither", () => {
    const result = run(cObj({ payment: cObj({ type: cLit("CASH"), cardNumber: cStr }) }), spec);
    expect(breaking(result).length).toBeGreaterThan(0);
  });
});

describe("G-F2 / N1 / N3 — null enumerates, and prints", () => {
  const spec = vObj({ status: [vUnion(vLit("ACTIVE"), vLit("INACTIVE"), vNull)] });

  test("N1: sending the literal null is accepted, not flagged", () => {
    const result = run(cObj({ status: cLit(null) }), spec);
    expect(result.findings).toHaveLength(0);
  });

  test("a value outside the enumeration is breaking", () => {
    expect(breaking(run(cObj({ status: cLit("GARBAGE") }), spec))).toHaveLength(1);
  });

  test("a widened string is unproven, not a clean pass", () => {
    const result = run(cObj({ status: cStr }), spec);
    expect(breaking(result)).toHaveLength(0);
    expect(result.findings.map((f) => f.severity)).toContain(SEVERITY.TYPE_UNKNOWN);
  });

  test("N3: the diagnostic prints null rather than swallowing it", () => {
    const result = run(cObj({ status: cLit("GARBAGE") }), spec);
    expect(result.findings[0].detail).toContain("null");
    expect(result.findings[0].detail).not.toContain(", ]");
  });
});

describe("a client union carrying null (owner-specified pre-freeze controls)", () => {
  /**
   * An exact finite client domain that is NOT a subset of the backend domain is
   * a proven refusal, and `null` is a member of that domain like any other
   * value. The extractor used to discard the branch, which made the check pass
   * on a payload Convex rejects.
   */
  test('"A" | null against v.literal("A") is BREAKING', () => {
    const result = run(cObj({ status: cLit("A", null) }), vObj({ status: [vLit("A")] }));
    expect(breaking(result)).toHaveLength(1);
    expect(result.findings[0].detail).toContain("null");
  });

  test('"A" | null against v.union(v.literal("A"), v.null()) is compatible', () => {
    const result = run(cObj({ status: cLit("A", null) }), vObj({ status: [vUnion(vLit("A"), vNull)] }));
    expect(result.findings).toHaveLength(0);
  });

  test("a widened scalar beside null stays UNKNOWN for the scalar half", () => {
    // The null half is provable; the string half is not. Reporting the whole
    // thing as BREAKING would overstate, reporting it clean would understate.
    const client = cObj({ status: clientNode.variants([cStr, cLit(null)]) });
    const result = run(client, vObj({ status: [vUnion(vLit("A"), vNull)] }));
    expect(breaking(result)).toHaveLength(0);
    expect(result.findings.map((f) => f.severity)).toContain(SEVERITY.TYPE_UNKNOWN);
  });

  test("null against a backend that declares a plain string IS breaking", () => {
    expect(breaking(run(cObj({ n: cLit(null) }), vObj({ n: [vStr] })))).toHaveLength(1);
  });
});

describe("the array-of-literal-union case (the Claude-family blocking finding)", () => {
  const spec = vObj({ statuses: [vArr(vUnion(vLit("ACTIVE"), vLit("SOLD")))] });

  test("an out-of-enumeration literal inside an array is breaking", () => {
    const result = run(cObj({ statuses: clientNode.array(cLit("MAYBE")) }), spec);
    expect(breaking(result)).toHaveLength(1);
    expect(paths(result)).toContain("statuses[*]");
  });

  test("an in-enumeration literal inside an array is clean", () => {
    expect(run(cObj({ statuses: clientNode.array(cLit("ACTIVE")) }), spec).findings).toHaveLength(0);
  });

  test("a widened string inside an array is unproven, not a clean pass", () => {
    const result = run(cObj({ statuses: clientNode.array(cStr) }), spec);
    expect(breaking(result)).toHaveLength(0);
    expect(result.findings.map((f) => f.severity)).toContain(SEVERITY.TYPE_UNKNOWN);
  });
});

describe("opaque values and opaque keys are different facts", () => {
  test("an opaque VALUE is a value-dimension unknown", () => {
    const result = run(cObj({ status: clientNode.opaqueValue() }), vObj({ status: [vStr] }));
    expect(result.findings[0].severity).toBe(SEVERITY.TYPE_UNKNOWN);
    expect(result.findings[0].dimension).toBe("VALUE");
  });

  test("opaque KEYS are a shape-dimension unknown, and never breaking", () => {
    const result = run(cObj({ profile: clientNode.opaqueKeys() }), vObj({ profile: [vObj({ bio: [vStr] })] }));
    expect(breaking(result)).toHaveLength(0);
    expect(result.findings[0].severity).toBe(SEVERITY.SHAPE_UNKNOWN);
    expect(result.findings[0].dimension).toBe("SHAPE");
  });

  test("v.any() ends the comparison rather than demanding anything", () => {
    const result = run(cObj({ meta: cObj({ whatever: cStr }) }), vObj({ meta: [{ type: "any" }] }));
    expect(result.findings).toHaveLength(0);
  });
});

describe("an UNRESOLVED client node (round-1 review, both seats)", () => {
  /**
   * ⚠️ FOUND INDEPENDENTLY BY BOTH REVIEW SEATS, which is why it is here as a
   * whole describe rather than one case.
   *
   * `compareNode` had an explicit branch for `opaqueValue` and none for
   * `unresolved`, so an unresolvable client value fell through into the
   * ordinary per-validator-kind comparisons and was treated as a definite
   * shape. That gave BOTH failure directions at once, decided by nothing more
   * than which validator it happened to meet:
   *
   *   vs scalar / id      silent PASS with zero findings — a false claim of
   *                       verification, the outcome the module header calls
   *                       "worse than useless"
   *   vs object / array   fabricated BREAKING — a false production-skew alarm,
   *                       which is how a monitor gets muted
   *
   * `unresolved` means "we learned nothing here". It can prove neither
   * direction, so it must report an unknown and never either verdict.
   */
  const cases: Array<[string, unknown]> = [
    ["object", vObj({ a: [vStr] })],
    ["array", vArr(vStr)],
    ["id", { type: "id", tableName: "vehicles" }],
    ["scalar", vStr],
    ["literal union", vUnion(vLit("A"), vLit("B"))],
  ];

  for (const [label, validator] of cases) {
    test(`vs ${label}: never BREAKING, and never a silent pass`, () => {
      const result = run(cObj({ v: clientNode.unresolved() }), vObj({ v: [validator] }));
      expect(breaking(result)).toHaveLength(0);
      expect(result.findings.length).toBeGreaterThan(0);
    });
  }

  test("the unknown names the right DIMENSION: keys can hide in an object", () => {
    const result = run(cObj({ v: clientNode.unresolved() }), vObj({ v: [vObj({ a: [vStr] })] }));
    expect(result.findings[0].severity).toBe(SEVERITY.SHAPE_UNKNOWN);
    expect(result.findings[0].dimension).toBe("SHAPE");
  });

  test("and only the VALUE is at stake for a scalar", () => {
    const result = run(cObj({ v: clientNode.unresolved() }), vObj({ v: [vStr] }));
    expect(result.findings[0].severity).toBe(SEVERITY.TYPE_UNKNOWN);
    expect(result.findings[0].dimension).toBe("VALUE");
  });
});

describe("an EMPTY array literal is knowledge, not ignorance", () => {
  /**
   * `vehicles: []` is not an unresolved element — it is a KNOWN absence of
   * elements. Convex validates zero of them, so the element validator cannot
   * refuse anything and there is nothing to report. Modelling it as
   * `array(unresolved)` produced a fabricated BREAKING at `vehicles[*]` for
   * code that is completely valid.
   */
  const spec = vObj({ vehicles: [vArr(vObj({ vin: [vStr] }))] });

  test("an empty array against an array-of-objects validator is CLEAN", () => {
    const result = run(cObj({ vehicles: clientNode.emptyArray() }), spec);
    expect(result.findings).toHaveLength(0);
    expect(result.compatible).toBe(true);
  });

  test("a populated array is still checked — the fix must not blind the element", () => {
    const bad = clientNode.array(cObj({ vin: cStr, ghost: cStr }));
    expect(breaking(run(cObj({ vehicles: bad }), spec))).toHaveLength(1);
  });

  test("merging an empty observation with a populated one keeps the element", () => {
    const merged = mergeClientNodes(clientNode.emptyArray(), clientNode.array(cObj({ ghost: cStr })));
    expect(merged.kind).toBe("array");
    expect(merged.empty).toBeFalsy();
    expect(breaking(run(cObj({ vehicles: merged }), spec)).length).toBeGreaterThan(0);
  });
});

describe("every validator kind refuses the wrong client shape", () => {
  /**
   * One arm per validator kind. These are the branches that decide whether a
   * payload is refused at all, and most of them had no test: the suite grew
   * around the interesting cases (unions, arrays, provenance) and left the
   * plain "wrong kind" answers to be assumed.
   */
  test("an array validator refuses a non-array client", () => {
    const result = run(cObj({ v: cStr }), vObj({ v: [vArr(vStr)] }));
    expect(breaking(result)).toHaveLength(1);
    expect(result.findings[0].detail).toContain("declares array");
  });

  test("an object validator refuses a scalar client", () => {
    const result = run(cObj({ v: cStr }), vObj({ v: [vObj({ a: [vStr] })] }));
    expect(breaking(result)).toHaveLength(1);
    expect(result.findings[0].detail).toContain("declares object");
  });

  test("an id validator refuses an object or an array", () => {
    const id = { type: "id", tableName: "vehicles" };
    expect(breaking(run(cObj({ v: cObj({ a: cStr }) }), vObj({ v: [id] })))).toHaveLength(1);
    expect(breaking(run(cObj({ v: clientNode.array(cStr) }), vObj({ v: [id] })))).toHaveLength(1);
  });

  test("an id validator does NOT accept an unbranded string as proof", () => {
    /**
     * ⚠️ THIS TEST ASSERTED THE OPPOSITE, AND THAT WAS THE FINER OF TWO FALSE
     * PASSES. `v.id(table)` means more than "is a JS string" — Convex's own
     * contract brands it, and tells callers holding an untrusted string to
     * normalize it before treating it as an id. An unbranded string is an
     * ABSENCE of proof and is now reported as one: not clean, not breaking.
     */
    const result = run(cObj({ v: cStr }), vObj({ v: [{ type: "id", tableName: "vehicles" }] }));
    expect(breaking(result)).toHaveLength(0);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe(SEVERITY.TYPE_UNKNOWN);
  });

  test("a scalar validator refuses an object", () => {
    const result = run(cObj({ v: cObj({ a: cStr }) }), vObj({ v: [vNum] }));
    expect(breaking(result)).toHaveLength(1);
    expect(result.findings[0].detail).toContain("declares number");
  });

  test("a scalar validator refuses a literal of the wrong primitive", () => {
    const result = run(cObj({ v: cLit(42) }), vObj({ v: [vStr] }));
    expect(breaking(result)).toHaveLength(1);
    expect(result.findings[0].detail).toContain("42");
  });

  test("an array whose element node is missing is UNKNOWN, never clean", () => {
    // Defensive: a non-empty array with no element is a programming error, and
    // the safe answer is "we do not know", which denies PASS.
    const broken = { kind: "array", element: null } as never;
    const result = run(cObj({ v: broken }), vObj({ v: [vArr(vStr)] }));
    expect(breaking(result)).toHaveLength(0);
    expect(result.findings.map((f) => f.severity)).toContain(SEVERITY.SHAPE_UNKNOWN);
  });
});

describe("findings name the client shape they refused", () => {
  /**
   * The label is what a responder reads at 3am. Each client kind has to render
   * as something they can act on rather than as an internal node name.
   */
  const cases: Array<[string, unknown, string]> = [
    ["an opaque value", clientNode.opaqueValue(), "any"],
    ["client variants", clientNode.variants([cObj({ a: cStr }), clientNode.array(cStr)]), "union"],
    ["a mixed literal set", cLit("A", 1), "union"],
    ["a single-kind literal set", cLit("A", "B"), "string"],
  ];
  for (const [label, node, expected] of cases) {
    test(`${label} renders as "${expected}"`, () => {
      expect(describeClient(node)).toBe(expected);
    });
  }

  test("a scalar renders as its own type", () => {
    expect(describeClient(clientNode.scalar("boolean"))).toBe("boolean");
  });
});

describe("a validator this control cannot model is an UNKNOWN, never a verdict", () => {
  /**
   * ⚠️ THIS WAS A SILENT CLEAN PASS — the one verdict this control must never
   * produce. Every branch of the scalar comparison was guarded by
   * `SCALAR_OK[validator.type] && …`, so a type with no entry skipped every
   * check and fell through to `{findings: [], compatible: true}`: reported
   * VERIFIED where nothing was verified.
   *
   * It is reachable from a malformed or partial spec, not only from a future
   * Convex kind — `validatorTree` tests `DYNAMIC.has(type)` against the RAW
   * type, so a node with no `type` is not caught there and arrives as
   * `{kind: "scalar", type: "unknown"}`.
   */
  // ⚠️ `site` IS REQUIRED ON EVERY FINDING, and omitting it here was silent.
  // `finding()` spreads `ctx.site`, and spreading `undefined` contributes
  // nothing — so this helper produced findings with no identifier, file or
  // line, the three fields the production typedef declares mandatory. Nothing
  // failed because these assertions never read them, which is exactly how an
  // optional identifier reached the classifier once before.
  const compare = (client: unknown, node: unknown) =>
    compareNode(client as never, validatorTree(node as never), "field", {
      unproven: false,
      site: { identifier: "vehicles:update", file: "app/Uses.tsx", line: 1 },
    } as never);

  // ⚠️ THE THIRD ROW USED TO BE A DUPLICATE, AND ITS COMMENT SAID OTHERWISE.
  //
  // It claimed the literal branch was "a different way in". It is not: the
  // unmodelled-type check returns BEFORE the literal branch, so a literal
  // client against `decimal128` exits at exactly the same line as row 2 and
  // exercises nothing new. A reviewer disproved it after two independent seats
  // had been asked this precise question and confirmed the rows were distinct.
  //
  // The false comment was the worse half: a duplicate row costs a little
  // runtime, a comment asserting coverage that does not exist misleads whoever
  // reads it next. The literal branch is now covered by a test that genuinely
  // reaches it, below.
  test.each([
    ["a spec node with NO type", clientNode.scalar("string"), { value: undefined }],
    ["an unmodelled validator type", clientNode.scalar("boolean"), { type: "decimal128" }],
  ])("%s is UNKNOWN — never silently clean, never a fabricated BREAKING", (_label, client, node) => {
    const r = compare(client, node);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].severity).toBe(SEVERITY.TYPE_UNKNOWN);
    // Denying PASS is correct; inventing a defect we cannot substantiate is not.
    // An UNKNOWN blocks a release through the coverage path without claiming
    // something false, so `compatible` must stay true.
    expect(r.compatible).toBe(true);
    // Every finding must carry the site the production typedef declares
    // required. Omitting it from the context was silent for exactly as long as
    // nothing asserted it.
    expect(r.findings[0]).toMatchObject({ identifier: "vehicles:update", file: "app/Uses.tsx", line: 1 });
  });

  test("v.bytes() vs an OBJECT is UNKNOWN — an ArrayBuffer is indistinguishable from any object", () => {
    // ⚠️ A FABRICATED BREAKING ON CORRECT CODE, produced by the fix meant to
    // stop one. `SCALAR_OK.bytes` accepted the client type `"object"`, which the
    // extractor never emits (CASE 8 pins that), so a real ArrayBuffer took the
    // object branch and was reported BREAKING. Neither verdict is honest here:
    // accepting any object would be a false PASS in the other direction.
    const r = compare(clientNode.object(new Map(), true), { type: "bytes" });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].severity).toBe(SEVERITY.TYPE_UNKNOWN);
    expect(r.compatible).toBe(true);
  });

  test.each([
    ["a scalar", clientNode.scalar("string")],
    ["an array", clientNode.array(clientNode.scalar("number"))],
    ["a literal", clientNode.literal(new Set(["A"]))],
  ])("but v.bytes() vs %s stays BREAKING — those are provably not an ArrayBuffer", (_l, client) => {
    // Refusing to answer a question we CAN answer would be its own dishonesty.
    const r = compare(client, { type: "bytes" });
    expect(r.findings.some((f: { severity: string }) => f.severity === SEVERITY.BREAKING)).toBe(true);
    expect(r.compatible).toBe(false);
  });

  test("the LITERAL branch is reached for a modelled type, and still refuses a bad value", () => {
    // The branch the deleted row only claimed to cover. A modelled validator
    // type gets past the unmodelled-type return, so the literal comparison
    // actually runs — and `values` is a Set, which is what the ClientNode
    // typedef declares.
    const r = compare(clientNode.literal(new Set([1])), { type: "string" });
    expect(r.findings.some((f: { severity: string }) => f.severity === SEVERITY.BREAKING)).toBe(true);
    expect(r.compatible).toBe(false);
  });

  test("a MODELLED type still refuses a real mismatch — the fix did not soften the check", () => {
    const r = compare(clientNode.scalar("string"), { type: "boolean" });
    expect(r.findings.some((f: { severity: string }) => f.severity === SEVERITY.BREAKING)).toBe(true);
    expect(r.compatible).toBe(false);
  });
});

describe("Convex scalar semantics, not approximations of them", () => {
  /**
   * Both of these reported a payload as compatible that the live backend
   * refuses — a false PASS, which is the one verdict this control must never
   * produce.
   */
  test("v.int64() accepts ONLY bigint, so a client number is BREAKING", () => {
    // Convex models a 64-bit integer as a JavaScript BigInt. `number` and
    // `bigint` are distinct primitives and the validator refuses the former.
    expect(breaking(run(cObj({ n: clientNode.scalar("number") }), vObj({ n: [{ type: "int64" }] })))).toHaveLength(1);
  });

  test("and a client bigint is accepted", () => {
    expect(run(cObj({ n: clientNode.scalar("bigint") }), vObj({ n: [{ type: "int64" }] })).findings).toHaveLength(0);
  });

  test("v.bytes() is NOT a wildcard — a string is refused", () => {
    // Listing `bytes` as a dynamic kind turned the validator into `any`, which
    // ended the comparison before anything was checked and made the
    // SCALAR_OK.bytes entry unreachable dead code that read as coverage.
    expect(breaking(run(cObj({ b: cStr }), vObj({ b: [{ type: "bytes" }] })))).toHaveLength(1);
  });

  test("v.record() and v.any() remain genuinely dynamic", () => {
    // The fix must not over-correct: these two really do accept anything.
    for (const kind of ["any", "record", "unknown"]) {
      expect(run(cObj({ x: cStr }), vObj({ x: [{ type: kind }] })).findings).toHaveLength(0);
    }
  });
});

describe("scalars and shapes", () => {
  test("a number where the backend declares a string is breaking", () => {
    expect(breaking(run(cObj({ name: clientNode.scalar("number") }), vObj({ name: [vStr] })))).toHaveLength(1);
  });

  test("an object where the backend declares a scalar is breaking", () => {
    expect(breaking(run(cObj({ name: cObj({ a: cStr }) }), vObj({ name: [vStr] })))).toHaveLength(1);
  });

  test("an array where the backend declares an object is breaking", () => {
    expect(breaking(run(cObj({ p: clientNode.array(cStr) }), vObj({ p: [vObj({ a: [vStr] })] })))).toHaveLength(1);
  });

  test("a matching scalar is silent", () => {
    expect(run(cObj({ n: clientNode.scalar("number") }), vObj({ n: [vNum] })).findings).toHaveLength(0);
  });
});

describe("provenance — an unproven subtree cannot prove a defect", () => {
  /**
   * Presence in a TypeScript type is not transmission. The flat model answered
   * this with a one-level parent lookup on a path string, which could only ever
   * be right at exactly one depth; here the fact travels down the tree as far
   * as it is true.
   */
  const cField = (node: unknown, provenance: string) => ({ node, provenance });
  const cObjP = (fields: Record<string, { node: unknown; provenance: string }>, keysComplete = true) =>
    clientNode.object(new Map(Object.entries(fields)), keysComplete);

  test("an undeclared field that is only TYPE_OPTIONAL is unknown, not breaking", () => {
    const result = run(cObjP({ ghost: cField(cStr, "TYPE_OPTIONAL") }), vObj({ orgId: [vStr, true] }));
    expect(breaking(result)).toHaveLength(0);
    expect(result.findings[0].severity).toBe(SEVERITY.SHAPE_UNKNOWN);
    expect(result.findings[0].detail).toContain("transmission is unproven");
  });

  test("the same field, actually written at the call site, IS breaking", () => {
    const result = run(cObjP({ ghost: cField(cStr, "LITERAL") }), vObj({ orgId: [vStr, true] }));
    expect(breaking(result)).toHaveLength(1);
  });

  test("TYPE_REQUIRED and SPREAD also prove transmission", () => {
    for (const provenance of ["TYPE_REQUIRED", "SPREAD"]) {
      expect(breaking(run(cObjP({ ghost: cField(cStr, provenance) }), vObj({ orgId: [vStr, true] })))).toHaveLength(1);
    }
  });

  test("the downgrade reaches NESTED defects, not just the field itself", () => {
    // `maybe` may never be assigned, so a value mismatch two levels below it
    // has not been demonstrated either.
    const client = cObjP({ maybe: cField(cObj({ n: clientNode.scalar("number") }), "TYPE_OPTIONAL") });
    const spec = vObj({ maybe: [vObj({ n: [vStr] }), true] });
    const result = run(client, spec);
    expect(breaking(result)).toHaveLength(0);
    expect(paths(result)).toContain("maybe.n");
  });

  test("a required field missing from an unproven optional parent is not breaking", () => {
    const client = cObjP({ profile: cField(cObj({}), "TYPE_OPTIONAL") });
    const result = run(client, vObj({ profile: [vObj({ bio: [vStr] }), true] }));
    expect(breaking(result)).toHaveLength(0);
    expect(paths(result)).toContain("profile.bio");
  });
});

describe("client variants — every branch the client might send must be accepted", () => {
  test("a plain union where ONE branch is rejected is BREAKING — fail-closed stays fail-closed", () => {
    /**
     * ⚠️ THIS RULE IS NOT RELAXED FOR MIXTURES, AND AN EARLIER ATTEMPT TO
     * RELAX IT GLOBALLY WAS THE WRONG FIX.
     *
     * The client may send any ONE of these, so a refused member is a refused
     * payload. Weakening this globally to buy an answer for the
     * `activeOrgId!` shape would have silenced a real defect anywhere a union
     * happened to contain one acceptable branch — a far larger hole than the
     * one it closed. Assertion uncertainty is carried by the NODE instead; see
     * the assertion-narrowed test below.
     */
    const client = cObj({
      v: clientNode.variants([clientNode.scalar("string"), clientNode.scalar("number")]),
    });
    const result = run(client, vObj({ v: [vStr] }));
    expect(breaking(result)).toHaveLength(1);
    expect(breaking(result)[0].detail).toContain("number");
  });

  test("a union narrowed only by a `!` assertion is UNKNOWN — not breaking, and not clean", () => {
    /**
     * The same shape as above, differing ONLY by the flag the extractor sets
     * when a `!` was stripped. That flag is the whole difference between an
     * honest unknown and 15 fabricated outages, measured on the real repo.
     */
    const asserted = {
      ...clientNode.variants([clientNode.scalar("string"), clientNode.scalar("number")]),
      assertionNarrowed: true,
    };
    const result = run(cObj({ v: asserted }), vObj({ v: [vStr] }));
    expect(breaking(result)).toHaveLength(0);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe(SEVERITY.TYPE_UNKNOWN);
    // It must not go silent either — that would be the false PASS.
    expect(result.findings[0].detail).toContain("number");
  });

  test("a union where EVERY branch is rejected is still BREAKING", () => {
    // The other half of the rule. If no value the expression can produce is
    // acceptable, no execution of this call can succeed — that is proven, not
    // unproven, and downgrading it would be the false PASS this control exists
    // to prevent.
    const client = cObj({
      v: clientNode.variants([clientNode.scalar("number"), clientNode.scalar("boolean")]),
    });
    const result = breaking(run(client, vObj({ v: [vStr] })));
    // One per refused member — which also proves the members are judged
    // individually rather than collapsed into a single verdict.
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.detail).join(" ")).toContain("number");
    expect(result.map((f) => f.detail).join(" ")).toContain("boolean");
  });

  test("a union where every branch is accepted is silent", () => {
    const client = cObj({ v: clientNode.variants([cLit("A"), cLit("B")]) });
    expect(run(client, vObj({ v: [vUnion(vLit("A"), vLit("B"))] })).findings).toHaveLength(0);
  });

  test("a rejected variant REJECTS the payload, which steers union branch choice", () => {
    /**
     * Surfaced by a surviving mutant, then by a SECOND surviving mutant when
     * the first replacement test was built at the wrong depth: a variants node
     * is compared against the whole validator before any union branching
     * happens, so its `compatible` flag is only ever read by a PARENT. Findings
     * and incompatibility normally travel together; they come apart exactly
     * here. A union whose branches all fail reports the least noisy branch, but
     * only once no branch claims to be merely unproven — so a variants node
     * that wrongly reports itself compatible hijacks the explanation and prints
     * the noisiest branch instead.
     */
    const client = cObj({
      w: cObj({ p: clientNode.variants([clientNode.scalar("number"), clientNode.scalar("boolean")]) }),
    });
    const spec = vObj({
      w: [
        vUnion(
          vObj({ p: [vStr] }), // both variants are wrong here: 2 findings
          vObj({ p: [vNum] }) // only the boolean variant is wrong: 1 finding
        ),
      ],
    });
    const result = run(client, spec);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].detail).toContain("boolean");
  });

  test("identical findings from two variants are reported once", () => {
    const client = cObj({
      v: clientNode.variants([cObj({ extra: cStr }), cObj({ extra: cStr })]),
    });
    expect(breaking(run(client, vObj({ v: [vObj({})] })))).toHaveLength(1);
  });
});

describe("v.id(table) — what the client must prove, and what it need not", () => {
  /**
   * The authorized model (SCRUM-178 c14156), written out so a future change to
   * any row is a deliberate act rather than an accident:
   *
   *   string scalar / all-string literal    -> CLEAN
   *   number / boolean / bigint scalar      -> BREAKING
   *   literal containing a non-string       -> BREAKING
   *   object / array                        -> BREAKING
   *   unresolved / opaque                   -> UNKNOWN
   *   variants                              -> member-wise vs the WHOLE
   *                                            validator: all accepted CLEAN,
   *                                            all refused BREAKING,
   *                                            mixture UNKNOWN
   */
  const vId = (table = "organizations") => ({ type: "id", tableName: table });
  const unknowns = (r: { findings: { severity: string }[] }) =>
    r.findings.filter((f) => f.severity !== SEVERITY.BREAKING);

  test.each([
    ["number", clientNode.scalar("number")],
    ["boolean", clientNode.scalar("boolean")],
    ["bigint", clientNode.scalar("bigint")],
  ])("a %s scalar where the backend declares v.id() is BREAKING", (_label, node) => {
    /**
     * ⚠️ THE FALSE PASS THIS BLOCK EXISTS FOR. The branch used to reject only
     * `object` and `array` and return `compatible: true` for everything else,
     * so every one of these reported CLEAN. Convex `v.id()` accepts only a
     * string document id.
     */
    const result = run(cObj({ orgId: node }), vObj({ orgId: [vId()] }));
    expect(breaking(result)).toHaveLength(1);
    expect(paths(result)).toContain("orgId");
  });

  test("a literal containing a non-string is BREAKING", () => {
    expect(breaking(run(cObj({ orgId: cLit(42) }), vObj({ orgId: [vId()] })))).toHaveLength(1);
  });

  test("a literal of only strings is NOT proof of a document id", () => {
    // An arbitrary string literal is still only a string.
    const result = run(cObj({ orgId: cLit("abc") }), vObj({ orgId: [vId()] }));
    expect(breaking(result)).toHaveLength(0);
    expect(result.findings[0].severity).toBe(SEVERITY.TYPE_UNKNOWN);
  });

  test("a PROVEN same-table id is clean", () => {
    expect(
      run(cObj({ orgId: clientNode.id(["organizations"]) }), vObj({ orgId: [vId()] })).findings
    ).toHaveLength(0);
  });

  test("a PROVEN cross-table id is BREAKING", () => {
    // ⚠️ THE DEFECT THE TABLE DOMAIN EXISTS FOR. Before the brand was
    // preserved, `Id<"customers">` and `Id<"organizations">` were both
    // `scalar("string")` and this comparison could not be made at all.
    const result = run(cObj({ orgId: clientNode.id(["customers"]) }), vObj({ orgId: [vId()] }));
    expect(breaking(result)).toHaveLength(1);
    expect(breaking(result)[0].detail).toContain("different table");
  });

  test("a MIXED table domain must not clean-PASS", () => {
    const mixed = clientNode.id(["organizations", "customers"]);
    const result = run(cObj({ orgId: mixed }), vObj({ orgId: [vId()] }));
    expect(breaking(result)).toHaveLength(0);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe(SEVERITY.TYPE_UNKNOWN);
  });

  test("a proven id satisfies v.string() but NOT v.number()", () => {
    // A document id is a JavaScript string at runtime, so real subtype facts
    // are preserved rather than the node being treated as an opaque new kind.
    expect(run(cObj({ v: clientNode.id(["organizations"]) }), vObj({ v: [vStr] })).findings).toHaveLength(0);
    expect(breaking(run(cObj({ v: clientNode.id(["organizations"]) }), vObj({ v: [vNum] })))).toHaveLength(1);
  });

  test("an object or an array is BREAKING", () => {
    expect(breaking(run(cObj({ orgId: cObj({}) }), vObj({ orgId: [vId()] })))).toHaveLength(1);
    expect(breaking(run(cObj({ orgId: clientNode.array(cStr) }), vObj({ orgId: [vId()] })))).toHaveLength(1);
  });

  test.each([
    ["unresolved", clientNode.unresolved()],
    ["opaque", clientNode.opaqueValue()],
  ])("an %s value is UNKNOWN, never BREAKING and never silent", (_label, node) => {
    const result = run(cObj({ orgId: node }), vObj({ orgId: [vId()] }));
    expect(breaking(result)).toHaveLength(0);
    expect(unknowns(result).length).toBeGreaterThan(0);
  });

  test("an unbranded string is NOT VERIFIED — the wrong-table question stays open", () => {
    /**
     * ⚠️ THIS TEST PREVIOUSLY ASSERTED THE OPPOSITE AND CALLED IT A "STATED
     * LIMITATION". That was the superseded design: admitting a bare string as
     * clean, on the argument that demanding the brand would turn 1,170 of 1,321
     * comparisons into UNKNOWN.
     *
     * The correct reading of that same measurement is the other way round — the
     * 1,170 count is evidence that a semantic dimension was ERASED by the
     * extractor, not evidence that generic strings are sufficient proof. So the
     * brand is preserved at extraction, and a value that genuinely arrives
     * unbranded reports NOT VERIFIED rather than clean.
     */
    const result = run(cObj({ vehicleId: cStr }), vObj({ vehicleId: [vId("vehicles")] }));
    expect(breaking(result)).toHaveLength(0);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe(SEVERITY.TYPE_UNKNOWN);
    expect(result.findings[0].detail).toContain("NOT verified");
  });

  describe("the non-null-assertion shape, which is where this got decided", () => {
    // `orgId: activeOrgId!` extracts as `string | null`, because the extractor
    // strips `!` on purpose: it is erased at runtime and proves nothing.
    // The extractor marks the node when a `!` was stripped; the id itself is
    // real, so the only uncertainty is the nullability the assertion hid.
    const idOrNull = {
      ...clientNode.variants([cLit(null), clientNode.id(["organizations"])]),
      assertionNarrowed: true,
    };

    test("Id | null against a BARE v.id() is UNKNOWN", () => {
      const result = run(cObj({ orgId: idOrNull }), vObj({ orgId: [vId()] }));
      expect(breaking(result)).toHaveLength(0);
      expect(unknowns(result)).toHaveLength(1);
      expect(result.findings[0].severity).toBe(SEVERITY.TYPE_UNKNOWN);
    });

    test("...and is NOT reported clean either — silence here would be the false PASS", () => {
      expect(run(cObj({ orgId: idOrNull }), vObj({ orgId: [vId()] })).findings.length).toBeGreaterThan(0);
    });

    test("WITHOUT the assertion flag the same shape is BREAKING — the flag is what moves it", () => {
      // ⚠️ The control that stops the flag being decorative. If `assertionNarrowed`
      // were ignored, this and the test above would agree, and neither would be
      // testing anything.
      const plain = clientNode.variants([cLit(null), clientNode.id(["organizations"])]);
      expect(breaking(run(cObj({ orgId: plain }), vObj({ orgId: [vId()] })))).toHaveLength(1);
    });

    test("Id | null against v.union(v.id(), v.null()) is CLEAN", () => {
      /**
       * ⚠️ EACH MEMBER IS JUDGED AGAINST THE WHOLE VALIDATOR, UNIONS INCLUDED.
       * Judging a member against the `id` branch alone — while its sibling
       * `v.null()` branch sits right there accepting the value — fabricated 8
       * findings in the measurement harness that produced these numbers. The
       * identical mistake is available to any patch of this comparator.
       */
      const result = run(cObj({ orgId: idOrNull }), vObj({ orgId: [vUnion(vId(), vNull)] }));
      expect(result.findings).toHaveLength(0);
    });

    test("a variants node where EVERY member is refused by v.id() is BREAKING", () => {
      const allBad = clientNode.variants([clientNode.scalar("number"), clientNode.scalar("boolean")]);
      const result = breaking(run(cObj({ orgId: allBad }), vObj({ orgId: [vId()] })));
      expect(result).toHaveLength(2);
      expect(result.map((f) => f.detail).join(" ")).toContain("document id");
    });
  });
});

describe("merging id observations — the table survives only where it is still true", () => {
  const merge = mergeClientNodes;

  test("two ids UNION their tables — the field may carry either", () => {
    const merged = merge(clientNode.id(["organizations"]), clientNode.id(["customers"])) as unknown as {
      kind: string;
      tables: Set<string>;
    };
    expect(merged.kind).toBe("id");
    expect([...merged.tables].sort()).toEqual(["customers", "organizations"]);
  });

  test("an id beside a BARE STRING widens to string — the table is no longer proven", () => {
    /**
     * ⚠️ FOUND BY A SURVIVING MUTANT. Keeping the id here kills no test unless
     * this exists, and it is a false PASS manufactured by merging: one route
     * proves a table, the other proves nothing beyond "string", and the merged
     * value may have come from either. Keeping the id lets the branded route
     * LAUNDER the unbranded one into "table identity verified".
     */
    expect(merge(clientNode.id(["organizations"]), cStr).kind).toBe("scalar");
    // Both operand orders — merge is supposed to be symmetric here, and an
     // order-dependent answer would be its own defect.
    expect(merge(cStr, clientNode.id(["organizations"])).kind).toBe("scalar");
  });

  test("the widened result no longer clean-PASSes v.id()", () => {
    // The consequence stated as behaviour rather than as shape, so the test
    // still means something if the representation changes.
    const merged = merge(clientNode.id(["organizations"]), cStr);
    const result = run(cObj({ orgId: merged }), vObj({ orgId: [{ type: "id", tableName: "organizations" }] }));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe(SEVERITY.TYPE_UNKNOWN);
  });
});

describe("merging two observations of the same node", () => {
  const merge = mergeClientNodes;

  test("opacity is absorbing: one `any` route makes the value unverified", () => {
    expect(merge(cStr, clientNode.opaqueValue()).kind).toBe("opaqueValue");
    expect(merge(clientNode.opaqueValue(), cObj({ a: cStr })).kind).toBe("opaqueValue");
  });

  // ⚠️ THIS TEST USED TO ASSERT THE OPPOSITE, AND THAT IS WHY NOBODY CAUGHT IT.
  //
  // It read "unresolved yields to anything that was actually observed" and
  // pinned `merge(unresolved, scalar) === scalar`. A suite that asserts an
  // information loss is correct is worse than no test: two adversarial reviewer
  // seats and a CodeRabbit pass all read this file and none flagged the merge,
  // because the behaviour was documented as intended.
  //
  // `unresolved` never meant "empty accumulator" — the accumulator seeds with
  // `null`, handled by the `!a` branch above. Every producer of `unresolved`
  // means "I INSPECTED THIS AND COULD NOT CLASSIFY IT": an unreadable property
  // initialiser, a union that collapsed to nothing, a type `kindOfType` could
  // not name. That is a finding about the code, and it has to survive.
  //
  // MEASURED ON THE REAL REPOSITORY at 0d83ba7d1: 5 live absorptions across 918
  // call sites, all of the form `unresolved + literal(...) -> literal(...)` —
  // reached from the union-branch walk, where one branch resolved to an
  // enumeration and the other could not be classified at all. The extractor
  // then asserts the field can ONLY carry that enumeration.
  test("unresolved is ABSORBING — an unclassifiable route is never absorbed by a classified one", () => {
    expect(merge(clientNode.unresolved(), cStr).kind).toBe("unresolved");
    expect(merge(cStr, clientNode.unresolved()).kind).toBe("unresolved");
    // and the exact live shape: a literal enumeration must not swallow it
    expect(merge(clientNode.unresolved(), cLit("NONE")).kind).toBe("unresolved");
    expect(merge(cLit("NONE"), clientNode.unresolved()).kind).toBe("unresolved");
  });

  test("the seed is null, not unresolved — merging into an empty accumulator still works", () => {
    // The one case that legitimately yields: there is no observation yet at all.
    // If this broke, no merge could ever start, and making `unresolved`
    // absorbing would poison every accumulation from its first step.
    expect(merge(null as never, cStr)).toEqual(cStr);
    expect(merge(cStr, null as never)).toEqual(cStr);
  });

  test("objects union their fields and take the STRONGER provenance", () => {
    const a = clientNode.object(new Map([["x", { node: cStr, provenance: "TYPE_OPTIONAL" }]]), true);
    const b = clientNode.object(new Map([["x", { node: cStr, provenance: "LITERAL" }]]), true);
    expect(merge(a, b).fields.get("x").provenance).toBe("LITERAL");
  });

  test("key completeness is a conjunction — one unenumerable route loses it", () => {
    const known = cObj({ a: cStr });
    expect(merge(known, clientNode.opaqueKeys()).keysComplete).toBe(false);
    expect(merge(known, cObj({ b: cStr })).keysComplete).toBe(true);
  });

  test("literals accumulate into one enumeration", () => {
    expect([...merge(cLit("A"), cLit("B")).values].sort()).toEqual(["A", "B"]);
  });

  test("a literal beside its own scalar widens open and stops being provable", () => {
    const merged = merge(cLit("A"), cStr);
    expect(merged.kind).toBe("scalar");
    // and the widening is what makes the enumeration unverifiable
    const result = run(cObj({ status: merged }), vObj({ status: [vUnion(vLit("A"), vLit("B"))] }));
    expect(result.findings.map((f) => f.severity)).toContain(SEVERITY.TYPE_UNKNOWN);
  });

  test("incompatible shapes are kept as variants rather than collapsed", () => {
    const merged = merge(cObj({ a: cStr }), cStr);
    expect(merged.kind).toBe("variants");
    expect(merged.nodes).toHaveLength(2);
  });

  test("merging variants does not nest them", () => {
    const merged = merge(merge(cObj({ a: cStr }), cStr), clientNode.scalar("number"));
    expect(merged.nodes).toHaveLength(3);
    expect(merged.nodes.some((n: { kind: string }) => n.kind === "variants")).toBe(false);
  });

  test("arrays merge element-wise", () => {
    const merged = merge(clientNode.array(cLit("A")), clientNode.array(cLit("B")));
    expect(merged.kind).toBe("array");
    expect([...merged.element.values].sort()).toEqual(["A", "B"]);
  });
});

/**
 * ⚠️ LAYER 1 — THE RELATION ITSELF, ON DIRECTLY CONSTRUCTED PAIRS.
 *
 * ⚠️ WHY THIS LAYER EXISTS, AND WHY ADDING ONE REGRESSION WOULD NOT HAVE DONE.
 *
 * The layer below this one checks `merge(a,b)` against its own inputs. That is
 * the property that matters, and it is also the reason a real hole survived:
 * **the operation under test manufactures every specimen for its own oracle.**
 * `mergeClientNodes`'s object case UNIONS the two field maps, so the `wider`
 * argument it hands the relation is STRUCTURALLY GUARANTEED to be a field-set
 * superset of `narrower`. The branch that refuses a CLOSED wider claiming
 * fewer keys than a CLOSED narrower therefore could not be reached by any
 * merge-derived pair — deleting that branch left all 256 tests green.
 *
 * That was the FOURTH hole in this safety proof, and the fourth found by
 * something other than reading it. Adding a single `closed{a}` vs
 * `closed{a,c}` regression would have killed that one mutant while leaving the
 * cause untouched, so this layer instead asserts the relation DIRECTLY, from
 * hand-built pairs that no merge produced. The two layers now police different
 * things and neither can generate the other's inputs:
 *
 *   LAYER 1 (here)  — is the relation itself correct, in both directions?
 *   LAYER 2 (below) — does the real merge respect it?
 *
 * Each row states an EXPECTED answer, so a relation that drifts toward "yes"
 * and one that drifts toward "no" both fail. Rows are grouped by the structural
 * rule they exercise; every rule carries at least one admitting row AND one
 * refusing row, because a rule tested in only one direction is half-tested.
 */
describe("LAYER 1: the relation itself, on DIRECTLY CONSTRUCTED pairs", () => {
  const f = (node: unknown) => ({ node, provenance: "LITERAL" });
  const o = (fields: Record<string, unknown>, keysComplete = true) =>
    clientNode.object(new Map(Object.entries(fields).map(([k, v]) => [k, f(v)])), keysComplete);
  const arr = (element: unknown) => clientNode.array(element);
  const num = clientNode.scalar("number");
  const unres = () => clientNode.unresolved();

  /** [label, wider, narrower, wider admits narrower?] */
  const CASES: Array<[string, unknown, unknown, boolean]> = [
    // ── IGNORANCE IS THE TOP. Only total ignorance admits total ignorance. ──
    ["unresolved admits a scalar", unres(), cStr, true],
    ["unresolved admits a closed object", unres(), o({ a: cStr }), true],
    ["opaqueValue admits a scalar", clientNode.opaqueValue(), cStr, true],
    ["a scalar does NOT admit unresolved", cStr, unres(), false],
    ["a literal does NOT admit unresolved", cLit("A"), unres(), false],
    ["a closed object does NOT admit unresolved", o({ a: cStr }), unres(), false],
    ["an array does NOT admit unresolved", arr(cStr), unres(), false],

    // ── KEY DOMAIN. The dimension the merge-derived layer cannot reach. ──
    ["a closed key set admits itself", o({ a: cStr }), o({ a: cStr }), true],
    ["a closed SUPERSET admits a closed subset", o({ a: cStr, c: cStr }), o({ a: cStr }), true],
    // ⚠️ THE ROW THE SURVIVING MUTANT PROVED WAS MISSING.
    ["a closed key set does NOT admit a closed set with an EXTRA key", o({ a: cStr }), o({ a: cStr, c: cStr }), false],
    ["a closed key set does NOT admit an OPEN one", o({ a: cStr }), o({ a: cStr }, false), false],
    ["an OPEN key set admits a closed one", o({ a: cStr }, false), o({ a: cStr }), true],
    ["an OPEN key set admits another OPEN one", o({ a: cStr }, false), o({ a: cStr }, false), true],
    ["an OPEN key set is unconstrained on keys it does not name", o({ a: cStr }, false), o({ a: cStr, c: cStr }), true],
    ["opaqueKeys admits any closed object", clientNode.opaqueKeys(), o({ a: cStr }), true],
    ["an EMPTY closed object does NOT admit one carrying a key", o({}), o({ a: cStr }), false],

    // ── VALUE DETERMINACY, pointwise and INDEPENDENT of the key domain. ──
    ["a scalar field admits a literal field", o({ a: cStr }), o({ a: cLit("A") }), true],
    ["a literal field does NOT admit a scalar field", o({ a: cLit("A") }), o({ a: cStr }), false],
    ["an unresolved field admits a known field", o({ a: unres() }), o({ a: cStr }), true],
    ["a known field does NOT admit an unresolved field", o({ a: cStr }), o({ a: unres() }), false],
    ["a wider enumeration admits a narrower one", o({ a: cLit("A", "B") }), o({ a: cLit("A") }), true],
    ["a narrower enumeration does NOT admit a wider one", o({ a: cLit("A") }), o({ a: cLit("A", "B") }), false],
    // ⚠️ THE TWO DIMENSIONS ARE INDEPENDENT — an open key set does not excuse a
    // narrowed VALUE. This is the combination the retired scalar model could
    // not express at all, because it collapsed both onto one number.
    ["OPEN keys do NOT excuse a narrowed value", o({ a: cStr }, false), o({ a: unres() }, false), false],
    ["OPEN keys still admit a legitimately narrower value", o({ a: cStr }, false), o({ a: cLit("A") }, false), true],

    // ── RECURSION. The same two rules, one level down. ──
    ["nesting: an unresolved leaf is admitted by a known leaf's parent? NO", o({ a: o({ b: cStr }) }), o({ a: o({ b: unres() }) }), false],
    ["nesting: an unresolved leaf's parent admits a known leaf", o({ a: o({ b: unres() }) }), o({ a: o({ b: cStr }) }), true],
    ["nesting: an inner OPEN key set is not admitted by an inner CLOSED one", o({ a: o({ b: cStr }) }), o({ a: o({ b: cStr }, false) }), false],
    ["nesting: an inner OPEN key set admits an inner CLOSED one", o({ a: o({ b: cStr }, false) }), o({ a: o({ b: cStr }) }), true],

    // ── ARRAYS carry the element's determinacy. ──
    ["an array of scalar admits an array of literal", arr(cStr), arr(cLit("A")), true],
    ["an array of literal does NOT admit an array of scalar", arr(cLit("A")), arr(cStr), false],
    ["an array does NOT admit an array whose element is unresolved", arr(cStr), arr(unres()), false],
    ["an array of unresolved admits any array", arr(unres()), arr(cStr), true],
    ["any array admits the EMPTY array", arr(cStr), clientNode.emptyArray(), true],
    ["the EMPTY array does NOT admit a populated one", clientNode.emptyArray(), arr(cStr), false],
    ["an array does NOT admit a non-array", arr(cStr), cStr, false],

    // ── VARIANTS. Not knowing which alternative runs is itself partial. ──
    ["variants admit any one of their alternatives", clientNode.variants([cStr, num]), cStr, true],
    ["a single shape does NOT admit variants it is only part of", cStr, clientNode.variants([cStr, num]), false],
    // ⚠️ THESE TWO ROWS USED TO LIE. They passed `variants([cStr])`, and
    // `clientNode.variants` COLLAPSES a single-element array to the bare
    // element — so both compared a variants node against a plain scalar and
    // silently duplicated the two rows above, while their labels claimed
    // variants-vs-variants coverage. No coverage was lost (the merge-derived
    // layer reaches genuine bipartite comparisons), but a label asserting
    // coverage that does not exist is the same defect as a vacuous test.
    // Both sides are now genuinely multi-element.
    ["variants admit variants they fully cover", clientNode.variants([cStr, num, clientNode.literal(new Set(["A"]))]), clientNode.variants([cStr, num]), true],
    ["variants do NOT admit variants carrying an alternative they lack", clientNode.variants([cStr, num]), clientNode.variants([cStr, clientNode.emptyArray()]), false],

    // ── SCALARS AND LITERALS at the leaves. ──
    // ⚠️ FRESHLY CONSTRUCTED ON BOTH SIDES, ON PURPOSE. Reusing the shared
    // `cStr` constant as both operands made `wider === narrower` short-circuit
    // before the scalar comparison ever ran, so mutating that branch to `false`
    // left the ENTIRE repository suite green — 3917 passed. Fifth instance of
    // the same shape: the specimen construction masking the branch, not the
    // rule being wrong. Two independently built scalars are not the same
    // object, so these rows reach the comparison.
    ["a scalar admits an independently built scalar of the same type", clientNode.scalar("string"), clientNode.scalar("string"), true],
    ["a number scalar admits an independently built number scalar", clientNode.scalar("number"), clientNode.scalar("number"), true],
    ["the identity short-circuit still holds for the very same object", cStr, cStr, true],
    ["a scalar does NOT admit a different scalar", cStr, num, false],
    ["a scalar admits a literal of its own type", cStr, cLit("A"), true],
    ["a scalar does NOT admit a literal of another type", cStr, clientNode.literal(new Set([1])), false],
    ["a literal admits the same literal", cLit("A"), cLit("A"), true],
    ["a literal does NOT admit an unrelated shape", cLit("A"), o({ a: cStr }), false],
  ];

  test.each(CASES)("%s", (_label, wider, narrower, expected) => {
    expect(admitsAtLeast(wider as never, narrower as never)).toBe(expected);
  });

  test("the table exercises BOTH directions of every rule", () => {
    // A table that only ever expected `false` would be satisfied by a relation
    // that refuses everything, and one that only expected `true` by a relation
    // that admits everything. Both degenerate forms have shipped in this file's
    // history, so the balance is asserted rather than assumed.
    const admits = CASES.filter(([, , , e]) => e === true).length;
    const refuses = CASES.filter(([, , , e]) => e === false).length;
    expect(admits, "no admitting rows — a refuse-everything relation would pass").toBeGreaterThan(10);
    expect(refuses, "no refusing rows — an admit-everything relation would pass").toBeGreaterThan(10);
  });
});

/**
 * ⚠️ THE INVARIANT. Everything else in this file tests a case; this tests the
 * RULE that the cases are instances of.
 *
 * Three separate defects in this extractor were one design fault: it observed
 * part of a TypeScript shape and emitted a NARROWER result with FULL
 * confidence. Tuple extraction kept `args[0]` and dropped the rest; the key-set
 * check asked only about string index signatures and claimed completeness over
 * an open numeric domain; and `mergeClientNodes` let an unclassifiable route be
 * absorbed by a classified one.
 *
 * ⚠️ THE FIRST ATTEMPT AT THIS RULE WAS A SCALAR SCORE, AND IT WAS WRONG THREE
 * TIMES. `certaintyOf` ranked every node 0/1/2 and required
 * `rank(merge(a,b)) <= min(rank(a), rank(b))`. Each hole in it was found by
 * something other than reading it:
 *
 *   1. a mutant ranking every object fully certain regardless of `keysComplete`
 *      KILLED NOTHING — comparing a rank to a rank means inflating both sides
 *      equally keeps the inequality true, so a constant would have passed;
 *   2. `variants` returned a flat 1 while `array(unresolved)` ranks 0, so
 *      `merge(scalar, array(unresolved))` came out MORE certain than an input;
 *   3. an object with a complete key set and an `unresolved` field ranked 2 —
 *      identical to the same object with a fully known field.
 *
 * The third ended the approach rather than adding a fourth patch: making the
 * object case member-aware moved the violation onto `opaqueKeys`, because an
 * object has TWO independent dimensions — whether its KEY SET is complete, and
 * how determined its FIELD VALUES are — and no single total order ranks every
 * combination of two dimensions consistently.
 *
 * So the rule is no longer arithmetic. It is CONTAINMENT over what a node can
 * actually carry at runtime, which has no scalar to collapse:
 *
 *   MERGING TWO OBSERVATIONS MUST ADMIT AT LEAST EVERYTHING EACH OBSERVATION
 *   ADMITTED. Merging may widen what is possible, or keep uncertainty; it may
 *   never produce evidence narrower than an input.
 *
 * The compiler holds the other half: `admitsAtLeast` switches exhaustively over
 * `ClientNode`, so a node kind added later and left unhandled fails `tsc`
 * rather than falling through to a permissive answer.
 */
describe("LAYER 2: the real merge respects the relation — merging never produces evidence narrower than an input", () => {
  const f = (node: unknown) => ({ node, provenance: "LITERAL" });
  const objOf = (fields: Record<string, unknown>, keysComplete = true) =>
    clientNode.object(new Map(Object.entries(fields).map(([k, v]) => [k, f(v)])), keysComplete);

  /**
   * ⚠️ THE SPECIMEN SET IS WHERE ALL THREE EARLIER HOLES LIVED, not the rule.
   *
   * Every specimen in the scalar era was fully determined or fully unknown AT
   * ITS TOP LEVEL, so nothing exercised a node that looks determined from
   * outside while carrying zero information inside — which is exactly where
   * each violation was. Compound and nested shapes are first-class here.
   */
  const specimens: Array<[string, unknown]> = [
    ["unresolved", clientNode.unresolved()],
    ["opaqueValue", clientNode.opaqueValue()],
    ["opaqueKeys", clientNode.opaqueKeys()],
    ["literal(A)", cLit("A")],
    ["literal(B)", cLit("B")],
    ["scalar(string)", cStr],
    ["scalar(number)", clientNode.scalar("number")],
    // ⚠️ ADDED AFTER A SURVIVING MUTANT. Making `id + string` merge KEEP the id
    // instead of widening to string killed nothing, because no specimen here
    // was an id — the property could not see a dimension it never sampled.
    ["id{organizations}", clientNode.id(["organizations"])],
    ["id{customers}", clientNode.id(["customers"])],
    ["id{organizations,customers}", clientNode.id(["organizations", "customers"])],
    ["obj{a:scalar}", objOf({ a: cStr })],
    ["obj{a:unresolved}", objOf({ a: clientNode.unresolved() })],
    ["obj{a:scalar} OPEN keys", objOf({ a: cStr }, false)],
    ["obj{b:literal}", objOf({ b: cLit("A") })],
    ["array(literal)", clientNode.array(cLit("A"))],
    ["array(unresolved)", clientNode.array(clientNode.unresolved())],
    ["array(scalar)", clientNode.array(cStr)],
    ["emptyArray", clientNode.emptyArray()],
    ["variants[scalar,obj]", clientNode.variants([cStr, objOf({ a: cStr })])],
    ["array(variants)", clientNode.array(clientNode.variants([cStr, clientNode.scalar("number")]))],
    ["obj{a:array(unresolved)}", objOf({ a: clientNode.array(clientNode.unresolved()) })],
    ["obj{a:obj{b:unresolved}}", objOf({ a: objOf({ b: clientNode.unresolved() }) })],
  ];

  test("every pair: merge(a,b) admits at least everything a admits AND everything b admits", () => {
    const violations: string[] = [];
    for (const [an, a] of specimens) {
      for (const [bn, b] of specimens) {
        const merged = mergeClientNodes(a as never, b as never);
        if (!admitsAtLeast(merged as never, a as never)) {
          violations.push(`merge(${an}, ${bn}) does NOT admit LEFT ${an}`);
        }
        if (!admitsAtLeast(merged as never, b as never)) {
          violations.push(`merge(${an}, ${bn}) does NOT admit RIGHT ${bn}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("operand order cannot change what a merge admits", () => {
    // A field reached by two routes must not be narrower because the
    // classifiable route happened to be walked first.
    const asymmetric: string[] = [];
    for (const [an, a] of specimens) {
      for (const [bn, b] of specimens) {
        const ab = mergeClientNodes(a as never, b as never);
        const ba = mergeClientNodes(b as never, a as never);
        if (!admitsAtLeast(ab as never, ba as never) || !admitsAtLeast(ba as never, ab as never)) {
          asymmetric.push(`${an} + ${bn}: order changes what is admitted`);
        }
      }
    }
    expect(asymmetric).toEqual([]);
  });

  test("the relation is REFLEXIVE — every specimen admits itself", () => {
    // Without this the property above is satisfiable by a relation that says
    // "no" to everything, which would make the whole suite vacuous.
    for (const [name, node] of specimens) {
      expect(admitsAtLeast(node as never, node as never), `${name} does not admit itself`).toBe(true);
    }
  });

  test("total ignorance admits everything, and only total ignorance admits it back", () => {
    // The asymmetry that makes absorbing `unresolved` correct. If this were
    // symmetric, an unclassifiable route could be swallowed by a classified one
    // and the relation would not notice — the original LIVE defect.
    for (const [name, node] of specimens) {
      expect(admitsAtLeast(clientNode.unresolved() as never, node as never), `unresolved should admit ${name}`).toBe(true);
    }
    expect(admitsAtLeast(cStr as never, clientNode.unresolved() as never)).toBe(false);
    expect(admitsAtLeast(cLit("A") as never, clientNode.unresolved() as never)).toBe(false);
    expect(admitsAtLeast(objOf({ a: cStr }) as never, clientNode.unresolved() as never)).toBe(false);
  });

  test("each way of knowing less is NOT admitted by the same node knowing more", () => {
    // The direction that catches a narrowing. Stated per dimension, because
    // conflating the two dimensions onto one scale is what failed three times.
    //
    // VALUE dimension: a determined field cannot stand in for an unresolved one.
    expect(admitsAtLeast(objOf({ a: cStr }) as never, objOf({ a: clientNode.unresolved() }) as never)).toBe(false);
    expect(admitsAtLeast(clientNode.array(cStr) as never, clientNode.array(clientNode.unresolved()) as never)).toBe(false);
    // KEY dimension: a closed key set cannot stand in for an open one.
    expect(admitsAtLeast(objOf({ a: cStr }) as never, objOf({ a: cStr }, false) as never)).toBe(false);
    // ...and the two are INDEPENDENT: open keys do not excuse a narrowed value,
    // which is the case the scalar model could not express at all.
    expect(admitsAtLeast(objOf({ a: cStr }, false) as never, objOf({ a: clientNode.unresolved() }, false) as never)).toBe(false);
    // Narrowing an enumeration is a narrowing too.
    expect(admitsAtLeast(cLit("A") as never, clientNode.literal(new Set(["A", "B"])) as never)).toBe(false);
  });

  test("legitimate widening IS admitted — the relation is not simply refusing", () => {
    // A relation that answers "no" often enough passes the property test while
    // proving nothing. These are the widenings the extractor really performs.
    expect(admitsAtLeast(clientNode.literal(new Set(["A", "B"])) as never, cLit("A") as never)).toBe(true);
    expect(admitsAtLeast(cStr as never, cLit("A") as never)).toBe(true);
    expect(admitsAtLeast(objOf({ a: cStr }, false) as never, objOf({ a: cStr }) as never)).toBe(true);
    expect(admitsAtLeast(clientNode.variants([cStr, clientNode.scalar("number")]) as never, cStr as never)).toBe(true);
    expect(admitsAtLeast(clientNode.array(cStr) as never, clientNode.emptyArray() as never)).toBe(true);
  });
});
