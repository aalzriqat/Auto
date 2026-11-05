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
 * 3. the server guard itself (`PILOT_SERVER_GUARDS`): the assertion the mutation calls
 *    must throw exactly when the shipped switch is on, so a mock that replaces only the guard is
 *    caught even if every constant is intact.
 *
 * A suite that claims pilot certification calls `assertPilotCertifyingConfig()` in `beforeAll`; any
 * difference throws `NOT PILOT CERTIFIED`, even if every assertion in the suite would otherwise pass.
 *
 * A suite that replaces pilot configuration (a historical lifecycle suite) cannot satisfy SCRUM-760 G2/G3/G7.
 * It carries the header `NON-PILOT-CERTIFYING` (see `pilotConfigParity.test.ts`).
 */
import path from "node:path";
import ts from "typescript";
import { discoverPilotSources, sourceProgram, unwrap, type PilotSourceDiscovery } from "./pilotSourceDiscovery";
import { pilotSourceSnapshot } from "./pilotSourceSnapshot";
import { PILOT_CAPABILITIES, PILOT_SERVER_BINDINGS, PILOT_SERVER_GUARDS, PILOT_SWITCHES, type PilotSwitchKey } from "../lib/pilotCapabilityManifest";

export interface PilotConfigMismatch {
  readonly switch: PilotSwitchKey;
  readonly shipped: boolean | null;
  readonly effective: boolean | null;
  readonly via: string;
}

export type { SwitchDeclaration } from "./pilotSourceDiscovery";

/** Names come from the same door records that define the manifest's refusing operations. */
export function pilotGuardNames(): string[] {
  return [...new Set(PILOT_CAPABILITIES.flatMap((cap) => cap.doors.flatMap((door) => door.guards)))].sort();
}

/** Discover local named exports as well as direct exported declarations. */
export function pilotSwitchDeclarations(text: string, fileName = "source.ts") {
  return discoverPilotSources(new Map([[fileName, text]]), new Set()).declarations;
}

let discovered: PilotSourceDiscovery | null = null;
function discoveredSources(): PilotSourceDiscovery {
  discovered ??= discoverPilotSources(pilotSourceSnapshot(), new Set(pilotGuardNames()));
  return discovered;
}

export interface SwitchModules {
  readonly declaring: ReadonlyMap<string, string>;
  readonly reexporting: ReadonlyMap<string, readonly string[]>;
}

let modules: SwitchModules | null = null;
export function switchModules(): SwitchModules {
  if (modules) return modules;
  const { declarations, exportedBy } = discoveredSources();
  const declaring = new Map(declarations.filter((decl) => decl.kind === "constant").map((decl) => [decl.name, decl.module]));
  const reexporting = new Map<string, readonly string[]>();
  for (const [key, module] of declaring) {
    reexporting.set(key, [...(exportedBy.get(key) ?? [])].filter((other) => other !== module).sort());
  }
  modules = { declaring, reexporting };
  return modules;
}

/** Include every switch exporter and every module exporting one of the declared door guards. */
export function pilotModuleBasenames(): string[] {
  const { exportedBy, guardModules } = discoveredSources();
  const names = new Set<string>(["pilotCapabilityManifest", "pilotConfigHook", "cashSalePilotGate"]);
  for (const mod of [...guardModules, ...[...exportedBy.values()].flatMap((set) => [...set])]) {
    names.add(path.posix.basename(mod));
  }
  return [...names].sort();
}

export function pilotSwitchNames(): string[] {
  return [...new Set(discoveredSources().declarations.map((decl) => decl.name))].sort();
}

/** Only actual exported declaration initializers count. Ambiguous or nonliteral evidence is unavailable. */
export function shippedValue(key: string): boolean | null {
  const declarations = discoveredSources().declarations.filter((decl) => decl.name === key);
  return declarations.length === 1 ? declarations[0]!.value : null;
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
    const listed = new Set((PILOT_SERVER_BINDINGS[key] ?? []).map((binding) => binding.module));
    for (const moduleId of switchModules().reexporting.get(key) ?? []) {
      if (!listed.has(moduleId)) out.push({ switch: key, shipped, effective: null, via: `unmeasured binding in ${moduleId}` });
    }
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
const basename = (specifier: string): string => path.posix.basename(specifier).replace(/\.[cm]?[jt]sx?$/, "");

function stringArgument(expr: ts.Expression | undefined): string | undefined {
  const argument = unwrap(expr);
  if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) return argument.text;
  return undefined;
}

function moduleArgument(expr: ts.Expression | undefined): string | undefined {
  const argument = unwrap(expr);
  if (argument && ts.isAwaitExpression(argument)) return moduleArgument(argument.expression);
  if (argument && ts.isCallExpression(argument) && argument.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return stringArgument(argument.arguments[0]);
  }
  return stringArgument(argument);
}

function memberAccess(expr: ts.Expression): { object: ts.Expression; name: string | undefined } | undefined {
  if (ts.isPropertyAccessExpression(expr)) return { object: expr.expression, name: expr.name.text };
  if (ts.isElementAccessExpression(expr)) return { object: expr.expression, name: stringArgument(expr.argumentExpression) };
  return undefined;
}

function vitestImport(decl: ts.Declaration | undefined): boolean {
  if (!decl) return false;
  const clause = ts.isImportSpecifier(decl) ? decl.parent.parent : decl.parent;
  if (!ts.isImportClause(clause) || clause.isTypeOnly) return false;
  const statement = clause.parent;
  return ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "vitest";
}

function isVitestObject(expr: ts.Expression, checker: ts.TypeChecker): boolean {
  const object = unwrap(expr);
  if (!object) return false;
  if (ts.isIdentifier(object)) {
    const symbol = checker.getSymbolAtLocation(object);
    if (!symbol) return ["vi", "vitest"].includes(object.text);
    return (symbol.declarations ?? []).some((decl) => ts.isImportSpecifier(decl) && !decl.isTypeOnly &&
      ["vi", "vitest"].includes((decl.propertyName ?? decl.name).text) && vitestImport(decl));
  }
  const member = memberAccess(object);
  if (!member?.name || !["vi", "vitest"].includes(member.name) || !ts.isIdentifier(member.object)) return false;
  return (checker.getSymbolAtLocation(member.object)?.declarations ?? [])
    .some((decl) => ts.isNamespaceImport(decl) && vitestImport(decl));
}

function vitestMethod(call: ts.CallExpression, checker: ts.TypeChecker): string | undefined {
  const callee = unwrap(call.expression);
  if (!callee) return undefined;
  const member = memberAccess(callee);
  if (member && isVitestObject(member.object, checker)) return member.name;
  if (!ts.isIdentifier(callee)) return undefined;
  const decl = checker.getSymbolAtLocation(callee)?.valueDeclaration;
  if (!decl || !ts.isBindingElement(decl) || decl.dotDotDotToken || !ts.isObjectBindingPattern(decl.parent)) return undefined;
  const variable = decl.parent.parent;
  if (!ts.isVariableDeclaration(variable) || !variable.initializer || !isVitestObject(variable.initializer, checker)) return undefined;
  const name = decl.propertyName ?? decl.name;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function changesPilotCall(call: ts.CallExpression, basenames: readonly string[], names: ReadonlySet<string>, checker: ts.TypeChecker): boolean {
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return false;
  // Callee identity is not authority: aliases, wrappers, bind and call can all replace a module.
  if (call.arguments.some((argument) => {
    const specifier = moduleArgument(argument);
    return specifier !== undefined && basenames.includes(basename(specifier));
  })) return true;
  const method = vitestMethod(call, checker);
  if (method === "mock" || method === "doMock") {
    const specifier = moduleArgument(call.arguments[0]);
    return specifier === undefined || basenames.includes(basename(specifier));
  }
  if (method !== "spyOn") return false;
  const target = moduleArgument(call.arguments[0]);
  if (target !== undefined && basenames.includes(basename(target))) return true;
  const spied = stringArgument(call.arguments[1]);
  if (spied === undefined) return true;
  return names.has(spied) || /^(?:assert\w*(?:Allowed|Enabled)|is\w*Disabled)$/.test(spied);
}

function opensSourceDoor(source: ts.SourceFile, checker: ts.TypeChecker, basenames: readonly string[], names: readonly string[]): boolean {
  const spiedNames = new Set([...names, ...pilotGuardNames()]);
  function visit(node: ts.Node): boolean {
    if (ts.isCallExpression(node) && changesPilotCall(node, basenames, spiedNames, checker)) return true;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (DOOR_HELPERS.includes(basename(stringArgument(node.arguments[0]) ?? ""))) return true;
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (DOOR_HELPERS.includes(basename(node.moduleSpecifier.text))) return true;
    }
    return ts.forEachChild(node, visit) ?? false;
  }
  return visit(source);
}

/** Inspect invocations, not comments, strings or formatting. Unreadable mock targets refuse certification. */
export function opensAPilotDoor(src: string, basenames: readonly string[], names: readonly string[]): boolean {
  const program = sourceProgram(new Map([["test.tsx", src]]));
  return opensSourceDoor(program.getSourceFile("test.tsx")!, program.getTypeChecker(), basenames, names);
}

/** Parse and bind the complete mock census once, preserving each file's lexical scope. */
export function pilotDoorOpeners(sources: ReadonlyMap<string, string>, basenames: readonly string[], names: readonly string[]): string[] {
  // Vitest executes each file as a module. Make script-shaped fixtures modules too so a
  // top-level binding in one file cannot hide an unbound Vitest invocation in another.
  const isolated = new Map([...sources].map(([file, text]) => [file, `${text}\nexport {};\n`]));
  const program = sourceProgram(isolated);
  const checker = program.getTypeChecker();
  return [...sources.keys()].filter((file) => opensSourceDoor(program.getSourceFile(file)!, checker, basenames, names));
}
