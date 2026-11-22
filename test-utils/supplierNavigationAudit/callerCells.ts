import ts from "typescript";
import { expect } from "vitest";

export function assertCallerReceiptCounts(source: ts.SourceFile): void {
  const counts = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations[0]?.name.getText(source) === "EXPECTED_CALLER_RECEIPTS");
  if (!counts || !ts.isVariableStatement(counts)) throw new Error("missing literal EXPECTED_CALLER_RECEIPTS oracle");
  const initializer = counts.declarationList.declarations[0]?.initializer;
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) throw new Error("receipt counts must be a literal object");
  const actual = Object.fromEntries(initializer.properties.map(property => {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || !ts.isNumericLiteral(property.initializer)) {
      throw new Error("receipt counts require literal title and integer pairs");
    }
    return [property.name.text, Number(property.initializer.text)];
  }));
  const expected = Object.fromEntries(DECLARED_CALLER_CELLS.map(declared => {
    const cells = declared.args[declared.helper === "navigationCells" ? 2 : 0];
    if (!Array.isArray(cells)) throw new Error(declared.title + ": declared cells unavailable");
    return [declared.title, cells.length];
  }));
  // Old door cells also owe receipts; their literal tuples are checked by the door census.
  for (const title of Object.keys(actual as Record<string, unknown>)) {
    if (title in expected) continue;
    const body = literalTestBody(source, title);
    const call = body?.statements[0] && awaitedCallerCall(body.statements[0]);
    const cells = call?.arguments[2];
    if (!cells || !ts.isArrayLiteralExpression(cells)) throw new Error(title + ": receipt oracle has no literal bound cells");
    expected[title] = cells.elements.length;
  }
  expect(actual, "literal receipt counts must match independent declared cells; never renew the cells and declaration together to silence a failure").toStrictEqual(expected);
}

interface DeclaredCallerCells { title: string; helper: string; args: readonly unknown[] }

// Independently declared literal inputs AND outcomes; never populated at test runtime.
const DECLARED_CALLER_CELLS: readonly DeclaredCallerCells[] = [
  {"title":"outstanding distinct cached vehicles preserve the denied viewer gate","helper":"navigationCells","args":["outstanding denied distinct vehicles",["shape","mixTarget","mixState","viewVehicles","validOutcome","validLabel"],[["native","vehicle","local","without","vehicle","vehicle","vehicle","vehicle"],["native","vehicle","deleted","without","vehicle","vehicle","none","none"],["native","vehicle","foreign","without","vehicle","vehicle","none","none"]],"outstanding"]},
  {"title":"settled distinct cached vehicles preserve the denied viewer gate","helper":"navigationCells","args":["settled denied distinct vehicles",["shape","mixTarget","mixState","viewVehicles","validOutcome","validLabel"],[["native","vehicle","local","without","vehicle","vehicle","vehicle","vehicle"],["native","vehicle","deleted","without","vehicle","vehicle","none","none"],["native","vehicle","foreign","without","vehicle","vehicle","none","none"]],"settled"]},
{"title":"settled multi-row cross-permission viewers cannot substitute another navigation gate","helper":"navigationCells","args":["settled cross-permission multi-row caller",["shape","role","viewSales","viewVehicles","manageFinance","rowCount","timestamp","status"],[["cash","AP","without","with","with","two","valid","POSTED","sale","number+vehicle"],["cash","AR","without","with","with","two","valid","POSTED","sale","number+vehicle"],["financed","AP","without","with","with","two","valid","POSTED","application","number+vehicle"],["financed","AR","without","with","with","two","valid","POSTED","application","number+vehicle"],["native","AP","with","without","with","two","valid","POSTED","vehicle","vehicle"],["opening","AP","with","with","without","two","valid","POSTED","opening","opening"],["opening","AR","with","with","without","two","valid","POSTED","opening","opening"],["expense","AR","with","without","with","two","valid","POSTED","expense+vehicle","expense"]],"settled"]},
{"title":"outstanding multi-row cross-permission viewers cannot substitute another navigation gate","helper":"navigationCells","args":["outstanding cross-permission multi-row caller",["shape","role","viewSales","viewVehicles","manageFinance","rowCount","timestamp","status"],[["cash","AP","without","with","with","two","valid","POSTED","sale","number+vehicle"],["cash","AR","without","with","with","two","valid","POSTED","sale","number+vehicle"],["financed","AP","without","with","with","two","valid","POSTED","application","number+vehicle"],["financed","AR","without","with","with","two","valid","POSTED","application","number+vehicle"],["native","AP","with","without","with","two","valid","POSTED","vehicle","vehicle"],["opening","AP","with","with","without","two","valid","POSTED","opening","opening"],["opening","AR","with","with","without","two","valid","POSTED","opening","opening"],["expense","AR","with","without","with","two","valid","POSTED","expense+vehicle","expense"]],"outstanding"]},
{"title":"outstanding partially recovered opening and expense rows preserve denied and allowed viewer gates","helper":"navigationCells","args":["outstanding partial recovery caller",["shape","role","manageFinance","viewVehicles","status","recovery","timestamp"],[["opening","AR","without","without","POSTED","partial","valid","opening","opening"],["opening","AR","with","with","POSTED","partial","valid","opening+link","opening"],["expense","AR","without","without","POSTED","partial","valid","expense+vehicle","expense"],["expense","AR","with","with","POSTED","partial","valid","expense+vehicle+link","expense"]],"outstanding"]},
 { title: "settled cash sale AP preserves the viewer gate and refuses foreign or deleted sales", helper: "navigationCells", args: ["settled cash sale AP", ["shape","saleTarget","viewSales","timestamp"], [
  ["cash","local","with","valid","sale+link","number+vehicle"],
  ["cash","local","without","valid","sale","number+vehicle"],
  ["cash","foreign","with","valid","none","none"],
  ["cash","deleted","with","valid","none","none"],
 ], "settled", "AP"] },
 { title: "settled cash sale AR preserves the viewer gate and refuses foreign or deleted sales", helper: "navigationCells", args: ["settled cash sale AR", ["shape","saleTarget","viewSales","timestamp"], [
  ["cash","local","with","valid","sale+link","number+vehicle"],
  ["cash","local","without","valid","sale","number+vehicle"],
  ["cash","foreign","with","valid","none","none"],
  ["cash","deleted","with","valid","none","none"],
 ], "settled", "AR"] },
 { title: "settled application AP preserves the viewer gate and refuses foreign or missing applications and hidden sales", helper: "navigationCells", args: ["settled application AP", ["shape","saleTarget","applicationTarget","viewSales","timestamp"], [
  ["financed","local","local","with","valid","application+link","number+vehicle"],
  ["financed","local","local","without","valid","application","number+vehicle"],
  ["financed","local","foreign","with","valid","sale","number+vehicle"],
  ["financed","local","missing","with","valid","sale","number+vehicle"],
  ["financed","foreign","local","with","valid","none","none"],
  ["financed","deleted","local","with","valid","none","none"],
 ], "settled", "AP"] },
 { title: "settled application AR preserves the viewer gate and refuses foreign or missing applications and hidden sales", helper: "navigationCells", args: ["settled application AR", ["shape","saleTarget","applicationTarget","viewSales","timestamp"], [
  ["financed","local","local","with","valid","application+link","number+vehicle"],
  ["financed","local","local","without","valid","application","number+vehicle"],
  ["financed","local","foreign","with","valid","sale","number+vehicle"],
  ["financed","local","missing","with","valid","sale","number+vehicle"],
  ["financed","foreign","local","with","valid","none","none"],
  ["financed","deleted","local","with","valid","none","none"],
 ], "settled", "AR"] },
 { title: "settled opening AP preserves the viewer gate and refuses foreign or missing drafts", helper: "navigationCells", args: ["settled opening AP", ["shape","draftTarget","status","manageFinance","timestamp"], [
  ["opening","local","POSTED","with","valid","opening+link","opening"],
  ["opening","local","POSTED","without","valid","opening","opening"],
  ["opening","foreign","POSTED","with","valid","none","none"],
  ["opening","missing","POSTED","with","valid","none","none"],
 ], "settled", "AP"] },
 { title: "settled opening AR preserves the viewer gate and refuses foreign or missing drafts", helper: "navigationCells", args: ["settled opening AR", ["shape","draftTarget","status","manageFinance","timestamp"], [
  ["opening","local","POSTED","with","valid","opening+link","opening"],
  ["opening","local","POSTED","without","valid","opening","opening"],
  ["opening","foreign","POSTED","with","valid","none","none"],
  ["opening","missing","POSTED","with","valid","none","none"],
 ], "settled", "AR"] },
 { title: "settled native vehicle AP preserves the viewer gate and refuses foreign or deleted vehicles", helper: "navigationCells", args: ["settled native vehicle AP", ["shape","vehicle","viewVehicles","timestamp"], [
  ["native","local","with","valid","vehicle+link","vehicle"],
  ["native","local","without","valid","vehicle","vehicle"],
  ["native","foreign","with","valid","none","none"],
  ["native","deleted","with","valid","none","none"],
 ], "settled", "AP"] },
 { title: "settled expense vehicle AR preserves the viewer gate and refuses foreign or deleted sources", helper: "navigationCells", args: ["settled expense vehicle AR", ["shape","expenseTarget","vehicle","viewVehicles","timestamp"], [
  ["expense","local","local","with","valid","expense+vehicle+link","expense"],
  ["expense","local","local","without","valid","expense+vehicle","expense"],
  ["expense","foreign","local","with","valid","none","none"],
  ["expense","deleted","local","with","valid","none","none"],
  ["expense","local","foreign","with","valid","expense","expense"],
  ["expense","local","deleted","with","valid","expense","expense"],
 ], "settled", "AR"] },
 { title: "relationship query preserves the viewer vehicle permission for sourced and owned rows", helper: "relationshipCells", args: [[
    ["SOURCED", "without", "SOURCED", "none"],
    ["SOURCED", "with", "SOURCED", "vehicle"],
    ["OWNED", "without", "OWNED_ON_ACCOUNT", "none"],
    ["OWNED", "with", "OWNED_ON_ACCOUNT", "vehicle"],
  ]] },
 { title: "settled multi-row AP and AR preserve denied and allowed source links", helper: "navigationCells", args: ["settled multi-row caller", ["shape","role","viewSales","viewVehicles","manageFinance","rowCount","timestamp","status"], [
  ["cash","AP","without","without","without","two","valid","POSTED","sale","number+vehicle"],
  ["cash","AR","without","without","without","two","valid","POSTED","sale","number+vehicle"],
  ["financed","AP","without","without","without","two","valid","POSTED","application","number+vehicle"],
  ["financed","AR","without","without","without","two","valid","POSTED","application","number+vehicle"],
  ["native","AP","without","without","without","two","valid","POSTED","vehicle","vehicle"],
  ["opening","AP","without","without","without","two","valid","POSTED","opening","opening"],
  ["opening","AR","without","without","without","two","valid","POSTED","opening","opening"],
  ["expense","AR","without","without","without","two","valid","POSTED","expense+vehicle","expense"],
  ["cash","AP","with","with","with","two","valid","POSTED","sale+link","number+vehicle"],
  ["cash","AR","with","with","with","two","valid","POSTED","sale+link","number+vehicle"],
  ["financed","AP","with","with","with","two","valid","POSTED","application+link","number+vehicle"],
  ["financed","AR","with","with","with","two","valid","POSTED","application+link","number+vehicle"],
  ["native","AP","with","with","with","two","valid","POSTED","vehicle+link","vehicle"],
  ["opening","AP","with","with","with","two","valid","POSTED","opening+link","opening"],
  ["opening","AR","with","with","with","two","valid","POSTED","opening+link","opening"],
  ["expense","AR","with","with","with","two","valid","POSTED","expense+vehicle+link","expense"],
 ], "settled"] },
 { title: "outstanding multi-row AP and AR preserve denied and allowed source links", helper: "navigationCells", args: ["outstanding multi-row caller", ["shape","role","viewSales","viewVehicles","manageFinance","rowCount","timestamp","status"], [
  ["cash","AP","without","without","without","two","valid","POSTED","sale","number+vehicle"],
  ["cash","AR","without","without","without","two","valid","POSTED","sale","number+vehicle"],
  ["financed","AP","without","without","without","two","valid","POSTED","application","number+vehicle"],
  ["financed","AR","without","without","without","two","valid","POSTED","application","number+vehicle"],
  ["native","AP","without","without","without","two","valid","POSTED","vehicle","vehicle"],
  ["opening","AP","without","without","without","two","valid","POSTED","opening","opening"],
  ["opening","AR","without","without","without","two","valid","POSTED","opening","opening"],
  ["expense","AR","without","without","without","two","valid","POSTED","expense+vehicle","expense"],
  ["cash","AP","with","with","with","two","valid","POSTED","sale+link","number+vehicle"],
  ["cash","AR","with","with","with","two","valid","POSTED","sale+link","number+vehicle"],
  ["financed","AP","with","with","with","two","valid","POSTED","application+link","number+vehicle"],
  ["financed","AR","with","with","with","two","valid","POSTED","application+link","number+vehicle"],
  ["native","AP","with","with","with","two","valid","POSTED","vehicle+link","vehicle"],
  ["opening","AP","with","with","with","two","valid","POSTED","opening+link","opening"],
  ["opening","AR","with","with","with","two","valid","POSTED","opening+link","opening"],
  ["expense","AR","with","with","with","two","valid","POSTED","expense+vehicle+link","expense"],
 ], "outstanding"] },
 { title: "settled partially recovered opening and expense rows preserve denied and allowed viewer gates", helper: "navigationCells", args: ["settled partial recovery caller", ["shape","role","manageFinance","viewVehicles","status","recovery","timestamp"], [
  ["opening","AR","without","without","POSTED","partial","valid","opening","opening"],
  ["opening","AR","with","with","POSTED","partial","valid","opening+link","opening"],
  ["expense","AR","without","without","POSTED","partial","valid","expense+vehicle","expense"],
  ["expense","AR","with","with","POSTED","partial","valid","expense+vehicle+link","expense"],
 ], "settled"] },
 { title: "relationship multi-row large and endCursor pages preserve both viewer gates", helper: "relationshipCells", args: [[
  ["SOURCED","without","SOURCED","none","multiple"],
  ["OWNED","without","OWNED_ON_ACCOUNT","none","multiple"],
  ["SOURCED","without","SOURCED","none","large"],
  ["OWNED","without","OWNED_ON_ACCOUNT","none","large"],
  ["SOURCED","without","SOURCED","none","endCursor"],
  ["OWNED","without","OWNED_ON_ACCOUNT","none","endCursor"],
  ["SOURCED","with","SOURCED","vehicle","multiple"],
  ["OWNED","with","OWNED_ON_ACCOUNT","vehicle","multiple"],
  ["SOURCED","with","SOURCED","vehicle","large"],
  ["OWNED","with","OWNED_ON_ACCOUNT","vehicle","large"],
  ["SOURCED","with","SOURCED","vehicle","endCursor"],
  ["OWNED","with","OWNED_ON_ACCOUNT","vehicle","endCursor"],
 ]] },
{"title":"settled distinct cached vehicle and sale targets preserve every AP and AR context","helper":"navigationCells","args":["settled mixed vehicle/sale",["shape","mixTarget","mixState","validOutcome","validLabel"],[["native","vehicle","deleted","vehicle+link","vehicle","none","none"],["native","vehicle","foreign","vehicle+link","vehicle","none","none"],["cash","saleTarget","deleted","sale+link","number+vehicle","none","none"],["cash","saleTarget","foreign","sale+link","number+vehicle","none","none"]],"settled"]},
{"title":"settled distinct cached application expense and opening targets preserve every context","helper":"navigationCells","args":["settled mixed application/expense/opening",["shape","mixTarget","mixState","validOutcome","validLabel"],[["financed","applicationTarget","missing","application+link","number+vehicle","sale","number+vehicle"],["financed","applicationTarget","foreign","application+link","number+vehicle","sale","number+vehicle"],["expense","expenseTarget","deleted","expense+vehicle+link","expense","none","none"],["expense","expenseTarget","foreign","expense+vehicle+link","expense","none","none"],["opening","draftTarget","foreign","opening+link","opening","none","none"],["opening","draftTarget","missing","opening+link","opening","none","none"]],"settled"]},
{"title":"settled renamed roles retain denied and admitted navigation gates","helper":"navigationCells","args":["settled renamed caller",["shape","roleName","viewSales","viewVehicles","manageFinance","timestamp","status"],[["cash","Limited reviewer","without","without","without","valid","POSTED","sale","number+vehicle"],["cash","Limited reviewer","with","without","without","valid","POSTED","sale+link","number+vehicle"],["native","Limited reviewer","without","without","without","valid","POSTED","vehicle","vehicle"],["native","Limited reviewer","without","with","without","valid","POSTED","vehicle+link","vehicle"],["opening","Limited reviewer","without","without","without","valid","POSTED","opening","opening"],["opening","Limited reviewer","without","without","with","valid","POSTED","opening+link","opening"]],"settled"]},
{"title":"outstanding distinct cached vehicle and sale targets preserve every AP and AR context","helper":"navigationCells","args":["outstanding mixed vehicle/sale",["shape","mixTarget","mixState","validOutcome","validLabel"],[["native","vehicle","deleted","vehicle+link","vehicle","none","none"],["native","vehicle","foreign","vehicle+link","vehicle","none","none"],["cash","saleTarget","deleted","sale+link","number+vehicle","none","none"],["cash","saleTarget","foreign","sale+link","number+vehicle","none","none"]],"outstanding"]},
{"title":"outstanding distinct cached application expense and opening targets preserve every context","helper":"navigationCells","args":["outstanding mixed application/expense/opening",["shape","mixTarget","mixState","validOutcome","validLabel"],[["financed","applicationTarget","missing","application+link","number+vehicle","sale","number+vehicle"],["financed","applicationTarget","foreign","application+link","number+vehicle","sale","number+vehicle"],["expense","expenseTarget","deleted","expense+vehicle+link","expense","none","none"],["expense","expenseTarget","foreign","expense+vehicle+link","expense","none","none"],["opening","draftTarget","foreign","opening+link","opening","none","none"],["opening","draftTarget","missing","opening+link","opening","none","none"]],"outstanding"]},
{"title":"outstanding renamed roles retain denied and admitted navigation gates","helper":"navigationCells","args":["outstanding renamed caller",["shape","roleName","viewSales","viewVehicles","manageFinance","timestamp","status"],[["cash","Limited reviewer","without","without","without","valid","POSTED","sale","number+vehicle"],["cash","Limited reviewer","with","without","without","valid","POSTED","sale+link","number+vehicle"],["native","Limited reviewer","without","without","without","valid","POSTED","vehicle","vehicle"],["native","Limited reviewer","without","with","without","valid","POSTED","vehicle+link","vehicle"],["opening","Limited reviewer","without","without","without","valid","POSTED","opening","opening"],["opening","Limited reviewer","without","without","with","valid","POSTED","opening+link","opening"]],"outstanding"]},
{"title":"relationship renamed roles and SOLD status preserve both viewer gates","helper":"relationshipCells","args":[[["SOURCED","without","SOURCED","none","renamed"],["SOURCED","with","SOURCED","vehicle","renamed"],["OWNED","without","OWNED_ON_ACCOUNT","none","renamed"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","renamed"],["SOURCED","without","SOURCED","none","sold"],["SOURCED","with","SOURCED","vehicle","sold"],["OWNED","without","OWNED_ON_ACCOUNT","none","sold"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","sold"]]]},
{"title":"relationship other makes and non-null continuation preserve both viewer gates","helper":"relationshipCells","args":[[["SOURCED","without","SOURCED","none","otherMake"],["SOURCED","with","SOURCED","vehicle","otherMake"],["OWNED","without","OWNED_ON_ACCOUNT","none","otherMake"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","otherMake"],["SOURCED","without","SOURCED","none","cursor"],["SOURCED","with","SOURCED","vehicle","cursor"],["OWNED","without","OWNED_ON_ACCOUNT","none","cursor"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","cursor"]]]},
{"title":"owned relationships refuse distinct deleted and foreign vehicles beside valid stock","helper":"relationshipCells","args":[[["OWNED","without","OWNED_ON_ACCOUNT","none","mixed-deleted"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","mixed-deleted"],["OWNED","without","OWNED_ON_ACCOUNT","none","mixed-foreign"],["OWNED","with","OWNED_ON_ACCOUNT","vehicle","mixed-foreign"]]]},
{"title":"settled mixed AP and AR keep independent denied and admitted gates","helper":"navigationCells","args":["settled mixed sections",["sectionPair","viewSales","viewVehicles","manageFinance","arOutcome","arLabel"],[["vehicle-expense","with","without","with","expense+vehicle","expense","vehicle","vehicle"],["vehicle-expense","with","with","with","expense+vehicle+link","expense","vehicle+link","vehicle"],["sale-opening","without","with","without","opening","opening","sale","number+vehicle"],["sale-opening","with","with","with","opening+link","opening","sale+link","number+vehicle"]],"settled"]},
{"title":"outstanding mixed AP and AR keep independent denied and admitted gates","helper":"navigationCells","args":["outstanding mixed sections",["sectionPair","viewSales","viewVehicles","manageFinance","arOutcome","arLabel"],[["vehicle-expense","with","without","with","expense+vehicle","expense","vehicle","vehicle"],["vehicle-expense","with","with","with","expense+vehicle+link","expense","vehicle+link","vehicle"],["sale-opening","without","with","without","opening","opening","sale","number+vehicle"],["sale-opening","with","with","with","opening+link","opening","sale+link","number+vehicle"]],"outstanding"]},
];

export function callerLiteral(node: ts.Node, message: string): unknown {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(value => callerLiteral(value, message));
  throw new Error(`${message}: caller cells and arguments must be inline literal strings or arrays`);
}

const LITERAL_TEST_BODIES = new WeakMap<ts.SourceFile, ReadonlyMap<string, ts.Block | undefined>>();

export function literalTestBody(source: ts.SourceFile, title: string): ts.Block | undefined {
  const cached = LITERAL_TEST_BODIES.get(source);
  if (cached) return cached.get(title);
  const bodies = new Map<string, ts.Block | undefined>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "test") {
      const name = node.arguments[0];
      const callback = node.arguments[1];
      if (name && ts.isStringLiteral(name)) {
        const body = callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body) ? callback.body : undefined;
        bodies.set(name.text, bodies.has(name.text) ? undefined : body);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  LITERAL_TEST_BODIES.set(source, bodies);
  return bodies.get(title);
}

export function awaitedCallerCall(statement: ts.Statement): ts.CallExpression | null {
  if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) return null;
  return ts.isCallExpression(statement.expression.expression) ? statement.expression.expression : null;
}

function callerCellRegistrationTitles(source: ts.SourceFile): string[] {
  return source.statements.flatMap(statement => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return [];
    const call = statement.expression;
    const [title, callback] = call.arguments;
    if (call.expression.getText(source) !== "test" || !title || !ts.isStringLiteral(title) || !callback) return [];
    let bound = false;
    const visit = (node: ts.Node): void => {
      if (isExplicitCallerCell(node, source)) bound = true;
      ts.forEachChild(node, visit);
    };
    visit(callback);
    return bound ? [title.text] : [];
  });
}

function isExplicitCallerCell(node: ts.Node, source: ts.SourceFile): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (node.expression.getText(source) === "relationshipCells") return true;
  const query = node.arguments[3];
  return node.expression.getText(source) === "navigationCells" && query !== undefined && ts.isStringLiteral(query) &&
    ["settled", "outstanding"].includes(query.text);
}

export function assertDeclaredCallerCells(source: ts.SourceFile): void {
  expect(callerCellRegistrationTitles(source).sort(), "caller cells: actual and independently declared title sets must match in both directions; never renew the cells and declaration together to silence a failure")
    .toStrictEqual(DECLARED_CALLER_CELLS.map(cell => cell.title).toSorted());
  for (const declared of DECLARED_CALLER_CELLS) {
    const message = `supplier caller / ${declared.title}: executed caller cells must equal the non-empty declared literal cells; never renew the cells and declaration together to silence a failure`;
    const body = literalTestBody(source, declared.title);
    expect(body?.statements.length, message).toBe(1);
    const call = body?.statements[0] && awaitedCallerCall(body.statements[0]);
    expect(call?.expression.getText(source), message).toBe(declared.helper);
    const actual = call?.arguments.map(node => callerLiteral(node, message));
    expect(actual, message).toStrictEqual(declared.args);
    const cells = declared.args[declared.helper === "navigationCells" ? 2 : 0];
    expect(Array.isArray(cells), message + ": cells must be an array").toBe(true);
    if (!Array.isArray(cells)) throw new Error(message);
    expect(cells.length, message + ": declared cells must be non-empty").toBeGreaterThan(0);
  }
}
