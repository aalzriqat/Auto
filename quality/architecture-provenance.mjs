import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function edgeKey(edge) {
  return `${edge.from}\u0000${edge.to}`;
}

function displayEdge(edge) {
  return `${edge.from} -> ${edge.to}`;
}

function compareText(left, right) {
  return left.localeCompare(right, "en");
}

function canonicalBaselineEdge(candidate, normalizePath) {
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError("Every architecture baseline edge must be an object.");
  }
  return {
    from: normalizePath(candidate.from),
    to: normalizePath(candidate.to),
  };
}

function uniqueSorted(entries, identity, label) {
  const identities = entries.map(identity);
  if (new Set(identities).size !== identities.length) {
    throw new Error(
      `Architecture baseline contains duplicate ${label} after path normalization.`,
    );
  }
  return entries.sort((left, right) =>
    compareText(identity(left), identity(right)),
  );
}

export function canonicalizeArchitectureBaseline(candidate, normalizePath) {
  if (typeof normalizePath !== "function") {
    throw new TypeError(
      "Architecture baseline canonicalization requires a path normalizer.",
    );
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError("Architecture baseline must be a JSON object.");
  }
  if (candidate.version !== 1) {
    throw new Error("Architecture baseline version must be 1.");
  }
  if (!/^[0-9a-f]{40}$/iu.test(candidate.sourceCommit ?? "")) {
    throw new Error(
      "Architecture baseline sourceCommit must be a full 40-character Git SHA.",
    );
  }
  if (
    typeof candidate.engineVersion !== "string" ||
    candidate.engineVersion.trim() === ""
  ) {
    throw new Error(
      "Architecture baseline engineVersion must be a non-empty string.",
    );
  }
  if (
    !Array.isArray(candidate.cyclicModules) ||
    !Array.isArray(candidate.cyclicEdges)
  ) {
    throw new Error(
      "Architecture baseline must contain cyclicModules and cyclicEdges arrays.",
    );
  }

  const cyclicModules = uniqueSorted(
    candidate.cyclicModules.map((modulePath) => normalizePath(modulePath)),
    (modulePath) => modulePath,
    "cyclic module paths",
  );
  const cyclicEdges = uniqueSorted(
    candidate.cyclicEdges.map((edge) =>
      canonicalBaselineEdge(edge, normalizePath),
    ),
    edgeKey,
    "cyclic edges",
  );
  const moduleSet = new Set(cyclicModules);
  const orphanEdge = cyclicEdges.find(
    (edge) => !moduleSet.has(edge.from) || !moduleSet.has(edge.to),
  );
  if (orphanEdge) {
    throw new Error(
      `Architecture baseline edge has an endpoint outside cyclicModules: ${displayEdge(orphanEdge)}`,
    );
  }

  return {
    version: 1,
    sourceCommit: candidate.sourceCommit.toLowerCase(),
    engineVersion: candidate.engineVersion,
    cyclicModules,
    cyclicEdges,
  };
}

export async function runArchitectureGit(rootDir, arguments_) {
  try {
    const result = await execFileAsync("git", arguments_, {
      cwd: resolve(rootDir),
      encoding: "utf8",
      windowsHide: true,
    });
    return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    return {
      exitCode: typeof error?.code === "number" ? error.code : null,
      stderr: String(error?.stderr ?? error?.message ?? "Unknown Git error"),
      stdout: String(error?.stdout ?? ""),
    };
  }
}

function gitFailure(command, result) {
  const detail =
    String(result.stderr ?? "").trim() ||
    `Git exited with code ${String(result.exitCode)}.`;
  return new Error(
    `BASELINE PROVENANCE ERROR\nGit could not run ${command}: ${detail}`,
  );
}

function resolvedCommit(result, label) {
  const commit = String(result.stdout ?? "")
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error(
      `BASELINE PROVENANCE ERROR\nGit did not resolve ${label} to a full commit SHA.`,
    );
  }
  return commit;
}

function normalizeGitPath(inputPath) {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new TypeError("Architecture baseline path must be non-empty.");
  }
  const slashPath = inputPath.trim().replaceAll("\\", "/");
  const segments = slashPath.split("/");
  if (
    slashPath.startsWith("/") ||
    /^[A-Za-z]:/u.test(slashPath) ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(
      `Architecture baseline path must be repository-relative: ${inputPath}`,
    );
  }
  return segments.join("/");
}

export async function readOriginMainArchitectureBaseline({
  rootDir,
  baselinePath,
  originMainCommit = "origin/main",
  executeGit = runArchitectureGit,
}) {
  const gitPath = normalizeGitPath(baselinePath);
  const treeResult = await executeGit(rootDir, [
    "ls-tree",
    "-z",
    "--full-tree",
    originMainCommit,
    "--",
    gitPath,
  ]);
  if (treeResult.exitCode !== 0) {
    throw gitFailure(`ls-tree ${originMainCommit} -- ${gitPath}`, treeResult);
  }
  if (treeResult.stdout === "") return null;
  if (!treeResult.stdout.endsWith(`\t${gitPath}\0`)) {
    throw new Error(
      `BASELINE PROVENANCE ERROR\norigin/main returned an ambiguous architecture baseline path for ${gitPath}.`,
    );
  }

  const showResult = await executeGit(rootDir, [
    "show",
    `${originMainCommit}:${gitPath}`,
  ]);
  if (showResult.exitCode !== 0) {
    throw gitFailure(`show ${originMainCommit}:${gitPath}`, showResult);
  }
  try {
    return JSON.parse(showResult.stdout);
  } catch (error) {
    throw new Error(
      `BASELINE PROVENANCE ERROR\nThe architecture baseline on origin/main is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function validateBaselineProvenance({
  rootDir,
  sourceCommit,
  executeGit = runArchitectureGit,
}) {
  if (!/^[0-9a-f]{40}$/iu.test(sourceCommit ?? "")) {
    throw new Error(
      "BASELINE PROVENANCE ERROR\nsourceCommit must be a full 40-character Git SHA.",
    );
  }

  const shallowResult = await executeGit(rootDir, [
    "rev-parse",
    "--is-shallow-repository",
  ]);
  if (shallowResult.exitCode !== 0) {
    throw gitFailure("rev-parse --is-shallow-repository", shallowResult);
  }
  if (shallowResult.stdout.trim() === "true") {
    throw new Error(
      "BASELINE PROVENANCE ERROR\nArchitecture provenance requires full Git history, but this clone is shallow. Use checkout fetch-depth: 0 or fetch the complete history before running the guard.",
    );
  }

  const commitResult = await executeGit(rootDir, [
    "cat-file",
    "-e",
    `${sourceCommit}^{commit}`,
  ]);
  if (commitResult.exitCode !== 0) {
    throw new Error(
      `BASELINE PROVENANCE ERROR\nBaseline sourceCommit ${sourceCommit} is not available as a commit. Fetch the complete origin history or repair the baseline provenance.`,
    );
  }

  const mainResult = await executeGit(rootDir, [
    "rev-parse",
    "--verify",
    "--quiet",
    "origin/main^{commit}",
  ]);
  if (mainResult.exitCode !== 0) {
    throw new Error(
      "BASELINE PROVENANCE ERROR\nRequired ref origin/main is unavailable. Fetch origin/main before running the architecture guard.",
    );
  }
  const originMainCommit = resolvedCommit(mainResult, "origin/main");

  const ancestorResult = await executeGit(rootDir, [
    "merge-base",
    "--is-ancestor",
    sourceCommit,
    originMainCommit,
  ]);
  if (ancestorResult.exitCode === 1) {
    throw new Error(
      `BASELINE PROVENANCE ERROR\nBaseline sourceCommit ${sourceCommit} is not an ancestor of origin/main. Re-audit the baseline from origin/main history.`,
    );
  }
  if (ancestorResult.exitCode !== 0) {
    throw gitFailure("merge-base --is-ancestor", ancestorResult);
  }

  const headResult = await executeGit(rootDir, [
    "rev-parse",
    "--verify",
    "--quiet",
    "HEAD^{commit}",
  ]);
  if (headResult.exitCode !== 0) {
    throw new Error(
      "BASELINE PROVENANCE ERROR\nRequired ref HEAD is unavailable. Check out the commit under test before running the architecture guard.",
    );
  }

  const headAncestorResult = await executeGit(rootDir, [
    "merge-base",
    "--is-ancestor",
    sourceCommit,
    "HEAD",
  ]);
  if (headAncestorResult.exitCode === 1) {
    throw new Error(
      `BASELINE PROVENANCE ERROR\nBaseline sourceCommit ${sourceCommit} is not an ancestor of HEAD. The baseline cannot come from an unrelated or branch-only history.`,
    );
  }
  if (headAncestorResult.exitCode !== 0) {
    throw gitFailure(
      "merge-base --is-ancestor sourceCommit HEAD",
      headAncestorResult,
    );
  }

  return originMainCommit;
}
