// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { startVitest } from "vitest/node";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { digestRulingText, scenarioFingerprint, type ScenarioRecord } from "./scenarioRecord";
import LocalExecutionReporter, { type LocalExecutionReport } from "./localExecutionReporter";
import { main as executeLocal, removeCreatedFile, verifyHarness } from "./runLocalExecution.mjs";

const cli = path.resolve(__dirname, "runLocalExecution.mjs");
const title = "selected fixture execution";
let root: string, evidence: string, head: string, record: ScenarioRecord;
const digest = digestRulingText("Synthetic fixture ruling");
const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const scenarioPath = () => path.join(root, "regression/scenarios/fixture.scenario.json");
const config = (extra = "") => `export default { test: { globals: true, environment: "node", include: ["selected.test.ts"], watch: false, ${extra} } };`;
const source = () => `test("${title}", () => { expect(2 + 2).toBe(4); });`;
/** Trusted embedding caller: the host selects the source root and evidence directory, never argv. */
const host = () => ({ root, evidenceDirectory: evidence });
const commitAll = (message: string) => {
  git(["add", "."]);
  git(["-c", "user.name=S3Fixture", "-c", "user.email=s3@example.invalid", "commit", "-qm", message]);
};
const saveRecord = () =>writeFileSync(scenarioPath(), JSON.stringify(record));

interface Receipt {
  verdict: string;
  trustedProducer: boolean;
  issues: string[];
  source: { before: { head: string }; after: { head: string } | null };
  native: LocalExecutionReport | null;
  process: { exit: number | null } | null;
}

function run(label: string, args: string[] = []): Receipt {
  const child = spawnSync(process.execPath, [cli, "--scenario", record.id, ...args],
    { cwd: root, timeout: 70000, encoding: "utf8", maxBuffer: 1024 * 1024, env: { ...process.env, GITHUB_SHA: "0".repeat(40) } });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  const output = String(JSON.parse(child.stdout).output);
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
  const output = path.join(evidence, "result.json");
  const result = executeLocal(["--root", root, "--scenario", record.id], host());
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
    // Only committed code runs; wrong-head, binding and path refusals fire before that check.
    if (mode === "source-mutation" || mode === "native-failed") commitAll("candidate test");
    const output = path.join(evidence, "result.json");
    executeLocal(["--root", root, "--scenario", record.id,
      ...(mode === "wrong-head" ? ["--expect-head", "0".repeat(40)] : [])], host());
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
    const channel = openSync(output, "wx");
    vi.stubEnv("AUTOFLOW_LOCAL_SCENARIO_FD", String(channel));
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
      closeSync(channel);
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
  const alias = path.join(evidence, "entry-alias");
  symlinkSync(path.dirname(cli), alias, process.platform === "win32" ? "junction" : "dir");
  try {
    const child = spawnSync(process.execPath, [path.join(alias, path.basename(cli)),
      "--scenario", record.id], { cwd: root, timeout: 70000, encoding: "utf8" });
    const output = String(JSON.parse(child.stdout).output);
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

test("a tracked path through a symlinked parent directory refuses before native execution", () => {
  const outside = mkdtempSync(path.join(tmpdir(), "s3-outside-"));
  try {
    mkdirSync(path.join(root, "linked"));
    writeFileSync(path.join(root, "linked/inside.txt"), "tracked");
    git(["add", "linked/inside.txt"]);
    rmSync(path.join(root, "linked"), { recursive: true });
    writeFileSync(path.join(outside, "inside.txt"), "foreign");
    symlinkSync(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    // Ignored, so the census sees only the tracked path below the link and the parent check must be what refuses.
    writeFileSync(path.join(root, ".gitignore"), "node_modules/\n.vitest/\nlinked\n");
    const receipt = run("symlinked-parent");
    expect(receipt.verdict).toBe("UNAVAILABLE");
    expect(receipt.issues).toContain("SOURCE_SYMLINK_UNAVAILABLE");
    expect(receipt.native).toBeNull();
  } finally {
    const link = path.join(root, "linked");
    if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(link);
    rmSync(outside, { recursive: true, force: true });
  }
}, 70000);

// Node reads TEMP/TMP on Windows and TMPDIR on POSIX, so pointing all three covers the effective one on either.
test("a temp directory inside the checkout creates nothing and refuses", () => {
  const before = readdirSync(root).sort();
  const child = spawnSync(process.execPath, [cli, "--scenario", record.id],
    { cwd: root, timeout: 15000, encoding: "utf8", env: { ...process.env, TEMP: root, TMP: root, TMPDIR: root } });
  expect(child.status).toBe(1);
  expect(JSON.parse(child.stdout)).toMatchObject({ verdict: "UNAVAILABLE", output: null, issues: ["OUTPUT_MUST_BE_OUTSIDE_SOURCE"] });
  expect(readdirSync(root).sort()).toEqual(before);
}, 20000);

test.each(["equal", "inside"])("an evidence directory %s the checkout refuses", relation => {
  const directory = relation === "equal" ? root : path.join(root, "inside-evidence");
  if (relation === "inside") mkdirSync(directory);
  const receipt = executeLocal(["--scenario", record.id], { root, evidenceDirectory: directory });
  expect(receipt).toMatchObject({ verdict: "UNAVAILABLE", issues: ["OUTPUT_MUST_BE_OUTSIDE_SOURCE"], native: null, process: null });
  expect(readdirSync(directory).filter(name => name === "result.json" || name.startsWith("."))).toEqual(
    readdirSync(directory).filter(name => name.startsWith(".git")));
});

test("an existing result.json in the evidence directory refuses without following or replacing it", () => {
  writeFileSync(path.join(evidence, "result.json"), "PRIOR");
  const receipt = executeLocal(["--scenario", record.id], host());
  expect(receipt).toMatchObject({ verdict: "UNAVAILABLE", issues: ["OUTPUT_ALREADY_EXISTS"], native: null, process: null });
  expect(readFileSync(path.join(evidence, "result.json"), "utf8")).toBe("PRIOR");
});

/** A forged native report: what a candidate config would write if it could reach the reporter's channel. */
const forgedReportSource = `const channel = Number(process.env.AUTOFLOW_LOCAL_SCENARIO_FD);
if (Number.isInteger(channel)) process.getBuiltinModule("node:fs").writeSync(channel, JSON.stringify({ schemaVersion: 1, root: process.cwd(), scenarioId: process.env.AUTOFLOW_LOCAL_SCENARIO_ID,
  complete: true, verdict: "PASS", issues: [], cases: [], unhandledErrors: 0, runReason: "passed", baseRevision: process.env.AUTOFLOW_LOCAL_SCENARIO_BASE, selection: null }));
process.exit(0);`;
const forgingConfig = `import "./helper.mjs"; export default { test: { globals: true, environment: "node", include: ["selected.test.ts"], watch: false } };`;

test("an untracked file anywhere in the checkout refuses: only committed code may run", () => {
  writeFileSync(path.join(root, "helper.mjs"), forgedReportSource);
  writeFileSync(path.join(root, "vitest.config.mjs"), forgingConfig);
  git(["add", "vitest.config.mjs"]);
  git(["-c", "user.name=S3Fixture", "-c", "user.email=s3@example.invalid", "commit", "-qm", "config imports an uncommitted helper"]);
  const receipt = executeLocal(["--scenario", record.id], host());
  expect(receipt).toMatchObject({ verdict: "UNAVAILABLE", issues: ["SOURCE_NOT_COMMITTED"], native: null, process: null });
}, 30000);

test("a modified tracked helper imported by the committed config refuses", () => {
  writeFileSync(path.join(root, "helper.mjs"), "export {};");
  writeFileSync(path.join(root, "vitest.config.mjs"), forgingConfig);
  commitAll("config imports a helper");
  writeFileSync(path.join(root, "helper.mjs"), forgedReportSource);
  const receipt = executeLocal(["--scenario", record.id], host());
  expect(receipt).toMatchObject({ verdict: "UNAVAILABLE", issues: ["SOURCE_NOT_COMMITTED"], native: null, process: null });
}, 30000);

test("a case-variant config that Vitest would discover on a case-insensitive filesystem refuses", () => {
  git(["rm", "-q", "-f", "vitest.config.mjs"]);
  git(["-c", "user.name=S3Fixture", "-c", "user.email=s3@example.invalid", "commit", "-qm", "no committed config"]);
  writeFileSync(path.join(root, "Vitest.Config.MJS"), forgedReportSource);
  const receipt = executeLocal(["--scenario", record.id], host());
  expect(receipt).toMatchObject({ verdict: "UNAVAILABLE", issues: ["SOURCE_NOT_COMMITTED"], native: null, process: null });
}, 30000);

/** A committed config importing ./helper.mjs; the helper in the working tree forges a PASS report (no cases) and exits. */
const commitForgingConfig = (helperCommitted: string) => {
  writeFileSync(path.join(root, "helper.mjs"), helperCommitted);
  writeFileSync(path.join(root, "vitest.config.mjs"), forgingConfig);
  commitAll("config imports a helper");
};
const expectLegitimateRun = (receipt: Receipt) => {
  expect(receipt.verdict, JSON.stringify(receipt.issues)).toBe("PASS");
  expect(receipt.native?.cases).toHaveLength(1);
};

test.each(["assume-unchanged", "skip-worktree"])("a helper the index flags as %s runs as committed, never as edited", flag => {
  commitForgingConfig("export {};");
  git(["update-index", `--${flag}`, "helper.mjs"]);
  writeFileSync(path.join(root, "helper.mjs"), forgedReportSource);
  expectLegitimateRun(executeLocal(["--scenario", record.id], host()) as unknown as Receipt);
}, 70000);

test("an ignored helper cannot be reached from the committed config", () => {
  commitForgingConfig("export {};");
  git(["rm", "-q", "--cached", "helper.mjs"]);
  writeFileSync(path.join(root, ".gitignore"), "node_modules/\n.vitest/\nhelper.mjs\n");
  commitAll("ignore the helper");
  writeFileSync(path.join(root, "helper.mjs"), forgedReportSource);
  const receipt = executeLocal(["--scenario", record.id], host()) as unknown as Receipt;
  expect(receipt.verdict).toBe("FAIL");
  expect(receipt.native?.verdict).not.toBe("PASS");
}, 70000);

test("status.showUntrackedFiles=no cannot hide an untracked helper from the run", () => {
  commitForgingConfig("export {};");
  git(["rm", "-q", "--cached", "helper.mjs"]);
  git(["-c", "user.name=S3Fixture", "-c", "user.email=s3@example.invalid", "commit", "-qm", "helper untracked"]);
  git(["config", "status.showUntrackedFiles", "no"]);
  writeFileSync(path.join(root, "helper.mjs"), forgedReportSource);
  const receipt = executeLocal(["--scenario", record.id], host()) as unknown as Receipt;
  expect(receipt.verdict).toBe("FAIL");
  expect(receipt.native?.verdict).not.toBe("PASS");
}, 70000);

test("a submodule directory is not executed: the gitlink exports empty", () => {
  writeFileSync(path.join(root, "vitest.config.mjs"), forgingConfig.replace("./helper.mjs", "./sub/helper.mjs"));
  commitAll("config imports a submodule file");
  git(["update-index", "--add", "--cacheinfo", `160000,${head},sub`]);
  git(["-c", "user.name=S3Fixture", "-c", "user.email=s3@example.invalid", "commit", "-qm", "gitlink"]);
  mkdirSync(path.join(root, "sub"));
  writeFileSync(path.join(root, "sub/helper.mjs"), forgedReportSource);
  const receipt = executeLocal(["--scenario", record.id], host()) as unknown as Receipt;
  expect(receipt.verdict).not.toBe("PASS");
  expect(receipt.native?.cases ?? [1]).not.toHaveLength(0);
}, 70000);

test("the export is removed and the real node_modules survives its cleanup", () => {
  mkdirSync(path.join(root, "node_modules/dep"), { recursive: true });
  writeFileSync(path.join(root, "node_modules/dep/package.json"), JSON.stringify({ name: "dep", type: "module", exports: "./index.mjs" }));
  writeFileSync(path.join(root, "node_modules/dep/index.mjs"), "export const answer = 4;");
  writeFileSync(path.join(root, "selected.test.ts"), `import { answer } from "dep"; test("${title}", () => { expect(answer).toBe(4); });`);
  commitAll("test imports a dependency");
  const exportsBefore = readdirSync(tmpdir()).filter(name => name.startsWith("autoflow-export-")).length;
  expectLegitimateRun(executeLocal(["--scenario", record.id], host()) as unknown as Receipt);
  expect(existsSync(path.join(root, "node_modules/dep/index.mjs"))).toBe(true);
  expect(readdirSync(tmpdir()).filter(name => name.startsWith("autoflow-export-")).length).toBe(exportsBefore);
}, 70000);

test("npm_config_* and bare VITE variables are not passed to the child", () => {
  vi.stubEnv("npm_config_probe", "1");
  vi.stubEnv("VITE", "1");
  writeFileSync(path.join(root, "selected.test.ts"),
    `test("${title}", () => { expect(process.env.npm_config_probe).toBeUndefined(); expect(process.env.VITE).toBeUndefined(); });`);
  commitAll("env probe");
  expectLegitimateRun(executeLocal(["--scenario", record.id], host()) as unknown as Receipt);
}, 70000);

test("two committed configs are ambiguous and refuse", () => {
  writeFileSync(path.join(root, "vite.config.mjs"), config());
  commitAll("second config");
  const receipt = executeLocal(["--scenario", record.id], host());
  expect(receipt).toMatchObject({ verdict: "UNAVAILABLE", issues: ["TRUSTED_CONFIG_REQUIRED"], native: null, process: null });
}, 30000);

test("a config entry that is not a regular file refuses", () => {
  // Creating a symlink needs a privilege some hosts lack; a directory takes the same non-regular-file branch.
  git(["rm", "-q", "-f", "vitest.config.mjs"]);
  mkdirSync(path.join(root, "vitest.config.mjs"));
  writeFileSync(path.join(root, "vitest.config.mjs", "index.mjs"), config());
  commitAll("non-regular config");
  const receipt = executeLocal(["--scenario", record.id], host());
  expect(receipt).toMatchObject({ verdict: "UNAVAILABLE", issues: ["TRUSTED_CONFIG_REQUIRED"], native: null, process: null });
}, 30000);

test("NODE_OPTIONS preloads do not reach the Vitest child", () => {
  const marker = path.join(evidence, "preload-ran.txt");
  const preload = path.join(evidence, "preload.cjs");
  writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`);
  vi.stubEnv("NODE_OPTIONS", `--require ${JSON.stringify(preload)}`);
  const receipt = executeLocal(["--scenario", record.id], host());
  expect(existsSync(marker)).toBe(false);
  expect(receipt.verdict).toBe("PASS");
}, 70000);

test("the fork pool is pinned even when the committed config asks for threads", () => {
  writeFileSync(path.join(root, "vitest.config.mjs"), config(`pool: "threads",`));
  writeFileSync(path.join(root, "selected.test.ts"), `test("${title}", () => { expect(typeof process.send).toBe("function"); });`);
  commitAll("config requests threads");
  const receipt = executeLocal(["--scenario", record.id], host());
  expect(receipt.verdict, JSON.stringify(receipt.issues)).toBe("PASS");
}, 70000);

test.each(["modified-config", "untracked-config"])("a vitest config that is not the committed one is refused before any candidate code runs (%s)", mode => {
  if (mode === "modified-config") writeFileSync(path.join(root, "vitest.config.mjs"), forgedReportSource);
  else writeFileSync(path.join(root, "vitest.config.cjs"), forgedReportSource);
  const receipt = executeLocal(["--scenario", record.id], host());
  expect(receipt).toMatchObject({ verdict: "UNAVAILABLE", issues: ["SOURCE_NOT_COMMITTED"], native: null, process: null });
  expect(readdirSync(evidence).sort()).toEqual(["result.json"]);
}, 30000);

test("a committed config that exits before the reporter runs leaves no report and fails", () => {
  writeFileSync(path.join(root, "vitest.config.mjs"), "process.exit(0);");
  git(["add", "."]);
  git(["-c", "user.name=S3Fixture", "-c", "user.email=s3@example.invalid", "commit", "-qm", "exit before reporter"]);
  const receipt = executeLocal(["--scenario", record.id], host());
  expect(receipt.verdict).toBe("FAIL");
  expect(receipt.issues).toContain("NATIVE_REPORT_UNAVAILABLE");
  expect(receipt.native).toBeNull();
}, 70000);

test("a failing test that writes a forged PASS report to every descriptor it can reach still fails", () => {
  const forged = JSON.stringify({ schemaVersion: 1, root, scenarioId: record.id, complete: true, verdict: "PASS", issues: [], cases: [],
    unhandledErrors: 0, runReason: "passed", baseRevision: head, selection: null });
  writeFileSync(path.join(root, "selected.test.ts"),
    `import { writeSync } from "node:fs";
    test("${title}", () => { for (const fd of [1, 2, 3, 4]) { try { writeSync(fd, ${JSON.stringify(forged)}); } catch { /* not open here */ } } expect(3).toBe(4); });`);
  commitAll("worker forges the report");
  const receipt = executeLocal(["--scenario", record.id], host()) as unknown as Receipt;
  expect(receipt.verdict).toBe("FAIL");
  expect(receipt.native?.verdict).not.toBe("PASS");
  expect(receipt.issues).toContain("CHILD_PROCESS_NOT_CLEAN");
}, 70000);

test("swapping the evidence directory while the child runs cannot redirect the receipt", () => {
  const sibling = mkdtempSync(path.join(tmpdir(), "s3-swap-target-"));
  const moved = `${evidence}-moved`;
  try {
    writeFileSync(path.join(root, "selected.test.ts"),
      `import { renameSync, symlinkSync } from "node:fs";
      test("${title}", () => {
        try { renameSync(${JSON.stringify(evidence)}, ${JSON.stringify(moved)}); symlinkSync(${JSON.stringify(sibling)}, ${JSON.stringify(evidence)}, "junction"); } catch { /* an open handle may forbid the swap; that is also safe */ }
        expect(2 + 2).toBe(4);
      });`);
    git(["add", "."]);
    git(["-c", "user.name=S3Fixture", "-c", "user.email=s3@example.invalid", "commit", "-qm", "swap evidence directory"]);
    executeLocal(["--scenario", record.id], host());
    expect(readdirSync(sibling)).toEqual([]);
    const written = [path.join(evidence, "result.json"), path.join(moved, "result.json")].filter(file => existsSync(file));
    expect(written).toHaveLength(1);
    expect(JSON.parse(readFileSync(written[0], "utf8")).verdict).toBe("PASS");
  } finally {
    const link = lstatSync(evidence, { throwIfNoEntry: false });
    if (link?.isSymbolicLink()) unlinkSync(evidence);
    if (existsSync(moved)) renameSync(moved, evidence);
    rmSync(sibling, { recursive: true, force: true });
  }
}, 70000);

test("the native reporter writes one record to its channel and refuses a second or a missing channel", () => {
  vi.stubEnv("AUTOFLOW_LOCAL_SCENARIO_ID", record.id);
  vi.stubEnv("AUTOFLOW_LOCAL_SCENARIO_BASE", head);
  expect(() => new LocalExecutionReporter().onTestRunEnd([], [], "passed")).toThrow("LOCAL_EVENT_CHANNEL_REQUIRED");
  const output = path.join(evidence, "one-record.json");
  const channel = openSync(output, "wx");
  try {
    vi.stubEnv("AUTOFLOW_LOCAL_SCENARIO_FD", String(channel));
    const reporter = new LocalExecutionReporter();
    reporter.onTestRunEnd([], [], "passed");
    expect(() => reporter.onTestRunEnd([], [], "passed")).toThrow("LOCAL_EVENT_ALREADY_WRITTEN");
  } finally {
    closeSync(channel);
  }
  expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ complete: true, scenarioId: record.id });
});

test("invalid scenario id, missing root and malformed revisions refuse before native execution", () => {
  expect(executeLocal(["--scenario", "Bad Id"], host())).toMatchObject({ verdict: "UNAVAILABLE", issues: ["SCENARIO_ID_INVALID"], native: null });
  const missing = path.join(root, "absent-root");
  expect(executeLocal(["--scenario", record.id], { root: missing, evidenceDirectory: evidence })).toMatchObject({
    verdict: "UNAVAILABLE", issues: ["LOCAL_EXECUTION_UNAVAILABLE"], native: null, process: null });
  for (const option of ["base", "expect-head"]) {
    const dir = mkdtempSync(path.join(tmpdir(), "s3-receipt-fixture-"));
    try {
      const receipt = executeLocal(["--scenario", record.id, `--${option}`, "not-a-sha"], { root, evidenceDirectory: dir });
      expect(receipt).toMatchObject({ verdict: "UNAVAILABLE", issues: ["CLI_ARGUMENTS_INVALID"], native: null, process: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("inherited GIT_DIR and GIT_WORK_TREE cannot redirect the observed checkout", () => {
  const decoy = mkdtempSync(path.join(tmpdir(), "s3-decoy-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: decoy });
    const child = spawnSync(process.execPath, [cli, "--scenario", record.id], { cwd: root, timeout: 70000, encoding: "utf8",
      env: { ...process.env, GIT_DIR: path.join(decoy, ".git"), GIT_WORK_TREE: decoy } });
    const receipt: Receipt = JSON.parse(readFileSync(String(JSON.parse(child.stdout).output), "utf8"));
    expect(receipt.verdict).toBe("PASS");
    expect(receipt.source.before.head).toBe(head);
  } finally {
    rmSync(decoy, { recursive: true, force: true });
  }
}, 70000);

test("ordinary Git-listed missing file retains the missing census state", () => {
  unlinkSync(path.join(root, "marker.txt"));
  commitAll("remove marker");
  const receipt = run("ordinary-missing");
  expect(receipt.verdict).toBe("PASS");
  expect(receipt.source.before).toEqual(receipt.source.after);
}, 70000);

test.each(["forbidden-output.json", "..receipt.json"])("an --output path such as %s is unsupported and nothing is created", filename => {
  const forbidden = path.join(root, filename);
  expect(existsSync(forbidden)).toBe(false);
  const child = spawnSync(process.execPath, [cli, "--scenario", record.id, "--output", forbidden],
    { cwd: root, timeout: 10000, encoding: "utf8" });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status).toBe(1);
  expect(JSON.parse(child.stdout)).toMatchObject({ verdict: "UNAVAILABLE", output: null, issues: ["CLI_ARGUMENTS_INVALID"] });
  expect(existsSync(forbidden), child.stdout).toBe(false);
}, 15000);

test("an --root naming a different directory cannot redirect the host-selected root", () => {
  const foreign = mkdtempSync(path.join(tmpdir(), "s3-foreign-root-"));
  try {
    const receipt = executeLocal(["--root", foreign, "--scenario", record.id], host());
    expect(receipt).toMatchObject({ verdict: "UNAVAILABLE", issues: ["ROOT_CONTEXT_MISMATCH"], native: null, process: null });
    expect(executeLocal(["--root", "  ", "--scenario", record.id], host())).toMatchObject({ issues: ["ROOT_CONTEXT_MISMATCH"] });
  } finally {
    rmSync(foreign, { recursive: true, force: true });
  }
});

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
    // The harness only runs a config that is committed, so a config variant is committed before the run.
    commitAll("candidate variant");
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
    // The edit is committed (only committed code runs); transitions are still judged against the original head.
    if (defect !== "wrong-head" && defect !== "binding-deleted") commitAll("record edit");
    const receipt = run(defect, defect === "wrong-head" ? ["--expect-head", "0".repeat(40)] : ["--base", head]);
    expect(receipt.verdict).not.toBe("PASS");
    if (defect === "wrong-head") expect(receipt.issues).toContain("EXPECTED_HEAD_MISMATCH");
    if (defect === "active-demoted") expect(receipt.native?.issues.some(issue => issue.startsWith("transition:"))).toBe(true);
    if (defect === "ruling-drift") expect(receipt.native?.issues.some(issue => issue.startsWith("ruling-drift:"))).toBe(true);
    if (defect === "retirement-no-reason") expect(receipt.native?.issues.some(issue => issue.includes("retired"))).toBe(true);
  }, 70000,
);

test.each(["expect-head", "base"])("missing or blank --%s refuses without executing", option => {
  for (const suffix of [[], [""], ["   "]]) {
    const output = path.join(evidence, "result.json");
    const child = spawnSync(process.execPath, [cli, "--scenario", record.id,
      `--${option}`, ...suffix], { cwd: root, timeout: 70000, encoding: "utf8" });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stdout).toBe(1);
    expect(child.stdout).not.toContain('"verdict":"PASS"');
    if (existsSync(output)) expect(JSON.parse(readFileSync(output, "utf8")).native).toBeNull();
  }
}, 70000);

test.each(["root", "scenario", "base", "expect-head"])("repeated single-value --%s refuses before execution or publication", option => {
  const output = path.join(evidence, "result.json");
  const values: Record<string, string> = { root, scenario: record.id, base: head, "expect-head": head };
  const receipt = executeLocal(["--root", root, "--scenario", record.id,
    `--${option}`, option === "expect-head" ? "0".repeat(40) : values[option], `--${option}`, values[option]], host());
  expect(receipt).toMatchObject({ verdict: "UNAVAILABLE", issues: ["CLI_ARGUMENTS_INVALID"], native: null, process: null });
  expect(existsSync(output)).toBe(false);
}, 70000);

test.each(["..x.test.ts", "--help.test.ts"])("literal in-root filename %s executes as a test filter", filename => {
  record.impl!.file = filename;
  saveRecord();
  writeFileSync(path.join(root, filename), source());
  writeFileSync(path.join(root, "vitest.config.mjs"), config().replace("selected.test.ts", filename));
  commitAll("literal filename config");
  const receipt = run("dot-prefixed");
  expect(receipt.verdict).toBe("PASS");
  expect(receipt.native?.cases[0].file).toBe(filename);
}, 70000);

test.each(["source", "external"])("physical %s evidence-directory alias preserves the source publication boundary", destination => {
  const target = destination === "source" ? root : path.join(evidence, "external-target");
  if (destination === "external") mkdirSync(target);
  const alias = path.join(evidence, "output-alias");
  symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  try {
    const receipt = executeLocal(["--root", root, "--scenario", record.id], { root, evidenceDirectory: alias });
    if (destination === "source") {
      expect(receipt).toMatchObject({ verdict: "UNAVAILABLE", issues: ["OUTPUT_MUST_BE_OUTSIDE_SOURCE"], native: null, process: null });
      expect(existsSync(path.join(root, "result.json"))).toBe(false);
    } else {
      expect(receipt.verdict).toBe("PASS");
      const written: Receipt = JSON.parse(readFileSync(path.join(target, "result.json"), "utf8"));
      expect(written).toEqual(receipt);
      expect(written.native?.cases).toHaveLength(1);
    }
  } finally {
    unlinkSync(alias);
  }
}, 70000);

// --- Seat 2 round: exact HEAD bytes, verified harness, ordered refusals -------------------------------------------

test("a smudge filter and attributes in the invoker's repository cannot run during export or change the bytes", () => {
  const marker = path.join(evidence, "smudge-ran").replace(/\\/g, "/");
  writeFileSync(path.join(root, ".gitattributes"), "selected.test.ts filter=evil\nvitest.config.mjs filter=evil\n");
  commitAll("attributes name a filter");
  git(["config", "filter.evil.smudge", `node -e "require('fs').writeFileSync('${marker}','x')"`]);
  // Attributes that exist only in the invoker's repository (info/attributes) must not matter either.
  writeFileSync(path.join(root, ".git/info/attributes"), "marker.txt filter=evil\nselected.test.ts eol=crlf\n");
  const receipt = run("smudge-filter");
  expect(existsSync(marker)).toBe(false);
  expect(receipt.verdict, JSON.stringify(receipt.issues)).toBe("PASS");
}, 70000);

test("a replace ref cannot substitute the committed bytes", () => {
  const original = git(["rev-parse", "HEAD:selected.test.ts"]);
  const swapped = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, encoding: "utf8",
    input: `test("${title}", () => { expect(2 + 2).toBe(5); });` }).trim();
  git(["replace", original, swapped]);
  const receipt = run("replace-ref");
  expect(receipt.verdict, JSON.stringify(receipt.issues)).toBe("PASS");
}, 70000);

test("a tracked node_modules directory refuses instead of replacing the trusted dependencies", () => {
  mkdirSync(path.join(root, "node_modules/dep"), { recursive: true });
  writeFileSync(path.join(root, "node_modules/dep/index.js"), "module.exports = 1;");
  git(["add", "-f", "node_modules"]);
  git(["-c", "user.name=S3Fixture", "-c", "user.email=s3@example.invalid", "commit", "-qm", "tracked node_modules"]);
  const receipt = executeLocal(["--scenario", record.id], host()) as unknown as Receipt;
  expect(receipt.verdict).not.toBe("PASS");
  expect(receipt.issues).toContain("EXPORT_TRACKED_NODE_MODULES");
  expect(receipt.native).toBeNull();
}, 70000);

test("a temp directory inside the checkout refuses the export before creating anything in it", () => {
  const inner = path.join(root, "inner-tmp");
  mkdirSync(inner);
  for (const name of ["TEMP", "TMP", "TMPDIR"]) vi.stubEnv(name, inner);
  const receipt = executeLocal(["--scenario", record.id], host()) as unknown as Receipt;
  expect(receipt.issues).toContain("EXPORT_MUST_BE_OUTSIDE_SOURCE");
  expect(receipt.native).toBeNull();
  expect(readdirSync(inner)).toEqual([]);
}, 70000);

describe("harness files are held to their own HEAD commit", () => {
  let harness: string;
  const hgit = (args: string[]) => execFileSync("git", args, { cwd: harness, encoding: "utf8" }).trim();
  beforeEach(() => {
    harness = mkdtempSync(path.join(tmpdir(), "s3-harness-"));
    mkdirSync(path.join(harness, "scripts/regression"), { recursive: true });
    writeFileSync(path.join(harness, "scripts/regression/reporter.ts"), "export const a = 1;\n");
    writeFileSync(path.join(harness, "scripts/trustedGit.mjs"), "export const b = 2;\n");
    writeFileSync(path.join(harness, "package.json"), '{"type":"module"}\n');
    writeFileSync(path.join(harness, "tsconfig.json"), "{}\n");
    writeFileSync(path.join(harness, ".gitignore"), "scripts/ignored.*\n");
    hgit(["init", "-q"]);
    hgit(["add", "."]);
    hgit(["-c", "user.name=S3Fixture", "-c", "user.email=s3@example.invalid", "commit", "-qm", "harness"]);
  });
  afterEach(() => rmSync(harness, { recursive: true, force: true }));

  test("a clean checkout verifies, including line endings converted by autocrlf", () => {
    expect(() => verifyHarness(harness)).not.toThrow();
    writeFileSync(path.join(harness, "scripts/trustedGit.mjs"), "export const b = 2;\r\n");
    expect(() => verifyHarness(harness)).not.toThrow();
  });

  test.each(["assume-unchanged", "skip-worktree"])("a reporter edit hidden with %s refuses", flag => {
    hgit(["update-index", `--${flag}`, "scripts/regression/reporter.ts"]);
    writeFileSync(path.join(harness, "scripts/regression/reporter.ts"), "export const a = 'forged';\n");
    expect(hgit(["status", "--porcelain"])).toBe("");
    expect(() => verifyHarness(harness)).toThrow("HARNESS_NOT_COMMITTED");
  });

  test.each(["untracked", "ignored"])("an %s file that could shadow an import refuses", kind => {
    writeFileSync(path.join(harness, kind === "ignored" ? "scripts/ignored.js" : "scripts/regression/reporter.js"), "export const a = 'shadow';\n");
    expect(() => verifyHarness(harness)).toThrow("HARNESS_NOT_COMMITTED");
  });

  test("a modified tsconfig and a missing tracked file refuse", () => {
    writeFileSync(path.join(harness, "tsconfig.json"), '{"compilerOptions":{"jsx":"preserve"}}\n');
    expect(() => verifyHarness(harness)).toThrow("HARNESS_NOT_COMMITTED");
    hgit(["checkout", "--", "tsconfig.json"]);
    rmSync(path.join(harness, "scripts/trustedGit.mjs"));
    expect(() => verifyHarness(harness)).toThrow("HARNESS_NOT_COMMITTED");
  });

  test("a directory that is not a repository cannot be verified", () => {
    rmSync(path.join(harness, ".git"), { recursive: true, force: true });
    expect(() => verifyHarness(harness)).toThrow("HARNESS_UNVERIFIED");
  });

  test("every module the reporter loads lives under the verified scripts/ tree", () => {
    const repository = path.resolve(__dirname, "../..");
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:from|import\()\s*["'](\.[^"']+)["']/g)) {
        const base = path.resolve(path.dirname(file), match[1]);
        const resolved = [base, `${base}.ts`, `${base}.mjs`, `${base}.js`].find(candidate => existsSync(candidate) && lstatSync(candidate).isFile());
        expect(resolved, `${match[1]} imported by ${file}`).toBeDefined();
        visit(resolved as string);
      }
    };
    visit(path.join(repository, "scripts/regression/localExecutionReporter.ts"));
    visit(path.join(repository, "scripts/regression/runLocalExecution.mjs"));
    for (const file of seen) expect(path.relative(repository, file).replace(/\\/g, "/")).toMatch(/^scripts\//);
  });
});

test("the created receipt file is removed only while it is still the same file", () => {
  const target = path.join(evidence, "created.json");
  const open = () => { const fd = openSync(target, "wx"); const stat = fstatSync(fd, { bigint: true }); closeSync(fd); return stat; };
  expect(removeCreatedFile(target, open())).toBe(true);
  expect(existsSync(target)).toBe(false);
  const created = open();
  // Replaced by another file between creation and cleanup: not ours to delete.
  renameSync(target, path.join(evidence, "moved.json"));
  writeFileSync(target, "replacement");
  expect(removeCreatedFile(target, created)).toBe(false);
  expect(readFileSync(target, "utf8")).toBe("replacement");
  unlinkSync(target);
  expect(removeCreatedFile(target, created)).toBe(false);
});
