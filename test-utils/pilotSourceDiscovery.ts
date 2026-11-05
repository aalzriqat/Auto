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
  while (current && (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current))) {
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

/** Resolve const bindings, including imports, without trusting asserted types or executing code. */
function literalInitializer(expr: ts.Expression | undefined, checker: ts.TypeChecker): ts.Expression | undefined {
  let current = unwrap(expr);
  const visited = new Set<ts.Symbol>();
  while (current && ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    if (!symbol) return undefined;
    const original = originalSymbol(symbol, checker);
    if (visited.has(original)) return undefined;
    visited.add(original);
    const declaration = original.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) ||
      !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) return undefined;
    current = unwrap(declaration.initializer);
  }
  return current;
}

function doorPropertyName(prop: ts.ObjectLiteralElementLike, checker: ts.TypeChecker): string | undefined {
  const name = prop.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (!ts.isComputedPropertyName(name)) return undefined;
  const literal = literalInitializer(name.expression, checker);
  return literal && (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) ? literal.text : undefined;
}

function doorPropertyValue(prop: ts.ObjectLiteralElementLike, checker: ts.TypeChecker): ts.Expression | undefined {
  if (ts.isPropertyAssignment(prop)) return literalInitializer(prop.initializer, checker);
  if (!ts.isShorthandPropertyAssignment(prop)) return undefined;
  const symbol = checker.getShorthandAssignmentValueSymbol(prop);
  const declaration = symbol && originalSymbol(symbol, checker).valueDeclaration;
  // Resolve the referenced binding, not the property's own symbol.
  if (!declaration || !ts.isVariableDeclaration(declaration) ||
    !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) return undefined;
  return literalInitializer(declaration.initializer, checker);
}

function couldBeBoolean(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(couldBeBoolean);
  return !(type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike |
    ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Never | ts.TypeFlags.Object));
}

function spreadCouldContainDoor(prop: ts.SpreadAssignment, checker: ts.TypeChecker): boolean {
  const initializer = literalInitializer(prop.expression, checker);
  if (initializer && ts.isObjectLiteralExpression(initializer) && initializer.properties.some((entry) =>
    !ts.isSpreadAssignment(entry) && isDoorMapProperty(entry, checker))) return true;
  const type = checker.getTypeAtLocation(prop.expression);
  const indexed = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  if (indexed && couldBeBoolean(indexed)) return true;
  const properties = checker.getPropertiesOfType(type);
  if (properties.length === 0 && prop.parent.properties.every(ts.isSpreadAssignment)) return true;
  return properties.some((symbol) => SWITCH_NAME.test(symbol.name) && couldBeBoolean(checker.getTypeOfSymbolAtLocation(symbol, prop)));
}

function isDoorMapProperty(prop: ts.ObjectLiteralElementLike, checker: ts.TypeChecker): boolean {
  if (ts.isSpreadAssignment(prop)) return spreadCouldContainDoor(prop, checker);
  const name = doorPropertyName(prop, checker);
  const value = doorPropertyValue(prop, checker);
  if (name === undefined) return !(value && NON_BOOLEAN_INITIALIZERS.has(value.kind));
  // Refusal-copy, reader and metadata registries are not boolean door maps.
  return SWITCH_NAME.test(name) && !(value && NON_BOOLEAN_INITIALIZERS.has(value.kind));
}

interface DiscoveryContext {
  readonly checker: ts.TypeChecker;
  readonly classified: Set<ts.Node>;
}

function classifyBinding(symbol: ts.Symbol, context: DiscoveryContext, visited = new Set<ts.Symbol>()): void {
  const original = originalSymbol(symbol, context.checker);
  if (visited.has(original)) return;
  visited.add(original);
  const declaration = original.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration)) return;
  context.classified.add(declaration.name);
  const initializer = unwrap(declaration.initializer);
  const target = initializer && ts.isIdentifier(initializer) && context.checker.getSymbolAtLocation(initializer);
  if (target) classifyBinding(target, context, visited);
}

function classifyMapTypes(decl: ts.VariableDeclaration, map: ts.ObjectLiteralExpression, names: ReadonlySet<string>, context: DiscoveryContext): void {
  function visit(node: ts.Node): void {
    if (ts.isPropertySignature(node) && names.has(node.name.getText().replace(/^["']|["']$/g, ""))) {
      context.classified.add(node.name);
    }
    ts.forEachChild(node, visit);
  }
  if (decl.type) visit(decl.type);
  // Only types on the map's ancestor wrappers describe this discovered map.
  for (let parent: ts.Node = map.parent; parent !== decl; parent = parent.parent) {
    if (ts.isTypeAssertionExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) visit(parent.type);
  }
}

function doorMapSwitches(decl: ts.VariableDeclaration, map: ts.ObjectLiteralExpression, context: DiscoveryContext): SwitchDeclaration[] {
  const { checker, classified } = context;
  const namedMap = SWITCH_NAME.test(decl.name.getText()) && map.properties.some((prop) => ts.isSpreadAssignment(prop));
  if (!namedMap && !map.properties.some((prop) => isDoorMapProperty(prop, checker))) return [];
  classified.add(decl.name);
  const moduleId = moduleName(decl.getSourceFile().fileName);
  const declarations = map.properties.map((prop): SwitchDeclaration => {
    const name = doorPropertyName(prop, checker);
    const context = `PILOT_SOURCE_DISCOVERY: ${decl.getSourceFile().fileName} ${decl.name.getText()}`;
    if (ts.isSpreadAssignment(prop)) throw new Error(`${context}: unresolved spread`);
    if (name === undefined) throw new Error(`${context}: unresolved computed key ${prop.name?.getText()}`);
    const value = literalBoolean(doorPropertyValue(prop, checker));
    if (value === null) throw new Error(`${context}: unresolved boolean value for ${name}`);
    if (prop.name) classified.add(prop.name);
    if (ts.isShorthandPropertyAssignment(prop)) {
      const binding = checker.getShorthandAssignmentValueSymbol(prop);
      if (binding) classifyBinding(binding, { checker, classified });
    }
    return { name, kind: "doorMap", module: moduleId, value, sourceId: `${moduleId}:${prop.pos}` };
  });
  classifyMapTypes(decl, map, new Set(declarations.map(({ name }) => name)), context);
  return declarations;
}

function frozenObject(expr: ts.Expression | undefined): ts.Expression | undefined {
  const current = unwrap(expr);
  if (!current || !ts.isCallExpression(current) || current.arguments.length !== 1) return current;
  const callee = current.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== "Object" || callee.name.text !== "freeze") return current;
  const argument = unwrap(current.arguments[0]);
  return argument && ts.isObjectLiteralExpression(argument) ? argument : current;
}

function variableSwitches(decl: ts.VariableDeclaration, context: DiscoveryContext): SwitchDeclaration[] {
  if (!ts.isIdentifier(decl.name)) return [];
  const moduleId = moduleName(decl.getSourceFile().fileName);
  const initializer = frozenObject(decl.initializer);
  const constant: SwitchDeclaration[] = SWITCH_NAME.test(decl.name.text)
    ? [{ name: decl.name.text, kind: "constant", module: moduleId, value: literalBoolean(initializer), sourceId: `${moduleId}:${decl.pos}` }]
    : [];
  if (constant.length > 0) context.classified.add(decl.name);
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) return constant;
  const doorMap = doorMapSwitches(decl, initializer, context);
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

function classifyDestructuredSource(declaration: ts.Declaration, context: DiscoveryContext): void {
  if (!ts.isBindingElement(declaration) || !ts.isObjectBindingPattern(declaration.parent)) return;
  const variable = declaration.parent.parent;
  const key = declaration.propertyName ?? declaration.name;
  if (!ts.isVariableDeclaration(variable) || !variable.initializer || !ts.isIdentifier(key)) return;
  const property = context.checker.getPropertyOfType(context.checker.getTypeAtLocation(variable.initializer), key.text);
  const name = ts.getNameOfDeclaration(property?.valueDeclaration);
  if (name) context.classified.add(name);
}

function variableExports(symbol: ts.Symbol, original: ts.Symbol, context: DiscoveryContext, visited: Set<ts.Symbol>): SwitchDeclaration[] {
  const { checker, classified } = context;
  const declaration = original.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) return [];
  // Binding elements include nested array/object patterns. Defaults are not evidence of the actual value.
  if (!ts.isVariableDeclaration(declaration)) {
    const bindings = exportedBinding(symbol, declaration, null);
    const name = ts.getNameOfDeclaration(declaration);
    if (bindings.length > 0 && name) {
      classified.add(name);
      classifyDestructuredSource(declaration, context);
    }
    return bindings;
  }
  const initializer = unwrap(declaration.initializer);
  const target = initializer && checker.getSymbolAtLocation(initializer);
  const referenced = target ? switchesBehind(target, context, visited) : [];
  const aliases = symbol.name !== original.name ? exportedBinding(symbol, declaration, literalBoolean(initializer)) : [];
  if (aliases.length > 0) classifyBinding(original, context);
  return [...aliases, ...referenced, ...variableSwitches(declaration, context)];
}

/** Follow compiler-resolved aliases and enumerate exported binding elements without evaluating code. */
function switchesBehind(symbol: ts.Symbol, context: DiscoveryContext, visited = new Set<ts.Symbol>()): SwitchDeclaration[] {
  const { checker } = context;
  const original = originalSymbol(symbol, checker);
  if (visited.has(symbol)) return [];
  visited.add(symbol);
  if (original.flags & ts.SymbolFlags.Module) {
    return checker.getExportsOfModule(original).flatMap((entry) => switchesBehind(entry, context, visited));
  }
  const declarations = variableExports(symbol, original, context, visited);
  if (declarations.length > 0) {
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isExportSpecifier(declaration)) context.classified.add(declaration.name);
    }
  }
  return declarations;
}

// Exact source owners, never suffix exemptions. Boolean entries still require door discovery.
const NON_DOOR_REGISTRIES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "convex/utils/errors.ts": { AppErrorCode: "Error-code strings identify refusals, not switch values." },
  "convex/utils/legacyCollectionRefundContainment.ts": { LEGACY_COLLECTION_REFUND_REFUSALS: "Refusal copy keyed by switch." },
  "convex/utils/postDeliveryDoorContainment.ts": { POST_DELIVERY_DOOR_REFUSALS: "Refusal copy keyed by switch." },
  "convex/utils/rt11DoorContainment.ts": { RT11_DOOR_REFUSALS: "Refusal copy keyed by switch." },
  "convex/utils/supplierSettlementContainment.ts": { SUPPLIER_SETTLEMENT_DOOR_REFUSALS: "Refusal copy keyed by switch." },
  "lib/i18n/domains/common.ts": {
    workspaceMessages: "Bilingual refusal translations, not switch values.",
    accountingWorkspaceMessages: "Bilingual accounting refusal translations, not switch values.",
  },
  "lib/pilotCapabilityManifest.ts": {
    PILOT_SWITCHES: "Functions read the authoritative switches; they do not declare values.",
    PILOT_SERVER_BINDINGS: "Lists server re-export modules for parity checks.",
    PILOT_SERVER_GUARDS: "Functions exercise refusal guards for parity checks.",
  },
  "test-utils/pilotSwitchMock.ts": { pilotSwitchModule: "Test adapter getters replace already discovered switches; not shipped doors." },
};

function registryOwner(node: ts.Node): string | undefined {
  for (let parent = node.parent.parent; parent; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent)) return ts.isSourceFile(parent.parent.parent.parent) ? parent.name.getText() : undefined;
    if (ts.isFunctionDeclaration(parent)) return ts.isSourceFile(parent.parent) ? parent.name?.getText() : undefined;
    if (ts.isPropertyAssignment(parent) || ts.isClassLike(parent)) return undefined;
  }
  return undefined;
}

function isNonDoorRegistryName(node: ts.Node, context: DiscoveryContext): boolean {
  const registries = NON_DOOR_REGISTRIES[node.getSourceFile().fileName];
  const name = occurrenceName(node);
  const owner = registryOwner(name);
  if (!owner || !registries || !Object.hasOwn(registries, owner)) return false;
  const property = name.parent;
  if (ts.isGetAccessorDeclaration(property)) return owner === "pilotSwitchModule";
  if (!ts.isPropertyAssignment(property)) return false;
  const initializer = literalInitializer(property.initializer, context.checker);
  return !!initializer && NON_BOOLEAN_INITIALIZERS.has(initializer.kind);
}

function occurrenceName(node: ts.Node): ts.Node {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) ||
    ts.isTypeAssertionExpression(current.parent) || ts.isNonNullExpression(current.parent) || ts.isSatisfiesExpression(current.parent)) {
    current = current.parent;
  }
  return ts.isComputedPropertyName(current.parent) ? current.parent : current;
}

function isSwitchNameOccurrence(node: ts.Node): node is ts.Identifier | ts.PrivateIdentifier | ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  if (!(ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) || !SWITCH_NAME.test(node.text)) return false;
  const name = occurrenceName(node);
  const parent = name.parent;
  if (ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) return false;
  if (ts.isBindingElement(parent)) return parent.name === name || parent.propertyName === name;
  return "name" in parent && parent.name === name;
}

function isClassifiedName(node: ts.Node, context: DiscoveryContext): boolean {
  if (context.classified.has(occurrenceName(node))) return true;
  if (!ts.isImportSpecifier(node.parent) && !ts.isImportClause(node.parent) && !ts.isNamespaceImport(node.parent)) return false;
  const symbol = context.checker.getSymbolAtLocation(node);
  const declaration = symbol && originalSymbol(symbol, context.checker).valueDeclaration;
  const name = ts.getNameOfDeclaration(declaration);
  return !!name && context.classified.has(name);
}

function assertClassifiedSources(files: readonly ts.SourceFile[], context: DiscoveryContext): void {
  const unclassified: string[] = [];
  function visit(node: ts.Node): void {
    if (isSwitchNameOccurrence(node) && !isClassifiedName(node, context) && !isNonDoorRegistryName(node, context)) {
      const file = node.getSourceFile();
      const { line } = file.getLineAndCharacterOfPosition(node.getStart());
      unclassified.push(`${file.fileName}:${line + 1} ${node.text}`);
    }
    ts.forEachChild(node, visit);
  }
  for (const file of files) {
    if (!file.isDeclarationFile && !/\.(?:test|spec)\.tsx?$/.test(file.fileName)) visit(file);
  }
  if (unclassified.length > 0) throw new Error(`PILOT_SOURCE_UNCLASSIFIED: ${unclassified.join("; ")}`);
}

/** Every source is inspected. Export structure and compiler symbols decide inclusion. */
export function discoverPilotSources(sources: ReadonlyMap<string, string>, guardNames: ReadonlySet<string>): PilotSourceDiscovery {
  const program = sourceProgram(sources);
  const checker = program.getTypeChecker();
  const context: DiscoveryContext = { checker, classified: new Set() };
  const declarations = new Map<string, SwitchDeclaration>();
  const exportedBy = new Map<string, Set<string>>();
  const guardModules = new Set<string>();
  for (const file of program.getSourceFiles()) {
    const symbol = checker.getSymbolAtLocation(file);
    if (!symbol) continue;
    const moduleId = moduleName(file.fileName);
    for (const entry of checker.getExportsOfModule(symbol)) {
      if (guardNames.has(originalSymbol(entry, checker).name)) guardModules.add(moduleId);
      for (const declaration of switchesBehind(entry, context)) {
        declarations.set(declaration.sourceId, declaration);
        const modules = exportedBy.get(declaration.name) ?? new Set<string>();
        modules.add(moduleId);
        exportedBy.set(declaration.name, modules);
      }
    }
  }
  assertClassifiedSources(program.getSourceFiles(), context);
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
