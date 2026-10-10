import { describe, expect, test } from "vitest";
import { validateAccountingReleaseEvidence } from "./validateAccountingReleaseEvidence.mjs";

const sha = "a".repeat(40);
const expected = {
  testedSha: sha,
  previewName: "rehearsal-main-42",
  previewUrl: "https://test.convex.cloud",
  runId: "42",
};
const valid = () => ({
  testedSha: sha,
  deploymentType: "preview",
  previewName: expected.previewName,
  convexUrl: expected.previewUrl,
  workflowRunId: expected.runId,
  targetVerification: "assertE2EBootstrap agreed: preview marker present, cloud URL matches",
  cases: [{ id: "A1", status: "PASS" }, { id: "FD1", status: "PASS" }],
  summary: { total: 2, passed: 2, failed: 0, failedIds: [], unproven: 0, unprovenIds: [], complete: true },
});

describe("exact release cloud accounting evidence", () => {
  test("accepts an exact-SHA, preview-attested run with executed scenarios", () => {
    expect(validateAccountingReleaseEvidence(valid(), expected)).toEqual([]);
  });

  test.each([
    ["missing", () => null],
    ["wrong SHA", () => ({ ...valid(), testedSha: "b".repeat(40) })],
    ["mock target", () => ({ ...valid(), deploymentType: "harness" })],
    ["wrong preview", () => ({ ...valid(), convexUrl: "https://other.convex.cloud" })],
    ["wrong run", () => ({ ...valid(), workflowRunId: "41" })],
    ["unattested target", () => ({ ...valid(), targetVerification: null })],
    ["zero execution", () => ({ ...valid(), cases: [], summary: { ...valid().summary, total: 0, passed: 0 } })],
    ["skipped scenario", () => ({ ...valid(), cases: [{ id: "A1", status: "PASS" }, { id: "FD1", status: "UNPROVEN" }] })],
    ["failed scenario", () => ({ ...valid(), cases: [{ id: "A1", status: "PASS" }, { id: "FD1", status: "FAIL" }] })],
    ["fabricated total", () => ({ ...valid(), summary: { ...valid().summary, total: 3, passed: 3 } })],
    ["duplicate scenario", () => ({ ...valid(), cases: [{ id: "A1", status: "PASS" }, { id: "A1", status: "PASS" }] })],
  ])("refuses %s", (_label, mutate) => {
    expect(validateAccountingReleaseEvidence(mutate(), expected)).not.toEqual([]);
  });
});
