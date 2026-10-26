import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveTrustedGitExecutable } from "../trustedGit.mjs";

const implementationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
// GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and friends would redirect Git away from the observed checkout.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
// Node preloads/loaders and Vite/Vitest overrides would run or reconfigure code the committed tree does not contain.
const childEnv = () => Object.fromEntries(Object.entries(cleanEnv()).filter(([name]) => !/^(NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|VITE|VITE_.*|VITEST|VITEST_.*|npm_config_.*|PNPM_.*)$/i.test(name)));
const git = (root, args, extraEnv = {}) => execFileSync(resolveTrustedGitExecutable(), args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: { ...cleanEnv(), ...extraEnv } });

/** Observed local files, not a trusted-job or production attestation. */
function observeSource(root) {
  const files = git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).sort();
  const digest = createHash("sha256");
  for (const file of files) {
    const target = path.resolve(root, file);
    // A symlinked parent directory would let the final-component check follow into another tree.
    const parent = path.dirname(target);
    if (existsSync(parent) && !sameFileName(realpathSync(parent), parent)) throw new Error("SOURCE_SYMLINK_UNAVAILABLE");
    const entry = lstatSync(target, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) throw new Error("SOURCE_SYMLINK_UNAVAILABLE");
    const bytes = entry ? hash(readFileSync(target)) : "MISSING";
    digest.update(file).update("\0").update(bytes).update("\0");
  }
  return { head: git(root, ["rev-parse", "HEAD"]).trim(), tree: git(root, ["rev-parse", "HEAD^{tree}"]).trim(),
    fileCount: files.length, fileDigest: digest.digest("hex"), dirty: git(root, ["status", "--porcelain"]).trim() !== "" };
}

function selectBinding(root, scenarioId) {
  // A plain walk, so it works on the Git-less export as well; the export holds only committed files.
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(relative);
      else if (entry.name.endsWith(".scenario.json")) files.push(relative);
    }
  };
  if (existsSync(path.join(root, "regression/scenarios"))) walk("regression/scenarios");
  const matches = files.map(file => JSON.parse(readFileSync(path.join(root, file), "utf8"))).filter(record => record.id === scenarioId);
  if (matches.length !== 1 || !matches[0].impl || typeof matches[0].impl.file !== "string" || typeof matches[0].impl.testName !== "string")
    throw new Error("SINGLE_RECORD_BINDING_REQUIRED");
  const binding = matches[0].impl, testFile = path.resolve(root, binding.file);
  const relative = path.relative(root, testFile);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !/\.test\.tsx?$/.test(relative)) throw new Error("BACKEND_TEST_PATH_REQUIRED");
  return { binding, testFile };
}

// Case-insensitive: Vitest on a case-insensitive filesystem discovers Vitest.Config.MJS as vitest.config.mjs.
const CONFIG_NAME = /^(vite|vitest)\.(config|workspace|projects)\.[cm]?[jt]s$|^vitest\.workspace\.json$/i;

/**
 * The one Vitest config of the exported tree. It runs in the process that holds the report pipe, so an ambiguous or
 * non-regular entry refuses.
 * @returns {string | null} the one config file name, or null when HEAD has none
 */
function exportedConfig(exportRoot) {
  try {
    const present = readdirSync(exportRoot).filter(name => CONFIG_NAME.test(name));
    if (present.length > 1) throw new Error("TRUSTED_CONFIG_REQUIRED");
    for (const name of present) if (!lstatSync(path.join(exportRoot, name)).isFile()) throw new Error("TRUSTED_CONFIG_REQUIRED");
    return present[0] ?? null;
  } catch {
    throw new Error("TRUSTED_CONFIG_REQUIRED");
  }
}

/**
 * Everything Vitest runs comes from a fresh export of the observed HEAD commit, never from the working tree, so ignored,
 * assume-unchanged, skip-worktree or hidden-untracked files cannot take part. A throwaway index keeps the user's index
 * untouched. Installed dependencies are reached through a link to the checkout's own node_modules.
 */
function exportCommitted(root, head) {
  const parent = realpathSync(tmpdir());
  const area = mkdtempSync(path.join(parent, "autoflow-export-"));
  try {
    if (!isOutside(root, area)) throw new Error("EXPORT_MUST_BE_OUTSIDE_SOURCE");
    const exportRoot = path.join(area, "tree");
    mkdirSync(exportRoot);
    const env = { GIT_INDEX_FILE: path.join(area, "index") };
    git(root, ["read-tree", head], env);
    git(root, ["checkout-index", "-a", "-f", `--prefix=${exportRoot.replace(/\\/g, "/")}/`], env);
    const modules = path.join(root, "node_modules");
    if (lstatSync(modules, { throwIfNoEntry: false }) && !existsSync(path.join(exportRoot, "node_modules")))
      symlinkSync(realpathSync(modules), path.join(exportRoot, "node_modules"), "junction");
    return { area, exportRoot };
  } catch (error) {
    removeExport(area);
    throw error;
  }
}

/** Remove the link first: a recursive delete must never follow it into the real node_modules. */
function removeExport(area) {
  const link = path.join(area, "tree", "node_modules");
  if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) {
    try { rmdirSync(link); } catch { try { unlinkSync(link); } catch { /* leave the export rather than risk the link target */ } }
    if (lstatSync(link, { throwIfNoEntry: false })) return;
  }
  rmSync(area, { recursive: true, force: true });
}

/** Digest of the exported files (not the dependency link), to see whether the run changed them. */
function observeExport(exportRoot) {
  const digest = createHash("sha256");
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(directory, entry.name);
      if (directory === exportRoot && entry.name === "node_modules") continue;
      digest.update(path.relative(exportRoot, full)).update("\0");
      if (entry.isDirectory()) walk(full);
      else if (entry.isSymbolicLink()) digest.update("LINK");
      else digest.update(hash(readFileSync(full)));
      digest.update("\0");
    }
  };
  walk(exportRoot);
  return digest.digest("hex");
}

function measureExecution({ root, scenarioId, base }, receipt) {
  selectBinding(root, scenarioId);
  // Fail closed on visible uncommitted edits too: a verdict about HEAD must not be read as one about the edited tree.
  if (receipt.source.before.dirty) throw new Error("SOURCE_NOT_COMMITTED");
  const { area, exportRoot } = exportCommitted(root, receipt.source.before.head);
  try {
    runExported({ root, exportRoot, scenarioId, base }, receipt);
  } finally {
    removeExport(area);
  }
}

function runExported({ root, exportRoot, scenarioId, base }, receipt) {
  const { binding, testFile } = selectBinding(exportRoot, scenarioId);
  const config = exportedConfig(exportRoot);
  const exportedBefore = observeExport(exportRoot);
  receipt.execution = { from: "HEAD_EXPORT" };
  const escapedName = binding.testName.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const pattern = `^${escapedName}$`;
  // The report returns on an extra pipe (fd 3) that only the Vitest main process holds. Forked workers, where the
  // candidate's tests run, do not inherit it, and no file path is trusted: nothing the child can write on disk is read.
  const child = spawnSync(process.execPath, [path.join(implementationRoot, "node_modules/vitest/vitest.mjs"), "run", testFile,
    "--root", exportRoot, ...(config ? ["--config", path.join(exportRoot, config)] : []), "--pool=forks", "--maxWorkers=1", "--no-file-parallelism", "--retry=0", "-t", pattern,
    "--reporter", path.join(implementationRoot, "scripts/regression/localExecutionReporter.ts")],
  { cwd: exportRoot, timeout: 60000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe"], env: { ...childEnv(),
    AUTOFLOW_LOCAL_SCENARIO_FD: "3", AUTOFLOW_LOCAL_SCENARIO_ID: scenarioId, AUTOFLOW_LOCAL_SCENARIO_BASE: base,
    AUTOFLOW_LOCAL_SCENARIO_GIT_ROOT: root } });
  receipt.process = { exit: child.status, signal: child.signal, error: child.error?.name ?? null };
  const channel = child.output?.[3];
  try {
    if (typeof channel === "string" && channel) receipt.native = JSON.parse(channel);
    else receipt.issues.push("NATIVE_REPORT_UNAVAILABLE");
  } catch {
    receipt.issues.push("NATIVE_REPORT_UNAVAILABLE");
  }
  const after = observeSource(root);
  receipt.source.after = after;
  if (JSON.stringify(receipt.source.before) !== JSON.stringify(after) || observeExport(exportRoot) !== exportedBefore)
    receipt.issues.push("SOURCE_CHANGED_DURING_EXECUTION");
  if (child.status !== 0 || child.signal || child.error) receipt.issues.push("CHILD_PROCESS_NOT_CLEAN");
  if (!receipt.native?.complete || receipt.native.verdict !== "PASS" || receipt.native.root !== exportRoot || receipt.native.scenarioId !== scenarioId || receipt.native.baseRevision !== base)
    receipt.issues.push("NATIVE_EXECUTION_NOT_VERIFIED");
  receipt.verdict = receipt.issues.length ? "FAIL" : "PASS";
}

function parseOptions(argv) {
  const parsed = parseArgs({ args: argv, strict: true, allowPositionals: false, tokens: true,
    options: { root: { type: "string" }, scenario: { type: "string" },
      base: { type: "string" }, "expect-head": { type: "string" } } });
  const seen = new Set();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) throw new Error("CLI_OPTION_REPEATED");
    seen.add(token.name);
  }
  for (const name of ["base", "expect-head"]) {
    if (parsed.values[name] !== undefined && !/^[0-9a-f]{40}$/.test(parsed.values[name])) throw new Error("REVISION_ARGUMENT_INVALID");
  }
  return parsed.values;
}

const isOutside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
};
const RECEIPT_FILE = "result.json";
const sameFileName = (left, right) => (process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right);

/**
 * The host, not a CLI argument, selects the source root: the launcher's working directory.
 * @param {string} [cwd]
 * @returns {{ root: string, evidenceDirectory: string | null }}
 */
export function createHostContext(cwd = process.cwd()) {
  return { root: cwd, evidenceDirectory: null };
}

function prepareInvocation(options, context) {
  const root = realpathSync(context.root);
  if (!statSync(root).isDirectory()) throw new Error("ROOT_DIRECTORY_REQUIRED");
  // --root only confirms the host-selected root; it is compared as text and never used as a path.
  if (options.root !== undefined) {
    const confirmation = options.root.trim() === "" ? "" : path.resolve(options.root);
    if (!confirmation || ![root, path.resolve(context.root)].some(known => sameFileName(known, confirmation)))
      throw new Error("ROOT_CONTEXT_MISMATCH");
  }
  // The receipt name is fixed; no argument contributes to any output path.
  // Check the parent before creating anything, so a TEMP/TMP/TMPDIR inside the checkout leaves nothing behind.
  const evidenceParent = context.evidenceDirectory ?? realpathSync(tmpdir());
  if (!isOutside(root, realpathSync(evidenceParent))) throw new Error("OUTPUT_MUST_BE_OUTSIDE_SOURCE");
  const evidenceDirectory = realpathSync(context.evidenceDirectory ?? mkdtempSync(path.join(realpathSync(tmpdir()), "autoflow-local-execution-")));
  if (!isOutside(root, evidenceDirectory)) throw new Error("OUTPUT_MUST_BE_OUTSIDE_SOURCE");
  const output = path.join(evidenceDirectory, RECEIPT_FILE);
  // lstat, not exists: a dangling link in the evidence directory must also refuse.
  if (lstatSync(output, { throwIfNoEntry: false })) throw new Error("OUTPUT_ALREADY_EXISTS");
  // Create the receipt now and keep the handle: the final write goes through this descriptor, never back through the
  // path, so replacing the directory (or a parent link) while the child runs cannot redirect it. "wx" is O_EXCL.
  const outputFd = openSync(output, "wx");
  const created = fstatSync(outputFd, { bigint: true });
  try {
    if (!isOutside(root, realpathSync(output))) throw new Error("OUTPUT_MUST_BE_OUTSIDE_SOURCE");
  } catch (error) {
    closeSync(outputFd);
    // The file this call just created must not survive a refused invocation, least of all inside the source tree.
    // Remove it only while the path still names that very file; a replacement is not ours to delete.
    const now = lstatSync(output, { bigint: true, throwIfNoEntry: false });
    if (now && now.dev === created.dev && now.ino === created.ino) {
      try { unlinkSync(output); } catch { /* already gone */ }
    }
    throw error;
  }
  return { root, output, outputFd };
}

export function main(argv = process.argv.slice(2), context = createHostContext()) {
  let options;
  try {
    options = parseOptions(argv);
  } catch {
    const receipt = { schemaVersion: 1, scope: "LOCAL_BACKEND_HARNESS_ADVISORY", trustedProducer: false,
      verdict: "UNAVAILABLE", issues: ["CLI_ARGUMENTS_INVALID"], source: null, native: null, process: null };
    console.log(JSON.stringify({ ...receipt, output: null }));
    return receipt;
  }
  const scenarioId = options.scenario ?? "opening-all-families-public-rehearsal";
  const receipt = { schemaVersion: 1, scope: "LOCAL_BACKEND_HARNESS_ADVISORY", trustedProducer: false,
    scenarioId, verdict: "UNAVAILABLE", issues: [], source: null, native: null, process: null };
  let publicationAllowed = false;
  let output = null;
  let outputFd = null;
  try {
    const invocation = prepareInvocation(options, context);
    const { root } = invocation;
    output = invocation.output;
    outputFd = invocation.outputFd;
    publicationAllowed = true;
    if (!/^[a-z0-9][a-z0-9._-]{2,80}$/.test(scenarioId)) throw new Error("SCENARIO_ID_INVALID");
    const before = observeSource(root);
    receipt.source = { before, after: null, authority: "UNATTESTED_LOCAL_OBSERVATION" };
    const expectedHead = options["expect-head"];
    if (expectedHead && expectedHead !== before.head) throw new Error("EXPECTED_HEAD_MISMATCH");
    const base = options.base ?? before.head;
    if (!/^[0-9a-f]{40}$/.test(base)) throw new Error("BASE_REVISION_REQUIRED");
    receipt.source.base = base;
    measureExecution({ root, scenarioId, base }, receipt);
  } catch (error) {
    receipt.issues.push(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "LOCAL_EXECUTION_UNAVAILABLE");
  }
  if (publicationAllowed) {
    try {
      writeSync(outputFd, `${JSON.stringify(receipt, null, 2)}\n`);
    } finally {
      closeSync(outputFd);
    }
  }
  console.log(JSON.stringify({ scope: receipt.scope, trustedProducer: false, verdict: receipt.verdict,
    output: publicationAllowed ? output : null, issues: receipt.issues }));
  return receipt;
}

if (typeof import.meta.main !== "boolean") {
  throw new TypeError("UNSUPPORTED_NODE: native import.meta.main requires Node 22.18.0 or later");
}
if (import.meta.main) {
  process.exitCode = main().verdict === "PASS" ? 0 : 1;
}
