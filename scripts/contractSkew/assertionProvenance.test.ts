import { describe, expect, test } from "vitest";
import { extractClientCalls } from "./clientPaths.mjs";
import { admitsAtLeast, compareNode, validatorTree } from "./contractTree.mjs";

const FIXTURE = "scripts/contractSkew/__fixtures__/assertionProvenanceCases.ts";

type ClientNode = Parameters<typeof compareNode>[0];
type ExtractedCall = {
  identifier: string;
  file: string;
  line: number;
  payload: ClientNode | null;
};

const extracted = extractClientCalls([FIXTURE], "tsconfig.json");
const calls = extracted.calls as ExtractedCall[];

const callOf = (name: string) => {
  const call = calls.find((candidate) => candidate.identifier === `assertions:${name}`);
  expect(call, `fixture call assertions:${name} did not extract`).toBeDefined();
  return call!;
};

const fieldAt = (name: string, field = "orgId"): ClientNode => {
  const payload = callOf(name).payload;
  expect(payload?.kind).toBe("object");
  if (!payload || payload.kind !== "object") throw new Error(`${name} did not extract an object`);
  const entry = payload.fields.get(field);
  expect(entry, `${name}.${field} did not extract`).toBeDefined();
  return entry!.node;
};

const orgIdValidator = validatorTree({ type: "id", tableName: "organizations" });
const orgIdFieldValidator = validatorTree({
  type: "object",
  value: { orgId: { fieldType: { type: "id", tableName: "organizations" }, optional: false } },
});

const compareCall = (name: string, validator = orgIdFieldValidator) => {
  const call = callOf(name);
  expect(call.payload, `${name} resolved no payload`).not.toBeNull();
  return compareNode(call.payload!, validator, "", { site: call });
};

describe("assertion provenance through the real TypeChecker and extractor", () => {
  test.each([
    "directAs",
    "angleAssertion",
    "assertedSpread",
    "conditionalAssertion",
    "aliasAssertion",
    "callArgumentAssertion",
    "calleeBodyAssertion",
    "propertyAccessAssertion",
    "mutableAssertion",
  ])("%s cannot manufacture clean same-table Id evidence", (name) => {
    const result = compareCall(name);
    expect(result.compatible).toBe(true);
    expect(result.findings.filter((finding) => finding.severity === "BREAKING")).toHaveLength(0);
    expect(result.findings.length, `${name} silently passed`).toBeGreaterThan(0);
    expect(result.findings.some((finding) => finding.severity === "TYPE_UNKNOWN")).toBe(true);
  });

  test("assertion-free Id provenance remains table-qualified", () => {
    expect(compareCall("provenSameTable").findings).toHaveLength(0);
    const cross = compareCall("provenCrossTable");
    expect(cross.compatible).toBe(false);
    expect(cross.findings.some((finding) => finding.detail.includes("different table"))).toBe(true);
  });

  test.each(["numberAssertion", "crossTableAssertion"])(
    "%s: an assertion cannot hide a definite mismatch",
    (name) => {
      const mismatch = compareCall(name);
      expect(mismatch.compatible, `${name} was incorrectly compatible`).toBe(false);
      expect(mismatch.findings.some((finding) => finding.severity === "BREAKING")).toBe(true);
    }
  );

  test("a redundant assertion does not discard independently proven same-table evidence", () => {
    expect(compareCall("redundantIdAssertion").findings).toHaveLength(0);
  });

  test.each([
    ["directAs", "baselineRaw"],
    ["angleAssertion", "baselineRaw"],
    ["assertedSpread", "baselineSpread"],
    ["conditionalAssertion", "conditionalBaseline"],
    ["aliasAssertion", "aliasBaseline"],
    ["callArgumentAssertion", "callArgumentBaseline"],
  ])("metamorphic: adding an assertion in %s never increases trust", (asserted, baseline) => {
    expect(admitsAtLeast(fieldAt(asserted), fieldAt(baseline))).toBe(true);
  });

  test("the metamorphic oracle is anti-vacuous for genuinely proven ids", () => {
    const proven = fieldAt("provenSameTable");
    const generic = fieldAt("baselineRaw");
    expect(admitsAtLeast(proven, generic)).toBe(false);
    expect(admitsAtLeast(generic, proven)).toBe(true);
  });
});

describe("non-null assertion uncertainty is attached only to erased alternatives", () => {
  test.each(["spreadNonNull", "queryNonNull"])("%s preserves uncertainty through normalization", (name) => {
    const result = compareCall(name);
    expect(result.compatible).toBe(true);
    expect(result.findings.filter((finding) => finding.severity === "BREAKING")).toHaveLength(0);
    expect(result.findings.some((finding) => finding.severity === "TYPE_UNKNOWN")).toBe(true);
  });

  test("a later resolved spread overwrites an earlier asserted property", () => {
    const result = compareCall("spreadAfterNonNull");
    expect(result.compatible).toBe(false);
    expect(result.findings.some((finding) => finding.severity === "BREAKING")).toBe(true);
  });

  test("an opaque spread only obscures values assigned before it", () => {
    const obscured = compareCall("opaqueSpreadAfterId");
    expect(obscured.compatible).toBe(true);
    expect(obscured.findings.some((finding) => finding.severity === "TYPE_UNKNOWN")).toBe(true);
    expect(compareCall("idAfterOpaqueSpread").findings).toHaveLength(0);
  });

  test("array element merging preserves uncertainty", () => {
    const result = compareCall(
      "arrayNonNull",
      validatorTree({
        type: "object",
        value: {
          orgIds: {
            fieldType: { type: "array", value: { type: "id", tableName: "organizations" } },
            optional: false,
          },
        },
      })
    );
    expect(result.compatible).toBe(true);
    expect(result.findings.filter((finding) => finding.severity === "BREAKING")).toHaveLength(0);
    expect(result.findings.some((finding) => finding.severity === "TYPE_UNKNOWN")).toBe(true);
  });

  test("a no-op non-null assertion cannot excuse an unrelated number alternative", () => {
    const result = compareCall("noOpNonNull");
    expect(result.compatible).toBe(false);
    expect(result.findings.some((finding) => finding.severity === "BREAKING")).toBe(true);
  });

  test("ordinary Id|string merging remains generic rather than table-qualified", () => {
    const result = compareNode(fieldAt("idBesideString"), orgIdValidator, "orgId", {
      site: callOf("idBesideString"),
    });
    expect(result.compatible).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("TYPE_UNKNOWN");
  });
});
