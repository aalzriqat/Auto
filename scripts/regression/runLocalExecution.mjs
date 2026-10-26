import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";

const implementationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (root, args) => execFileSync(resolveTrustedGitExecutable(), args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });

/** Observed local files, not a trusted-job or production attestation. */
function observeSource(root) {
  const files = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).sort();
  const digest = createHash("sha256");
  for (const file of files) {
    const target = path.resolve(root, file);
    const entry = lstatSync(target, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) throw new Error("SOURCE_SYMLINK_UNAVAILABLE");
    const bytes = entry ? hash(readFileSync(target)) : "MISSING";
    digest.update(file).update("\0").update(bytes).update("\0");
  }
  return { head: git(root, ["rev-parse", "HEAD"]).trim(), tree: git(root, ["rev-parse", "HEAD^{tree}"]).trim(),
    fileCount: files.length, fileDigest: digest.digest("hex"), dirty: git(root, ["status", "--porcelain"]).trim() !== "" };
}

function selectBinding(root, scenarioId) {
  const files = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "regression/scenarios"])
    .split("\0").filter(file => file.endsWith(".scenario.json"));
  const matches = files.map(file => JSON.parse(readFileSync(path.join(root, file), "utf8"))).filter(record => record.id === scenarioId);
  if (matches.length !== 1 || !matches[0].impl || typeof matches[0].impl.file !== "string" || typeof matches[0].impl.testName !== "string")
    throw new Error("SINGLE_RECORD_BINDING_REQUIRED");
  const binding = matches[0].impl, testFile = path.resolve(root, binding.file);
  const relative = path.relative(root, testFile);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !/\.test\.tsx?$/.test(relative)) throw new Error("BACKEND_TEST_PATH_REQUIRED");
  return { binding, relative };
}

function measureExecution({ root, scenarioId, base, events }, receipt) {
  const { binding, relative } = selectBinding(root, scenarioId);
  const escapedName = binding.testName.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const pattern = `^${escapedName}$`;
  const child = spawnSync(process.execPath, [path.join(implementationRoot, "node_modules/vitest/vitest.mjs"), "run", relative,
    "--root", root, "--maxWorkers=1", "--no-file-parallelism", "--retry=0", "-t", pattern,
    "--reporter", path.join(implementationRoot, "scripts/regression/localExecutionReporter.ts")],
  { cwd: root, timeout: 60000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", env: { ...process.env,
    AUTOFLOW_LOCAL_SCENARIO_EVENTS: events, AUTOFLOW_LOCAL_SCENARIO_ID: scenarioId, AUTOFLOW_LOCAL_SCENARIO_BASE: base } });
  receipt.process = { exit: child.status, signal: child.signal, error: child.error?.name ?? null };
  if (existsSync(events)) receipt.native = JSON.parse(readFileSync(events, "utf8"));
  else receipt.issues.push("NATIVE_REPORT_UNAVAILABLE");
  const after = observeSource(root);
  receipt.source.after = after;
  if (JSON.stringify(receipt.source.before) !== JSON.stringify(after)) receipt.issues.push("SOURCE_CHANGED_DURING_EXECUTION");
  if (child.status !== 0 || child.signal || child.error) receipt.issues.push("CHILD_PROCESS_NOT_CLEAN");
  if (!receipt.native?.complete || receipt.native.verdict !== "PASS" || receipt.native.root !== root || receipt.native.scenarioId !== scenarioId || receipt.native.baseRevision !== base)
    receipt.issues.push("NATIVE_EXECUTION_NOT_VERIFIED");
  receipt.verdict = receipt.issues.length ? "FAIL" : "PASS";
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    const parsed = parseArgs({ args: argv, strict: true, allowPositionals: false, tokens: true,
      options: { root: { type: "string" }, scenario: { type: "string" }, output: { type: "string" },
        base: { type: "string" }, "expect-head": { type: "string" } } });
    options = parsed.values;
    const seen = new Set();
    for (const token of parsed.tokens) {
      if (token.kind !== "option") continue;
      if (seen.has(token.name)) throw new Error("CLI_OPTION_REPEATED");
      seen.add(token.name);
    }
    for (const name of ["base", "expect-head"]) {
      if (options[name] !== undefined && !/^[0-9a-f]{40}$/.test(options[name])) throw new Error("REVISION_ARGUMENT_INVALID");
    }
  } catch {
    const receipt = { schemaVersion: 1, scope: "LOCAL_BACKEND_HARNESS_ADVISORY", trustedProducer: false,
      verdict: "UNAVAILABLE", issues: ["CLI_ARGUMENTS_INVALID"], source: null, native: null, process: null };
    console.log(JSON.stringify({ ...receipt, output: null }));
    return receipt;
  }
  const value = name => options[name];
  const root = path.resolve(value("root") ?? process.cwd());
  const scenarioId = value("scenario") ?? "opening-all-families-public-rehearsal";
  const artifactDirectory = mkdtempSync(path.join(tmpdir(), "autoflow-local-execution-"));
  const output = path.resolve(value("output") ?? path.join(artifactDirectory, "result.json"));
  const events = path.join(artifactDirectory, "native-events.json");
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
    const before = observeSource(root);
    receipt.source = { before, after: null, authority: "UNATTESTED_LOCAL_OBSERVATION" };
    const expectedHead = value("expect-head");
    if (expectedHead && expectedHead !== before.head) throw new Error("EXPECTED_HEAD_MISMATCH");
    const base = value("base") ?? before.head;
    if (!/^[0-9a-f]{40}$/.test(base)) throw new Error("BASE_REVISION_REQUIRED");
    receipt.source.base = base;
    measureExecution({ root, scenarioId, base, events }, receipt);
  } catch (error) {
    receipt.issues.push(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "LOCAL_EXECUTION_UNAVAILABLE");
  }
  if (publicationAllowed) writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ scope: receipt.scope, trustedProducer: false, verdict: receipt.verdict,
    output: publicationAllowed ? output : null, issues: receipt.issues }));
  return receipt;
}

if (typeof import.meta.main !== "boolean") {
  throw new Error("UNSUPPORTED_NODE: native import.meta.main requires Node 22.18.0 or later");
}
if (import.meta.main) {
  process.exitCode = main().verdict === "PASS" ? 0 : 1;
}
