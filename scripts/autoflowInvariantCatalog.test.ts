import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  AUTOFLOW_INVARIANTS,
  structuralProofHasNegativeControlSource,
  validateInvariantCatalog,
  type InvariantDefinition,
} from "./autoflowInvariantCatalog";

const ROOT = path.resolve(__dirname, "..");

/**
 * Deliberately independent from AUTOFLOW_INVARIANTS.
 *
 * Deriving this list from the catalog would let deleting an invariant shrink the
 * expectation and the implementation in one edit. Updating this ratchet must be
 * an explicit review decision.
 */
const REQUIRED_INVARIANT_IDS = [
  "ACC-1",
  "ACC-2",
  "ACC-3",
  "AUTH-1",
  "CONC-1",
  "CONS-1",
  "ECON-1",
  "ECON-2",
  "LIFE-1",
  "PERF-1",
  "TEN-1",
  "UI-1",
] as const;

function copyCatalog(): InvariantDefinition[] {
  return AUTOFLOW_INVARIANTS.map((invariant) => ({
    ...invariant,
    sourceAreas: [...invariant.sourceAreas],
    proofs: invariant.proofs.map((proof) => ({ ...proof })),
  }));
}

describe("SCRUM-342 invariant catalog — current repository", () => {
  test("the catalog is internally valid and every referenced proof exists", () => {
    expect(validateInvariantCatalog(ROOT)).toEqual([]);
  });

  test("required invariant families cannot silently disappear", () => {
    const actual = AUTOFLOW_INVARIANTS.map((invariant) => invariant.id).sort();
    expect(actual).toEqual([...REQUIRED_INVARIANT_IDS].sort());
  });

  test("every PARTIAL invariant has one explicit Jira owner for the remaining gap", () => {
    const unowned = AUTOFLOW_INVARIANTS.filter(
      (invariant) => invariant.state === "PARTIAL" && !/^SCRUM-\d+$/.test(invariant.tracking ?? "")
    ).map((invariant) => invariant.id);

    expect(unowned).toEqual([]);
  });
});

describe("SCRUM-342 invariant catalog — negative controls", () => {
  test("NEGATIVE CONTROL: duplicate invariant IDs are refused", () => {
    const broken = copyCatalog();
    broken.push({ ...broken[0], sourceAreas: [...broken[0].sourceAreas], proofs: [...broken[0].proofs] });

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      "Duplicate invariant id: " + broken[0].id
    );
  });

  test("NEGATIVE CONTROL: silently deleting a required invariant fails the independent ratchet", () => {
    const reduced = AUTOFLOW_INVARIANTS.filter((invariant) => invariant.id !== "TEN-1");
    const actual = reduced.map((invariant) => invariant.id).sort();

    expect(actual).not.toEqual([...REQUIRED_INVARIANT_IDS].sort());
    expect(REQUIRED_INVARIANT_IDS).toContain("TEN-1");
  });

  test("NEGATIVE CONTROL: a missing proof file is refused", () => {
    const broken = copyCatalog();
    broken[0].proofs = [
      ...broken[0].proofs,
      {
        path: "convex/this-proof-does-not-exist.test.ts",
        kind: "EXECUTION",
        note: "Synthetic negative control for the catalog file-existence guard.",
      },
    ];

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[0].id + " proof file does not exist: convex/this-proof-does-not-exist.test.ts"
    );
  });

  test("NEGATIVE CONTROL: a PARTIAL invariant without a Jira owner is refused", () => {
    const broken = copyCatalog();
    const index = broken.findIndex((invariant) => invariant.state === "PARTIAL");
    broken[index] = { ...broken[index], tracking: undefined };

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id + " is PARTIAL without a SCRUM tracking issue"
    );
  });

  test("NEGATIVE CONTROL: a structural proof cannot merely claim to be proof", () => {
    const broken = copyCatalog();
    const index = broken.findIndex((invariant) =>
      invariant.proofs.some((proof) => proof.kind === "STRUCTURAL")
    );
    const proofIndex = broken[index].proofs.findIndex((proof) => proof.kind === "STRUCTURAL");
    broken[index].proofs[proofIndex] = {
      ...broken[index].proofs[proofIndex],
      negativeControl: false,
    };

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id +
        " structural proof is not declared negative-controlled: " +
        broken[index].proofs[proofIndex].path
    );
  });

  test("NEGATIVE CONTROL: CRITICAL+ENFORCED cannot be certified by source shape alone", () => {
    const broken = copyCatalog();
    const index = broken.findIndex(
      (invariant) => invariant.severity === "CRITICAL" && invariant.state === "ENFORCED"
    );
    broken[index] = {
      ...broken[index],
      proofs: [
        {
          path: "scripts/economicCommandCensus.test.ts",
          kind: "STRUCTURAL",
          negativeControl: true,
          note: "Synthetic structural-only evidence for the catalog negative control.",
        },
      ],
    };

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id +
        " is CRITICAL+ENFORCED but relies only on structural/manual evidence; execution or preview evidence is required"
    );
  });

  test("the structural negative-control marker detector itself has positive and negative controls", () => {
    expect(structuralProofHasNegativeControlSource("NEGATIVE CONTROL — remove the writer")).toBe(true);
    expect(structuralProofHasNegativeControlSource("FAULT 3: hidden caller")).toBe(true);
    expect(structuralProofHasNegativeControlSource("the self-tests come first")).toBe(true);
    expect(structuralProofHasNegativeControlSource("everything is green")).toBe(false);
  });
});
