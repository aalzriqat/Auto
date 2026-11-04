/**
 * SCRUM-810: a suite that claims pilot certification must run with the shipped pilot
 * configuration. A suite that opened a door through a mock is rejected, even if its own
 * assertions pass. Legacy suites that open doors must say so.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { assertPilotCertifyingConfig, pilotConfigMismatches } from "./pilotConfigParity";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

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
  });

  test("negative control: a door opened with the shared test helper is NOT PILOT CERTIFIED", async () => {
    vi.resetModules();
    vi.doMock("@/convex/utils/fixedAssetLifecycleContainment", async (importOriginal) =>
      (await import("./fixedAssetLifecycleSwitch")).openFixedAssetLifecycle(await importOriginal())
    );
    const parity = await import("./pilotConfigParity");
    expect(parity.pilotConfigMismatches().map((m) => m.switch)).toContain("FIXED_ASSET_LIFECYCLE_PILOT_DISABLED");
    expect(() => parity.assertPilotCertifyingConfig()).toThrow(/NOT PILOT CERTIFIED/);
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

/** A test that mocks a containment/switch module, or imports a door-opening helper. */
// The helper names are joined from parts so this file does not itself name the legacy-refund helper:
// scripts/legacyCollectionRefundOptOutCensus.test.ts lists every file that does.
const DOOR_HELPERS = ["rt11DoorSwitches", "postDeliveryDoorSwitches", ["legacyCollectionRefund", "Switches"].join(""), "supplierSettlementSwitches", "pilotSwitchMock", "fixedAssetLifecycleSwitch"];
const OPENS_A_DOOR = new RegExp(
  String.raw`vi\.(?:mock|doMock)\(\s*["'][^"']*(?:Containment|pilotSwitches|saleDebtContainment|pilotCapabilities|rt11DoorContainment)["']|test-utils/(?:${DOOR_HELPERS.join("|")})`
);

describe("legacy door-opening suites are labelled", () => {
  const baseline = new Set<string>(JSON.parse(read("test-utils/nonPilotCertifyingBaseline.json")).files as string[]);
  const self = "test-utils/pilotConfigParity.test.ts";
  const opening = testFiles("")
    .filter((rel) => rel !== self && OPENS_A_DOOR.test(read(rel)))
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
