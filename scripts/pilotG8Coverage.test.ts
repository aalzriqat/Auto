import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import ts from "typescript";
import scenarioConfig from "../playwright.scenarios.config";
import roleConfig from "../playwright.role-audit.config";
import { pilotExplorerStarts, PILOT_ACCOUNTING_VIEWS } from "../playwright/fixtures/pilotHunt";

test("G8 explorer declares twelve pilot starts and consumes the plan", () => {
  const starts = pilotExplorerStarts();
  expect(starts.map(s => `${s.route}:${s.locale}:${s.viewport.name}`).sort()).toEqual([
    "accounting:ar:desktop", "accounting:ar:phone", "accounting:en:desktop", "accounting:en:phone",
    "deals:ar:desktop", "deals:ar:phone", "deals:en:desktop", "deals:en:phone",
    "sales:ar:desktop", "sales:ar:phone", "sales:en:desktop", "sales:en:phone",
  ]);
  expect(starts.filter(s => s.viewport.name === "phone").every(s => s.viewport.width === 320)).toBe(true);
  // A plan that is never consumed by the actual explorer is not coverage.
  const source = ts.createSourceFile("jev-explorer.spec.ts", readFileSync("playwright/scenarios/jev-explorer.spec.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node.expression.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(calls).toContain("pilotExplorerStarts");
});

test("G8 Accounting traversal reaches the register, collections and each report beyond Overview", () => {
  expect(PILOT_ACCOUNTING_VIEWS.map(v => `${v.section}/${v.tabs.join("/")}`)).toEqual([
    "overview/", "receivables/claims", "receivables/collections/receivables", "receivables/collections/cheques",
    "receivables/collections/paymentLinks", "receivables/collections/cashDrawer", "receivables/collections/payments",
    "receivables/collections/reports", "receivables/collections/approvals", "cash/", "journal/register", "journal/manual", "reconcile/",
    "statements/trialBalance", "statements/incomeStatement", "statements/balanceSheet", "statements/vatReturn",
    "assets/fixedAssets", "assets/prepaid", "assets/equity", "settings/",
  ]);
});


test("G8 scripted journeys run once before the shared ledger matrix and never under a role-audit seat", () => {
  const scripted = scenarioConfig.projects?.find(project => project.name === "pilot-scripted");
  expect(scripted?.testDir).toBe("./playwright/tests");
  expect(scripted?.testMatch).toEqual(["sales.spec.ts", "financed-deal-economics.spec.ts", "accounting.spec.ts"]);
  expect(scenarioConfig.projects?.find(project => project.name === "chromium")?.dependencies).toContain("pilot-scripted");
  expect(roleConfig.projects?.some(project => project.name === "pilot-scripted")).toBe(false);
  const names = new Set(roleConfig.projects?.map(project => project.name));
  for (const project of roleConfig.projects ?? []) for (const dependency of project.dependencies ?? []) {
    expect(names.has(dependency), `${project.name} depends on absent ${dependency}`).toBe(true);
  }
});
