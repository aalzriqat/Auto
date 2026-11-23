import ts from "typescript";
import { resolvedSymbol, unwrap } from "./pilotAstBindings";

const delegatedApplicationDoors = {
  "applications.finalizeDeal": {
    module: "convex/domains/deal/finalizeDeal.ts",
    helper: "prepareFinancedClosing",
    guardModule: "convex/utils/depositOtherContainment.ts",
    guard: "refuseDepositOtherTreatment",
    dependency: "DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED",
  },
  "applications.correctExpectedPayment": {
    module: "convex/domains/deal/expectedPayment.ts",
    helper: "executeCorrectExpectedPayment",
    guardModule: "convex/utils/rt11DoorContainment.ts",
    guard: "assertRt11DoorAllowed",
    dependency: "assertRt11DoorAllowed",
  },
} as const;

export function hasDelegatedApplicationPilotGuard(door: string): door is keyof typeof delegatedApplicationDoors {
  return Object.hasOwn(delegatedApplicationDoors, door);
}

export function delegatedApplicationGuard(door: string): string | undefined {
  return hasDelegatedApplicationPilotGuard(door) ? delegatedApplicationDoors[door].dependency : undefined;
}

function directCall(expression: ts.Expression | undefined): ts.CallExpression | undefined {
  const outer = unwrap(expression);
  const call = outer && ts.isAwaitExpression(outer) ? unwrap(outer.expression) : outer;
  return call && ts.isCallExpression(call) ? call : undefined;
}

function handlerFunction(handler: ts.Node): ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (ts.isMethodDeclaration(handler)) return handler;
  if (!ts.isPropertyAssignment(handler)) return undefined;
  const fn = unwrap(handler.initializer);
  return fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? fn : undefined;
}

function isBinding(expression: ts.Expression | undefined, binding: ts.Symbol | undefined, checker: ts.TypeChecker): boolean {
  const input = unwrap(expression);
  return !!binding && !!input && ts.isIdentifier(input) && resolvedSymbol(input, checker) === binding;
}

function receivesOwnedApplication(call: ts.CallExpression, handler: ts.Block, checker: ts.TypeChecker): boolean {
  const applicationArg = unwrap(call.arguments[2]);
  const declaration = applicationArg && ts.isIdentifier(applicationArg) && resolvedSymbol(applicationArg, checker)?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isVariableDeclarationList(declaration.parent)) return false;
  const list = declaration.parent;
  const constFlag = list.flags & ts.NodeFlags.Const;
  if (constFlag === 0 || !ts.isVariableStatement(list.parent) || list.parent.parent !== handler ||
      declaration.getStart() >= call.getStart()) return false;
  const initializer = unwrap(declaration.initializer);
  const load = initializer && ts.isAwaitExpression(initializer) && directCall(initializer);
  if (!load || !matchesDeclaration(resolvedSymbol(load.expression, checker), "convex/utils/tenancy.ts", "requireOwnedRow")) return false;
  const [ctx, org, table, id] = load.arguments;
  const args = unwrap(call.arguments[1]);
  const argsBinding = args && resolvedSymbol(args, checker);
  return !!ctx && isBinding(ctx, resolvedSymbol(call.arguments[0], checker), checker) &&
    !!org && propertyOf(org, "orgId", argsBinding, checker) &&
    !!table && ts.isStringLiteral(table) && table.text === "financeApplications" &&
    !!id && propertyOf(id, "applicationId", argsBinding, checker);
}

function matchesDeclaration(symbol: ts.Symbol | undefined, module: string, name: string): boolean {
  return symbol?.name === name && symbol.valueDeclaration?.getSourceFile().fileName === module;
}

function propertyOf(expression: ts.Expression, property: string, owner: ts.Symbol | undefined, checker: ts.TypeChecker): boolean {
  const access = unwrap(expression);
  return !!owner && !!access && ts.isPropertyAccessExpression(access) && access.name.text === property &&
    resolvedSymbol(access.expression, checker) === owner;
}

function readsPaidTimestamp(expression: ts.Expression, name: string, owner: ts.Symbol | undefined, checker: ts.TypeChecker): boolean {
  const check = unwrap(expression);
  return !!check && ts.isBinaryExpression(check) && check.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    ts.isIdentifier(check.right) && check.right.text === "undefined" && propertyOf(check.left, name, owner, checker);
}

/** The refactor moved these two straight-line calls. Keep this evidence local to those doors. */
export function delegatedApplicationDependency(door: string, handler: ts.Node, checker: ts.TypeChecker): string | undefined {
  if (!hasDelegatedApplicationPilotGuard(door)) return undefined;
  const spec = delegatedApplicationDoors[door];
  const fn = handlerFunction(handler);
  if (!fn?.body || !ts.isBlock(fn.body)) return undefined;
  const body = fn.body;
  const [ctxParam, argsParam] = fn.parameters;
  const ctxBinding = ctxParam && checker.getSymbolAtLocation(ctxParam.name);
  const argsBinding = argsParam && checker.getSymbolAtLocation(argsParam.name);
  const calls: (ts.CallExpression | undefined)[] = [];
  for (const statement of body.statements) {
    if (ts.isThrowStatement(statement)) break;
    if (ts.isReturnStatement(statement)) {
      if (door === "applications.correctExpectedPayment") calls.push(directCall(statement.expression));
      break;
    }
    if (door === "applications.finalizeDeal" && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = unwrap(declaration.initializer);
        if (initializer && ts.isAwaitExpression(initializer)) calls.push(directCall(initializer));
      }
    }
  }
  const helpers = calls.flatMap((call) => {
    if (!call || !isBinding(call.arguments[0], ctxBinding, checker) || !isBinding(call.arguments[1], argsBinding, checker)) return [];
    const target = resolvedSymbol(call.expression, checker);
    if (!matchesDeclaration(target, spec.module, spec.helper)) return [];
    if (door === "applications.correctExpectedPayment" && !receivesOwnedApplication(call, body, checker)) return [];
    const declaration = target?.valueDeclaration;
    return declaration && ts.isFunctionDeclaration(declaration) && declaration.body ? [{ declaration, body: declaration.body }] : [];
  });
  const [helper, duplicate] = helpers;
  if (!helper || duplicate) return undefined;
  const arg = helper.declaration.parameters[door === "applications.finalizeDeal" ? 1 : 2];
  const owner = arg && checker.getSymbolAtLocation(arg.name);
  for (const statement of helper.body.statements) {
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) break;
    if (!ts.isIfStatement(statement) || !ts.isBlock(statement.thenStatement)) continue;
    const condition = unwrap(statement.expression);
    if (!condition || !ts.isBinaryExpression(condition)) continue;
    const statements = statement.thenStatement.statements;
    const end = statements.findIndex((entry) => ts.isReturnStatement(entry) || ts.isThrowStatement(entry));
    const reachable = end < 0 ? statements : statements.slice(0, end);
    const guarded = reachable.some((entry) => {
      const call = ts.isExpressionStatement(entry) ? directCall(entry.expression) : undefined;
      if (!call || !matchesDeclaration(resolvedSymbol(call.expression, checker), spec.guardModule, spec.guard)) return false;
      if (door === "applications.finalizeDeal") {
        const switchRef = unwrap(condition.right);
        const treatment = unwrap(condition.left);
        if (!treatment || !ts.isBinaryExpression(treatment) ||
          treatment.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken ||
          !ts.isStringLiteral(treatment.right) || treatment.right.text !== "OTHER") return false;
        const access = unwrap(treatment.left);
        return !!access && ts.isPropertyAccessExpression(access) && access.name.text === "treatment" &&
          propertyOf(access.expression, "depositResolution", owner, checker) &&
          condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
          !!switchRef && matchesDeclaration(resolvedSymbol(switchRef, checker), spec.guardModule, spec.dependency) &&
          call.arguments.length === 0;
      }
      const [code] = call.arguments;
      return condition.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
        readsPaidTimestamp(condition.left, "disbursedAt", owner, checker) &&
        readsPaidTimestamp(condition.right, "supplierDisbursementConfirmedAt", owner, checker) &&
        call.arguments.length === 1 && !!code && ts.isStringLiteral(code) && code.text === "EXPECTED_PAYMENT_PAID_PILOT_DISABLED";
    });
    if (guarded) return spec.dependency;
  }
  return undefined;
}
