/**
 * SCRUM-810: the pilot capability manifest keeps the server switches, the UI and the
 * refusal copy in step. Each test below fails when one layer drifts from another.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { commonAr, commonEn } from "@/lib/i18n/domains/common";
import { pilotSwitchDeclarations, shippedValue, switchModules } from "../test-utils/pilotConfigParity";
import { discoverPilotSources } from "../test-utils/pilotSourceDiscovery";
import {
  PILOT_CAPABILITIES,
  PILOT_SERVER_BINDINGS,
  PILOT_SERVER_GUARDS,
  PILOT_SWITCHES,
  type PilotSwitchKey,
} from "./pilotCapabilityManifest";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir: string, accept: (rel: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    if (name === "node_modules" || name === "_generated" || name.startsWith(".")) continue;
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, accept, out);
    else if (accept(rel)) out.push(rel);
  }
  return out;
}

const isSource = (rel: string) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel) && !rel.endsWith(".d.ts");

const SOURCE_ROOTS = readdirSync(ROOT).filter(
  (name) =>
    !name.startsWith(".") &&
    !["node_modules", "_generated", "coverage", "playwright-report", "test-results"].includes(name) &&
    statSync(path.join(ROOT, name)).isDirectory()
);

/**
 * Every switch the repository declares anywhere outside tests, found by parsing the source:
 * exported variables with a switch name (typed or not, one line or many) plus the keys of
 * exported door maps.
 */
let declaredCache: string[] | null = null;
function declaredSwitches(): string[] {
  if (declaredCache) return declaredCache;
  const sources = new Map(SOURCE_ROOTS.flatMap((root) => walk(root, isSource)).map((rel) => [rel, read(rel)]));
  const names = new Set(discoverPilotSources(sources, new Set()).declarations.map((declaration) => declaration.name));
  declaredCache = [...names].sort();
  return declaredCache;
}

/** The value each switch ships with. Flipping one in source must change this table in the same change. */
const EXPECTED_SHIPPED: Record<PilotSwitchKey, boolean> = {
  PAYMENT_LINKS_PILOT_DISABLED: true,
  FIXED_ASSET_LIFECYCLE_PILOT_DISABLED: true,
  MANUAL_JOURNALS_PILOT_DISABLED: true,
  PARTNER_PROFIT_DISTRIBUTION_PILOT_DISABLED: true,
  CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED: true,
  SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED: true,
  DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED: true,
  LEGACY_COLLECTION_REFUND_PILOT_DISABLED: true,
  CLEARED_CHEQUE_RETURN_PILOT_DISABLED: true,
  SUPPLIER_RECEIPT_REVERSAL_PILOT_DISABLED: true,
  SUPPLIER_PAYABLE_CORRECTION_PILOT_DISABLED: true,
  SUPPLIER_COST_EXPENSE_REVERSAL_PILOT_DISABLED: true,
  CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED: true,
  CUSTODY_WRITEOFF_PILOT_DISABLED: true,
  CUSTODY_MIGRATION_PILOT_DISABLED: true,
  CUSTODY_REOPEN_PILOT_DISABLED: true,
  MANUAL_FINANCE_APPROVAL_PILOT_DISABLED: true,
  EXPECTED_PAYMENT_PAID_PILOT_DISABLED: true,
  SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED: true,
  DIRECT_COMMISSION_PAYOUT_PILOT_DISABLED: true,
  VEHICLE_OWNERSHIP_CHANGE_PILOT_DISABLED: true,
  PAID_LANDED_COST_CHANGE_PILOT_DISABLED: true,
  CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED: true,
  CASH_SALE_EXTRAS_PILOT_REFUSED: true,
  // The commission-lines door is open in the pilot: this is the one switch that ships false.
  DEAL_COMMISSION_LINES_PILOT_DISABLED: false,
};

/** The body of `export const <fn> = mutation(...)` up to the next top-level export. */
function doorSource(moduleName: string, fn: string): string {
  const text = read(`convex/${moduleName}.ts`);
  const start = text.search(new RegExp(`^export const ${fn} = \\w+\\(`, "m"));
  if (start < 0) return "";
  const rest = text.slice(start + 1);
  const next = rest.search(/^export (?:const|async function|function) /m);
  return next < 0 ? rest : rest.slice(0, next);
}

// The discovery and shipped-value checks read and parse every source module through the compiler
// symbols. Under coverage instrumentation in a contended CI slice that walk passed the 5 s default
// (PR #769, run 41832856111, slice 8/8), so this suite carries its own limit; the global timeout is unchanged.
describe("pilot capability manifest", { timeout: 60_000 }, () => {
  test("discovery: every declared pilot switch is registered", () => {
    const registered = new Set(Object.keys(PILOT_SWITCHES));
    const missing = declaredSwitches().filter((name) => !registered.has(name));
    expect(missing, `register these in lib/pilotCapabilityManifest.ts: ${missing.join(", ")}`).toEqual([]);
  });

  test("discovery: finds typed, multi-line and door-map declarations (negative controls)", () => {
    const names = (src: string) => pilotSwitchDeclarations(src).map((d) => `${d.kind}:${d.name}`);
    expect(names("export const A_PILOT_DISABLED: boolean = true;")).toEqual(["constant:A_PILOT_DISABLED"]);
    expect(names("export const B_PILOT_REQUIRED =\n  true as const;")).toEqual(["constant:B_PILOT_REQUIRED"]);
    expect(names("export const C_PILOT_REFUSED = (false) satisfies boolean;")).toEqual(["constant:C_PILOT_REFUSED"]);
    expect(names("export const MAP = {\n  D_PILOT_DISABLED: true,\n  E_PILOT_DISABLED: false,\n} as const;")).toEqual([
      "doorMap:D_PILOT_DISABLED",
      "doorMap:E_PILOT_DISABLED",
    ]);
    expect(names("const NOT_EXPORTED_PILOT_DISABLED = true; export const OTHER = 1;")).toEqual([]);
  });

  test("shipped values: the source, the manifest reader and the pinned table agree for every switch", () => {
    expect(Object.keys(EXPECTED_SHIPPED).sort()).toEqual(Object.keys(PILOT_SWITCHES).sort());
    for (const key of Object.keys(PILOT_SWITCHES) as PilotSwitchKey[]) {
      expect(shippedValue(key), `${key} in source`).toBe(EXPECTED_SHIPPED[key]);
      expect(PILOT_SWITCHES[key](), `${key} through the manifest`).toBe(EXPECTED_SHIPPED[key]);
    }
  });

  test("server: every module that re-exports a switch constant is a listed binding, and no stale binding remains", () => {
    const { reexporting } = switchModules();
    const actual = [...reexporting]
      .filter(([key]) => key in PILOT_SWITCHES)
      .flatMap(([key, mods]) => mods.map((m) => `${key} @ ${m}`))
      .sort();
    const listed = Object.entries(PILOT_SERVER_BINDINGS)
      .flatMap(([key, list]) => (list ?? []).map((b) => `${key} @ ${b.module}`))
      .sort();
    expect(listed, "list the module in PILOT_SERVER_BINDINGS so parity measures it").toEqual(actual);
  });

  test("server: every switch with a refusing door has a guard the parity check calls", () => {
    const guarded = Object.keys(PILOT_SERVER_GUARDS).sort();
    const expected = [...new Set(PILOT_CAPABILITIES
      .filter((cap) => cap.doors.some((door) => door.guards.some((guard) => guard.startsWith("assert"))))
      .flatMap((cap) => cap.switches))].sort();
    expect(guarded).toEqual(expected);
  });

  test("discovery: every registered switch exists in the source and belongs to exactly one capability", () => {
    const declared = new Set(declaredSwitches());
    const owners = new Map<string, string[]>();
    for (const cap of PILOT_CAPABILITIES) {
      for (const key of cap.switches) owners.set(key, [...(owners.get(key) ?? []), cap.id]);
    }
    for (const key of Object.keys(PILOT_SWITCHES)) {
      expect(declared.has(key), `${key} is registered but not declared in convex/ or lib/`).toBe(true);
      expect(owners.get(key), `${key} must belong to exactly one capability`).toHaveLength(1);
    }
    expect(PILOT_CAPABILITIES.map((c) => c.id)).toEqual([...new Set(PILOT_CAPABILITIES.map((c) => c.id))]);
  });

  test("copy: every refusal key has English and Arabic text, and the Arabic is a real translation", () => {
    const en = commonEn as Record<string, string>;
    const ar = commonAr as Record<string, string>;
    for (const cap of PILOT_CAPABILITIES) {
      expect(cap.refusalKeys.length + (cap.refusalCopy ? 1 : 0), `${cap.id} needs refusal copy`).toBeGreaterThan(0);
      if (cap.refusalCopy) {
        expect(cap.refusalCopy.ar, `${cap.id} Arabic`).toMatch(/[؀-ۿ]/);
        expect(cap.refusalCopy.ar).not.toBe(cap.refusalCopy.en);
      }
      for (const key of cap.refusalKeys) {
        expect(en[key]?.trim(), `${key} English`).toBeTruthy();
        expect(ar[key]?.trim(), `${key} Arabic`).toBeTruthy();
        expect(ar[key], `${key} Arabic must not equal the English text`).not.toBe(en[key]);
        expect(ar[key], `${key} Arabic must contain Arabic script`).toMatch(/[؀-ۿ]/);
      }
    }
  });

  test("server: every registered door still carries its guard", () => {
    for (const cap of PILOT_CAPABILITIES) {
      for (const door of cap.doors) {
        const [moduleName, fn] = door.name.split(".") as [string, string];
        const src = doorSource(moduleName, fn);
        expect(src.length, `${door.name} was not found in convex/${moduleName}.ts`).toBeGreaterThan(0);
        expect(
          door.guards.some((g) => src.includes(g)),
          `${door.name} no longer calls any of: ${door.guards.join(", ")}`
        ).toBe(true);
      }
    }
  });

  test("ui: every caller of a whole-refusing door is declared, and still holds its gate", () => {
    const wholeDoors = PILOT_CAPABILITIES.flatMap((c) => c.doors.filter((d) => d.scope === "whole"));
    const found = new Map<string, Set<string>>();
    for (const rel of [...walk("components", isSource), ...walk("app", isSource), ...walk("hooks", isSource)]) {
      const text = read(rel);
      for (const door of wholeDoors) {
        if (new RegExp(`\\bapi\\.${door.name.replace(".", "\\.")}\\b`).test(text)) {
          found.set(door.name, (found.get(door.name) ?? new Set()).add(rel));
        }
      }
    }
    for (const cap of PILOT_CAPABILITIES) {
      for (const door of cap.doors.filter((d) => d.scope === "whole")) {
        const declared = new Set((cap.uiCallers ?? []).filter((u) => u.doors.includes(door.name)).map((u) => u.file));
        expect([...(found.get(door.name) ?? [])].sort(), `UI callers of ${door.name}`).toEqual([...declared].sort());
      }
      for (const caller of cap.uiCallers ?? []) {
        const gateFile = caller.gateFile ?? caller.file;
        expect(read(gateFile).includes(caller.gate), `${gateFile} lost its gate ${caller.gate}`).toBe(true);
      }
    }
  });
});
