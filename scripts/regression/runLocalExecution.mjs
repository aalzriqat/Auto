import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const implementationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const value = name => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; };
const root = path.resolve(value("root") ?? process.cwd());
const scenarioId = value("scenario") ?? "opening-all-families-public-rehearsal";
const artifactDirectory = mkdtempSync(path.join(tmpdir(), "autoflow-local-execution-"));
const output = path.resolve(value("output") ?? path.join(artifactDirectory, "result.json"));
const events = path.join(artifactDirectory, "native-events.json");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });

/** Observed local files, not a trusted-job or production attestation. */
function observeSource() {
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).sort();
  const digest = createHash("sha256");
  for (const file of files) {
    const target = path.resolve(root, file);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error("SOURCE_SYMLINK_UNAVAILABLE");
    const bytes = !existsSync(target) ? "MISSING" : hash(readFileSync(target));
    digest.update(file).update("\0").update(bytes).update("\0");
  }
  return { head: git(["rev-parse", "HEAD"]).trim(), tree: git(["rev-parse", "HEAD^{tree}"]).trim(),
    fileCount: files.length, fileDigest: digest.digest("hex"), dirty: git(["status", "--porcelain"]).trim() !== "" };
}

const receipt = { schemaVersion: 1, scope: "LOCAL_BACKEND_HARNESS_ADVISORY", trustedProducer: false,
  scenarioId, verdict: "UNAVAILABLE", issues: [], source: null, native: null, process: null };
let publicationAllowed = false;
try {
  const outputRelative = path.relative(root, output);
  if (!(outputRelative === ".." || outputRelative.startsWith(`..${path.sep}`) || path.isAbsolute(outputRelative)))
    throw new Error("OUTPUT_MUST_BE_OUTSIDE_SOURCE");
  if (existsSync(output)) throw new Error("OUTPUT_ALREADY_EXISTS");
  publicationAllowed = true;
  if (!/^[a-z0-9][a-z0-9._-]{2,80}$/.test(scenarioId)) throw new Error("SCENARIO_ID_INVALID");
  const before = observeSource();
  receipt.source = { before, after: null, authority: "UNATTESTED_LOCAL_OBSERVATION" };
  const expectedHead = value("expect-head");
  if (expectedHead && expectedHead !== before.head) throw new Error("EXPECTED_HEAD_MISMATCH");
  const base = value("base") ?? before.head;
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error("BASE_REVISION_REQUIRED");
  receipt.source.base = base;
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "regression/scenarios"])
    .split("\0").filter(file => file.endsWith(".scenario.json"));
  const matches = files.map(file => JSON.parse(readFileSync(path.join(root, file), "utf8"))).filter(record => record.id === scenarioId);
  if (matches.length !== 1 || !matches[0].impl || typeof matches[0].impl.file !== "string" || typeof matches[0].impl.testName !== "string")
    throw new Error("SINGLE_RECORD_BINDING_REQUIRED");
  const binding = matches[0].impl, testFile = path.resolve(root, binding.file);
  const relative = path.relative(root, testFile);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !/\.test\.tsx?$/.test(relative)) throw new Error("BACKEND_TEST_PATH_REQUIRED");
  const pattern = `^${binding.testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const child = spawnSync(process.execPath, [path.join(implementationRoot, "node_modules/vitest/vitest.mjs"), "run", relative,
    "--root", root, "--maxWorkers=1", "--no-file-parallelism", "--retry=0", "-t", pattern,
    "--reporter", path.join(implementationRoot, "scripts/regression/localExecutionReporter.ts")],
  { cwd: root, timeout: 60000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", env: { ...process.env,
    AUTOFLOW_LOCAL_SCENARIO_EVENTS: events, AUTOFLOW_LOCAL_SCENARIO_ID: scenarioId, AUTOFLOW_LOCAL_SCENARIO_BASE: base } });
  receipt.process = { exit: child.status, signal: child.signal, error: child.error?.name ?? null };
  if (existsSync(events)) receipt.native = JSON.parse(readFileSync(events, "utf8"));
  else receipt.issues.push("NATIVE_REPORT_UNAVAILABLE");
  const after = observeSource();
  receipt.source.after = after;
  if (JSON.stringify(before) !== JSON.stringify(after)) receipt.issues.push("SOURCE_CHANGED_DURING_EXECUTION");
  if (child.status !== 0 || child.signal || child.error) receipt.issues.push("CHILD_PROCESS_NOT_CLEAN");
  if (!receipt.native?.complete || receipt.native.verdict !== "PASS" || receipt.native.root !== root || receipt.native.scenarioId !== scenarioId || receipt.native.baseRevision !== base)
    receipt.issues.push("NATIVE_EXECUTION_NOT_VERIFIED");
  receipt.verdict = receipt.issues.length ? "FAIL" : "PASS";
} catch (error) {
  receipt.issues.push(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "LOCAL_EXECUTION_UNAVAILABLE");
}
if (publicationAllowed) writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ scope: receipt.scope, trustedProducer: false, verdict: receipt.verdict,
  output: publicationAllowed ? output : null, issues: receipt.issues }));
process.exitCode = receipt.verdict === "PASS" ? 0 : 1;
