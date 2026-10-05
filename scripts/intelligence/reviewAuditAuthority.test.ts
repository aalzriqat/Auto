import { describe, expect, test } from "vitest";
import {
  acceptAuditRun,
  AUDIT_ARTIFACT_NAME,
  AUTHORITY_REJECTION,
  BINDING_STATUS,
  buildAuditPayload,
  conclusionFor,
  CONTROLLER_WORKFLOW_PATH,
  NOT_EVALUABLE_REASON,
  readAuditBinding,
  UNAVAILABLE_REASON,
} from "./reviewAuditAuthority.mjs";
import { VERDICTS } from "./reviewEvidence.mjs";

// Negative controls for SCRUM-644 S3b authority. The positive control proves a
// genuine controller binding is accepted, so each refusal below is caused by
// the one defect it plants.

const REPO = 1_000_001;
const FOREIGN_REPO = 2_000_002;
const RUN_ID = 37_000_000_001;
const sha = (digit: string) => digit.repeat(40);
const TIP = sha("a");
const OLD_TIP = sha("9");
const HEAD = sha("c");
const MERGE = sha("d");
const PR = 450;

function genuine() {
  const run = {
    id: RUN_ID,
    run_attempt: 1,
    repository: { id: REPO },
    head_repository: { id: REPO },
    path: `${CONTROLLER_WORKFLOW_PATH}@refs/heads/main`,
    event: "push",
    head_branch: "main",
    head_sha: TIP,
    status: "completed",
    conclusion: "success",
  };
  const artifact = { name: AUDIT_ARTIFACT_NAME, expired: false, workflow_run: { id: RUN_ID } };
  const payload = {
    controllerRunId: RUN_ID,
    runAttempt: 1,
    workflowSha: TIP,
    mainTip: TIP,
    N: PR,
    H: HEAD,
    M: MERGE,
  };
  return { run, artifact, payload };
}

const read = (candidate: unknown, overrides: Record<string, unknown> = {}) =>
  readAuditBinding({ candidate, repositoryId: REPO, currentMainTip: TIP, prNumber: PR, headSha: HEAD, ...overrides });

describe("SCRUM-644 S3b audit authority predicate", () => {
  test("positive control: a genuine controller run, artifact and payload are accepted", () => {
    expect(acceptAuditRun({ ...genuine(), repositoryId: REPO })).toEqual({ accepted: true, rejections: [] });
  });

  const plants: [string, (b: ReturnType<typeof genuine>) => void, string][] = [
    ["a run in another repository", (b) => { b.run.repository.id = FOREIGN_REPO; }, AUTHORITY_REJECTION.RUN_REPOSITORY],
    ["a different workflow file", (b) => { b.run.path = ".github/workflows/other.yml@refs/heads/main"; }, AUTHORITY_REJECTION.RUN_PATH],
    ["the controller path with a lookalike suffix", (b) => { b.run.path = `${CONTROLLER_WORKFLOW_PATH}.bak`; }, AUTHORITY_REJECTION.RUN_PATH],
    ["a pull_request run (the candidate's copy)", (b) => { b.run.event = "pull_request"; }, AUTHORITY_REJECTION.RUN_EVENT],
    ["a workflow_dispatch run (the dispatching ref's copy)", (b) => { b.run.event = "workflow_dispatch"; }, AUTHORITY_REJECTION.RUN_EVENT],
    ["a run on a branch other than main", (b) => { b.run.head_branch = "feature"; }, AUTHORITY_REJECTION.RUN_BRANCH],
    ["a fork head repository", (b) => { b.run.head_repository.id = FOREIGN_REPO; }, AUTHORITY_REJECTION.RUN_HEAD_REPOSITORY],
    ["a failed run", (b) => { b.run.conclusion = "failure"; }, AUTHORITY_REJECTION.RUN_CONCLUSION],
    ["a run still in progress", (b) => { b.run.status = "in_progress"; }, AUTHORITY_REJECTION.RUN_CONCLUSION],
    ["an artifact from another run", (b) => { b.artifact.workflow_run.id = RUN_ID + 1; }, AUTHORITY_REJECTION.ARTIFACT_BINDING],
    ["an expired artifact", (b) => { b.artifact.expired = true; }, AUTHORITY_REJECTION.ARTIFACT_BINDING],
    ["an artifact with another name", (b) => { b.artifact.name = "audit"; }, AUTHORITY_REJECTION.ARTIFACT_BINDING],
    ["a payload naming another run", (b) => { b.payload.controllerRunId = RUN_ID + 1; }, AUTHORITY_REJECTION.PAYLOAD_RUN],
    ["a payload from another attempt", (b) => { b.payload.runAttempt = 2; }, AUTHORITY_REJECTION.PAYLOAD_RUN],
    ["a payload evaluated by other controller code", (b) => { b.payload.workflowSha = OLD_TIP; }, AUTHORITY_REJECTION.PAYLOAD_REVISION],
    ["a payload recording another main tip", (b) => { b.payload.mainTip = OLD_TIP; }, AUTHORITY_REJECTION.PAYLOAD_REVISION],
    ["a run with no commit SHA", (b) => { b.run.head_sha = "main"; b.payload.workflowSha = "main"; b.payload.mainTip = "main"; }, AUTHORITY_REJECTION.PAYLOAD_REVISION],
  ];

  test.each(plants)("rejects %s", (_name, plant, code) => {
    const binding = genuine();
    plant(binding);
    const result = acceptAuditRun({ ...binding, repositoryId: REPO });
    expect(result.accepted).toBe(false);
    expect(result.rejections).toEqual([code]);
  });

  test("every admitted event is accepted, and only those", () => {
    for (const event of ["workflow_run", "push", "schedule"]) {
      const binding = genuine();
      binding.run.event = event;
      expect(acceptAuditRun({ ...binding, repositoryId: REPO }).accepted).toBe(true);
    }
  });

  test("missing pieces are refused, not crashed on", () => {
    const { run, artifact } = genuine();
    expect(acceptAuditRun({ run, artifact, payload: null, repositoryId: REPO }).accepted).toBe(false);
    expect(acceptAuditRun({ run: undefined, artifact, payload: {}, repositoryId: REPO }).accepted).toBe(false);
  });
});

describe("SCRUM-644 S3b audit binding reader", () => {
  test("positive control: the current binding is BOUND", () => {
    const binding = genuine();
    expect(read(binding)).toEqual({ status: BINDING_STATUS.BOUND, payload: binding.payload });
  });

  test("no artifact or payload at all is UNAVAILABLE(NO_CURRENT_BINDING), never a pass", () => {
    // Absence reports no rejections, so it stays distinguishable from a present
    // but untrusted binding.
    for (const candidate of [null, undefined]) {
      expect(read(candidate)).toEqual({
        status: BINDING_STATUS.UNAVAILABLE,
        reason: UNAVAILABLE_REASON.NO_CURRENT_BINDING,
        rejections: [],
      });
    }
    expect(read("x")).toMatchObject({ status: BINDING_STATUS.UNAVAILABLE, reason: UNAVAILABLE_REASON.NO_CURRENT_BINDING });
  });

  test("an old successful run is a decoy once main has moved (S3B-2-RERUN)", () => {
    // A rerun keeps its original SHA. It is internally consistent and still
    // passes the predicate; only the current-tip binding rejects it.
    const rerun = genuine();
    rerun.run.run_attempt = 2;
    rerun.payload.runAttempt = 2;
    expect(acceptAuditRun({ ...rerun, repositoryId: REPO }).accepted).toBe(true);
    expect(read(rerun, { currentMainTip: sha("b") })).toMatchObject({
      status: BINDING_STATUS.UNAVAILABLE,
      reason: UNAVAILABLE_REASON.STALE_CONTROLLER,
    });
  });

  test("a run that finishes after main advanced is UNAVAILABLE", () => {
    expect(read(genuine(), { currentMainTip: sha("e") }).reason).toBe(UNAVAILABLE_REASON.STALE_CONTROLLER);
  });

  test("an unreadable current tip is UNAVAILABLE, not a match", () => {
    expect(read(genuine(), { currentMainTip: undefined }).reason).toBe(UNAVAILABLE_REASON.STALE_CONTROLLER);
  });

  test("a binding for another PR does not answer for this one", () => {
    expect(read(genuine(), { prNumber: PR + 1 }).reason).toBe(UNAVAILABLE_REASON.NO_CURRENT_BINDING);
  });

  test("a binding for an older head is HEAD_MOVED", () => {
    expect(read(genuine(), { headSha: sha("f") }).reason).toBe(UNAVAILABLE_REASON.HEAD_MOVED);
  });

  test("an untrusted run surfaces its rejections and stays UNAVAILABLE", () => {
    const binding = genuine();
    binding.run.event = "workflow_dispatch";
    expect(read(binding)).toEqual({
      status: BINDING_STATUS.UNAVAILABLE,
      reason: UNAVAILABLE_REASON.NO_CURRENT_BINDING,
      rejections: [AUTHORITY_REJECTION.RUN_EVENT],
    });
  });

  test("a carried-forward reference to a run at an older tip is rejected", () => {
    const carried = genuine();
    carried.run.head_sha = OLD_TIP;
    carried.payload.workflowSha = OLD_TIP;
    carried.payload.mainTip = OLD_TIP;
    expect(read(carried).reason).toBe(UNAVAILABLE_REASON.STALE_CONTROLLER);
  });
});

describe("SCRUM-644 S3b conclusion table", () => {
  test("the literal table: only COMPLETE and NOT_REQUIRED pass; there is no neutral", () => {
    const table = Object.fromEntries(
      Object.values(VERDICTS).map((verdict) => [verdict, conclusionFor({ kind: "VERDICT", verdict })]),
    );
    expect(table).toEqual({
      NOT_REQUIRED: "success",
      COMPLETE: "success",
      REVIEW_UNRESOLVED: "action_required",
      INCOMPLETE: "failure",
      INVALID: "failure",
    });
    for (const reason of Object.values(NOT_EVALUABLE_REASON)) {
      expect(conclusionFor({ kind: "NOT_EVALUABLE", reason })).toBe("action_required");
    }
    expect(conclusionFor({ kind: "UNAVAILABLE", reason: "BATCH_INCOMPLETE" })).toBeNull();
  });

  test("property: no outcome other than COMPLETE or NOT_REQUIRED maps to a passing conclusion", () => {
    const outcomes = [
      ...Object.values(VERDICTS).map((verdict) => ({ kind: "VERDICT", verdict })),
      ...Object.values(NOT_EVALUABLE_REASON).map((reason) => ({ kind: "NOT_EVALUABLE", reason })),
      { kind: "UNAVAILABLE", reason: "BATCH_INCOMPLETE" },
    ];
    for (const outcome of outcomes) {
      const passing = ["success", "neutral", "skipped"].includes(conclusionFor(outcome) as string);
      const allowed = outcome.kind === "VERDICT" && ([VERDICTS.COMPLETE, VERDICTS.NOT_REQUIRED] as string[]).includes((outcome as { verdict?: string }).verdict ?? "");
      expect({ outcome, passing }).toEqual({ outcome, passing: allowed });
    }
  });

  test("an unknown outcome throws instead of defaulting", () => {
    expect(() => conclusionFor({ kind: "VERDICT", verdict: "toString" })).toThrow();
    expect(() => conclusionFor({ kind: "NOT_EVALUABLE", reason: "SOMETHING" })).toThrow();
    expect(() => conclusionFor(undefined as never)).toThrow();
  });
});

describe("SCRUM-644 S3b publishable payload", () => {
  const base = {
    controllerRunId: RUN_ID,
    runAttempt: 1,
    workflowSha: TIP,
    mainTip: TIP,
    prNumber: PR,
    headSha: HEAD,
    mergeSha: MERGE,
    policyVersion: 1,
    requirements: ["BOUNDARY"],
    recordPath: "review-evidence/pr-450.json",
    recordBlob: sha("e"),
  };
  const HOSTILE = "```\n## APPROVED ".concat("x".repeat(10_000));

  test("candidate text in details, unknown requirements and odd codes never reach the payload", () => {
    const payload = buildAuditPayload({
      ...base,
      outcome: { kind: "VERDICT", verdict: VERDICTS.INCOMPLETE, note: HOSTILE },
      evaluation: {
        reasons: [
          { code: "NO_EVIDENCE", requirement: "BOUNDARY", detail: HOSTILE },
          { code: "MISSING_OBLIGATION", requirement: HOSTILE, detail: HOSTILE },
          { code: HOSTILE, detail: HOSTILE },
        ],
        obligations: [{ requirement: "BOUNDARY", status: "MISSING" }, { requirement: HOSTILE, status: "MISSING" }],
        unresolvedReviews: [HOSTILE],
      },
    });
    const text = JSON.stringify(payload);
    expect(text).not.toContain("```");
    expect(text).not.toContain("APPROVED");
    expect(text.length).toBeLessThan(4_000);
    expect(payload.reasons).toEqual([
      { code: "NO_EVIDENCE", requirement: "BOUNDARY" },
      { code: "MISSING_OBLIGATION", requirement: undefined },
    ]);
    expect(payload.obligations).toEqual([{ requirement: "BOUNDARY", status: "MISSING" }]);
    expect(payload.unresolvedReviews).toEqual([]);
    expect(payload.outcome).toEqual({ kind: "VERDICT", verdict: VERDICTS.INCOMPLETE });
    expect(payload.conclusion).toBe("failure");
  });

  test("the payload is honest about what it does not prove", () => {
    const payload = buildAuditPayload({ ...base, outcome: { kind: "VERDICT", verdict: VERDICTS.COMPLETE }, evaluation: {} });
    expect(payload).toMatchObject({
      tests: "registered-not-executed",
      runtime: "not-collected",
      reviews: "unauthenticated",
      title: "record audit · valid for main @ aaaaaaa",
    });
    expect(payload).not.toHaveProperty("proofs");
  });

  test("a runtime-only INCOMPLETE is a failure whose title names the S3c gap", () => {
    const payload = buildAuditPayload({
      ...base,
      outcome: { kind: "VERDICT", verdict: VERDICTS.INCOMPLETE },
      evaluation: { reasons: [{ code: "RUNTIME_UNPROVEN", requirement: "BOUNDARY", detail: "x" }] },
    });
    expect(payload.conclusion).toBe("failure");
    expect(payload.title).toBe("record audit: runtime not collected (S3c) · valid for main @ aaaaaaa");
  });

  test("unresolved reviews stay visible beside an INCOMPLETE verdict", () => {
    const payload = buildAuditPayload({
      ...base,
      requirements: ["BOUNDARY", "REVIEW_X"],
      outcome: { kind: "VERDICT", verdict: VERDICTS.INCOMPLETE },
      evaluation: { reasons: [{ code: "RUNTIME_UNPROVEN", requirement: "BOUNDARY" }], unresolvedReviews: ["REVIEW_X"] },
    });
    expect(payload.unresolvedReviews).toEqual(["REVIEW_X"]);
  });

  test("a record path outside review-evidence/ or a non-SHA blob is redacted", () => {
    for (const recordPath of ["../etc/passwd", "review-evidence/x.json\n```", "review-evidence/a b.json", 7]) {
      expect(buildAuditPayload({ ...base, recordPath, outcome: { kind: "UNAVAILABLE", reason: "X" }, evaluation: {} }).recordPath).toBe("<redacted>");
    }
    expect(buildAuditPayload({ ...base, recordBlob: "HEAD", outcome: { kind: "UNAVAILABLE", reason: "X" }, evaluation: {} }).recordBlob).toBeNull();
  });
});
