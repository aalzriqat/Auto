// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startVitest } from "vitest/node";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { digestRulingText, scenarioFingerprint, type ScenarioRecord } from "./scenarioRecord";
import LocalExecutionReporter, { type LocalExecutionReport } from "./localExecutionReporter";
import { main as executeLocal } from "./runLocalExecution.mjs";

const cli = path.resolve(__dirname, "runLocalExecution.mjs");
const title = "selected fixture execution";
let root: string, evidence: string, head: string, record: ScenarioRecord;
const digest = digestRulingText("Synthetic fixture ruling");
const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const scenarioPath = () => path.join(root, "regression/scenarios/fixture.scenario.json");
const config = (extra = "") => `export default { test: { globals: true, environment: "node", include: ["selected.test.ts"], watch: false, ${extra} } };`;
const source = () => `test("${title}", () => { expect(2 + 2).toBe(4); });`;
const saveRecord = () => writeFileSync(scenarioPath(), JSON.stringify(record));

interface Receipt {
  verdict: string;
  trustedProducer: boolean;
  issues: string[];
  source: { before: { head: string }; after: { head: string } | null };
  native: LocalExecutionReport | null;
  process: { exit: number | null } | null;
}

function run(label: string, args: string[] = []): Receipt {
  const output = path.join(evidence, `${label}.json`);
  const child = spawnSync(process.execPath, [cli, "--root", root, "--scenario", record.id, "--output", output, ...args],
    { timeout: 70000, encoding: "utf8", maxBuffer: 1024 * 1024, env: { ...process.env, GITHUB_SHA: "0".repeat(40) } });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(existsSync(output), child.stderr).toBe(true);
  const receipt: Receipt = JSON.parse(readFileSync(output, "utf8"));
  expect(child.status).toBe(receipt.verdict === "PASS" ? 0 : 1);
  const retained = process.env.AUTOFLOW_S3_PROOF_DIR;
  if (retained) {
    mkdirSync(retained, { recursive: true });
    writeFileSync(path.join(retained, `${label}.json`), readFileSync(output));
  }
  return receipt;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "s3-target-fixture-"));
  evidence = mkdtempSync(path.join(tmpdir(), "s3-receipt-fixture-"));
  mkdirSync(path.join(root, "regression/scenarios"), { recursive: true });
  record = { id: "fixture-execution", fingerprint: "", domain: "permission", level: "backend", status: "active",
    source: { hunter: "scripted", runId: "synthetic-unit-fixture", firstSeen: "2026-10-26" },
    steps: [{ actor: { role: "synthetic", org: "FIXTURE" }, action: "fixture.run", input: { answer: 4 } }],
    expected: [{ observable: "fixture.answer", value: 4 }], rulings: [{ id: "SCRUM-761#description", digest }],
    impl: { file: "selected.test.ts", testName: title }, matrixRow: "SYNTHETIC-FIXTURE" };
  record.fingerprint = scenarioFingerprint(record);
  saveRecord();
  writeFileSync(path.join(root, "regression/rulings.json"), JSON.stringify([{ id: "SCRUM-761#description", digest, date: "2026-10-26" }]));
  writeFileSync(path.join(root, "selected.test.ts"), source());
  writeFileSync(path.join(root, "vitest.config.mjs"), config());
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\n.vitest/\n");
  writeFileSync(path.join(root, "marker.txt"), "before");
  git(["init", "-q"]);
  git(["add", "."]);
  // Fixture-only history exercises real immutable base/head objects, never the application branch.
  git(["-c", "user.name=S3Fixture", "-c", "user.email=s3@example.invalid", "commit", "-qm", "Synthetic execution fixture"]);
  head = git(["rev-parse", "HEAD"]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  const link = path.join(root, "dangling-link");
  if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(link);
  for (const target of [root, evidence]) {
    const absolute = path.resolve(target), parent = path.resolve(tmpdir());
    if (!absolute.startsWith(`${parent}${path.sep}s3-`)) throw new Error("Unsafe fixture cleanup path");
    // These created directories contain no dependency junctions or linked checkouts.
    rmSync(absolute, { recursive: true, force: true });
  }
});

test("imported CLI entry executes real Git, child process and receipt I/O", () => {
  const output = path.join(evidence, "imported-entry.json");
  const result = executeLocal(["--root", root, "--scenario", record.id, "--output", output]);
  const receipt: Receipt = JSON.parse(readFileSync(output, "utf8"));
  expect(receipt.verdict).toBe("PASS");
  expect(receipt).toEqual(result);
  expect(receipt.process?.exit).toBe(0);
}, 70000);

test("stdin import leaves the CLI unexecuted", () => {
  const before = git(["status", "--porcelain"]);
  const child = spawnSync(process.execPath, ["--input-type=module", "-"], { cwd: root, encoding: "utf8", timeout: 10000,
    input: `await import(${JSON.stringify(pathToFileURL(cli).href)}); console.log("IMPORTED_WITHOUT_EXECUTION");` });
  const retained = process.env.AUTOFLOW_S3_PROOF_DIR;
  if (retained) { mkdirSync(retained, { recursive: true }); writeFileSync(path.join(retained, "stdin-import-observation.json"),
    JSON.stringify({ exit: child.status, signal: child.signal, error: child.error?.name ?? null, stdout: child.stdout, stderr: child.stderr })); }
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status).toBe(0);
  expect(child.stdout.trim()).toBe("IMPORTED_WITHOUT_EXECUTION");
  expect(child.stderr).toBe("");
  expect(git(["status", "--porcelain"])).toBe(before);
}, 15000);

test.each(["wrong-head", "binding-deleted", "foreign-path", "source-mutation", "native-failed"] as const)(
  "imported CLI retains the actual %s refusal", mode => {
    if (mode === "binding-deleted") { delete record.impl; saveRecord(); }
    if (mode === "foreign-path" && record.impl) { record.impl.file = "../foreign.test.ts"; saveRecord(); }
    if (mode === "source-mutation") writeFileSync(path.join(root, "selected.test.ts"),
      `import { writeFileSync } from "node:fs"; test("${title}", () => { writeFileSync("marker.txt", "after"); expect(4).toBe(4); });`);
    if (mode === "native-failed") writeFileSync(path.join(root, "selected.test.ts"), `test("${title}", () => { expect(3).toBe(4); });`);
    const output = path.join(evidence, `imported-${mode}.json`);
    executeLocal(["--root", root, "--scenario", record.id, "--output", output,
      ...(mode === "wrong-head" ? ["--expect-head", "0".repeat(40)] : [])]);
    const receipt: Receipt = JSON.parse(readFileSync(output, "utf8"));
    expect(receipt.verdict).not.toBe("PASS");
    const expected = { "wrong-head": "EXPECTED_HEAD_MISMATCH", "binding-deleted": "SINGLE_RECORD_BINDING_REQUIRED",
      "foreign-path": "BACKEND_TEST_PATH_REQUIRED", "source-mutation": "SOURCE_CHANGED_DURING_EXECUTION", "native-failed": "CHILD_PROCESS_NOT_CLEAN" };
    expect(receipt.issues).toContain(expected[mode]);
  }, 70000);

test.each(["positive", "runtime-skip", "expected-failure", "zero", "duplicate", "failed"] as const)(
  "native Vitest API delivers measured %s events to the reporter", async mode => {
    if (mode === "runtime-skip") writeFileSync(path.join(root, "selected.test.ts"),
      `const method = "sk" + "ip"; test("${title}", execution => execution[method]());`);
    if (mode === "expected-failure") writeFileSync(path.join(root, "selected.test.ts"),
      `const options = Object.fromEntries([["fa" + "ils", true]]); test("${title}", options, () => { throw new Error("Synthetic expected failure"); });`);
    if (mode === "zero") writeFileSync(path.join(root, "vitest.config.mjs"), config('exclude: ["**/*"], passWithNoTests: true,'));
    if (mode === "duplicate") writeFileSync(path.join(root, "vitest.config.mjs"),
      `export default { test: { projects: ["one", "two"].map(name => ({ test: { name, globals: true, environment: "node", include: ["selected.test.ts"] } })) } };`);
    if (mode === "failed") writeFileSync(path.join(root, "selected.test.ts"), `test("${title}", () => { expect(3).toBe(4); });`);
    const output = path.join(evidence, `api-${mode}.json`);
    vi.stubEnv("AUTOFLOW_LOCAL_SCENARIO_EVENTS", output);
    vi.stubEnv("AUTOFLOW_LOCAL_SCENARIO_ID", record.id);
    vi.stubEnv("AUTOFLOW_LOCAL_SCENARIO_BASE", head);
    const previousExit = process.exitCode;
    let native: Awaited<ReturnType<typeof startVitest>> | undefined;
    try {
      native = await startVitest("test", ["selected.test.ts"], { root, watch: false, maxWorkers: 1,
        fileParallelism: false, reporters: [new LocalExecutionReporter()], coverage: { enabled: false } });
      const receipt: LocalExecutionReport = JSON.parse(readFileSync(output, "utf8"));
      expect(receipt.complete).toBe(true);
      expect(receipt.verdict).toBe(mode === "positive" ? "PASS" : "FAIL");
      if (mode === "expected-failure") expect(receipt.issues).toContain("EXPECTED_FAILURE_IS_NOT_PASS");
      if (mode === "runtime-skip") expect(receipt.cases[0].state).toBe("skipped");
      if (mode === "zero") expect(receipt.cases).toHaveLength(0);
      if (mode === "duplicate") expect(receipt.cases).toHaveLength(2);
      if (mode === "failed") expect(receipt.runReason).toBe("failed");
    } finally {
      await native?.close();
      process.exitCode = previousExit;
    }
  }, 30000);

test("actual native execution joins one record without trusting GitHub environment labels", () => {
  const receipt = run("positive");
  expect(receipt).toMatchObject({ verdict: "PASS", trustedProducer: false, source: { before: { head } } });
  expect(receipt.native?.cases).toHaveLength(1);
  expect(receipt.native?.cases[0]).toMatchObject({ name: title, project: "", state: "passed", expectedFailure: false,
    retryCount: 0, repeatCount: 0, flaky: false });
  expect(receipt.native?.cases[0].id).toEqual(expect.any(String));
}, 70000);

test("junction alias entry executes the CLI and publishes its actual receipt", () => {
  const alias = path.join(evidence, "entry-alias"), output = path.join(evidence, "alias-receipt.json");
  symlinkSync(path.dirname(cli), alias, process.platform === "win32" ? "junction" : "dir");
  try {
    const child = spawnSync(process.execPath, [path.join(alias, path.basename(cli)), "--root", root,
      "--scenario", record.id, "--output", output], { timeout: 70000, encoding: "utf8" });
    const observed = { exit: child.status, signal: child.signal, error: child.error?.name ?? null,
      stdout: child.stdout, stderr: child.stderr, receiptCreated: existsSync(output), platform: process.platform };
    const retained = process.env.AUTOFLOW_S3_PROOF_DIR;
    if (retained) { mkdirSync(retained, { recursive: true }); writeFileSync(path.join(retained, "entry-alias-observation.json"), JSON.stringify(observed)); }
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(existsSync(output), child.stdout).toBe(true);
    const receipt: Receipt = JSON.parse(readFileSync(output, "utf8"));
    expect(receipt.verdict).toBe("PASS");
    expect(receipt.native?.cases).toHaveLength(1);
    expect(receipt.process?.exit).toBe(0);
    if (retained) writeFileSync(path.join(retained, "entry-alias-receipt.json"), readFileSync(output));
  } finally {
    unlinkSync(alias);
  }
}, 70000);

test("Git-listed dangling source link refuses before native execution", () => {
  const target = path.join(root, "absent-target"), link = path.join(root, "dangling-link");
  // Windows measures a real dangling junction; POSIX measures a real file symlink.
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "file");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(existsSync(link)).toBe(false);
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: target, encoding: "utf8" }).trim();
  git(["update-index", "--add", "--cacheinfo", `120000,${blob},dangling-link`]);
  expect(git(["ls-files", "--stage", "--", "dangling-link"])).toMatch(/^120000 /);
  const receipt = run("dangling-link");
  expect(receipt.verdict).toBe("UNAVAILABLE");
  expect(receipt.issues).toContain("SOURCE_SYMLINK_UNAVAILABLE");
  expect(receipt.native).toBeNull();
}, 70000);

test("ordinary Git-listed missing file retains the missing census state", () => {
  unlinkSync(path.join(root, "marker.txt"));
  const receipt = run("ordinary-missing");
  expect(receipt.verdict).toBe("PASS");
  expect(receipt.source.before).toEqual(receipt.source.after);
}, 70000);

test.each(["forbidden-output.json", "..receipt.json"])("refused source output %s is never created", filename => {
  const forbidden = path.join(root, filename);
  expect(existsSync(forbidden)).toBe(false);
  const child = spawnSync(process.execPath, [cli, "--root", root, "--scenario", record.id, "--output", forbidden],
    { timeout: 10000, encoding: "utf8" });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status).toBe(1);
  const retained = process.env.AUTOFLOW_S3_PROOF_DIR;
  if (retained && existsSync(forbidden)) {
    mkdirSync(retained, { recursive: true });
    writeFileSync(path.join(retained, `rejected-${filename.replace(/\./g, "_")}.json`), readFileSync(forbidden));
  }
  expect(existsSync(forbidden), child.stdout).toBe(false);
}, 15000);

test.each(["runtime-skip", "expected-failure", "zero", "duplicate", "source-mutation"] as const)(
  "actual %s execution cannot certify a record", mode => {
    // Runtime indirection deliberately tests the existing validator's documented static-analysis limit.
    if (mode === "runtime-skip") writeFileSync(path.join(root, "selected.test.ts"),
      `const method = "sk" + "ip"; test("${title}", execution => execution[method]());`);
    if (mode === "expected-failure") writeFileSync(path.join(root, "selected.test.ts"),
      `const options = Object.fromEntries([["fa" + "ils", true]]); test("${title}", options, () => { throw new Error("Synthetic expected failure"); });`);
    if (mode === "zero") writeFileSync(path.join(root, "vitest.config.mjs"), config('exclude: ["**/*"], passWithNoTests: true,'));
    if (mode === "duplicate") writeFileSync(path.join(root, "vitest.config.mjs"),
      `export default { test: { projects: ["one", "two"].map(name => ({ test: { name, globals: true, environment: "node", include: ["selected.test.ts"] } })) } };`);
    if (mode === "source-mutation") writeFileSync(path.join(root, "selected.test.ts"),
      `import { writeFileSync } from "node:fs"; test("${title}", () => { writeFileSync("marker.txt", "after"); expect(4).toBe(4); });`);
    const receipt = run(mode);
    expect(receipt.verdict).toBe("FAIL");
    if (mode === "runtime-skip") expect(receipt.native?.cases[0].state).toBe("skipped");
    if (mode === "expected-failure") {
      expect(receipt.native?.cases[0]).toMatchObject({ state: "passed", expectedFailure: true });
      expect(receipt.native?.issues).toContain("EXPECTED_FAILURE_IS_NOT_PASS");
    }
    if (mode === "zero") {
      expect(receipt.process?.exit).toBe(0);
      expect(receipt.native?.complete).toBe(true);
      expect(receipt.native?.cases).toHaveLength(0);
      expect(receipt.native?.issues).toContain("EXACTLY_ONE_EXECUTION_REQUIRED");
    }
    if (mode === "duplicate") expect(receipt.native?.cases).toHaveLength(2);
    if (mode === "source-mutation") {
      expect(receipt.native?.verdict).toBe("PASS");
      expect(receipt.issues).toContain("SOURCE_CHANGED_DURING_EXECUTION");
    }
  }, 70000,
);

test.each(["binding-deleted", "ruling-drift", "active-demoted", "retirement-no-reason", "wrong-head"] as const)(
  "%s refuses before accepting execution", defect => {
    if (defect === "binding-deleted") { delete record.impl; saveRecord(); }
    if (defect === "ruling-drift") {
      record.rulings[0].digest = "0".repeat(64); saveRecord();
    }
    if (defect === "active-demoted") {
      record.status = "candidate"; record.candidateReason = "Synthetic transition"; record.candidateIssue = "SCRUM-761"; saveRecord();
    }
    if (defect === "retirement-no-reason") {
      record.status = "retired"; record.retiredByRuling = "SCRUM-761#description"; saveRecord();
    }
    const receipt = run(defect, defect === "wrong-head" ? ["--expect-head", "0".repeat(40)] : []);
    expect(receipt.verdict).not.toBe("PASS");
    if (defect === "wrong-head") expect(receipt.issues).toContain("EXPECTED_HEAD_MISMATCH");
    if (defect === "active-demoted") expect(receipt.native?.issues.some(issue => issue.startsWith("transition:"))).toBe(true);
    if (defect === "ruling-drift") expect(receipt.native?.issues.some(issue => issue.startsWith("ruling-drift:"))).toBe(true);
    if (defect === "retirement-no-reason") expect(receipt.native?.issues.some(issue => issue.includes("retired"))).toBe(true);
  }, 70000,
);

test.each(["expect-head", "base"])("missing or blank --%s refuses without executing", option => {
  for (const suffix of [[], [""], ["   "]]) {
    const output = path.join(evidence, `${option}-${suffix.length}-${suffix[0]?.length ?? 0}.json`);
    const child = spawnSync(process.execPath, [cli, "--root", root, "--scenario", record.id, "--output", output,
      `--${option}`, ...suffix], { timeout: 70000, encoding: "utf8" });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stdout).toBe(1);
    expect(child.stdout).not.toContain('"verdict":"PASS"');
    if (existsSync(output)) expect(JSON.parse(readFileSync(output, "utf8")).native).toBeNull();
  }
}, 70000);

test("in-root dot-prefixed test filename executes without being mistaken for traversal", () => {
  record.impl!.file = "..x.test.ts";
  saveRecord();
  writeFileSync(path.join(root, "..x.test.ts"), source());
  writeFileSync(path.join(root, "vitest.config.mjs"), config().replace("selected.test.ts", "..x.test.ts"));
  const receipt = run("dot-prefixed");
  expect(receipt.verdict).toBe("PASS");
  expect(receipt.native?.cases[0].file).toBe("..x.test.ts");
}, 70000);
