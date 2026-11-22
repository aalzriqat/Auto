import { expect } from "vitest";
import ts from "typescript";
import { refuseRunnerOverrides } from "./runnerSyntax";
import { assertSecondBindingForms, assertReferenceForms, assertIntrinsicForms } from "./navigationProbes";
import { parse } from "./source";
import { assertAdmittedRunnerReferences, assertRunnerCallback } from "./runnerReferences";

export const checkCallerRunnerCensusRefusesIterationWritesToProtectedTargets = () => {
  const forms = [
    "test(\"for of write\", () => { for (relationshipCells of []) {} });",
    "test(\"for in property write\", () => { for (callerAudits[0] in {}) {} });",
    "test(\"for of destructure write\", () => { for ({ relationshipCells } of []) {} });",
    "test(\"for await write\", async () => { for await (relationshipCells of []) {} });"
  ];
  for (const form of forms) {
    const source = ts.createSourceFile("static-write.ts", form, ts.ScriptTarget.Latest, true);
    expect(() => refuseRunnerOverrides(source), form).toThrow(/write to a protected top-level runner binding/);
  }
};

export const checkCallerRunnerCensusUnwrapsErasedTypesBeforeCheckingProtectedWrites = () => {
  const forms = [
    "test(\"prefix assertion write\", () => { (<typeof relationshipCells>relationshipCells) = replacement; });",
    "test(\"satisfies write\", () => { (relationshipCells satisfies typeof relationshipCells) = replacement; });"
  ];
  for (const form of forms) {
    const source = ts.createSourceFile("static-write.ts", form, ts.ScriptTarget.Latest, true);
    expect(() => refuseRunnerOverrides(source), form).toThrow(/write to a protected top-level runner binding/);
  }
};

export const checkCallerAdmittedReferenceTableRefusesVariableSecondBindingsGroup1 = () => {
  assertSecondBindingForms([
'const relationshipCells = async () => {};',
'let callerAudits = [];'
], /ADMITTED_RUNNER_REFERENCES refuses second binding/);
};

export const checkCallerAdmittedReferenceTableRefusesVariableSecondBindingsGroup2 = () => {
  assertSecondBindingForms([
'var EXPECTED_CALLER_RECEIPTS = {};'
], /ADMITTED_RUNNER_REFERENCES refuses second binding/);
};

export const checkCallerAdmittedReferenceTableRefusesDestructuredAndParameterSecondBindingsGroup1 = () => {
  assertSecondBindingForms([
'const { relationshipCells } = replacement;',
'const { nested: { callerAudits } } = replacement;'
], /ADMITTED_RUNNER_REFERENCES refuses second binding/);
};

export const checkCallerAdmittedReferenceTableRefusesDestructuredAndParameterSecondBindingsGroup2 = () => {
  assertSecondBindingForms([
'function nested(expect: unknown) {}'
], /ADMITTED_RUNNER_REFERENCES refuses second binding/);
};

export const checkCallerAdmittedReferenceTableRefusesFunctionSecondBindingsGroup1 = () => {
  assertSecondBindingForms([
'function nested({ role: callerAudits }: unknown) {}',
'function relationshipCells() {}'
], /ADMITTED_RUNNER_REFERENCES refuses second binding/);
};

export const checkCallerAdmittedReferenceTableRefusesFunctionSecondBindingsGroup2 = () => {
  assertSecondBindingForms([
'const nested = function assertCallerResult() {};'
], /ADMITTED_RUNNER_REFERENCES refuses second binding/);
};

export const checkCallerAdmittedReferenceTableRefusesClassCatchAndImportSecondBindings = () => {
  assertSecondBindingForms([
    'class verifyCallerAssertions {}',
    'try {} catch (callerAudits) {}',
  ], /ADMITTED_RUNNER_REFERENCES refuses second binding/);
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
  const importedShadow = original + '\nimport { value as relationshipCells } from "./unreviewed";';
  expect(() => assertAdmittedRunnerReferences(ts.createSourceFile("runner-import-binding.ts", importedShadow, ts.ScriptTarget.Latest, true)))
    .toThrow(/ADMITTED_RUNNER_REFERENCES refuses second binding relationshipCells/);
};

export const checkCallerAdmittedReferenceTableClosesEveryRegistrationCallbackEnvelope = () => {
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
  const title = 'test("relationship query preserves the viewer vehicle permission for sourced and owned rows", async () => {';
  for (const callback of [
    'async (_ctx, relationshipCells = async cells => { callerAudits.push({ expected: cells, asserted: [...cells], message: "forged" }); }) => {',
    'async (_ctx, noOp = () => {}) => {',
    'async function (context) {',
  ]) {
    const text = original.replace(title, title.replace("async () => {", callback));
    expect(text, "callback mutation must change the real fixture").not.toBe(original);
    expect(() => assertAdmittedRunnerReferences(ts.createSourceFile("runner-envelope.ts", text, ts.ScriptTarget.Latest, true)), callback)
      .toThrow(/ADMITTED_RUNNER_REFERENCES requires a zero-parameter/);
  }
  for (const form of ['test("nested", (context) => {});', 'describe("nested", function (context) {});', 'it("nested", (context) => {});']) {
    const source = ts.createSourceFile("envelope.ts", form, ts.ScriptTarget.Latest, true);
    const statement = source.statements[0];
    if (!statement || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) throw new Error("literal callback fixture unavailable");
    const call = statement.expression;
    expect(() => assertRunnerCallback(source, call), form)
      .toThrow(/zero-parameter/);
  }
};

export const checkCallerAdmittedReferenceTableRefusesReceiptWritesAliasesAndTypeofGroup1 = () => {
  assertReferenceForms([
'callerAudits.push({ expected: [], asserted: [], message: "forged" });',
'const auditAlias = callerAudits;'
], /ADMITTED_RUNNER_REFERENCES/);
};

export const checkCallerAdmittedReferenceTableRefusesReceiptWritesAliasesAndTypeofGroup2 = () => {
  assertReferenceForms([
'const countAlias = EXPECTED_CALLER_RECEIPTS;',
'void typeof callerAudits;'
], /ADMITTED_RUNNER_REFERENCES/);
};

export const checkCallerAdmittedReferenceTableRefusesReceiptSpreadsAndMutationMethodsGroup1 = () => {
  assertReferenceForms([
'const copy = [...callerAudits];',
'Object.assign(EXPECTED_CALLER_RECEIPTS, {});'
], /ADMITTED_RUNNER_REFERENCES/);
};

export const checkCallerAdmittedReferenceTableRefusesReceiptSpreadsAndMutationMethodsGroup2 = () => {
  assertReferenceForms([
'Object.defineProperty(EXPECTED_CALLER_RECEIPTS, "title", { value: 0 });',
'callerAudits.push = () => 0;'
], /ADMITTED_RUNNER_REFERENCES/);
};

export const checkCallerAdmittedReferenceTableRefusesGlobalAssignmentsUpdatesAndDeletionGroup1 = () => {
  assertReferenceForms([
'Array.prototype.toSorted = () => [];',
'Object.is = () => true;'
], /ADMITTED_RUNNER_REFERENCES/);
};

export const checkCallerAdmittedReferenceTableRefusesGlobalAssignmentsUpdatesAndDeletionGroup2 = () => {
  assertReferenceForms([
'globalThis.reviewFlag++;',
'delete Array.prototype.toSorted;'
], /ADMITTED_RUNNER_REFERENCES/);
};

export const checkCallerAdmittedReferenceTableRefusesIntrinsicRebindingAndObjectMutatorsGroup1 = () => {
  assertReferenceForms([
'({ Array } = replacement);',
'Object.defineProperties(Array.prototype, {});'
], /ADMITTED_RUNNER_REFERENCES/);
};

export const checkCallerAdmittedReferenceTableRefusesIntrinsicRebindingAndObjectMutatorsGroup2 = () => {
  assertReferenceForms([
'Object.setPrototypeOf(Object, {});',
'Reflect.set(Array.prototype, "toSorted", () => []);'
], /ADMITTED_RUNNER_REFERENCES/);
};

export const checkCallerAdmittedReferenceTableRefusesReflectMutatorsAndDynamicImportsGroup1 = () => {
  assertReferenceForms([
'Reflect.defineProperty(Object, "is", { value: () => true });',
'Reflect.setPrototypeOf(Object, {});'
], /ADMITTED_RUNNER_REFERENCES/);
};

export const checkCallerAdmittedReferenceTableRefusesReflectMutatorsAndDynamicImportsGroup2 = () => {
  assertReferenceForms([
'void import("./utils/supplierNavigation");'
], /ADMITTED_RUNNER_REFERENCES/);
};

export const checkCallerAdmittedReferenceTableAdmitsDirectLocalObjectMutationControls = () => {
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
  const title = 'test("caller matcher canaries refuse known false strict and partial comparisons", () => {';
  const local = original.replace(title, title + '\n const local = {}; Object.assign(local, { value: 1 }); Object.defineProperty(local, "other", {value: 2});');
  expect(() => assertAdmittedRunnerReferences(ts.createSourceFile("runner-local-control.ts", local, ts.ScriptTarget.Latest, true)))
    .not.toThrow();
};

export const checkCallerIntrinsicAdmissionsRefuseLiteralAndParenthesizedGlobalMutatorsGroup1 = () => {
  assertIntrinsicForms([
'Object["defineProperty"](Array.prototype, "reviewSlot", { value: 1 });',
'(Object.defineProperty)(Array.prototype, "reviewSlot", { value: 1 });'
], /ADMITTED_RUNNER_REFERENCES/);
};

export const checkCallerIntrinsicAdmissionsRefuseLiteralAndParenthesizedGlobalMutatorsGroup2 = () => {
  assertIntrinsicForms([
'(Object).defineProperty(Array.prototype, "reviewSlot", { value: 1 });',
'Reflect["set"](Array.prototype, "reviewSlot", 1);'
], /ADMITTED_RUNNER_REFERENCES/);
};

export const checkCallerIntrinsicAdmissionsRefuseWrappedMutatorsAliasesAndCallEscapesGroup1 = () => {
  assertIntrinsicForms([
'Object["defineProperties"](Array.prototype, {});',
'(Reflect.setPrototypeOf)(Array.prototype, {});'
], /ADMITTED_RUNNER_REFERENCES/);
};

export const checkCallerIntrinsicAdmissionsRefuseWrappedMutatorsAliasesAndCallEscapesGroup2 = () => {
  assertIntrinsicForms([
'const mutate = Object.defineProperty; mutate(Array.prototype, "reviewSlot", { value: 1 });',
'Object.defineProperty.call(null, Array.prototype, "reviewSlot", { value: 1 });'
], /ADMITTED_RUNNER_REFERENCES/);
};

export const checkCallerIntrinsicAdmissionsAdmitDirectLocalLiteralMemberControls = () => {
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
  const title = 'test("caller matcher canaries refuse known false strict and partial comparisons", () => {';
  const local = original.replace(title, title + '\n const local = {}; (Object["assign"])(local, { value: 1 }); Reflect["set"](local, "other", 2);');
  expect(() => assertAdmittedRunnerReferences(ts.createSourceFile("runner-local-intrinsic.ts", local, ts.ScriptTarget.Latest, true)))
    .not.toThrow();
};
