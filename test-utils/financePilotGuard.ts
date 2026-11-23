import ts from "typescript";
import { resolvedSymbol, unwrap } from "./pilotAstBindings";

const guardName = "assertRt11DoorAllowed";
const authenticate = 'const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT]);';
const loadCustody = (name: string) =>
  `const ${name} = await requireOwnedRow(ctx, args.orgId, "financeDealCustody", args.custodyId, CUSTODY_NOT_FOUND);`;
const application = 'const parent = await requireOwnedRow(ctx, args.orgId, "financeApplications", ownedCustody.applicationId, APPLICATION_NOT_FOUND);';
const summary = 'const summary = summarizeReadableCustody(owned, await loadActiveFees(ctx, owned.applicationId), "closing this custody record");';

interface GuardBranch {
  before: readonly string[];
  then?: { condition: string; branch: GuardBranch };
}

const financeDoors = new Map<string, {
  module: string;
  helper: string;
  switchCode: string;
  accounting: boolean;
  branch: GuardBranch;
}>([
  ["financeDealCosts.migrateLegacyCustodyToLedger", {
    module: "custodyMigration", helper: "migrateLegacyCustodyToLedgerHandler",
    switchCode: "CUSTODY_MIGRATION_PILOT_DISABLED", accounting: true,
    branch: { before: [
      'const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT, PERMISSIONS.MANAGE_FINANCE]);',
      loadCustody("owned"),
      'assertNotCustodian(owned, user._id, "Migrating a custody record to the ledger");',
    ] },
  }],
  ["financeDealCosts.reopenDealCustody", {
    module: "custodyReconciliation", helper: "reopenDealCustodyHandler",
    switchCode: "CUSTODY_REOPEN_PILOT_DISABLED", accounting: false,
    branch: { before: [authenticate, loadCustody("custody")] },
  }],
  ["financeDealCosts.recordCustodyMovement", {
    module: "custodyMovement", helper: "recordCustodyMovementHandler",
    switchCode: "CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED", accounting: true,
    branch: { before: [authenticate, loadCustody("ownedCustody")], then: {
      condition: 'args.kind === "REVERSAL" || args.kind === "REIMBURSED"',
      branch: { before: [application], then: {
        condition: "dealEconomicsFrozen(parent).frozen",
        branch: { before: [] },
      } },
    } },
  }],
  ["financeDealCosts.reconcileDealCustody", {
    module: "custodyReconciliation", helper: "reconcileDealCustodyHandler",
    switchCode: "CUSTODY_WRITEOFF_PILOT_DISABLED", accounting: true,
    branch: { before: [
      authenticate, loadCustody("owned"),
      'assertNotCustodian(owned, user._id, "Closing a custody record");',
      "const notes = args.notes.trim();",
      'if (!notes) { throw new ConvexError("Record what was checked before closing this custody record."); }',
      "const writeOffReason = args.writeOffReason?.trim() || undefined;",
    ], then: {
      condition: "writeOffReason",
      branch: { before: [summary], then: {
        condition: "!summary.settled && summary.employeeOwesDealerMinor > 0 && summary.overReturnedMinor === 0 && " +
          "summary.reimbursementOutstandingMinor === 0 && summary.reimbursementOverpaidMinor === 0",
        branch: { before: [] },
      } },
    } },
  }],
]);

const preflightBindings: ReadonlyMap<string, string> = new Map([
  ["requireTenantAuth", "convex/utils/tenancy.ts"],
  ["requireOwnedRow", "convex/utils/tenancy.ts"],
  ["PERMISSIONS", "convex/utils/permissions.ts"],
  ["APPLICATION_NOT_FOUND", "convex/utils/financeDealCosts/dealCostGuards.ts"],
  ["CUSTODY_NOT_FOUND", "convex/utils/financeDealCosts/dealCostGuards.ts"],
  ["assertNotCustodian", "convex/utils/financeDealCosts/custodyRecords.ts"],
  ["dealEconomicsFrozen", "convex/utils/financeDealCosts/dealCostGuards.ts"],
  ["loadActiveFees", "convex/utils/settlementDeductions.ts"],
  ["summarizeReadableCustody", "convex/utils/settlementDeductions.ts"],
]);

export function delegatedFinanceGuard(door: string): string | undefined {
  return financeDoors.has(door) ? guardName : undefined;
}

function tokens(source: string): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  const values: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const value = token === ts.SyntaxKind.StringLiteral ? JSON.stringify(scanner.getTokenValue()) : scanner.getTokenText();
    if ([")", "]", "}"].includes(value) && values.at(-1) === ",") values.pop();
    values.push(value);
  }
  return JSON.stringify(values);
}

function runtimeImport(node: ts.Node, checker: ts.TypeChecker): ts.ImportSpecifier | undefined {
  if (!ts.isIdentifier(node)) return undefined;
  const binding = checker.getSymbolAtLocation(node)?.declarations?.[0];
  if (!binding || !ts.isImportSpecifier(binding) || binding.isTypeOnly || binding.parent.parent.isTypeOnly) return undefined;
  return binding;
}

function importedRuntimeSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  return runtimeImport(node, checker) ? resolvedSymbol(node, checker) : undefined;
}

function matchesBinding(node: ts.Node, name: string, module: string, checker: ts.TypeChecker): boolean {
  const symbol = importedRuntimeSymbol(node, checker);
  return symbol?.name === name && symbol.valueDeclaration?.getSourceFile().fileName === module;
}

function bindingsMatch(node: ts.Node, bindings: ReadonlyMap<string, ts.Declaration>, checker: ts.TypeChecker): boolean {
  if (ts.isIdentifier(node)) {
    const local = bindings.get(node.text);
    if (local && resolvedSymbol(node, checker)?.valueDeclaration !== local) return false;
    const modulePath = preflightBindings.get(node.text);
    if (modulePath && !matchesBinding(node, node.text, modulePath, checker)) return false;
    if (node.text === "ConvexError") {
      const binding = runtimeImport(node, checker);
      if (!binding) return false;
      const specifier = binding.parent.parent.parent.moduleSpecifier;
      if (!ts.isStringLiteral(specifier) || specifier.text !== "convex/values" ||
          (binding.propertyName ?? binding.name).text !== "ConvexError") return false;
    }
    if (node.text === "undefined" && resolvedSymbol(node, checker)?.valueDeclaration) return false;
  }
  return !ts.forEachChild(node, (child) => !bindingsMatch(child, bindings, checker) || undefined);
}

function recordPreflightDeclarations(statement: ts.Statement, bindings: Map<string, ts.Declaration>): void {
  if (!ts.isVariableStatement(statement)) return;
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name)) {
      bindings.set(declaration.name.text, declaration);
    } else if (ts.isObjectBindingPattern(declaration.name)) {
      for (const element of declaration.name.elements) {
        if (ts.isIdentifier(element.name)) bindings.set(element.name.text, element);
      }
    }
  }
}

function inertFunctionDeclaration(statement: ts.Statement): boolean {
  if (ts.isFunctionDeclaration(statement)) return true;
  if (!ts.isVariableStatement(statement) ||
      (statement.declarationList.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const) return false;
  return statement.declarationList.declarations.every(({ name, initializer }) => ts.isIdentifier(name) &&
    !!initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)));
}

/** Recognize only the proven read/refusal prefix on the applicable route to the guard. */
function guardOnBranch(
  body: ts.Block,
  switchCode: string,
  route: GuardBranch,
  bindings: Map<string, ts.Declaration>,
  checker: ts.TypeChecker
): boolean {
  const statements = body.statements.filter((statement) => !inertFunctionDeclaration(statement));
  for (const [index, expected] of route.before.entries()) {
    const statement = statements[index];
    if (!statement || tokens(statement.getText()) !== tokens(expected) ||
        !bindingsMatch(statement, bindings, checker)) return false;
    recordPreflightDeclarations(statement, bindings);
  }
  const next = statements[route.before.length];
  if (route.then) {
    return !!next && ts.isIfStatement(next) && ts.isBlock(next.thenStatement) &&
      tokens(next.expression.getText()) === tokens(route.then.condition) &&
      bindingsMatch(next.expression, bindings, checker) &&
      guardOnBranch(next.thenStatement, switchCode, route.then.branch, bindings, checker);
  }
  if (!next || !ts.isExpressionStatement(next)) return false;
  const call = unwrap(next.expression);
  if (!call || !ts.isCallExpression(call) || call.arguments.length !== 1 || call.questionDotToken) return false;
  const [code] = call.arguments;
  return !!code && ts.isStringLiteral(code) && code.text === switchCode &&
    matchesBinding(call.expression, guardName, "convex/utils/rt11DoorContainment.ts", checker);
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

  const target = importedRuntimeSymbol(call.expression, checker);
  const declaration = target?.valueDeclaration;
  if (target?.name !== spec.helper || !declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body ||
      declaration.getSourceFile().fileName !== `convex/utils/financeDealCosts/${spec.module}.ts`) return undefined;
  const [ctxParameter, argsParameter] = declaration.parameters;
  if (!ctxParameter || !argsParameter || ctxParameter.name.getText() !== "ctx" || argsParameter.name.getText() !== "args") return undefined;
  const bindings = new Map<string, ts.Declaration>([["ctx", ctxParameter], ["args", argsParameter]]);
  return guardOnBranch(declaration.body, spec.switchCode, spec.branch, bindings, checker) ? guardName : undefined;
}
