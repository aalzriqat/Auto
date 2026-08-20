import path from "node:path";

import ts from "typescript";

import { moduleText, normalizePath, parseSource } from "./ast-utils.mjs";

const AGGREGATE_PACKAGE = "@convex-dev/aggregate";

function withoutExtension(file) {
  return normalizePath(file).replace(/\.(?:[cm]?[jt]sx?)$/u, "");
}

function moduleAliases(records) {
  const aliases = new Map();
  for (const record of records) {
    const key = withoutExtension(record.file);
    aliases.set(key, record.file);
    if (key.endsWith("/index")) aliases.set(key.slice(0, -6), record.file);
  }
  return aliases;
}

function resolveModule(fromFile, specifier, aliases) {
  if (!specifier.startsWith(".")) return undefined;
  const fromDirectory = path.posix.dirname(withoutExtension(fromFile));
  const key = path.posix.normalize(path.posix.join(fromDirectory, specifier));
  return aliases.get(withoutExtension(key));
}

function addAll(target, names) {
  let changed = false;
  for (const name of names) {
    if (!target.has(name)) {
      target.add(name);
      changed = true;
    }
  }
  return changed;
}

function packageExportNames(statement) {
  const names = new Set();
  if (!statement.exportClause) {
    names.add("TableAggregate");
    return names;
  }
  if (!ts.isNamedExports(statement.exportClause)) return names;
  for (const element of statement.exportClause.elements) {
    if ((element.propertyName ?? element.name).text === "TableAggregate") {
      names.add(element.name.text);
    }
  }
  return names;
}

function targetExportsForImport(specifier, file, exportsByFile, aliases) {
  const target = specifier
    ? resolveModule(file, specifier, aliases)
    : undefined;
  return target ? exportsByFile.get(target) : undefined;
}

function addNamedImports(bindings, specifier, targetExports, direct) {
  if (!ts.isNamedImports(bindings)) return;
  for (const element of bindings.elements) {
    if (element.isTypeOnly) continue;
    const importedName = (element.propertyName ?? element.name).text;
    const fromPackage =
      specifier === AGGREGATE_PACKAGE && importedName === "TableAggregate";
    if (fromPackage || targetExports?.has(importedName)) {
      direct.add(element.name.text);
    }
  }
}

function addConstructorImport(statement, context, imports) {
  if (
    !ts.isImportDeclaration(statement) ||
    statement.importClause?.isTypeOnly
  ) {
    return;
  }
  const specifier = moduleText(statement.moduleSpecifier);
  const targetExports = targetExportsForImport(
    specifier,
    context.file,
    context.exportsByFile,
    context.aliases,
  );
  if (statement.importClause?.name && targetExports?.has("default")) {
    imports.direct.add(statement.importClause.name.text);
  }
  const bindings = statement.importClause?.namedBindings;
  if (!bindings) return;
  if (ts.isNamespaceImport(bindings) && targetExports?.size) {
    imports.namespaces.set(bindings.name.text, new Set(targetExports));
    return;
  }
  addNamedImports(bindings, specifier, targetExports, imports.direct);
}

function importedConstructors(ast, file, exportsByFile, aliases) {
  const imports = { direct: new Set(), namespaces: new Map() };
  const context = { file, exportsByFile, aliases };
  for (const statement of ast.statements) {
    addConstructorImport(statement, context, imports);
  }
  return imports;
}

function localExportNames(statement, imports) {
  const names = new Set();
  if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
    return names;
  }
  for (const element of statement.exportClause.elements) {
    const localName = (element.propertyName ?? element.name).text;
    if (imports.direct.has(localName)) names.add(element.name.text);
  }
  return names;
}

function reexportNames(statement, file, exportsByFile, aliases) {
  const specifier = statement.moduleSpecifier
    ? moduleText(statement.moduleSpecifier)
    : undefined;
  if (!specifier) return undefined;
  if (specifier === AGGREGATE_PACKAGE) return packageExportNames(statement);
  const target = resolveModule(file, specifier, aliases);
  const targetExports = target ? exportsByFile.get(target) : undefined;
  if (!targetExports) return new Set();
  if (!statement.exportClause) return new Set(targetExports);
  if (!ts.isNamedExports(statement.exportClause)) return new Set();
  const names = new Set();
  for (const element of statement.exportClause.elements) {
    const importedName = (element.propertyName ?? element.name).text;
    if (targetExports.has(importedName)) names.add(element.name.text);
  }
  return names;
}

function discoverExports(parsed, exportsByFile, aliases) {
  let changed = false;
  for (const record of parsed) {
    const exported = exportsByFile.get(record.file);
    const imports = importedConstructors(
      record.ast,
      record.file,
      exportsByFile,
      aliases,
    );
    for (const statement of record.ast.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      const reexported = reexportNames(
        statement,
        record.file,
        exportsByFile,
        aliases,
      );
      changed =
        addAll(exported, reexported ?? localExportNames(statement, imports)) ||
        changed;
    }
  }
  return changed;
}

/** Resolves package constructor provenance through local named/namespace re-exports. */
export function aggregateConstructorOptions(records) {
  const parsed = records.map((record) => ({
    ...record,
    ast: parseSource(record.source, record.file),
  }));
  const aliases = moduleAliases(records);
  const exportsByFile = new Map(
    records.map((record) => [record.file, new Set()]),
  );
  while (discoverExports(parsed, exportsByFile, aliases)) {
    // Monotonic fixed point supports chains of local re-exports.
  }
  return new Map(
    parsed.map((record) => [
      record.file,
      (() => {
        const imports = importedConstructors(
          record.ast,
          record.file,
          exportsByFile,
          aliases,
        );
        return {
          constructorImports: imports.direct,
          constructorNamespaces: imports.namespaces,
        };
      })(),
    ]),
  );
}
