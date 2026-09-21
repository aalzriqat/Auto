import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
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

async function materializeEntry({
  sourcePath,
  destinationPath,
  candidateBoundary,
  ancestry,
  budget,
  depth = 0,
}) {
  if (depth > MAX_BROWSER_BUILD_DEPTH) {
    throw new Error("Candidate build exceeds the maximum runtime directory depth.");
  }
  budget.entries += 1;
  if (budget.entries > MAX_BROWSER_BUILD_ENTRIES) {
    throw new Error("Candidate build exceeds the maximum runtime entry count.");
  }
  const sourceReal = await realpath(sourcePath);
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

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function collectRuntimeRecords(runtimeRoot) {
  const records = [];
  let totalBytes = 0;
  let totalEntries = 0;

  async function walk(currentRoot, relativeRoot = "", depth = 0) {
    if (depth > MAX_BROWSER_BUILD_DEPTH) {
      throw new Error("Candidate artifact exceeds the maximum runtime directory depth.");
    }
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

  await materializeEntry({
    sourcePath: standaloneRoot,
    destinationPath: runtimeRoot,
    candidateBoundary,
    ancestry: new Set(),
    budget,
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
