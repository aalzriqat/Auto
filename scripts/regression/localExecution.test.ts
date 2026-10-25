// @vitest-environment node
import { afterEach, beforeEach, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { digestRulingText, scenarioFingerprint, type ScenarioRecord } from "./scenarioRecord";
import type { LocalExecutionReport } from "./localExecutionReporter";

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
  for (const target of [root, evidence]) {
    const absolute = path.resolve(target), parent = path.resolve(tmpdir());
    if (!absolute.startsWith(`${parent}${path.sep}s3-`)) throw new Error("Unsafe fixture cleanup path");
    // These created directories contain no dependency junctions or linked checkouts.
    rmSync(absolute, { recursive: true, force: true });
  }
});

test("actual native execution joins one record without trusting GitHub environment labels", () => {
  const receipt = run("positive");
  expect(receipt).toMatchObject({ verdict: "PASS", trustedProducer: false, source: { before: { head } } });
  expect(receipt.native?.cases).toHaveLength(1);
  expect(receipt.native?.cases[0]).toMatchObject({ name: title, project: "", state: "passed", expectedFailure: false,
    retryCount: 0, repeatCount: 0, flaky: false });
  expect(receipt.native?.cases[0].id).toEqual(expect.any(String));
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
