import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, test } from "vitest";

const FILE = "convex/utils/supplierDocumentOwnership.ts";
const printer = ts.createPrinter({ removeComments: true });

function declaration(text: string, name: string) {
  const source = ts.createSourceFile(FILE, text, ts.ScriptTarget.Latest, true);
  if ("parseDiagnostics" in source && Array.isArray(source.parseDiagnostics) && source.parseDiagnostics.length > 0) {
    throw new Error("Ownership module must parse without diagnostics");
  }
  const matches = source.statements.filter(ts.isFunctionDeclaration).filter(node => node.name?.text === name);
  if (matches.length !== 1 || !matches[0]?.body) throw new Error(`Exactly one complete ${name} declaration required`);
  return { source, node: matches[0] };
}

function executableSurface(text: string, name: string) {
  const { source, node } = declaration(text, name);
  if (node.modifiers?.length !== 1 || node.modifiers[0]?.kind !== ts.SyntaxKind.ExportKeyword || node.asteriskToken ||
      node.parameters.length !== 2 || node.parameters.some(parameter => !ts.isIdentifier(parameter.name) ||
        parameter.initializer || parameter.dotDotDotToken || parameter.questionToken || parameter.modifiers?.length)) {
    throw new Error(`Unreviewed ${name} executable declaration`);
  }
  const signature = (fn: ts.FunctionDeclaration, sf: ts.SourceFile) => printer.printNode(ts.EmitHint.Unspecified,
    ts.factory.updateFunctionDeclaration(fn, fn.modifiers, fn.asteriskToken, fn.name, fn.typeParameters, fn.parameters, fn.type, undefined), sf);
  const expected = declaration(`export function ${name}<T extends object>(doc: T | null, orgId: Id<"organizations">): T | null { return doc; }`, name);
  // Pin the entire signature: exactly two simple parameters without executable
  // defaults/rest/bindings/decorators, and reviewed generics, return type and modifiers.
  if (signature(node, source) !== signature(expected.node, expected.source)) throw new Error(`Unreviewed ${name} declaration surface`);
  return node.body!.statements.map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, source));
}

const displaySource = readFileSync(FILE, "utf8");
const predicates = ["ownedSupplierDocument", "supplierDecisionDocument"] as const;
function refusesSurface(change: (fn: string) => string) {
  for (const name of predicates) {
    const { source, node } = declaration(displaySource, name);
    const original = node.getText(source);
    const altered = change(original);
    expect(altered).not.toBe(original);
    expect(() => executableSurface(displaySource.replace(original, altered), name)).toThrow();
  }
}
function extraParameter(parameter: string) {
  return (fn: string) => fn.replace('orgId: Id<"organizations">,', `orgId: Id<"organizations">,\n  ${parameter},`);
}
test("ownership declaration refuses executable default parameters", () => {
  refusesSurface(extraParameter('extra: unknown = Object.assign(doc ?? {}, { isDeleted: false })'));
});
test("ownership declaration refuses destructuring defaults", () => {
  refusesSurface(extraParameter('{ extra } = Object.assign(doc ?? {}, { isDeleted: false })'));
});
test("ownership declaration refuses rest binding defaults", () => {
  refusesSurface(extraParameter('...[extra = Object.assign(doc ?? {}, { isDeleted: false })]: unknown[]'));
});
test("ownership declaration refuses defaults on existing parameters", () => {
  refusesSurface(fn => fn.replace('orgId: Id<"organizations">,', 'orgId: Id<"organizations"> = dangerous(),'));
});
test("ownership declaration refuses changed binding and parameter counts", () => {
  refusesSurface(fn => fn.replace('doc: T | null', '{ doc }: T'));
  refusesSurface(fn => fn.replace('doc: T | null,', ''));
});
test("ownership declaration refuses decorators and execution modifiers", () => {
  refusesSurface(fn => '@dangerous()\n' + fn);
  refusesSurface(fn => fn.replace('export function', 'export async function'));
  refusesSurface(fn => fn.replace('export function', 'export function*'));
});
test("ownership declaration refuses overloads and generic changes", () => {
  refusesSurface(fn => fn + '\n' + fn.slice(0, fn.indexOf('{')) + ';');
  refusesSurface(fn => fn.replace('T extends object', 'T extends object = ReturnType<typeof dangerous>'));
  refusesSurface(fn => fn.replace('T extends object', 'T extends object, U'));
});
test("ownership declaration refuses changed parameter types and optional bindings", () => {
  refusesSurface(fn => fn.replace('doc: T | null', 'doc?: T | null'));
  refusesSurface(fn => fn.replace('doc: T | null', 'doc: unknown'));
});

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
  executableSurface(displaySource, "ownedSupplierDocument");
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

test("supplier decisions retain the complete organization-only historical rule", () => {
  const navigation = body("convex/utils/supplierNavigation.ts", "owned");
  const decision = executableSurface(displaySource, "supplierDecisionDocument");
  expect(decision).toStrictEqual([navigation.statements[1], navigation.statements[3]].map(node =>
    printer.printNode(ts.EmitHint.Unspecified, node!, navigation.source)));
});
