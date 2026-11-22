import { test, expect } from "vitest";
import { assertAuthorizationConditionInventory, authorizationHelpers, authorizationSources } from "./authorizationGraph";
import { parse } from "./source";
import { assertAuthorizationPairs } from "./authorizationDecisions";
import ts from "typescript";
import { listActiveTestRegistrations } from "../../autoflowInvariantCatalog";
import { literalTestBody } from "./callerCells";
import { navigationFingerprint } from "./fingerprints";

test("authorization condition census requires distinguishing literal row pairs for every evaluated decision", () => {
  assertAuthorizationConditionInventory(parse("convex/utils/tenancy.ts"), parse("convex/utils/permissions.ts"));
  assertAuthorizationPairs(parse("convex/utils/tenancy.test.ts"));
});

function assertAuthorizationSourceRefusal(statement: string, message: RegExp, ownerPredicate = false): void {
  const tenancy = parse("convex/utils/tenancy.ts");
  const permissions = parse("convex/utils/permissions.ts");
  const original = ownerPredicate ? permissions : tenancy;
  const text = ownerPredicate ? original.text.replace("PRE_413_OWNER_FALLBACK_PERMISSIONS.every(", "PRE_413_OWNER_FALLBACK_PERMISSIONS.some(") : original.text.replace("  return { user, membership, role };", statement + "\n  return { user, membership, role };");
  expect(text).not.toBe(original.text);
  const changed = ts.createSourceFile(original.fileName, text, ts.ScriptTarget.Latest, true);
  expect(() => assertAuthorizationConditionInventory(ownerPredicate ? tenancy : changed, ownerPredicate ? changed : permissions)).toThrow(message);
}

test("authorization condition census refuses an unlisted admission branch", () => { assertAuthorizationSourceRefusal('  if (role.name === "Unpaired") return { user, membership, role };', /condition inventory changed/); });

test("authorization condition census refuses changed owner predicates", () => { assertAuthorizationSourceRefusal("", /condition inventory changed/, true); });

test("authorization condition census refuses comparisons stored as data", () => { assertAuthorizationSourceRefusal('  const choice = Number(role.name === "Unpaired");', /condition inventory changed/); });

test("authorization condition census refuses nullish decisions", () => { assertAuthorizationSourceRefusal('  const choice = role.name ?? "Unpaired";', /condition inventory changed/); });

test("authorization condition census refuses optional access", () => { assertAuthorizationSourceRefusal('const choice = role?.name;', /unreviewed authorization control/); });

test("authorization condition census refuses computed access", () => { assertAuthorizationSourceRefusal('const choice = role.permissions[0];', /unreviewed authorization control/); });

test("authorization condition census refuses constructor decisions", () => { assertAuthorizationSourceRefusal('const choice = new Map();', /unreviewed authorization control/); });

test("authorization census follows authentication and context classification decisions", () => {
  const tenancy = parse("convex/utils/tenancy.ts");
  const permissions = parse("convex/utils/permissions.ts");
  for (const [before, after] of [
    ['if (user.disabled)', 'if (user.disabled && identity.subject !== "auth-decision")'],
    ['return "insert" in ctx.db;', 'return false;'],
  ]) {
    const changed = tenancy.text.replace(before!, after!);
    expect(changed).not.toBe(tenancy.text);
    expect(() => assertAuthorizationConditionInventory(ts.createSourceFile(tenancy.fileName, changed, ts.ScriptTarget.Latest, true), permissions)).toThrow();
  }
});

function authorizationMutation(name: string, before: string, after: string): ts.SourceFile {
  const source = parse("convex/utils/tenancy.ts");
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error("Missing mutation target " + name);
  const text = declaration.getText(source);
  if (!text.includes(before)) throw new Error("Missing authorization control anchor " + name);
  return ts.createSourceFile(source.fileName, source.text.slice(0, declaration.getStart(source)) +
    text.replace(before, after) + source.text.slice(declaration.end), ts.ScriptTarget.Latest, true);
}

test("authorization graph resolves local aliases and refuses unreviewed helper bodies", () => {
  const alias = authorizationMutation("requireTenantAuth", "const user = await requireAuth(ctx);",
    "const authenticate = requireAuth; const user = await authenticate(ctx);");
  expect(authorizationHelpers(authorizationSources(alias)).map(helper => helper.name)).toContain("requireAuth");
  expect(() => assertAuthorizationConditionInventory(alias, parse("convex/utils/permissions.ts"))).toThrow(/authorization helper changed/);
  const wrapper = authorizationMutation("requireTenantAuth", "const user = await requireAuth(ctx);", "const authenticate = extraAuth; const user = await authenticate(ctx);");
  const extra = ts.createSourceFile(wrapper.fileName, wrapper.text + "\nfunction extraAuth(ctx: QueryCtx) { return requireAuth(ctx); }", ts.ScriptTarget.Latest, true);
  expect(authorizationHelpers(authorizationSources(extra)).map(helper => helper.name)).toContain("extraAuth");
  expect(() => assertAuthorizationConditionInventory(extra, parse("convex/utils/permissions.ts"))).toThrow(/Every reached helper/);
});

test("authorization graph refuses reexports computed calls and module initialization writes", () => {
  const permissions = parse("convex/utils/permissions.ts");
  const source = parse("convex/utils/tenancy.ts");
  const changed = authorizationMutation("requireTenantAuth", "const user = await requireAuth(ctx);", "const user = await importedAuth(ctx);");
  const reexport = ts.createSourceFile(source.fileName, 'import { requireAuth as importedAuth } from "./unreviewed-auth-reexport";\n' + changed.text, ts.ScriptTarget.Latest, true);
  expect(() => assertAuthorizationConditionInventory(reexport, permissions)).toThrow(/unreviewed call/);
  const computed = authorizationMutation("requireTenantAuth", "const user = await requireAuth(ctx);", 'const user = await ({ requireAuth })["requireAuth"](ctx);');
  expect(() => assertAuthorizationConditionInventory(computed, permissions)).toThrow();
  const overwritten = ts.createSourceFile(source.fileName, source.text + "\nrequireAuth = async ctx => null as never;", ts.ScriptTarget.Latest, true);
  expect(() => assertAuthorizationConditionInventory(overwritten, permissions)).toThrow(/initialization changed/);
  const unparseable = ts.createSourceFile(source.fileName, source.text + "\n/*", ts.ScriptTarget.Latest, true);
  expect(() => assertAuthorizationConditionInventory(unparseable, permissions)).toThrow(/Unparseable authorization graph/);
});

test("main settled combined-family completeness and totals assertions remain at least as strong", () => {
  const source = parse("convex/supplierNavigation.scrum869.test.ts");
  const title = "100 settled rows per family with distinct targets use at most 803 actual gets per handler";
  const registrations = listActiveTestRegistrations(source.text);
  expect(registrations.map(entry => entry.title), "main's combined AR plus recovery completeness contract must execute").toContain(title);
  const body = literalTestBody(source, title);
  const assertions = body?.statements.filter(ts.isExpressionStatement).filter(statement =>
    statement.expression.getFirstToken(source)?.getText(source) === "expect");
  expect(assertions?.map(statement => navigationFingerprint(statement, source)), "main 029386d9b: preserve both original literal totals, completeness and exact 803-get assertions").toStrictEqual([
    "8028f9c6b24c6f585f6b422e22e1871a79818fa5c9528bf14224e606ce881b14",
    "4d837509e766c2ad09711bc14c7d032cc6d7005daacaf2f575208cf8f6b78840",
  ]);
});

test("literal body indexing refuses duplicate registrations and separates source images", () => {
  const unique = ts.createSourceFile("index.ts", 'test("one", () => { expect(1).toBe(1); });', ts.ScriptTarget.Latest, true);
  expect(literalTestBody(unique, "one")).toBeDefined();
  const duplicate = ts.createSourceFile("index.ts", unique.text + 'test("one", function () {});', ts.ScriptTarget.Latest, true);
  expect(literalTestBody(duplicate, "one")).toBeUndefined();
  const changed = ts.createSourceFile("index.ts", 'test("two", () => {});', ts.ScriptTarget.Latest, true);
  expect(literalTestBody(changed, "one")).toBeUndefined();
});
