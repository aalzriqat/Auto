import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanAdminSuperAdmin } from "./autoflow/admin-super-admin.mjs";
import { aggregateConstructorOptions } from "./autoflow/aggregate-reexports.mjs";
import { scanAggregateWiring } from "./autoflow/aggregate-registration.mjs";
import {
  RULE_IDS,
  compareText,
  normalizePath,
  sortDiagnostics,
} from "./autoflow/ast-utils.mjs";
import { scanEconomicsRevision } from "./autoflow/economics-revision.mjs";
import { scanRawConvexBuilders } from "./autoflow/raw-convex-builders.mjs";

export {
  RULE_IDS,
  scanAdminSuperAdmin,
  scanAggregateWiring,
  scanEconomicsRevision,
  scanRawConvexBuilders,
};

const CONVEX_ENTRY_EXTENSIONS = [
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".jsx",
];
const GENERATED_BINDING_OUTPUTS = new Set([
  "_generated/api.d.ts",
  "_generated/api.js",
  "_generated/dataModel.d.ts",
  "_generated/server.d.ts",
  "_generated/server.js",
]);

function isConvexSourceFile(convexRoot, absoluteFile) {
  const relativeFile = normalizePath(path.relative(convexRoot, absoluteFile));
  if (GENERATED_BINDING_OUTPUTS.has(relativeFile)) return false;
  if (/\.d\.(?:ts|mts|cts)$/.test(relativeFile)) return false;
  if (
    /\.(?:test|spec)\.(?:js|mjs|cjs|ts|tsx|mts|cts|jsx)$/.test(relativeFile)
  ) {
    return false;
  }
  return CONVEX_ENTRY_EXTENSIONS.some((extension) =>
    relativeFile.endsWith(extension),
  );
}

function convexSourceFiles(convexRoot) {
  const files = [];
  const walk = (directory) => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (isConvexSourceFile(convexRoot, fullPath)) {
        files.push(fullPath);
      }
    }
  };
  walk(convexRoot);
  return files;
}

/** Runs all four rules against a checkout and returns deterministic diagnostics. */
export function scanRepository(repositoryRoot = process.cwd()) {
  const root = path.resolve(repositoryRoot);
  const convexRoot = path.join(root, "convex");
  if (!fs.statSync(convexRoot).isDirectory()) {
    throw new Error(`Convex source directory not found: ${convexRoot}`);
  }

  const sources = convexSourceFiles(convexRoot).map((absoluteFile) => ({
    absoluteFile,
    file: normalizePath(path.relative(root, absoluteFile)),
    source: fs.readFileSync(absoluteFile, "utf8"),
  }));
  const moduleSources = new Map(
    sources.map(({ file, source }) => [file, source]),
  );
  const constructorOptions = aggregateConstructorOptions(sources);
  const diagnostics = [];
  for (const { file: relativeFile, source } of sources) {
    diagnostics.push(...scanRawConvexBuilders(source, relativeFile));
    diagnostics.push(
      ...scanEconomicsRevision(source, relativeFile, { moduleSources }),
    );
    // The aggregate scanner returns immediately unless this file constructs a
    // package-proven TableAggregate, so instances cannot evade the wiring
    // contract merely by moving out of convex/aggregates.ts.
    diagnostics.push(
      ...scanAggregateWiring(
        source,
        relativeFile,
        constructorOptions.get(relativeFile),
      ),
    );
    if (
      /^convex\/admin(?:[^/]*|\/.+)\.(?:js|mjs|cjs|ts|tsx|mts|cts|jsx)$/.test(
        relativeFile,
      )
    ) {
      diagnostics.push(...scanAdminSuperAdmin(source, relativeFile));
    }
  }
  return sortDiagnostics(diagnostics);
}

export function formatDiagnostic(item) {
  return `${item.file}:${item.line}:${item.column} [${item.ruleId}] ${item.message}`;
}

function cliRoot(argv) {
  if (argv.length === 0) return process.cwd();
  if (argv.length === 1 && !argv[0].startsWith("-")) return argv[0];
  if (argv.length === 2 && argv[0] === "--root") return argv[1];
  throw new Error(
    "Usage: node quality/autoflow-rules.mjs [--root] [repository-root]",
  );
}

export function runCli(argv = process.argv.slice(2)) {
  const diagnostics = scanRepository(cliRoot(argv));
  if (diagnostics.length === 0) {
    console.log("AutoFlow AST safety rules: no violations.");
    return 0;
  }
  for (const item of diagnostics) console.error(formatDiagnostic(item));
  console.error(
    `AutoFlow AST safety rules: ${diagnostics.length} violation(s).`,
  );
  return 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
