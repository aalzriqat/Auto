// SCRUM-426 (SCRUM-418 section 6) — public Convex function detection for the
// validator (guardrail 11) and tenant-builder (guardrail 9) counters.
//
// A public function is an EXPORTED value built by a public builder (`query`,
// `mutation`, `action`, never `internal*`) that the file imported from
// convex/_generated/server or from the repo wrappers in convex/functions.ts.
// Builders are resolved from the imports, so `mutation as define`, a namespace
// import and a wrapper path like `../functions` are all followed, and a local
// function that merely shares the name is not mistaken for a builder.
// Docs: https://docs.convex.dev/functions/validation (args and returns validators)
//       https://docs.convex.dev/understanding/best-practices/ (validate every public function)
import ts from "typescript";

import { skipWrappers } from "./astCounts.mjs";
import { resolveSpecifier } from "./rules.mjs";

const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/u;

const GENERATED_SERVER = {
  query: { kind: "query", tenant: false },
  mutation: { kind: "mutation", tenant: false },
  action: { kind: "action", tenant: false },
};
// orgQuery / orgMutation are the tenant builders that arrive with SCRUM-418
// section 4; they are listed now so the counters are already right on that day.
const FUNCTIONS_MODULE = {
  ...GENERATED_SERVER,
  socialBulkMutation: { kind: "mutation", tenant: false },
  orgQuery: { kind: "query", tenant: true },
  orgMutation: { kind: "mutation", tenant: true },
};
const BUILDER_MODULES = new Map([
  ["convex/_generated/server", GENERATED_SERVER],
  ["convex/functions", FUNCTIONS_MODULE],
]);

function importedBuilders(sourceFile, filePath) {
  const named = new Map();
  const namespaces = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const resolved = resolveSpecifier(filePath, statement.moduleSpecifier.text);
    const table = resolved.kind === "repo" ? BUILDER_MODULES.get(resolved.id) : undefined;
    if (!table || !clause.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) namespaces.set(clause.namedBindings.name.text, table);
    else {
      for (const element of clause.namedBindings.elements) {
        const builder = table[(element.propertyName ?? element.name).text];
        if (builder && !element.isTypeOnly) named.set(element.name.text, builder);
      }
    }
  }
  return { named, namespaces };
}

/** `export { a, b as c }` without a module specifier: local name -> the names it is exported as. */
function locallyExportedNames(sourceFile) {
  const names = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause &&
      ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const local = (element.propertyName ?? element.name).text;
        names.set(local, [...(names.get(local) ?? []), element.name.text]);
      }
    }
  }
  return names;
}

function hasModifier(node, kind) {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((m) => m.kind === kind);
}

function unwrapExpression(node) {
  let current = skipWrappers(node);
  while (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) {
    current = skipWrappers(current.expression);
  }
  return current;
}

/** The builder a call expression invokes, or undefined when it is not a public builder. */
function builderOf(call, imports) {
  const callee = skipWrappers(call.expression);
  if (ts.isIdentifier(callee)) return imports.named.get(callee.text);
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    return imports.namespaces.get(callee.expression.text)?.[callee.name.text];
  }
  return undefined;
}

/** True only when the config is an object literal that states the property outright. */
function declares(call, property) {
  const config = call.arguments[0] ? skipWrappers(call.arguments[0]) : undefined;
  if (!config || !ts.isObjectLiteralExpression(config)) return false;
  return config.properties.some(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
      p.name.text === property,
  );
}

/**
 * Every public function a file registers, keyed like Convex addresses it:
 * module path (no extension) + ":" + export name.
 * @returns {Array<{ key: string, kind: string, tenant: boolean, hasArgs: boolean, hasReturns: boolean }>}
 */
export function listPublicFunctions(sourceFile, filePath) {
  const functions = [];
  const imports = importedBuilders(sourceFile, filePath);
  if (imports.named.size === 0 && imports.namespaces.size === 0) return functions;
  const exportedAs = locallyExportedNames(sourceFile);
  const modulePath = filePath.replace(SOURCE_EXTENSION, "");
  const record = (call, exportName) => {
    const builder = builderOf(call, imports);
    if (!builder) return;
    functions.push({
      key: `${modulePath}:${exportName}`,
      kind: builder.kind,
      tenant: builder.tenant,
      hasArgs: declares(call, "args"),
      hasReturns: declares(call, "returns"),
    });
  };
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer || !ts.isIdentifier(declaration.name)) continue;
        const names = [...(isExported ? [declaration.name.text] : []), ...(exportedAs.get(declaration.name.text) ?? [])];
        const value = unwrapExpression(declaration.initializer);
        if (ts.isCallExpression(value)) for (const name of new Set(names)) record(value, name);
      }
    } else if (ts.isExportAssignment(statement)) {
      const value = unwrapExpression(statement.expression);
      if (ts.isCallExpression(value)) record(value, "default");
    }
  }
  return functions;
}

/**
 * @returns {{ "public-functions": number, "no-args-validator": number,
 *   "no-returns-validator": number, "non-tenant-builder": number }}
 */
export function countPublicFunctions(sourceFile, filePath) {
  const counts = { "public-functions": 0, "no-args-validator": 0, "no-returns-validator": 0, "non-tenant-builder": 0 };
  for (const fn of listPublicFunctions(sourceFile, filePath)) {
    counts["public-functions"] += 1;
    if (!fn.hasArgs) counts["no-args-validator"] += 1;
    if (!fn.hasReturns) counts["no-returns-validator"] += 1;
    if (fn.kind !== "action" && !fn.tenant) counts["non-tenant-builder"] += 1;
  }
  return counts;
}
