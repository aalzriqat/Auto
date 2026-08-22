import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runArchitectureGit } from "./architecture-provenance.mjs";

const execFileAsync = promisify(execFile);
const SNAPSHOT_WORKER = fileURLToPath(
  new URL("./architecture-source-worker.mjs", import.meta.url),
);

function gitWorktreeError(operation, result) {
  const detail =
    String(result.stderr ?? "").trim() ||
    `Git exited with code ${String(result.exitCode)}.`;
  return new Error(
    `ARCHITECTURE SOURCE SNAPSHOT ERROR\nGit could not ${operation}: ${detail}`,
  );
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function createWorkspaceLinks(checkoutDir) {
  const sharedPackage = resolve(checkoutDir, "packages/shared");
  if (!(await isDirectory(sharedPackage))) return;

  const packageScope = resolve(checkoutDir, "node_modules/@autoflow");
  await mkdir(packageScope, { recursive: true });
  await symlink(
    sharedPackage,
    resolve(packageScope, "shared"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

export async function runArchitectureSnapshotWorker({
  checkoutDir,
  entryPoints,
}) {
  try {
    const arguments_ = [SNAPSHOT_WORKER];
    if (entryPoints) arguments_.push(JSON.stringify(entryPoints));
    const result = await execFileAsync(process.execPath, arguments_, {
      cwd: resolve(checkoutDir),
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    return JSON.parse(result.stdout);
  } catch (error) {
    const detail =
      String(error?.stderr ?? "").trim() ||
      String(error?.message ?? "Unknown source snapshot worker error");
    throw new Error(
      `ARCHITECTURE SOURCE SNAPSHOT ERROR\nThe isolated dependency scan failed: ${detail}`,
      { cause: error },
    );
  }
}

export async function inspectArchitectureSourceCommit({
  rootDir,
  sourceCommit,
  inspect,
  executeGit = runArchitectureGit,
  prepareCheckout = createWorkspaceLinks,
}) {
  if (!/^[0-9a-f]{40}$/iu.test(sourceCommit ?? "")) {
    throw new Error(
      "ARCHITECTURE SOURCE SNAPSHOT ERROR\nsourceCommit must be a full 40-character Git SHA.",
    );
  }
  if (typeof inspect !== "function") {
    throw new TypeError("Architecture source inspection requires a callback.");
  }

  const repositoryRoot = resolve(rootDir);
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "autoflow-architecture-source-"),
  );
  const checkoutDir = resolve(temporaryRoot, "checkout");
  const addResult = await executeGit(repositoryRoot, [
    "-c",
    "core.longpaths=true",
    "worktree",
    "add",
    "--detach",
    checkoutDir,
    sourceCommit,
  ]);

  if (addResult.exitCode !== 0) {
    await rm(temporaryRoot, { force: true, recursive: true });
    throw gitWorktreeError("materialize the baseline source commit", addResult);
  }

  let inspectionResult;
  let inspectionError;
  try {
    await prepareCheckout(checkoutDir);
    inspectionResult = await inspect(checkoutDir);
  } catch (error) {
    inspectionError = error;
  }

  const removeResult = await executeGit(repositoryRoot, [
    "worktree",
    "remove",
    "--force",
    checkoutDir,
  ]);
  await rm(temporaryRoot, { force: true, recursive: true });

  if (removeResult.exitCode !== 0) {
    const cleanupError = gitWorktreeError(
      "remove the temporary baseline worktree",
      removeResult,
    );
    if (inspectionError) {
      throw new AggregateError(
        [inspectionError, cleanupError],
        "Architecture source inspection and cleanup both failed.",
      );
    }
    throw cleanupError;
  }
  if (inspectionError) throw inspectionError;
  return inspectionResult;
}

export async function readArchitectureSourceSnapshot(options) {
  return inspectArchitectureSourceCommit({
    ...options,
    inspect: (checkoutDir) => runArchitectureSnapshotWorker({ checkoutDir }),
  });
}
