import { expect } from "vitest";
import ts from "typescript";
import { parse } from "./source";
import { navigationConditions } from "./navigationCoverage";
import { assertAdmittedRunnerReferences } from "./runnerReferences";

export function assertRuntimeControlForms(forms: readonly (readonly [string, string, string])[]): void {
  if (forms.length === 0) throw new Error("assertRuntimeControlForms requires non-empty forms");
  for (const [code, condition, form] of forms) {
    const escapedForm = form!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(() => navigationConditions(ts.createSourceFile("probe.ts", code!, ts.ScriptTarget.Latest, true)), condition).toThrow(new RegExp(`Unsupported navigation ${escapedForm}: .* at probe\\.ts:1:`));
  }
}

export function assertSecondBindingForms(forms: readonly string[], expectedMessage: RegExp): void {
  if (forms.length === 0) throw new Error("assertSecondBindingForms requires non-empty forms");
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
  const title = 'test("caller matcher canaries refuse known false strict and partial comparisons", () => {';
  for (const form of forms) {
    const text = original.replace(title, title + "\n" + form);
    expect(text, "binding mutation must change the real fixture").not.toBe(original);
    const source = ts.createSourceFile("runner-binding.ts", text, ts.ScriptTarget.Latest, true);
    expect(() => assertAdmittedRunnerReferences(source), form).toThrow(expectedMessage);
  }
}

export function assertReferenceForms(forms: readonly string[], expectedMessage: RegExp): void {
  if (forms.length === 0) throw new Error("assertReferenceForms requires non-empty forms");
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
  const title = 'test("caller matcher canaries refuse known false strict and partial comparisons", () => {';
  for (const form of forms) {
    const text = original.replace(title, title + "\n" + form);
    expect(text, "reference mutation must change the real fixture").not.toBe(original);
    expect(() => assertAdmittedRunnerReferences(ts.createSourceFile("runner-reference.ts", text, ts.ScriptTarget.Latest, true)), form)
      .toThrow(expectedMessage);
  }
}

export function assertIntrinsicForms(forms: readonly string[], expectedMessage: RegExp): void {
  if (forms.length === 0) throw new Error("assertIntrinsicForms requires non-empty forms");
  const original = parse("convex/supplierNavigation.scrum869.test.ts").text;
  const title = 'test("caller matcher canaries refuse known false strict and partial comparisons", () => {';
  for (const form of forms) {
    const text = original.replace(title, title + "\n" + form);
    const source = ts.createSourceFile("runner-intrinsic-admission.ts", text, ts.ScriptTarget.Latest, true);
    expect(() => assertAdmittedRunnerReferences(source), form).toThrow(expectedMessage);
  }
}
