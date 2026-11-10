import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, test } from "vitest";
import { listActiveTestRegistrations } from "../autoflowInvariantCatalog";
import { SUPPLIER_NAVIGATION_DOORS } from "./supplierNavigationDoors";

const root = join(__dirname, "..", "..");
const updateTable = "Update scripts/intelligence/supplierNavigationDoors.ts and its public-query test rows";

test("supplier navigation ownership calls and permission gates all have declared door rows", () => {
  const source = ts.createSourceFile("supplierNavigation.ts", readFileSync(join(root, "convex/utils/supplierNavigation.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const found = { owned: 0, permission: 0, status: 0 };
  // Count invocations, not helper declarations, comments or quoted examples.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "owned") found.owned += 1;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "includes") {
        const receiver = callee.expression;
        if ((ts.isIdentifier(receiver) && receiver.text === "permissions") ||
          (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "permissions")) found.permission += 1;
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
      ts.isPropertyAccessExpression(node.left) && node.left.name.text === "status" &&
      ts.isStringLiteral(node.right) && node.right.text === "POSTED") found.status += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  const declared = { owned: 0, permission: 0, status: 0 };
  for (const door of SUPPLIER_NAVIGATION_DOORS) {
    expect(door.rows.length, `${updateTable}: ${door.name} has no rows`).toBeGreaterThan(0);
    declared[door.kind] += 1;
  }
  expect(found, updateTable).toStrictEqual(declared);
});

test("every declared supplier navigation row names one active literal test registration", () => {
  const source = readFileSync(join(root, "convex/supplierNavigation.scrum869.test.ts"), "utf8");
  const registered = listActiveTestRegistrations(source).filter(row => !row.parameterized);
  for (const door of SUPPLIER_NAVIGATION_DOORS) {
    for (const row of door.rows) {
      expect(registered.filter(test => test.title === row.title).length,
        `${updateTable}: ${door.name} / ${row.state} / ${row.viewer}: ${row.title}`).toBe(1);
    }
  }
});
