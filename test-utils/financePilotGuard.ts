import ts from "typescript";
import { resolvedSymbol, unwrap } from "./pilotAstBindings";

const guardName = "assertRt11DoorAllowed";
const financeDoors = new Map([
  ["financeDealCosts.migrateLegacyCustodyToLedger", {
    module: "custodyMigration", helper: "migrateLegacyCustodyToLedgerHandler",
    switchCode: "CUSTODY_MIGRATION_PILOT_DISABLED", accounting: true, conditions: [],
  }],
  ["financeDealCosts.reopenDealCustody", {
    module: "custodyReconciliation", helper: "reopenDealCustodyHandler",
    switchCode: "CUSTODY_REOPEN_PILOT_DISABLED", accounting: false, conditions: [],
  }],
  ["financeDealCosts.recordCustodyMovement", {
    module: "custodyMovement", helper: "recordCustodyMovementHandler",
    switchCode: "CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED", accounting: true,
    conditions: ['args.kind === "REVERSAL" || args.kind === "REIMBURSED"', "dealEconomicsFrozen(parent).frozen"],
  }],
  ["financeDealCosts.reconcileDealCustody", {
    module: "custodyReconciliation", helper: "reconcileDealCustodyHandler",
    switchCode: "CUSTODY_WRITEOFF_PILOT_DISABLED", accounting: true,
    conditions: [
      "writeOffReason",
      "!summary.settled && summary.employeeOwesDealerMinor > 0 && summary.overReturnedMinor === 0 && " +
        "summary.reimbursementOutstandingMinor === 0 && summary.reimbursementOverpaidMinor === 0",
    ],
  }],
]);

export function delegatedFinanceGuard(door: string): string | undefined {
  return financeDoors.has(door) ? guardName : undefined;
}

function conditionTokens(source: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push(token === ts.SyntaxKind.StringLiteral ? JSON.stringify(scanner.getTokenValue()) : scanner.getTokenText());
  }
  return tokens;
}

function guardOnBranch(
  body: ts.Block,
  switchCode: string,
  conditions: readonly string[],
  checker: ts.TypeChecker
): boolean {
  const [condition, ...remaining] = conditions;
  const expected = condition && JSON.stringify(conditionTokens(condition));
  for (const statement of body.statements) {
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) break;
    if (condition !== undefined) {
      if (ts.isIfStatement(statement) && ts.isBlock(statement.thenStatement) &&
          JSON.stringify(conditionTokens(statement.expression.getText())) === expected &&
          guardOnBranch(statement.thenStatement, switchCode, remaining, checker)) return true;
      continue;
    }
    if (!ts.isExpressionStatement(statement)) continue;
    const call = unwrap(statement.expression);
    if (!call || !ts.isCallExpression(call) || call.arguments.length !== 1 || call.questionDotToken) continue;
    const [code] = call.arguments;
    const guard = resolvedSymbol(call.expression, checker);
    if (guard?.name === guardName && guard.valueDeclaration?.getSourceFile().fileName === "convex/utils/rt11DoorContainment.ts" &&
        code && ts.isStringLiteral(code) && code.text === switchCode) return true;
  }
  return false;
}

/** The Finance registrations return a direct invocation of one known handler. */
export function delegatedFinanceDependency(door: string, handler: ts.Node, checker: ts.TypeChecker): string | undefined {
  const spec = financeDoors.get(door);
  if (!spec || !ts.isPropertyAssignment(handler)) return undefined;
  const wrapper = unwrap(handler.initializer);
  if (!wrapper || !ts.isArrowFunction(wrapper) || wrapper.parameters.length !== 2 || ts.isBlock(wrapper.body)) return undefined;

  const call = unwrap(wrapper.body);
  if (!call || !ts.isCallExpression(call) || call.questionDotToken || call.arguments.length !== (spec.accounting ? 3 : 2)) return undefined;
  const [ctx, args, accounting] = call.arguments;
  if (!ctx || !args || !ts.isIdentifier(ctx) || !ts.isIdentifier(args) ||
      resolvedSymbol(ctx, checker)?.valueDeclaration !== wrapper.parameters[0] ||
      resolvedSymbol(args, checker)?.valueDeclaration !== wrapper.parameters[1]) return undefined;
  if (spec.accounting) {
    if (!accounting || !ts.isIdentifier(accounting)) return undefined;
    const dependency = resolvedSymbol(accounting, checker);
    const declaration = dependency?.valueDeclaration;
    if (dependency?.name !== "accounting" || !declaration || !ts.isVariableDeclaration(declaration) ||
        !ts.isVariableDeclarationList(declaration.parent) || !ts.isVariableStatement(declaration.parent.parent) ||
        !ts.isSourceFile(declaration.parent.parent.parent) || declaration.getSourceFile() !== handler.getSourceFile()) return undefined;
  }

  const target = resolvedSymbol(call.expression, checker);
  const declaration = target?.valueDeclaration;
  if (target?.name !== spec.helper || !declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body ||
      declaration.getSourceFile().fileName !== `convex/utils/financeDealCosts/${spec.module}.ts`) return undefined;
  return guardOnBranch(declaration.body, spec.switchCode, spec.conditions, checker) ? guardName : undefined;
}
