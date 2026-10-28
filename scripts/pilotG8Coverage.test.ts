import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import ts from "typescript";
import scenarioConfig from "../playwright.scenarios.config";
import roleConfig from "../playwright.role-audit.config";
import { pilotExplorerSeed, pilotExplorerStarts, pilotExplorerTitle, PILOT_ACCOUNTING_VIEWS, PILOT_G8_ROLE_PROJECT, PILOT_G8_ROLE_TAG } from "../playwright/fixtures/pilotHunt";

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

/** Project names reachable through `dependencies`, i.e. the config's dependency graph. */
function dependencyDepth(projects: readonly { name?: string; dependencies?: readonly string[] }[], name: string): number {
  const project = projects.find(item => item.name === name);
  if (!project) throw new Error(`absent project ${name}`);
  return 1 + Math.max(-1, ...(project.dependencies ?? []).map(dependency => dependencyDepth(projects, dependency)));
}

function testCalls(file: string) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const calls: { title: string; options?: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "test" && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      calls.push({ title: node.arguments[0].text, options: node.arguments.length === 3 ? node.arguments[1].getText(source) : undefined });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

test("G8 scripted witnesses sit in their own project that nothing depends on, after the ledger matrix", () => {
  const projects = scenarioConfig.projects ?? [];
  const scripted = projects.find(project => project.name === "pilot-scripted");
  expect(scripted?.testDir).toBe("./playwright/tests");
  expect(scripted?.testMatch).toEqual(["sales.spec.ts", "financed-deal-economics.spec.ts", "accounting.spec.ts"]);
  expect(scripted?.dependencies).toEqual(["setup"]);
  // The pre-existing matrix project keeps exactly its origin/main dependencies.
  expect(projects.find(project => project.name === "chromium")?.dependencies).toEqual(["setup"]);
  expect(projects.some(project => project.dependencies?.includes("pilot-scripted"))).toBe(false);
  // Same phase, listed last: at one worker the matrix runs first and sees its old state.
  expect(projects.map(project => project.name).at(-1)).toBe("pilot-scripted");
  expect(projects[1].name).toBe("chromium");
  expect(roleConfig.projects?.some(project => project.name === "pilot-scripted")).toBe(false);
  const names = new Set(roleConfig.projects?.map(project => project.name));
  for (const project of roleConfig.projects ?? []) for (const dependency of project.dependencies ?? []) {
    expect(names.has(dependency), `${project.name} depends on absent ${dependency}`).toBe(true);
  }
});

test("G8 role journeys run in their own project: before the matrix isolates the seat, never gating it", () => {
  const projects = roleConfig.projects ?? [];
  const regressions = projects.find(project => project.name === "role-regressions");
  const g8 = projects.find(project => project.name === PILOT_G8_ROLE_PROJECT);
  expect(PILOT_G8_ROLE_PROJECT).toBe("pilot-g8-role-hunt");
  expect(regressions?.dependencies).toEqual(["setup"]);
  expect(g8?.dependencies).toEqual(["setup"]);
  expect(g8?.testMatch).toBe(regressions?.testMatch);
  expect(g8?.use).toEqual(regressions?.use);
  // The tag partitions the one spec file: every case runs in exactly one project.
  expect(String(g8?.grep)).toBe(String(new RegExp(PILOT_G8_ROLE_TAG)));
  expect(String(regressions?.grepInvert)).toBe(String(g8?.grep));
  // Nothing depends on the G8 project; the matrix keeps its main dependency list.
  expect(projects.some(project => project.dependencies?.includes(PILOT_G8_ROLE_PROJECT))).toBe(false);
  const matrix = projects.find(project => project.name === "chromium");
  expect(matrix?.dependencies).toEqual(["setup", "role-regressions"]);
  // Playwright runs dependency phases to completion in order. Equal depth to
  // role-regressions means the G8 journeys finish before the matrix starts.
  expect(dependencyDepth(projects, PILOT_G8_ROLE_PROJECT)).toBe(dependencyDepth(projects, "role-regressions"));
  expect(dependencyDepth(projects, PILOT_G8_ROLE_PROJECT)).toBeLessThan(dependencyDepth(projects, "chromium"));
  const titles = testCalls("playwright/tests/audit-role-access.spec.ts");
  const tagged = titles.filter(call => call.options === "{ tag: PILOT_G8_ROLE_TAG }").map(call => call.title);
  expect(tagged).toEqual([
    "pilot Accounting traversal paints every section and nested reader",
    "pilot Sales opens CASH and configured FINANCED entry panels for each audited role",
    "pilot Deals opens owned and SOURCED cash and configured financed detail screens",
  ]);
  expect(titles.filter(call => call.options !== undefined).length).toBe(tagged.length);
});

test("G8 explorer runs one test per start, restores the Dashboard random walk and seeds each start apart", () => {
  const titles = testCalls("playwright/scenarios/jev-explorer.spec.ts").map(call => call.title);
  const planned = pilotExplorerStarts().map(pilotExplorerTitle);
  expect(new Set(planned).size).toBe(12);
  expect(titles.filter(title => title.startsWith("pilot explorer ")).sort()).toEqual([...planned].sort());
  expect(titles).toContain("random walk");
  const source = readFileSync("playwright/scenarios/jev-explorer.spec.ts", "utf8");
  expect(source).toMatch(/test\("random walk"[^]*?route: "dashboard", seed: SEED/);
  for (const base of [1, 4242, 99_999]) {
    const seeds = pilotExplorerStarts().map(start => pilotExplorerSeed(base, start));
    expect(new Set(seeds).size).toBe(12);
    expect(seeds.every(seed => Number.isInteger(seed) && seed > 0 && seed < 2 ** 32)).toBe(true);
    expect(seeds).toEqual(pilotExplorerStarts().map(start => pilotExplorerSeed(base, start)));
  }
});