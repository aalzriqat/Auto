// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { startVitest } from "vitest/node";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { digestRulingText, scenarioFingerprint, type ScenarioRecord } from "./scenarioRecord";
import LocalExecutionReporter, { type LocalExecutionReport } from "./localExecutionReporter";
import { checkTreePath, isHarnessFile, main as executeLocal, matchesHead, removeCreatedFile, removeExport, verifyExport, writeCommittedTree } from "./runLocalExecution.mjs";

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
/**
 * A commit in a fixture repository would otherwise start detached `git maintenance`/`gc`, which can still be writing under
 * `.git/objects` while a recursive delete walks it (ENOTEMPTY on newer Git). Turn it off in the fixture's own config.
 */
const quiet = (run: (args: string[]) => string) => {
  run(["config", "maintenance.auto", "false"]);
  run(["config", "gc.auto", "0"]);
};
/** Belt for the braces above: tolerate a late writer instead of failing a cleanup. */
const retries = { maxRetries: 5, retryDelay: 100 };
const saveRecord = () =>writeFileSync(scenarioPath(), JSON.stringify(record));

/** Remove a junction/symlink itself, never what it points at. */
const dropLink = (link: string) => {
  if (!lstatSync(link, { throwIfNoEntry: false })) return;
  try { rmdirSync(link); } catch { unlinkSync(link); }
};

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
  quiet(git);
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
    rmSync(absolute, { recursive: true, force: true, ...retries });
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
  writeFileSync(path.join(root, "forged-report.json"), forged);
  // The worker proves it read the fixture and attempted every forge by writing a marker to a host-owned path
  // handed over in the environment, so a missing or unread fixture cannot leave this test green.
  const proofDir = mkdtempSync(path.join(tmpdir(), "s3-forge-proof-")), proof = path.join(proofDir, "sent");
  writeFileSync(path.join(root, "selected.test.ts"),
    `import { readFileSync, writeFileSync, writeSync } from "node:fs";
    test("${title}", () => { const forged = readFileSync(new URL("./forged-report.json", import.meta.url), "utf8"); for (const fd of [1, 2, 3, 4]) { try { writeSync(fd, forged); } catch { /* not open here */ } } writeFileSync(process.env.FORGE_PROOF as string, forged); expect(3).toBe(4); });`);
  commitAll("worker forges the report");
  expect(execFileSync("git", ["show", "HEAD:forged-report.json"], { cwd: root, encoding: "utf8" })).toBe(forged);
  vi.stubEnv("FORGE_PROOF", proof);
  let receipt: Receipt;
  try { receipt = executeLocal(["--scenario", record.id], host()) as unknown as Receipt; } finally { vi.unstubAllEnvs(); }
  const sent = existsSync(proof) ? readFileSync(proof, "utf8") : null;
  rmSync(proofDir, { recursive: true, force: true });
  expect(sent).toBe(forged);
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

describe("the reporter and runner run from the harness checkout's own HEAD, never its working tree", () => {
  const repository = path.resolve(__dirname, "../..");
  let harness: string;
  const hgit = (args: string[]) => execFileSync("git", args, { cwd: harness, encoding: "utf8" }).trim();
  const harnessFile = (file: string) => path.join(harness, file);
  const commitHarness = () => {
    hgit(["add", "-A"]);
    hgit(["-c", "user.name=S3Fixture", "-c", "user.email=s3@example.invalid", "commit", "-qm", "harness"]);
  };
  const harnessHost = () => ({ root, evidenceDirectory: evidence, harnessRoot: harness });
  beforeEach(() => {
    // A committed copy of this checkout's harness files: the working-tree edits below must not reach the run.
    harness = mkdtempSync(path.join(tmpdir(), "s3-harness-"));
    const listed = execFileSync("git", ["ls-files", "-z", "scripts", "package.json", "tsconfig.json"], { cwd: repository, encoding: "utf8" }).split("\0").filter(Boolean);
    for (const file of listed) {
      mkdirSync(path.dirname(harnessFile(file)), { recursive: true });
      writeFileSync(harnessFile(file), readFileSync(path.join(repository, file)));
    }
    writeFileSync(harnessFile(".gitignore"), "scripts/regression/*.js\nnode_modules\n");
    symlinkSync(path.join(repository, "node_modules"), harnessFile("node_modules"), process.platform === "win32" ? "junction" : "dir");
    hgit(["init", "-q"]);
    quiet(hgit);
    commitHarness();
  });
  afterEach(() => {
    // The link goes first so a recursive delete cannot reach the real dependencies.
    dropLink(harnessFile("node_modules"));
    rmSync(harness, { recursive: true, force: true, ...retries });
  });

  test("a clean committed harness copy runs the scenario end to end", () => {
    const receipt = executeLocal(["--scenario", record.id], harnessHost()) as unknown as Receipt;
    expect(receipt.verdict, JSON.stringify(receipt.issues)).toBe("PASS");
  }, 70000);

  test.each(["assume-unchanged", "skip-worktree", "uncommitted"])("a reporter edit that is %s never runs", flag => {
    if (flag !== "uncommitted") hgit(["update-index", `--${flag}`, "scripts/regression/localExecutionReporter.ts"]);
    // Loading this version would fail the run outright; the HEAD copy has no such line.
    writeFileSync(harnessFile("scripts/regression/localExecutionReporter.ts"),
      `throw new Error("FORGED_REPORTER");\n${readFileSync(harnessFile("scripts/regression/localExecutionReporter.ts"), "utf8")}`);
    const receipt = executeLocal(["--scenario", record.id], harnessHost()) as unknown as Receipt;
    expect(receipt.verdict, JSON.stringify(receipt.issues)).toBe("PASS");
  }, 70000);

  test.each(["untracked", "ignored"])("an %s file that would shadow an import never runs", kind => {
    // Both extensions outrank .ts when the reporter imports ./scenarioRecord.
    const shadow = kind === "ignored" ? "scripts/regression/scenarioRecord.js" : "scripts/regression/scenarioRecord.mjs";
    writeFileSync(harnessFile(shadow), 'throw new Error("SHADOW_RAN");\n');
    const receipt = executeLocal(["--scenario", record.id], harnessHost()) as unknown as Receipt;
    expect(receipt.verdict, JSON.stringify(receipt.issues)).toBe("PASS");
  }, 70000);

  test.each(["\r\n", "\r\r\n", "mixed"])("a forged edit with %j line endings never runs: endings were never a tolerance", ending => {
    // The old verifier accepted a working tree that equals HEAD up to CR bytes; \r\r\n and mixed endings hid real edits.
    const original = readFileSync(harnessFile("scripts/trustedGit.mjs"), "utf8");
    const forged = `throw new Error("FORGED_TRUSTED_GIT");\n${original}`;
    const lines = forged.split("\n");
    writeFileSync(harnessFile("scripts/trustedGit.mjs"), lines.map((line, at) => `${line}${ending === "mixed" ? (at % 2 ? "\r\r" : "\r") : ending.slice(0, -1)}`).join("\n"));
    const receipt = executeLocal(["--scenario", record.id], harnessHost()) as unknown as Receipt;
    expect(receipt.verdict, JSON.stringify(receipt.issues)).toBe("PASS");
  }, 70000);

  test("a harness that is not a repository top cannot be used", () => {
    rmSync(harnessFile(".git"), { recursive: true, force: true });
    const receipt = executeLocal(["--scenario", record.id], harnessHost()) as unknown as Receipt;
    expect(receipt.issues).toContain("HARNESS_UNVERIFIED");
    expect(receipt.native).toBeNull();
  }, 70000);

  describe("a fresh CLI whose own files differ from the harness HEAD", () => {
    const cliOf = () => harnessFile("scripts/regression/runLocalExecution.mjs");
    const fresh = () => {
      const child = spawnSync(process.execPath, [cliOf(), "--scenario", record.id], { cwd: root, timeout: 70000, encoding: "utf8", maxBuffer: 1024 * 1024 });
      expect(child.error, child.stderr).toBeUndefined();
      const output = String(JSON.parse(child.stdout).output);
      try {
        return JSON.parse(readFileSync(output, "utf8")) as Receipt & { harness?: { head: string; closureMatchesHead: boolean } };
      } finally {
        rmSync(path.dirname(output), { recursive: true, force: true });
      }
    };
    const headBytes = (file: string) => execFileSync("git", ["show", `HEAD:${file}`], { cwd: harness, encoding: "latin1" });
    const closure = ["scripts/trustedGit.mjs", "scripts/regression/runLocalExecution.mjs"];

    test("an unmodified harness runs, and the receipt names its HEAD", () => {
      const receipt = fresh();
      expect(receipt.verdict, JSON.stringify(receipt.issues)).toBe("PASS");
      expect(receipt.harness).toEqual({ head: hgit(["rev-parse", "HEAD"]), closureMatchesHead: true });
    }, 70000);

    test.each(closure)("%s converted whole-file to CRLF, as autocrlf does, is still the committed file", file => {
      writeFileSync(harnessFile(file), headBytes(file).replace(/\n/g, "\r\n"), "latin1");
      const receipt = fresh();
      expect(receipt.verdict, JSON.stringify(receipt.issues)).toBe("PASS");
      expect(receipt.harness?.closureMatchesHead).toBe(true);
    }, 70000);

    test.each(closure)("%s edited under assume-unchanged is reported, even though git status is clean", file => {
      hgit(["update-index", "--assume-unchanged", file]);
      writeFileSync(harnessFile(file), `${headBytes(file)}\n// edited\n`, "latin1");
      expect(hgit(["status", "--porcelain"])).toBe("");
      const receipt = fresh();
      // A refused harness gives no verdict about the tree (UNAVAILABLE, exit 1), the same as every other thrown refusal.
      expect(receipt.verdict).toBe("UNAVAILABLE");
      expect(receipt.issues).toContain("HARNESS_NOT_COMMITTED");
      expect(receipt.native).toBeNull();
      expect(receipt.harness).toEqual({ head: hgit(["rev-parse", "HEAD"]), closureMatchesHead: false });
    }, 70000);

    test.each(["\r\r\n", "mixed"])("%j line endings are not the CRLF transform", ending => {
      const text = headBytes("scripts/trustedGit.mjs");
      const lines = text.split("\n");
      writeFileSync(harnessFile("scripts/trustedGit.mjs"), lines.map((line, at) => (at === lines.length - 1 ? line : `${line}${ending === "mixed" ? (at % 2 ? "\r" : "") : "\r\r"}`)).join("\n"), "latin1");
      const receipt = fresh();
      expect(receipt.verdict).toBe("UNAVAILABLE");
      expect(receipt.issues).toContain("HARNESS_NOT_COMMITTED");
    }, 70000);

    test("a committed file that has a CR is compared byte for byte", () => {
      // autocrlf would strip the CR on commit; the committed blob must really contain it.
      hgit(["config", "core.autocrlf", "false"]);
      writeFileSync(harnessFile("scripts/trustedGit.mjs"), `${headBytes("scripts/trustedGit.mjs")}// has\r\n`, "latin1");
      commitHarness();
      expect(headBytes("scripts/trustedGit.mjs")).toContain("\r");
      writeFileSync(harnessFile("scripts/trustedGit.mjs"), headBytes("scripts/trustedGit.mjs").replace(/\n/g, "\r\n"), "latin1");
      const receipt = fresh();
      expect(receipt.verdict).toBe("UNAVAILABLE");
      expect(receipt.issues).toContain("HARNESS_NOT_COMMITTED");
    }, 70000);
  });

  test("a subdirectory of the harness repository is not a harness checkout", () => {
    const receipt = executeLocal(["--scenario", record.id], { ...harnessHost(), harnessRoot: harnessFile("scripts") }) as unknown as Receipt;
    expect(receipt.issues).toContain("HARNESS_UNVERIFIED");
    expect(receipt.native).toBeNull();
  }, 70000);

  test("a harness commit without the reporter cannot be used", () => {
    rmSync(harnessFile("scripts/regression/localExecutionReporter.ts"));
    commitHarness();
    const receipt = executeLocal(["--scenario", record.id], harnessHost()) as unknown as Receipt;
    expect(receipt.issues).toContain("HARNESS_UNVERIFIED");
  }, 70000);

  test("the reporter reads base records without replace refs", () => {
    // A second scenario is active at the base commit and deleted at HEAD: that is a transition problem. A replace ref
    // that turns its base blob into a retired record would hide it, so the reporter must not honor replace refs.
    const other = { ...record, id: "fixture-other", fingerprint: "" };
    writeFileSync(path.join(root, "regression/scenarios/other.scenario.json"), JSON.stringify(other));
    commitAll("second active scenario");
    const base = git(["rev-parse", "HEAD"]);
    git(["rm", "-q", "regression/scenarios/other.scenario.json"]);
    commitAll("delete the second scenario");
    const blob = git(["rev-parse", `${base}:regression/scenarios/other.scenario.json`]);
    const retired = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, encoding: "utf8",
      input: JSON.stringify({ ...other, status: "retired" }) }).trim();
    git(["replace", blob, retired]);
    const receipt = executeLocal(["--scenario", record.id, "--base", base], harnessHost()) as unknown as Receipt;
    expect(receipt.verdict).toBe("FAIL");
    expect(receipt.native?.issues.join("\n")).toMatch(/transition: fixture-other: an active scenario was deleted/);
  }, 70000);

  test("an incomplete cleanup fails the run, on success and on every throw path", () => {
    const links: string[] = [];
    const stubborn = { ...harnessHost(), detachLink: (link: string) => { links.push(link); return false; } };
    const cleanUp = () => {
      for (const link of links) dropLink(link);
      for (const area of new Set(links.map(link => path.dirname(path.dirname(link))))) rmSync(area, { recursive: true, force: true });
      links.length = 0;
      rmSync(path.join(evidence, "result.json"));
    };
    try {
      // Success path.
      let receipt = executeLocal(["--scenario", record.id], stubborn) as unknown as Receipt;
      expect(receipt.verdict).toBe("FAIL");
      expect(receipt.issues).toContain("EXPORT_CLEANUP_INCOMPLETE");
      cleanUp();
      // A throw while running (two configs are ambiguous).
      writeFileSync(path.join(root, "vite.config.mjs"), config());
      commitAll("second config");
      receipt = executeLocal(["--scenario", record.id], stubborn) as unknown as Receipt;
      expect(receipt.issues).toEqual(expect.arrayContaining(["TRUSTED_CONFIG_REQUIRED", "EXPORT_CLEANUP_INCOMPLETE"]));
      cleanUp();
      // A throw while exporting (a tracked node_modules is refused after the harness copy exists).
      git(["rm", "-q", "vite.config.mjs"]);
      mkdirSync(path.join(root, "node_modules/dep"), { recursive: true });
      writeFileSync(path.join(root, "node_modules/dep/index.js"), "module.exports = 1;");
      git(["add", "-f", "node_modules"]);
      commitAll("tracked node_modules");
      receipt = executeLocal(["--scenario", record.id], stubborn) as unknown as Receipt;
      expect(receipt.issues).toEqual(expect.arrayContaining(["EXPORT_TRACKED_NODE_MODULES", "EXPORT_CLEANUP_INCOMPLETE"]));
      expect(receipt.verdict).toBe("FAIL");
    } finally {
      cleanUp();
    }
  }, 70000);

  describe("a cleanup that throws is still a failed cleanup", () => {
    const stuck = (message: string, links: string[]) => ({ ...harnessHost(), detachLink: (link: string) => { links.push(link); throw new Error(message); } });
    const sweep = (links: string[]) => {
      for (const link of links) dropLink(link);
      for (const area of new Set(links.map(link => path.dirname(path.dirname(link))))) rmSync(area, { recursive: true, force: true });
    };

    test.each(["EBUSY_SEAM", "ebusy lowercase"])("a detacher that throws %j on a passing run gives FAIL, never PASS", message => {
      const links: string[] = [];
      try {
        const receipt = executeLocal(["--scenario", record.id], stuck(message, links)) as unknown as Receipt;
        expect(receipt.verdict).toBe("FAIL");
        expect(receipt.issues).toContain("EXPORT_CLEANUP_INCOMPLETE");
      } finally {
        sweep(links);
      }
    }, 70000);

    test("a detacher that throws while the export is being refused gives FAIL with the refusal kept", () => {
      mkdirSync(path.join(root, "node_modules/dep"), { recursive: true });
      writeFileSync(path.join(root, "node_modules/dep/index.js"), "module.exports = 1;");
      git(["add", "-f", "node_modules"]);
      commitAll("tracked node_modules");
      const links: string[] = [];
      try {
        const receipt = executeLocal(["--scenario", record.id], stuck("EBUSY_SEAM", links)) as unknown as Receipt;
        expect(receipt.verdict).toBe("FAIL");
        expect(receipt.issues).toEqual(expect.arrayContaining(["EXPORT_TRACKED_NODE_MODULES", "EXPORT_CLEANUP_INCOMPLETE"]));
      } finally {
        sweep(links);
      }
    }, 70000);
  });

  test("every module the reporter loads lives under the exported scripts/ tree", () => {
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

describe("the export seams", () => {
  const sha1 = (text: string) => execFileSync("git", ["hash-object", "--no-filters", "--stdin"], { input: text, encoding: "utf8" }).trim();
  let destination: string;
  beforeEach(() => { destination = mkdtempSync(path.join(tmpdir(), "s3-export-")); });
  afterEach(() => rmSync(destination, { recursive: true, force: true }));
  const markerOnly = (file: string) => file === "marker.txt";
  const markerOid = () => git(["rev-parse", `${head}:marker.txt`]);
  const addEntry = (mode: string, content: string | null, file: string) => {
    const oid = content === null ? "1".repeat(40) : execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, encoding: "utf8", input: content }).trim();
    git(["update-index", "--add", "--cacheinfo", `${mode},${oid},${file}`]);
    // No `add .`: these entries have no working-tree file and would be staged as deletions.
    git(["-c", "user.name=S3Fixture", "-c", "user.email=s3@example.invalid", "commit", "-qm", `add ${file}`]);
    return git(["rev-parse", "HEAD"]);
  };

  test("the committed bytes are written exactly, with directories, and only what the filter includes", () => {
    writeCommittedTree(root, head, destination);
    expect(readFileSync(path.join(destination, "marker.txt"), "utf8")).toBe("before");
    expect(readFileSync(path.join(destination, "regression/scenarios/fixture.scenario.json"), "utf8")).toBe(readFileSync(scenarioPath(), "utf8"));
    const filtered = mkdtempSync(path.join(tmpdir(), "s3-export-"));
    try {
      writeCommittedTree(root, head, filtered, markerOnly);
      expect(readdirSync(filtered)).toEqual(["marker.txt"]);
    } finally {
      rmSync(filtered, { recursive: true, force: true });
    }
  });

  test("a submodule entry becomes an empty directory, and an executable file is an ordinary file", () => {
    addEntry("160000", null, "deep/sub");
    const tip = addEntry("100755", "#!/bin/sh\n", "deep/tool.sh");
    writeCommittedTree(root, tip, destination);
    expect(readdirSync(path.join(destination, "deep/sub"))).toEqual([]);
    expect(readFileSync(path.join(destination, "deep/tool.sh"), "utf8")).toBe("#!/bin/sh\n");
  });

  test("a symlink entry is refused", () => {
    const linked = addEntry("120000", "marker.txt", "alias");
    expect(() => writeCommittedTree(root, linked, destination)).toThrow("EXPORT_ENTRY_UNSUPPORTED");
  });

  test("a repository that is not sha1 cannot be exported", () => {
    const other = mkdtempSync(path.join(tmpdir(), "s3-sha256-"));
    try {
      execFileSync("git", ["init", "-q", "--object-format=sha256"], { cwd: other });
      expect(() => writeCommittedTree(other, "HEAD", destination)).toThrow("EXPORT_OBJECT_FORMAT_UNSUPPORTED");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test.each([
    ["correct bytes", () => `${markerOid()} blob 6\nbefore\n`, null],
    ["different bytes of the right length", () => `${markerOid()} blob 6\nBEFORE\n`, "EXPORT_OBJECT_MISMATCH"],
    ["a size larger than the bytes", () => `${markerOid()} blob 99\nbefore\n`, "EXPORT_OBJECT_MISMATCH"],
    ["a size that swallows the separator", () => `${markerOid()} blob 7\nbefore\n`, "EXPORT_OBJECT_MISMATCH"],
    ["no separator after the bytes", () => `${markerOid()} blob 6\nbefore`, "EXPORT_OBJECT_MISMATCH"],
    ["another object", () => `${"0".repeat(40)} blob 6\nbefore\n`, "EXPORT_OBJECTS_UNREADABLE"],
    ["a header that is not a blob", () => `${markerOid()} tree 6\nbefore\n`, "EXPORT_OBJECTS_UNREADABLE"],
    ["no output", () => "", "EXPORT_OBJECTS_UNREADABLE"],
    ["a header without a line end", () => `${markerOid()} blob 6`, "EXPORT_OBJECTS_UNREADABLE"],
  ])("object output with %s", (_name, output, refusal) => {
    const read = () => Buffer.from(output(), "latin1");
    if (refusal) expect(() => writeCommittedTree(root, head, destination, markerOnly, read)).toThrow(refusal);
    else {
      writeCommittedTree(root, head, destination, markerOnly, read);
      expect(readFileSync(path.join(destination, "marker.txt"), "utf8")).toBe("before");
    }
  });

  describe("verifyExport", () => {
    const place = (file: string, content: string) => {
      mkdirSync(path.dirname(path.join(destination, file)), { recursive: true });
      writeFileSync(path.join(destination, file), content);
    };
    const listing = () => ({ files: new Map([["a/b.txt", sha1("one")], ["c.txt", sha1("two")]]), directories: new Set(["", "a"]) });
    beforeEach(() => { place("a/b.txt", "one"); place("c.txt", "two"); });

    test("the exact listing verifies", () => {
      const { files, directories } = listing();
      expect(() => verifyExport(destination, files, directories)).not.toThrow();
    });

    test.each([
      ["an extra file", () => place("extra.txt", "x")],
      ["an extra nested file", () => place("a/extra.txt", "x")],
      ["an extra directory", () => mkdirSync(path.join(destination, "stray"))],
      ["a changed byte", () => place("c.txt", "twO")],
      ["a missing file", () => rmSync(path.join(destination, "c.txt"))],
      ["a file where a directory is listed", () => { rmSync(path.join(destination, "a"), { recursive: true }); place("a", "file"); }],
    ])("%s refuses", (_name, change) => {
      change();
      const { files, directories } = listing();
      expect(() => verifyExport(destination, files, directories)).toThrow("EXPORT_DIFFERS_FROM_HEAD");
    });
  });

  describe("checkTreePath", () => {
    test.each(["scripts/a.ts", ".gitignore", ".github/workflows/x.yml", "my_node_modules/x", "comet.txt", "com10", "..x", "a b/c", "x.test.ts", "a-b_c/d.e.f"])("%s is accepted", file => {
      expect(() => checkTreePath(file, new Set())).not.toThrow();
    });

    test.each(["", "a//b", "/a", "a/", ".", "..", "a/./b", "a/../b", ".git/config", "a/.GIT/x", "a\\b", "a:b", "a<b", "a>b", 'a"b', "a|b", "a?b", "a*b", "dot.", "space ", "CON", "con.txt", "a/AUX", "COM1", "lpt9.x", "nul", "a\nb", "a\rb", "x/y\n"])("%j is refused as unsafe", file => {
      expect(() => checkTreePath(file, new Set())).toThrow("EXPORT_PATH_UNSAFE");
    });

    test.each(["node_modules/x", "a/Node_Modules/x", "NODE_MODULES"])("%s is refused as a tracked dependency tree", file => {
      expect(() => checkTreePath(file, new Set())).toThrow("EXPORT_TRACKED_NODE_MODULES");
    });

    test("paths that differ only by case collide", () => {
      const seen = new Set<string>();
      checkTreePath("Docs/A.ts", seen);
      expect(() => checkTreePath("docs/a.ts", seen)).toThrow("EXPORT_PATH_COLLISION");
      expect(() => checkTreePath("docs/b.ts", seen)).not.toThrow();
    });
  });

  test.each([
    ["identical bytes", "a\nb\n", "a\nb\n", true],
    ["identical bytes with CRLF committed", "a\r\nb\r\n", "a\r\nb\r\n", true],
    ["a whole-file LF to CRLF conversion", "a\r\nb\r\n", "a\nb\n", true],
    ["a conversion of a file with no trailing newline", "a\r\nb", "a\nb", true],
    ["a conversion of an empty file", "", "", true],
    ["a doubled CR", "a\r\r\nb\r\r\n", "a\nb\n", false],
    ["mixed endings", "a\r\nb\n", "a\nb\n", false],
    ["a lone CR added", "a\rb\n", "a\nb\n", false],
    ["a changed byte", "a\r\nc\r\n", "a\nb\n", false],
    ["an appended line", "a\r\nb\r\nc\r\n", "a\nb\n", false],
    ["a CRLF conversion of a file that already had a CR", "a\r\r\nb\r\n", "a\rb\n", false],
    ["a CRLF-only working file for a committed file with a CR", "a\r\nb\r\n", "a\r\nb\n", false],
  ])("matchesHead: %s", (_name, working, committed, expected) => {
    expect(matchesHead(Buffer.from(working, "latin1"), Buffer.from(committed, "latin1"))).toBe(expected);
  });

  describe("removeExport", () => {
    let dependencies: string;
    const lay = () => {
      const area = mkdtempSync(path.join(tmpdir(), "s3-area-"));
      const links: string[] = [];
      for (const part of ["tree", "harness"]) {
        mkdirSync(path.join(area, part, "src"), { recursive: true });
        writeFileSync(path.join(area, part, "src/file.txt"), part);
        const link = path.join(area, part, "node_modules");
        symlinkSync(dependencies, link, process.platform === "win32" ? "junction" : "dir");
        links.push(link);
      }
      return { area, links };
    };
    beforeEach(() => {
      dependencies = mkdtempSync(path.join(tmpdir(), "s3-deps-"));
      writeFileSync(path.join(dependencies, "dep.js"), "module.exports = 1;");
    });
    afterEach(() => rmSync(dependencies, { recursive: true, force: true }));

    test("both links are detached before the recursive delete and the dependencies survive", () => {
      const { area } = lay();
      expect(removeExport(area)).toBe(true);
      expect(existsSync(area)).toBe(false);
      expect(readFileSync(path.join(dependencies, "dep.js"), "utf8")).toBe("module.exports = 1;");
    });

    test("a link that will not detach is reported, every sibling is still removed, and the link target is untouched", () => {
      const { area, links } = lay();
      const stuck = new Set<string>();
      // The first link stays; the second detaches for real. One failure must not be forgotten by the success after it.
      const detach = (link: string) => {
        if (link === links[0]) { stuck.add(link); return false; }
        dropLink(link);
        return true;
      };
      try {
        expect(removeExport(area, detach)).toBe(false);
        expect(stuck.size).toBe(1);
        expect(existsSync(path.join(area, "tree/src"))).toBe(false);
        expect(existsSync(path.join(area, "harness/src"))).toBe(false);
        expect(lstatSync(links[0]).isSymbolicLink()).toBe(true);
        expect(readFileSync(path.join(dependencies, "dep.js"), "utf8")).toBe("module.exports = 1;");
      } finally {
        dropLink(links[0]);
        rmSync(area, { recursive: true, force: true });
      }
    });

    test("an area that is already partly gone is removed without error", () => {
      const { area, links } = lay();
      dropLink(links[1]);
      rmSync(path.join(area, "harness"), { recursive: true });
      expect(removeExport(area)).toBe(true);
      expect(existsSync(area)).toBe(false);
    });
  });

  test.each([
    ["scripts/a.ts", true], ["scripts/regression/x.mjs", true], ["package.json", true], ["tsconfig.json", true],
    ["tsconfig.build.json", true], ["tsconfig.app.json", true],
    ["convex/package.json", false], ["scriptsx/a.ts", false], ["xpackage.json", false], ["package.jsonx", false], ["tsconfig/x.json", false],
    ["tsconfig.jsonx", false], ["vitest.config.mjs", false], [".npmrc", false], ["pnpm-lock.yaml", false], ["regression/scenarios/a.scenario.json", false],
  ])("%s is %s a harness file", (file, harnessFile) => {
    expect(isHarnessFile(file)).toBe(harnessFile);
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
