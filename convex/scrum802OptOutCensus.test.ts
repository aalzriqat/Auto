/**
 * SCRUM-802 (owner ruling, Option A): the pilot cash-sale containment must run for real.
 *
 * `vitest.setup.ts` no longer turns `CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED` off. A suite that only uses a cash
 * completion as a fixture (complete a cash sale, then collect or cancel it, to test something else) opts out with a
 * file-level `vi.mock` marked "SCRUM-802 legacy-cash-lifecycle opt-out". This census is the ratchet: the opt-out list
 * is exactly the one below, so a new suite cannot quietly run with the containment off, and the certification and
 * rehearsal files can never be on it. Shrinking the list (re-cutting a suite to pay by deposit) is always allowed;
 * delete the entry in the same change.
 *
 * How an opt-out is verified: the file is parsed with the TypeScript compiler API and the EFFECTIVE value of the switch
 * in the object the mock factory returns is evaluated. It counts only for a top-level `vi.mock` of the containment
 * module whose factory returns an object literal ending with a falsy literal on the switch. A marker, a comment, a
 * pass-through mock, a spread after the key (it restores the real value), a nested object, `|| true`, a variable, a
 * shorthand, a `vi.doMock` nothing imports after, a conditional or later-undone mock do not count. The evaluator reads
 * object-literal factories only; any other factory shape is refused (so the suite must be written in the plain shape).
 * The independent `turnsSwitchOff` text detector additionally flags any unmarked mock of the gate modules.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const MARK = "SCRUM-802 legacy-cash-lifecycle opt-out";

const ALLOWED_OPT_OUTS: readonly string[] = [
  "components/deposits/QuoteDepositManager.test.tsx",
  "convex/accountingPhase0.test.ts",
  "convex/accountingPhase8.test.ts",
  "convex/accountingPhase9.test.ts",
  "convex/accountingReceiptMovement.test.ts",
  "convex/accountingVehicleInventory.test.ts",
  "convex/applications.test.ts",
  "convex/billOfSaleEconomics.test.ts",
  "convex/cashApplicationFinancierLeg.test.ts",
  "convex/chequeCancelledSaleCredit.test.ts",
  "convex/commissionAccrualTiming.test.ts",
  "convex/commissionMarginBase.test.ts",
  "convex/commitmentFinalization.test.ts",
  "convex/commitmentRestorationSpine.test.ts",
  "convex/consignedDepositResolution.test.ts",
  "convex/consignedReporting.test.ts",
  "convex/consignedSettlementRoute.test.ts",
  "convex/consignmentEconomics.test.ts",
  "convex/depositCancellationPending.test.ts",
  "convex/depositRevenueRecognition.test.ts",
  "convex/deposits.test.ts",
  "convex/financeLifecyclePhase1.test.ts",
  "convex/financeLifecyclePhase3.test.ts",
  "convex/financeLifecyclePhase4.test.ts",
  "convex/financedConsignedSettlement.test.ts",
  "convex/financierLegNotApplicable.test.ts",
  "convex/migrateConsignedSaleBasis.test.ts",
  "convex/multiVehicleDepositAllocation.test.ts",
  "convex/profitApprovalEnforcement.test.ts",
  "convex/retiredDealModes.test.ts",
  "convex/saleCancellationOutcomeMatrix.test.ts",
  "convex/saleCompletionTenancyGuards.test.ts",
  "convex/saleOwnedTeardown.test.ts",
  "convex/sales.test.ts",
  "convex/salesCommissionEntry.test.ts",
  "convex/scrum230MonthlyCronIsolation.test.ts",
  "convex/scrum411P202ForwardedDeposit.test.ts",
  "convex/scrum415FinancedDoor.test.ts",
  "convex/scrum571s1Containment.test.ts",
  "convex/scrum571s2CashSettlement.test.ts",
  "convex/scrum641DeletedVehicleDoors.test.ts",
  "convex/scrum693VehicleNotReadyForSale.test.ts",
  "convex/scrum69FinanceDoor.test.ts",
  "convex/supplierPayableSettlement.test.ts",
  "convex/supplierPayablesReconciliation.scrum651.test.ts",
  "convex/supplierReceivables.test.ts",
];

const MUST_RUN_WITH_REAL_SWITCH = [
  "convex/scrum486Certification.test.ts",
  "convex/accountingReleaseRehearsal.test.ts",
  "convex/scrum802CashSaleContainment.test.ts",
  "convex/scrum802CashSaleExtras.test.ts",
  "convex/scrum802CashSaleOrdering.test.ts",
  // Bound to the regression scenario cash-sale-with-tax-is-refused-with-the-specific-code-before-any-write.
  "convex/ownedSaleTaxEndToEnd.test.ts",
] as const;

// The mutation attacks on the extras switch (CASH_SALE_EXTRAS_PILOT_REFUSED): each mocks the gate module and flips ONLY
// that switch, so it is neither an opt-out nor allowed to touch the full-payment switch.
const EXTRAS_SWITCH_ATTACKS: readonly string[] = ["convex/scrum802CashSaleExtrasSwitchAttack.test.ts"];

// Mirrors vitest.config.ts: include **/*.test.ts(x) from the repository root, exclude these directories.
const EXCLUDED_DIRS = new Set(["node_modules", ".next", "out", "build", "apps", "packages"]);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (EXCLUDED_DIRS.has(name) || name.startsWith(".")) continue;
    const path = dir === "." ? name : join(dir, name);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

// Anything that turns the switch off or replaces the gate module, however it is spelled. Two independent detectors:
// (1) any vi.mock / vi.doMock call that names either gate module (optional extension, import(...) form, any quote or
//     backtick), and (2) the switch's name used as an object key with any value other than the literal `true`
//     (false, !1, 0, undefined, null, a variable...).
const MOCKS_GATE_MODULE = /vi\.(?:mock|doMock)\s*\(\s*(?:import\s*\(\s*)?["'`][^"'`]*(?:saleDebtContainment|cashSalePilotGate)/;
const SETS_SWITCH_NOT_TRUE = /CASH_SALE_(?:FULL_PAYMENT_PILOT_REQUIRED|EXTRAS_PILOT_REFUSED)\s*:\s*(?!\s|true\b)/;
function turnsSwitchOff(src: string): boolean {
  return MOCKS_GATE_MODULE.test(src) || SETS_SWITCH_NOT_TRUE.test(src);
}

// What a marked opt-out must actually DO, not merely say. The marker text, a comment, a string, a pass-through
// `importOriginal()` mock, a doMock that nothing imports after, or a mock that is conditional or later undone do not turn
// the switch off. The source is parsed with the TypeScript compiler API and the EFFECTIVE value of the switch in the
// object the mock factory returns is evaluated: only a top-level `vi.mock` of the containment module whose factory
// returns an object literal in which the LAST word on the switch is a falsy literal counts (a spread after the key
// restores the real value; a nested object, `|| true`, a variable or a shorthand is not a falsy literal).
const FULL = "CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED";
const EXTRAS = "CASH_SALE_EXTRAS_PILOT_REFUSED";
const CONTAINMENT_MODULE = /(?:^|\/)saleDebtContainment(?:\.[cm]?[tj]s)?$/;
const MOCK_METHODS = new Set(["mock", "doMock", "unmock", "doUnmock"]);

function stripWrappers(expression: ts.Expression): ts.Expression {
  let e = expression;
  while (
    ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** false, null, undefined, 0, !1 (and !true): the literals that really switch a boolean off. Nothing computed. */
function isFalsyLiteral(expression: ts.Expression): boolean {
  const e = stripWrappers(expression);
  if (e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(e)) return e.text === "undefined";
  if (ts.isNumericLiteral(e)) return Number(e.text) === 0;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = stripWrappers(e.operand);
    return (ts.isNumericLiteral(operand) && Number(operand.text) !== 0) || operand.kind === ts.SyntaxKind.TrueKeyword;
  }
  return false;
}

/** A property's static name, or "?" when it is computed from something that is not a literal (it could be any key). */
function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const inner = stripWrappers(name.expression);
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  }
  return "?";
}

/** Whether the object literal leaves `key` off at the end (the last word on it is a falsy literal; a spread resets it). */
function objectLeavesKeyOff(object: ts.ObjectLiteralExpression, key: string): boolean {
  let off = false;
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = stripWrappers(property.expression);
      // A literal spread that does not name the key leaves it as it was; any other spread may restore the real value.
      off = ts.isObjectLiteralExpression(spread) ? (mentionsKey(spread, key) ? objectLeavesKeyOff(spread, key) : off) : false;
    } else if (ts.isPropertyAssignment(property)) {
      const name = propertyName(property.name);
      if (name === key) off = isFalsyLiteral(property.initializer);
      else if (name === "?") off = false;
    } else if (property.name) {
      const name = propertyName(property.name); // shorthand, method, accessor
      if (name === key || name === "?") off = false;
    }
  }
  return off;
}

/** Whether the object literal names `key` anywhere at its top level (a computed unknown name counts as naming it). */
function mentionsKey(object: ts.ObjectLiteralExpression, key: string): boolean {
  return object.properties.some((property) => {
    if (ts.isSpreadAssignment(property)) {
      const spread = stripWrappers(property.expression);
      return ts.isObjectLiteralExpression(spread) ? mentionsKey(spread, key) : false;
    }
    if (!property.name) return false;
    const name = propertyName(property.name);
    return name === key || name === "?";
  });
}

/** True when every spread in the object is a call of the factory's own first parameter (importOriginal), nothing else. */
function spreadsOnlyTheOriginal(object: ts.ObjectLiteralExpression, originalName: string | undefined): boolean {
  return object.properties.every((property) => {
    if (!ts.isSpreadAssignment(property)) return true;
    const spread = stripWrappers(property.expression);
    return (
      originalName !== undefined && ts.isCallExpression(spread) &&
      ts.isIdentifier(spread.expression) && spread.expression.text === originalName
    );
  });
}

function returnedObjects(factory: ts.Expression | undefined): ts.ObjectLiteralExpression[] | undefined {
  if (!factory || !(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) return undefined;
  const results: ts.Expression[] = [];
  if (!ts.isBlock(factory.body)) {
    results.push(factory.body);
  } else {
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && node !== factory) return; // a nested function's returns are not the factory's
      if (ts.isReturnStatement(node) && node.expression) results.push(node.expression);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(factory.body, visit);
  }
  if (results.length === 0) return undefined;
  const objects = results.map((r) => stripWrappers(r));
  return objects.every(ts.isObjectLiteralExpression) ? (objects as ts.ObjectLiteralExpression[]) : undefined;
}

function firstParameterName(factory: ts.Expression | undefined): string | undefined {
  if (!factory || !(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) return undefined;
  const parameter = factory.parameters[0];
  return parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : undefined;
}

function moduleSpecifier(call: ts.CallExpression): string | undefined {
  const first = call.arguments[0];
  if (!first) return undefined;
  const e = stripWrappers(first);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isCallExpression(e) && e.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const arg = e.arguments[0];
    return arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : undefined;
  }
  return undefined;
}

/** Every vi.mock / vi.doMock / vi.unmock / vi.doUnmock call that names the containment module, at any depth. */
function containmentCalls(source: ts.SourceFile): { call: ts.CallExpression; topLevelMock: boolean }[] {
  const out: { call: ts.CallExpression; topLevelMock: boolean }[] = [];
  const topLevel = new Set<ts.Node>(
    source.statements.filter(ts.isExpressionStatement).map((statement) => stripWrappers(statement.expression))
  );
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "vi" &&
      MOCK_METHODS.has(node.expression.name.text)
    ) {
      const specifier = moduleSpecifier(node);
      if (specifier !== undefined && CONTAINMENT_MODULE.test(specifier)) {
        out.push({ call: node, topLevelMock: node.expression.name.text === "mock" && topLevel.has(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function parse(src: string): ts.SourceFile {
  return ts.createSourceFile("subject.test.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

/** The factory objects of the file's containment mocks, or undefined when any call is not an accepted top-level vi.mock. */
function acceptedFactories(src: string): { objects: ts.ObjectLiteralExpression[]; original: string | undefined }[] | undefined {
  const calls = containmentCalls(parse(src));
  if (calls.length === 0 || calls.some((c) => !c.topLevelMock)) return undefined;
  const factories = calls.map(({ call }) => {
    const objects = returnedObjects(call.arguments[1]);
    return objects ? { objects, original: firstParameterName(call.arguments[1]) } : undefined;
  });
  return factories.every((f) => f !== undefined) ? (factories as { objects: ts.ObjectLiteralExpression[]; original: string | undefined }[]) : undefined;
}

function mocksFullPaymentSwitchOff(src: string): boolean {
  const factories = acceptedFactories(src);
  return factories !== undefined && factories.every((f) => f.objects.every((object) => objectLeavesKeyOff(object, FULL)));
}

/** The extras-switch attack: flips ONLY the extras switch, never names the full-payment switch, spreads only importOriginal. */
function flipsOnlyTheExtrasSwitch(src: string): boolean {
  const factories = acceptedFactories(src);
  return (
    factories !== undefined &&
    factories.every((f) =>
      f.objects.every(
        (object) =>
          objectLeavesKeyOff(object, EXTRAS) && !mentionsKey(object, FULL) && spreadsOnlyTheOriginal(object, f.original)
      )
    )
  );
}

/** An opt-out replaces the containment module only; replacing the gate module itself is never an opt-out. */
function replacesTheGateModule(src: string): boolean {
  return /vi\.(?:mock|doMock|unmock|doUnmock)\s*\(\s*(?:import\s*\(\s*)?["'`][^"'`]*cashSalePilotGate/.test(src);
}

describe("SCRUM-802 opt-out census", () => {
  const SELF = "convex/scrum802OptOutCensus.test.ts";
  const all = testFiles(".").filter((path) => path !== SELF);
  const optedOut = all.filter((path) => readFileSync(path, "utf8").includes(MARK)).sort();

  test("the scan covers every test directory vitest runs (convex, components, lib, scripts, test-utils and the rest)", () => {
    expect(all).toContain("convex/sales.test.ts");
    expect(all).toContain("components/deposits/QuoteDepositManager.test.tsx");
    expect(all.some((path) => path.startsWith("scripts/"))).toBe(true);
    expect(all.some((path) => path.startsWith("lib/"))).toBe(true);
  });

  test("no test file turns the switch off or mocks the gate modules without carrying the opt-out marker", () => {
    // "importOriginal()" pass-through mocks are harmless no-ops but are still flagged: there is nothing to opt back in to.
    const unmarked = all.filter((path) => {
      const src = readFileSync(path, "utf8");
      if (EXTRAS_SWITCH_ATTACKS.includes(path)) return !flipsOnlyTheExtrasSwitch(src);
      return turnsSwitchOff(src) && !src.includes(MARK);
    });
    expect(unmarked).toEqual([]);
  });

  test("every opted-out suite really mocks the full-payment switch off (the marker alone is not an opt-out)", () => {
    const notReal = optedOut.filter((path) => !mocksFullPaymentSwitchOff(readFileSync(path, "utf8")));
    expect(notReal).toEqual([]);
    // ... and an opt-out replaces only the containment module, never the gate module itself.
    expect(optedOut.filter((path) => replacesTheGateModule(readFileSync(path, "utf8")))).toEqual([]);
  });

  test("the extras-switch attacks exist, flip only that switch, and are not opt-outs", () => {
    for (const path of EXTRAS_SWITCH_ATTACKS) {
      expect(all).toContain(path);
      expect(optedOut).not.toContain(path);
      expect(flipsOnlyTheExtrasSwitch(readFileSync(path, "utf8"))).toBe(true);
    }
  });

  test("exactly the listed suites run with the containment off", () => {
    expect(optedOut).toEqual([...ALLOWED_OPT_OUTS].sort());
  });

  test("certification and rehearsal files run with the real switch", () => {
    for (const path of MUST_RUN_WITH_REAL_SWITCH) {
      expect(all).toContain(path); // a renamed or deleted certification file must fail here, not silently drop out
      expect(optedOut).not.toContain(path);
      const src = readFileSync(path, "utf8");
      expect(turnsSwitchOff(src)).toBe(false);
      expect(src).not.toContain(MARK);
    }
    expect(readFileSync("vitest.setup.ts", "utf8")).not.toContain("CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED");
  });

  test("the detector goes red on every spelling vitest honours (self-test)", () => {
    const N = "CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED";
    const escapes = [
      `vi.mock("./utils/saleDebtContainment", async () => ({ ${N}: false }));`,
      `vi.mock("./utils/saleDebtContainment.ts", async o => ({...(await o()), ${N}: !1}));`,
      `vi.mock("./utils/saleDebtContainment.js", async (o) => ({...(await o()), ${N}: 0}));`,
      `vi.mock(import("./utils/saleDebtContainment"), async (o) => ({...(await o()), ${N}: undefined}));`,
      "vi.mock(`./utils/saleDebtContainment`, async (o) => await o());",
      `vi.doMock('../utils/cashSalePilotGate', () => ({}));`,
      `vi.mock( "./utils/cashSalePilotGate.ts" , () => ({}));`,
      `const m = { ${N}: null };`,
      `const m = { ${N}:flag };`,
    ];
    for (const src of escapes) expect(turnsSwitchOff(src), src).toBe(true);
    const harmless = [
      `import { ${N} } from "./utils/saleDebtContainment";`,
      `expect(${N}).toBe(true);`,
      `const m = { ${N}: true };`,
      `vi.mock("./rateLimit", () => ({}));`,
    ];
    for (const src of harmless) expect(turnsSwitchOff(src), src).toBe(false);
    // The extras switch is covered by the same detector.
    expect(turnsSwitchOff("const m = { CASH_SALE_EXTRAS_PILOT_REFUSED: false };")).toBe(true);
    expect(turnsSwitchOff("const m = { CASH_SALE_EXTRAS_PILOT_REFUSED: !1 };")).toBe(true);
  });

  test("the opt-out verifier evaluates the effective switch value and goes red on every fooling case (self-test)", () => {
    const N = FULL;
    const M = `"./utils/saleDebtContainment"`;
    const good = [
      `vi.mock(${M}, async (importOriginal) => ({ ...(await importOriginal()), ${N}: false }));`,
      `vi.mock(${M}, async (importOriginal) => ({ ...(await importOriginal()), ${N}: !1 }));`,
      `vi.mock("./utils/saleDebtContainment.ts", async (o) => ({ ...(await o()), ${N}: 0 }));`,
      `vi.mock(import("./utils/saleDebtContainment"), async (o) => ({ ...(await o()), ${N}: undefined }));`,
      `vi.mock(${M}, async (o) => ({ ...(await o<typeof import(${M})>()), ${N}: false as const }));`,
      `vi.mock(${M}, async (o) => {\n  const real = await o();\n  return { ...real, ${N}: false };\n});`,
      `vi.mock(${M}, async (o) => ({ ...(await o()), ${N}: true, ${N}: false }));`,
      `vi.mock(${M}, () => ({ [${JSON.stringify(N)}]: false }));`,
    ];
    for (const src of good) expect(mocksFullPaymentSwitchOff(src), src).toBe(true);

    const fooled = [
      // marker only; comment or string claiming the switch is off
      `// ${MARK}\nconst x = 1;`,
      `// ${MARK}\nvi.mock(${M}, async (o) => {\n  // ${N}: false\n  return await o();\n});`,
      `// ${MARK}\nvi.mock(${M}, async (o) => {\n  /* ${N}: false */\n  return { ...(await o()) };\n});`,
      `// ${MARK}\nvi.mock(${M}, async (o) => ({ ...(await o()), note: "${N}: false" }));`,
      // pass-through mock, the switch still real
      `vi.mock(${M}, async (o) => await o());`,
      // Seat 1 L2 / Codex batch 3: the effective value is true again
      `vi.mock(${M}, async (o) => ({ ${N}: false, ...(await o()) }));`,
      `vi.mock(${M}, async (o) => ({ ${N}: false, ...(await o()), other: 1 }));`,
      `vi.mock(${M}, async (o) => ({ ...(await o()), ${N}: false, ${N}: true }));`,
      `vi.mock(${M}, async (o) => ({ ...(await o()), ${N}: false || true }));`,
      `vi.mock(${M}, async (o) => ({ ...(await o()), ${N}: !1 || true }));`,
      `vi.mock(${M}, async (o) => ({ ...(await o()), ${N}: flag }));`,
      `vi.mock(${M}, async (o) => ({ ...(await o()), ${N}: true }));`,
      `vi.mock(${M}, async (o) => { const ${N} = false; return { ...(await o()), ${N} }; });`,
      `vi.mock(${M}, async (o) => ({ ...(await o()), ${N}() { return false; } }));`,
      // nested object, wrong module, wrong key
      `vi.mock(${M}, async (o) => ({ ...(await o()), nested: { ${N}: false } }));`,
      `vi.mock(${M}, async (o) => ({ ...(await o()), default: { ${N}: false } }));`,
      `vi.mock("./rateLimit", () => ({ ${N}: false }));\nvi.mock(${M}, async (o) => await o());`,
      `vi.mock("./utils/saleDebtContainmentOther", () => ({ ${N}: false }));`,
      `vi.mock(${M}, async (o) => ({ ...(await o()), CASH_SALE_EXTRAS_PILOT_REFUSED: false }));`,
      // a computed key that could be anything
      `vi.mock(${M}, async (o) => ({ ${N}: false, [name]: true }));`,
      // never-called or conditional or later-undone mocks
      `vi.doMock(${M}, async (o) => ({ ...(await o()), ${N}: false }));`,
      `if (process.env.X) { vi.mock(${M}, async (o) => ({ ...(await o()), ${N}: false })); }`,
      `describe("x", () => { vi.mock(${M}, async (o) => ({ ...(await o()), ${N}: false })); });`,
      `vi.mock(${M}, async (o) => ({ ...(await o()), ${N}: false }));\nvi.unmock(${M});`,
      `vi.mock(${M}, async (o) => ({ ...(await o()), ${N}: false }));\nvi.doUnmock(${M});`,
      // one mock off, a second (the last wins) not
      `vi.mock(${M}, async (o) => ({ ...(await o()), ${N}: false }));\nvi.mock(${M}, async (o) => await o());`,
      // a factory shape the evaluator does not read is refused, not trusted
      `vi.mock(${M}, async (o) => Object.assign(await o(), { ${N}: false }));`,
      `vi.mock(${M}, factoryFromElsewhere);`,
      `vi.mock(${M}, async (o) => { const m = { ${N}: false }; return m; });`,
      `vi.mock(${M}, async (o) => { if (x) return { ${N}: false }; return await o(); });`,
      // value set, nothing mocked
      `const m = { ${N}: false };`,
    ];
    for (const src of fooled) expect(mocksFullPaymentSwitchOff(src), src).toBe(false);

    // The replaced-gate-module check
    expect(replacesTheGateModule(`vi.mock("./utils/cashSalePilotGate", () => ({}));`)).toBe(true);
    expect(replacesTheGateModule(`vi.mock(${M}, async (o) => await o());`)).toBe(false);
  });

  test("the extras-switch attack verifier flips ONLY the extras switch in the exact shape (self-test)", () => {
    const X = EXTRAS;
    const M = `"./utils/saleDebtContainment"`;
    const good = `vi.mock(${M}, async (importOriginal) => ({ ...(await importOriginal()), ${X}: false }));`;
    expect(flipsOnlyTheExtrasSwitch(good)).toBe(true);
    const bad = [
      good.replace("false }", `false, ${FULL}: false }`), // also flips the full-payment switch
      good.replace("false }", `false, ${FULL}: true }`), // names it at all
      `vi.mock(${M}, async (o) => ({ ${X}: false, ...(await o()) }));`, // spread after the key restores it
      `vi.mock(${M}, async (o) => ({ ...(await o()), ${X}: false || true }));`,
      `vi.mock(${M}, async (o) => ({ ...(await o()), ...other, ${X}: false }));`, // spread of something else
      `vi.mock(${M}, async (o) => ({ ...{ ${FULL}: false }, ...(await o()), ${X}: false }));`,
      `vi.doMock(${M}, async (o) => ({ ...(await o()), ${X}: false }));`,
      `vi.mock(${M}, async (o) => ({ ...(await o()), ${X}: false }));\nvi.unmock(${M});`,
      `// ${X}: false\nvi.mock(${M}, async (o) => await o());`,
      `vi.mock(${M}, async (o) => ({ ...(await o()), nested: { ${X}: false } }));`,
    ];
    for (const src of bad) expect(flipsOnlyTheExtrasSwitch(src), src).toBe(false);
  });
});
