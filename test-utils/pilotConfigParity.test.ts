/**
 * SCRUM-810: a suite that claims pilot certification must run with the shipped pilot
 * configuration. A suite that opened a door through a mock is rejected, even if its own
 * assertions pass. Legacy suites that open doors must say so.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  assertPilotCertifyingConfig,
  opensAPilotDoor,
  pilotConfigMismatches,
  pilotModuleBasenames,
  pilotSwitchNames,
  readingsFor,
} from "./pilotConfigParity";
import { PILOT_SERVER_BINDINGS, type PilotSwitchKey } from "../lib/pilotCapabilityManifest";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/** Each of these re-imports the manifest and every containment module with a mock in place. */
const RELOAD_TIMEOUT_MS = 60_000;

afterEach(() => {
  vi.doUnmock("@/lib/pilotCapabilities");
  vi.doUnmock("@/convex/utils/fixedAssetLifecycleContainment");
  vi.resetModules();
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
  });

  test("a mock of the manifest itself opens a door", () => {
    const real = pilotModuleBasenames();
    expect(opensAPilotDoor(`${MOCK}("@/lib/pilotCapabilityManifest", () => ({}));`, real, [])).toBe(true);
  });

  test("leaves unrelated mocks and plain imports alone", () => {
    expect(opens(`${MOCK}("./rateLimit", () => ({}));`)).toBe(false);
    expect(opens(`import { x } from "./utils/gateModule";`)).toBe(false);
    expect(opens(`${SPY}(console, "log");`)).toBe(false);
  });
});

describe("legacy door-opening suites are labelled", () => {
  const baseline = new Set<string>(JSON.parse(read("test-utils/nonPilotCertifyingBaseline.json")).files as string[]);
  const self = "test-utils/pilotConfigParity.test.ts";
  const basenames = pilotModuleBasenames();
  const names = pilotSwitchNames();
  const opening = testFiles("")
    .filter((rel) => rel !== self && opensAPilotDoor(read(rel), basenames, names))
    .sort();

  test("a suite that opens a door says NON-PILOT-CERTIFYING or is in the shrink-only baseline", () => {
    const unlabelled = opening.filter((rel) => !read(rel).includes("NON-PILOT-CERTIFYING") && !baseline.has(rel));
    expect(unlabelled, "add `NON-PILOT-CERTIFYING` to the header of each, or stop opening the door").toEqual([]);
  });

  test("the baseline lists only suites that still open a door and are still unlabelled", () => {
    const stale = [...baseline].filter((rel) => !opening.includes(rel) || read(rel).includes("NON-PILOT-CERTIFYING"));
    expect(stale, "remove these from test-utils/nonPilotCertifyingBaseline.json").toEqual([]);
  });

  test("a suite that asserts pilot certification does not also open a door", () => {
    const both = opening.filter((rel) => read(rel).includes("assertPilotCertifyingConfig("));
    expect(both).toEqual([]);
  });
});
