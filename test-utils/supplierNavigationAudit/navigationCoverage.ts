import ts from "typescript";
import { unsupported, identifierChecker, type NavigationScan, checkCallable, recordNavigationDeclarations, checkPermissionForm, checkRuntimeForm, recordNavigationRead, conditionNode, compact, CONDITION_AXIS, assertNavigationSyntax, IMPORT_FORMS, CALLABLES, READ_FORMS } from "./navigationSyntax";
import { expect } from "vitest";
import { type Door } from "./doorMatrix";

function checkTypeImports(source: ts.SourceFile, node: ts.Node): void {
  if (ts.isImportTypeNode(node)) unsupported(source, node, "import type; update IMPORT_FORMS");
  ts.forEachChild(node, child => checkTypeImports(source, child));
}

export function navigationConditions(source: ts.SourceFile): Set<string> {
  const found = new Set<string>();
  const checker = identifierChecker(source);
  const scan: NavigationScan = {functions: [], imports: [], reads: [], arrows: 0};
  const visit = (node: ts.Node, scope = "module"): void => {
    if (ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) unsupported(source, node, "import or re-export");
    if (ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isTypeParameterDeclaration(node)) { checkTypeImports(source, node); return; }
    const fn = checkCallable(source, node, scope);
    recordNavigationDeclarations(source, node, fn, scan);
    checkPermissionForm(source, node);
    checkRuntimeForm(source, node, fn, checker);
    recordNavigationRead(source, node, fn, scan);
    const condition = conditionNode(source, node);
    if (condition) {
      const key = `${fn}:${compact(condition, source)}`;
      if (!CONDITION_AXIS[key]) unsupported(source, node, `condition ${ts.SyntaxKind[node.kind]}; update CONDITION_AXIS`);
      found.add(key);
    }
    ts.forEachChild(node, child => visit(child, fn));
  };
  visit(source);
  assertNavigationSyntax(source);
  for (const [name, actual, expected] of [
    ["IMPORT_FORMS", scan.imports, IMPORT_FORMS],
    ["CALLABLES", scan.functions.sort(), [...CALLABLES].sort()],
    ["READ_FORMS", scan.reads.sort(), [...READ_FORMS].sort()],
  ]) if (JSON.stringify(actual) !== JSON.stringify(expected)) unsupported(source, source, `inventory; update ${name}`);
  if (scan.arrows !== 1) unsupported(source, source, "arrow inventory; update checkCallable");
  if (!found.size) unsupported(source, source, "empty condition oracle; update CONDITION_AXIS");
  return found;
}

function isExpenseVehicleRead(node: ts.Node): boolean {
  for (let parent = node.parent; parent && !ts.isFunctionDeclaration(parent); parent = parent.parent) {
    if (!ts.isIfStatement(parent) || parent.thenStatement.pos > node.pos || parent.thenStatement.end < node.end) continue;
    const condition = parent.expression;
    if (ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      ts.isStringLiteral(condition.left) && condition.left.text === "expenseId") return true;
  }
  return false;
}

function navigationSite(source: ts.SourceFile, node: ts.Node, fn: string): string | undefined {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "owned") {
    const cache = node.arguments[2];
    expect(cache && ts.isPropertyAccessExpression(cache), "owned site must name its cache").toBe(true);
    const table = (cache as ts.PropertyAccessExpression).name.text;
    const vehicleTable = isExpenseVehicleRead(node) ? "expense vehicles" : "native/sale vehicles";
    return `${fn}: ${table === "vehicles" ? vehicleTable : table}`;
  }
  const permission = checkPermissionForm(source, node);
  if (permission) return `${fn}: ${permission}`;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    ts.isPropertyAccessExpression(node.left) && node.left.name.text === "status" && ts.isStringLiteral(node.right) && node.right.text === "POSTED") return `${fn}: POSTED`;
  return undefined;
}

export function navigationSites(source: ts.SourceFile): string[] {
  const sites: string[] = [];
  const visit = (node: ts.Node, scope = ""): void => {
    const fn = ts.isFunctionDeclaration(node) ? node.name?.text ?? "" : scope;
    const site = navigationSite(source, node, fn);
    if (site) {
      if (sites.includes(site)) unsupported(source, node, `duplicate source site ${site}; update SUPPLIER_NAVIGATION_DOORS with distinct door identities`);
      sites.push(site);
    }
    ts.forEachChild(node, child => visit(child, fn));
  };
  visit(source);
  return sites.sort();
}

// Retain the round-six product at the new axes' baselines, then add focused
// base-choice pairs. No production predicate participates in this requirement.
export function requiredNavigationTuples(door: Door): string[][] {
  const axes = Object.entries(door.axes);
  let core: string[][] = [[]];
  for (const [axis, values] of axes) {
    expect(values.length, `${door.name}: empty axis ${axis}`).toBeGreaterThan(0);
    expect(new Set(values).size, `${door.name}: duplicate values on ${axis}`).toBe(values.length);
    const baseline = ["timestamp", "saleStatus"].includes(axis) ? values.slice(0, 1) : values.filter(value => axis !== "dealNumber" || value !== "second");
    core = core.flatMap(tuple => baseline.map(value => [...tuple, value]));
  }
  const required = [...core];
  for (const shape of door.axes.shape!) {
    const base: Record<string, string> = Object.fromEntries(axes.map(([axis, values]) =>
      [axis, axis === "shape" ? shape : axis === "dealNumber" && shape === "native" ? "without" : values[0]!]));
    for (const axis of ["timestamp", "dealNumber", "saleStatus"]) {
      const variants = (door.axes[axis] ?? []).filter(value => axis === "dealNumber" ? value === "second" && shape !== "native" : value !== door.axes[axis]![0]);
      for (const value of variants) {
        for (const gate of ["viewSales", "viewVehicles", "manageFinance"].filter(gate => gate in door.axes)) {
          for (const permission of ["without", "with"]) {
            // Hidden sales retain both statuses; a missing sale was read back before deletion.
            const targets = axis === "saleStatus" ? door.axes.saleTarget! : [base.saleTarget!];
            for (const target of targets) {
              const cell = { ...base, [axis]: value, [gate]: permission };
              if ("saleTarget" in base) cell.saleTarget = target;
              required.push(axes.map(([name]) => cell[name]!));
            }
          }
        }
      }
    }
  }
  return [...new Map(required.map(tuple => [JSON.stringify(tuple), tuple])).values()];
}
