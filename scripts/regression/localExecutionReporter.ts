import { writeSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Reporter, TestModule, Vitest } from "vitest/node";
import { loadLibrary, validateLibrary, validateTransitions, type ScenarioRecord } from "./scenarioRecord";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";

interface ExecutionCase {
  id: string;
  file: string;
  name: string;
  fullName: string;
  project: string;
  state: string;
  expectedFailure: boolean;
  mode: string;
  retryCount: number | null;
  repeatCount: number | null;
  flaky: boolean | null;
}

export interface LocalExecutionReport {
  schemaVersion: 1;
  root: string;
  scenarioId: string;
  complete: boolean;
  verdict: "PASS" | "FAIL";
  issues: string[];
  cases: ExecutionCase[];
  unhandledErrors: number | null;
  runReason: string | null;
  baseRevision: string;
  selection: { id: string; status: string; fingerprint: string; retiredReason: string | null; retiredByRuling: string | null } | null;
}

function baseRecords(root: string, revision: string): Array<Pick<ScenarioRecord, "id" | "status">> {
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("BASE_REVISION_REQUIRED");
  const git = resolveTrustedGitExecutable();
  const files = execFileSync(git, ["ls-tree", "-rz", "--name-only", revision, "--", "regression/scenarios"],
    { cwd: process.env.AUTOFLOW_LOCAL_SCENARIO_GIT_ROOT || root, encoding: "utf8" }).split("\0").filter(file => file.endsWith(".scenario.json"));
  if (!files.length) throw new Error("BASE_LIBRARY_UNAVAILABLE");
  // These immutable Git records feed the existing transition validator, never an execution verdict.
  return files.map(file => {
    const record: unknown = JSON.parse(execFileSync(git, ["cat-file", "blob", `${revision}:${file}`], { cwd: process.env.AUTOFLOW_LOCAL_SCENARIO_GIT_ROOT || root, encoding: "utf8" }));
    if (!record || typeof record !== "object" || !("id" in record) || typeof record.id !== "string" ||
      !("status" in record) || (record.status !== "active" && record.status !== "candidate" && record.status !== "retired"))
      throw new Error("BASE_TRANSITION_RECORD_UNAVAILABLE");
    return { id: record.id, status: record.status };
  });
}

/** Local advisory only: actual native Reporter events, no trusted producer attestation. */
export default class LocalExecutionReporter implements Reporter {
  /** A descriptor the host opened for this process only (never a file path); workers do not inherit it. */
  private readonly channel = Number(process.env.AUTOFLOW_LOCAL_SCENARIO_FD ?? "");
  private selected: ScenarioRecord | undefined;
  private readonly report: LocalExecutionReport = {
    schemaVersion: 1, root: "", scenarioId: process.env.AUTOFLOW_LOCAL_SCENARIO_ID ?? "",
    complete: false, verdict: "FAIL", issues: [], cases: [], unhandledErrors: null, runReason: null,
    baseRevision: process.env.AUTOFLOW_LOCAL_SCENARIO_BASE ?? "", selection: null,
  };

  private saved = false;

  private save(): void {
    if (!Number.isInteger(this.channel) || this.channel < 3) throw new Error("LOCAL_EVENT_CHANNEL_REQUIRED");
    // One record per run: a second write would make the host's single-document parse fail rather than overwrite.
    if (this.saved) throw new Error("LOCAL_EVENT_ALREADY_WRITTEN");
    this.saved = true;
    writeSync(this.channel, JSON.stringify(this.report));
  }

  onInit(vitest: Vitest): void {
    this.report.root = path.resolve(vitest.config.root);
    try {
      const library = loadLibrary(this.report.root);
      const problems = [...library.problems,
        ...validateLibrary(library.records, { rulings: library.rulings, repoRoot: this.report.root }),
        ...validateTransitions(baseRecords(this.report.root, this.report.baseRevision), library.records)];
      this.report.issues = problems.map(problem => `${problem.rule}: ${problem.scenario}: ${problem.message}`);
      this.selected = library.records.find(record => record.id === this.report.scenarioId);
      if (this.selected) this.report.selection = { id: this.selected.id, status: this.selected.status,
        fingerprint: this.selected.fingerprint, retiredReason: this.selected.retiredReason ?? null,
        retiredByRuling: this.selected.retiredByRuling ?? null };
      if (this.selected?.status !== "active" || this.selected.level !== "backend" || !this.selected.impl)
        this.report.issues.push("ACTIVE_BACKEND_BINDING_REQUIRED");
    } catch (error) {
      console.error("Local execution preflight failed", error);
      this.report.issues.push("LIBRARY_OR_BASE_UNAVAILABLE");
    }
    if (this.report.issues.length) {
      this.save();
      throw new Error("LOCAL_SCENARIO_PREFLIGHT_FAILED");
    }
  }

  private collectCases(modules: ReadonlyArray<TestModule>, binding: NonNullable<ScenarioRecord["impl"]>): void {
    const selectedFile = path.resolve(this.report.root, binding.file);
    for (const testModule of modules) for (const test of testModule.children.allTests()) {
      if (path.resolve(testModule.moduleId) !== selectedFile || test.name !== binding.testName) continue;
      const diagnostic = test.diagnostic();
      this.report.cases.push({ id: test.id, file: path.relative(this.report.root, testModule.moduleId).replace(/\\/g, "/"),
        name: test.name, fullName: test.fullName, project: test.project.name, state: test.result().state,
        expectedFailure: test.options.fails === true, mode: test.options.mode,
        retryCount: diagnostic?.retryCount ?? null, repeatCount: diagnostic?.repeatCount ?? null, flaky: diagnostic?.flaky ?? null });
    }
  }

  private validateCases(): void {
    if (this.report.cases.length !== 1) this.report.issues.push("EXACTLY_ONE_EXECUTION_REQUIRED");
    for (const execution of this.report.cases) {
      if (execution.state !== "passed") this.report.issues.push("SELECTED_TEST_NOT_PASSED");
      if (execution.expectedFailure) this.report.issues.push("EXPECTED_FAILURE_IS_NOT_PASS");
      if (execution.mode !== "run") this.report.issues.push("ORDINARY_RUN_REQUIRED");
      if (execution.retryCount !== 0 || execution.repeatCount !== 0 || execution.flaky !== false)
        this.report.issues.push("SINGLE_NONFLAKY_ATTEMPT_REQUIRED");
    }
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>, errors: ReadonlyArray<unknown>, reason: string): void {
    const binding = this.selected?.impl;
    this.report.unhandledErrors = errors.length;
    this.report.runReason = reason;
    if (!binding) this.report.issues.push("ACTIVE_BACKEND_BINDING_REQUIRED");
    else {
      this.collectCases(modules, binding);
      this.validateCases();
    }
    if (errors.length || reason !== "passed") this.report.issues.push("NATIVE_RUN_NOT_CLEAN");
    this.report.complete = true;
    this.report.verdict = this.report.issues.length ? "FAIL" : "PASS";
    this.save();
  }
}
