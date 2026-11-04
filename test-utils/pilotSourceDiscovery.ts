import path from "node:path";
import ts from "typescript";

const SWITCH_NAME = /_PILOT_(?:DISABLED|REQUIRED|REFUSED)$/;
const NON_BOOLEAN_INITIALIZERS = new Set([
  ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral, ts.SyntaxKind.NullKeyword, ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrayLiteralExpression, ts.SyntaxKind.ObjectLiteralExpression,
]);
const moduleName = (file: string): string => file.replace(/\.tsx?$/, "");

export interface SwitchDeclaration {
  readonly name: string;
  readonly kind: "constant" | "doorMap";
  readonly module: string;
  readonly value: boolean | null;
  readonly sourceId: string;
}

export interface PilotSourceDiscovery {
  readonly declarations: readonly SwitchDeclaration[];
  readonly exportedBy: ReadonlyMap<string, ReadonlySet<string>>;
  readonly guardModules: readonly string[];
}

export function unwrap(expr: ts.Expression | undefined): ts.Expression | undefined {
  let current = expr;
  while (current && (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current))) {
    current = current.expression;
  }
  return current;
}

function literalBoolean(expr: ts.Expression | undefined): boolean | null {
  const initializer = unwrap(expr);
  if (initializer?.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (initializer?.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

function variableSwitches(decl: ts.VariableDeclaration): SwitchDeclaration[] {
  if (!ts.isIdentifier(decl.name)) return [];
  const moduleId = moduleName(decl.getSourceFile().fileName);
  const initializer = unwrap(decl.initializer);
  const constant: SwitchDeclaration[] = SWITCH_NAME.test(decl.name.text)
    ? [{ name: decl.name.text, kind: "constant", module: moduleId, value: literalBoolean(initializer), sourceId: `${moduleId}:${decl.pos}` }]
    : [];
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) return constant;
  const doorMap = initializer.properties.flatMap((prop) => {
    if (!ts.isPropertyAssignment(prop)) return [];
    if (!(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) || !SWITCH_NAME.test(prop.name.text)) return [];
    const value = unwrap(prop.initializer);
    if (value && NON_BOOLEAN_INITIALIZERS.has(value.kind)) return [];
    return [{ name: prop.name.text, kind: "doorMap" as const, module: moduleId, value: literalBoolean(prop.initializer), sourceId: `${moduleId}:${prop.pos}` }];
  });
  return doorMap.length > 0 ? doorMap : constant;
}

function resolveSource(specifier: string, from: string, sources: ReadonlyMap<string, string>): string | undefined {
  let target: string;
  if (specifier.startsWith("@/")) target = specifier.slice(2);
  else if (specifier.startsWith(".")) target = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)).replace(/^\//, "");
  else return undefined;
  const base = target.replace(/\.[cm]?[jt]sx?$/, "");
  return [target, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, `${base}/index.ts`].find((file) => sources.has(file));
}

interface CachedProgram {
  readonly sources: ReadonlyMap<string, string>;
  readonly program: ts.Program;
}

// Vitest resets modules while installing negative-control mocks. Keep compiler data across
// those resets, but compare source contents on every call. Retain at most two root sets.
const worker = globalThis as typeof globalThis & { autoflowPilotPrograms?: Map<string, CachedProgram> };
const programs = worker.autoflowPilotPrograms ??= new Map<string, CachedProgram>();

function previousProgram(key: string, size: number): CachedProgram | undefined {
  return programs.get(key) ?? [...programs.values()].sort((a, b) =>
    Math.abs(a.sources.size - size) - Math.abs(b.sources.size - size))[0];
}

/** Resolve only within the supplied source snapshot. Reuse unchanged text, never stale file lists. */
export function sourceProgram(sources: ReadonlyMap<string, string>): ts.Program {
  const key = JSON.stringify([...sources.keys()]);
  const previous = previousProgram(key, sources.size);
  if (previous && sources.size === previous.sources.size &&
    [...sources].every(([file, text]) => previous.sources.get(file) === text)) return previous.program;
  const options: ts.CompilerOptions = { noLib: true, types: [], target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => "/";
  host.getSourceFile = (file) => {
    const text = sources.get(file);
    if (text === undefined) return undefined;
    const oldSource = previous?.program.getSourceFile(file);
    return oldSource?.text === text ? oldSource : ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  };
  host.fileExists = (file) => sources.has(file);
  host.readFile = (file) => sources.get(file);
  host.resolveModuleNames = (specifiers, from) => specifiers.map((specifier) => {
    const resolvedFileName = resolveSource(specifier, from, sources);
    return resolvedFileName ? { resolvedFileName } : undefined;
  });
  const program = ts.createProgram([...sources.keys()], options, host, previous?.program);
  programs.delete(key);
  programs.set(key, { sources: new Map(sources), program });
  if (programs.size > 2) programs.delete(programs.keys().next().value!);
  return program;
}

function originalSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function exportedBinding(symbol: ts.Symbol, declaration: ts.Declaration, value: boolean | null): SwitchDeclaration[] {
  if (!SWITCH_NAME.test(symbol.name)) return [];
  const moduleId = moduleName(declaration.getSourceFile().fileName);
  return [{ name: symbol.name, kind: "constant", module: moduleId, value, sourceId: `${moduleId}:${declaration.pos}:${symbol.name}` }];
}

function variableExports(symbol: ts.Symbol, original: ts.Symbol, checker: ts.TypeChecker, visited: Set<ts.Symbol>): SwitchDeclaration[] {
  const declaration = original.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) return [];
  // Binding elements include nested array/object patterns. Defaults are not evidence of the actual value.
  if (!ts.isVariableDeclaration(declaration)) return exportedBinding(symbol, declaration, null);
  const initializer = unwrap(declaration.initializer);
  const target = initializer && checker.getSymbolAtLocation(initializer);
  const referenced = target ? switchesBehind(target, checker, visited) : [];
  const aliases = symbol.name !== original.name ? exportedBinding(symbol, declaration, literalBoolean(initializer)) : [];
  return [...aliases, ...referenced, ...variableSwitches(declaration)];
}

/** Follow compiler-resolved aliases and enumerate exported binding elements without evaluating code. */
function switchesBehind(symbol: ts.Symbol, checker: ts.TypeChecker, visited = new Set<ts.Symbol>()): SwitchDeclaration[] {
  const original = originalSymbol(symbol, checker);
  if (visited.has(symbol)) return [];
  visited.add(symbol);
  if (original.flags & ts.SymbolFlags.Module) {
    return checker.getExportsOfModule(original).flatMap((entry) => switchesBehind(entry, checker, visited));
  }
  return variableExports(symbol, original, checker, visited);
}

/** Every source is inspected. Export structure and compiler symbols decide inclusion. */
export function discoverPilotSources(sources: ReadonlyMap<string, string>, guardNames: ReadonlySet<string>): PilotSourceDiscovery {
  const program = sourceProgram(sources);
  const checker = program.getTypeChecker();
  const declarations = new Map<string, SwitchDeclaration>();
  const exportedBy = new Map<string, Set<string>>();
  const guardModules = new Set<string>();
  for (const file of program.getSourceFiles()) {
    const symbol = checker.getSymbolAtLocation(file);
    if (!symbol) continue;
    const moduleId = moduleName(file.fileName);
    for (const entry of checker.getExportsOfModule(symbol)) {
      if (guardNames.has(originalSymbol(entry, checker).name)) guardModules.add(moduleId);
      for (const declaration of switchesBehind(entry, checker)) {
        declarations.set(declaration.sourceId, declaration);
        const modules = exportedBy.get(declaration.name) ?? new Set<string>();
        modules.add(moduleId);
        exportedBy.set(declaration.name, modules);
      }
    }
  }
  return { declarations: [...declarations.values()], exportedBy, guardModules: [...guardModules] };
}

function moduleExports(file: ts.SourceFile, checker: ts.TypeChecker): ts.Symbol[] {
  const symbol = checker.getSymbolAtLocation(file);
  return symbol ? checker.getExportsOfModule(symbol) : [];
}

function resolvedSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && originalSymbol(symbol, checker);
}

function publicMutationHandler(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Node | undefined {
  const decl = originalSymbol(symbol, checker).valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl)) return undefined;
  const call = unwrap(decl.initializer);
  if (!call || !ts.isCallExpression(call)) return undefined;
  const builder = resolvedSymbol(call.expression, checker);
  const file = builder?.valueDeclaration?.getSourceFile().fileName;
  const publicBuilder = (file === "convex/functions.ts" && ["mutation", "socialBulkMutation"].includes(builder?.name ?? "")) ||
    (file === "convex/_generated/server.d.ts" && builder?.name === "mutation");
  if (!publicBuilder) return undefined;
  const config = unwrap(call.arguments[0]);
  if (!config || !ts.isObjectLiteralExpression(config)) return undefined;
  return config.properties.find((prop) => prop.name && prop.name.getText() === "handler");
}

function pilotDependencies(handler: ts.Node, checker: ts.TypeChecker, dependencies: ReadonlyMap<ts.Symbol, string>): string[] {
  const found = new Set<string>();
  function visit(node: ts.Node): void {
    const reference = ts.isCallExpression(node) ? node.expression : node;
    const symbol = resolvedSymbol(reference, checker);
    const name = symbol && dependencies.get(symbol);
    if (name && (ts.isCallExpression(node) || SWITCH_NAME.test(name))) found.add(name);
    ts.forEachChild(node, visit);
  }
  visit(handler);
  return [...found].sort();
}

function pilotSymbols(files: readonly ts.SourceFile[], checker: ts.TypeChecker): ReadonlyMap<ts.Symbol, string> {
  const dependencies = new Map<ts.Symbol, string>();
  for (const file of files) {
    for (const entry of moduleExports(file, checker)) {
      const symbol = originalSymbol(entry, checker);
      const guard = /^convex\/utils\/[^/]*Containment\.ts$/.test(file.fileName) && /^assert\w*(?:Allowed|Enabled)$/.test(symbol.name);
      if (guard || SWITCH_NAME.test(entry.name)) dependencies.set(symbol, entry.name);
    }
  }
  return dependencies;
}

/** Public mutation handlers calling containment guards or directly reading exported pilot switches. */
export function discoverGuardedPilotMutations(sources: ReadonlyMap<string, string>): ReadonlyMap<string, readonly string[]> {
  const program = sourceProgram(sources);
  const checker = program.getTypeChecker();
  const files = program.getSourceFiles();
  const dependencies = pilotSymbols(files, checker);
  const doors = new Map<string, readonly string[]>();
  for (const file of files.filter((source) => /^convex\/[^/]+\.ts$/.test(source.fileName) && !/\.(?:test|spec)\.ts$/.test(source.fileName))) {
    for (const symbol of moduleExports(file, checker)) {
      const handler = publicMutationHandler(symbol, checker);
      const calls = handler ? pilotDependencies(handler, checker, dependencies) : [];
      if (calls.length > 0) doors.set(`${path.posix.basename(file.fileName, ".ts")}.${symbol.name}`, calls);
    }
  }
  return doors;
}
