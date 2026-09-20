import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  AUTOFLOW_INVARIANTS,
  isActiveInvariant,
  structuralProofHasExecutableNegativeControl,
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

  test("NEGATIVE CONTROL: mandatory obligation assessments cannot silently disappear", () => {
    const broken = copyCatalog();
    const index = broken.findIndex((invariant) => invariant.id === "ACC-3");
    broken[index].requirements = broken[index].requirements.filter(
      (requirement) => requirement.obligation !== "BOUNDARY"
    );

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      "ACC-3 is missing mandatory obligation assessment BOUNDARY"
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
    broken[0].proofs = [
      ...broken[0].proofs,
      {
        invariantId: broken[0].id,
        path: "convex/this-proof-does-not-exist.test.ts",
        mechanism: "EXECUTION",
        obligations: ["NEGATIVE"],
        note: "Synthetic negative control for the catalog file-existence guard.",
      },
    ];

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[0].id +
        " proof file does not exist: convex/this-proof-does-not-exist.test.ts"
    );
  });

  test("NEGATIVE CONTROL: proof without a stable marker is refused", () => {
    const broken = copyCatalog();
    broken[0].proofs = broken[0].proofs.map((proof, index) =>
      index === 0 ? { ...proof, marker: undefined } : proof
    );

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[0].id + " proof has no stable marker: " + broken[0].proofs[0].path
    );
  });

  test("NEGATIVE CONTROL: a stale proof marker is refused", () => {
    const broken = copyCatalog();
    broken[0].proofs = broken[0].proofs.map((proof, index) =>
      index === 0
        ? { ...proof, marker: "SCRUM-342-MARKER-THAT-DOES-NOT-EXIST" }
        : proof
    );

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[0].id +
        " proof marker is missing or not an active executable test marker in " +
        broken[0].proofs[0].path +
        ": SCRUM-342-MARKER-THAT-DOES-NOT-EXIST"
    );
  });

  test("NEGATIVE CONTROL: evidence cannot reference an unknown invariant ID", () => {
    const broken = copyCatalog();
    broken[0].proofs = broken[0].proofs.map((proof, index) =>
      index === 0 ? { ...proof, invariantId: "NOPE-999" } : proof
    );

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[0].id + " proof references unknown invariant ID NOPE-999"
    );
  });

  test("NEGATIVE CONTROL: evidence cannot be bound to a different existing invariant", () => {
    const broken = copyCatalog();
    broken[0].proofs = broken[0].proofs.map((proof, index) =>
      index === 0 ? { ...proof, invariantId: broken[1].id } : proof
    );

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[0].id +
        " contains proof bound to different invariant ID " +
        broken[1].id
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
    broken[index].proofs = broken[index].proofs.map((proof, currentIndex) =>
      currentIndex === proofIndex
        ? { ...proof, negativeControlMarker: undefined }
        : proof
    );

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id +
        " structural proof has no executable negative-control marker: " +
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
    broken[index].requirements = [
      ...broken[index].requirements,
      {
        obligation: "PROPERTY",
        status: "DEFERRED",
        reason: "Synthetic deferred property obligation for the validator negative control.",
        tracking: "SCRUM-342",
      },
    ];

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
    broken[index].requirements = broken[index].requirements.map(
      (requirement, currentIndex) =>
        currentIndex === requirementIndex ? { ...requirement, reason: "" } : requirement
    );

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
    broken[index].requirements = broken[index].requirements.map(
      (requirement, currentIndex) =>
        currentIndex === requirementIndex
          ? { ...requirement, tracking: undefined }
          : requirement
    );

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
    broken[index].requirements = broken[index].requirements.map(
      (requirement, currentIndex) =>
        currentIndex === requirementIndex
          ? {
              obligation: "TENANCY",
              status: "NOT_APPLICABLE",
              reason: "Synthetic invalid classification used only by this negative control.",
            }
          : requirement
    );

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

  test("NEGATIVE CONTROL: profile concurrency classification cannot contradict its proof obligation", () => {
    const broken = copyCatalog();
    const index = broken.findIndex(
      (invariant) => invariant.profile.concurrency === "REQUIRED"
    );
    broken[index] = {
      ...broken[index],
      profile: { ...broken[index].profile, concurrency: "NOT_APPLICABLE" },
    };

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id + " marks concurrency NOT_APPLICABLE inconsistently"
    );
  });

  test("NEGATIVE CONTROL: reversal-required profile needs an applicable REVERSAL obligation", () => {
    const broken = copyCatalog();
    const index = broken.findIndex(
      (invariant) => invariant.profile.reversal === "REQUIRED"
    );
    broken[index].requirements = broken[index].requirements.map((requirement) =>
      requirement.obligation === "REVERSAL"
        ? {
            obligation: "REVERSAL",
            status: "NOT_APPLICABLE",
            reason: "Synthetic contradictory reversal classification for this negative control.",
          }
        : requirement
    );

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id +
        " declares reversal REQUIRED without an applicable REVERSAL obligation"
    );
  });

  test("NEGATIVE CONTROL: a keyword in a comment is not an executable structural control", () => {
    const source = `
      // test("NEGATIVE CONTROL — comment only", () => { throw new Error("never"); });
      const note = "NEGATIVE CONTROL — comment only";
    `;
    expect(
      structuralProofHasExecutableNegativeControl(
        source,
        "NEGATIVE CONTROL — comment only"
      )
    ).toBe(false);
  });

  test("an actual test declaration is accepted as executable structural control", () => {
    const source = `
      test("NEGATIVE CONTROL — executable", () => {
        expect(true).toBe(true);
      });
    `;
    expect(
      structuralProofHasExecutableNegativeControl(
        source,
        "NEGATIVE CONTROL — executable"
      )
    ).toBe(true);
  });

  test("NEGATIVE CONTROL: a marker inside an uninvoked function is not active evidence", () => {
    const source = `
      function neverCalled() {
        test("NEGATIVE CONTROL — dormant", () => {
          expect(true).toBe(true);
        });
      }
    `;
    expect(
      structuralProofHasExecutableNegativeControl(
        source,
        "NEGATIVE CONTROL — dormant"
      )
    ).toBe(false);
  });

  test("NEGATIVE CONTROL: a marker behind a conditional branch is not active evidence", () => {
    const source = `
      if (false) {
        test("NEGATIVE CONTROL — conditional", () => {
          expect(true).toBe(true);
        });
      }
    `;
    expect(
      structuralProofHasExecutableNegativeControl(
        source,
        "NEGATIVE CONTROL — conditional"
      )
    ).toBe(false);
  });

  test("NEGATIVE CONTROL: duplicate active markers are ambiguous and refused", () => {
    const source = `
      test("NEGATIVE CONTROL — duplicate", () => {
        expect(true).toBe(true);
      });
      test("NEGATIVE CONTROL — duplicate", () => {
        expect(true).toBe(true);
      });
    `;
    expect(
      structuralProofHasExecutableNegativeControl(
        source,
        "NEGATIVE CONTROL — duplicate"
      )
    ).toBe(false);
  });

  test("an active nested test under an active describe remains valid evidence", () => {
    const source = `
      describe("active suite", () => {
        test("NEGATIVE CONTROL — nested active", () => {
          expect(true).toBe(true);
        });
      });
    `;
    expect(
      structuralProofHasExecutableNegativeControl(
        source,
        "NEGATIVE CONTROL — nested active"
      )
    ).toBe(true);
  });

  test("NEGATIVE CONTROL: a vacuous title match cannot satisfy an analyzer-backed control", () => {
    const source = `
      test("NEGATIVE CONTROL — analyzer backed", () => {
        expect(true).toBe(true);
      });
    `;
    expect(
      structuralProofHasExecutableNegativeControl(
        source,
        "NEGATIVE CONTROL — analyzer backed",
        ["findUnguardedTenantWrites", "VULNERABLE", "expect"]
      )
    ).toBe(false);
  });

  test("an analyzer-backed control must reference the analyzer, fixture, and assertion", () => {
    const source = `
      test("NEGATIVE CONTROL — analyzer backed", () => {
        const found = findUnguardedTenantWrites(VULNERABLE, "x.ts");
        expect(found).toHaveLength(1);
      });
    `;
    expect(
      structuralProofHasExecutableNegativeControl(
        source,
        "NEGATIVE CONTROL — analyzer backed",
        ["findUnguardedTenantWrites", "VULNERABLE", "expect"]
      )
    ).toBe(true);
  });

  test("NEGATIVE CONTROL: test.skip cannot satisfy structural evidence", () => {
    const source = `
      test.skip("NEGATIVE CONTROL — skipped", () => {
        throw new Error("never executed");
      });
    `;
    expect(
      structuralProofHasExecutableNegativeControl(
        source,
        "NEGATIVE CONTROL — skipped"
      )
    ).toBe(false);
  });

  test("NEGATIVE CONTROL: tests nested under describe.skip cannot satisfy evidence", () => {
    const source = `
      describe.skip("disabled suite", () => {
        test("NEGATIVE CONTROL — nested under skip", () => {
          throw new Error("never executed");
        });
      });
    `;
    expect(
      structuralProofHasExecutableNegativeControl(
        source,
        "NEGATIVE CONTROL — nested under skip"
      )
    ).toBe(false);
  });

  test("NEGATIVE CONTROL: tests nested under curried describe.skipIf cannot satisfy evidence", () => {
    const source = `
      describe.skipIf(true)("disabled suite", () => {
        test("NEGATIVE CONTROL — nested under skipIf", () => {
          throw new Error("never executed");
        });
      });
    `;
    expect(
      structuralProofHasExecutableNegativeControl(
        source,
        "NEGATIVE CONTROL — nested under skipIf"
      )
    ).toBe(false);
  });

  test("NEGATIVE CONTROL: PLATFORM_SERIALIZED_PROVEN requires PREVIEW concurrency proof", () => {
    const broken = copyCatalog();
    const index = broken.findIndex(
      (invariant) => invariant.profile.concurrency === "REQUIRED"
    );
    broken[index] = {
      ...broken[index],
      profile: {
        ...broken[index].profile,
        concurrency: "PLATFORM_SERIALIZED_PROVEN",
      },
      proofs: broken[index].proofs.filter((proof) => proof.mechanism !== "PREVIEW"),
    };

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id +
        " claims PLATFORM_SERIALIZED_PROVEN without required PREVIEW CONCURRENCY proof"
    );
  });

  test("NEGATIVE CONTROL: IRREVERSIBLE_BY_DESIGN requires an explicit reversal N/A", () => {
    const broken = copyCatalog();
    const index = broken.findIndex(
      (invariant) => invariant.profile.reversal === "REQUIRED"
    );
    broken[index] = {
      ...broken[index],
      profile: {
        ...broken[index].profile,
        reversal: "IRREVERSIBLE_BY_DESIGN",
      },
    };

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id +
        " is IRREVERSIBLE_BY_DESIGN without REVERSAL marked NOT_APPLICABLE"
    );
  });

  test("NEGATIVE CONTROL: external-input-sensitive invariants must assess FUZZ", () => {
    const broken = copyCatalog();
    const index = broken.findIndex((invariant) => invariant.state === "PARTIAL");
    broken[index] = {
      ...broken[index],
      profile: {
        ...broken[index].profile,
        externalInputSensitive: true,
      },
    };

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id +
        " is external-input-sensitive without an applicable FUZZ assessment"
    );
  });

  test("NEGATIVE CONTROL: scheduled-work-sensitive invariants must assess fault boundaries", () => {
    const broken = copyCatalog();
    const index = broken.findIndex((invariant) => invariant.id === "TEN-1");
    broken[index] = {
      ...broken[index],
      profile: {
        ...broken[index].profile,
        scheduledWorkSensitive: true,
      },
    };

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id +
        " is scheduled-work-sensitive without explicit REPLAY assessment"
    );
    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id +
        " is scheduled-work-sensitive without explicit CONCURRENCY assessment"
    );
    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[index].id +
        " is scheduled-work-sensitive without explicit FAULT_INJECTION assessment"
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

  test("NEGATIVE CONTROL: SUPERSEDED replacement IDs must exist and be active", () => {
    const broken = copyCatalog();
    broken[0] = {
      ...broken[0],
      state: "SUPERSEDED",
      retirement: {
        reason: "Synthetic supersession with an unknown replacement for the validator.",
        tracking: "SCRUM-342",
        supersededBy: ["NOPE-999"],
      },
    };

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[0].id + " supersedes to unknown invariant ID NOPE-999"
    );
  });

  test("NEGATIVE CONTROL: an invariant cannot supersede itself", () => {
    const broken = copyCatalog();
    broken[0] = {
      ...broken[0],
      state: "SUPERSEDED",
      retirement: {
        reason: "Synthetic self-supersession for the validator negative control.",
        tracking: "SCRUM-342",
        supersededBy: [broken[0].id],
      },
    };

    expect(validateInvariantCatalog(ROOT, broken)).toContain(
      broken[0].id + " cannot supersede itself"
    );
  });

});
