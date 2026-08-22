import path from "node:path";

import { normalizePath } from "./ast-utils.mjs";

const MODULE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];
const EXPLICIT_EXTENSION_CANDIDATES = new Map([
  [".js", [".ts", ".tsx", ".js", ".jsx"]],
  [".jsx", [".tsx", ".jsx"]],
  [".mjs", [".mts", ".mjs"]],
  [".cjs", [".cts", ".cjs"]],
  [".ts", [".ts"]],
  [".tsx", [".tsx"]],
  [".mts", [".mts"]],
  [".cts", [".cts"]],
]);

export function normalizedModuleFile(file) {
  return normalizePath(path.posix.normalize(normalizePath(file))).replace(
    /^\.\//,
    "",
  );
}

export function moduleCandidates(importerFile, specifier) {
  if (!specifier.startsWith(".")) return [];
  const importerDirectory = path.posix.dirname(
    normalizedModuleFile(importerFile),
  );
  const base = normalizedModuleFile(
    path.posix.join(importerDirectory, specifier),
  );
  const extension = path.posix.extname(base);
  if (!MODULE_EXTENSIONS.includes(extension)) {
    return [
      ...MODULE_EXTENSIONS.map((candidate) => `${base}${candidate}`),
      ...MODULE_EXTENSIONS.map((candidate) => `${base}/index${candidate}`),
    ];
  }
  const withoutExtension = base.slice(0, -extension.length);
  return EXPLICIT_EXTENSION_CANDIDATES.get(extension).map(
    (candidate) => `${withoutExtension}${candidate}`,
  );
}

export function resolvedModuleSource(moduleSources, importerFile, specifier) {
  if (!moduleSources) return undefined;
  const normalizedSources = new Map(
    [...moduleSources].map(([file, source]) => [
      normalizedModuleFile(file),
      source,
    ]),
  );
  const file = moduleCandidates(importerFile, specifier).find((candidate) =>
    normalizedSources.has(candidate),
  );
  return file ? { file, source: normalizedSources.get(file) } : undefined;
}
