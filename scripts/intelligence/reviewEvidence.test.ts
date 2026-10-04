import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { listActiveTestRegistrations } from "../autoflowInvariantCatalog";
import {
  evaluateReviewEvidence,
  isNonMaterialPath,
} from "./reviewEvidence.mjs";

// Negative controls for SCRUM-644 S3a. Each control names the one defect it
// plants on an otherwise valid input; the positive control proves that input
// is accepted, so every refusal below is caused by the planted defect alone.

const policy = JSON.parse(
  readFileSync(path.join(__dirname, "../../.github/review-policy.json"), "utf8"),
);

const sha = (digit: string) => digit.repeat(40);
const BASE = sha("b");
const HEAD = sha("c");
const MERGE = sha("d");
const EVIDENCE_SHA = sha("e");
const FOREIGN_SHA = sha("f");

const TEST_FILE = "convex/deals.test.ts";
const TEST_SOURCE = `
describe("listApplications", () => {
  test("orders the status-filtered branch newest first", () => {});
  test.skip("orders the salesperson branch newest first", () => {});
  test.each([])("orders page %s newest first", () => {});
});
describe.each([])("branch %s", () => {
  test("keeps the cursor stable", () => {});
});
const unused = "orders the unregistered branch newest first";
`;

const RUNTIME_WORKFLOW = ".github/workflows/trusted-accounting-rehearsal.yml";
const RUNTIME_ARTIFACT = "trusted-accounting-rehearsal-evidence";

type EvidenceItem = Record<string, unknown>;

function testEvidence(title: string, overrides: EvidenceItem = {}): EvidenceItem {
  return { kind: "test", file: TEST_FILE, title, sha: EVIDENCE_SHA, ...overrides };
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    policy,
    record: {
      policyVersion: policy.policyVersion,
      obligations: [
        {
          requirement: "proof:status-filter-order",
          evidence: [testEvidence("orders the status-filtered branch newest first")],
        },
        {
          requirement: "proof:accounting-runtime",
          evidence: [{ kind: "runtime", workflow: RUNTIME_WORKFLOW, status: "EXECUTED" }],
        },
      ],
    },
    identities: { head: HEAD, base: BASE, merge: MERGE, mergeParents: [BASE, HEAD] },
    requirements: [
      "proof:status-filter-order",
      "proof:accounting-runtime",
      "review:correctness-governance",
    ],
    history: {
      isAncestor: (candidate: string) => candidate === EVIDENCE_SHA,
      changedFilesSince: () => ["review-evidence/scrum-644.json"],
    },
    testRegistry: { [TEST_FILE]: listActiveTestRegistrations(TEST_SOURCE) },
    runtimeEvidence: [
      {
        workflowPath: RUNTIME_WORKFLOW,
        artifact: RUNTIME_ARTIFACT,
        testedSha: MERGE,
        conclusion: "success",
      },
    ],
    ...overrides,
  };
}

function withObligation(requirement: string, evidence: EvidenceItem[]) {
  const input = validInput();
  input.record.obligations = input.record.obligations.map((obligation) =>
    obligation.requirement === requirement ? { requirement, evidence } : obligation,
  );
  return input;
}

function codes(result: { reasons: { code: string }[] }) {
  return result.reasons.map((reason) => reason.code);
}

describe("review evidence — positive control", () => {
  test("a fully evidenced record is COMPLETE except for the reported review", () => {
    const result = evaluateReviewEvidence(validInput());
    expect(result.verdict).toBe("COMPLETE");
    expect(result.reasons).toEqual([]);
    expect(result.obligations).toEqual([
      { requirement: "proof:accounting-runtime", status: "SATISFIED" },
      { requirement: "proof:status-filter-order", status: "SATISFIED" },
      { requirement: "review:correctness-governance", status: "REPORTED_UNRESOLVED" },
    ]);
  });

  test("a change with no requirements needs no record", () => {
    const result = evaluateReviewEvidence(validInput({ requirements: [], record: null }));
    expect(result.verdict).toBe("NOT_REQUIRED");
  });

  test("the fixture registry is what the catalog parser reports", () => {
    expect(listActiveTestRegistrations(TEST_SOURCE)).toEqual([
      { title: "orders the status-filtered branch newest first", parameterized: false },
      { title: "orders page %s newest first", parameterized: true },
      { title: "keeps the cursor stable", parameterized: true },
    ]);
  });
});

describe("control 1 — an unavailable runtime test does not pass", () => {
  test("a runtime obligation reported UNAVAILABLE is refused", () => {
    const result = evaluateReviewEvidence(
      withObligation("proof:accounting-runtime", [
        { kind: "runtime", workflow: RUNTIME_WORKFLOW, status: "UNAVAILABLE" },
      ]),
    );
    expect(result.verdict).toBe("INCOMPLETE");
    expect(codes(result)).toEqual(["RUNTIME_UNAVAILABLE"]);
  });

  test("a runtime claim with no trusted run behind it is refused", () => {
    const result = evaluateReviewEvidence(validInput({ runtimeEvidence: [] }));
    expect(codes(result)).toEqual(["RUNTIME_UNPROVEN"]);
  });

  test("a failed trusted run does not prove the obligation", () => {
    const input = validInput();
    input.runtimeEvidence[0].conclusion = "failure";
    expect(codes(evaluateReviewEvidence(input))).toEqual(["RUNTIME_UNPROVEN"]);
  });

  test("two matching trusted runs are ambiguous, not either one", () => {
    const input = validInput();
    input.runtimeEvidence.push({ ...input.runtimeEvidence[0] });
    expect(codes(evaluateReviewEvidence(input))).toEqual(["RUNTIME_AMBIGUOUS"]);
  });

  test("a workflow the policy does not admit proves nothing", () => {
    const result = evaluateReviewEvidence(
      withObligation("proof:accounting-runtime", [
        { kind: "runtime", workflow: ".github/workflows/playwright.yml", status: "EXECUTED" },
      ]),
    );
    expect(codes(result)).toEqual(["RUNTIME_UNPROVEN"]);
  });
});

describe("control 2 — a stale reviewer revision does not pass", () => {
  const title = "orders the status-filtered branch newest first";

  test("evidence from a commit that is not an ancestor of head is stale", () => {
    const result = evaluateReviewEvidence(
      withObligation("proof:status-filter-order", [testEvidence(title, { sha: FOREIGN_SHA })]),
    );
    expect(codes(result)).toEqual(["STALE_EVIDENCE"]);
  });

  test("a material change after the evidence commit makes it stale", () => {
    const input = validInput();
    input.history = { ...input.history, changedFilesSince: () => ["convex/deals.ts"] };
    expect(codes(evaluateReviewEvidence(input))).toEqual(["STALE_EVIDENCE"]);
  });

  test("a documentation change counts as material", () => {
    const input = validInput();
    input.history = { ...input.history, changedFilesSince: () => ["docs/architecture/invariant-governance.md"] };
    expect(codes(evaluateReviewEvidence(input))).toEqual(["STALE_EVIDENCE"]);
  });

  test("an abbreviated SHA is refused before any history lookup", () => {
    const result = evaluateReviewEvidence(
      withObligation("proof:status-filter-order", [testEvidence(title, { sha: EVIDENCE_SHA.slice(0, 7) })]),
    );
    expect(codes(result)).toEqual(["BAD_SHA"]);
  });

  test("only evidence records themselves are non-material", () => {
    expect(isNonMaterialPath(policy, "review-evidence/scrum-644.json")).toBe(true);
    expect(isNonMaterialPath(policy, "review-evidence/../convex/deals.json")).toBe(false);
    expect(isNonMaterialPath(policy, "review-evidence/scrum-644.ts")).toBe(false);
    expect(isNonMaterialPath(policy, "convex/review-evidence/x.json")).toBe(false);
  });
});

describe("control 3 — a missing branch obligation does not pass", () => {
  test("a requirement the record does not answer is MISSING", () => {
    const input = validInput();
    input.requirements = [...input.requirements, "proof:salesperson-filter-order"];
    const result = evaluateReviewEvidence(input);
    expect(result.verdict).toBe("INCOMPLETE");
    expect(codes(result)).toEqual(["MISSING_OBLIGATION"]);
  });

  test("an excepted requirement is reported, never COMPLETE", () => {
    const input = validInput();
    input.requirements = [...input.requirements, "proof:salesperson-filter-order"];
    (input.record as Record<string, unknown>).exceptions = [
      { requirement: "proof:salesperson-filter-order", jira: "SCRUM-644" },
    ];
    const result = evaluateReviewEvidence(input);
    expect(result.verdict).toBe("INCOMPLETE");
    expect(codes(result)).toEqual(["EXCEPTED"]);
  });

  test("an obligation with no evidence is unproven", () => {
    const result = evaluateReviewEvidence(withObligation("proof:status-filter-order", []));
    expect(codes(result)).toEqual(["NO_EVIDENCE"]);
  });

  test("a requirement no policy rule classifies fails closed", () => {
    const input = validInput();
    input.requirements = [...input.requirements, "attest:something-new"];
    expect(codes(evaluateReviewEvidence(input))).toEqual(["UNCLASSIFIED_REQUIREMENT"]);
  });
});

describe("control 4 — a fabricated execution claim does not pass", () => {
  test.each([
    ["a skipped test", "orders the salesperson branch newest first"],
    ["a title that only appears in a string", "orders the unregistered branch newest first"],
    ["a title that does not exist", "orders every branch newest first"],
  ])("%s is not a registered test", (_label, title) => {
    const result = evaluateReviewEvidence(
      withObligation("proof:status-filter-order", [testEvidence(title)]),
    );
    expect(codes(result)).toEqual(["TEST_NOT_REGISTERED"]);
  });

  test("a test in a file the registry does not cover is not registered", () => {
    const result = evaluateReviewEvidence(
      withObligation("proof:status-filter-order", [
        testEvidence("orders the status-filtered branch newest first", { file: "convex/other.test.ts" }),
      ]),
    );
    expect(codes(result)).toEqual(["TEST_NOT_REGISTERED"]);
  });

  test.each([
    ["test.each", "orders page %s newest first"],
    ["a test inside describe.each", "keeps the cursor stable"],
  ])("%s may run zero cases and is refused", (_label, title) => {
    const result = evaluateReviewEvidence(
      withObligation("proof:status-filter-order", [testEvidence(title)]),
    );
    expect(codes(result)).toEqual(["TEST_PARAMETERIZED"]);
  });

  test("a trusted run of a different merge does not prove this one", () => {
    const input = validInput();
    input.runtimeEvidence[0].testedSha = FOREIGN_SHA;
    expect(codes(evaluateReviewEvidence(input))).toEqual(["RUNTIME_WRONG_MERGE"]);
  });

  test("one genuine item does not rescue a fabricated one beside it", () => {
    const result = evaluateReviewEvidence(
      withObligation("proof:status-filter-order", [
        testEvidence("orders the status-filtered branch newest first"),
        testEvidence("orders every branch newest first"),
      ]),
    );
    expect(codes(result)).toEqual(["TEST_NOT_REGISTERED"]);
  });

  test("an evidence kind the validator does not know is refused", () => {
    const result = evaluateReviewEvidence(
      withObligation("proof:status-filter-order", [{ kind: "screenshot", file: "a.png" }]),
    );
    expect(codes(result)).toEqual(["UNKNOWN_EVIDENCE"]);
  });
});

describe("control 5 — the range comes from the caller, never the record", () => {
  test("base equal to head is an empty range", () => {
    const input = validInput();
    input.identities = { ...input.identities, base: HEAD };
    const result = evaluateReviewEvidence(input);
    expect(result.verdict).toBe("INVALID");
    expect(codes(result)).toContain("EMPTY_RANGE");
  });

  test("a merge whose second parent is not head is refused", () => {
    const input = validInput();
    input.identities = { ...input.identities, mergeParents: [BASE, FOREIGN_SHA] };
    const result = evaluateReviewEvidence(input);
    expect(result.verdict).toBe("INVALID");
    expect(codes(result)).toEqual(["MERGE_NOT_OF_HEAD"]);
  });

  test("an abbreviated identity is refused", () => {
    const input = validInput();
    input.identities = { ...input.identities, head: HEAD.slice(0, 7), mergeParents: [BASE, HEAD.slice(0, 7)] };
    expect(evaluateReviewEvidence(input).verdict).toBe("INVALID");
  });

  test("a record declaring base = head changes nothing (paired with the valid case)", () => {
    const honest = evaluateReviewEvidence(validInput());
    const input = validInput();
    (input.record as Record<string, unknown>).base = HEAD;
    (input.record as Record<string, unknown>).head = HEAD;
    const lying = evaluateReviewEvidence(input);
    expect(lying).toEqual(honest);
    expect(lying.verdict).toBe("COMPLETE");
  });

  test("a record cannot shrink the requirement set by declaring a later base", () => {
    const input = validInput();
    (input.record as Record<string, unknown>).base = HEAD;
    input.requirements = [...input.requirements, "proof:salesperson-filter-order"];
    expect(codes(evaluateReviewEvidence(input))).toEqual(["MISSING_OBLIGATION"]);
  });
});

describe("control 6 — a record from another policy version does not pass", () => {
  test.each([[0], [2], ["1"], [undefined]])("policyVersion %s is refused", (version) => {
    const input = validInput();
    input.record.policyVersion = version as number;
    const result = evaluateReviewEvidence(input);
    expect(result.verdict).toBe("INVALID");
    expect(codes(result)).toEqual(["POLICY_VERSION"]);
  });

  test("requirements with no record at all are INVALID", () => {
    const result = evaluateReviewEvidence(validInput({ record: null }));
    expect(result.verdict).toBe("INVALID");
    expect(codes(result)).toEqual(["MISSING_RECORD"]);
  });
});

describe("control 7 — a review cannot be proven by evidence", () => {
  test("evidence attached to a review requirement is refused", () => {
    const input = validInput();
    input.record.obligations.push({
      requirement: "review:correctness-governance",
      evidence: [testEvidence("orders the status-filtered branch newest first")],
    });
    const result = evaluateReviewEvidence(input);
    expect(result.verdict).toBe("INCOMPLETE");
    expect(codes(result)).toEqual(["REVIEW_NOT_PROVABLE"]);
  });

  test("a review-invariant requirement stays unresolved however it is answered", () => {
    const input = validInput();
    input.requirements = [...input.requirements, "review-invariant:deal-money-authority"];
    input.record.obligations.push({ requirement: "review-invariant:deal-money-authority", evidence: [] });
    const result = evaluateReviewEvidence(input);
    expect(result.obligations).toContainEqual({
      requirement: "review-invariant:deal-money-authority",
      status: "REPORTED_UNRESOLVED",
    });
  });
});
