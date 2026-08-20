import { readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

import { createLexicalBindingProvenance } from "./autoflow/lexical-binding-provenance.mjs";
import { codeGenerationViolationForNode } from "./autoflow/dynamic-code-generation.mjs";
import {
  RUNTIME_GLOBAL_OBJECT_NAMES,
  workerLoaderKind,
} from "./autoflow/worker-runtime-loader.mjs";

const REQUIRE_METADATA_MEMBERS = new Set(["extensions", "resolve"]);

const SAFE_MODULE_METADATA_MEMBERS = new Set([
  "exports",
  "filename",
  "id",
  "loaded",
  "path",
  "paths",
  "require",
]);

const NODE_MODULE_LOADER_EXPORTS = new Set([
  "createRequire",
  "default",
  "Module",
]);

const NODE_PROCESS_LOADER_EXPORTS = new Set(["default", "getBuiltinModule"]);
const NODE_VM_CODE_GENERATION_EXPORTS = new Set([
  "compileFunction",
  "createScript",
  "default",
  "runInContext",
  "runInNewContext",
  "runInThisContext",
  "Script",
  "SourceTextModule",
]);

const GLOBAL_OBJECT_CODE_GENERATORS = new Set([
  "eval",
  "Function",
  "constructor",
]);
const GLOBAL_OBJECT_LOADERS = new Set(["module", "process", "require"]);

function scriptKind(filePath) {
  if (/\.tsx$/iu.test(filePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/iu.test(filePath)) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/iu.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function unwrapStaticExpression(expression) {
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

function literalModuleSpecifier(expression) {
  const current = unwrapStaticExpression(expression);
  return current &&
    (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current))
    ? current.text
    : undefined;
}

function isRepositoryModuleSpecifier(specifier) {
  return (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(specifier) ||
    specifier.startsWith("@/") ||
    specifier.startsWith("@autoflow/") ||
    /^(?:app|components|hooks|lib|convex|quality|scripts|packages|apps|dealer-worker)\//u.test(
      specifier,
    )
  );
}

function staticMemberName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (!ts.isElementAccessExpression(expression)) return undefined;
  const argument = expression.argumentExpression
    ? unwrapStaticExpression(expression.argumentExpression)
    : undefined;
  return argument &&
    (ts.isStringLiteral(argument) ||
      ts.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : undefined;
}

function isUnboundIdentifier(node, name, bindings) {
  return (
    ts.isIdentifier(node) && node.text === name && !bindings.hasBinding(node)
  );
}

function isUnboundIdentifierIn(node, names, bindings) {
  return (
    ts.isIdentifier(node) && names.has(node.text) && !bindings.hasBinding(node)
  );
}

function commonJsLoaderKind(expression, bindings) {
  const current = unwrapStaticExpression(expression);
  if (isUnboundIdentifier(current, "require", bindings)) return "require";
  if (
    (ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)) &&
    staticMemberName(current) === "require" &&
    isUnboundIdentifier(
      unwrapStaticExpression(current.expression),
      "module",
      bindings,
    )
  ) {
    return "module.require";
  }
  return undefined;
}

function runtimeLoaderKind(expression, bindings) {
  const current = unwrapStaticExpression(expression);
  if (current.kind === ts.SyntaxKind.ImportKeyword) return "import";
  return (
    commonJsLoaderKind(current, bindings) ?? workerLoaderKind(current, bindings)
  );
}

function expressionEnvelope(node) {
  let current = node;
  while (
    current.parent &&
    unwrapStaticExpression(current.parent) === current &&
    current.parent !== current
  ) {
    current = current.parent;
  }
  return current;
}

function isDirectCallee(node) {
  const envelope = expressionEnvelope(node);
  return (
    ts.isCallExpression(envelope.parent) &&
    unwrapStaticExpression(envelope.parent.expression) ===
      unwrapStaticExpression(envelope)
  );
}

function isSafeRequireMetadataUse(node) {
  const envelope = expressionEnvelope(node);
  const parent = envelope.parent;
  if (ts.isTypeOfExpression(parent)) return true;
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === envelope
  ) {
    return REQUIRE_METADATA_MEMBERS.has(staticMemberName(parent));
  }
  return false;
}

function isSafeStaticMemberUse(node, safeMembers) {
  const envelope = expressionEnvelope(node);
  const parent = envelope.parent;
  if (ts.isTypeOfExpression(parent)) return true;
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === envelope
  ) {
    return safeMembers.has(staticMemberName(parent));
  }
  return false;
}

function isSafeModuleMetadataUse(node) {
  return isSafeStaticMemberUse(node, SAFE_MODULE_METADATA_MEMBERS);
}

function isSafeProcessMemberUse(node) {
  const envelope = expressionEnvelope(node);
  const parent = envelope.parent;
  if (ts.isTypeOfExpression(parent)) return true;
  if (
    (ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent)) &&
    parent.expression === envelope
  ) {
    const member = staticMemberName(parent);
    return (
      member !== undefined &&
      member !== "mainModule" &&
      member !== "getBuiltinModule"
    );
  }
  return false;
}

function staticMemberChain(node) {
  const members = [];
  let outerExpression = expressionEnvelope(node);
  while (
    outerExpression.parent &&
    (ts.isPropertyAccessExpression(outerExpression.parent) ||
      ts.isElementAccessExpression(outerExpression.parent)) &&
    unwrapStaticExpression(outerExpression.parent.expression) ===
      unwrapStaticExpression(outerExpression)
  ) {
    members.push(staticMemberName(outerExpression.parent));
    outerExpression = expressionEnvelope(outerExpression.parent);
  }
  return { members, outerExpression };
}

function isSafeGlobalObjectUse(node) {
  const { members, outerExpression } = staticMemberChain(node);
  if (ts.isTypeOfExpression(outerExpression.parent)) return true;
  const [globalMember, nestedMember] = members;
  if (globalMember === undefined) return false;
  if (
    GLOBAL_OBJECT_CODE_GENERATORS.has(globalMember) ||
    GLOBAL_OBJECT_LOADERS.has(globalMember)
  ) {
    if (globalMember === "process") {
      return (
        members.length > 1 &&
        nestedMember !== undefined &&
        nestedMember !== "getBuiltinModule" &&
        nestedMember !== "mainModule"
      );
    }
    if (globalMember === "module") {
      return (
        members.length > 1 &&
        nestedMember !== "require" &&
        SAFE_MODULE_METADATA_MEMBERS.has(nestedMember)
      );
    }
    if (globalMember === "require") {
      return members.length > 1 && REQUIRE_METADATA_MEMBERS.has(nestedMember);
    }
    return false;
  }
  return true;
}

const MODULE_GLOBAL_LOADER = Object.freeze({
  globalName: "module",
  isSafeUse: isSafeModuleMetadataUse,
});

const PROCESS_GLOBAL_LOADER = Object.freeze({
  globalName: "process",
  isSafeUse: isSafeProcessMemberUse,
});

const NODE_GLOBAL_OBJECT_LOADER = Object.freeze({
  globalNames: RUNTIME_GLOBAL_OBJECT_NAMES,
  isSafeUse: isSafeGlobalObjectUse,
});

function isIdentifierReference(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (parent.name === node && !ts.isShorthandPropertyAssignment(parent)) {
    return false;
  }
  if (parent.propertyName === node) return false;
  if (ts.isQualifiedName(parent) || ts.isTypeNode(parent)) return false;
  if (
    (ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) &&
    parent.label === node
  ) {
    return false;
  }
  return true;
}

function importModuleText(node) {
  return node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function nodeLoaderExports(specifier) {
  if (specifier === "module" || specifier === "node:module") {
    return NODE_MODULE_LOADER_EXPORTS;
  }
  if (specifier === "process" || specifier === "node:process") {
    return NODE_PROCESS_LOADER_EXPORTS;
  }
  if (specifier === "vm" || specifier === "node:vm") {
    return NODE_VM_CODE_GENERATION_EXPORTS;
  }
  return undefined;
}

function importsNodeLoader(clause, loaderExports) {
  if (!clause || clause.isTypeOnly) return false;
  if (clause.name) return true;
  if (!clause.namedBindings) return false;
  if (ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings.elements.some(
    (element) =>
      !element.isTypeOnly &&
      loaderExports.has((element.propertyName ?? element.name).text),
  );
}

function exportsNodeLoader(node, loaderExports) {
  if (node.isTypeOnly) return false;
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return true;
  return node.exportClause.elements.some(
    (element) =>
      !element.isTypeOnly &&
      loaderExports.has((element.propertyName ?? element.name).text),
  );
}

function importEqualsModuleText(node) {
  if (
    !ts.isImportEqualsDeclaration(node) ||
    node.isTypeOnly ||
    !ts.isExternalModuleReference(node.moduleReference)
  ) {
    return undefined;
  }
  return importModuleText(node.moduleReference.expression);
}

function isNodeLoaderApiCall(node, bindings) {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return false;
  if (!nodeLoaderExports(literalModuleSpecifier(node.arguments[0]))) {
    return false;
  }
  const callee = unwrapStaticExpression(node.expression);
  return (
    callee.kind === ts.SyntaxKind.ImportKeyword ||
    commonJsLoaderKind(callee, bindings) !== undefined
  );
}

function unsupportedNodeLoaderApiNode(node, bindings) {
  if (
    ts.isImportDeclaration(node) &&
    nodeLoaderExports(importModuleText(node.moduleSpecifier))
  ) {
    return importsNodeLoader(
      node.importClause,
      nodeLoaderExports(importModuleText(node.moduleSpecifier)),
    );
  }
  if (
    ts.isExportDeclaration(node) &&
    nodeLoaderExports(importModuleText(node.moduleSpecifier))
  ) {
    return exportsNodeLoader(
      node,
      nodeLoaderExports(importModuleText(node.moduleSpecifier)),
    );
  }
  if (nodeLoaderExports(importEqualsModuleText(node))) return true;
  return isNodeLoaderApiCall(node, bindings);
}

function nodeLoaderApiViolation(sourceFile, modulePath, node, bindings) {
  if (!unsupportedNodeLoaderApiNode(node, bindings)) return undefined;
  const start = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile, false),
  );
  return {
    kind: "UNTRACEABLE NODE MODULE LOADER",
    rule: "runtime-imports-resolve",
    from: modulePath,
    line: start.line + 1,
    column: start.character + 1,
    message:
      "Use static Node imports that do not expose runtime module-loader APIs; loader access can hide repository dependencies.",
  };
}

function runtimeLoaderViolation(
  sourceFile,
  modulePath,
  node,
  loaderKind,
  indirect,
) {
  const start = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile, false),
  );
  const workerLoader = loaderKind === "importScripts";
  const commonJs = loaderKind !== "import" && !workerLoader;
  const untracedLocalLoader =
    loaderKind === "module.require" ||
    loaderKind === "createRequire" ||
    workerLoader;
  return {
    kind: workerLoader
      ? "UNTRACEABLE WORKER LOADER"
      : commonJs
        ? "UNTRACEABLE COMMONJS LOADER"
        : "NONLITERAL RUNTIME IMPORT",
    rule: "runtime-imports-resolve",
    from: modulePath,
    line: start.line + 1,
    column: start.character + 1,
    message: indirect
      ? workerLoader
        ? "Call importScripts directly with literal external URLs only; aliases can hide repository dependencies and cycles."
        : "Call the CommonJS loader directly with one literal specifier; aliases and indirect calls cannot be audited for dependencies or cycles."
      : untracedLocalLoader
        ? workerLoader
          ? "Use a static import for repository-local worker scripts; dependency analysis cannot trace importScripts."
          : `Use a static import or direct require() for repository-local modules; dependency analysis cannot trace ${loaderKind}.`
        : `Use one literal ${loaderKind} specifier so architecture dependencies and cycles can be resolved statically.`,
  };
}

function callViolation(sourceFile, modulePath, node, bindings) {
  if (!ts.isCallExpression(node)) return undefined;
  const loaderKind = runtimeLoaderKind(node.expression, bindings);
  if (!loaderKind) return undefined;
  const specifier =
    node.arguments.length === 1 && !node.questionDotToken
      ? literalModuleSpecifier(node.arguments[0])
      : undefined;
  const dependencyCruiserTracesLoader =
    loaderKind === "import" || loaderKind === "require";
  if (specifier !== undefined && dependencyCruiserTracesLoader)
    return undefined;
  if (
    specifier !== undefined &&
    !dependencyCruiserTracesLoader &&
    !isRepositoryModuleSpecifier(specifier)
  )
    return undefined;
  return runtimeLoaderViolation(
    sourceFile,
    modulePath,
    node,
    loaderKind,
    false,
  );
}

function indirectRequireViolation(sourceFile, modulePath, node, bindings) {
  if (
    !isUnboundIdentifier(node, "require", bindings) ||
    !isIdentifierReference(node)
  )
    return undefined;
  if (isDirectCallee(node) || isSafeRequireMetadataUse(node)) {
    return undefined;
  }
  return runtimeLoaderViolation(sourceFile, modulePath, node, "require", true);
}

function indirectModuleRequireViolation(
  sourceFile,
  modulePath,
  node,
  bindings,
) {
  if (
    (!ts.isPropertyAccessExpression(node) &&
      !ts.isElementAccessExpression(node)) ||
    commonJsLoaderKind(node, bindings) !== "module.require" ||
    isDirectCallee(node)
  ) {
    return undefined;
  }
  return runtimeLoaderViolation(
    sourceFile,
    modulePath,
    node,
    "module.require",
    true,
  );
}

function indirectWorkerLoaderViolation(sourceFile, modulePath, node, bindings) {
  if (
    workerLoaderKind(node, bindings) !== "importScripts" ||
    (ts.isIdentifier(node) && !isIdentifierReference(node)) ||
    isDirectCallee(node) ||
    ts.isTypeOfExpression(expressionEnvelope(node).parent)
  ) {
    return undefined;
  }
  return runtimeLoaderViolation(
    sourceFile,
    modulePath,
    node,
    "importScripts",
    true,
  );
}

function indirectNodeGlobalViolation(
  sourceFile,
  modulePath,
  node,
  bindings,
  options,
) {
  const { globalName, isSafeUse } = options;
  if (
    !isUnboundIdentifier(node, globalName, bindings) ||
    !isIdentifierReference(node) ||
    isSafeUse(node)
  ) {
    return undefined;
  }
  return runtimeLoaderViolation(sourceFile, modulePath, node, globalName, true);
}

function indirectNodeGlobalObjectViolation(
  sourceFile,
  modulePath,
  node,
  bindings,
  options,
) {
  const { globalNames, isSafeUse } = options;
  if (
    !isUnboundIdentifierIn(node, globalNames, bindings) ||
    !isIdentifierReference(node) ||
    isSafeUse(node)
  ) {
    return undefined;
  }
  return runtimeLoaderViolation(sourceFile, modulePath, node, node.text, true);
}

export function findNonliteralRuntimeImports(source, modulePath) {
  const sourceFile = ts.createSourceFile(
    modulePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(modulePath),
  );
  const violations = [];
  const bindings = createLexicalBindingProvenance(sourceFile);
  const visit = (node) => {
    const violation =
      nodeLoaderApiViolation(sourceFile, modulePath, node, bindings) ??
      codeGenerationViolationForNode(sourceFile, modulePath, node, bindings) ??
      callViolation(sourceFile, modulePath, node, bindings) ??
      indirectRequireViolation(sourceFile, modulePath, node, bindings) ??
      indirectModuleRequireViolation(sourceFile, modulePath, node, bindings) ??
      indirectWorkerLoaderViolation(sourceFile, modulePath, node, bindings) ??
      indirectNodeGlobalViolation(
        sourceFile,
        modulePath,
        node,
        bindings,
        MODULE_GLOBAL_LOADER,
      ) ??
      indirectNodeGlobalViolation(
        sourceFile,
        modulePath,
        node,
        bindings,
        PROCESS_GLOBAL_LOADER,
      ) ??
      indirectNodeGlobalObjectViolation(
        sourceFile,
        modulePath,
        node,
        bindings,
        NODE_GLOBAL_OBJECT_LOADER,
      );
    if (violation) violations.push(violation);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [
    ...new Map(
      violations.map((violation) => [
        `${violation.kind}\u0000${violation.line}\u0000${violation.column}`,
        violation,
      ]),
    ).values(),
  ];
}

function safeModulePath(rootDir, modulePath) {
  const root = path.resolve(rootDir);
  const absolutePath = path.resolve(
    root,
    ...modulePath.replaceAll("\\", "/").split("/"),
  );
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      `Architecture source path escapes the repository: ${modulePath}`,
    );
  }
  return absolutePath;
}

export async function scanNonliteralRuntimeImports({ rootDir, modulePaths }) {
  const violations = [];
  for (const modulePath of [...new Set(modulePaths)].sort()) {
    const source = await readFile(safeModulePath(rootDir, modulePath), "utf8");
    violations.push(...findNonliteralRuntimeImports(source, modulePath));
  }
  return violations;
}
