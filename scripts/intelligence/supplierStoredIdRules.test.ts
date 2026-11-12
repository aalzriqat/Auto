import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, test } from "vitest";

function body(file: string, name: string) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const declarations = source.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name);
  expect(declarations, `${file}: exactly one ${name} declaration`).toHaveLength(1);
  const declaration = declarations[0];
  if (!declaration?.body) throw new Error(`Missing ${file}:${name} body`);
  return { source, statements: declaration.body.statements };
}

test("supplier stored-id ownership rule cannot drift from certified navigation", () => {
  const navigation = body("convex/utils/supplierNavigation.ts", "owned");
  const shared = body("convex/utils/supplierDocumentOwnership.ts", "ownedSupplierDocument");
  // Navigation's first statement loads the cached document. Its remaining complete
  // decision must equal the shared rule, including early returns and extra conditions.
  expect(navigation.statements).toHaveLength(4);
  expect(shared.statements).toHaveLength(3);
  const printer = ts.createPrinter({ removeComments: true });
  const print = (node: ts.Statement, source: ts.SourceFile) => printer.printNode(ts.EmitHint.Unspecified, node, source);
  expect(shared.statements.map(node => print(node, shared.source))).toStrictEqual(
    navigation.statements.slice(1).map(node => print(node, navigation.source)),
  );
});
