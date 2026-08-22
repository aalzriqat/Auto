import { access, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { cruise } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";

import {
  canonicalizeArchitectureBaseline,
  readOriginMainArchitectureBaseline,
  validateBaselineProvenance,
} from "./architecture-provenance.mjs";
import { assertArchitectureBaselineIntegrity } from "./architecture-baseline-integrity.mjs";
import { stronglyConnectedComponents } from "./architecture-cycles.mjs";
import {
  architectureBoundaryViolations,
  isArchitectureAuditedPath,
  isArchitectureTestPath,
} from "./architecture-policy.mjs";
import { scanNonliteralRuntimeImports } from "./architecture-runtime-imports.mjs";
import { readArchitectureSourceSnapshot } from "./architecture-source-snapshot.mjs";
import {
  ARCHITECTURE_ENTRY_POINTS,
  architectureEntryPoints,
  architectureFrameworkRuntimePaths,
} from "./architecture-entry-points.mjs";
import { resolveNextPageExtensions } from "./autoflow/next-runtime-entries.mjs";

export { assertArchitectureBaselineIntegrity, validateBaselineProvenance };

export const ARCHITECTURE_ENGINE_VERSION = "17.4.3";
export { ARCHITECTURE_ENTRY_POINTS };

const SOURCE_FILE_EXTENSION_PATTERN = /\.[cm]?[jt]sx?$/iu;
const INSTALLED_DEPENDENCY_PATH_PATTERN = /(?:^|\/)node_modules\//iu;

const GENERATED_SOURCE_PATHS = new Set([
  "convex/_generated/api.d.ts",
  "convex/_generated/api.js",
  "convex/_generated/datamodel.d.ts",
  "convex/_generated/server.d.ts",
  "convex/_generated/server.js",
]);

const GENERATED_SOURCE_PATTERN =
  "^convex/_generated/(?:api\\.d\\.ts|api\\.js|dataModel\\.d\\.ts|server\\.d\\.ts|server\\.js)$";

const INTERNAL_BARE_PATH_PATTERN =
  /^(?:app|components|hooks|lib|convex|packages\/shared\/src|apps\/mobile\/(?:src|app)|dealer-worker\/src|public|quality)\//;

function compareText(left, right) {
  return left.localeCompare(right, "en");
}
function edgeKey(edge) {
  return `${edge.from}\u0000${edge.to}`;
}

function normalizedSegments(inputPath) {
  const slashPath = inputPath.normalize("NFC").replaceAll("\\", "/");
  const segments = [];

  for (const segment of slashPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error(
          `Architecture paths must stay inside the repository: ${inputPath}`,
        );
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return segments;
}

export function normalizeArchitecturePath(inputPath) {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new TypeError("Architecture paths must be non-empty strings.");
  }

  const trimmedPath = inputPath.trim();
  if (isAbsolute(trimmedPath) || /^[A-Za-z]:[\\/]/u.test(trimmedPath)) {
    throw new Error(
      `Architecture paths must be repository-relative: ${inputPath}`,
    );
  }

  return normalizedSegments(trimmedPath).join("/").toLocaleLowerCase("en-US");
}

function normalizedDisplayPath(inputPath) {
  return normalizedSegments(inputPath.trim()).join("/");
}

function isGeneratedSource(sourcePath) {
  return GENERATED_SOURCE_PATHS.has(normalizeArchitecturePath(sourcePath));
}

function isSourceFile(sourcePath) {
  if (typeof sourcePath !== "string") return false;
  const slashPath = sourcePath.normalize("NFC").replaceAll("\\", "/");
  if (isAbsolute(slashPath) || /^[A-Za-z]:\//u.test(slashPath)) return false;
  if (
    slashPath === ".." ||
    slashPath.startsWith("../") ||
    INSTALLED_DEPENDENCY_PATH_PATTERN.test(slashPath)
  )
    return false;
  const displayPath = normalizedDisplayPath(sourcePath);
  return (
    SOURCE_FILE_EXTENSION_PATTERN.test(displayPath) &&
    !INSTALLED_DEPENDENCY_PATH_PATTERN.test(displayPath)
  );
}

function isInternalSpecifier(specifier) {
  return (
    typeof specifier === "string" &&
    (specifier.startsWith(".") ||
      specifier.startsWith("/") ||
      /^[A-Za-z]:[\\/]/u.test(specifier) ||
      specifier.startsWith("@/") ||
      specifier.startsWith("@autoflow/") ||
      INTERNAL_BARE_PATH_PATTERN.test(specifier))
  );
}

function moduleDisplayPaths(cruiseResult) {
  const displayByIdentity = new Map();

  for (const moduleRecord of cruiseResult.modules) {
    if (
      !isSourceFile(moduleRecord.source) ||
      isGeneratedSource(moduleRecord.source)
    )
      continue;
    const identity = normalizeArchitecturePath(moduleRecord.source);
    const displayPath = normalizedDisplayPath(moduleRecord.source);
    const previousPath = displayByIdentity.get(identity);
    if (previousPath && previousPath !== displayPath) {
      throw new Error(
        `AMBIGUOUS MODULE IDENTITY\n${previousPath}\n${displayPath}\nPaths differing only by case or separators are not portable.`,
      );
    }
    displayByIdentity.set(identity, displayPath);
  }

  return displayByIdentity;
}

function unresolvedInternalImports(cruiseResult, displayByIdentity) {
  const violationsByImport = new Map();

  for (const moduleRecord of cruiseResult.modules) {
    if (
      !isSourceFile(moduleRecord.source) ||
      isGeneratedSource(moduleRecord.source)
    )
      continue;
    const from = normalizeArchitecturePath(moduleRecord.source);
    if (!displayByIdentity.has(from)) continue;

    for (const dependency of moduleRecord.dependencies ?? []) {
      if (
        !dependency.couldNotResolve ||
        !isInternalSpecifier(dependency.module)
      )
        continue;
      const identity = edgeKey({ from, to: dependency.module });
      if (violationsByImport.has(identity)) continue;
      violationsByImport.set(identity, {
        kind: "UNRESOLVED INTERNAL IMPORT",
        rule: "internal-imports-resolve",
        from: displayByIdentity.get(from),
        to: dependency.module,
        message:
          "Fix the import path or the TypeScript/workspace resolution configuration.",
      });
    }
  }

  return [...violationsByImport.values()].sort((left, right) =>
    compareText(
      `${left.from}\u0000${left.to}`,
      `${right.from}\u0000${right.to}`,
    ),
  );
}

function localEdges(cruiseResult, displayByIdentity) {
  const edgesByIdentity = new Map();

  for (const moduleRecord of cruiseResult.modules) {
    if (
      !isSourceFile(moduleRecord.source) ||
      isGeneratedSource(moduleRecord.source)
    )
      continue;
    const from = normalizeArchitecturePath(moduleRecord.source);
    if (!displayByIdentity.has(from)) continue;

    for (const dependency of moduleRecord.dependencies ?? []) {
      if (dependency.couldNotResolve || !isSourceFile(dependency.resolved))
        continue;
      if (isGeneratedSource(dependency.resolved)) continue;
      const to = normalizeArchitecturePath(dependency.resolved);
      if (!displayByIdentity.has(to)) continue;

      const identity = edgeKey({ from, to });
      const previousEdge = edgesByIdentity.get(identity);
      const edge = {
        from,
        to,
        displayFrom: displayByIdentity.get(from),
        displayTo: displayByIdentity.get(to),
        runtime: !dependency.preCompilationOnly && !dependency.typeOnly,
      };
      edgesByIdentity.set(
        identity,
        previousEdge
          ? { ...edge, runtime: previousEdge.runtime || edge.runtime }
          : edge,
      );
    }
  }

  return [...edgesByIdentity.values()].sort((left, right) =>
    compareText(edgeKey(left), edgeKey(right)),
  );
}

export function architectureGraph(cruiseResult) {
  if (!cruiseResult || !Array.isArray(cruiseResult.modules)) {
    throw new TypeError(
      "Expected dependency-cruiser output with a modules array.",
    );
  }
  if (
    cruiseResult.nonliteralRuntimeImports !== undefined &&
    !Array.isArray(cruiseResult.nonliteralRuntimeImports)
  ) {
    throw new TypeError(
      "Expected nonliteral runtime import diagnostics to be an array.",
    );
  }
  if (
    cruiseResult.frameworkRuntimePaths !== undefined &&
    !Array.isArray(cruiseResult.frameworkRuntimePaths)
  ) {
    throw new TypeError("Expected framework runtime paths to be an array.");
  }

  const displayByIdentity = moduleDisplayPaths(cruiseResult);
  const frameworkRuntimePaths = cruiseResult.frameworkRuntimePaths
    ? new Set(
        cruiseResult.frameworkRuntimePaths.map((runtimePath) =>
          normalizeArchitecturePath(runtimePath),
        ),
      )
    : undefined;
  return {
    modules: [...displayByIdentity.keys()].sort(compareText),
    edges: localEdges(cruiseResult, displayByIdentity),
    nonliteralRuntimeImports: cruiseResult.nonliteralRuntimeImports ?? [],
    unresolved: unresolvedInternalImports(cruiseResult, displayByIdentity),
    frameworkRuntimePaths,
    engineVersion: ARCHITECTURE_ENGINE_VERSION,
  };
}

function isCyclicComponent(component, runtimeEdgeKeys) {
  return (
    component.length > 1 ||
    runtimeEdgeKeys.has(edgeKey({ from: component[0], to: component[0] }))
  );
}

export function runtimeCycleSnapshot(graph) {
  const runtimeModules = graph.modules.filter(
    (modulePath) =>
      isArchitectureAuditedPath(modulePath, graph.frameworkRuntimePaths) &&
      !isArchitectureTestPath(modulePath),
  );
  const runtimeEdges = graph.edges.filter(
    (edge) =>
      edge.runtime &&
      isArchitectureAuditedPath(edge.from, graph.frameworkRuntimePaths) &&
      isArchitectureAuditedPath(edge.to, graph.frameworkRuntimePaths) &&
      !isArchitectureTestPath(edge.from) &&
      !isArchitectureTestPath(edge.to),
  );
  const runtimeEdgeKeys = new Set(runtimeEdges.map(edgeKey));
  const cyclicComponents = stronglyConnectedComponents(
    runtimeModules,
    runtimeEdges,
  ).filter((component) => isCyclicComponent(component, runtimeEdgeKeys));
  const componentByModule = new Map();

  for (const component of cyclicComponents) {
    for (const modulePath of component)
      componentByModule.set(modulePath, component);
  }

  const cyclicModules = [...componentByModule.keys()].sort(compareText);
  const cyclicEdges = runtimeEdges.filter(
    (edge) =>
      componentByModule.has(edge.from) &&
      componentByModule.get(edge.from) === componentByModule.get(edge.to),
  );

  return {
    cyclicModules,
    cyclicEdges: cyclicEdges
      .map(({ from, to }) => ({ from, to }))
      .sort((left, right) => compareText(edgeKey(left), edgeKey(right))),
  };
}

export function canonicalArchitectureBaseline(candidate) {
  return canonicalizeArchitectureBaseline(candidate, normalizeArchitecturePath);
}

function difference(currentEntries, baselineEntries, identity) {
  const baselineIdentities = new Set(baselineEntries.map(identity));
  return currentEntries.filter(
    (entry) => !baselineIdentities.has(identity(entry)),
  );
}

function cycleRatchetViolations(snapshot, baseline) {
  const violations = [];
  for (const modulePath of difference(
    snapshot.cyclicModules,
    baseline.cyclicModules,
    String,
  )) {
    violations.push({
      kind: "NEW CYCLIC MODULE",
      rule: "no-new-runtime-cycles",
      from: modulePath,
      message: "This module newly participates in a runtime dependency cycle.",
    });
  }
  for (const edge of difference(
    snapshot.cyclicEdges,
    baseline.cyclicEdges,
    edgeKey,
  )) {
    violations.push({
      kind: "NEW CIRCULAR DEPENDENCY EDGE",
      rule: "no-new-runtime-cycles",
      from: edge.from,
      to: edge.to,
      message:
        "Remove this edge or break the runtime cycle; existing cyclic edges are only grandfathered exactly.",
    });
  }
  for (const modulePath of difference(
    baseline.cyclicModules,
    snapshot.cyclicModules,
    String,
  )) {
    violations.push({
      kind: "STALE ARCHITECTURE BASELINE",
      rule: "baseline-must-ratchet-down",
      from: modulePath,
      message:
        "This module is no longer cyclic. Remove it and its obsolete edges from the baseline.",
    });
  }
  for (const edge of difference(
    baseline.cyclicEdges,
    snapshot.cyclicEdges,
    edgeKey,
  )) {
    violations.push({
      kind: "STALE ARCHITECTURE BASELINE",
      rule: "baseline-must-ratchet-down",
      from: edge.from,
      to: edge.to,
      message:
        "This cyclic edge no longer exists. Remove it from the baseline so it cannot be reintroduced.",
    });
  }
  return violations;
}

export function evaluateArchitecture(cruiseResult, baselineInput) {
  const graph = architectureGraph(cruiseResult);
  const baseline = canonicalArchitectureBaseline(baselineInput);
  const snapshot = runtimeCycleSnapshot(graph);
  const violations = [
    ...graph.nonliteralRuntimeImports,
    ...graph.unresolved,
    ...architectureBoundaryViolations(graph),
    ...cycleRatchetViolations(snapshot, baseline),
  ];

  if (baseline.engineVersion !== graph.engineVersion) {
    violations.unshift({
      kind: "ARCHITECTURE BASELINE ENGINE MISMATCH",
      rule: "baseline-engine-version",
      message: `Baseline: ${baseline.engineVersion}; current dependency-cruiser: ${graph.engineVersion}. Re-audit the graph before changing the baseline.`,
    });
  }

  return {
    ok: violations.length === 0,
    violations,
    snapshot,
    stats: {
      modules: graph.modules.length,
      dependencies: graph.edges.length,
      runtimeCyclicModules: snapshot.cyclicModules.length,
      runtimeCyclicEdges: snapshot.cyclicEdges.length,
    },
  };
}

export async function cruiseArchitecture({
  rootDir,
  entryPoints,
  tsConfigPath = "tsconfig.json",
}) {
  const absoluteRoot = resolve(rootDir);
  const pageExtensions = await resolveNextPageExtensions({
    rootDir: absoluteRoot,
  });
  const configuredFrameworkRuntimePaths =
    architectureFrameworkRuntimePaths(pageExtensions);
  const configuredFrameworkRuntimeIdentities = new Set(
    configuredFrameworkRuntimePaths.map((runtimePath) =>
      normalizeArchitecturePath(runtimePath),
    ),
  );
  const configuredEntryPoints =
    entryPoints ?? architectureEntryPoints(pageExtensions);
  const absoluteTsConfigPath = resolve(absoluteRoot, tsConfigPath);
  const parsedTsConfig = extractTSConfig(absoluteTsConfigPath);
  const availableEntryPoints = [];
  for (const entryPoint of configuredEntryPoints) {
    try {
      await access(resolve(absoluteRoot, entryPoint));
      availableEntryPoints.push(entryPoint);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (availableEntryPoints.length === 0) {
    throw new Error("No architecture entry points exist in this checkout.");
  }
  const cruiseOutput = await cruise(
    availableEntryPoints,
    {
      baseDir: absoluteRoot,
      combinedDependencies: true,
      doNotFollow: { path: "(^|/)node_modules/" },
      enhancedResolveOptions: {
        conditionNames: ["types", "import", "default"],
        exportsFields: ["exports"],
        mainFields: ["types", "main"],
      },
      exclude: { path: GENERATED_SOURCE_PATTERN },
      moduleSystems: ["es6", "cjs"],
      parser: "tsc",
      preserveSymlinks: false,
      progress: { type: "none" },
      tsConfig: { fileName: absoluteTsConfigPath },
      tsPreCompilationDeps: "specify",
    },
    undefined,
    { tsConfig: parsedTsConfig },
  );

  if (typeof cruiseOutput.output === "string") {
    throw new Error(
      "dependency-cruiser returned formatted text instead of a dependency graph.",
    );
  }
  const modulePaths = cruiseOutput.output.modules
    .map((moduleRecord) => moduleRecord.source)
    .filter(
      (sourcePath) =>
        isSourceFile(sourcePath) &&
        isArchitectureAuditedPath(
          normalizeArchitecturePath(sourcePath),
          configuredFrameworkRuntimeIdentities,
        ) &&
        !isGeneratedSource(sourcePath),
    )
    .map(normalizedDisplayPath)
    .filter((modulePath) => !isArchitectureTestPath(modulePath));
  const nonliteralRuntimeImports = await scanNonliteralRuntimeImports({
    rootDir: absoluteRoot,
    modulePaths,
  });
  return {
    ...cruiseOutput.output,
    nonliteralRuntimeImports,
    frameworkRuntimePaths: configuredFrameworkRuntimePaths,
  };
}

export function formatArchitectureViolations(violations) {
  return violations
    .map((violation) => {
      const source = violation.line
        ? `${violation.from}:${violation.line}:${violation.column}`
        : violation.from;
      const dependency = violation.to ? `${source} -> ${violation.to}` : source;
      return [
        violation.kind,
        dependency,
        `Rule: ${violation.rule}`,
        violation.message,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

export async function runArchitectureCheck({
  rootDir = process.cwd(),
  baselinePath = "quality/baselines/architecture.json",
} = {}) {
  const baseline = canonicalArchitectureBaseline(
    JSON.parse(await readFile(resolve(rootDir, baselinePath), "utf8")),
  );
  const originMainCommit = await validateBaselineProvenance({
    rootDir,
    sourceCommit: baseline.sourceCommit,
  });
  const originBaselineInput = await readOriginMainArchitectureBaseline({
    rootDir,
    baselinePath,
    originMainCommit,
  });
  const originBaseline = originBaselineInput
    ? canonicalArchitectureBaseline(originBaselineInput)
    : null;
  const sourceSnapshot = await readArchitectureSourceSnapshot({
    rootDir,
    sourceCommit: baseline.sourceCommit,
  });
  assertArchitectureBaselineIntegrity({
    baseline,
    originBaseline,
    originMainCommit,
    sourceSnapshot,
    engineVersion: ARCHITECTURE_ENGINE_VERSION,
  });
  const cruiseResult = await cruiseArchitecture({ rootDir });
  return evaluateArchitecture(cruiseResult, baseline);
}

function isCommandLineEntry() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isCommandLineEntry()) {
  try {
    const report = await runArchitectureCheck();
    if (!report.ok) {
      console.error(formatArchitectureViolations(report.violations));
      process.exitCode = 1;
    } else {
      console.log(
        `Architecture guard passed: ${report.stats.modules} modules, ${report.stats.dependencies} internal dependencies, ${report.stats.runtimeCyclicEdges} grandfathered cyclic edges.`,
      );
    }
  } catch (error) {
    console.error(
      `ARCHITECTURE CHECK ERROR\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
