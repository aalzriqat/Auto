// @vitest-environment node
import { describe, expect, it } from "vitest";
import { bindTrustedBrowserReplays, verifyTrustedBrowserReceipt } from "./trustedBrowserReceipt.mjs";

const expected = {
  repositoryId: 1258400280, workflowId: 363714180, runId: 43969132881, attempt: 1,
  artifactId: 14278054464, prNumber: 825,
  baseSha: "f95cd62838322fea0a831975303b4bf0b9fe9f1a",
  headSha: "9123574f8317460c3932e5e92d07383d851f8188",
  testedSha: "d317838c4efaad10e72f36427370302389200b50",
  controllerSha: "f95cd62838322fea0a831975303b4bf0b9fe9f1a",
};
const archiveSha256 = "447f79d10b4bc5c5a95599ef3466ab4da4bd978f28e9e6a55acf040c1de1862a";

function receiptFixture() {
  const { repositoryId, workflowId, runId, attempt, artifactId, prNumber, baseSha, headSha, testedSha, controllerSha } = expected;
  const producer = { id: runId, head_branch: "main", head_sha: controllerSha };
  const job = { run_id: runId, run_attempt: attempt, status: "completed", conclusion: "success" };
  return {
    expected,
    run: {
      ...producer, run_attempt: attempt, workflow_id: workflowId, repository: { id: repositoryId },
      head_repository: { id: repositoryId }, path: ".github/workflows/browser-attack-swarm.yml",
      event: "workflow_run", status: "completed", conclusion: "success", pull_requests: [],
    },
    jobs: [{ ...job, name: "trusted-e2e" }, { ...job, name: "authenticated-pr-e2e-publish" }],
    artifact: {
      id: artifactId, expired: false, name: `trusted-g5-evidence-${runId}-${attempt}`,
      digest: `sha256:${archiveSha256}`,
      workflow_run: { ...producer, repository_id: repositoryId, head_repository_id: repositoryId },
    },
    archiveSha256,
    check: {
      name: "authenticated-pr-e2e", external_id: `g5:${prNumber}:${runId}:${attempt}`,
      head_sha: headSha, status: "completed", conclusion: "success", app: { slug: "github-actions" },
    },
    pull: {
      number: prNumber, state: "open", draft: false,
      base: { ref: "main", sha: baseSha, repo: { id: repositoryId } },
      head: { sha: headSha, repo: { id: repositoryId } },
    },
    mergeRef: { ref: `refs/pull/${prNumber}/merge`, object: { type: "commit", sha: testedSha } },
    merge: { sha: testedSha, parents: [{ sha: baseSha }, { sha: headSha }] },
    evidence: { headSha, testedSha, controllerSha },
  };
}

describe("protected browser receipt provenance", () => {
  it("verifies the successful exact attempt even when GitHub omits the workflow run's PR list", () => {
    expect(verifyTrustedBrowserReceipt(receiptFixture())).toBe(true);
  });

  const invalid: [string, (fixture: ReturnType<typeof receiptFixture>) => void][] = [
    ["a newer attempt", ({ run }) => { run.run_attempt++; }],
    ["a different workflow", ({ run }) => { run.workflow_id++; }],
    ["a fork controller", ({ run }) => { run.head_repository.id++; }],
    ["a failed producing job", ({ jobs }) => { jobs[0].conclusion = "failure"; }],
    ["a skipped publisher", ({ jobs }) => { jobs[1].conclusion = "skipped"; }],
    ["duplicated job names", ({ jobs }) => { jobs.push(jobs[0]); }],
    ["a different immutable artifact", ({ artifact }) => { artifact.id++; }],
    ["a downloaded archive that differs from the GitHub digest", (fixture) => { fixture.archiveSha256 = "a".repeat(64); }],
    ["an expired artifact", ({ artifact }) => { artifact.expired = true; }],
    ["the previous artifact attempt", ({ artifact }) => { artifact.name = `trusted-g5-evidence-${expected.runId}-2`; }],
    ["another controller on the artifact", ({ artifact }) => { artifact.workflow_run.head_sha = "c".repeat(40); }],
    ["a different PR on the check", ({ check }) => { check.external_id = `g5:826:${expected.runId}:${expected.attempt}`; }],
    ["a different check issuer", ({ check }) => { check.app.slug = "other-app"; }],
    ["a pull request retargeted away from main", ({ pull }) => { pull.base.ref = "release"; }],
    ["a superseded live merge ref", ({ mergeRef }) => { mergeRef.object.sha = "c".repeat(40); }],
    ["a changed base parent", ({ merge }) => { merge.parents[0].sha = "c".repeat(40); }],
    ["a different tested merge inside the evidence", ({ evidence }) => { evidence.testedSha = "c".repeat(40); }],
  ];

  it.each(invalid)("refuses %s", (_name, mutate) => {
    const fixture = receiptFixture();
    mutate(fixture);
    expect(verifyTrustedBrowserReceipt(fixture)).toBe(false);
  });
});

it("joins only cases bound to the same active trusted record and the receipt's current attempt", () => {
  const record = {
    id: "supplier-p7-browser-ar", status: "active", domain: "screen", level: "browser",
    fingerprint: "e".repeat(64), impl: { file: "playwright/tests/supplier-identity.spec.ts", testName: "supplier in Arabic" },
  };
  const attempt = { producerRunId: String(expected.runId), producerAttempt: String(expected.attempt) };
  const evidence = {
    executedDefinitions: ["supplier-identity.spec.ts"],
    supplierArabicReplay: { id: record.id, code: "PASS", ...attempt },
  };
  const joined = (selected = [record], trusted = [record]) =>
    bindTrustedBrowserReplays({ expected, evidence, explorer: undefined, selected, trusted });
  expect(joined()).toEqual([{ id: record.id, code: "PASS" }]);
  expect(joined([{ ...record, impl: { ...record.impl, testName: "replacement title" } }])).toEqual([]);
  expect(joined([{ ...record, fingerprint: "f".repeat(64) }])).toEqual([]);
  expect(joined([record], [record, record])).toEqual([]);
  evidence.supplierArabicReplay.producerAttempt = "2";
  expect(joined()).toEqual([]);
});

it("refuses a partial or wrong-base explorer census even if the selected case passed", () => {
  const { baseSha, headSha, testedSha, controllerSha, runId, attempt } = expected;
  const records = Array.from({ length: 12 }, (_, index) => ({ id: `walk-${index}`, code: "PASS" }));
  const binding = {
    id: records[0].id, status: "active", level: "browser", domain: "screen", fingerprint: "e".repeat(64),
    impl: { file: "playwright/scenarios/jev-explorer.spec.ts", testName: "a bound walk" },
  };
  const explorer = { baseSha, headSha, testedSha, controllerSha, producerRunId: String(runId), producerAttempt: String(attempt), records };
  const joined = (proof: typeof explorer) =>
    bindTrustedBrowserReplays({ expected, evidence: null, explorer: proof, selected: [binding], trusted: [binding] });
  expect(joined(explorer)).toEqual([records[0]]);
  expect(joined({ ...explorer, records: records.slice(0, 11) })).toEqual([]);
  expect(joined({ ...explorer, baseSha: "e".repeat(40) })).toEqual([]);
});

it("requires the three known sourced cases on the exact attempt before joining any of them", () => {
  const { baseSha, headSha, testedSha, controllerSha, runId, attempt } = expected;
  const records = ["g8-sourced-cash-delivery-screen", "g8-sourced-financed-delivery-screen",
    "g8-sourced-direct-financed-delivery-screen"].map(id => ({ id, code: "PASS" }));
  const selected = records.map(({ id }) => ({
    id, status: "active", level: "browser", domain: "screen", fingerprint: "e".repeat(64),
    impl: { file: "playwright/scenarios/pilot-sourced.spec.ts", testName: id },
  }));
  const proof = { baseSha, headSha, testedSha, controllerSha, producerRunId: String(runId), producerAttempt: String(attempt), records };
  const joined = (sourced: typeof proof) =>
    bindTrustedBrowserReplays({ expected, evidence: null, explorer: undefined, sourced, selected, trusted: selected });
  expect(joined(proof)).toEqual(records);
  expect(joined({ ...proof, records: [records[0], records[1], { id: "unrelated-case", code: "PASS" }] })).toEqual([]);
  expect(joined({ ...proof, producerAttempt: String(attempt + 1) })).toEqual([]);
});
