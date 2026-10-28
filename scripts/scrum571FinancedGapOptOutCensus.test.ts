/**
 * SCRUM-571 ruling 10 (owner ruling c23812 on SCRUM-760): the financed-customer-gap pilot refusal must run for real.
 *
 * `FINANCED_CUSTOMER_GAP_COLLECTION_PILOT_REQUIRED` (convex/utils/financedGapPilotSwitch.ts) is true everywhere, including
 * `vitest.setup.ts`. A suite that only needs a financed sale with an open customer gap invoice as a FIXTURE (to test plan
 * v3 economics, reports, commission or cancellation, none of which can be reached any other way until the receipt
 * resolver SCRUM-722/723/724 exists) opts out with a file-level `vi.mock` of the switch module, marked
 * "SCRUM-571 financed-gap-collection opt-out". This census is the ratchet: the opt-out list is exactly the one below, so a
 * new suite cannot quietly run with the refusal off, and the suite that proves the refusal and the certification and
 * rehearsal files can never be on it. Shrinking the list is always allowed; delete the entry in the same change.
 *
 * Scope, stated plainly. The detector is a text regex over test files: it flags a literal-specifier `vi.mock` or
 * `vi.doMock` of the switch module and the switch's name used as an object key with a value other than `true`. It does not
 * see computed specifiers or mocks hidden in helper files. An opt-out also has to set the switch to a falsy literal, so
 * the marker alone is not an opt-out. Paths are normalised to forward slashes so the list means the same on Windows and
 * on the Linux runner. This file lives in scripts/ (not convex/) because it reads the file system, which Convex's
 * default runtime does not provide.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { FINANCED_CUSTOMER_GAP_COLLECTION_PILOT_REQUIRED } from "../convex/utils/financedGapPilotSwitch";

const MARK = "SCRUM-571 financed-gap-collection opt-out";
const SWITCH = "FINANCED_CUSTOMER_GAP_COLLECTION_PILOT_REQUIRED";
const SWITCH_MODULE = "financedGapPilotSwitch";

const ALLOWED_OPT_OUTS: readonly string[] = [
  "convex/commissionMarginBase.test.ts",
  "convex/financedConsignedSettlement.test.ts",
  "convex/financingEconomics.test.ts",
  "convex/manualFinanceSettlement.test.ts",
  "convex/scrum350Cons1V3PriceBasis.test.ts",
  "convex/scrum411DirectRoute.test.ts",
  "convex/scrum411ForwardOrdering.test.ts",
  "convex/scrum411ReportBasis.test.ts",
  "convex/scrum571bGapRefusedEarlyOptOut.test.ts",
  "convex/scrum571s2FinancedSettledRead.test.ts",
  "convex/scrum766CustomerPaysFinanceCompany.test.ts",
];

const MUST_RUN_WITH_REAL_SWITCH: readonly string[] = [
  "convex/scrum571FinancedGapFailClosed.test.ts",
  "convex/scrum486Certification.test.ts",
  "convex/accountingReleaseRehearsal.test.ts",
  "convex/scrum802CashSaleContainment.test.ts",
  "convex/scrum802CashSaleOrdering.test.ts",
];

// Mirrors vitest.config.ts (and the SCRUM-802 census): **/*.test.ts(x) from the repository root, minus these directories.
const EXCLUDED_DIRS = new Set(["node_modules", ".next", "out", "build", "apps", "packages"]);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const path = dir === "." ? entry.name : join(dir, entry.name);
    if (entry.isDirectory()) testFiles(path, out);
    else if (/\.test\.tsx?$/.test(entry.name)) out.push(path.split("\\").join("/"));
  }
  return out;
}

const QUOTE = "[\"'`]";
// The modules whose replacement turns the refusal off: the switch itself, and the two modules that read it (the pure rule
// and the completion door). Mocking either of the latter replaces the refusal without touching the switch.
const GATE_MODULES = "financedGapPilotGate|financedGapPilotRule";
const MOCK_CALL_OPEN = /vi\.(mock|doMock|unmock|doUnmock)\s*\(/g;
const TARGETS_SWITCH = new RegExp(`^\\s*(?:import\\s*\\(\\s*)?${QUOTE}[^"'\`]*${SWITCH_MODULE}`);
const TARGETS_GATE = new RegExp(`^\\s*(?:import\\s*\\(\\s*)?${QUOTE}[^"'\`]*(?:${GATE_MODULES})`);
const SETS_SWITCH_NOT_TRUE = new RegExp(`${SWITCH}\\s*:\\s*(?!\\s|true\\b)`);
/** The switch set to a literal that really turns it off, as the LAST key (a spread after it would restore the real value). */
const SETS_SWITCH_OFF = new RegExp(`${SWITCH}\\s*:\\s*(?:false|null|undefined|0|!1)\\s*,?\\s*\\}\\s*\\)\\s*\\)`);

/** The source with block and line comments removed, so a commented-out mock is not a mock. (`://` is kept: it is not a comment.) */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

type MockCall = { kind: string; text: string };

/** Every executable `vi.mock`-family call: its kind, and its argument text through the balancing close paren. */
function mockCalls(src: string): MockCall[] {
  const code = stripComments(src);
  const calls: MockCall[] = [];
  for (const open of code.matchAll(MOCK_CALL_OPEN)) {
    const start = open.index + open[0].length;
    let depth = 1;
    let quote = "";
    let end = start;
    for (; end < code.length && depth > 0; end++) {
      const ch = code[end];
      if (quote) {
        if (ch === "\\") end++;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    calls.push({ kind: open[1], text: code.slice(start, end) });
  }
  return calls;
}

function turnsSwitchOff(src: string): boolean {
  return (
    mockCalls(src).some((call) => TARGETS_SWITCH.test(call.text) || TARGETS_GATE.test(call.text)) ||
    SETS_SWITCH_NOT_TRUE.test(stripComments(src))
  );
}

/**
 * An opt-out: at least one executable mock of the switch module, EVERY such mock's own factory sets the switch to a falsy
 * literal last, and nothing replaces the rule or the door instead. A pass-through mock, a restored switch, a false value
 * that only a comment or another object mentions, and a mock of the gate or rule module all fail.
 */
function isRealOptOut(src: string): boolean {
  const calls = mockCalls(src);
  const switchMocks = calls.filter((call) => (call.kind === "mock" || call.kind === "doMock") && TARGETS_SWITCH.test(call.text));
  return (
    switchMocks.length > 0 &&
    switchMocks.every((call) => SETS_SWITCH_OFF.test(call.text)) &&
    !calls.some((call) => TARGETS_GATE.test(call.text))
  );
}

describe("SCRUM-571 financed-gap opt-out census", () => {
  const SELF = "scripts/scrum571FinancedGapOptOutCensus.test.ts";
  const all = testFiles(".").filter((path) => path !== SELF);
  // One read per file for the whole census.
  const sources = new Map(all.map((path) => [path, readFileSync(path, "utf8")] as const));
  const read = (path: string): string => sources.get(path) ?? readFileSync(path, "utf8");
  const optedOut = all.filter((path) => read(path).includes(MARK)).sort();

  test("the switch is on in the code that ships and in the shared test setup", () => {
    expect(FINANCED_CUSTOMER_GAP_COLLECTION_PILOT_REQUIRED).toBe(true);
    expect(read("vitest.setup.ts")).not.toContain(SWITCH);
  });

  test("the scan covers every test directory vitest runs", () => {
    expect(all).toContain("convex/sales.test.ts");
    expect(all.some((path) => path.startsWith("scripts/"))).toBe(true);
    expect(all.some((path) => path.startsWith("lib/"))).toBe(true);
  });

  test("no test file turns the switch off or mocks the switch module without carrying the opt-out marker", () => {
    const unmarked = all.filter((path) => {
      const src = read(path);
      return turnsSwitchOff(src) && !src.includes(MARK);
    });
    expect(unmarked).toEqual([]);
  });

  test("every opted-out suite really mocks the switch off (the marker alone is not an opt-out)", () => {
    expect(optedOut.filter((path) => !isRealOptOut(read(path)))).toEqual([]);
  });

  test("exactly the listed suites run with the refusal off", () => {
    expect(optedOut).toEqual([...ALLOWED_OPT_OUTS].sort());
  });

  test("the refusal's own suite and the certification and rehearsal files run with the real switch", () => {
    for (const path of MUST_RUN_WITH_REAL_SWITCH) {
      // A renamed or deleted file must fail here, not silently drop out of the ratchet.
      expect(all, `${path} is missing`).toContain(path);
      expect(optedOut).not.toContain(path);
      const src = read(path);
      expect(turnsSwitchOff(src), path).toBe(false);
      expect(src).not.toContain(MARK);
    }
  });

  test("the text detector goes red on the listed spellings (self-test)", () => {
    const escapes = [
      `vi.mock("./utils/financedGapPilotSwitch", async () => ({ ${SWITCH}: false }));`,
      `vi.mock("./utils/financedGapPilotSwitch.ts", async o => ({...(await o()), ${SWITCH}: !1}));`,
      `vi.mock(import("./utils/financedGapPilotSwitch"), async (o) => ({...(await o()), ${SWITCH}: undefined}));`,
      "vi.mock(`./utils/financedGapPilotSwitch`, async (o) => await o());",
      `vi.doMock('../utils/financedGapPilotSwitch', () => ({}));`,
      `const m = { ${SWITCH}: 0 };`,
    ];
    for (const src of escapes) expect(turnsSwitchOff(src), src).toBe(true);
    const harmless = [
      `import { ${SWITCH} } from "./utils/financedGapPilotSwitch";`,
      `expect(${SWITCH}).toBe(true);`,
      `const m = { ${SWITCH}: true };`,
    ];
    for (const src of harmless) expect(turnsSwitchOff(src), src).toBe(false);
  });

  test("the opt-out verifier accepts a real opt-out and refuses a pass-through or a restored switch (self-test)", () => {
    const real = `vi.mock("./utils/financedGapPilotSwitch", async (o) => ({ ...(await o()), ${SWITCH}: false }));`;
    const passThrough = `vi.mock("./utils/financedGapPilotSwitch", async (o) => ({ ...(await o()) }));`;
    const restored = `vi.mock("./utils/financedGapPilotSwitch", async (o) => ({ ${SWITCH}: false, ...(await o()) }));`;
    expect(isRealOptOut(real)).toBe(true);
    expect(isRealOptOut(passThrough)).toBe(false);
    expect(isRealOptOut(restored)).toBe(false);
  });

  const SWITCH_OFF_MOCK = `vi.mock("./utils/financedGapPilotSwitch", async (o) => ({ ...(await o()), ${SWITCH}: false }));`;
  const PASS_THROUGH_MOCK = `vi.mock("./utils/financedGapPilotSwitch", async (o) => ({ ...(await o()) }));`;

  test("a commented-out mock is not a mock (self-test)", () => {
    const lineComment = `// ${SWITCH_OFF_MOCK}\nconst x = 1;`;
    const blockComment = `/* ${SWITCH_OFF_MOCK} */\nconst x = 1;`;
    const docComment = `/**\n * ${SWITCH_OFF_MOCK}\n */`;
    for (const src of [lineComment, blockComment, docComment]) {
      expect(turnsSwitchOff(src), src).toBe(false);
      expect(isRealOptOut(src), src).toBe(false);
    }
    // A comment after code on the same line is stripped too, but code before it is kept.
    expect(turnsSwitchOff(`${SWITCH_OFF_MOCK} // keep`)).toBe(true);
  });

  test("a pass-through mock does not become an opt-out because a comment or another object says false (self-test)", () => {
    const commentedFalse = `${PASS_THROUGH_MOCK}\n// ${SWITCH_OFF_MOCK}\n`;
    const elsewhereFalse = `${PASS_THROUGH_MOCK}\nconst unrelated = { ${SWITCH}: false };\n`;
    const trailingBlock = `${PASS_THROUGH_MOCK}\n/* vi.mock("./utils/financedGapPilotSwitch", () => ({ ${SWITCH}: false })); */`;
    for (const src of [commentedFalse, elsewhereFalse, trailingBlock]) expect(isRealOptOut(src), src).toBe(false);
    // Two executable mocks: the opt-out only counts when EVERY one sets the switch off.
    expect(isRealOptOut(`${SWITCH_OFF_MOCK}\n${PASS_THROUGH_MOCK}`)).toBe(false);
    expect(isRealOptOut(`${SWITCH_OFF_MOCK}\n${SWITCH_OFF_MOCK}`)).toBe(true);
  });

  test("a mock of the gate or the rule module turns the refusal off and is never a valid opt-out (self-test)", () => {
    const gate = `vi.mock("./utils/financedGapPilotGate", () => ({ assertFinancedCustomerGapCollectable: () => undefined }));`;
    const rule = `vi.doMock("../utils/financedGapPilotRule", async (o) => ({ ...(await o()), customerGapToDealerIsUncollectable: () => false }));`;
    for (const src of [gate, rule]) {
      expect(turnsSwitchOff(src), src).toBe(true);
      expect(isRealOptOut(src), src).toBe(false);
      // Carrying a real switch opt-out beside it does not launder it.
      expect(isRealOptOut(`${SWITCH_OFF_MOCK}\n${src}`), src).toBe(false);
    }
  });
});
