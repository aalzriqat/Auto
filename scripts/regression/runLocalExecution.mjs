import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
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

const blobId = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * The blobs of one commit, listed without any working-tree input.
 * @returns {{ mode: string, type: string, oid: string, file: string }[]}
 */
function listTree(cwd, args) {
  return git(cwd, ["--no-replace-objects", "ls-tree", "-r", "-z", ...args]).split("\0").filter(Boolean).map(line => {
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error("EXPORT_TREE_UNREADABLE");
    return { mode: match[1], type: match[2], oid: match[3], file: match[4] };
  });
}

/** Paths from the object database are data: refuse anything that could leave, alias or hide inside the export. Exported for tests. */
export function checkTreePath(file, seen) {
  const segments = file.split("/");
  for (const segment of segments) {
    if (/^node_modules$/i.test(segment)) throw new Error("EXPORT_TRACKED_NODE_MODULES");
    if (segment === "" || segment === "." || segment === ".." || /^\.git$/i.test(segment) || /[\\:<>"|?*\0]/.test(segment) ||
      /[. ]$/.test(segment) || RESERVED_NAME.test(segment)) throw new Error("EXPORT_PATH_UNSAFE");
  }
  const key = file.toLowerCase();
  if (seen.has(key)) throw new Error("EXPORT_PATH_COLLISION");
  seen.add(key);
}

/**
 * Write the commit's blobs straight from the object database. Nothing consults the working tree, the index, the invoker's
 * smudge/clean filters, hooks or any .gitattributes, so the bytes are exactly the tree's; each blob is hashed again here
 * and the finished export is compared against the listing before anything runs. Bytes are exact except that the
 * executable bit is not restored, LFS files stay pointer text, and a submodule is an empty directory. Exported for tests.
 * @param {string} root checkout whose object database is read
 * @param {string} head commit to export
 * @param {string} exportRoot empty destination directory
 * @param {(file: string) => boolean} [include] which tree paths to write
 * @param {(root: string, oids: string[]) => Buffer} [readObjects] raw `cat-file --batch` output; a seam for tests
 */
export function writeCommittedTree(root, head, exportRoot, include = () => true, readObjects = readBlobBatch) {
  if (git(root, ["rev-parse", "--show-object-format"]).trim() !== "sha1") throw new Error("EXPORT_OBJECT_FORMAT_UNSUPPORTED");
  const entries = listTree(root, ["--full-tree", head]).filter(entry => include(entry.file));
  const seen = new Set(), files = new Map(), directories = new Set([""]);
  for (const entry of entries) {
    checkTreePath(entry.file, seen);
    if (entry.mode === "160000") directories.add(entry.file);
    else if (entry.mode === "100644" || entry.mode === "100755") files.set(entry.file, entry.oid);
    else throw new Error("EXPORT_ENTRY_UNSUPPORTED");
  }
  for (const known of [...files.keys(), ...directories]) {
    for (let at = known.lastIndexOf("/"); at > 0; at = known.lastIndexOf("/", at - 1)) directories.add(known.slice(0, at));
  }
  const wanted = [...files.values()];
  const output = readObjects(root, wanted);
  let position = 0;
  const bytesOf = new Map();
  for (const oid of wanted) {
    const lineEnd = output.indexOf(10, position);
    const header = lineEnd < 0 ? "" : output.subarray(position, lineEnd).toString("latin1");
    const match = /^([0-9a-f]{40}) blob (\d+)$/.exec(header);
    if (!match || match[1] !== oid) throw new Error("EXPORT_OBJECTS_UNREADABLE");
    const size = Number(match[2]), start = lineEnd + 1;
    const bytes = output.subarray(start, start + size);
    if (bytes.length !== size || output[start + size] !== 10 || blobId(bytes) !== oid) throw new Error("EXPORT_OBJECT_MISMATCH");
    bytesOf.set(oid, bytes);
    position = start + size + 1;
  }
  for (const directory of directories) if (directory) mkdirSync(path.join(exportRoot, directory), { recursive: true });
  for (const [file, oid] of files) writeFileSync(path.join(exportRoot, file), bytesOf.get(oid), { flag: "wx" });
  verifyExport(exportRoot, files, directories);
}

function readBlobBatch(root, oids) {
  const read = spawnSync(resolveTrustedGitExecutable(), ["--no-replace-objects", "cat-file", "--batch"],
    { cwd: root, input: `${oids.join("\n")}\n`, maxBuffer: 1024 * 1024 * 1024, env: cleanEnv() });
  if (read.error || read.status !== 0) throw new Error("EXPORT_OBJECTS_UNREADABLE");
  return read.stdout;
}

/** The export holds exactly the listed files and directories, byte-identical to their blobs. Exported for tests. */
export function verifyExport(exportRoot, files, directories) {
  const walk = (directory, relative) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      const kind = lstatSync(full);
      if (kind.isDirectory()) {
        if (!directories.has(name)) throw new Error("EXPORT_DIFFERS_FROM_HEAD");
        walk(full, name);
      } else if (kind.isFile() && files.has(name)) {
        if (blobId(readFileSync(full)) !== files.get(name)) throw new Error("EXPORT_DIFFERS_FROM_HEAD");
        files.delete(name);
      } else throw new Error("EXPORT_DIFFERS_FROM_HEAD");
    }
  };
  walk(exportRoot, "");
  if (files.size) throw new Error("EXPORT_DIFFERS_FROM_HEAD");
}

/**
 * What the reporter and the Vitest main process load from the harness checkout: its scripts, package.json (module type)
 * and tsconfig (compile options). They run from a copy exported from the harness's own HEAD, so the working tree there
 * (edited, assume-unchanged, skip-worktree, untracked or shadowing files, line endings) never takes part. .npmrc, the pnpm
 * workspace files and lockfiles are install-time inputs that Vitest does not read, and node_modules stays a trusted
 * environment.
 */
export const isHarnessFile = file => file.startsWith("scripts/") || /^(package\.json|tsconfig[^/]*\.json)$/.test(file);

/** Detach one dependency link without following it. @returns {boolean} true when it is gone */
function detachLink(link) {
  try { rmdirSync(link); } catch { try { unlinkSync(link); } catch { /* checked next */ } }
  return !lstatSync(link, { throwIfNoEntry: false });
}

function linkModules(from, into) {
  const modules = path.join(from, "node_modules");
  if (lstatSync(modules, { throwIfNoEntry: false })) symlinkSync(realpathSync(modules), path.join(into, "node_modules"), "junction");
}

/**
 * Everything Vitest runs comes from commit objects, never from a working tree: the source's HEAD into `tree`, and the
 * harness's own HEAD (scripts only) into `harness`. Ignored, assume-unchanged, skip-worktree or hidden-untracked files
 * cannot take part. Installed dependencies are reached through links to each checkout's own node_modules.
 */
function exportCommitted(root, harnessRoot, head, receipt, detach) {
  const parent = realpathSync(tmpdir());
  // Before creating anything, so a TEMP/TMP/TMPDIR inside the checkout leaves nothing behind.
  if (!isOutside(root, parent)) throw new Error("EXPORT_MUST_BE_OUTSIDE_SOURCE");
  const area = mkdtempSync(path.join(parent, "autoflow-export-"));
  try {
    if (!isOutside(root, realpathSync(area))) throw new Error("EXPORT_MUST_BE_OUTSIDE_SOURCE");
    const harness = path.join(area, "harness");
    mkdirSync(harness);
    let harnessHead;
    try {
      if (!sameFileName(realpathSync(git(harnessRoot, ["rev-parse", "--show-toplevel"]).trim()), realpathSync(harnessRoot))) throw new Error("HARNESS_UNVERIFIED");
      harnessHead = git(harnessRoot, ["rev-parse", "HEAD"]).trim();
    } catch {
      throw new Error("HARNESS_UNVERIFIED");
    }
    writeCommittedTree(harnessRoot, harnessHead, harness, isHarnessFile);
    if (!existsSync(path.join(harness, "scripts/regression/localExecutionReporter.ts"))) throw new Error("HARNESS_UNVERIFIED");
    // The files this process is running from must be the harness HEAD's own bytes, whatever git status says.
    const closureMatchesHead = RUNNING_FILES.every(file => {
      const committed = path.join(harness, file);
      return existsSync(committed) && matchesHead(readFileSync(path.join(implementationRoot, file)), readFileSync(committed));
    });
    receipt.harness = { head: harnessHead, closureMatchesHead };
    if (!closureMatchesHead) throw new Error("HARNESS_NOT_COMMITTED");
    linkModules(harnessRoot, harness);
    const exportRoot = path.join(area, "tree");
    mkdirSync(exportRoot);
    writeCommittedTree(root, head, exportRoot);
    linkModules(root, exportRoot);
    return { area, exportRoot, harness };
  } catch (error) {
    cleanUp(area, detach, receipt);
    throw error;
  }
}

/**
 * Detach each dependency link first: a recursive delete must never follow one into a real node_modules. If a link cannot
 * be detached, every other entry is still removed and only the links are left. Exported for tests.
 * @param {string} area
 * @param {(link: string) => boolean} [detach] returns true when the link is gone
 * @returns {boolean} true when nothing of the export remains
 */
export function removeExport(area, detach = detachLink) {
  const parts = ["tree", "harness"].map(name => path.join(area, name));
  let complete = true;
  for (const part of parts) {
    const link = path.join(part, "node_modules");
    if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() && !detach(link)) complete = false;
  }
  if (complete) {
    rmSync(area, { recursive: true, force: true });
    return true;
  }
  for (const part of parts) {
    if (!existsSync(part)) continue;
    for (const name of readdirSync(part)) if (name !== "node_modules") rmSync(path.join(part, name), { recursive: true, force: true });
  }
  return false;
}

/** A cleanup that throws did not finish: it counts as incomplete and the verdict is FAIL, never the earlier PASS. */
function cleanUp(area, detach, receipt) {
  let complete = false;
  try {
    complete = removeExport(area, detach);
  } catch {
    complete = false;
  }
  if (!complete) {
    receipt.issues.push("EXPORT_CLEANUP_INCOMPLETE");
    receipt.verdict = "FAIL";
  }
}

/** The files of this checkout that the CLI process itself loads; they are not part of any export. */
const RUNNING_FILES = ["scripts/regression/runLocalExecution.mjs", "scripts/trustedGit.mjs"];

/**
 * Whether a working-tree file is the committed file. Equal bytes match. A committed file with no CR also matches its
 * whole-file LF to CRLF conversion, which is what autocrlf checkouts produce; doubled CRs, mixed endings and any
 * committed CR are compared byte for byte. Exported for tests.
 * @param {Buffer} working
 * @param {Buffer} committed
 */
export function matchesHead(working, committed) {
  if (working.equals(committed)) return true;
  return !committed.includes(13) && working.equals(Buffer.from(committed.toString("latin1").replace(/\n/g, "\r\n"), "latin1"));
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

function measureExecution({ root, scenarioId, base, harnessRoot, detach }, receipt) {
  selectBinding(root, scenarioId);
  // Fail closed on visible uncommitted edits too: a verdict about HEAD must not be read as one about the edited tree.
  if (receipt.source.before.dirty) throw new Error("SOURCE_NOT_COMMITTED");
  const { area, exportRoot, harness } = exportCommitted(root, harnessRoot, receipt.source.before.head, receipt, detach);
  try {
    runExported({ root, exportRoot, harness, harnessRoot, scenarioId, base }, receipt);
  } finally {
    // Also on a throw: an incomplete cleanup is a failure whatever else went wrong.
    cleanUp(area, detach, receipt);
  }
}

function runExported({ root, exportRoot, harness, harnessRoot, scenarioId, base }, receipt) {
  const { binding, testFile } = selectBinding(exportRoot, scenarioId);
  const config = exportedConfig(exportRoot);
  const exportedBefore = observeExport(exportRoot);
  receipt.execution = { from: "HEAD_EXPORT" };
  const escapedName = binding.testName.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const pattern = `^${escapedName}$`;
  // The report returns on an extra pipe (fd 3) that only the Vitest main process holds. Forked workers, where the
  // candidate's tests run, do not inherit it, and no file path is trusted: nothing the child can write on disk is read.
  const child = spawnSync(process.execPath, [path.join(harnessRoot, "node_modules/vitest/vitest.mjs"), "run", testFile,
    "--root", exportRoot, ...(config ? ["--config", path.join(exportRoot, config)] : []), "--pool=forks", "--maxWorkers=1", "--no-file-parallelism", "--retry=0", "-t", pattern,
    "--reporter", path.join(harness, "scripts/regression/localExecutionReporter.ts")],
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
 * The host, not a CLI argument, selects the source root: the launcher's working directory. A trusted embedding caller
 * may also name the harness checkout (default: the checkout this file lives in) and a link detacher (cleanup seam).
 * @param {string} [cwd]
 * @returns {{ root: string, evidenceDirectory: string | null, harnessRoot?: string, detachLink?: (link: string) => boolean }}
 */
export function createHostContext(cwd = process.cwd()) {
  return { root: cwd, evidenceDirectory: null };
}

/**
 * The file this call just created must not survive a refused invocation, least of all inside the source tree.
 * Remove it only while the path still names that very file (same device and inode as the descriptor's stat); a
 * replacement is not ours to delete.
 * @returns {boolean} whether the path was removed
 */
export function removeCreatedFile(output, created) {
  const now = lstatSync(output, { bigint: true, throwIfNoEntry: false });
  if (!now || now.dev !== created.dev || now.ino !== created.ino) return false;
  try { unlinkSync(output); return true; } catch { return false; }
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
    removeCreatedFile(output, created);
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
    measureExecution({ root, scenarioId, base, harnessRoot: realpathSync(context.harnessRoot ?? implementationRoot), detach: context.detachLink }, receipt);
  } catch (error) {
    receipt.issues.push(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "LOCAL_EXECUTION_UNAVAILABLE");
    // Whatever threw, a run that did not finish cleanly is never a PASS.
    if (receipt.verdict === "PASS") receipt.verdict = "FAIL";
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
