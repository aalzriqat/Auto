import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { extractCanonicalInvariants } from "./jevImpact.mjs";
import {
  AUDIT_ARTIFACT_NAME,
  BINDING_STATUS,
  CONTROLLER_WORKFLOW_PATH,
  NOT_EVALUABLE_REASON,
  OUTCOME_UNAVAILABLE_REASON,
  readAuditBinding,
} from "./reviewAuditAuthority.mjs";
import {
  BatchHalt,
  CHECK_NAME,
  createGithubClient,
  deriveRequirements,
  isAdmittedTestFile,
  LIMITS,
  runController,
  UNCLASSIFIED_REQUIREMENT,
  UNIT_SUITE_EXCLUDED_DIRS,
} from "./reviewAuditController.mjs";
import { createGitPort } from "./reviewAuditControllerCli.mjs";
import { VERDICTS } from "./reviewEvidence.mjs";

const ROOT = process.cwd();
const policy = JSON.parse(readFileSync(path.join(ROOT, ".github/review-policy.json"), "utf8"));
const invariants = extractCanonicalInvariants(ROOT);
const sha = (c: string) => c.repeat(40);
const MAIN_TIP = sha("a");
const HEAD = sha("b");
const MERGE = sha("c");
const REPO = 4242;
const RUN = { id: 900, attempt: 1, workflowSha: MAIN_TIP, artifactName: AUDIT_ARTIFACT_NAME };

type Blobs = Record<string, string>;

function fakeGit(options: { files: string[]; blobs?: Blobs; modes?: Record<string, string>; parents?: string[]; fetched?: { head: string; merge: string } }) {
  const blobs = options.blobs ?? {};
  return {
    fetchPull: vi.fn(() => options.fetched ?? { head: HEAD, merge: MERGE }),
    parents: vi.fn(() => options.parents ?? [MAIN_TIP, HEAD]),
    changedFiles: vi.fn((from: string, to: string) => (from === MAIN_TIP && to === MERGE ? options.files : [])),
    isAncestor: vi.fn(() => true),
    blobSize: vi.fn((_sha: string, file: string) => (Object.hasOwn(blobs, file) ? Buffer.byteLength(blobs[file]) : null)),
    fileMode: vi.fn((_sha: string, file: string) => (Object.hasOwn(blobs, file) ? (options.modes?.[file] ?? "100644") : null)),
    blobId: vi.fn(() => sha("d")),
    show: vi.fn((_sha: string, file: string) => blobs[file]),
  };
}

function pull(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    state: "open",
    mergeable: true,
    merge_commit_sha: MERGE,
    base: { ref: "main" },
    head: { sha: HEAD, repo: { id: REPO } },
    ...overrides,
  };
}

function fakeGithub(pulls: Record<number, unknown[]>) {
  const calls: Record<number, number> = {};
  const checkRuns: Record<string, unknown>[] = [];
  return {
    checkRuns,
    listOpenPulls: vi.fn(async () => Object.keys(pulls).map((n) => ({ number: Number(n), base: { ref: "main" } }))),
    getPull: vi.fn(async (n: number) => {
      const sequence = pulls[n];
      const index = Math.min(calls[n] ?? 0, sequence.length - 1);
      calls[n] = (calls[n] ?? 0) + 1;
      const next = sequence[index];
      if (next instanceof Error) throw next;
      return next;
    }),
    createCheckRun: vi.fn(async (checkRun: Record<string, unknown>) => {
      checkRuns.push(checkRun);
      return {};
    }),
  };
}

function context(github: ReturnType<typeof fakeGithub>, git: ReturnType<typeof fakeGit>) {
  return { github, git, trusted: { policy, invariants }, run: RUN, repositoryId: REPO, mainTip: MAIN_TIP, sleep: vi.fn(async () => {}) };
}

async function auditOne(git: ReturnType<typeof fakeGit>, sequence: unknown[] = [pull()]) {
  const github = fakeGithub({ 7: sequence });
  const ctx = context(github, git);
  const result = await runController(ctx);
  return { ...result, github, ctx, payload: result.payloads[0] };
}

describe("SCRUM-644 S3b-2 requirement derivation", () => {
  test("DA-1: a change no catalog source area classifies cannot pass as NOT_REQUIRED", () => {
    const { requirements, unclassifiedCount } = deriveRequirements({
      files: ["packages/shared/src/financingEconomics.ts"],
      invariants,
      policy,
    });
    expect(unclassifiedCount).toBe(1);
    expect(requirements).toContain(UNCLASSIFIED_REQUIREMENT);
  });

  test("DA-1 controls: a record-only change needs nothing; a catalog-covered change gets no fallback", () => {
    expect(deriveRequirements({ files: ["review-evidence/pr-7.json"], invariants, policy })).toEqual({
      requirements: [],
      unclassifiedCount: 0,
    });
    const covered = deriveRequirements({ files: ["convex/finance.ts"], invariants, policy });
    expect(covered.unclassifiedCount).toBe(0);
    expect(covered.requirements).not.toContain(UNCLASSIFIED_REQUIREMENT);
    expect(covered.requirements.length).toBeGreaterThan(0);
    const governed = deriveRequirements({ files: ["package.json"], invariants, policy });
    expect(governed.requirements).toContain("review:correctness-governance");
    expect(governed.requirements).not.toContain(UNCLASSIFIED_REQUIREMENT);
  });

  test("one unclassified path beside covered ones still adds the fallback", () => {
    const mixed = deriveRequirements({ files: ["convex/finance.ts", "lib/financingEconomics.ts"], invariants, policy });
    expect(mixed).toMatchObject({ unclassifiedCount: 1 });
    expect(mixed.requirements).toContain(UNCLASSIFIED_REQUIREMENT);
  });
});

describe("SCRUM-644 S3b-2 controller outcomes", () => {
  test("DA-1 end to end: a shared-only PR with no record never publishes success", async () => {
    const { payload, github } = await auditOne(fakeGit({ files: ["packages/shared/src/financingEconomics.ts"] }));
    expect(payload.outcome).toEqual({ kind: "VERDICT", verdict: VERDICTS.INVALID });
    expect(payload.conclusion).toBe("failure");
    expect(github.checkRuns).toHaveLength(1);
    expect(github.checkRuns[0]).toMatchObject({ name: CHECK_NAME, head_sha: HEAD, conclusion: "failure" });
  });

  test("positive control: a record-only PR is NOT_REQUIRED and passes", async () => {
    const { payload } = await auditOne(fakeGit({ files: ["review-evidence/pr-7.json"], blobs: { "review-evidence/pr-7.json": "{}" } }));
    expect(payload.outcome).toEqual({ kind: "VERDICT", verdict: VERDICTS.NOT_REQUIRED });
    expect(payload.conclusion).toBe("success");
    expect(payload).toMatchObject({ N: 7, H: HEAD, M: MERGE, mainTip: MAIN_TIP, controllerRunId: 900, runAttempt: 1 });
  });

  test("a record that answers the shared-only change still cannot clear the unclassified review", async () => {
    const record = JSON.stringify({ policyVersion: policy.policyVersion, obligations: [] });
    const { payload } = await auditOne(
      fakeGit({
        files: ["packages/shared/src/financingEconomics.ts", "review-evidence/pr-7.json"],
        blobs: { "review-evidence/pr-7.json": record },
      }),
    );
    expect(payload.outcome.verdict).toBe(VERDICTS.REVIEW_UNRESOLVED);
    expect(payload.conclusion).toBe("action_required");
    expect(payload.unresolvedReviews).toContain(UNCLASSIFIED_REQUIREMENT);
  });

  const provenanceCases: [string, Parameters<typeof fakeGit>[0], unknown[], string][] = [
    ["mergeability still unknown after one retry", { files: [] }, [pull({ mergeable: null })], NOT_EVALUABLE_REASON.MERGE_PENDING],
    ["a conflicted PR", { files: [] }, [pull({ mergeable: false })], NOT_EVALUABLE_REASON.CONFLICTED],
    ["a fork", { files: [] }, [pull({ head: { sha: HEAD, repo: { id: 1 } } })], NOT_EVALUABLE_REASON.FORK],
    ["a PR retargeted off main", { files: [] }, [pull({ base: { ref: "release" } })], NOT_EVALUABLE_REASON.STALE_BASE],
    ["a closed PR", { files: [] }, [pull({ state: "closed" })], NOT_EVALUABLE_REASON.STALE_BASE],
    ["a deleted fork (null head repository)", { files: [] }, [pull({ head: { sha: HEAD, repo: null } })], NOT_EVALUABLE_REASON.FORK],
    ["a head that moved before the fetch", { files: [], fetched: { head: sha("e"), merge: MERGE } }, [pull()], NOT_EVALUABLE_REASON.HEAD_MOVED],
    ["a merge ref that is not merge_commit_sha", { files: [], fetched: { head: HEAD, merge: sha("e") } }, [pull()], NOT_EVALUABLE_REASON.MERGE_REF_MISMATCH],
    ["a merge whose second parent is not the head", { files: [], parents: [MAIN_TIP, sha("e")] }, [pull()], NOT_EVALUABLE_REASON.MERGE_REF_MISMATCH],
    ["an octopus merge", { files: [], parents: [MAIN_TIP, HEAD, sha("e")] }, [pull()], NOT_EVALUABLE_REASON.MERGE_REF_MISMATCH],
    ["a merge computed against an older main", { files: [], parents: [sha("e"), HEAD] }, [pull()], NOT_EVALUABLE_REASON.STALE_BASE],
  ];
  test.each(provenanceCases)("%s is NOT_EVALUABLE, never a verdict", async (_name, gitOptions, sequence, reason) => {
    const git = fakeGit(gitOptions);
    const { payload, github } = await auditOne(git, sequence);
    // Refused before anything is evaluated, not merely caught later.
    expect(git.changedFiles).not.toHaveBeenCalled();
    expect(payload.outcome).toEqual({ kind: "NOT_EVALUABLE", reason });
    expect(payload.conclusion).toBe("action_required");
    expect(github.checkRuns.map((run) => run.conclusion)).toEqual(["action_required"]);
  });

  test("an unknown mergeable state is retried exactly once before MERGE_PENDING", async () => {
    const { payload, ctx } = await auditOne(fakeGit({ files: ["review-evidence/x.json"], blobs: { "review-evidence/x.json": "{}" } }), [
      pull({ mergeable: null }),
      pull(),
    ]);
    expect(ctx.sleep).toHaveBeenCalledTimes(1);
    expect(payload.outcome.verdict).toBe(VERDICTS.NOT_REQUIRED);
  });

  test.each([
    ["two records", { "review-evidence/a.json": "{}", "review-evidence/b.json": "{}" }],
    ["an unparseable record", { "review-evidence/a.json": "{not json" }],
    ["an oversized record", { "review-evidence/a.json": `{"pad":"${"x".repeat(LIMITS.recordBytes)}"}` }],
  ])("%s is a malformed record: INVALID", async (_name, blobs) => {
    const { payload } = await auditOne(fakeGit({ files: ["convex/finance.ts", ...Object.keys(blobs)], blobs }));
    expect(payload.outcome.verdict).toBe(VERDICTS.INVALID);
    expect(payload.reasons.map((reason: { code: string }) => reason.code)).toContain("MALFORMED_RECORD");
  });

  test("a record deleted by the PR is not read: the change has no record", async () => {
    const { payload } = await auditOne(fakeGit({ files: ["convex/finance.ts", "review-evidence/old.json"] }));
    expect(payload.reasons.map((reason: { code: string }) => reason.code)).toEqual(["MISSING_RECORD"]);
  });

  test("an over-budget cited test file is REGISTRY_BUDGET, not a verdict", async () => {
    const record = JSON.stringify({
      policyVersion: policy.policyVersion,
      obligations: [{ requirement: "proof:NEGATIVE", evidence: [{ kind: "test", file: "convex/big.test.ts", title: "proof:NEGATIVE", sha: HEAD }] }],
    });
    const { payload } = await auditOne(
      fakeGit({
        files: ["convex/finance.ts", "review-evidence/a.json"],
        blobs: { "review-evidence/a.json": record, "convex/big.test.ts": "x".repeat(LIMITS.testFileBytes + 1) },
      }),
    );
    expect(payload.outcome).toEqual({ kind: "NOT_EVALUABLE", reason: NOT_EVALUABLE_REASON.REGISTRY_BUDGET });
  });

  test("a registered test is read from the merge; one outside the unit suite's roots is never registered", async () => {
    const testSource = 'import { test } from "vitest";\ntest("guards proof:NEGATIVE", () => {});\n';
    const evidence = (file: string) => ({ kind: "test", file, title: "guards proof:NEGATIVE", sha: HEAD });
    const recordFor = (file: string) =>
      JSON.stringify({ policyVersion: policy.policyVersion, obligations: [{ requirement: "proof:NEGATIVE", evidence: [evidence(file)] }] });
    const reasonsFor = async (file: string) => {
      const { payload } = await auditOne(
        fakeGit({
          files: ["convex/finance.ts", "review-evidence/a.json"],
          blobs: { "review-evidence/a.json": recordFor(file), [file]: testSource },
        }),
      );
      return payload.reasons.filter((reason: { requirement?: string }) => reason.requirement === "proof:NEGATIVE");
    };
    expect(await reasonsFor("convex/guard.test.ts")).toEqual([]);
    expect(await reasonsFor("packages/shared/src/guard.test.ts")).toEqual([{ code: "TEST_NOT_REGISTERED", requirement: "proof:NEGATIVE" }]);
    expect(await reasonsFor("convex/build/guard.test.ts")).toEqual([{ code: "TEST_NOT_REGISTERED", requirement: "proof:NEGATIVE" }]);
  });

  test("M1: a cited test that is a symlink or submodule is not registered; a regular or executable file is", async () => {
    const testSource = 'import { test } from "vitest";\ntest("guards proof:NEGATIVE", () => {});\n';
    const file = "convex/guard.test.ts";
    const record = JSON.stringify({
      policyVersion: policy.policyVersion,
      obligations: [{ requirement: "proof:NEGATIVE", evidence: [{ kind: "test", file, title: "guards proof:NEGATIVE", sha: HEAD }] }],
    });
    const reasonsWithMode = async (mode: string) => {
      const { payload } = await auditOne(
        fakeGit({
          files: ["convex/finance.ts", "review-evidence/a.json"],
          blobs: { "review-evidence/a.json": record, [file]: testSource },
          modes: { [file]: mode },
        }),
      );
      return payload.reasons.filter((reason: { requirement?: string }) => reason.requirement === "proof:NEGATIVE");
    };
    for (const mode of ["120000", "160000"]) expect(await reasonsWithMode(mode), mode).toEqual([{ code: "TEST_NOT_REGISTERED", requirement: "proof:NEGATIVE" }]);
    for (const mode of ["100644", "100755"]) expect(await reasonsWithMode(mode), mode).toEqual([]);
  });

  test("a head that moves during evaluation publishes nothing for the stale head", async () => {
    const { payload, github } = await auditOne(fakeGit({ files: ["review-evidence/x.json"], blobs: { "review-evidence/x.json": "{}" } }), [
      pull(),
      pull({ head: { sha: sha("e"), repo: { id: REPO } } }),
    ]);
    expect(payload.outcome).toEqual({ kind: "NOT_EVALUABLE", reason: NOT_EVALUABLE_REASON.HEAD_MOVED });
    expect(github.checkRuns).toEqual([]);
  });

  // TRE-1 (Codex, cb4ee2ea4): the live PR can change under a fixed head. A later
  // run skips a PR that left main, so a success written now would never be replaced.
  const recordOnly = () => fakeGit({ files: ["review-evidence/x.json"], blobs: { "review-evidence/x.json": "{}" } });
  test.each([
    ["retargeted off main", pull({ base: { ref: "release" }, merge_commit_sha: sha("e") }), NOT_EVALUABLE_REASON.STALE_BASE],
    ["closed", pull({ state: "closed" }), NOT_EVALUABLE_REASON.STALE_BASE],
    ["given a new merge commit", pull({ merge_commit_sha: sha("e") }), NOT_EVALUABLE_REASON.MERGE_REF_MISMATCH],
    ["now conflicted", pull({ mergeable: false }), NOT_EVALUABLE_REASON.CONFLICTED],
    ["moved to a fork head repository", pull({ head: { sha: HEAD, repo: { id: 1 } } }), NOT_EVALUABLE_REASON.FORK],
  ])("TRE-1: a PR %s during evaluation is NOT_EVALUABLE on its unchanged head, never success", async (_name, latest, reason) => {
    const { payload, github } = await auditOne(recordOnly(), [pull({ state: "open" }), latest]);
    expect(payload.outcome).toEqual({ kind: "NOT_EVALUABLE", reason });
    expect(github.checkRuns.map((run) => [run.head_sha, run.conclusion])).toEqual([[HEAD, "action_required"]]);
  });

  test("TRE-1 control: an unchanged open PR keeps its verdict", async () => {
    const { payload } = await auditOne(recordOnly(), [pull({ state: "open" }), pull({ state: "open" })]);
    expect(payload.outcome).toEqual({ kind: "VERDICT", verdict: VERDICTS.NOT_REQUIRED });
  });

  test("candidate text never reaches the check-run", async () => {
    const hostile = "```\n## APPROVED ".concat("x".repeat(5000));
    const record = JSON.stringify({ policyVersion: hostile, obligations: [{ requirement: hostile, evidence: [] }] });
    const { github } = await auditOne(
      fakeGit({ files: ["convex/finance.ts", "review-evidence/a`b.json"], blobs: { "review-evidence/a`b.json": record } }),
    );
    const published = JSON.stringify(github.checkRuns);
    expect(published).not.toContain("APPROVED");
    expect(published).not.toContain("a`b");
    expect(github.checkRuns[0].output).toEqual({
      title: expect.stringMatching(/^record audit(: runtime unproven)? · valid for main @ aaaaaaa$/),
      summary: expect.stringContaining(`Controller run 900 attempt 1; artifact \`${AUDIT_ARTIFACT_NAME}\`, file \`audit-7.json\`.`),
    });
  });
});

describe("SCRUM-644 S3b-2 batch behaviour", () => {
  test("one PR throwing is EVALUATION_ERROR; the others are still audited", async () => {
    const github = fakeGithub({ 7: [pull()], 8: [pull({ number: 8 })] });
    const git = fakeGit({ files: ["review-evidence/x.json"], blobs: { "review-evidence/x.json": "{}" } });
    git.changedFiles.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const { payloads } = await runController(context(github, git));
    expect(payloads.map((payload: { N: number; outcome: unknown }) => [payload.N, payload.outcome])).toEqual([
      [7, { kind: "NOT_EVALUABLE", reason: NOT_EVALUABLE_REASON.EVALUATION_ERROR }],
      [8, { kind: "VERDICT", verdict: VERDICTS.NOT_REQUIRED }],
    ]);
  });

  test("a GitHub error reading one PR is EVALUATION_ERROR for that PR alone, with no check-run", async () => {
    const github = fakeGithub({ 7: [new Error("GitHub GET /pulls/7 answered 500")], 8: [pull({ number: 8 })] });
    const git = fakeGit({ files: ["review-evidence/x.json"], blobs: { "review-evidence/x.json": "{}" } });
    const { payloads, halted } = await runController(context(github, git));
    expect(halted).toBe(false);
    expect(payloads.map((payload: { N: number; H: unknown; outcome: unknown }) => [payload.N, payload.H, payload.outcome])).toEqual([
      [7, null, { kind: "NOT_EVALUABLE", reason: NOT_EVALUABLE_REASON.EVALUATION_ERROR }],
      [8, HEAD, { kind: "VERDICT", verdict: VERDICTS.NOT_REQUIRED }],
    ]);
    expect(github.checkRuns.map((run) => run.head_sha)).toEqual([HEAD]);
  });

  test("a failed publish leaves exactly one payload for that PR and the batch continues", async () => {
    const github = fakeGithub({ 7: [pull()], 8: [pull({ number: 8 })] });
    github.createCheckRun.mockRejectedValueOnce(new Error("GitHub POST /check-runs answered 500"));
    const git = fakeGit({ files: ["review-evidence/x.json"], blobs: { "review-evidence/x.json": "{}" } });
    const { payloads, published } = await runController(context(github, git));
    expect(payloads.map((payload: { N: number; outcome: unknown }) => [payload.N, payload.outcome])).toEqual([
      [7, { kind: "NOT_EVALUABLE", reason: NOT_EVALUABLE_REASON.EVALUATION_ERROR }],
      [8, { kind: "VERDICT", verdict: VERDICTS.NOT_REQUIRED }],
    ]);
    expect(published).toBe(1);
  });

  test("a halt marks the halting PR and every later one BATCH_INCOMPLETE, with no check-run", async () => {
    const github = fakeGithub({ 7: [pull()], 8: [new BatchHalt("429")], 9: [pull({ number: 9 })] });
    const git = fakeGit({ files: ["review-evidence/x.json"], blobs: { "review-evidence/x.json": "{}" } });
    const { payloads, halted } = await runController(context(github, git));
    expect(halted).toBe(true);
    expect(payloads.map((payload: { N: number; outcome: { kind: string; reason?: string } }) => [payload.N, payload.outcome.reason ?? payload.outcome.kind])).toEqual([
      [7, "VERDICT"],
      [8, OUTCOME_UNAVAILABLE_REASON.BATCH_INCOMPLETE],
      [9, OUTCOME_UNAVAILABLE_REASON.BATCH_INCOMPLETE],
    ]);
    expect(github.checkRuns.map((run) => run.head_sha)).toEqual([HEAD]);
  });

  test("a halt during the head re-read halts the batch rather than becoming an EVALUATION_ERROR", async () => {
    const github = fakeGithub({ 7: [pull(), new BatchHalt("429")], 8: [pull({ number: 8 })] });
    const git = fakeGit({ files: ["review-evidence/x.json"], blobs: { "review-evidence/x.json": "{}" } });
    const { payloads, halted } = await runController(context(github, git));
    expect(halted).toBe(true);
    expect(payloads.map((payload: { outcome: { reason?: string } }) => payload.outcome.reason)).toEqual([
      OUTCOME_UNAVAILABLE_REASON.BATCH_INCOMPLETE,
      OUTCOME_UNAVAILABLE_REASON.BATCH_INCOMPLETE,
    ]);
    expect(github.checkRuns).toEqual([]);
  });

  test("pull requests beyond the cap are BATCH_INCOMPLETE", async () => {
    const pulls: Record<number, unknown[]> = {};
    for (let n = 1; n <= LIMITS.maxPullRequests + 2; n += 1) pulls[n] = [pull({ number: n, mergeable: false })];
    const { payloads } = await runController(context(fakeGithub(pulls), fakeGit({ files: [] })));
    const incomplete = payloads.filter((payload: { outcome: { reason?: string } }) => payload.outcome.reason === OUTCOME_UNAVAILABLE_REASON.BATCH_INCOMPLETE);
    expect(incomplete.map((payload: { N: number }) => payload.N)).toEqual([LIMITS.maxPullRequests + 1, LIMITS.maxPullRequests + 2]);
  });

  test("the GitHub client halts on 403, 429 and an exhausted budget, and throws on other errors", async () => {
    const respond = (status: number) => vi.fn(async () => new Response("{}", { status }));
    for (const status of [403, 429]) {
      await expect(createGithubClient({ token: "t", repository: "o/r", fetchImpl: respond(status) }).getPull(1)).rejects.toBeInstanceOf(BatchHalt);
    }
    const failing = createGithubClient({ token: "t", repository: "o/r", fetchImpl: respond(500) });
    await expect(failing.getPull(1)).rejects.not.toBeInstanceOf(BatchHalt);
    const budgeted = createGithubClient({ token: "t", repository: "o/r", fetchImpl: respond(200), budget: 1 });
    await budgeted.getPull(1);
    await expect(budgeted.getPull(1)).rejects.toBeInstanceOf(BatchHalt);
  });
});

describe("SCRUM-644 S3b-2 end to end with the S3b-1 reader", () => {
  const runFor = (event: string) => ({
    id: RUN.id,
    run_attempt: RUN.attempt,
    path: `${CONTROLLER_WORKFLOW_PATH}@refs/heads/main`,
    event,
    head_branch: "main",
    head_sha: MAIN_TIP,
    status: "completed",
    conclusion: "success",
    repository: { id: REPO },
    head_repository: { id: REPO },
  });
  const artifact = { name: AUDIT_ARTIFACT_NAME, expired: false, workflow_run: { id: RUN.id } };

  test("the controller's payload binds for the reader under workflow_run, and not under workflow_dispatch", async () => {
    const { payload } = await auditOne(fakeGit({ files: ["review-evidence/x.json"], blobs: { "review-evidence/x.json": "{}" } }));
    const read = (event: string) =>
      readAuditBinding({ candidates: [{ run: runFor(event), artifact, payload }], repositoryId: REPO, currentMainTip: MAIN_TIP, prNumber: 7, headSha: HEAD });
    expect(read("workflow_run")).toEqual({ status: BINDING_STATUS.BOUND, payload });
    expect(read("workflow_dispatch").status).toBe(BINDING_STATUS.UNAVAILABLE);
  });
});

describe("SCRUM-644 S3b-2 test-file admission", () => {
  test("the excluded directories are exactly CI's unit collector's, which covers every root vitest.config.ts exclude", () => {
    const runner = readFileSync(path.join(ROOT, "scripts/runVitestCoverageShards.mjs"), "utf8");
    const set = runner.match(/const excludedDirs = new Set\(\[([\s\S]*?)\]\)/);
    expect(set).not.toBeNull();
    const runnerDirs = [...(set?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect([...runnerDirs].sort()).toEqual([...UNIT_SUITE_EXCLUDED_DIRS].sort());
    expect(runner).toMatch(/if \(!entry\.isFile\(\)\) continue;/);

    const config = readFileSync(path.join(ROOT, "vitest.config.ts"), "utf8");
    const block = config.match(/test:\s*\{[\s\S]*?include: \["\*\*\/\*\.test\.ts", "\*\*\/\*\.test\.tsx"\],\s*exclude: \[([\s\S]*?)\]/);
    expect(block).not.toBeNull();
    const excludes = [...(block?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(excludes.length).toBeGreaterThan(0);
    for (const entry of excludes) {
      const file = entry.replaceAll("**", "deep").concat("/x.test.ts");
      expect(isAdmittedTestFile(file), file).toBe(false);
    }
  });

  test("only unit-suite test files are admitted: excluded directory names are refused at any depth", () => {
    expect(isAdmittedTestFile("convex/x.test.ts")).toBe(true);
    expect(isAdmittedTestFile("components/x.test.tsx")).toBe(true);
    expect(isAdmittedTestFile("convex/builder/x.test.ts")).toBe(true);
    const refused = ["convex/x.ts", "convex/x.spec.ts", "lib/node_modules/x.test.ts", "a/.claude/x.test.ts", "convex/../x.test.ts", "convex/./x.test.ts", "/x.test.ts", 7];
    for (const dir of UNIT_SUITE_EXCLUDED_DIRS) refused.push(`${dir}/x.test.ts`, `convex/${dir}/x.test.ts`, `lib/a/${dir}/x.test.tsx`);
    for (const file of refused) expect(isAdmittedTestFile(file), String(file)).toBe(false);
  });
});
describe("SCRUM-644 S3b-2 git port", () => {
  test("refuses anything but a full SHA or a plain path before calling git", () => {
    const git = createGitPort();
    expect(() => git.isAncestor("--output=/tmp/x", MAIN_TIP)).toThrow("not a commit SHA");
    expect(() => git.blobSize(MAIN_TIP, "-x")).toThrow("bad path");
    expect(() => git.fetchPull(0)).toThrow("bad PR number");
  });
});

describe("SCRUM-644 S3b-2 workflow structure", () => {
  const file = path.join(ROOT, ".github/workflows/trusted-review-evidence.yml");
  const text = readFileSync(file, "utf8");
  const workflow = parseYaml(text);

  test("runs only main's copy: push to main and workflow_run of Invariant Governance", () => {
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      workflow_run: { workflows: ["Invariant Governance"], types: ["completed"] },
    });
    expect(workflow.jobs.reconcile.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflow.concurrency).toEqual({ group: "tre-reconcile", "cancel-in-progress": false });
  });

  test("holds nothing at workflow level, exactly the four permissions on its one job, and no secret", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["reconcile"]);
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.reconcile.permissions).toEqual({ checks: "write", contents: "read", "pull-requests": "read", actions: "read" });
    expect(text).not.toMatch(/secrets\.|secrets\[/);
  });

  test("workflow_run pwn-request class: no PR-controlled expression, nothing interpolated into a shell, every action pinned", () => {
    // Only these two expressions exist anywhere in the file; both are run context, never PR data.
    const expressions = [...text.matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/g)].map((match) => match[1]);
    expect([...new Set(expressions)].sort()).toEqual(["github.token", "github.workflow_sha"]);
    const steps: { run?: string; uses?: string; with?: Record<string, unknown> }[] = workflow.jobs.reconcile.steps;
    for (const step of steps) {
      if (step.run !== undefined) expect(step.run, step.run).not.toContain("${{");
      if (step.uses !== undefined) expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    }
    // One checkout, of the workflow's own revision; no other step selects a ref.
    const refs = steps.filter((step) => step.with && "ref" in step.with).map((step) => step.with?.ref);
    expect(refs).toEqual(["${{ github.workflow_sha }}"]);
  });

  test("the controller never executes candidate content: git is the only process, no dynamic code", () => {
    const controller = readFileSync(path.join(ROOT, "scripts/intelligence/reviewAuditController.mjs"), "utf8");
    const cli = readFileSync(path.join(ROOT, "scripts/intelligence/reviewAuditControllerCli.mjs"), "utf8");
    for (const source of [controller, cli]) {
      expect(source).not.toMatch(/\beval\(|new Function|\bimport\(|\brequire\(|\bspawn(Sync)?\(|\bexec\(|\bexecSync\(/);
    }
    expect(controller).not.toContain("child_process");
    expect([...cli.matchAll(/execFileSync\(([^,]+),/g)].map((match) => match[1])).toEqual(['"git"']);
  });

  test("report-only: the check name collides with no release-gated check or waiver", () => {
    const waivers = JSON.parse(readFileSync(path.join(ROOT, ".github/release-waivers.json"), "utf8"));
    const names: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key === "name" && typeof value === "string") names.push(value);
          walk(value);
        }
      }
    };
    walk(waivers);
    expect(names.length).toBeGreaterThan(0);
    expect(names.map((name) => name.toLowerCase())).not.toContain(CHECK_NAME);
    expect(JSON.stringify(waivers)).not.toContain(CHECK_NAME);
    // The job's own check-run must not carry the published name either.
    expect(workflow.jobs.reconcile.name).not.toBe(CHECK_NAME);
  });

  test("checks out the workflow's own revision without credentials and asserts it is main's tip", () => {
    const steps = workflow.jobs.reconcile.steps;
    expect(steps[0].with).toEqual({ ref: "${{ github.workflow_sha }}", "fetch-depth": 0, "persist-credentials": false });
    expect(steps[1].run).toContain('"$main_tip" != "$GITHUB_WORKFLOW_SHA"');
    expect(steps[1].run).toContain('"$checkout" != "$GITHUB_WORKFLOW_SHA"');
    expect(steps.some((step: { run?: string }) => step.run === "pnpm install --frozen-lockfile --ignore-scripts")).toBe(true);
    expect(text).not.toMatch(/github\.event\.(pull_request|workflow_run)|head_branch|head\.ref|cache:/);
  });

  test("no other workflow uses the controller's name, artifact or check name", () => {
    const dir = path.join(ROOT, ".github/workflows");
    const others = readdirSync(dir)
      .filter((name) => /\.ya?ml$/.test(name) && name !== "trusted-review-evidence.yml")
      .map((name) => readFileSync(path.join(dir, name), "utf8"));
    for (const other of others) {
      expect(other).not.toContain(AUDIT_ARTIFACT_NAME);
      expect(other).not.toMatch(new RegExp(`name:\\s*${CHECK_NAME}\\s*$`, "m"));
    }
  });
});
