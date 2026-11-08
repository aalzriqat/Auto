// SCRUM-426 (SCRUM-418 section 6) — public Convex function detection for the
// validator (guardrail 11), tenant-builder (guardrail 9) and door (guardrail 5)
// rules.
//
// A public function is an EXPORTED value built by a public builder (`query`,
// `mutation`, `action`, never `internal*`). Builders are resolved from imports,
// never from a name, so `mutation as define`, a namespace import and a wrapper
// path like `../functions` are followed, and a local function that merely shares
// a name is not mistaken for a builder.
//
// Builders made with convex-helpers (`customQuery`, `customMutation`,
// `customAction`) are public builders too when their base builder is public:
// `const authed = customQuery(query, ...)` binds `authed`, and `authed({...})`
// registers a public function. Plain aliases (`const q = query`), re-exports
// (`export { a as b }`, `export { a } from`, `export *`) and imports of any of
// those from another repo module are followed across files, so resolution works
// on a whole tree: `extractFacts` reads one file, `resolvePublicFunctions`
// resolves a set of files together. A factory FUNCTION that returns a custom
// builder (convex/aggregates.ts createSocialBulkMutation) is not followed; the
// one in the repo is listed in FUNCTIONS_MODULE.
// Docs: https://docs.convex.dev/functions/validation (args and returns validators)
//       https://docs.convex.dev/understanding/best-practices/ (validate every public function)
//       https://stack.convex.dev/custom-functions (customQuery / customMutation / customAction)
import { createHash } from "node:crypto";

import ts from "typescript";

import { parseSource, skipWrappers } from "./astCounts.mjs";
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

const CUSTOM_FUNCTIONS_PACKAGE = "convex-helpers/server/customFunctions";
const CUSTOM_FACTORIES = { customQuery: "query", customMutation: "mutation", customAction: "action" };

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

/** `name` or `namespace.name`, the only reference shapes that can name a builder. */
function refOf(node) {
  if (!node) return null;
  const current = unwrapExpression(node);
  if (ts.isIdentifier(current)) return { name: current.text };
  if (ts.isPropertyAccessExpression(current) && ts.isIdentifier(current.expression)) {
    return { ns: current.expression.text, name: current.name.text };
  }
  return null;
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

/** What a top-level initializer is, as far as builder resolution cares. */
function initOf(expression) {
  const value = unwrapExpression(expression);
  if (ts.isCallExpression(value)) {
    return {
      type: "call",
      callee: refOf(value.expression),
      firstArg: refOf(value.arguments[0]),
      hasArgs: declares(value, "args"),
      hasReturns: declares(value, "returns"),
    };
  }
  const ref = refOf(value);
  return ref ? { type: "ref", ref } : null;
}

const factsCache = new Map();

/**
 * The builder-relevant facts of one file, as plain data. Cached by path + text
 * so a file unchanged between two trees is parsed once.
 */
export function extractFacts(filePath, text) {
  const key = createHash("sha256").update(filePath).update("\0").update(text).digest("hex");
  let facts = factsCache.get(key);
  if (!facts) factsCache.set(key, (facts = readFacts(filePath, parseSource(filePath, text))));
  return facts;
}

function readFacts(filePath, sourceFile) {
  const keyBase = filePath.replace(SOURCE_EXTENSION, "");
  const facts = {
    keyBase,
    moduleId: keyBase.replace(/\/index$/u, ""),
    imports: new Map(), // local -> { from: { repo: boolean, id }, imported }
    declarations: new Map(), // local -> { exported: boolean, init }
    localExports: [], // { local, exported }
    reExports: [], // { from, imported, exported }
    starExports: [], // from
  };
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      readImport(facts, filePath, statement);
    } else if (ts.isVariableStatement(statement)) {
      const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
      for (const declaration of statement.declarationList.declarations) {
        if (!declaration.initializer || !ts.isIdentifier(declaration.name)) continue;
        facts.declarations.set(declaration.name.text, { exported, init: initOf(declaration.initializer) });
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      facts.declarations.set("default", { exported: true, init: initOf(statement.expression) });
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      readExport(facts, filePath, statement);
    }
  }
  return facts;
}

function moduleRef(filePath, specifier) {
  const resolved = resolveSpecifier(filePath, specifier);
  return { repo: resolved.kind === "repo", id: resolved.id };
}

function readImport(facts, filePath, statement) {
  const clause = statement.importClause;
  if (!clause || clause.isTypeOnly) return;
  const from = moduleRef(filePath, statement.moduleSpecifier.text);
  if (clause.name) facts.imports.set(clause.name.text, { from, imported: "default" });
  if (!clause.namedBindings) return;
  if (ts.isNamespaceImport(clause.namedBindings)) {
    facts.imports.set(clause.namedBindings.name.text, { from, imported: "*" });
    return;
  }
  for (const element of clause.namedBindings.elements) {
    if (!element.isTypeOnly) facts.imports.set(element.name.text, { from, imported: (element.propertyName ?? element.name).text });
  }
}

function readExport(facts, filePath, statement) {
  const clause = statement.exportClause;
  if (!statement.moduleSpecifier) {
    if (!clause || !ts.isNamedExports(clause)) return;
    for (const element of clause.elements) {
      if (!element.isTypeOnly) facts.localExports.push({ local: (element.propertyName ?? element.name).text, exported: element.name.text });
    }
    return;
  }
  if (!ts.isStringLiteral(statement.moduleSpecifier)) return;
  const from = moduleRef(filePath, statement.moduleSpecifier.text);
  if (!from.repo) return;
  if (!clause) facts.starExports.push(from.id);
  else if (ts.isNamedExports(clause)) {
    for (const element of clause.elements) {
      if (!element.isTypeOnly) facts.reExports.push({ from: from.id, imported: (element.propertyName ?? element.name).text, exported: element.name.text });
    }
  }
}

/**
 * Resolve builders and public functions for a set of files together.
 * @param {Map<string, ReturnType<typeof extractFacts>>} factsByPath
 * @returns {Map<string, Array<{ key: string, kind: string, tenant: boolean, hasArgs: boolean, hasReturns: boolean }>>}
 *   path -> the public functions the file registers (keyed module path + ":" + export name)
 */
export function resolvePublicFunctions(factsByPath) {
  const modules = new Map([...factsByPath.values()].map((facts) => [facts.moduleId, facts]));
  const resolver = createResolver(modules);
  const result = new Map();
  for (const [filePath, facts] of factsByPath) result.set(filePath, resolver.functionsOf(facts));
  return result;
}

function createResolver(modules) {
  /** The builder a `custom*` factory call produces, or undefined. */
  function customBuilder(facts, init, seen) {
    if (init.type !== "call" || !init.callee) return undefined;
    const kind = customFactoryKind(facts, init.callee);
    if (!kind) return undefined;
    const base = init.firstArg && builderOfRef(facts, init.firstArg, seen);
    return base ? { kind, tenant: base.tenant } : undefined;
  }

  function customFactoryKind(facts, callee) {
    const binding = facts.imports.get(callee.ns ?? callee.name);
    if (!binding || binding.from.repo || binding.from.id !== CUSTOM_FUNCTIONS_PACKAGE) return undefined;
    if (callee.ns) return binding.imported === "*" ? CUSTOM_FACTORIES[callee.name] : undefined;
    return CUSTOM_FACTORIES[binding.imported];
  }

  function builderOfInit(facts, init, seen) {
    if (!init) return undefined;
    if (init.type === "ref") return builderOfRef(facts, init.ref, seen);
    return customBuilder(facts, init, seen);
  }

  function builderOfRef(facts, ref, seen) {
    if (ref.ns) {
      const binding = facts.imports.get(ref.ns);
      if (!binding || binding.imported !== "*" || !binding.from.repo) return undefined;
      return exportedBuilder(binding.from.id, ref.name, seen);
    }
    const guard = `${facts.moduleId}#${ref.name}`;
    if (seen.has(guard)) return undefined;
    const declaration = facts.declarations.get(ref.name);
    if (declaration) return builderOfInit(facts, declaration.init, new Set(seen).add(guard));
    const binding = facts.imports.get(ref.name);
    if (!binding || !binding.from.repo || binding.imported === "*") return undefined;
    return exportedBuilder(binding.from.id, binding.imported, new Set(seen).add(guard));
  }

  /** The builder a module exports under `name`, or undefined. */
  function exportedBuilder(moduleId, name, seen) {
    const guard = `${moduleId}:${name}`;
    if (seen.has(guard)) return undefined;
    const next = new Set(seen).add(guard);
    const table = BUILDER_MODULES.get(moduleId);
    if (table && Object.hasOwn(table, name)) return table[name];
    const facts = modules.get(moduleId);
    if (!facts) return undefined;
    const declaration = facts.declarations.get(name);
    if (declaration?.exported && name !== "default") return builderOfInit(facts, declaration.init, next);
    if (name === "default" && declaration) return builderOfInit(facts, declaration.init, next);
    for (const entry of facts.localExports) {
      if (entry.exported === name) return builderOfRef(facts, { name: entry.local }, next);
    }
    for (const entry of facts.reExports) {
      if (entry.exported === name) return exportedBuilder(entry.from, entry.imported, next);
    }
    if (name === "default") return undefined;
    for (const from of facts.starExports) {
      const found = exportedBuilder(from, name, next);
      if (found) return found;
    }
    return undefined;
  }

  function functionsOf(facts) {
    const exportedNames = new Map();
    const exportAs = (local, exported) => exportedNames.set(local, [...(exportedNames.get(local) ?? []), exported]);
    for (const [local, declaration] of facts.declarations) if (declaration.exported) exportAs(local, local);
    for (const entry of facts.localExports) if (facts.declarations.has(entry.local)) exportAs(entry.local, entry.exported);
    const functions = [];
    for (const [local, names] of exportedNames) {
      const init = facts.declarations.get(local).init;
      if (init?.type !== "call" || !init.callee) continue;
      const builder = builderOfRef(facts, init.callee, new Set());
      if (!builder) continue;
      for (const name of new Set(names)) {
        functions.push({
          key: `${facts.keyBase}:${name}`,
          kind: builder.kind,
          tenant: builder.tenant,
          hasArgs: init.hasArgs,
          hasReturns: init.hasReturns,
        });
      }
    }
    return functions;
  }

  return { functionsOf };
}

/**
 * The four per-file counts of guardrails 9 and 11.
 * @returns {{ "public-functions": number, "no-args-validator": number,
 *   "no-returns-validator": number, "non-tenant-builder": number }}
 */
export function countFunctions(functions) {
  const counts = { "public-functions": 0, "no-args-validator": 0, "no-returns-validator": 0, "non-tenant-builder": 0 };
  for (const fn of functions) {
    counts["public-functions"] += 1;
    if (!fn.hasArgs) counts["no-args-validator"] += 1;
    if (!fn.hasReturns) counts["no-returns-validator"] += 1;
    if (fn.kind !== "action" && !fn.tenant) counts["non-tenant-builder"] += 1;
  }
  return counts;
}

const TOP_LEVEL_MODULE = /^convex\/[^/]+$/u;

/**
 * Doors: top-level convex/<name> modules that register at least one public
 * function. Convex exposes them to clients, so nothing in the repo imports them.
 * @param {Map<string, Array<unknown>>} functionsByPath
 * @param {Map<string, ReturnType<typeof extractFacts>>} factsByPath
 */
export function doorModules(functionsByPath, factsByPath) {
  const doors = new Set();
  for (const [filePath, functions] of functionsByPath) {
    const moduleId = factsByPath.get(filePath)?.moduleId;
    if (functions.length > 0 && moduleId && TOP_LEVEL_MODULE.test(moduleId)) doors.add(moduleId);
  }
  return doors;
}
