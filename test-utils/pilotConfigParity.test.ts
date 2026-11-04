/**
 * SCRUM-810: a suite that claims pilot certification must run with the shipped pilot
 * configuration. A suite that opened a door through a mock is rejected, even if its own
 * assertions pass. Legacy suites that open doors must say so.
 */
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  assertPilotCertifyingConfig,
  opensAPilotDoor,
  pilotDoorOpeners,
  pilotConfigMismatches,
  pilotModuleBasenames,
  pilotSwitchNames,
  readingsFor,
} from "./pilotConfigParity";
import { PILOT_SERVER_BINDINGS, type PilotSwitchKey } from "../lib/pilotCapabilityManifest";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const sourceFixtures = new Map<string, Buffer | null>();

/** Each of these re-imports the manifest and every containment module with a mock in place. */
const RELOAD_TIMEOUT_MS = 60_000;

afterEach(() => {
  for (const [file, original] of sourceFixtures) {
    if (original === null) unlinkSync(file);
    else writeFileSync(file, original);
  }
  sourceFixtures.clear();
  vi.doUnmock("@/lib/pilotCapabilities");
  vi.doUnmock("@/hooks/reviewBarrel");
  vi.doUnmock("@/convex/utils/fixedAssetLifecycleContainment");
  vi.doUnmock("@/convex/utils/manualJournalContainment");
  vi.restoreAllMocks();
  vi.resetModules();
});

// Exercise real source I/O. Each temporary change is restored byte-for-byte in afterEach.
async function parityWithSources(sources: Readonly<Record<string, string>>) {
  vi.resetModules();
  for (const [rel, source] of Object.entries(sources)) {
    const file = path.resolve(ROOT, rel);
    sourceFixtures.set(file, existsSync(file) ? readFileSync(file) : null);
    writeFileSync(file, source);
  }
  return import("./pilotConfigParity");
}

describe("SCRUM-810 review negative controls", () => {
  test("R3-F2: a mocked hooks barrel cannot certify an unmeasured binding", async () => {
    vi.doMock("@/hooks/reviewBarrel", () => ({ PAYMENT_LINKS_PILOT_DISABLED: false }));
    const parity = await parityWithSources({
      "hooks/reviewBarrel.ts": 'export { PAYMENT_LINKS_PILOT_DISABLED } from "../lib/pilotCapabilities";',
    });
    const moduleId = "../hooks/reviewBarrel";
    const barrel = await import(moduleId);
    expect(barrel.PAYMENT_LINKS_PILOT_DISABLED).toBe(false);
    expect(() => parity.assertPilotCertifyingConfig(["PAYMENT_LINKS_PILOT_DISABLED"])).toThrow(/NOT PILOT CERTIFIED.*hooks\/reviewBarrel/);
    expect(parity.switchModules().reexporting.get("PAYMENT_LINKS_PILOT_DISABLED")).toContain("hooks/reviewBarrel");
    expect(parity.pilotModuleBasenames()).toContain("reviewBarrel");
  }, RELOAD_TIMEOUT_MS);

  test.each([
    ["const off: boolean = true; export { off as REVIEW_PILOT_DISABLED };", true],
    ["const off: boolean = Boolean(true); export { off as REVIEW_PILOT_DISABLED };", null],
  ])("R2-F1: discovers a pilot-named export alias and reads its literal value: %s", async (source, value) => {
    const parity = await parityWithSources({ "lib/reviewLocal.ts": source });
    expect(parity.switchModules().declaring.get("REVIEW_PILOT_DISABLED")).toBe("lib/reviewLocal");
    expect(parity.shippedValue("REVIEW_PILOT_DISABLED")).toBe(value);
    expect(parity.pilotSwitchNames()).toContain("REVIEW_PILOT_DISABLED");
  }, RELOAD_TIMEOUT_MS);

  test.each([
    ["leading-space star", ' export * from "./pilotCapabilities";'],
    ["import alias", 'import { PAYMENT_LINKS_PILOT_DISABLED as off } from "./pilotCapabilities"; export { off };'],
    ["namespace", 'export * as ns from "./pilotCapabilities";'],
    ["constant alias", 'import { PAYMENT_LINKS_PILOT_DISABLED } from "./pilotCapabilities"; export const ALIAS = PAYMENT_LINKS_PILOT_DISABLED;'],
    ["switch-named alias", 'import { PAYMENT_LINKS_PILOT_DISABLED } from "./pilotCapabilities"; export const ALIAS_PILOT_DISABLED = PAYMENT_LINKS_PILOT_DISABLED;'],
  ])("F1: discovers %s and refuses its unmeasured server binding", async (_shape, source) => {
    const parity = await parityWithSources({ "lib/reviewBarrel.ts": source });
    expect(parity.switchModules().reexporting.get("PAYMENT_LINKS_PILOT_DISABLED")).toContain("lib/reviewBarrel");
    expect(parity.pilotModuleBasenames()).toContain("reviewBarrel");
    expect(() => parity.assertPilotCertifyingConfig(["PAYMENT_LINKS_PILOT_DISABLED"])).toThrow(/NOT PILOT CERTIFIED.*reviewBarrel/);
  }, RELOAD_TIMEOUT_MS);

  test("F1: discovers a typed local switch exported by name", async () => {
    const parity = await parityWithSources({
      "lib/reviewLocal.ts": "const REVIEW_PILOT_DISABLED: boolean = true; export { REVIEW_PILOT_DISABLED };",
    });
    expect(parity.switchModules().declaring.get("REVIEW_PILOT_DISABLED")).toBe("lib/reviewLocal");
    expect(parity.shippedValue("REVIEW_PILOT_DISABLED")).toBe(true);
    expect(parity.pilotSwitchNames()).toContain("REVIEW_PILOT_DISABLED");
  }, RELOAD_TIMEOUT_MS);

  test("F3: a commented-out payment-link example cannot certify a false mock", async () => {
    vi.doMock("@/lib/pilotCapabilities", () => ({ PAYMENT_LINKS_PILOT_DISABLED: false }));
    const parity = await parityWithSources({
      "lib/pilotCapabilities.ts": "/* Example only:\nexport const PAYMENT_LINKS_PILOT_DISABLED = false;\n*/\n" + read("lib/pilotCapabilities.ts"),
    });
    expect(() => parity.assertPilotCertifyingConfig(["PAYMENT_LINKS_PILOT_DISABLED"])).toThrow(/NOT PILOT CERTIFIED/);
    expect(parity.shippedValue("PAYMENT_LINKS_PILOT_DISABLED")).toBe(true);
  }, RELOAD_TIMEOUT_MS);

  test.each([
    "/* Example:\n CUSTODY_REOPEN_PILOT_DISABLED: false,\n*/\n",
    "const example = {\n CUSTODY_REOPEN_PILOT_DISABLED: false,\n};\n",
  ])("F3: door-map values ignore unrelated examples: %s", async (example) => {
    const file = "convex/utils/fixedAssetLifecycleContainment.ts";
    const parity = await parityWithSources({
      [file]: example + read(file),
    });
    expect(parity.shippedValue("CUSTODY_REOPEN_PILOT_DISABLED")).toBe(true);
  }, RELOAD_TIMEOUT_MS);

  test("F4: replacing only the manual-journal guard cannot certify", async () => {
    vi.resetModules();
    vi.doMock("@/convex/utils/manualJournalContainment", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../convex/utils/manualJournalContainment")>()),
      assertManualJournalsEnabled: () => undefined,
    }));
    const parity = await import("./pilotConfigParity");
    expect(() => parity.assertPilotCertifyingConfig(["MANUAL_JOURNALS_PILOT_DISABLED"])).toThrow(/NOT PILOT CERTIFIED.*server guard refusal/);
    expect(parity.pilotModuleBasenames()).toContain("manualJournalContainment");
  }, RELOAD_TIMEOUT_MS);
});

describe("pilot config parity", () => {
  test("the shipped configuration is pilot certifying", () => {
    expect(pilotConfigMismatches()).toEqual([]);
    expect(() => assertPilotCertifyingConfig()).not.toThrow();
  });

  test("negative control: a payment-links constant mocked off is NOT PILOT CERTIFIED", async () => {
    vi.resetModules();
    vi.doMock("@/lib/pilotCapabilities", () => ({ PAYMENT_LINKS_PILOT_DISABLED: false }));
    const parity = await import("./pilotConfigParity");
    expect(parity.pilotConfigMismatches().map((m) => m.switch)).toContain("PAYMENT_LINKS_PILOT_DISABLED");
    expect(() => parity.assertPilotCertifyingConfig()).toThrow(/NOT PILOT CERTIFIED.*PAYMENT_LINKS_PILOT_DISABLED/);
  }, RELOAD_TIMEOUT_MS);

  test("negative control: a door opened with the shared test helper is NOT PILOT CERTIFIED", async () => {
    vi.resetModules();
    vi.doMock("@/convex/utils/fixedAssetLifecycleContainment", async (importOriginal) =>
      (await import("./fixedAssetLifecycleSwitch")).openFixedAssetLifecycle(await importOriginal())
    );
    const parity = await import("./pilotConfigParity");
    expect(parity.pilotConfigMismatches().map((m) => m.switch)).toContain("FIXED_ASSET_LIFECYCLE_PILOT_DISABLED");
    expect(() => parity.assertPilotCertifyingConfig()).toThrow(/NOT PILOT CERTIFIED/);
  }, RELOAD_TIMEOUT_MS);

  test("negative control: replacing only the server guard, with every constant intact, is NOT PILOT CERTIFIED", async () => {
    vi.resetModules();
    vi.doMock("@/convex/utils/fixedAssetLifecycleContainment", async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      assertFixedAssetLifecycleAllowed: () => undefined,
    }));
    const parity = await import("./pilotConfigParity");
    const found = parity.pilotConfigMismatches().filter((m) => m.switch === "FIXED_ASSET_LIFECYCLE_PILOT_DISABLED");
    expect(found.map((m) => m.via)).toEqual(["server guard refusal"]);
    expect(() => parity.assertPilotCertifyingConfig()).toThrow(/NOT PILOT CERTIFIED.*server guard refusal/);
  }, RELOAD_TIMEOUT_MS);

  test("negative control: a module the server imports the payment-link switch through is measured too", () => {
    const flipped = (key: PilotSwitchKey) =>
      readingsFor(key).map((r) => (r.via.startsWith("binding in ") ? { ...r, effective: false } : r));
    const found = pilotConfigMismatches(flipped);
    expect(found.map((m) => `${m.switch} ${m.via}`)).toEqual([
      "PAYMENT_LINKS_PILOT_DISABLED binding in convex/utils/saleDebtContainment",
    ]);
  });

  test("the payment-link switch has a binding for the module paymentIntents imports it from", () => {
    expect(read("convex/paymentIntents.ts")).toMatch(/PAYMENT_LINKS_PILOT_DISABLED[^;]*from "\.\/utils\/saleDebtContainment"/);
    expect((PILOT_SERVER_BINDINGS.PAYMENT_LINKS_PILOT_DISABLED ?? []).map((b) => b.module)).toEqual([
      "convex/utils/saleDebtContainment",
    ]);
  });
});

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, dir || "."))) {
    if (name === "node_modules" || name === "_generated" || name.startsWith(".") || name === "playwright-report") continue;
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(path.join(ROOT, rel)).isDirectory()) testFiles(rel, out);
    else if (/\.test\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

// The calls are joined from parts so this file contains no literal mock call: the SCRUM-802 and
// legacy-refund censuses scan every test file for them.
const MOCK = ["vi", "mock"].join(".");
const DO_MOCK = ["vi", "doMock"].join(".");
const SPY = ["vi", "spyOn"].join(".");

describe("the door-opening detector", () => {
  const basenames = ["gateModule"];
  const names = ["EXAMPLE_PILOT_DISABLED"];
  const opens = (src: string) => opensAPilotDoor(src, basenames, names);

  test("the shared census keeps file scopes separate and refuses unreadable mock targets", () => {
    const sources = new Map([
      ["globals.ts", "const vi = unrelated;"],
      ["unbound.ts", `${DO_MOCK}(target, () => ({}));`],
      ["aliased.ts", 'import { vi as tools } from "vitest"; const { doMock: replace } = tools; replace(target, () => ({}));'],
      ["shadowed.ts", 'export function f(vi) { vi.doMock(target, () => ({})); }'],
      ["literal.ts", 'export {}; replaceSomething("./gateModule", () => ({}));'],
    ]);
    expect(pilotDoorOpeners(sources, basenames, names)).toEqual(["unbound.ts", "aliased.ts", "literal.ts"]);
  });

  test.each([
    'const tools = vi; tools.doMock("./gateModule", () => ({}));',
    'const m = vi.doMock; m("./gateModule", () => ({}));',
    'vi.doMock.bind(vi)("./gateModule", () => ({}));',
    'const m = vi.doMock.bind(vi); m("./gateModule", () => ({}));',
    'vi.doMock.call(vi, "./gateModule", () => ({}));',
    'const { vi: v } = await import("vitest"); v.doMock("./gateModule", () => ({}));',
    'replaceSomething(0, "./gateModule", () => ({}));',
    'replaceSomething(import("./gateModule"), () => ({}));',
  ])("R3-F1: any callee receiving a pilot module refuses certification: %s", (source) => {
    expect(opens(source)).toBe(true);
  });

  test("R3-F1: static and dynamic module imports alone do not open a door", () => {
    expect(opens('import { flag } from "./gateModule";')).toBe(false);
    expect(opens('const flags = await import("./gateModule");')).toBe(false);
  });

  test.each([
    ['import { vi as toolsVi } from "vitest";', "toolsVi.doMock"],
    ['import { vitest as toolsVi } from "vitest";', "toolsVi.doMock"],
    ['import * as V from "vitest";', "V.vi.mock"],
    ["", 'vi["mock"]'],
    ["const { doMock } = vi;", "doMock"],
    ['import { vi as toolsVi } from "vitest"; const { doMock: replace } = toolsVi;', "replace"],
    ['import * as V from "vitest";', 'V["vitest"]["doMock"]'],
  ])("R2-F2: detects Vitest bindings and access forms: %s %s", (binding, callee) => {
    const source = `${binding}\n${callee}("@/convex/utils/fixedAssetLifecycleContainment", () => ({ assertFixedAssetLifecycleAllowed: () => undefined }));`;
    expect(opensAPilotDoor(source, pilotModuleBasenames(), pilotSwitchNames())).toBe(true);
  });

  test.each([
    'import { vi as toolsVi } from "other"; toolsVi.doMock("./gateModule", () => ({}));',
    'import * as V from "other"; V.vi.mock("./gateModule", () => ({}));',
    'import { vi as toolsVi } from "vitest"; function f(toolsVi) { toolsVi.doMock("./gateModule", () => ({})); }',
    'function f(vi) { vi["mock"]("./gateModule", () => ({})); }',
    'const { doMock } = unrelated; doMock("./gateModule", () => ({}));',
  ])("R3-F1: a pilot module argument refuses even with unrelated or shadowed bindings: %s", (source) => {
    expect(opens(source)).toBe(true);
  });

  test.each([
    `${DO_MOCK} /* comment */ ("@/convex/utils/fixedAssetLifecycleContainment", () => ({ assertFixedAssetLifecycleAllowed: () => undefined }));`,
    `${SPY}(await import("@/convex/utils/fixedAssetLifecycleContainment"), "assertFixedAssetLifecycleAllowed").mockImplementation(() => undefined);`,
  ])("F2: detects guard replacement through AST: %s", (src) => {
    expect(opensAPilotDoor(src, pilotModuleBasenames(), pilotSwitchNames())).toBe(true);
  });

  test("F4: detects both mock and spy replacements of the manual-journal guard", () => {
    const modules = pilotModuleBasenames();
    const switches = pilotSwitchNames();
    expect(opensAPilotDoor(`${DO_MOCK}("@/convex/utils/manualJournalContainment", () => ({}));`, modules, switches)).toBe(true);
    expect(opensAPilotDoor(`${SPY}(mod, "assertManualJournalsEnabled").mockImplementation(() => undefined);`, modules, switches)).toBe(true);
  });

  test("derives the pilot modules from the source, including the re-export module", () => {
    expect(pilotModuleBasenames()).toEqual(
      expect.arrayContaining([
        "pilotCapabilities",
        "saleDebtContainment",
        "fixedAssetLifecycleContainment",
        "rt11DoorContainment",
        "supplierSettlementContainment",
        "pilotCapabilityManifest",
      ])
    );
    expect(pilotSwitchNames()).toEqual(expect.arrayContaining(["PAYMENT_LINKS_PILOT_DISABLED", "CUSTODY_REOPEN_PILOT_DISABLED"]));
  });

  test("sees every supported spelling of a mock of a pilot module", () => {
    const spellings = [
      `${MOCK}("./utils/gateModule", () => ({}));`,
      `${MOCK}("./utils/gateModule.ts", async (o) => ({ ...(await o()) }));`,
      `${MOCK}("./utils/gateModule.js", async (o) => ({ ...(await o()) }));`,
      `${MOCK}(import("./utils/gateModule"), async (o) => ({ ...(await o()) }));`,
      `${MOCK}(\`./utils/gateModule\`, async (o) => await o());`,
      `${DO_MOCK}('../utils/gateModule', () => ({}));`,
      `${MOCK}(  "@/utils/gateModule"  , () => ({}));`,
      `${MOCK}(\n  "./utils/gateModule",\n  () => ({})\n);`,
    ];
    for (const src of spellings) expect(opens(src), src).toBe(true);
  });

  test("refuses a computed specifier, which it cannot read", () => {
    expect(opens(`${MOCK}(specifier, () => ({}));`)).toBe(true);
    expect(opens(`${MOCK}(\`./utils/\${name}\`, () => ({}));`)).toBe(true);
  });

  test("sees a spy on a guard or a switch, and an import of a door-opening helper", () => {
    expect(opens(`${SPY}(mod, "assertExampleAllowed");`)).toBe(true);
    expect(opens(`${SPY}(mod, 'isExampleDisabled');`)).toBe(true);
    expect(opens(`${SPY}(mod, "EXAMPLE_PILOT_DISABLED", "get");`)).toBe(true);
    expect(opens(`import { openThing } from "../test-utils/rt11DoorSwitches";`)).toBe(true);
    expect(opens(`await import("../test-utils/rt11DoorSwitches");`)).toBe(true);
    expect(opens(`${SPY}(await import("./gateModule"), "aliasedGuard").mockImplementation(() => undefined);`)).toBe(true);
  });

  test("a mock of the manifest itself opens a door", () => {
    const real = pilotModuleBasenames();
    expect(opensAPilotDoor(`${MOCK}("@/lib/pilotCapabilityManifest", () => ({}));`, real, [])).toBe(true);
  });

  test("leaves unrelated mocks and plain imports alone", () => {
    expect(opens(`${MOCK}("./rateLimit", () => ({}));`)).toBe(false);
    expect(opens(`import { x } from "./utils/gateModule";`)).toBe(false);
    expect(opens(`${SPY}(console, "log");`)).toBe(false);
    expect(opens(`// ${DO_MOCK}("./gateModule", () => ({}));`)).toBe(false);
    expect(opens(`const example = '${SPY}(mod, "assertExampleAllowed")';`)).toBe(false);
  });
});

describe("legacy door-opening suites are labelled", () => {
  const baseline = new Set<string>(JSON.parse(read("test-utils/nonPilotCertifyingBaseline.json")).files as string[]);
  const self = "test-utils/pilotConfigParity.test.ts";
  const basenames = pilotModuleBasenames();
  const names = pilotSwitchNames();
  const sources = new Map(testFiles("").filter((rel) => rel !== self).map((rel) => [rel, read(rel)]));
  const opening = pilotDoorOpeners(sources, basenames, names).sort();

  test("a suite that opens a door says NON-PILOT-CERTIFYING or is in the shrink-only baseline", () => {
    const unlabelled = opening.filter((rel) => !sources.get(rel)!.includes("NON-PILOT-CERTIFYING") && !baseline.has(rel));
    expect(unlabelled, "add `NON-PILOT-CERTIFYING` to the header of each, or stop opening the door").toEqual([]);
  });

  test("the baseline lists only suites that still open a door and are still unlabelled", () => {
    const stale = [...baseline].filter((rel) => !opening.includes(rel) || sources.get(rel)!.includes("NON-PILOT-CERTIFYING"));
    expect(stale, "remove these from test-utils/nonPilotCertifyingBaseline.json").toEqual([]);
  });

  test("a suite that asserts pilot certification does not also open a door", () => {
    const both = opening.filter((rel) => /\b(?:assertPilotCertifyingConfig|beforePilotCertifyingConfig)\s*\(/.test(sources.get(rel)!));
    expect(both).toEqual([]);
  });
});
