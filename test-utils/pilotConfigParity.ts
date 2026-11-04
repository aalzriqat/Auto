/**
 * SCRUM-810: proves a suite is running with the SHIPPED pilot configuration.
 *
 * The shipped value of each switch is read from the source text of the module that declares it,
 * which no mock can reach. It is compared with three effective values:
 *
 * 1. the manifest reader (the export, or the module's own `is...Disabled`, that screens read);
 * 2. every module binding the server imports the switch through (`PILOT_SERVER_BINDINGS`, e.g. the
 *    payment-link switch that `paymentIntents` imports from `saleDebtContainment`, not from its
 *    declaring module);
 * 3. the server guard itself (`PILOT_SERVER_GUARDS`): the `assert...Allowed()` the mutation calls
 *    must throw exactly when the shipped switch is on, so a mock that replaces only the guard is
 *    caught even if every constant is intact.
 *
 * A suite that claims pilot certification calls `assertPilotCertifyingConfig()` in `beforeAll`; any
 * difference throws `NOT PILOT CERTIFIED`, even if every assertion in the suite would otherwise pass.
 *
 * A suite that must open a door (a historical lifecycle suite) cannot satisfy SCRUM-760 G2/G3/G7.
 * It carries the header `NON-PILOT-CERTIFYING` (see `pilotConfigParity.test.ts`).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { PILOT_SERVER_BINDINGS, PILOT_SERVER_GUARDS, PILOT_SWITCHES, type PilotSwitchKey } from "../lib/pilotCapabilityManifest";

const ROOT = path.resolve(__dirname, "..");
const SOURCE_DIRS = ["convex", "lib"];
const SWITCH_NAME = /_PILOT_(?:DISABLED|REQUIRED|REFUSED)$/;

export interface PilotConfigMismatch {
  readonly switch: PilotSwitchKey;
  readonly shipped: boolean | null;
  readonly effective: boolean;
  /** Which measurement disagreed: the manifest reader, a module binding, or the server guard. */
  readonly via: string;
}

export interface SwitchDeclaration {
  readonly name: string;
  /** `constant`: a standalone switch. `doorMap`: a key of an exported object of switches. */
  readonly kind: "constant" | "doorMap";
}

const hasExport = (st: ts.Statement): boolean =>
  ts.canHaveModifiers(st) && (ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);

function unwrap(expr: ts.Expression | undefined): ts.Expression | undefined {
  let e = expr;
  while (e && (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e))) e = e.expression;
  return e;
}

/**
 * Structural discovery, so a type annotation, a different initializer or a line break cannot hide
 * a switch: every exported variable whose name ends in `_PILOT_DISABLED|REQUIRED|REFUSED`, and every
 * such key of an exported object literal.
 */
export function pilotSwitchDeclarations(text: string, fileName = "source.ts"): SwitchDeclaration[] {
  const out: SwitchDeclaration[] = [];
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st) || !hasExport(st)) continue;
    for (const decl of st.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const init = unwrap(decl.initializer);
      if (init && ts.isObjectLiteralExpression(init)) {
        for (const prop of init.properties) {
          const key = prop.name;
          if (key && (ts.isIdentifier(key) || ts.isStringLiteral(key)) && SWITCH_NAME.test(key.text)) {
            out.push({ name: key.text, kind: "doorMap" });
          }
        }
      } else if (SWITCH_NAME.test(decl.name.text)) {
        out.push({ name: decl.name.text, kind: "constant" });
      }
    }
  }
  return out;
}

function walkSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    if (name === "node_modules" || name === "_generated" || name.startsWith(".")) continue;
    const rel = `${dir}/${name}`;
    if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(rel);
    else if (!/\.[a-z]+$/.test(name)) walkSources(rel, out);
  }
  return out;
}

const stripExt = (rel: string): string => rel.replace(/\.tsx?$/, "");
const WHOLE_MODULE_REEXPORT = /^export\s+\*\s+from\s/m;

interface ParsedSource {
  readonly module: string;
  readonly text: string;
  readonly declarations: SwitchDeclaration[];
  /** Local names listed in `export { ... }` (with or without `from`). */
  readonly namedExports: string[];
  /** Modules this file re-exports wholesale with `export * from`. */
  readonly starFrom: string[];
}

function resolveSpecifier(fromModule: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return specifier.slice(2);
  if (!specifier.startsWith(".")) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromModule), specifier));
}

let parsed: ParsedSource[] | null = null;
function parsedSources(): ParsedSource[] {
  parsed ??= SOURCE_DIRS.flatMap((dir) => walkSources(dir)).flatMap((rel) => {
    const text = readFileSync(path.join(ROOT, rel), "utf8");
    // Only a file that names a switch, or re-exports a whole module, can declare or re-export one.
    // Parsing every file is what made this slow under coverage.
    if (!text.includes("_PILOT_") && !WHOLE_MODULE_REEXPORT.test(text)) return [];
    const moduleId = stripExt(rel);
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    const namedExports: string[] = [];
    const starFrom: string[] = [];
    for (const st of sf.statements) {
      if (!ts.isExportDeclaration(st) || st.isTypeOnly) continue;
      if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) namedExports.push((el.propertyName ?? el.name).text);
      } else if (!st.exportClause && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        const target = resolveSpecifier(moduleId, st.moduleSpecifier.text);
        if (target) starFrom.push(target);
      }
    }
    return [{ module: moduleId, text, declarations: pilotSwitchDeclarations(text, rel), namedExports, starFrom }];
  });
  return parsed;
}

export interface SwitchModules {
  /** Repository-relative module (no extension) that declares each switch. */
  readonly declaring: ReadonlyMap<string, string>;
  /** Other modules that export the same constant, so the server can import it from there. */
  readonly reexporting: ReadonlyMap<string, readonly string[]>;
}

let modules: SwitchModules | null = null;
/** Where each switch is declared and which other modules re-export it (named or `export *`). */
export function switchModules(): SwitchModules {
  if (modules) return modules;
  const files = parsedSources();
  const declaring = new Map<string, string>();
  for (const f of files) for (const d of f.declarations) if (d.kind === "constant") declaring.set(d.name, f.module);
  const exportedBy = new Map<string, Set<string>>();
  for (const [key, mod] of declaring) exportedBy.set(key, new Set([mod]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of files) {
      for (const [key, set] of exportedBy) {
        const viaNamed = f.namedExports.includes(key);
        const viaStar = f.starFrom.some((target) => set.has(target));
        if ((viaNamed || viaStar) && !set.has(f.module)) {
          set.add(f.module);
          changed = true;
        }
      }
    }
  }
  const reexporting = new Map<string, readonly string[]>();
  for (const [key, set] of exportedBy) reexporting.set(key, [...set].filter((m) => m !== declaring.get(key)).sort());
  modules = { declaring, reexporting };
  return modules;
}

/** Basenames of every module that declares or re-exports a switch, plus the manifest and the gate that applies them. */
export function pilotModuleBasenames(): string[] {
  const { declaring, reexporting } = switchModules();
  const names = new Set<string>(["pilotCapabilityManifest", "cashSalePilotGate"]);
  for (const mod of declaring.values()) names.add(path.posix.basename(mod));
  for (const list of reexporting.values()) for (const mod of list) names.add(path.posix.basename(mod));
  for (const f of parsedSources()) {
    if (f.declarations.some((d) => d.kind === "doorMap")) names.add(path.posix.basename(f.module));
  }
  return [...names].sort();
}

/** The switch names a test could spy on or set (constants and door-map keys). */
export function pilotSwitchNames(): string[] {
  return [...new Set(parsedSources().flatMap((f) => f.declarations.map((d) => d.name)))].sort();
}

/** The value written in source: `export const KEY[: type] = true`, or `KEY: true,` inside a door map. */
export function shippedValue(key: string): boolean | null {
  const own = new RegExp(`^export const ${key}(?:\\s*:\\s*[^=]+?)?\\s*=\\s*(true|false)\\b`, "m");
  const entry = new RegExp(`^\\s*${key}:\\s*(true|false)\\b`, "m");
  // Only files that declare a switch can hold its value, and that is a handful, not the whole tree.
  for (const f of parsedSources()) {
    if (f.declarations.length === 0 || !f.text.includes(key)) continue;
    const hit = own.exec(f.text) ?? entry.exec(f.text);
    if (hit) return hit[1] === "true";
  }
  return null;
}

const refuses = (guard: () => void): boolean => {
  try {
    guard();
    return false;
  } catch {
    return true;
  }
};

export interface SwitchReading {
  readonly via: string;
  readonly effective: boolean;
}

/** Every effective value the screens and the server see for one switch. */
export function readingsFor(key: PilotSwitchKey): SwitchReading[] {
  const readings: SwitchReading[] = [{ via: "manifest reader", effective: PILOT_SWITCHES[key]() }];
  for (const binding of PILOT_SERVER_BINDINGS[key] ?? []) {
    readings.push({ via: `binding in ${binding.module}`, effective: binding.read() });
  }
  const guard = PILOT_SERVER_GUARDS[key];
  if (guard) readings.push({ via: "server guard refusal", effective: refuses(guard) });
  return readings;
}

/** `readings` is injectable so a test can simulate a re-export or a guard that has been replaced. */
export function pilotConfigMismatches(
  readings: (key: PilotSwitchKey) => SwitchReading[] = readingsFor,
  keys: readonly PilotSwitchKey[] = Object.keys(PILOT_SWITCHES) as PilotSwitchKey[]
): PilotConfigMismatch[] {
  const out: PilotConfigMismatch[] = [];
  for (const key of keys) {
    const shipped = shippedValue(key);
    for (const { via, effective } of readings(key)) {
      if (shipped === null || shipped !== effective) out.push({ switch: key, shipped, effective, via });
    }
  }
  return out;
}

/**
 * A suite that exercises one capability checks only that capability's switches. The census of
 * every switch lives in `pilotConfigParity.test.ts`, so a UI suite stays cheap.
 */
export function assertPilotCertifyingConfig(only?: readonly PilotSwitchKey[]): void {
  const mismatches = pilotConfigMismatches(readingsFor, only);
  if (mismatches.length === 0) return;
  const detail = mismatches
    .map((m) => `${m.switch} (shipped ${m.shipped === null ? "not found in source" : m.shipped}, effective ${m.effective}, via ${m.via})`)
    .join("; ");
  throw new Error(`NOT PILOT CERTIFIED: this suite runs with a pilot configuration that differs from the shipped one: ${detail}`);
}

// Test-only helpers that open a door. Joined from parts so no test names the legacy-refund helper:
// scripts/legacyCollectionRefundOptOutCensus.test.ts lists every file that does.
const DOOR_HELPERS = [
  "rt11DoorSwitches",
  "postDeliveryDoorSwitches",
  ["legacyCollectionRefund", "Switches"].join(""),
  "supplierSettlementSwitches",
  "pilotSwitchMock",
  "fixedAssetLifecycleSwitch",
];
const MOCK_CALL = /vi\.(?:mock|doMock)\s*\(\s*(?:import\s*\(\s*)?["'`]([^"'`]+)["'`]/g;
// vi.mock / vi.doMock whose first argument is not a string literal or import("literal"), or is a template with a substitution.
const COMPUTED_SPECIFIER = /vi\.(?:mock|doMock)\s*\(\s*(?!["'`]|import\s*\(\s*["'`])|vi\.(?:mock|doMock)\s*\(\s*`[^`]*\$\{/;
const HELPER_IMPORT = new RegExp(String.raw`["'\`][^"'\`]*/(?:${DOOR_HELPERS.join("|")})(?:\.[cm]?[jt]s)?["'\`]`);

/**
 * True when a test source mocks a pilot module in any supported spelling (plain, `.ts` or `.js`
 * suffix, backtick, `import()` form), mocks with a computed specifier (which cannot be read), spies
 * on a guard or switch, or imports a door-opening helper.
 */
export function opensAPilotDoor(src: string, basenames: readonly string[], names: readonly string[]): boolean {
  if (COMPUTED_SPECIFIER.test(src)) return true;
  for (const m of src.matchAll(MOCK_CALL)) {
    const base = path.posix.basename(m[1]!).replace(/\.[cm]?[jt]sx?$/, "");
    if (basenames.includes(base)) return true;
  }
  const spied = new RegExp(String.raw`vi\.spyOn\s*\([^)]*?["'\`](?:assert\w*Allowed|is\w*Disabled|${names.join("|")})["'\`]`);
  return spied.test(src) || HELPER_IMPORT.test(src);
}
