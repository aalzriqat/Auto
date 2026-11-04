/** Static evidence checks. These establish reachability, not execution or certification quality. */
import ts from "typescript";
import path from "node:path";

const MONEY_FIELD = /\b(amount|price|cost|balance|commission|salary|wage|credit|debit|principal|interest|discount|refund|revenue|profit|payment|fee|tax|budget|paid|due|net|gross)(s)?\b/i;
const POSTING_CALL = /^post\w*$/;

function moneyName(name: string): boolean {
  if (/(At|Date|Timestamp|Revision|Count|Version|Day|Days|Month|Months|Year|Years)$/.test(name)) return false;
  return MONEY_FIELD.test(name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " "));
}

function numericOrUnknown(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(numericOrUnknown);
  return !!(type.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.Any | ts.TypeFlags.Unknown));
}

export function parseSource(src: string): ts.SourceFile {
  return ts.createSourceFile("control.ts", src, ts.ScriptTarget.Latest, true);
}

export function sourceAnalysis(files: string[]) {
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: [],
    noEmit: true,
  });
  return { program, checker: program.getTypeChecker() };
}

function callableBody(declaration: ts.Declaration): ts.Node | undefined {
  if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) return declaration.body;
  if (!ts.isVariableDeclaration(declaration)) return undefined;
  const init = declaration.initializer;
  if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return init.body;
  return undefined;
}

function bodiesFor(expression: ts.Expression, checker: ts.TypeChecker | undefined, seen = new Set<ts.Symbol>()): ts.Node[] {
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return [expression.body];
  if (!checker) return [];
  let symbol = checker.getSymbolAtLocation(expression);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  if (!symbol || seen.has(symbol)) return [];
  seen.add(symbol);
  return (symbol.declarations ?? []).flatMap((d) => {
    if (d.getSourceFile().fileName.includes("node_modules")) return [];
    const body = callableBody(d);
    if (body) return [body];
    if (ts.isVariableDeclaration(d) && d.initializer) return bodiesFor(d.initializer, checker, seen);
    return [];
  });
}

/** Follow resolved helper bindings (including import aliases) and passed callbacks, with cycle protection. */
function reachable(start: ts.Node, matches: (call: ts.CallExpression) => boolean, checker?: ts.TypeChecker): boolean {
  const visited = new Set<ts.Node>();
  const walk = (root: ts.Node): boolean => {
    if (visited.has(root)) return false;
    visited.add(root);
    const visit = (node: ts.Node): boolean => {
      if (node !== root && ts.isFunctionLike(node)) return false;
      if (ts.isCallExpression(node)) {
        if (matches(node)) return true;
        const bodies = [node.expression, ...node.arguments].flatMap((arg) => bodiesFor(arg, checker));
        if (bodies.some(walk)) return true;
      }
      return ts.forEachChild(node, visit) ?? false;
    };
    return visit(root);
  };
  return walk(start);
}

function callName(call: ts.CallExpression): string {
  const target = call.expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return "";
}

function writesMoney(call: ts.CallExpression, checker?: ts.TypeChecker): boolean {
  if (!["insert", "patch", "replace"].includes(callName(call))) return false;
  // Only database writers, not unrelated libraries with a similarly named method.
  if (!ts.isPropertyAccessExpression(call.expression) || !/\bdb\b/.test(call.expression.expression.getText())) return false;
  const payload = call.arguments[1];
  if (!payload) return false;
  if (!checker) return ts.isObjectLiteralExpression(payload) &&
    payload.properties.some((p) => p.name && moneyName(p.name.getText()));
  if (ts.isObjectLiteralExpression(payload) && payload.properties.some((p) =>
    ts.isPropertyAssignment(p) && moneyName(p.name.getText()) && numericOrUnknown(checker.getTypeAtLocation(p.initializer)))) return true;
  const payloadType = checker.getTypeAtLocation(payload);
  if (payloadType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  const indexType = payloadType.getStringIndexType();
  if (indexType && numericOrUnknown(indexType)) return true;
  return payloadType.getProperties().some((p) =>
    moneyName(p.name) && numericOrUnknown(checker.getTypeOfSymbolAtLocation(p, payload)));
}

function financialCall(call: ts.CallExpression, checker?: ts.TypeChecker): boolean {
  if (POSTING_CALL.test(callName(call))) return true;
  if (writesMoney(call, checker)) return true;
  // Ledger/subledger writes are financial even if their payload uses an opaque object or zero amounts.
  const table = call.arguments[0];
  return ["insert", "delete", "patch", "replace"].includes(callName(call)) &&
    !!table && ts.isStringLiteral(table) && /journal|collectionPayment|cashMovement|bankTransaction|deposit|payrollRun|expense|transaction|receivable|payable/i.test(table.text);
}

/** Locate only executable handler bodies, not validators or comments. Missing bodies refuse evidence. */
export function mutationBody(node: ts.Node): ts.Node {
  let body: ts.Node | undefined;
  const visit = (child: ts.Node): void => {
    if (ts.isPropertyAssignment(child) && child.name.getText() === "handler") {
      if (ts.isArrowFunction(child.initializer) || ts.isFunctionExpression(child.initializer)) body = child.initializer.body;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  if (!body) throw new Error(`No handler body for ${node.getText().slice(0, 80)}`);
  return body;
}

export function hasFinancialEffect(node: ts.Node, checker?: ts.TypeChecker): boolean {
  return reachable(node, (call) => financialCall(call, checker), checker);
}

export function financialEvidence(node: ts.Node, checker: ts.TypeChecker): string | undefined {
  let evidence: string | undefined;
  reachable(node, (call) => {
    if (!financialCall(call, checker)) return false;
    const file = call.getSourceFile();
    const line = file.getLineAndCharacterOfPosition(call.getStart()).line + 1;
    evidence = `${path.basename(file.fileName)}:${line} ${callName(call)}`;
    return true;
  }, checker);
  return evidence;
}

function testRegistration(call: ts.CallExpression): boolean {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return ["test", "it"].includes(expression.text);
  if (!ts.isCallExpression(expression)) return false;
  const each = expression.expression;
  return ts.isPropertyAccessExpression(each) && each.name.text === "each" &&
    ts.isIdentifier(each.expression) && ["test", "it"].includes(each.expression.text);
}

export function testBodies(source: ts.SourceFile, row?: string): ts.Node[] {
  const bodies: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && testRegistration(node)) {
      const [title, callback] = node.arguments;
      if (title && ts.isStringLiteralLike(title) && (row === undefined || title.text === row) && callback &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) bodies.push(callback.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bodies;
}

export function rowCallsDoor(source: ts.SourceFile, door: string, row?: string, checker?: ts.TypeChecker): boolean {
  const bodies = testBodies(source, row);
  if (row !== undefined && bodies.length !== 1) return false;
  const reference = `api.${door.replaceAll("/", ".")}`;
  return bodies.some((body) => bodyDoors(body, checker).has(reference));
}

const doorCache = new WeakMap<ts.Node, Set<string>>();
function bodyDoors(body: ts.Node, checker?: ts.TypeChecker): Set<string> {
  const cached = doorCache.get(body);
  if (cached) return cached;
  const doors = new Set<string>();
  reachable(body, (call) => {
    if (["mutation", "runMutation"].includes(callName(call))) {
      const reference = call.arguments[0]?.getText();
      if (reference?.startsWith("api.")) doors.add(reference);
    }
    return false;
  }, checker);
  doorCache.set(body, doors);
  return doors;
}

export function exportedDeclaration(source: ts.SourceFile, name: string, checker: ts.TypeChecker): ts.Declaration {
  const moduleSymbol = checker.getSymbolAtLocation(source);
  let symbol = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((e) => e.name === name);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration;
  if (!declaration) throw new Error(`Cannot resolve registered export ${path.basename(source.fileName)}.${name}`);
  return declaration;
}

export function publicMutationNames(exports: Record<string, unknown>): string[] {
  return Object.entries(exports).filter(([, value]) =>
    value !== null && (typeof value === "function" || typeof value === "object") &&
    "isMutation" in value && value.isMutation === true &&
    "isPublic" in value && value.isPublic === true).map(([name]) => name);
}
