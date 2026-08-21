import { describe, expect, test } from "vitest";
import { validatorTree, clientNode, compareNode, SEVERITY } from "./contractTree.mjs";

/**
 * The tree model has to re-establish, from scratch, every case the flat model
 * got wrong — plus the two historical incidents SCRUM-178 exists for. These are
 * written against the model directly so a failure points at the representation
 * rather than at the plumbing around it.
 */

const ctx = { site: { identifier: "w:save", file: "x.tsx", line: 1 } };
const run = (client: unknown, validatorSpec: unknown) =>
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
