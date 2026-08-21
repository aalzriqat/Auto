import { describe, expect, test } from "vitest";
import {
  validatorTree,
  clientNode,
  compareNode,
  mergeClientNodes,
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

const breaking = (r: { findings: { severity: string }[] }) =>
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
  test("a union where ONE branch is rejected is breaking", () => {
    const client = cObj({
      v: clientNode.variants([clientNode.scalar("string"), clientNode.scalar("number")]),
    });
    expect(breaking(run(client, vObj({ v: [vStr] })))).toHaveLength(1);
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

describe("merging two observations of the same node", () => {
  const merge = mergeClientNodes;

  test("opacity is absorbing: one `any` route makes the value unverified", () => {
    expect(merge(cStr, clientNode.opaqueValue()).kind).toBe("opaqueValue");
    expect(merge(clientNode.opaqueValue(), cObj({ a: cStr })).kind).toBe("opaqueValue");
  });

  test("unresolved yields to anything that was actually observed", () => {
    expect(merge(clientNode.unresolved(), cStr)).toEqual(cStr);
    expect(merge(cStr, clientNode.unresolved())).toEqual(cStr);
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
