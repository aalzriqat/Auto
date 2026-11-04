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
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
    return SWITCH_NAME.test(decl.name.text)
      ? [{ name: decl.name.text, kind: "constant", module: moduleId, value: literalBoolean(initializer), sourceId: `${moduleId}:${decl.pos}` }]
      : [];
  }
  return initializer.properties.flatMap((prop) => {
    if (!ts.isPropertyAssignment(prop)) return [];
    if (!(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) || !SWITCH_NAME.test(prop.name.text)) return [];
    const value = unwrap(prop.initializer);
    if (value && NON_BOOLEAN_INITIALIZERS.has(value.kind)) return [];
    return [{ name: prop.name.text, kind: "doorMap" as const, module: moduleId, value: literalBoolean(prop.initializer), sourceId: `${moduleId}:${prop.pos}` }];
  });
}

/** Resolve only within the supplied source snapshot. No node_modules or compiler library reads. */
function sourceProgram(sources: ReadonlyMap<string, string>): ts.Program {
  const options: ts.CompilerOptions = { noLib: true, types: [], target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options);
  host.getCurrentDirectory = () => "/";
  host.getSourceFile = (file) => {
    const text = sources.get(file);
    return text === undefined ? undefined : ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  };
  host.fileExists = (file) => sources.has(file);
  host.readFile = (file) => sources.get(file);
  host.resolveModuleNames = (specifiers, from) => specifiers.map((specifier) => {
    let target: string;
    if (specifier.startsWith("@/")) target = specifier.slice(2);
    else if (specifier.startsWith(".")) target = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)).replace(/^\//, "");
    else return undefined;
    const base = target.replace(/\.[cm]?[jt]sx?$/, "");
    const resolvedFileName = [target, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((file) => sources.has(file));
    return resolvedFileName ? { resolvedFileName } : undefined;
  });
  return ts.createProgram([...sources.keys()], options, host);
}

function originalSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/** Follow compiler-resolved import/export aliases, namespaces, and exported const aliases. */
function switchesBehind(symbol: ts.Symbol, checker: ts.TypeChecker, visited = new Set<ts.Symbol>()): SwitchDeclaration[] {
  const original = originalSymbol(symbol, checker);
  if (visited.has(original)) return [];
  visited.add(original);
  if (original.flags & ts.SymbolFlags.Module) {
    return checker.getExportsOfModule(original).flatMap((entry) => switchesBehind(entry, checker, visited));
  }
  const declaration = original.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration)) return [];
  const initializer = unwrap(declaration.initializer);
  const target = initializer && checker.getSymbolAtLocation(initializer);
  const referenced = target ? switchesBehind(target, checker, visited) : [];
  return referenced.length > 0 ? referenced : variableSwitches(declaration);
}

/** Every source is parsed. Export structure and compiler symbols, never text, decide inclusion. */
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
