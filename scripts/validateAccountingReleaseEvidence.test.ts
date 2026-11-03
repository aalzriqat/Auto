import { describe, expect, test } from "vitest";
import { createRequire } from "node:module";

// Load the actual CLI module through Node, preserving its native shebang boundary.
const { validateAccountingReleaseEvidence, LOCAL_BACKEND_URL } = createRequire(import.meta.url)(
  "./validateAccountingReleaseEvidence.mjs",
) as typeof import("./validateAccountingReleaseEvidence.mjs");
import { REQUIRED_REHEARSAL_CASE_IDS } from "./accountingRehearsalCases.mjs";

const sha = "a".repeat(40);
const expected = {
  testedSha: sha,
  previewName: "rehearsal-main-42",
  previewUrl: "https://test.convex.cloud",
  runId: "42",
  runAttempt: "1",
  caseIds: ["A1", "FD1"],
};
const valid = () => ({
  testedSha: sha,
  deploymentType: "preview",
  previewName: expected.previewName,
  convexUrl: expected.previewUrl,
  workflowRunId: expected.runId,
  workflowRunAttempt: expected.runAttempt,
  targetVerification:
    "assertE2EBootstrap agreed: preview marker present, cloud URL matches",
  cases: [
    { id: "A1", status: "PASS" },
    { id: "FD1", status: "PASS" },
  ],
  summary: {
    total: 2,
    passed: 2,
    failed: 0,
    failedIds: [],
    unproven: 0,
    unprovenIds: [],
    complete: true,
  },
});

describe("exact release cloud accounting evidence", () => {
  test("accepts an exact-SHA, preview-attested run with executed scenarios", () => {
    expect(validateAccountingReleaseEvidence(valid(), expected)).toEqual([]);
  });

  test("the production validator requires the whole trusted cloud set", () => {
    const cases = REQUIRED_REHEARSAL_CASE_IDS.map((id) => ({
      id,
      status: "PASS",
    }));
    const evidence = {
      ...valid(),
      cases,
      summary: {
        ...valid().summary,
        total: cases.length,
        passed: cases.length,
      },
    };
    const { caseIds: _fixtureOverride, ...productionExpected } = expected;
    expect(
      validateAccountingReleaseEvidence(evidence, productionExpected),
    ).toEqual([]);
    expect(
      validateAccountingReleaseEvidence(valid(), productionExpected),
    ).not.toEqual([]);
  });

  test.each([
    ["missing", () => null],
    ["wrong SHA", () => ({ ...valid(), testedSha: "b".repeat(40) })],
    ["mock target", () => ({ ...valid(), deploymentType: "harness" })],
    [
      "wrong preview",
      () => ({ ...valid(), convexUrl: "https://other.convex.cloud" }),
    ],
    ["wrong run", () => ({ ...valid(), workflowRunId: "41" })],
    ["wrong attempt", () => ({ ...valid(), workflowRunAttempt: "2" })],
    ["unattested target", () => ({ ...valid(), targetVerification: null })],
    [
      "zero execution",
      () => ({
        ...valid(),
        cases: [],
        summary: { ...valid().summary, total: 0, passed: 0 },
      }),
    ],
    [
      "skipped scenario",
      () => ({
        ...valid(),
        cases: [
          { id: "A1", status: "PASS" },
          { id: "FD1", status: "UNPROVEN" },
        ],
      }),
    ],
    [
      "failed scenario",
      () => ({
        ...valid(),
        cases: [
          { id: "A1", status: "PASS" },
          { id: "FD1", status: "FAIL" },
        ],
      }),
    ],
    [
      "fabricated total",
      () => ({
        ...valid(),
        summary: { ...valid().summary, total: 3, passed: 3 },
      }),
    ],
    [
      "duplicate scenario",
      () => ({
        ...valid(),
        cases: [
          { id: "A1", status: "PASS" },
          { id: "A1", status: "PASS" },
        ],
      }),
    ],
    [
      "missing required case",
      () => ({
        ...valid(),
        cases: [{ id: "A1", status: "PASS" }],
        summary: { ...valid().summary, total: 1, passed: 1 },
      }),
    ],
  ])("refuses %s", (_label, mutate) => {
    expect(validateAccountingReleaseEvidence(mutate(), expected)).not.toEqual(
      [],
    );
  });
});

test("opening cutover is a required named cloud gate and an old29-only result cannot certify it", () => {
  expect(REQUIRED_REHEARSAL_CASE_IDS).toContain("S858-OPENING");
  expect(REQUIRED_REHEARSAL_CASE_IDS).toContain("S858-CONTAINMENT");
  expect(REQUIRED_REHEARSAL_CASE_IDS).toHaveLength(39);
  const old = REQUIRED_REHEARSAL_CASE_IDS.filter(
    (id) => !id.startsWith("S858-") && !id.startsWith("SUP-") && id !== "U-RET" && id !== "CC-CASH",
  );
  expect(old).toHaveLength(29);
  const cases = old.map((id) => ({ id, status: "PASS" }));
  const evidence = {
    ...valid(),
    cases,
    summary: { ...valid().summary, total: cases.length, passed: cases.length },
  };
  const { caseIds: _fixtureOverride, ...productionExpected } = expected;
  expect(
    validateAccountingReleaseEvidence(evidence, productionExpected),
  ).toContain(
    "The required cloud scenario set is incomplete or contains an unexpected case.",
  );
});

// SCRUM-892: pull requests and the release certify on the runner-local backend (owner ruling c24441).
describe("pull-request evidence from the runner-local backend", () => {
  const LOCAL_URL = "http://127.0.0.1:3210";
  test("its loopback URL is the one the local backend binds", async () => {
    const { LOCAL_CONVEX_URL } = await import("./localConvexBackend.mjs");
    expect(LOCAL_BACKEND_URL).toBe(LOCAL_CONVEX_URL);
    expect(LOCAL_BACKEND_URL).toBe(LOCAL_URL);
  });
  const localExpected = { ...expected, previewName: undefined, previewUrl: LOCAL_URL, deploymentType: "local", eventName: "workflow_run" };
  const localEvidence = () => ({
    ...valid(),
    deploymentType: "local",
    previewName: null,
    convexUrl: LOCAL_URL,
    targetVerification: "assertE2EBootstrap agreed: preview marker present, local backend URL matches",
  });

  test("accepts exact local evidence for a pull-request rehearsal", () => {
    expect(validateAccountingReleaseEvidence(localEvidence(), localExpected)).toEqual([]);
  });

  test("requires the same complete 39-case set as the release", () => {
    const { caseIds: _fixtureOverride, ...production } = localExpected;
    expect(validateAccountingReleaseEvidence(localEvidence(), production))
      .toContain("The required cloud scenario set is incomplete or contains an unexpected case.");
  });

  // Owner ruling SCRUM-892 c24441: the release rehearsal runs on the local backend too.
  test("accepts exact local evidence for the release rehearsal", () => {
    expect(validateAccountingReleaseEvidence(localEvidence(), { ...localExpected, eventName: "repository_dispatch" })).toEqual([]);
  });

  test.each([
    ["an unnamed event", { eventName: undefined }],
    ["a push", { eventName: "push" }],
    ["a hand dispatch", { eventName: "workflow_dispatch" }],
  ])("refuses local evidence under %s", (_label, override) => {
    expect(validateAccountingReleaseEvidence(localEvidence(), { ...localExpected, ...override }))
      .toContain("Local backend evidence is accepted only from the trusted rehearsal's pull-request or release event.");
  });

  test("the release default (no expected type) still refuses local evidence", () => {
    expect(validateAccountingReleaseEvidence(localEvidence(), { ...expected, previewUrl: LOCAL_URL }))
      .toContain("Evidence does not match the created disposable preview.");
  });

  test.each([
    ["cloud-typed evidence", () => ({ ...localEvidence(), deploymentType: "preview" })],
    ["a named preview", () => ({ ...localEvidence(), previewName: "rehearsal-main-42" })],
    ["another loopback port", () => ({ ...localEvidence(), convexUrl: "http://127.0.0.1:3211" })],
    ["the cloud attestation", () => ({ ...localEvidence(), targetVerification: valid().targetVerification })],
  ])("refuses %s on the local path", (_label, mutate) => {
    expect(validateAccountingReleaseEvidence(mutate(), localExpected)).not.toEqual([]);
  });

  test("refuses a URL the job did not start, even when it is the loopback backend's", () => {
    expect(validateAccountingReleaseEvidence(localEvidence(), { ...localExpected, previewUrl: "http://127.0.0.1:9999" }))
      .toContain("Evidence does not match this job's local backend.");
  });

  test("refuses an unknown expected deployment type", () => {
    expect(validateAccountingReleaseEvidence(valid(), { ...expected, deploymentType: "harness" }))
      .toContain("Unknown expected deployment type.");
  });
});

test.each(["S858-CLEANUP-HISTORY", "S858-CLEANUP-SPLIT", "U-RET", "CC-CASH"])("cloud evidence refuses the missing native callback %s", missing => {
  const cases = REQUIRED_REHEARSAL_CASE_IDS.filter(id => id !== missing).map(id => ({ id, status: "PASS" }));
  const evidence = { ...valid(), cases, summary: { ...valid().summary, total: cases.length, passed: cases.length } };
  const { caseIds: _fixtureOverride, ...productionExpected } = expected;
  expect(validateAccountingReleaseEvidence(evidence, productionExpected)).toContain("The required cloud scenario set is incomplete or contains an unexpected case.");
});
