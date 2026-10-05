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
// Titles carry the requirement id they prove, the catalog's marker convention.
// The #431 escape class: the status-filtered branch is proven, the
// salesperson-filtered branch only appears to be.
const STATUS_TITLE = "proof:BOUNDARY orders the status-filtered branch newest first";
const UNRELATED_TITLE = "proof:jev-harness routes governance files";
const TEST_SOURCE = `
describe("listApplications", () => {
  test("${STATUS_TITLE}", () => {});
  test("${UNRELATED_TITLE}", () => {});
  test.skip("proof:BOUNDARY orders the salesperson branch newest first", () => {});
  test.each([])("proof:BOUNDARY orders page %s newest first", () => {});
});
describe.each([])("branch %s", () => {
  test("proof:BOUNDARY keeps the cursor stable", () => {});
});
describe.each([])("outer %s", () => {
  describe("inner", () => {
    test("proof:BOUNDARY holds two levels down", () => {});
  });
});
const unused = "proof:BOUNDARY orders the unregistered branch newest first";
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
          requirement: "proof:BOUNDARY",
          evidence: [testEvidence(STATUS_TITLE)],
        },
        {
          requirement: "proof:accounting-runtime",
          evidence: [{ kind: "runtime", workflow: RUNTIME_WORKFLOW, status: "EXECUTED" }],
        },
      ],
    },
    identities: { head: HEAD, base: BASE, merge: MERGE, mergeParents: [BASE, HEAD] },
    requirements: [
      "proof:BOUNDARY",
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
  test("every proof holding beside a required review is REVIEW_UNRESOLVED, never COMPLETE", () => {
    const result = evaluateReviewEvidence(validInput());
    expect(result.verdict).toBe("REVIEW_UNRESOLVED");
    expect(result.reasons).toEqual([]);
    expect(result.unresolvedReviews).toEqual(["review:correctness-governance"]);
    expect(result.obligations).toEqual([
      { requirement: "proof:BOUNDARY", status: "SATISFIED" },
      { requirement: "proof:accounting-runtime", status: "SATISFIED" },
      { requirement: "review:correctness-governance", status: "REPORTED_UNRESOLVED" },
    ]);
  });

  test("the same proofs with no review requirement are COMPLETE", () => {
    const input = validInput();
    input.requirements = input.requirements.filter((requirement) => !requirement.startsWith("review:"));
    const result = evaluateReviewEvidence(input);
    expect(result.verdict).toBe("COMPLETE");
    expect(result.unresolvedReviews).toEqual([]);
  });

  test("a change with no requirements needs no record", () => {
    const result = evaluateReviewEvidence(validInput({ requirements: [], record: null }));
    expect(result.verdict).toBe("NOT_REQUIRED");
  });

  test("the fixture registry is what the catalog parser reports", () => {
    expect(listActiveTestRegistrations(TEST_SOURCE)).toEqual([
      { title: STATUS_TITLE, parameterized: false },
      { title: UNRELATED_TITLE, parameterized: false },
      { title: "proof:BOUNDARY orders page %s newest first", parameterized: true },
      { title: "proof:BOUNDARY keeps the cursor stable", parameterized: true },
      { title: "proof:BOUNDARY holds two levels down", parameterized: true },
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

  test("two trusted runs of the current merge are ambiguous, not either one", () => {
    const input = validInput();
    input.runtimeEvidence.push({ ...input.runtimeEvidence[0] });
    expect(codes(evaluateReviewEvidence(input))).toEqual(["RUNTIME_AMBIGUOUS"]);
  });

  test("an earlier push's run beside the current merge's run does not make it ambiguous", () => {
    const input = validInput();
    input.runtimeEvidence.push({ ...input.runtimeEvidence[0], testedSha: FOREIGN_SHA, conclusion: "failure" });
    const result = evaluateReviewEvidence(input);
    expect(codes(result)).toEqual([]);
    expect(result.obligations).toContainEqual({ requirement: "proof:accounting-runtime", status: "SATISFIED" });
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

describe("control 2 — evidence formed at a stale revision does not pass", () => {
  const title = STATUS_TITLE;

  test("evidence from a commit that is not an ancestor of head is stale", () => {
    const result = evaluateReviewEvidence(
      withObligation("proof:BOUNDARY", [testEvidence(title, { sha: FOREIGN_SHA })]),
    );
    expect(codes(result)).toEqual(["STALE_EVIDENCE"]);
  });

  test("a material change after the evidence commit makes it stale", () => {
    const input = validInput();
    input.history = { ...input.history, changedFilesSince: () => ["convex/deals.ts"] };
    expect(codes(evaluateReviewEvidence(input))).toEqual(["STALE_EVIDENCE"]);
  });

  test("a rename out of a material path is stale when both sides are reported (--no-renames)", () => {
    const input = validInput();
    input.history = {
      ...input.history,
      changedFilesSince: () => ["convex/deals.ts", "review-evidence/deals.json"],
    };
    expect(codes(evaluateReviewEvidence(input))).toEqual(["STALE_EVIDENCE"]);
  });

  test("a documentation change counts as material", () => {
    const input = validInput();
    input.history = { ...input.history, changedFilesSince: () => ["docs/architecture/invariant-governance.md"] };
    expect(codes(evaluateReviewEvidence(input))).toEqual(["STALE_EVIDENCE"]);
  });

  test("an abbreviated SHA is refused before any history lookup", () => {
    const result = evaluateReviewEvidence(
      withObligation("proof:BOUNDARY", [testEvidence(title, { sha: EVIDENCE_SHA.slice(0, 7) })]),
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
    const result = evaluateReviewEvidence(withObligation("proof:BOUNDARY", []));
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
    ["a skipped test", "proof:BOUNDARY orders the salesperson branch newest first"],
    ["a title that only appears in a string", "proof:BOUNDARY orders the unregistered branch newest first"],
    ["a title that does not exist", "proof:BOUNDARY orders every branch newest first"],
  ])("%s is not a registered test", (_label, title) => {
    const result = evaluateReviewEvidence(
      withObligation("proof:BOUNDARY", [testEvidence(title)]),
    );
    expect(codes(result)).toEqual(["TEST_NOT_REGISTERED"]);
  });

  test("a test in a file the registry does not cover is not registered", () => {
    const result = evaluateReviewEvidence(
      withObligation("proof:BOUNDARY", [
        testEvidence(STATUS_TITLE, { file: "convex/other.test.ts" }),
      ]),
    );
    expect(codes(result)).toEqual(["TEST_NOT_REGISTERED"]);
  });

  test.each([
    ["test.each", "proof:BOUNDARY orders page %s newest first"],
    ["a test inside describe.each", "proof:BOUNDARY keeps the cursor stable"],
    ["a test two levels inside describe.each", "proof:BOUNDARY holds two levels down"],
  ])("%s may run zero cases and is refused", (_label, title) => {
    const result = evaluateReviewEvidence(
      withObligation("proof:BOUNDARY", [testEvidence(title)]),
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
      withObligation("proof:BOUNDARY", [
        testEvidence(STATUS_TITLE),
        testEvidence("proof:BOUNDARY orders every branch newest first"),
      ]),
    );
    expect(codes(result)).toEqual(["TEST_NOT_REGISTERED"]);
  });

  test("an evidence kind the validator does not know is refused", () => {
    const result = evaluateReviewEvidence(
      withObligation("proof:BOUNDARY", [{ kind: "screenshot", file: "a.png" }]),
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
    expect(lying.verdict).toBe("REVIEW_UNRESOLVED");
    expect(lying.reasons).toEqual([]);
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
      evidence: [testEvidence(STATUS_TITLE)],
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

describe("control 8 — evidence proves only the requirement it is bound to", () => {
  test("a registered test for another requirement cannot be cited", () => {
    const result = evaluateReviewEvidence(
      withObligation("proof:BOUNDARY", [testEvidence(UNRELATED_TITLE)]),
    );
    expect(codes(result)).toEqual(["EVIDENCE_NOT_FOR_REQUIREMENT"]);
  });

  test.each([
    ["extends", "proof:BOUNDARY_X orders the status-filtered branch newest first"],
    ["is extended by", "xproof:BOUNDARY orders the status-filtered branch newest first"],
  ])("a title whose token %s the requirement id does not carry it", (_how, title) => {
    const result = evaluateReviewEvidence(withObligation("proof:BOUNDARY", [testEvidence(title)]));
    expect(codes(result)).toEqual(["EVIDENCE_NOT_FOR_REQUIREMENT"]);
  });

  test("a governance proof cannot borrow a boundary test", () => {
    const input = validInput();
    input.requirements = [...input.requirements, "proof:jev-harness"];
    input.record.obligations.push({ requirement: "proof:jev-harness", evidence: [testEvidence(STATUS_TITLE)] });
    expect(codes(evaluateReviewEvidence(input))).toEqual(["EVIDENCE_NOT_FOR_REQUIREMENT"]);
  });

  test("the rehearsal is not proof of a catalog obligation it does not list", () => {
    const input = validInput();
    input.requirements = [...input.requirements, "proof:REPLAY"];
    input.record.obligations.push({
      requirement: "proof:REPLAY",
      evidence: [{ kind: "runtime", workflow: RUNTIME_WORKFLOW, status: "EXECUTED" }],
    });
    expect(codes(evaluateReviewEvidence(input))).toEqual(["EVIDENCE_NOT_FOR_REQUIREMENT"]);
  });
});

describe("control 9 — a malformed record is INVALID, never a crash", () => {
  // JSON.parse can produce this; String() throws on it.
  const UNPRINTABLE = JSON.parse('{"toString":"x"}');

  test.each([
    ["a string record", "not-a-record"],
    ["an array record", []],
    ["obligations that are a string", { obligations: "proof:BOUNDARY" }],
    ["obligations that are a single object", { obligations: { requirement: "proof:BOUNDARY" } }],
    ["an obligation that is null", { obligations: [null] }],
    ["an obligation with no requirement", { obligations: [{ evidence: [] }] }],
    ["evidence that is not an array", { obligations: [{ requirement: "proof:BOUNDARY", evidence: {} }] }],
    ["an evidence item that is null", { obligations: [{ requirement: "proof:BOUNDARY", evidence: [null] }] }],
    ["exceptions that are a string", { exceptions: "proof:BOUNDARY" }],
    ["exceptions that are a single object", { exceptions: { requirement: "proof:BOUNDARY" } }],
    ["an exception that is null", { exceptions: [null] }],
    ...["kind", "status", "workflow", "file", "title", "sha"].map((field): [string, unknown] => [
      `an evidence ${field} that is an object`,
      { obligations: [{ requirement: "proof:BOUNDARY", evidence: [{ kind: "test", [field]: UNPRINTABLE }] }] },
    ]),
    ["an exception jira that is an object", { exceptions: [{ requirement: "proof:BOUNDARY", jira: UNPRINTABLE }] }],
    ["a policyVersion that is an object", { policyVersion: UNPRINTABLE }],
  ] as [string, unknown][])("%s", (_label, shape) => {
    const record = Array.isArray(shape) || typeof shape !== "object" || shape === null
      ? shape
      : { policyVersion: policy.policyVersion, ...shape };
    const result = evaluateReviewEvidence(validInput({ record }));
    expect(result.verdict).toBe("INVALID");
    expect(codes(result)).toEqual(["MALFORMED_RECORD"]);
  });

  test.each([
    ["after", (good: unknown, bad: unknown) => [good, bad]],
    ["before", (good: unknown, bad: unknown) => [bad, good]],
  ])("a second obligation for one requirement, %s the good one, is malformed", (_order, arrange) => {
    const input = validInput();
    const [good, ...rest] = input.record.obligations;
    const bad = { requirement: "proof:BOUNDARY", evidence: [testEvidence(UNRELATED_TITLE)] };
    input.record.obligations = [...(arrange(good, bad) as typeof rest), ...rest];
    const result = evaluateReviewEvidence(input);
    expect(result.verdict).toBe("INVALID");
    expect(codes(result)).toEqual(["MALFORMED_RECORD"]);
  });

  test("two exceptions for one requirement are malformed", () => {
    const exception = { requirement: "proof:BOUNDARY", jira: "SCRUM-644" };
    const result = evaluateReviewEvidence(
      validInput({ record: { policyVersion: policy.policyVersion, obligations: [], exceptions: [exception, exception] } }),
    );
    expect(codes(result)).toEqual(["MALFORMED_RECORD"]);
  });

  test("a run conclusion that is an object is unproven, not a crash", () => {
    const input = validInput();
    input.runtimeEvidence[0].conclusion = UNPRINTABLE;
    expect(codes(evaluateReviewEvidence(input))).toEqual(["RUNTIME_UNPROVEN"]);
  });

  test("a test file named __proto__ is not registered, not a crash", () => {
    const result = evaluateReviewEvidence(
      withObligation("proof:BOUNDARY", [testEvidence(STATUS_TITLE, { file: "__proto__" })]),
    );
    expect(codes(result)).toEqual(["TEST_NOT_REGISTERED"]);
  });
});
