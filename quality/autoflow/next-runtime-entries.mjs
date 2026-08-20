import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import ts from "typescript";

import {
  hasAmbiguousConfigMutation,
  hasSideEffectImport,
} from "./next-config-mutations.mjs";

export const NEXT_CONFIG_FILES = Object.freeze([
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "next.config.mts",
]);

export const DEFAULT_NEXT_PAGE_EXTENSIONS = Object.freeze([
  "tsx",
  "ts",
  "jsx",
  "js",
]);

export const SUPPORTED_NEXT_PAGE_EXTENSIONS = Object.freeze([
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "mts",
  "cts",
]);

const SUPPORTED_NEXT_PAGE_EXTENSION_SET = new Set(
  SUPPORTED_NEXT_PAGE_EXTENSIONS,
);
const NEXT_CLIENT_INSTRUMENTATION_EXTENSIONS = Object.freeze([
  "js",
  "mjs",
  "tsx",
  "ts",
  "jsx",
]);
const NEXT_SERVER_RUNTIME_NAMES = Object.freeze([
  "instrumentation",
  "middleware",
  "proxy",
]);
const CONFIG_PATH_SET = new Set(NEXT_CONFIG_FILES);
const MISSING_PAGE_EXTENSIONS = Symbol("missing-page-extensions");
const AMBIGUOUS_PAGE_EXTENSIONS = Symbol("ambiguous-page-extensions");

function configError(message) {
  return new Error(`NEXT RUNTIME ENTRY CONFIG ERROR\n${message}`);
}

function scriptKind(configPath) {
  if (/\.(?:js|mjs|cjs)$/u.test(configPath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function topLevelConstBindings(sourceFile) {
  const bindings = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        bindings.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return bindings;
}

function staticPropertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (!ts.isComputedPropertyName(name)) return undefined;
  const expression = unwrapExpression(name.expression);
  return ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
    ? expression.text
    : undefined;
}

function isModuleExports(expression) {
  const current = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(current)) {
    return (
      ts.isIdentifier(current.expression) &&
      current.expression.text === "module" &&
      current.name.text === "exports"
    );
  }
  if (!ts.isElementAccessExpression(current)) return false;
  const owner = unwrapExpression(current.expression);
  const member = current.argumentExpression
    ? unwrapExpression(current.argumentExpression)
    : undefined;
  return (
    ts.isIdentifier(owner) &&
    owner.text === "module" &&
    member !== undefined &&
    (ts.isStringLiteral(member) ||
      ts.isNoSubstitutionTemplateLiteral(member)) &&
    member.text === "exports"
  );
}

function exportedConfigExpressions(sourceFile) {
  const expressions = [];
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      expressions.push(statement.expression);
      continue;
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isModuleExports(statement.expression.left)
    ) {
      expressions.push(statement.expression.right);
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text === "default") {
          expressions.push(element.propertyName ?? element.name);
        }
      }
    }
  }
  return expressions;
}

function resolvedAlias(expression, context) {
  const current = unwrapExpression(expression);
  if (!ts.isIdentifier(current)) return current;
  if (context.resolving.has(current.text)) return undefined;
  const initializer = context.bindings.get(current.text);
  if (!initializer) return undefined;
  const resolving = new Set(context.resolving).add(current.text);
  return resolvedAlias(initializer, { ...context, resolving });
}

function transparentConfigWrappers(sourceFile) {
  const wrappers = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@sentry/nextjs" ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      if ((element.propertyName ?? element.name).text === "withSentryConfig") {
        wrappers.add(element.name.text);
      }
    }
  }
  return wrappers;
}

function isConfigWrapperCall(callExpression, context) {
  const callee = unwrapExpression(callExpression.expression);
  if (ts.isIdentifier(callee)) {
    return context.transparentConfigWrappers.has(callee.text);
  }
  return false;
}

function resolvedConfigObject(expression, context) {
  let current = resolvedAlias(expression, context);
  while (current && ts.isCallExpression(current)) {
    if (
      !isConfigWrapperCall(current, context) ||
      current.arguments.length === 0
    ) {
      return undefined;
    }
    current = resolvedAlias(current.arguments[0], context);
  }
  return current && ts.isObjectLiteralExpression(current) ? current : undefined;
}

function resolvedExtensionArray(expression, context) {
  const current = resolvedAlias(expression, context);
  if (!current || !ts.isArrayLiteralExpression(current)) return undefined;

  const extensions = [];
  for (const element of current.elements) {
    if (ts.isSpreadElement(element)) {
      const spread = resolvedExtensionArray(element.expression, context);
      if (!spread) return undefined;
      extensions.push(...spread);
      continue;
    }
    const candidate = resolvedAlias(element, context);
    if (
      !candidate ||
      (!ts.isStringLiteral(candidate) &&
        !ts.isNoSubstitutionTemplateLiteral(candidate))
    ) {
      return undefined;
    }
    extensions.push(candidate.text);
  }
  return extensions;
}

function propertyPageExtensions(property, context) {
  if (ts.isPropertyAssignment(property)) {
    return resolvedExtensionArray(property.initializer, context);
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    return resolvedExtensionArray(property.name, context);
  }
  return undefined;
}

function objectPageExtensions(objectLiteral, context) {
  if (context.objects.has(objectLiteral)) return AMBIGUOUS_PAGE_EXTENSIONS;
  context.objects.add(objectLiteral);
  let pageExtensions = MISSING_PAGE_EXTENSIONS;
  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spreadObject = resolvedConfigObject(property.expression, context);
      const spreadExtensions = spreadObject
        ? objectPageExtensions(spreadObject, context)
        : AMBIGUOUS_PAGE_EXTENSIONS;
      if (spreadExtensions !== MISSING_PAGE_EXTENSIONS) {
        pageExtensions = spreadExtensions;
      }
      continue;
    }
    const propertyName = staticPropertyName(property.name);
    if (
      propertyName === undefined &&
      ts.isComputedPropertyName(property.name)
    ) {
      pageExtensions = AMBIGUOUS_PAGE_EXTENSIONS;
      continue;
    }
    if (propertyName !== "pageExtensions") continue;
    pageExtensions =
      propertyPageExtensions(property, context) ?? AMBIGUOUS_PAGE_EXTENSIONS;
  }
  context.objects.delete(objectLiteral);
  return pageExtensions;
}

function validatedPageExtensions(candidate, configPath) {
  if (candidate === AMBIGUOUS_PAGE_EXTENSIONS) {
    throw configError(
      `${configPath} computes pageExtensions dynamically; use a static array of supported source extensions.`,
    );
  }
  if (candidate === MISSING_PAGE_EXTENSIONS) {
    return [...DEFAULT_NEXT_PAGE_EXTENSIONS];
  }
  if (!Array.isArray(candidate)) {
    throw configError(
      `${configPath} must declare pageExtensions as a static array.`,
    );
  }
  if (candidate.length === 0) {
    throw configError(`${configPath} declares an empty pageExtensions array.`);
  }
  const unsupported = candidate.filter(
    (extension) => !SUPPORTED_NEXT_PAGE_EXTENSION_SET.has(extension),
  );
  if (unsupported.length > 0) {
    throw configError(
      `${configPath} declares unsupported pageExtensions: ${[
        ...new Set(unsupported),
      ].join(
        ", ",
      )}. Supported extensions: ${SUPPORTED_NEXT_PAGE_EXTENSIONS.join(", ")}.`,
    );
  }
  return [...new Set(candidate)];
}

function pageExtensionsFromNextConfig(source, configPath) {
  const sourceFile = ts.createSourceFile(
    configPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(configPath),
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    const detail = ts.flattenDiagnosticMessageText(
      sourceFile.parseDiagnostics[0].messageText,
      "\n",
    );
    throw configError(`${configPath} could not be parsed: ${detail}`);
  }
  const exports = exportedConfigExpressions(sourceFile);
  if (exports.length !== 1) {
    throw configError(
      `${configPath} must have exactly one statically analyzable default or module.exports assignment.`,
    );
  }
  const context = {
    bindings: topLevelConstBindings(sourceFile),
    objects: new Set(),
    resolving: new Set(),
    transparentConfigWrappers: transparentConfigWrappers(sourceFile),
  };
  const configObject = resolvedConfigObject(exports[0], context);
  if (!configObject) {
    throw configError(
      `${configPath} exports a dynamic or unsupported configuration shape.`,
    );
  }
  if (
    hasAmbiguousConfigMutation({
      sourceFile,
      context,
      configObject,
      resolveAlias: resolvedAlias,
      resolveConfigObject: resolvedConfigObject,
      isConfigWrapperCall,
    })
  ) {
    throw configError(
      `${configPath} mutates or composes its configuration dynamically.`,
    );
  }
  const extensions = validatedPageExtensions(
    objectPageExtensions(configObject, context),
    configPath,
  );
  return hasSideEffectImport(sourceFile)
    ? [...SUPPORTED_NEXT_PAGE_EXTENSIONS]
    : extensions;
}

function rejectUnsupportedRuntimeCandidates(inventory) {
  const unsupported = inventory
    .map(normalizedInventoryPath)
    .filter((repositoryPath) => {
      const match =
        /^(?:src\/)?(?:instrumentation|middleware|proxy)\.([^.\/]+)$/iu.exec(
          repositoryPath,
        );
      return Boolean(
        match && !SUPPORTED_NEXT_PAGE_EXTENSION_SET.has(match[1].toLowerCase()),
      );
    });
  if (unsupported.length > 0) {
    throw configError(
      `Unsupported Next.js runtime entry candidates found: ${unsupported.join(", ")}.`,
    );
  }
}

export function resolveNextPageExtensionsFromInventory({
  inventory,
  readSource,
}) {
  if (!Array.isArray(inventory)) {
    throw new TypeError("Next.js config inventory must be an array.");
  }
  rejectUnsupportedRuntimeCandidates(inventory);
  const configPath = nextConfigPath(inventory);
  if (!configPath) return [...DEFAULT_NEXT_PAGE_EXTENSIONS];
  if (typeof readSource !== "function") {
    throw new TypeError(`A source reader is required for ${configPath}.`);
  }
  const source = readSource(configPath);
  if (typeof source !== "string") {
    throw new TypeError(`${configPath} source must be a string.`);
  }
  return pageExtensionsFromNextConfig(source, configPath);
}

function normalizedInventoryPath(repositoryPath) {
  return repositoryPath
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .normalize("NFC");
}

function nextConfigPath(inventory) {
  const matches = inventory
    .map(normalizedInventoryPath)
    .filter((repositoryPath) => CONFIG_PATH_SET.has(repositoryPath));
  if (matches.length > 1) {
    throw configError(
      `Multiple Next.js config files found: ${matches.join(", ")}.`,
    );
  }
  return matches[0];
}

function runtimePaths(names, extensions) {
  return ["", "src/"].flatMap((prefix) =>
    names.flatMap((name) =>
      extensions.map((extension) => `${prefix}${name}.${extension}`),
    ),
  );
}

export function nextFrameworkRuntimePaths(
  pageExtensions = DEFAULT_NEXT_PAGE_EXTENSIONS,
) {
  const validated = validatedPageExtensions(
    pageExtensions,
    "Next.js configuration",
  );
  return [
    ...runtimePaths(
      ["instrumentation-client"],
      NEXT_CLIENT_INSTRUMENTATION_EXTENSIONS,
    ),
    ...runtimePaths(NEXT_SERVER_RUNTIME_NAMES, validated),
  ];
}

export function isSupportedNextFrameworkRuntimePath(repositoryPath) {
  let normalizedPath = repositoryPath
    .replaceAll("\\", "/")
    .normalize("NFC")
    .toLowerCase();
  while (normalizedPath.startsWith("./")) {
    normalizedPath = normalizedPath.slice(2);
  }
  const match =
    /^(?:src\/)?(instrumentation-client|instrumentation|middleware|proxy)\.([^.\/]+)$/u.exec(
      normalizedPath,
    );
  if (!match) return false;
  const [, runtimeName, extension] = match;
  return runtimeName === "instrumentation-client"
    ? NEXT_CLIENT_INSTRUMENTATION_EXTENSIONS.includes(extension)
    : SUPPORTED_NEXT_PAGE_EXTENSION_SET.has(extension);
}

async function inventoryFor(options, rootDir) {
  if (typeof options.inventory === "function") {
    return options.inventory(rootDir);
  }
  if (options.inventory) return options.inventory;
  const rootFiles = await directoryFiles(rootDir);
  let srcFiles = [];
  try {
    srcFiles = await directoryFiles(resolve(rootDir, "src"), "src/");
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
  }
  return [...rootFiles, ...srcFiles];
}

async function directoryFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => `${prefix}${entry.name}`);
}

async function sourceFor(options, rootDir, configPath) {
  if (options.readSource) return options.readSource(configPath, rootDir);
  return readFile(resolve(rootDir, configPath), "utf8");
}

export async function resolveNextPageExtensions(options = {}) {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const inventory = await inventoryFor(options, rootDir);
  const configPath = nextConfigPath(inventory);
  const source = configPath
    ? await sourceFor(options, rootDir, configPath)
    : undefined;
  return resolveNextPageExtensionsFromInventory({
    inventory,
    readSource: () => source,
  });
}
