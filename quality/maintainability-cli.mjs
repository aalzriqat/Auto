import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import {
  canonicalBaselineText,
  combineRatchetComparisons,
  compareAnalyses,
  createBaseline,
  validateBaselineDocument,
} from "./maintainability-baseline.mjs";
import {
  analyzeSourceEntries,
  debtCounts,
} from "./maintainability-metrics.mjs";
import {
  DEFAULT_BASELINE_PATH,
  isProductionSource,
  normalizedInventory,
} from "./maintainability-paths.mjs";
import {
  NEXT_CONFIG_FILES,
  nextFrameworkRuntimePaths,
  resolveNextPageExtensionsFromInventory,
} from "./autoflow/next-runtime-entries.mjs";

const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(buffer, description) {
  try {
    return utf8Decoder.decode(buffer);
  } catch (error) {
    throw new Error(`${description} is not valid UTF-8.`, { cause: error });
  }
}

function runGit(repositoryRoot, argumentsList, options = {}) {
  const command = spawnSync("git", ["-C", repositoryRoot, ...argumentsList], {
    encoding: null,
    input: options.input,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
  });
  if (command.error) throw command.error;
  if (
    command.status !== 0 &&
    !options.allowedStatuses?.includes(command.status)
  ) {
    const stderr = decodeUtf8(command.stderr, "git stderr").trim();
    throw new Error(`git ${argumentsList.join(" ")} failed: ${stderr}`);
  }
  return command;
}

function nulSeparatedPaths(buffer, description) {
  return decodeUtf8(buffer, description).split("\0").filter(Boolean);
}

export function repositoryRoot(startDirectory = process.cwd()) {
  const command = runGit(startDirectory, ["rev-parse", "--show-toplevel"]);
  return decodeUtf8(command.stdout, "repository root").trim();
}

function safeWorkingTreePath(root, originalPath) {
  const absolutePath = path.resolve(
    root,
    ...originalPath.replaceAll("\\", "/").split("/"),
  );
  const rootPrefix = `${path.resolve(root)}${path.sep}`;
  if (!absolutePath.startsWith(rootPrefix)) {
    throw new Error(`Repository path escapes the worktree: ${originalPath}`);
  }
  return absolutePath;
}

export function analyzeWorkingTree(root = repositoryRoot()) {
  const listed = runGit(root, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const inventory = normalizedInventory(
    nulSeparatedPaths(listed.stdout, "git path inventory"),
  );
  const availableFiles = new Map();
  for (const { originalPath, repositoryPath } of inventory) {
    const absolutePath = safeWorkingTreePath(root, originalPath);
    if (!existsSync(absolutePath)) continue;
    const fileStatus = lstatSync(absolutePath);
    if (!fileStatus.isFile() && !fileStatus.isSymbolicLink()) continue;
    availableFiles.set(repositoryPath, {
      absolutePath,
      fileStatus,
    });
  }
  const pageExtensions = resolveNextPageExtensionsFromInventory({
    inventory: [...availableFiles.keys()],
    readSource: (configPath) => {
      const configFile = availableFiles.get(configPath);
      if (!configFile || configFile.fileStatus.isSymbolicLink()) {
        throw new Error(
          `Next.js configuration must be a regular file: ${configPath}`,
        );
      }
      return decodeUtf8(readFileSync(configFile.absolutePath), configPath);
    },
  });
  const scopeOptions = {
    frameworkRuntimePaths: nextFrameworkRuntimePaths(pageExtensions),
  };
  const entries = [];
  for (const { repositoryPath } of inventory) {
    if (!isProductionSource(repositoryPath, scopeOptions)) continue;
    const availableFile = availableFiles.get(repositoryPath);
    if (!availableFile) continue;
    const { absolutePath, fileStatus } = availableFile;
    if (fileStatus.isSymbolicLink()) {
      throw new Error(
        `Production source may not be a symbolic link: ${repositoryPath}`,
      );
    }
    if (!fileStatus.isFile()) continue;
    entries.push({
      path: repositoryPath,
      source: decodeUtf8(readFileSync(absolutePath), repositoryPath),
    });
  }
  return analyzeSourceEntries(entries, scopeOptions);
}

function resolvedCommitSha(buffer, commitish) {
  const resolved = decodeUtf8(buffer, "resolved commit").trim();
  if (!/^[0-9a-f]{40}$/u.test(resolved)) {
    throw new Error(`Git did not resolve ${commitish} to a full commit SHA.`);
  }
  return resolved;
}

export function resolveCommit(root, commitish) {
  const command = runGit(root, [
    "rev-parse",
    "--verify",
    `${commitish}^{commit}`,
  ]);
  return resolvedCommitSha(command.stdout, commitish);
}

function commitBlobEntries(root, sourceCommit, included) {
  if (!included.length) return [];

  const batchInput = included
    .map(({ originalPath }) => `${sourceCommit}:${originalPath}\n`)
    .join("");
  const output = runGit(root, ["cat-file", "--batch"], {
    input: batchInput,
  }).stdout;
  const entries = [];
  let offset = 0;
  for (const { repositoryPath } of included) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0)
      throw new Error(`Missing git object header for ${repositoryPath}`);
    const header = decodeUtf8(
      output.subarray(offset, headerEnd),
      "git object header",
    );
    const match = /^[0-9a-f]+ blob ([0-9]+)$/u.exec(header);
    if (!match) {
      throw new Error(
        `Unexpected git object header for ${repositoryPath}: ${header}`,
      );
    }
    const byteLength = Number(match[1]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + byteLength;
    if (contentEnd >= output.length || output[contentEnd] !== 0x0a) {
      throw new Error(`Truncated git object for ${repositoryPath}`);
    }
    entries.push({
      path: repositoryPath,
      source: decodeUtf8(
        output.subarray(contentStart, contentEnd),
        repositoryPath,
      ),
    });
    offset = contentEnd + 1;
  }
  if (offset !== output.length) {
    throw new Error("git cat-file returned unexpected trailing data.");
  }
  return entries;
}

function commitSourceEntries(root, sourceCommit) {
  const listed = runGit(root, [
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    sourceCommit,
    "--",
  ]);
  const inventory = normalizedInventory(
    nulSeparatedPaths(listed.stdout, "commit path inventory"),
  );
  const configFileNames = new Set(NEXT_CONFIG_FILES);
  const configEntries = inventory.filter(({ repositoryPath }) =>
    configFileNames.has(repositoryPath),
  );
  const configSources = new Map(
    commitBlobEntries(root, sourceCommit, configEntries).map((entry) => [
      entry.path,
      entry.source,
    ]),
  );
  const pageExtensions = resolveNextPageExtensionsFromInventory({
    inventory: inventory.map(({ repositoryPath }) => repositoryPath),
    readSource: (configPath) => configSources.get(configPath),
  });
  const scopeOptions = {
    frameworkRuntimePaths: nextFrameworkRuntimePaths(pageExtensions),
  };
  const included = inventory.filter(({ repositoryPath }) =>
    isProductionSource(repositoryPath, scopeOptions),
  );
  return {
    entries: commitBlobEntries(root, sourceCommit, included),
    scopeOptions,
  };
}

export function analyzeCommit(root, commitish) {
  const sourceCommit = resolveCommit(root, commitish);
  const { entries, scopeOptions } = commitSourceEntries(root, sourceCommit);
  const analysis = analyzeSourceEntries(entries, scopeOptions);
  return { sourceCommit, ...analysis };
}

function assertBaselineAncestor(root, sourceCommit) {
  const shallow = decodeUtf8(
    runGit(root, ["rev-parse", "--is-shallow-repository"]).stdout,
    "shallow-repository state",
  ).trim();
  const originMain = runGit(
    root,
    ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"],
    { allowedStatuses: [1, 128] },
  );
  const originMainCommit =
    originMain.status === 0
      ? resolvedCommitSha(originMain.stdout, "refs/remotes/origin/main")
      : null;
  const headAncestry = runGit(
    root,
    ["merge-base", "--is-ancestor", sourceCommit, "HEAD"],
    { allowedStatuses: [1] },
  );
  const mainAncestry = originMainCommit
    ? runGit(
        root,
        ["merge-base", "--is-ancestor", sourceCommit, originMainCommit],
        { allowedStatuses: [1] },
      )
    : null;
  assertBaselineProvenance({
    isShallow: shallow !== "false",
    originMainExists: originMainCommit !== null,
    sourceIsAncestorOfHead: headAncestry.status === 0,
    sourceIsAncestorOfOriginMain: mainAncestry?.status === 0,
  });
  return originMainCommit;
}

export function assertBaselineProvenance(state) {
  if (state.isShallow) {
    throw new Error(
      "Maintainability baselines require a complete, non-shallow checkout.",
    );
  }
  if (!state.originMainExists) {
    throw new Error(
      "Maintainability baselines require refs/remotes/origin/main.",
    );
  }
  if (!state.sourceIsAncestorOfOriginMain) {
    throw new Error(
      "Baseline sourceCommit must be an ancestor of origin/main.",
    );
  }
  if (!state.sourceIsAncestorOfHead) {
    throw new Error("Baseline sourceCommit must be an ancestor of HEAD.");
  }
}

export function formatMaintainabilityIssue(issue) {
  const identity = issue.anchor
    ? `${issue.path} :: ${issue.anchor}`
    : issue.path;
  const title =
    issue.kind === "LEGACY_DEBT_WORSENED"
      ? "LEGACY DEBT WORSENED"
      : issue.entity === "file" && issue.metric === "lines"
        ? "NEW FILE SIZE VIOLATION"
        : "NEW MAINTAINABILITY VIOLATION";
  const lines = [
    title,
    identity,
    `Metric: ${issue.entity} ${issue.metric}`,
    `Current: ${issue.current}`,
  ];
  if (issue.baseline !== undefined) {
    lines.push(`Baseline: ${issue.baseline}`, `Increase: +${issue.delta}`);
  } else {
    lines.push("Baseline: not grandfathered");
  }
  lines.push(
    `Limit: ${issue.limit}`,
    issue.baseline === undefined
      ? "Reduce the metric to the limit; new debt cannot be added to the baseline."
      : "Reduce the metric to its recorded baseline value or lower.",
  );
  return lines.join("\n");
}

function cliOptions(argumentsList) {
  if (!argumentsList.length) return { mode: "check" };
  if (argumentsList[0] !== "--write-baseline" || !argumentsList[1]) {
    throw new Error(
      "Usage: node quality/maintainability.mjs [--write-baseline <origin/main-ancestor-commit>]",
    );
  }
  if (argumentsList.length === 2) {
    return { mode: "write", commitish: argumentsList[1] };
  }
  throw new Error(
    "Usage: node quality/maintainability.mjs [--write-baseline <origin/main-ancestor-commit>]",
  );
}

function writeBaseline(root, options) {
  const sourceCommit = resolveCommit(root, options.commitish);
  assertBaselineAncestor(root, sourceCommit);
  const sourceAnalysis = analyzeCommit(root, sourceCommit);
  const baseline = createBaseline(sourceAnalysis.sourceCommit, sourceAnalysis);
  process.stdout.write(canonicalBaselineText(baseline));
  return 0;
}

function checkCurrentTree(root) {
  const baselinePath = path.join(root, DEFAULT_BASELINE_PATH);
  const baselineText = readFileSync(baselinePath, "utf8");
  const baseline = JSON.parse(baselineText);
  if (!/^[0-9a-f]{40}$/u.test(baseline.sourceCommit ?? "")) {
    throw new Error("Maintainability baseline has an invalid sourceCommit.");
  }
  const originMainCommit = assertBaselineAncestor(root, baseline.sourceCommit);
  const sourceAnalysis = analyzeCommit(root, baseline.sourceCommit);
  validateBaselineDocument(baseline, sourceAnalysis, baselineText);
  const currentAnalysis = analyzeWorkingTree(root);
  const currentVsSource = compareAnalyses(currentAnalysis, sourceAnalysis);
  let currentVsOrigin = currentVsSource;
  if (originMainCommit !== sourceAnalysis.sourceCommit) {
    const latestMainAnalysis = analyzeCommit(root, originMainCommit);
    currentVsOrigin = compareAnalyses(currentAnalysis, latestMainAnalysis);
  }
  const comparison = combineRatchetComparisons(
    currentVsSource,
    currentVsOrigin,
  );
  process.stdout.write(
    `Maintainability debt: ${JSON.stringify(debtCounts(currentAnalysis))}\n`,
  );
  for (const issue of comparison.issues) {
    process.stderr.write(`${formatMaintainabilityIssue(issue)}\n\n`);
  }
  return comparison.ok ? 0 : 1;
}

export function runCli(
  argumentsList = process.argv.slice(2),
  startDirectory = process.cwd(),
) {
  const root = repositoryRoot(startDirectory);
  const options = cliOptions(argumentsList);
  return options.mode === "write"
    ? writeBaseline(root, options)
    : checkCurrentTree(root);
}
