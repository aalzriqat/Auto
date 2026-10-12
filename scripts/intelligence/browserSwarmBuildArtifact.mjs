import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUILD_MANIFEST_FILE = "browser-swarm-candidate-build.json";
export const MAX_BROWSER_BUILD_FILES = 30_000;
export const MAX_BROWSER_BUILD_ENTRIES = 45_000;
export const MAX_BROWSER_BUILD_DEPTH = 64;
export const MAX_BROWSER_BUILD_BYTES = 512 * 1024 * 1024;
export const MAX_BROWSER_BUILD_MANIFEST_BYTES = 8 * 1024 * 1024;

const MANIFEST_AUTHORITY = "TRUSTED_BROWSER_SWARM_CANDIDATE_BUILD";
const BUILD_MODE = "FRESH_EXACT_SHA_STANDALONE";
const SHA_RE = /^[0-9a-f]{40}$/i;
const DIGEST_RE = /^[0-9a-f]{64}$/;

function exactSha(value, label) {
  if (typeof value !== "string" || !SHA_RE.test(value)) {
    throw new Error(label + " must be an exact 40-character commit SHA.");
  }
  return value.toLowerCase();
}

function positivePrNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("prNumber must be a positive safe integer.");
  }
  return number;
}

function safeRunId(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,80}$/.test(value)
  ) {
    throw new Error("runId must be a lowercase safe identifier.");
  }
  return value;
}

function safePreviewName(value) {
  if (
    typeof value !== "string" ||
    !/^e2e-[a-z0-9][a-z0-9._-]{0,56}$/.test(value)
  ) {
    throw new Error("previewName must be an explicit e2e-* preview identifier.");
  }
  return value;
}

function convexOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value ?? "");
  } catch {
    throw new Error("convexCloudUrl must be a valid URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    !/^[a-z0-9-]+\.convex\.cloud$/.test(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("convexCloudUrl must be a bare HTTPS convex.cloud origin.");
  }
  return parsed.origin;
}

function normalizeIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Candidate build identity must be an object.");
  }
  const identity = value;
  const allowed = new Set([
    "baseSha",
    "headSha",
    "testedSha",
    "controllerSha",
    "prNumber",
    "runId",
    "previewName",
    "convexCloudUrl",
  ]);
  const keys = Object.keys(identity);
  if (keys.some((key) => !allowed.has(key)) || keys.length !== allowed.size) {
    throw new Error("Candidate build identity contains unexpected or missing fields.");
  }
  return {
    baseSha: exactSha(identity.baseSha, "baseSha"),
    headSha: exactSha(identity.headSha, "headSha"),
    testedSha: exactSha(identity.testedSha, "testedSha"),
    controllerSha: exactSha(identity.controllerSha, "controllerSha"),
    prNumber: positivePrNumber(identity.prNumber),
    runId: safeRunId(identity.runId),
    previewName: safePreviewName(identity.previewName),
    convexCloudUrl: convexOrigin(identity.convexCloudUrl),
  };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function safeRelativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.includes("\0")
  ) {
    throw new Error("Artifact file path is unsafe.");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Artifact file path is unsafe.");
  }
  return value;
}

const PNPM_PACKAGE_NAME_RE = /^[a-z0-9_~-][a-z0-9._~-]*$/i;
const PNPM_SCOPE_NAME_RE = /^@[a-z0-9_~-][a-z0-9._~-]*$/i;

/**
 * Locate pnpm's hoist index (.pnpm/node_modules) and its virtual store (.pnpm)
 * inside the standalone tree. Both must be real directories inside the
 * candidate root, and the index must sit directly in the store; otherwise no
 * dangling-link exception exists at all.
 */
async function resolvePnpmHoistIndex(standaloneRoot, candidateBoundary) {
  const storePath = path.join(standaloneRoot, "node_modules", ".pnpm");
  // lstat: a symlinked .pnpm is not a directory, so a forged store never qualifies.
  if (!(await lstat(storePath).catch(() => null))?.isDirectory()) return null;
  const store = await realpath(storePath).catch(() => null);
  if (!store || !isInside(candidateBoundary, store)) return null;
  const root = await realpath(path.join(store, "node_modules")).catch(() => null);
  if (root !== path.join(store, "node_modules")) return null;
  return { root, store };
}

/**
 * SCRUM-824 (owner ruling c22957). Next's tracer can copy a pnpm hoist-index
 * link without its target when the package was judged unneeded (PR #531:
 * debug's optional supports-color). Such a link may be omitted only when it is
 * a symlink, sits directly in the hoist index (or one @scope below it), has a
 * relative target that stays inside the virtual store and outside the index,
 * and that target genuinely does not exist. A realpath ENOENT alone is never
 * enough; every other dangling, escaping, chained or looping link is refused.
 */
export async function isAllowedDanglingHoistLink(sourcePath, hoistIndex) {
  if (!hoistIndex) return false;
  const info = await lstat(sourcePath).catch(() => null);
  if (!info?.isSymbolicLink()) return false;
  if (!PNPM_PACKAGE_NAME_RE.test(path.basename(sourcePath))) return false;
  const parentReal = await realpath(path.dirname(sourcePath)).catch(() => null);
  if (!parentReal) return false;
  const inIndex = parentReal === hoistIndex.root;
  const inScope =
    path.dirname(parentReal) === hoistIndex.root &&
    PNPM_SCOPE_NAME_RE.test(path.basename(parentReal));
  if (!inIndex && !inScope) return false;
  const target = await readlink(sourcePath).catch(() => null);
  if (typeof target !== "string" || !target || target.includes("\0") || path.isAbsolute(target)) {
    return false;
  }
  // Only pnpm's canonical shape is accepted:
  //   ../<store-dir>/node_modules/<name>                 (index leaf)
  //   ../../<store-dir>/node_modules/@scope/<name>       (scoped leaf)
  // No other "..", ".", or empty segment, and the name must match the link.
  // path.resolve cancels "x/.." lexically while the kernel follows x first, so
  // any further ".." could leave the store through a symlink and come back.
  const segments = target.split("/");
  const ups = inScope ? 2 : 1;
  const linkName = inScope
    ? [path.basename(parentReal), path.basename(sourcePath)]
    : [path.basename(sourcePath)];
  if (segments.length !== ups + 2 + linkName.length) return false;
  if (segments.slice(0, ups).some((segment) => segment !== "..")) return false;
  const storeDir = segments[ups];
  if (!storeDir || storeDir === "." || storeDir === ".." || storeDir === "node_modules") {
    return false;
  }
  if (segments[ups + 1] !== "node_modules") return false;
  if (segments.slice(ups + 2).join("/") !== linkName.join("/")) return false;
  const resolved = path.resolve(parentReal, target);
  if (!isInside(hoistIndex.store, resolved) || isInside(hoistIndex.root, resolved)) {
    return false;
  }
  const targetState = await lstat(resolved).then(
    () => "present",
    (error) => (error?.code === "ENOENT" ? "absent" : "unreadable"),
  );
  if (targetState !== "absent") return false;
  // path.resolve is lexical, but the kernel follows symlinked components. The
  // nearest existing ancestor of the target must be its own realpath, so no
  // component between the store and the target can redirect it elsewhere.
  let existing = path.dirname(resolved);
  for (;;) {
    if (!isInside(hoistIndex.store, existing)) return false;
    const state = await lstat(existing).then(
      () => "present",
      (error) => (error?.code === "ENOENT" ? "absent" : "unreadable"),
    );
    if (state === "unreadable") return false;
    if (state === "present") break;
    existing = path.dirname(existing);
  }
  return (await realpath(existing).catch(() => null)) === existing;
}

async function materializeEntry({
  sourcePath,
  destinationPath,
  candidateBoundary,
  ancestry,
  budget,
  hoistIndex = null,
  depth = 0,
}) {
  if (depth > MAX_BROWSER_BUILD_DEPTH) {
    throw new Error("Candidate build exceeds the maximum runtime directory depth.");
  }
  budget.entries += 1;
  if (budget.entries > MAX_BROWSER_BUILD_ENTRIES) {
    throw new Error("Candidate build exceeds the maximum runtime entry count.");
  }
  let sourceReal;
  try {
    sourceReal = await realpath(sourcePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (await isAllowedDanglingHoistLink(sourcePath, hoistIndex)) {
      process.stderr.write(
        "Omitted dangling pnpm hoist-index link: " +
          path.relative(candidateBoundary, sourcePath) +
          "\n",
      );
      return;
    }
    if ((await lstat(sourcePath).catch(() => null))?.isSymbolicLink()) {
      throw new Error(
        "Candidate build contains a dangling symlink that is not a pnpm hoist-index link; refusing artifact materialization: " +
          path.relative(candidateBoundary, sourcePath),
      );
    }
    throw error;
  }
  if (!isInside(candidateBoundary, sourceReal)) {
    throw new Error(
      "Candidate build symlink or path escapes candidate root; refusing artifact materialization.",
    );
  }

  const info = await stat(sourceReal);
  if (info.isDirectory()) {
    if (ancestry.has(sourceReal)) {
      throw new Error("Candidate build contains a directory/symlink cycle.");
    }
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(sourceReal);
    await mkdir(destinationPath, { recursive: true });
    const entries = (await readdir(sourceReal)).sort((left, right) =>
      left.localeCompare(right),
    );
    for (const name of entries) {
      await materializeEntry({
        sourcePath: path.join(sourceReal, name),
        destinationPath: path.join(destinationPath, name),
        candidateBoundary,
        ancestry: nextAncestry,
        budget,
        hoistIndex,
        depth: depth + 1,
      });
    }
    return;
  }

  if (!info.isFile()) {
    throw new Error("Candidate build contains a non-regular runtime entry.");
  }

  budget.files += 1;
  budget.bytes += info.size;
  if (budget.files > MAX_BROWSER_BUILD_FILES) {
    throw new Error("Candidate build exceeds the maximum runtime file count.");
  }
  if (budget.bytes > MAX_BROWSER_BUILD_BYTES) {
    throw new Error("Candidate build exceeds the maximum runtime byte size.");
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  await copyFile(sourceReal, destinationPath);
  await chmod(destinationPath, info.mode & 0o777);
}

/**
 * Explicit UTF-16 code-unit comparator (Sonar S2871). Deliberately not
 * localeCompare: that reorders mixed-case names relative to the default sort
 * this replaced, which would change the pnpm hoist copy order.
 */
export const byCodeUnit = (a, b) => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/**
 * pnpm's node_modules holds symlinks, and each real package keeps its own
 * dependencies as siblings inside the virtual store. Materializing the links as
 * copies strands those siblings, so `node server.js` dies on its first require
 * (a real run failed on @swc/helpers). pnpm lists every package that was not
 * linked at the top under node_modules/.pnpm/node_modules; copy each one that
 * has no top-level counterpart so ordinary resolution finds it. Existing
 * top-level packages are never replaced, and every copy goes through the same
 * boundary and budget checks as the rest of the tree.
 */
async function hoistPnpmVirtualStore({
  standaloneRoot,
  runtimeRoot,
  candidateBoundary,
  budget,
  hoistIndex,
}) {
  const hoistRoot = path.join(standaloneRoot, "node_modules", ".pnpm", "node_modules");
  const names = await readdir(hoistRoot).catch(() => []);
  const copyIfMissing = async (relative) => {
    const destinationPath = path.join(runtimeRoot, "node_modules", relative);
    if (await lstat(destinationPath).catch(() => null)) return;
    await materializeEntry({
      sourcePath: path.join(hoistRoot, relative),
      destinationPath,
      candidateBoundary,
      ancestry: new Set(),
      budget,
      hoistIndex,
    });
  };
  // Expand each scope directory in place so the copy order stays: sorted
  // top-level names, with a scope's sorted children at the scope's position.
  const expand = async (name) => {
    if (!name.startsWith("@")) return [name];
    const scoped = await readdir(path.join(hoistRoot, name)).catch(() => []);
    return scoped.sort(byCodeUnit).map((child) => path.join(name, child));
  };
  const relatives = (
    await Promise.all(
      names
        .filter((name) => !name.startsWith("."))
        .sort(byCodeUnit)
        .map(expand),
    )
  ).flat();
  // Copies share one budget, so they must run one at a time and in order.
  await relatives.reduce(
    (previous, relative) => previous.then(() => copyIfMissing(relative)),
    Promise.resolve(),
  );
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function assertRuntimeTraversalDepth(depth) {
  if (depth > MAX_BROWSER_BUILD_DEPTH) {
    throw new Error("Candidate artifact exceeds the maximum runtime directory depth.");
  }
}

async function collectRuntimeRecords(runtimeRoot) {
  const records = [];
  let totalBytes = 0;
  let totalEntries = 0;

  async function walk(currentRoot, relativeRoot = "", depth = 0) {
    assertRuntimeTraversalDepth(depth);
    const entries = (await readdir(currentRoot, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      totalEntries += 1;
      if (totalEntries > MAX_BROWSER_BUILD_ENTRIES) {
        throw new Error("Candidate artifact exceeds the maximum runtime entry count.");
      }
      const absolute = path.join(currentRoot, entry.name);
      const relative = relativeRoot
        ? relativeRoot + "/" + entry.name
        : entry.name;
      safeRelativePath(relative);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        throw new Error("Materialized candidate artifact must not contain symlinks.");
      }
      if (info.isDirectory()) {
        await walk(absolute, relative, depth + 1);
        continue;
      }
      if (!info.isFile()) {
        throw new Error("Materialized candidate artifact contains a non-regular entry.");
      }
      totalBytes += info.size;
      if (records.length + 1 > MAX_BROWSER_BUILD_FILES) {
        throw new Error("Candidate artifact exceeds the maximum runtime file count.");
      }
      if (totalBytes > MAX_BROWSER_BUILD_BYTES) {
        throw new Error("Candidate artifact exceeds the maximum runtime byte size.");
      }
      records.push({
        path: relative,
        size: info.size,
        sha256: await hashFile(absolute),
      });
    }
  }

  await walk(runtimeRoot);
  records.sort((left, right) => left.path.localeCompare(right.path));
  return { records, totalBytes };
}

function rootDigest(records) {
  const hash = createHash("sha256");
  for (const record of records) {
    hash.update(record.path);
    hash.update("\0");
    hash.update(String(record.size));
    hash.update("\0");
    hash.update(record.sha256);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function assertExactObjectKeys(object, allowed, label) {
  const keys = Object.keys(object);
  if (
    keys.length !== allowed.length ||
    keys.some((key) => !allowed.includes(key))
  ) {
    throw new Error(label + " contains unexpected or missing fields.");
  }
}

function validateFileRecords(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_BROWSER_BUILD_FILES
  ) {
    throw new Error("Candidate build manifest contains an invalid file list.");
  }
  const seen = new Set();
  let total = 0;
  const records = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Candidate build manifest file " + index + " is malformed.");
    }
    assertExactObjectKeys(entry, ["path", "size", "sha256"], "Candidate build file");
    const recordPath = safeRelativePath(entry.path);
    if (seen.has(recordPath)) {
      throw new Error("Candidate build manifest contains duplicate file paths.");
    }
    seen.add(recordPath);
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== "string" ||
      !DIGEST_RE.test(entry.sha256)
    ) {
      throw new Error("Candidate build manifest file metadata is malformed.");
    }
    total += entry.size;
    if (total > MAX_BROWSER_BUILD_BYTES) {
      throw new Error("Candidate build manifest exceeds the maximum runtime byte size.");
    }
    return {
      path: recordPath,
      size: entry.size,
      sha256: entry.sha256,
    };
  });
  return { records, totalBytes: total };
}

function validateManifestShape(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Candidate build manifest must be an object.");
  }
  const manifest = value;
  assertExactObjectKeys(
    manifest,
    [
      "version",
      "authority",
      "buildMode",
      "baseSha",
      "headSha",
      "testedSha",
      "controllerSha",
      "prNumber",
      "runId",
      "previewName",
      "convexCloudUrl",
      "fileCount",
      "totalBytes",
      "rootSha256",
      "files",
    ],
    "Candidate build manifest",
  );

  if (
    manifest.version !== 1 ||
    manifest.authority !== MANIFEST_AUTHORITY ||
    manifest.buildMode !== BUILD_MODE
  ) {
    throw new Error("Candidate build manifest authority metadata is invalid.");
  }

  const identity = normalizeIdentity({
    baseSha: manifest.baseSha,
    headSha: manifest.headSha,
    testedSha: manifest.testedSha,
    controllerSha: manifest.controllerSha,
    prNumber: manifest.prNumber,
    runId: manifest.runId,
    previewName: manifest.previewName,
    convexCloudUrl: manifest.convexCloudUrl,
  });
  const normalizedExpected = normalizeIdentity(expected);
  for (const key of Object.keys(normalizedExpected)) {
    if (identity[key] !== normalizedExpected[key]) {
      throw new Error(
        "Candidate build manifest " + key + " does not match the trusted run.",
      );
    }
  }

  const { records, totalBytes } = validateFileRecords(manifest.files);
  if (
    manifest.fileCount !== records.length ||
    manifest.totalBytes !== totalBytes ||
    typeof manifest.rootSha256 !== "string" ||
    !DIGEST_RE.test(manifest.rootSha256) ||
    manifest.rootSha256 !== rootDigest(records)
  ) {
    throw new Error("Candidate build manifest aggregate digest metadata is invalid.");
  }

  return {
    ...identity,
    version: 1,
    authority: MANIFEST_AUTHORITY,
    buildMode: BUILD_MODE,
    fileCount: records.length,
    totalBytes,
    rootSha256: manifest.rootSha256,
    files: records,
  };
}

export async function createBrowserSwarmBuildArtifact({
  candidateRoot,
  artifactRoot,
  identity,
}) {
  if (!candidateRoot || !artifactRoot) {
    throw new Error("candidateRoot and artifactRoot are required.");
  }
  const normalizedIdentity = normalizeIdentity(identity);
  const candidateBoundary = await realpath(candidateRoot);
  const standaloneRoot = path.join(candidateBoundary, ".next", "standalone");
  const staticRoot = path.join(candidateBoundary, ".next", "static");
  const publicRoot = path.join(candidateBoundary, "public");

  const standaloneInfo = await lstat(standaloneRoot).catch(() => null);
  if (!standaloneInfo) {
    throw new Error(
      "Exact candidate build did not produce .next/standalone; refusing artifact publication.",
    );
  }
  const staticInfo = await lstat(staticRoot).catch(() => null);
  if (!staticInfo) {
    throw new Error(
      "Exact candidate build did not produce .next/static; refusing artifact publication.",
    );
  }

  await rm(artifactRoot, { recursive: true, force: true });
  const runtimeRoot = path.join(artifactRoot, "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const budget = { entries: 0, files: 0, bytes: 0 };
  const hoistIndex = await resolvePnpmHoistIndex(standaloneRoot, candidateBoundary);

  await materializeEntry({
    sourcePath: standaloneRoot,
    destinationPath: runtimeRoot,
    candidateBoundary,
    ancestry: new Set(),
    budget,
    hoistIndex,
  });
  await hoistPnpmVirtualStore({
    standaloneRoot,
    runtimeRoot,
    candidateBoundary,
    budget,
    hoistIndex,
  });

  await rm(path.join(runtimeRoot, ".next", "static"), {
    recursive: true,
    force: true,
  });
  await materializeEntry({
    sourcePath: staticRoot,
    destinationPath: path.join(runtimeRoot, ".next", "static"),
    candidateBoundary,
    ancestry: new Set(),
    budget,
  });

  const publicInfo = await lstat(publicRoot).catch(() => null);
  if (publicInfo) {
    await rm(path.join(runtimeRoot, "public"), { recursive: true, force: true });
    await materializeEntry({
      sourcePath: publicRoot,
      destinationPath: path.join(runtimeRoot, "public"),
      candidateBoundary,
      ancestry: new Set(),
      budget,
    });
  }

  const serverInfo = await lstat(path.join(runtimeRoot, "server.js")).catch(
    () => null,
  );
  if (!serverInfo?.isFile()) {
    throw new Error("Standalone candidate artifact is missing runtime/server.js.");
  }

  const { records, totalBytes } = await collectRuntimeRecords(runtimeRoot);
  const manifest = {
    version: 1,
    authority: MANIFEST_AUTHORITY,
    buildMode: BUILD_MODE,
    ...normalizedIdentity,
    fileCount: records.length,
    totalBytes,
    rootSha256: rootDigest(records),
    files: records,
  };
  await writeFile(
    path.join(artifactRoot, BUILD_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  return manifest;
}

export async function verifyBrowserSwarmBuildArtifact({
  artifactRoot,
  expected,
}) {
  if (!artifactRoot) throw new Error("artifactRoot is required.");

  const rootEntries = (await readdir(artifactRoot).catch(() => [])).sort(
    (left, right) => left.localeCompare(right),
  );
  if (
    rootEntries.length !== 2 ||
    rootEntries[0] !== BUILD_MANIFEST_FILE ||
    rootEntries[1] !== "runtime"
  ) {
    throw new Error(
      "Candidate build artifact is missing its manifest/runtime root or contains an unexpected artifact root entry.",
    );
  }

  const manifestPath = path.join(artifactRoot, BUILD_MANIFEST_FILE);
  const manifestInfo = await lstat(manifestPath).catch(() => null);
  if (!manifestInfo?.isFile()) {
    throw new Error("Candidate build artifact manifest is missing.");
  }
  if (manifestInfo.size > MAX_BROWSER_BUILD_MANIFEST_BYTES) {
    throw new Error("Candidate build artifact manifest exceeds the size limit.");
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("Candidate build artifact manifest is not valid JSON.");
  }
  const manifest = validateManifestShape(parsed, expected);

  const runtimeRoot = path.join(artifactRoot, "runtime");
  const { records, totalBytes } = await collectRuntimeRecords(runtimeRoot);
  if (
    records.length !== manifest.fileCount ||
    totalBytes !== manifest.totalBytes
  ) {
    throw new Error(
      "Candidate build artifact file set, digest, or size is missing, partial, or inconsistent.",
    );
  }
  const expectedByPath = new Map(
    manifest.files.map((record) => [record.path, record]),
  );
  for (const record of records) {
    const expectedRecord = expectedByPath.get(record.path);
    if (!expectedRecord) {
      throw new Error(
        "Candidate build artifact contains a file not present in the trusted manifest.",
      );
    }
    if (
      record.size !== expectedRecord.size ||
      record.sha256 !== expectedRecord.sha256
    ) {
      throw new Error(
        "Candidate build artifact digest or size mismatch for " + record.path + ".",
      );
    }
    expectedByPath.delete(record.path);
  }
  if (expectedByPath.size > 0) {
    throw new Error("Candidate build artifact is missing manifest-declared files.");
  }
  if (rootDigest(records) !== manifest.rootSha256) {
    throw new Error("Candidate build artifact root digest mismatch.");
  }
  return manifest;
}

function identityFromEnv(env) {
  return {
    baseSha: env.BASE_SHA,
    headSha: env.HEAD_SHA,
    testedSha: env.TESTED_SHA,
    controllerSha: env.CONTROLLER_SHA,
    prNumber: env.PR_NUMBER,
    runId: env.BROWSER_SWARM_RUN_ID,
    previewName: env.CONVEX_PREVIEW_NAME,
    convexCloudUrl: env.NEXT_PUBLIC_CONVEX_URL,
  };
}

async function main() {
  const mode = process.argv[2];
  const artifactRoot = process.env.BROWSER_SWARM_BUILD_ARTIFACT_ROOT;
  if (!artifactRoot) {
    throw new Error("BROWSER_SWARM_BUILD_ARTIFACT_ROOT is required.");
  }
  if (mode === "create") {
    const candidateRoot = process.env.CANDIDATE_ROOT;
    if (!candidateRoot) throw new Error("CANDIDATE_ROOT is required.");
    await createBrowserSwarmBuildArtifact({
      candidateRoot,
      artifactRoot,
      identity: identityFromEnv(process.env),
    });
    process.stdout.write("Created exact-SHA browser swarm candidate artifact.\n");
    return;
  }
  if (mode === "verify") {
    await verifyBrowserSwarmBuildArtifact({
      artifactRoot,
      expected: identityFromEnv(process.env),
    });
    process.stdout.write("Verified exact-SHA browser swarm candidate artifact.\n");
    return;
  }
  throw new Error("Usage: browserSwarmBuildArtifact.mjs <create|verify>");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
