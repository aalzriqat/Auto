/**
 * Resolve the declaration owning a registered backend export, without walking
 * its dependencies. Named re-exports, imported/local aliases and namespace
 * members follow TypeScript symbols. Missing, cyclic, ambiguous, declaration-only
 * or computed definitions refuse. Calls (including custom registration factories)
 * belong to their declaration file; the factory/handler implementation is outside
 * this narrow evidence check. This is source attribution, not runtime certification.
 */
import path from "node:path";
import ts from "typescript";
import { createClientProgram } from "./clientPaths.mjs";
import { toPosixRel } from "./clientFiles.mjs";

/** @param {string} functionId @returns {string | undefined} */
const definitionModuleOf = (functionId) => {
  const match = /^([A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*):([A-Za-z0-9_]+)$/.exec(String(functionId));
  return match ? `convex/${match[1]}.ts` : undefined;
};

/** @param {{ root: string, functionIds: string[], tsconfig?: string }} options */
export function createBackendDefinitionResolver({ root, functionIds, tsconfig = "convex/tsconfig.json" }) {
  const modules = [...new Set(functionIds.map(definitionModuleOf).filter((file) => file !== undefined))];
  const program = createClientProgram(modules.map((file) => path.resolve(root, file)), path.resolve(root, tsconfig));
  const checker = program.getTypeChecker();

  /** @param {import("typescript").Node} node */
  const unwrap = (node) => {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isExpressionWithTypeArguments(node)) node = node.expression;
    return node;
  };
  /** @param {import("typescript").Declaration} declaration */
  const supportedAliasModule = (declaration) => {
    /** @type {import("typescript").Node | undefined} */
    let statement = declaration;
    while (statement && !ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) statement = statement.parent;
    if (!statement?.moduleSpecifier) return true;
    const target = checker.getSymbolAtLocation(statement.moduleSpecifier);
    const sources = target?.getDeclarations() ?? [];
    return sources.length === 1 && ts.isSourceFile(sources[0]) && !unsupportedSource(sources[0]);
  };
  /** @param {import("typescript").Symbol | undefined} symbol @param {Set<import("typescript").Symbol>} seen @returns {string | undefined} */
  const definitionFile = (symbol, seen) => {
    if (!symbol || seen.has(symbol)) return undefined;
    seen.add(symbol);
    const declarations = symbol.getDeclarations() ?? [];
    if (declarations.length !== 1) return undefined;
    const declaration = declarations[0];
    const source = declaration.getSourceFile();
    if (source.isDeclarationFile || unsupportedSource(source)) return undefined;
    if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      return supportedAliasModule(declaration) ? definitionFile(checker.getImmediateAliasedSymbol(symbol), seen) : undefined;
    }
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
    const initializer = unwrap(declaration.initializer);
    if (ts.isPropertyAccessExpression(initializer)) {
      const receiver = checker.getSymbolAtLocation(unwrap(initializer.expression))?.getDeclarations();
      if (receiver?.length !== 1 || !ts.isNamespaceImport(receiver[0]) || !supportedAliasModule(receiver[0])) return undefined;
    }
    if (ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer)) {
      return definitionFile(checker.getSymbolAtLocation(initializer), seen);
    }
    if (!ts.isCallExpression(initializer) || initializer.expression.kind === ts.SyntaxKind.ImportKeyword) return undefined;
    const relative = toPosixRel(root, source.fileName);
    return relative.startsWith("../") || path.isAbsolute(relative) || relative.includes("node_modules/") ? undefined : relative;
  };
  /** @param {import("typescript").SourceFile} source */
  const unsupportedSource = (source) => program.getSyntacticDiagnostics(source).length > 0 || source.statements.some((statement) =>
    ts.isExportDeclaration(statement) && !statement.exportClause);
  /** @type {Map<string, { file?: string, unresolved: string[] }>} */
  const cache = new Map();
  /** @param {string} functionId @returns {{ file?: string, unresolved: string[] }} */
  return (functionId) => {
    const cached = cache.get(functionId);
    if (cached) return cached;
    const moduleFile = definitionModuleOf(functionId);
    const source = moduleFile ? program.getSourceFile(path.resolve(root, moduleFile)) : undefined;
    // A star export can collide with another export without a syntax error;
    // refuse instead of letting checker.getExportsOfModule choose one target.
    const unsupported = source && unsupportedSource(source);
    const moduleSymbol = source && !unsupported ? checker.getSymbolAtLocation(source) : undefined;
    const exported = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === functionId.split(":")[1]);
    const file = definitionFile(exported, new Set());
    const resolved = file ? { file, unresolved: [] } : { unresolved: [`cannot resolve backend definition ${functionId}`] };
    cache.set(functionId, resolved);
    return resolved;
  };
}
