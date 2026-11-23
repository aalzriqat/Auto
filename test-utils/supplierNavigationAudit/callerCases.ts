import { expect } from "vitest";
import { parse, updateTable } from "./source";
import { assertDeclaredCallerCells, assertCallerReceiptCounts } from "./callerCells";
import { callableNavigationExports, NAVIGATION_CALLERS, assertCallerTests, assertNavigationCallerSweep, refuseDynamicNavigation } from "./callerCensus";
import { listActiveTestRegistrations } from "../../scripts/autoflowInvariantCatalog";
import { assertForwardingFingerprints, assertCacheFingerprints, assertRunnerFingerprints, type RunnerPinPart } from "./runnerPins";
import ts from "typescript";
import { refuseRunnerOverrides } from "./runnerSyntax";

export const checkSupplierNavigationCallerCensusPinsEveryPermissionScopeAndBindsPublicQueryBehaviour = () => {
  const syntax = parse("convex/supplierNavigation.scrum869.test.ts");
  assertDeclaredCallerCells(syntax);
  assertCallerReceiptCounts(syntax);
};

export const checkSupplierNavigationCallerBindingsRetainEveryPermissionScopeAndForwardingContract = () => {
  const syntax = parse("convex/supplierNavigation.scrum869.test.ts");
  const names = callableNavigationExports(parse("convex/utils/supplierNavigation.ts"));
  expect(names, `Review every permission-taking export and list its callers. ${updateTable}`).toStrictEqual(["addSupplierRowContext", "supplierVehicleHref"]);
  const active = listActiveTestRegistrations(syntax.text).filter(test => !test.parameterized);
  for (const caller of NAVIGATION_CALLERS) assertCallerTests(caller, syntax, active);
  assertForwardingFingerprints();
  assertCacheFingerprints(parse("convex/utils/supplierReadCache.ts"));
};

export const checkSupplierNavigationCallerSweepQuarter0EnumeratesItsRecursiveProductionFiles = () => {
  assertNavigationCallerSweep(0);
};

export const checkSupplierNavigationCallerSweepQuarter1EnumeratesItsRecursiveProductionFiles = () => {
  assertNavigationCallerSweep(1);
};

export const checkSupplierNavigationCallerSweepQuarter2EnumeratesItsRecursiveProductionFiles = () => {
  assertNavigationCallerSweep(2);
};

export const checkSupplierNavigationCallerSweepQuarter3EnumeratesItsRecursiveProductionFiles = () => {
  assertNavigationCallerSweep(3);
};

export const checkSupplierNavigationRunnerEnvelopeContractRetainsReviewedImportsBindingsAndBodies = () => {
  assertRunnerFingerprints(parse("convex/supplierNavigation.scrum869.test.ts"), "envelope");
};

export const checkSupplierNavigationRunnerEvenContractRetainsReviewedImportsBindingsAndBodies = () => {
  assertRunnerFingerprints(parse("convex/supplierNavigation.scrum869.test.ts"), "even");
};

export const checkSupplierNavigationRunnerOddContractRetainsReviewedImportsBindingsAndBodies = () => {
  assertRunnerFingerprints(parse("convex/supplierNavigation.scrum869.test.ts"), "odd");
};

export const checkCallerFixtureHookPinsRejectChangedSetupBodies = () => {
  const source = parse("convex/supplierNavigation.scrum869.test.ts");
  const changed = source.text.replace("prepared = fixture;", "prepared = undefined;");
  expect(changed).not.toBe(source.text);
  expect(() => assertRunnerFingerprints(ts.createSourceFile(source.fileName, changed, ts.ScriptTarget.Latest, true))).toThrow(/only pinned/);
  const unsettled = source.text.replace("await settleReadBound(preparedSettled);", "return;");
  expect(unsettled).not.toBe(source.text);
  expect(() => assertRunnerFingerprints(ts.createSourceFile(source.fileName, unsettled, ts.ScriptTarget.Latest, true))).toThrow(/only pinned/);
  const moved = source.text.replace('describe("distinct settled read fixture"', 'describe("unreviewed fixture scope"');
  expect(moved).not.toBe(source.text);
  expect(() => assertRunnerFingerprints(ts.createSourceFile(source.fileName, moved, ts.ScriptTarget.Latest, true))).toThrow(/only pinned/);
};

export const checkNavigationExportCensusIncludesRenamedArraysAndImportedScopeTypes = () => {
  const source = ts.createSourceFile("probe.ts", `
    import type { NavigationArgs } from "./imported-scope";
    export function importedScope(args: NavigationArgs): void {}
    export function renamedArray(perms: readonly string[]): void {}
    export function renamedProperty(scope: { grants: string[] }): void {}
  `, ts.ScriptTarget.Latest, true);
  expect(callableNavigationExports(source), "callable exports cannot disappear through noResolve or a permissions rename")
    .toStrictEqual(["importedScope", "renamedArray", "renamedProperty"]);
};

export const checkNavigationCensusRefusesLiteralDynamicImportsAndRequireLoaders = () => {
  for (const form of [
    'void import("./utils/supplierNavigation")',
    'require("./utils/supplierNavigation")',
    'void import(`./utils/supplierNavigation`)',
    'require(`./utils/supplierNavigation`)',
    'module.require("./utils/supplierNavigation")',
    'module.require(`./utils/supplierNavigation`)',
    'import navigation = require("./utils/supplierNavigation")',
  ]) {
    const source = ts.createSourceFile("convex/loader-probe.ts", form, ts.ScriptTarget.Latest, true);
    expect(() => refuseDynamicNavigation(source), `dynamic loader cell: ${form}`).toThrow(/dynamic navigation import\/require/);
  }
};

export const checkCallerRunnerCensusRefusesWholeFileOverrides = () => {
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
  const imports = ts.createSourceFile("runner-imports.ts", original, ts.ScriptTarget.Latest, true).statements
    .filter(ts.isImportDeclaration).map(node => node.getText()).join("\n");
  const forms = [
    'relationshipCells = async () => {};',
    '{ navigationCells = async () => {}; }',
    'class RunnerSetup { static { relationshipCells = async () => {}; } }',
    'test("older body replacement", () => { navigationCells = async () => {}; });',
    'test("nested replacement", () => { function nested() { verifyCallerAssertions = () => {}; } nested(); });',
    'assertCallerResult = () => {}; verifyCallerAssertions = () => {};',
    'test("compound", () => { callerAudits.length += 1; });',
    'test("update", () => { callerAudits.length++; });',
    'test("delete", () => { delete callerAudits[0]; });',
    'test("destructure", () => { ({ navigationCells } = replacement); });',
    'test("class expression", () => { const setup = class {}; });',
    'expect.extend({});',
    'test("alias matcher method", () => { const extendMatcher = expect.extend; extendMatcher({}); });',
    'test("alias matcher owner", () => { const assertionApi = expect; assertionApi.extend({}); });',
    'test("destructured matcher", () => { const { extend } = expect; extend({}); });',
    'describe("alias hook", () => { const hook = afterEach; hook(() => {}); });',
    'test("alias spy", () => { const spy = vi.spyOn; spy(expect, "getState"); });',
    'test("computed matcher", () => { expect["ex" + "tend"]({}); });',
    'test("identity matcher alias", () => { const assertionApi = expect.valueOf(); assertionApi.extend({}); });',
    'test("state alias", () => { const state = expect.getState(); state.currentTestName = "other"; });',
    'describe("called hook alias", () => { afterEach.call(null, () => {}); });',
    'test("chainable vi alias", () => { const utils = vi.useFakeTimers(); utils.stubGlobal("expect", replacement); });',
    'function seed() { const mockModule = vi.mock; mockModule("vitest"); }',
    'function seed() { vi.spyOn(PERMISSIONS, "VIEW_SALES"); }',
    'test("spoof title", () => { expect.setState({ currentTestName: "other" }); });',
    'test("write state", () => { expect.getState().currentTestName = "other"; });',
    'test("matcher inside", () => { expect["addEqualityTesters"]([]); });',
    'expect.addSnapshotSerializer({});',
    'beforeEach(() => expect.extend({}));',
    'test("nested hook", () => { afterAll(() => {}); });',
    'describe("older suite", () => { test.' + 'only("selection", () => {}); });',
    'vi.mock("vitest");',
    'vi.doMock("./supplierStatement");',
    'vi.hoisted(() => {});',
    'vi.spyOn(expect, "getState");',
    'vi.spyOn(callerAudits, "push");',
    'vi.spyOn(PERMISSIONS, "VIEW_SALES");',
    'vi.stubGlobal("expect", replacement);',
    'test("eval", () => { eval("code"); });',
    'test("function constructor", () => { new Function("code"); });',
    'test("tagged function", () => { Function`code`; });',
  ];
  for (const form of forms) {
    const source = ts.createSourceFile("runner-refusal.ts", imports + "\n" + form, ts.ScriptTarget.Latest, true);
    expect(() => refuseRunnerOverrides(source), form).toThrow();
  }

};

function assertRunnerStatementRefusal(form: string): void {
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
  const source = ts.createSourceFile("runner-statement-refusal.ts", original + "\n" + form, ts.ScriptTarget.Latest, true);
  expect(() => assertRunnerFingerprints(source), form).toThrow();
}

export const checkCallerRunnerCensusRefusesAnUnreviewedSideEffectImport = () => { assertRunnerStatementRefusal('import "./unreviewed-side-effect";'); };

export const checkCallerRunnerCensusRefusesAnUnlistedVoidStatement = () => { assertRunnerStatementRefusal('void 0;'); };

export const checkCallerRunnerCensusRefusesAnUnlistedEmptyStatement = () => { assertRunnerStatementRefusal(';'); };

function assertRunnerFormattingControl(change: "comment" | "whitespace", part: RunnerPinPart): void {
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
  const text = change === "comment" ? "// formatting control\n" + original : original.replace("function verifyCallerAssertions(", "function   verifyCallerAssertions( ");
  const source = ts.createSourceFile("runner-control.ts", text, ts.ScriptTarget.Latest, true);
  expect(() => assertRunnerFingerprints(source, part)).not.toThrow();
}

export const checkCallerRunnerCensusAcceptsCommentOnlyEnvelopeControls = () => { assertRunnerFormattingControl("comment", "envelope"); };

export const checkCallerRunnerCensusAcceptsCommentOnlyEvenControls = () => { assertRunnerFormattingControl("comment", "even"); };

export const checkCallerRunnerCensusAcceptsCommentOnlyOddControls = () => { assertRunnerFormattingControl("comment", "odd"); };

export const checkCallerRunnerCensusAcceptsWhitespaceOnlyEnvelopeControls = () => { assertRunnerFormattingControl("whitespace", "envelope"); };

export const checkCallerRunnerCensusAcceptsWhitespaceOnlyEvenControls = () => { assertRunnerFormattingControl("whitespace", "even"); };

export const checkCallerRunnerCensusAcceptsWhitespaceOnlyOddControls = () => { assertRunnerFormattingControl("whitespace", "odd"); };

export const checkCallerReceiptOracleRejectsACountThatDisagreesWithIndependentlyDeclaredCells = () => {
  const source = parse("convex/supplierNavigation.scrum869.test.ts");
  const declaration = source.statements.filter(ts.isVariableStatement).flatMap(node => node.declarationList.declarations)
    .find(node => node.name.getText(source) === "EXPECTED_CALLER_RECEIPTS");
  const initializer = declaration?.initializer;
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) throw new Error("literal count fixture unavailable");
  const first = initializer.properties[0];
  if (!first || !ts.isPropertyAssignment(first) || !ts.isNumericLiteral(first.initializer)) throw new Error("literal count fixture unavailable");
  expect(first.initializer.text, "the first caller declaration has four cells").toBe("4");
  const changed = source.text.slice(0, first.initializer.getStart(source)) + "3" + source.text.slice(first.initializer.end);
  expect(() => assertCallerReceiptCounts(source)).not.toThrow();
  expect(() => assertCallerReceiptCounts(ts.createSourceFile(source.fileName, changed, ts.ScriptTarget.Latest, true)))
    .toThrow(/literal receipt counts must match independent declared cells/);
};

export const checkSupplierCacheFingerprintsRefuseUnreviewedChangesToBothCacheFunctions = () => {
  const source = parse("convex/utils/supplierReadCache.ts");
  expect(() => assertCacheFingerprints(source)).not.toThrow();
  for (const [name, before, after] of [
    ["createSupplierReadCache", "export function createSupplierReadCache() {", "export function createSupplierReadCache() { void 0;"],
    ["readCached", "  return doc;", "  return null;"],
  ] as const) {
    expect(source.text.includes(before), name + ": source fixture must exist").toBe(true);
    const changed = ts.createSourceFile(source.fileName, source.text.replace(before, after), ts.ScriptTarget.Latest, true);
    expect(() => assertCacheFingerprints(changed), name).toThrow(new RegExp(name));
  }
};
