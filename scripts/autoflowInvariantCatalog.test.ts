import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  AUTOFLOW_INVARIANTS,
  isActiveInvariant,
  structuralProofHasNegativeControlSource,
  validateInvariantCatalog,
  type InvariantDefinition,
  type ProofObligation,
} from "./autoflowInvariantCatalog";

const ROOT = path.resolve(__dirname, "..");

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
    symbols: invariant.symbols ? [...invariant.symbols] : undefined,
    profile: { ...invariant.profile },
    requirements: invariant.requirements.map((requirement) => ({
      ...requirement,
      acceptedEvidence: requirement.acceptedEvidence
        ? [...requirement.acceptedEvidence]
        : undefined,
    })),
    proofs: invariant.proofs.map((proof) => ({
      ...proof,
      obligations: [...proof.obligations],
    })),
    retirement: invariant.retirement
      ? {
          ...invariant.retirement,
          supersededBy: invariant.retirement.supersededBy
            ? [...invariant.retirement.supersededBy]
            : undefined,
        }
      : undefined,
  }));
}

function findWithRequirement(
  catalog: InvariantDefinition[],
  obligation: ProofObligation
): number {
  return catalog.findIndex((invariant) =>
    invariant.requirements.some(
      (requirement) =>
        requirement.obligation === obligation && requirement.status === "REQUIRED"
    )
  );
}

describe("SCRUM-342 invariant catalog — current repository", () => {
  test("the catalog is internally valid and every referenced proof exists", () => {
    expect(validateInvariantCatalog(ROOT)).toEqual([]);
  });

  test("required invariant IDs cannot silently disappear or be renamed", () => {
    const actual = AUTOFLOW_INVARIANTS.map((invariant) => invariant.id).sort();
    expect(actual).toEqual([...REQUIRED_INVARIANT_IDS].sort());
  });

  test("the active catalog cannot vacuously collapse to zero", () => {
    expect(AUTOFLOW_INVARIANTS.filter(isActiveInvariant).length).toBeGreaterThan(0);
    expect(validateInvariantCatalog(ROOT, [])).toContain(
      "Invariant catalog has no active invariants"
    );
  });

  test("every PARTIAL invariant declares an explicit Jira owner", () => {
    const unowned = AUTOFLOW_INVARIANTS.filter(
      (invariant) =>
        invariant.state === "PARTIAL" &&
        !/^SCRUM-\d+$/.test(invariant.tracking ?? "")
    ).map((invariant) => invariant.id);

    expect(unowned).toEqual([]);
  });

  test("ENFORCED is derived from a catalog with no deferred obligations", () => {
    const invalid = AUTOFLOW_INVARIANTS.filter(
      (invariant) =>
        invariant.state === "ENFORCED" &&
        invariant.requirements.some((requirement) => requirement.status === "DEFERRED")
    ).map((invariant) => invariant.id);

    expect(invalid).toEqual([]);
  });
});

describe("SCRUM-342 invariant catalog — validator negative controls", () => {
  test("NEGATIVE CONTROL: duplicate invariant IDs are refused", () => {
    const broken = copyCatalog();
    broken.push(copyCatalog()[0]);

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      "Duplicate invariant id: " + broken[0].id
    );
  });

  test("NEGATIVE CONTROL: deleting a required ID fails the independent ratchet", () => {
    const reduced = AUTOFLOW_INVARIANTS.filter((invariant) => invariant.id !== "TEN-1");
    const actual = reduced.map((invariant) => invariant.id).sort();

    expect(actual).not.toEqual([...REQUIRED_INVARIANT_IDS].sort());
    expect(REQUIRED_INVARIANT_IDS).toContain("TEN-1");
  });

  test("NEGATIVE CONTROL: a missing proof file is refused", () => {
    const broken = copyCatalog();
    broken[0].proofs.push({
      path: "convex/this-proof-does-not-exist.test.ts",
      mechanism: "EXECUTION",
      obligations: ["NEGATIVE"],
      note: "Synthetic negative control for the catalog file-existence guard.",
    });

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[0].id +
        " proof file does not exist: convex/this-proof-does-not-exist.test.ts"
    );
  });

  test("NEGATIVE CONTROL: a stale proof marker is refused", () => {
    const broken = copyCatalog();
    broken[0].proofs[0] = {
      ...broken[0].proofs[0],
      marker: "SCRUM-342-MARKER-THAT-DOES-NOT-EXIST",
    };

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[0].id +
        " proof marker is missing from " +
        broken[0].proofs[0].path +
        ": SCRUM-342-MARKER-THAT-DOES-NOT-EXIST"
    );
  });

  test("NEGATIVE CONTROL: PARTIAL without Jira ownership is refused", () => {
    const broken = copyCatalog();
    const index = broken.findIndex((invariant) => invariant.state === "PARTIAL");
    broken[index] = { ...broken[index], tracking: undefined };

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id + " is PARTIAL without a SCRUM tracking issue"
    );
  });

  test("NEGATIVE CONTROL: a structural proof must demonstrate its own failure mode", () => {
    const broken = copyCatalog();
    const index = broken.findIndex((invariant) =>
      invariant.proofs.some((proof) => proof.mechanism === "STRUCTURAL")
    );
    const proofIndex = broken[index].proofs.findIndex(
      (proof) => proof.mechanism === "STRUCTURAL"
    );
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

  test("NEGATIVE CONTROL: a REQUIRED obligation cannot exist without acceptable evidence", () => {
    const broken = copyCatalog();
    const index = findWithRequirement(broken, "NEGATIVE");
    broken[index].proofs = broken[index].proofs.map((proof) => ({
      ...proof,
      obligations: proof.obligations.filter((obligation) => obligation !== "NEGATIVE"),
    }));

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id + " is missing required proof obligation NEGATIVE"
    );
  });

  test("NEGATIVE CONTROL: ENFORCED cannot hide a deferred proof obligation", () => {
    const broken = copyCatalog();
    const index = broken.findIndex((invariant) => invariant.state === "ENFORCED");
    broken[index].requirements.push({
      obligation: "PROPERTY",
      status: "DEFERRED",
      reason: "Synthetic deferred property obligation for the validator negative control.",
      tracking: "SCRUM-342",
    });

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id + " is ENFORCED while PROPERTY is still DEFERRED"
    );
  });

  test("NEGATIVE CONTROL: NOT_APPLICABLE requires a real rationale", () => {
    const broken = copyCatalog();
    const index = broken.findIndex((invariant) =>
      invariant.requirements.some(
        (requirement) => requirement.status === "NOT_APPLICABLE"
      )
    );
    const requirementIndex = broken[index].requirements.findIndex(
      (requirement) => requirement.status === "NOT_APPLICABLE"
    );
    broken[index].requirements[requirementIndex] = {
      ...broken[index].requirements[requirementIndex],
      reason: "",
    };

    const obligation = broken[index].requirements[requirementIndex].obligation;
    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id +
        " marks " +
        obligation +
        " NOT_APPLICABLE without a meaningful rationale"
    );
  });

  test("NEGATIVE CONTROL: DEFERRED requires its own Jira ownership", () => {
    const broken = copyCatalog();
    const index = broken.findIndex((invariant) =>
      invariant.requirements.some((requirement) => requirement.status === "DEFERRED")
    );
    const requirementIndex = broken[index].requirements.findIndex(
      (requirement) => requirement.status === "DEFERRED"
    );
    broken[index].requirements[requirementIndex] = {
      ...broken[index].requirements[requirementIndex],
      tracking: undefined,
    };

    const obligation = broken[index].requirements[requirementIndex].obligation;
    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id +
        " defers " +
        obligation +
        " without a SCRUM tracking issue"
    );
  });

  test("NEGATIVE CONTROL: tenant sensitivity requires executable TENANCY proof", () => {
    const broken = copyCatalog();
    const index = broken.findIndex((invariant) => invariant.profile.tenantSensitive);
    const requirementIndex = broken[index].requirements.findIndex(
      (requirement) => requirement.obligation === "TENANCY"
    );
    broken[index].requirements[requirementIndex] = {
      obligation: "TENANCY",
      status: "NOT_APPLICABLE",
      reason: "Synthetic invalid classification used only by this negative control.",
    };

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id + " is tenant-sensitive without required TENANCY proof"
    );
  });

  test("NEGATIVE CONTROL: direct economic invariants must explicitly assess core economic risks", () => {
    const broken = copyCatalog();
    const index = broken.findIndex(
      (invariant) => invariant.profile.economicImpact === "DIRECT"
    );
    broken[index].requirements = broken[index].requirements.filter(
      (requirement) => requirement.obligation !== "CONCURRENCY"
    );

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id +
        " has DIRECT economic impact without explicit CONCURRENCY assessment"
    );
  });

  test("NEGATIVE CONTROL: evidence cannot claim an undeclared obligation", () => {
    const broken = copyCatalog();
    const index = broken.findIndex((invariant) => invariant.proofs.length > 0);
    const obligation = broken[index].proofs[0].obligations[0];
    broken[index].requirements = broken[index].requirements.filter(
      (requirement) => requirement.obligation !== obligation
    );

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id +
        " proof references undeclared obligation " +
        obligation +
        ": " +
        broken[index].proofs[0].path
    );
  });

  test("NEGATIVE CONTROL: retirement cannot be silent deletion-by-label", () => {
    const broken = copyCatalog();
    broken[0] = { ...broken[0], state: "RETIRED", retirement: undefined };

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[0].id + " retirement metadata is incomplete"
    );
  });

  test("NEGATIVE CONTROL: SUPERSEDED requires replacement invariant IDs", () => {
    const broken = copyCatalog();
    broken[0] = {
      ...broken[0],
      state: "SUPERSEDED",
      retirement: {
        reason: "Synthetic retirement record for the validator negative control.",
        tracking: "SCRUM-342",
      },
    };

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[0].id + " is SUPERSEDED without replacement invariant IDs"
    );
  });

  test("the structural marker detector has positive and negative controls", () => {
    expect(
      structuralProofHasNegativeControlSource("NEGATIVE CONTROL — remove the writer")
    ).toBe(true);
    expect(structuralProofHasNegativeControlSource("FAULT 3: hidden caller")).toBe(true);
    expect(structuralProofHasNegativeControlSource("the self-tests come first")).toBe(true);
    expect(structuralProofHasNegativeControlSource("everything is green")).toBe(false);
  });
});
