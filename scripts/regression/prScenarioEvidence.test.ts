// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { buildBrowserReplayManifest } from "./trustedBrowserManifest.mjs";
import { createLocalScenarioEvidence, finishPrScenarioEvidence, preserveScenarioObligations, scenarioEvidenceDigest } from "./prScenarioEvidence.mjs";
import { OPENING_PROOF_CASES, OPENING_PROOF_SPEC, ROLE_AUDIT_SPEC, ROLE_CASE_PROJECTS } from "../intelligence/trustedBrowserReplayPolicy.mjs";
import { selectForPr } from "./prRunner.mjs";
import { readPublishedLocalScenarios } from "./trustedBrowserSource.mjs";

const candidate = {
  repositoryId: 42, prNumber: 12, workflowRunId: 200, workflowAttempt: 2,
  baseSha: "a".repeat(40), headSha: "b".repeat(40), testedSha: "c".repeat(40),
};
const opening = OPENING_PROOF_CASES[0];
const backend = {
  id: "ordinary-ledger", status: "active", domain: "money", level: "backend", fingerprint: "d".repeat(64),
  impl: { file: "ordinary.test.ts", testName: "keeps the ledger total" },
};
const protectedCase = {
  id: opening.scenarioId, status: "active", domain: "screen", level: "browser", fingerprint: "e".repeat(64),
  impl: { file: OPENING_PROOF_SPEC, testName: opening.title }, sourceGlobs: ["opening/**"],
};
const staticCase = {
  id: "ordinary-static-screen", status: "active", domain: "screen", level: "browser", fingerprint: "f".repeat(64),
  impl: { file: "static.visual.spec.ts", testName: "keeps the selected filters visible" }, sourceGlobs: ["opening/**"],
};

function evidence() {
  const selection = selectForPr([backend, protectedCase, staticCase], ["opening/form.tsx"]);
  const localRaw = createLocalScenarioEvidence(candidate, {
    selection, issues: [],
    verdicts: [{ id: backend.id, code: "PASS" }],
    browserVerdicts: [{ id: protectedCase.id, code: "BROWSER_REPLAY_NOT_EXECUTED" }, { id: staticCase.id, code: "PASS" }],
  });
  const browserRaw = JSON.stringify(buildBrowserReplayManifest(candidate, [protectedCase], [{ id: protectedCase.id, code: "PASS" }]));
  return { candidate, selection, protectedSelection: [protectedCase], localRaw, localDigest: scenarioEvidenceDigest(localRaw), browserRaw };
}

describe("exact scenario result aggregation", () => {
  it("joins complete local executions and the exact protected receipt", () => {
    expect(finishPrScenarioEvidence(evidence())).toMatchObject({ verdict: "PASS", selected: 3, passed: 3, failed: 0 });
  });

  it.each(["baseSha", "headSha", "testedSha", "prNumber", "repositoryId", "workflowRunId", "workflowAttempt"] as const)(
    "refuses evidence from another %s", (field) => {
      const input = evidence();
      const previous = JSON.parse(input.localRaw);
      previous.candidate[field] = typeof candidate[field] === "string" ? "0".repeat(40) : 999;
      const localRaw = JSON.stringify(previous);
      expect(() => finishPrScenarioEvidence({ ...input, localRaw, localDigest: scenarioEvidenceDigest(localRaw) }))
        .toThrow("LOCAL_SCENARIO_EVIDENCE_INVALID");
      const browserRaw = JSON.stringify({ ...JSON.parse(input.browserRaw), candidate: previous.candidate });
      expect(() => finishPrScenarioEvidence({ ...input, browserRaw })).toThrow("PROTECTED_SCENARIO_EVIDENCE_INVALID");
    },
  );

  it("refuses a changed report after the matching digest was recorded", () => {
    const input = evidence();
    expect(() => finishPrScenarioEvidence({ ...input, localRaw: input.localRaw + " " })).toThrow("LOCAL_SCENARIO_EVIDENCE_INVALID");
  });

  it("requires a receipt manifest even when the PR selects no protected bindings", () => {
    const selection = selectForPr([backend], []);
    const localRaw = createLocalScenarioEvidence(candidate, {
      selection, verdicts: [{ id: backend.id, code: "PASS" }], browserVerdicts: [], issues: [],
    });
    const input = { candidate, selection, protectedSelection: [], localRaw, localDigest: scenarioEvidenceDigest(localRaw) };
    expect(() => finishPrScenarioEvidence({ ...input, browserRaw: "" })).toThrow("PROTECTED_SCENARIO_EVIDENCE_INVALID");
    const browserRaw = JSON.stringify(buildBrowserReplayManifest(candidate, [], []));
    expect(finishPrScenarioEvidence({ ...input, browserRaw })).toMatchObject({ verdict: "PASS", selected: 1, passed: 1 });
  });

  it("refuses unsuccessful local evidence and a raw browser record masquerading as a verdict", () => {
    const input = evidence();
    const local = JSON.parse(input.localRaw);
    local.issues = ["VITEST_EXIT_1"];
    const localRaw = JSON.stringify(local);
    expect(() => finishPrScenarioEvidence({ ...input, localRaw, localDigest: scenarioEvidenceDigest(localRaw) }))
      .toThrow("LOCAL_SCENARIO_EVIDENCE_INVALID");
    const receipt = JSON.parse(input.browserRaw);
    receipt.records[0].code = "FAIL";
    expect(() => finishPrScenarioEvidence({ ...input, browserRaw: JSON.stringify(receipt) }))
      .toThrow("PROTECTED_SCENARIO_EVIDENCE_INVALID");
  });

  it("admits a deferred role audit only against its exact protected binding", () => {
    const role = { ...protectedCase, id: "role-proof", impl: { file: ROLE_AUDIT_SPEC,
      testName: Array.from(ROLE_CASE_PROJECTS.keys())[0] } };
    const selection = selectForPr([backend, role], [role.impl.file]);
    const localRaw = createLocalScenarioEvidence(candidate, { selection, issues: [],
      verdicts: [{ id: backend.id, code: "PASS" }], browserVerdicts: [{ id: role.id, code: "ROLE_AUDIT_EVIDENCE_NOT_JOINED" }] });
    const browserRaw = JSON.stringify(buildBrowserReplayManifest(candidate, [role], [{ id: role.id, code: "PASS", evidence: "role-audit" }]));
    const input = { candidate, selection, protectedSelection: [role], localRaw, localDigest: scenarioEvidenceDigest(localRaw), browserRaw };
    expect(finishPrScenarioEvidence(input)).toMatchObject({ verdict: "PASS", selected: 2, passed: 2 });
    expect(() => finishPrScenarioEvidence({ ...input, protectedSelection: [] })).toThrow("PROTECTED_SCENARIO_EVIDENCE_INVALID");
  });

  it("does not extend a real base receipt to a changed candidate binding", () => {
    const updated = { ...protectedCase, fingerprint: "9".repeat(64) };
    const selection = selectForPr([backend, updated], [updated.impl.file]);
    const localRaw = createLocalScenarioEvidence(candidate, { selection, issues: [],
      verdicts: [{ id: backend.id, code: "PASS" }],
      browserVerdicts: [{ id: updated.id, code: "BROWSER_REPLAY_NOT_EXECUTED" }] });
    const browserRaw = JSON.stringify(buildBrowserReplayManifest(candidate, [protectedCase], [{ id: protectedCase.id, code: "PASS" }]));
    expect(() => finishPrScenarioEvidence({ candidate, selection, protectedSelection: [protectedCase], localRaw,
      localDigest: scenarioEvidenceDigest(localRaw), browserRaw })).toThrow("PROTECTED_SCENARIO_EVIDENCE_INVALID");
  });

  it.each(["missing", "duplicate", "changed"] as const)("refuses a %s local binding", (kind) => {
    const input = evidence();
    const local = JSON.parse(input.localRaw);
    if (kind === "missing") local.browser.pop();
    if (kind === "duplicate") local.browser[1] = local.browser[0];
    if (kind === "changed") local.browser[0].binding = "0".repeat(64);
    const localRaw = JSON.stringify(local);
    expect(() => finishPrScenarioEvidence({ ...input, localRaw, localDigest: scenarioEvidenceDigest(localRaw) }))
      .toThrow("LOCAL_SCENARIO_COVERAGE_INVALID");
  });

  it.each(["TEST_SKIPPED", "TEST_FAILED", "FILE_NOT_EXECUTED"])("refuses local %s despite a valid browser receipt", (code) => {
    const input = evidence();
    const local = JSON.parse(input.localRaw);
    local.backend[0].code = code;
    const localRaw = JSON.stringify(local);
    expect(() => finishPrScenarioEvidence({ ...input, localRaw, localDigest: scenarioEvidenceDigest(localRaw) }))
      .toThrow("LOCAL_SCENARIO_VERDICT_REFUSED");
  });

  it("does not let protected evidence excuse an unexecuted static case", () => {
    const input = evidence();
    const local = JSON.parse(input.localRaw);
    local.browser.find(({ id }: { id: string }) => id === staticCase.id).code = "BROWSER_REPLAY_NOT_EXECUTED";
    const localRaw = JSON.stringify(local);
    expect(() => finishPrScenarioEvidence({ ...input, localRaw, localDigest: scenarioEvidenceDigest(localRaw) }))
      .toThrow("LOCAL_SCENARIO_VERDICT_REFUSED");
  });

  it.each(["missing", "duplicate", "changed"] as const)("refuses a %s protected binding", (kind) => {
    const input = evidence();
    const receipt = JSON.parse(input.browserRaw);
    if (kind === "missing") receipt.records.pop();
    if (kind === "duplicate") receipt.records.push(receipt.records[0]);
    if (kind === "changed") receipt.records[0].fingerprint = "0".repeat(64);
    expect(() => finishPrScenarioEvidence({ ...input, browserRaw: JSON.stringify(receipt) }))
      .toThrow("PROTECTED_SCENARIO_EVIDENCE_INVALID");
  });
});

describe("protected registry obligations", () => {
  const baseRecords = [backend, protectedCase, staticCase];
  const changed = ["opening/form.tsx"];
  const rulingId = "SCRUM-123#c4567";
  const protectedRulings = [{ id: rulingId, digest: "1".repeat(64) }];
  function preserve(candidateRecords: (typeof baseRecords)[number][]) {
    return preserveScenarioObligations({ baseRecords, candidateRecords,
      selection: selectForPr(candidateRecords, changed), changed, protectedRulings });
  }

  it.each(baseRecords)("refuses deletion or demotion of $id", (record) => {
    expect(() => preserve(baseRecords.filter(candidateRecord => candidateRecord.id !== record.id)))
      .toThrow("ACTIVE_SCENARIO_NOT_RETAINED");
    const demoted = baseRecords.map(candidateRecord => candidateRecord.id === record.id
      ? { ...candidateRecord, status: "candidate" } : candidateRecord);
    expect(() => preserve(demoted)).toThrow("ACTIVE_SCENARIO_NOT_RETAINED");
  });

  it("refuses masking a selected static scenario by changing its source scope", () => {
    expect(() => preserve([backend, protectedCase, { ...staticCase, sourceGlobs: ["elsewhere/**"] }]))
      .toThrow("ACTIVE_SCENARIO_NOT_SELECTED");
  });

  it("refuses replacing an authenticated replay with a static binding", () => {
    expect(() => preserve([backend, { ...protectedCase, impl: staticCase.impl }, staticCase]))
      .toThrow("PROTECTED_SCENARIO_CLASS_CHANGED");
  });

  it("retains the base receipt obligation during a ruled retirement", () => {
    const retirement = { ...protectedCase, status: "retired", retiredReason: "Owner replaced this stage",
      retiredByRuling: rulingId };
    const unproven = { ...retirement, retiredByRuling: "SCRUM-321#c5678" };
    expect(() => preserve([backend, unproven, staticCase])).toThrow("SCENARIO_RETIREMENT_UNPROVEN");
    expect(preserve([backend, retirement, staticCase])).toEqual([protectedCase]);
  });
});

describe("local evidence published for the exact workflow attempt", () => {
  const artifactId = 987;
  const digest = "1".repeat(64);
  const artifact = { id: artifactId, name: "pr-local-scenarios-200-2", expired: false,
    size_in_bytes: 100, digest: `sha256:${digest}`,
    workflow_run: { id: 200, repository_id: 42, head_repository_id: 42, head_sha: candidate.headSha } };

  it.each([
    ["missing", [], artifact],
    ["duplicate", [artifact, artifact], artifact],
    ["prior run", [artifact], { ...artifact, workflow_run: { ...artifact.workflow_run, id: 199 } }],
    ["prior attempt", [artifact], { ...artifact, name: "pr-local-scenarios-200-1" }],
    ["other repo", [artifact], { ...artifact, workflow_run: { ...artifact.workflow_run, head_repository_id: 43 } }],
    ["other head", [artifact], { ...artifact, workflow_run: { ...artifact.workflow_run, head_sha: candidate.baseSha } }],
    ["expired", [artifact], { ...artifact, expired: true }],
    ["archive digest mismatch", [artifact], { ...artifact, digest: `sha256:${"2".repeat(64)}` }],
  ])("refuses %s artifact provenance before download", (_label, listed, details) => {
    const api = vi.fn().mockReturnValueOnce({ total_count: listed.length, artifacts: listed }).mockReturnValueOnce(details);
    const downloadZip = vi.fn();
    expect(() => readPublishedLocalScenarios({ candidate, artifactId, digest, api, downloadZip }))
      .toThrow("LOCAL_SCENARIO_ARTIFACT_INVALID");
    expect(downloadZip).not.toHaveBeenCalled();
  });
});
