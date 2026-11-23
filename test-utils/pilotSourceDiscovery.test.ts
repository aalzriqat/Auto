import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { discoverGuardedPilotMutations, discoverPilotSources, sourceProgram } from "./pilotSourceDiscovery";

describe("SCRUM-810 bounded compiler work", () => {
  test("reuses an unchanged snapshot across module resets but invalidates changed text and root files", async () => {
    const sources = new Map([
      ["flags.ts", "export const REVIEW_PILOT_DISABLED = true;"],
      ["stable.ts", "export const stable = 1;"],
    ]);
    const first = sourceProgram(sources);
    expect(sourceProgram(new Map(sources))).toBe(first);
    vi.resetModules();
    const reloaded = await import("./pilotSourceDiscovery");
    expect(reloaded.sourceProgram(new Map(sources))).toBe(first);
    sources.set("flags.ts", "export const REVIEW_PILOT_DISABLED = false;");
    const changed = sourceProgram(sources);
    expect(changed).not.toBe(first);
    expect(changed.getSourceFile("stable.ts")).toBe(first.getSourceFile("stable.ts"));
    expect(discoverPilotSources(sources, new Set()).declarations[0]?.value).toBe(false);
    sources.delete("flags.ts");
    sources.set("other.ts", "export const OTHER_PILOT_DISABLED = true;");
    expect(sourceProgram(sources).getSourceFile("flags.ts")).toBeUndefined();
    expect(discoverPilotSources(sources, new Set()).declarations.map((entry) => entry.name)).toEqual(["OTHER_PILOT_DISABLED"]);
  });

  test("finds aliases through cycles and escaped exports outside the usual directories", () => {
    const sources = new Map([
      ["elsewhere/flags.ts", 'export const REVIEW_\\u0050ILOT_DISABLED = true;'],
      ["elsewhere/barrel.ts", 'export * from "./flags"; export * from "./cycle";'],
      ["elsewhere/cycle.ts", 'export * as nested from "./barrel";'],
      ["hooks/exporter.ts", 'import { REVIEW_PILOT_DISABLED as flag } from "../elsewhere/barrel"; export const alias = flag;'],
      ["unrelated.ts", 'export const text = "unrelated";'],
    ]);
    const discovery = discoverPilotSources(sources, new Set());
    expect(discovery.declarations.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: "REVIEW_PILOT_DISABLED", value: true },
    ]);
    expect([...discovery.exportedBy.get("REVIEW_PILOT_DISABLED") ?? []].sort()).toEqual([
      "elsewhere/barrel", "elsewhere/cycle", "elsewhere/flags", "hooks/exporter",
    ]);
  });
});

describe("pilot source discovery controls", () => {
  test.each([
    ["Object.freeze", "Object.freeze({ REVIEW_PILOT_DISABLED: true })"],
    ["Object.freeze as const", "Object.freeze({ REVIEW_PILOT_DISABLED: true } as const)"],
    ["TypeAssertion", "<const>{ REVIEW_PILOT_DISABLED: true }"],
    ["typed TypeAssertion", "<{ REVIEW_PILOT_DISABLED: boolean }>{ REVIEW_PILOT_DISABLED: true }"],
    ["NonNullExpression", "({ REVIEW_PILOT_DISABLED: true })!"],
  ])("R12: discovers %s door maps", (_shape, initializer) => {
    const source = `export const doors = ${initializer};`;
    expect(discoverPilotSources(new Map([["flags.ts", source]]), new Set()).declarations)
      .toMatchObject([{ name: "REVIEW_PILOT_DISABLED", kind: "doorMap", value: true }]);
  });

  test.each([
    ["nested", "export const doors = { custody: { REVIEW_PILOT_DISABLED: true } };"],
    ["class static", "export class Doors { static REVIEW_PILOT_DISABLED = true; }"],
    ["default export", "export default { REVIEW_PILOT_DISABLED: true };"],
  ])("R12: backstop refuses %s door maps with a source location", (_shape, source) => {
    expect(() => discoverPilotSources(new Map([["flags.ts", source]]), new Set()))
      .toThrow(/PILOT_SOURCE_UNCLASSIFIED.*flags.ts:1.*REVIEW_PILOT_DISABLED/);
  });

  test.each([
    ["script declaration", "const REVIEW_PILOT_DISABLED = true;"],
    ["private object", "const doors = { REVIEW_PILOT_DISABLED: true };"],
    ["nested string key", 'export const doors = { custody: { "REVIEW_PILOT_DISABLED": true } };'],
    ["nested computed key", 'export const doors = { custody: { ["REVIEW_PILOT_DISABLED"]: true } };'],
    ["nested wrapped computed key", 'export const doors = { custody: { [("REVIEW_PILOT_DISABLED")!]: true } };'],
    ["class instance", 'export class Doors { "REVIEW_PILOT_DISABLED" = true; }'],
    ["class private member", "export class Doors { static #REVIEW_PILOT_DISABLED = true; }"],
    ["class method", "export class Doors { REVIEW_PILOT_DISABLED() { return true; } }"],
    ["class getter", "export class Doors { get REVIEW_PILOT_DISABLED() { return true; } }"],
    ["wrapped factory", "export const doors = factory({ REVIEW_PILOT_DISABLED: true });"],
    ["freeze extra argument", "export const doors = Object.freeze({ REVIEW_PILOT_DISABLED: true }, extra);"],
    ["freeze other receiver", "export const doors = Other.freeze({ REVIEW_PILOT_DISABLED: true });"],
    ["destructured property key", 'const { REVIEW_PILOT_DISABLED: off } = input;'],
  ])("R12: backstop refuses an unclassified %s", (_shape, source) => {
    expect(() => discoverPilotSources(new Map([["flags.ts", `\n${source}`]]), new Set()))
      .toThrow(/PILOT_SOURCE_UNCLASSIFIED.*flags.ts:2.*REVIEW_PILOT_DISABLED/);
  });

  test("R12: another discovered occurrence cannot excuse a same-name private declaration", () => {
    const sources = new Map([
      ["flags.ts", "export const REVIEW_PILOT_DISABLED = true; function other() { const REVIEW_PILOT_DISABLED = false; }"],
    ]);
    expect(() => discoverPilotSources(sources, new Set())).toThrow(/PILOT_SOURCE_UNCLASSIFIED.*flags.ts:1.*REVIEW_PILOT_DISABLED/);
  });

  test.each([
    ["convex/utils/errors.ts", 'export const AppErrorCode = { REVIEW_PILOT_DISABLED: "off" };'],
    ["lib/pilotCapabilityManifest.ts", 'export const PILOT_SWITCHES = { REVIEW_PILOT_DISABLED: () => true };'],
    ["lib/i18n/domains/common.ts", 'const workspaceMessages = translate({ REVIEW_PILOT_DISABLED: ["off", "blocked"] });'],
    ["test-utils/pilotSwitchMock.ts", 'export function pilotSwitchModule() { return { get REVIEW_PILOT_DISABLED() { return true; } }; }'],
  ])("R12: named non-door registry in %s stays outside switch declarations", (file, source) => {
    expect(discoverPilotSources(new Map([[file, source]]), new Set()).declarations).toEqual([]);
  });

  test.each([
    ["wrong file", "other.ts", 'export const AppErrorCode = { REVIEW_PILOT_DISABLED: "off" };'],
    ["wrong registry", "convex/utils/errors.ts", 'export const OtherCodes = { REVIEW_PILOT_DISABLED: "off" };'],
    ["inherited registry name", "convex/utils/errors.ts", 'export const toString = { REVIEW_PILOT_DISABLED: "off" };'],
    ["shadowed registry name", "convex/utils/errors.ts", 'function other() { const AppErrorCode = { REVIEW_PILOT_DISABLED: "off" }; }'],
    ["nested registry key", "convex/utils/errors.ts", 'export const AppErrorCode = { group: { REVIEW_PILOT_DISABLED: "off" } };'],
    ["private boolean map", "convex/utils/errors.ts", 'const AppErrorCode = { REVIEW_PILOT_DISABLED: true };'],
  ])("R12: registry exemption rejects %s", (_shape, file, source) => {
    expect(() => discoverPilotSources(new Map([[file, source]]), new Set())).toThrow(/PILOT_SOURCE_UNCLASSIFIED.*REVIEW_PILOT_DISABLED/);
  });

  test("R12: comments, value strings, direct reads and test declarations are not new door names", () => {
    const sources = new Map([
      ["flags.ts", '// REVIEW_PILOT_DISABLED\nexport const example = "REVIEW_PILOT_DISABLED"; read(doors.REVIEW_PILOT_DISABLED);'],
      ["flags.test.ts", "const REVIEW_PILOT_DISABLED = true;"],
    ]);
    expect(discoverPilotSources(sources, new Set()).declarations).toEqual([]);
  });

  test("R12: a boolean in a named registry must enter switch discovery", () => {
    const source = 'export const AppErrorCode = { REVIEW_PILOT_DISABLED: true };';
    expect(discoverPilotSources(new Map([["convex/utils/errors.ts", source]]), new Set()).declarations)
      .toMatchObject([{ name: "REVIEW_PILOT_DISABLED", kind: "doorMap", value: true }]);
  });

  test("R12: namespace export names are discovered with unavailable values", () => {
    const source = 'export * as REVIEW_PILOT_DISABLED from "./empty";';
    expect(discoverPilotSources(new Map([["flags.ts", source]]), new Set()).declarations)
      .toMatchObject([{ name: "REVIEW_PILOT_DISABLED", value: null }]);
  });

  test.each([
    ["shorthand", "const REVIEW_PILOT_DISABLED = true; export const doors = { REVIEW_PILOT_DISABLED };", true],
    ["computed string", 'export const doors = { ["REVIEW_PILOT_DISABLED"]: false };', false],
    ["wrapped computed string", 'export const doors = { [("REVIEW_PILOT_DISABLED")!]: false };', false],
    ["computed template", 'export const doors = { [`REVIEW_PILOT_DISABLED`]: true };', true],
    ["computed const", 'const key = "REVIEW_PILOT_DISABLED"; export const doors = { [key]: true };', true],
  ] as const)("door maps discover %s properties", (_shape, source, value) => {
    const discovery = discoverPilotSources(new Map([["flags.ts", source]]), new Set());
    expect(discovery.declarations.map(({ name, kind, value }) => ({ name, kind, value }))).toEqual([
      { name: "REVIEW_PILOT_DISABLED", kind: "doorMap", value },
    ]);
    expect([...discovery.exportedBy.get("REVIEW_PILOT_DISABLED") ?? []]).toEqual(["flags"]);
  });

  test.each([
    ["unresolvable computed key", 'REVIEW_PILOT_DISABLED: true, [runtimeKey()]: true', "computed key"],
    ["spread", 'REVIEW_PILOT_DISABLED: true, ...extra', "spread"],
    ["unresolvable value", 'REVIEW_PILOT_DISABLED: runtimeFlag()', "REVIEW_PILOT_DISABLED"],
    ["nonboolean value", 'REVIEW_PILOT_DISABLED: true, OTHER_PILOT_DISABLED: "true"', "OTHER_PILOT_DISABLED"],
  ])("door maps fail closed on %s", (_shape, properties, detail) => {
    const source = `export const doors = { ${properties} };`;
    expect(() => discoverPilotSources(new Map([["flags.ts", source]]), new Set()))
      .toThrow(new RegExp(`PILOT_SOURCE_DISCOVERY.*flags.ts.*doors.*${detail}`));
  });

  test.each([
    ["computed key without a known sibling", 'export const doors = { [runtimeKey()]: true };'],
    ["unresolved key and value", 'export const doors = { [runtimeKey()]: runtimeFlag() };'],
    ["spread containing the only pilot key", 'const extra = { REVIEW_PILOT_DISABLED: true }; export const doors = { ...extra };'],
    ["unresolved spread without a known sibling", 'export const doors = { ...extra };'],
    ["typed spread containing the only pilot key", 'const extra: Record<string, boolean> = { REVIEW_PILOT_DISABLED: true }; export const doors = { ...extra };'],
    ["boolean index-signature spread", 'declare const extra: { [key: string]: boolean }; export const doors = { ...extra };'],
    ["unresolved spread in a pilot-named map", 'export const doors_PILOT_DISABLED = { ...extra };'],
    ["mutable computed key", 'let key = "REVIEW_PILOT_DISABLED"; export const doors = { [key]: true };'],
    ["mutable shorthand value", 'let REVIEW_PILOT_DISABLED = true; export const doors = { REVIEW_PILOT_DISABLED };'],
    ["unresolved shorthand value", 'const REVIEW_PILOT_DISABLED = runtimeFlag(); export const doors = { REVIEW_PILOT_DISABLED };'],
    ["cyclic const value", 'const a = b; const b = a; export const doors = { REVIEW_PILOT_DISABLED: a };'],
  ])("door maps fail closed on %s", (_shape, source) => {
    expect(() => discoverPilotSources(new Map([["flags.ts", source]]), new Set()))
      .toThrow(/PILOT_SOURCE_DISCOVERY.*flags.ts.*doors/);
  });

  test("door maps retain every key and resolve imported shorthand bindings through aliases", () => {
    const sources = new Map([
      ["bindings.ts", 'const flag = (false) as const; export { flag as REVIEW_PILOT_DISABLED };'],
      ["flags.ts", 'import { REVIEW_PILOT_DISABLED } from "./bindings"; export const doors = { REVIEW_PILOT_DISABLED, other: true };'],
    ]);
    const discovery = discoverPilotSources(sources, new Set());
    expect(discovery.declarations.filter(({ kind }) => kind === "doorMap").map(({ name, value }) => ({ name, value }))).toEqual([
      { name: "REVIEW_PILOT_DISABLED", value: false }, { name: "other", value: true },
    ]);
  });

  test("unnamed nonboolean registries must be explicitly classified", () => {
    const source = `
      const copy: { REVIEW_PILOT_DISABLED: "off" | "blocked" } = { REVIEW_PILOT_DISABLED: "off" };
      export const copies = { ...copy };
      export const readers = { REVIEW_PILOT_DISABLED: () => true };
      export const metadata = { REVIEW_PILOT_DISABLED: ["off"] };
    `;
    expect(() => discoverPilotSources(new Map([["metadata.ts", source]]), new Set()))
      .toThrow(/PILOT_SOURCE_UNCLASSIFIED.*metadata.ts:2.*REVIEW_PILOT_DISABLED/);
  });

  test.each([
    'export { missing as REVIEW_PILOT_DISABLED } from "external";',
    'export const REVIEW_PILOT_DISABLED = { nested: true };',
    'export function REVIEW_PILOT_DISABLED() { return true; }',
  ])("R3-F3: other unreadable exported bindings remain unavailable: %s", (source) => {
    expect(discoverPilotSources(new Map([["hooks/review.ts", source]]), new Set()).declarations.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: "REVIEW_PILOT_DISABLED", value: null },
    ]);
  });

  test.each([
    'export const { REVIEW_PILOT_DISABLED } = { REVIEW_PILOT_DISABLED: true };',
    'export const [REVIEW_PILOT_DISABLED] = [true];',
    'const { flag: REVIEW_PILOT_DISABLED } = input; export { REVIEW_PILOT_DISABLED };',
    'export const { nested: [REVIEW_PILOT_DISABLED] } = input;',
    'const [off] = input; export { off as REVIEW_PILOT_DISABLED };',
    'export const { flag: REVIEW_PILOT_DISABLED = true } = input;',
  ])("R3-F3: destructured exported bindings are discovered with unavailable values: %s", (source) => {
    const discovery = discoverPilotSources(new Map([["hooks/review.ts", source]]), new Set());
    expect(discovery.declarations.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: "REVIEW_PILOT_DISABLED", value: null },
    ]);
    expect([...discovery.exportedBy.get("REVIEW_PILOT_DISABLED") ?? []]).toEqual(["hooks/review"]);
  });

  test("R3-F5: public mutations reading a switch directly are discovered by symbol identity", () => {
    const sources = new Map([
      ["convex/functions.ts", "export const mutation = build(); export const internalMutation = build();"],
      ["lib/flags.ts", "export const REVIEW_PILOT_DISABLED = true;"],
      ["hooks/barrel.ts", 'export { REVIEW_PILOT_DISABLED as flag } from "../lib/flags";'],
      ["convex/direct.ts", `
        import { mutation, internalMutation } from "./functions";
        import { flag as off } from "../hooks/barrel";
        export const direct = mutation({ handler: () => { if (off) throw Error(); } });
        export const hidden = internalMutation({ handler: () => off });
        export const shadowed = mutation({ handler: (off) => off });
        export const example = mutation({ handler: () => "REVIEW_PILOT_DISABLED" });
      `],
    ]);
    expect([...discoverGuardedPilotMutations(sources)]).toEqual([["direct.direct", ["REVIEW_PILOT_DISABLED"]]]);
  });

  test("pilot-named export aliases preserve distinct names and nonliteral evidence stays unavailable", () => {
    const sources = new Map([
      ["lib/local.ts", "const off: boolean = true; export { off as REVIEW_PILOT_DISABLED, off as OTHER_PILOT_REQUIRED };"],
      ["lib/dynamic.ts", "const off = Boolean(true); export { off as DYNAMIC_PILOT_REFUSED };"],
      ["lib/barrel.ts", 'export * as switches from "./local";'],
      ["lib/alias.ts", 'import { REVIEW_PILOT_DISABLED } from "./local"; export const ALIAS_PILOT_DISABLED = REVIEW_PILOT_DISABLED;'],
    ]);
    const discovery = discoverPilotSources(sources, new Set());
    expect(discovery.declarations.map(({ name, value }) => ({ name, value }))).toEqual([
      { name: "REVIEW_PILOT_DISABLED", value: true },
      { name: "OTHER_PILOT_REQUIRED", value: true },
      { name: "DYNAMIC_PILOT_REFUSED", value: null },
      { name: "ALIAS_PILOT_DISABLED", value: null },
    ]);
    expect([...discovery.exportedBy.get("OTHER_PILOT_REQUIRED") ?? []]).toEqual(["lib/local", "lib/barrel"]);
  });

  test("delegated Applications guards require the actual helper call and refusal", () => {
    const applications = `
      import { mutation } from "./functions";
      import { prepare, execute } from "./domains/deal";
      import { EXTRA_PILOT_DISABLED } from "./flags";
      import { requireOwnedRow } from "./utils/tenancy";
      export const finalizeDeal = mutation({ handler: async (ctx, args) => {
        if (EXTRA_PILOT_DISABLED) throw Error();
        const mayReadMoney = await prepare(ctx, args);
        return mayReadMoney;
      } });
      export const correctExpectedPayment = mutation({ handler: async (ctx, args) => {
        const app = await requireOwnedRow(ctx, args.orgId, "financeApplications", args.applicationId);
        return execute(ctx, args, app);
      } });
    `;
    const closing = `
      import { DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED as disabled, refuseDepositOtherTreatment as refuse } from "../../utils/depositOtherContainment";
      export function prepareFinancedClosing(ctx, args) {
        if (args.depositResolution?.treatment === "OTHER" && disabled) { refuse(); }
      }
    `;
    const correction = `
      import { assertRt11DoorAllowed as assertAllowed } from "../../utils/rt11DoorContainment";
      export function executeCorrectExpectedPayment(ctx, args, app) {
        if (app.disbursedAt !== undefined || app.supplierDisbursementConfirmedAt !== undefined) {
          assertAllowed("EXPECTED_PAYMENT_PAID_PILOT_DISABLED");
        }
      }
    `;
    const sources = new Map([
      ["convex/functions.ts", "export const mutation = build();"],
      ["convex/applications.ts", applications],
      ["convex/flags.ts", "export const EXTRA_PILOT_DISABLED = true;"],
      ["convex/domains/deal/index.ts", `
        export { prepareFinancedClosing as prepare } from "./finalizeDeal";
        export { executeCorrectExpectedPayment as execute } from "./expectedPayment";
      `],
      ["convex/domains/deal/finalizeDeal.ts", closing],
      ["convex/domains/deal/expectedPayment.ts", correction],
      ["convex/utils/depositOtherContainment.ts", `
        export const DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED = true;
        export function refuseDepositOtherTreatment() {}
      `],
      ["convex/utils/rt11DoorContainment.ts", "export function assertRt11DoorAllowed(key) {}"],
      ["convex/utils/tenancy.ts", "export function requireOwnedRow(ctx, orgId, table, id) {}"],
    ]);
    expect(discoverGuardedPilotMutations(sources)).toEqual(new Map([
      ["applications.finalizeDeal", ["DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED", "EXTRA_PILOT_DISABLED"]],
      ["applications.correctExpectedPayment", ["assertRt11DoorAllowed"]],
    ]));

    const controls = [
      ["convex/applications.ts", applications.replace("await prepare(ctx, args)", `await Promise.resolve("prepare(ctx, args)")`), "applications.finalizeDeal"],
      ["convex/applications.ts", applications.replace("const mayReadMoney", "return 1; const mayReadMoney"), "applications.finalizeDeal"],
      ["convex/domains/deal/finalizeDeal.ts", closing.replace("refuse();", "function unused() { refuse(); }"), "applications.finalizeDeal"],
      ["convex/domains/deal/finalizeDeal.ts", closing.replace("&& disabled", "&& true"), "applications.finalizeDeal"],
      ["convex/applications.ts", applications.replace("prepare(ctx, args)", "prepare(ctx, {})"), "applications.finalizeDeal"],
      ["convex/applications.ts", applications.replace("execute(ctx, args, app)", "execute(ctx, args, {})"), "applications.correctExpectedPayment"],
      ["convex/applications.ts", applications.replace("args.applicationId);", "args.otherApplicationId);"), "applications.correctExpectedPayment"],
      ["convex/domains/deal/finalizeDeal.ts", closing.replace("refuse();", "return; refuse();"), "applications.finalizeDeal"],
      ["convex/domains/deal/expectedPayment.ts", correction.replace("assertAllowed(", "throw Error(); assertAllowed("), "applications.correctExpectedPayment"],
      ["convex/domains/deal/expectedPayment.ts", correction.replace("EXPECTED_PAYMENT_PAID_PILOT_DISABLED", "SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED"), "applications.correctExpectedPayment"],
      ["convex/domains/deal/expectedPayment.ts", correction.replace("supplierDisbursementConfirmedAt", "unrelatedAt"), "applications.correctExpectedPayment"],
    ] as const;
    for (const [file, changed, door] of controls) {
      const guards = discoverGuardedPilotMutations(new Map(sources).set(file, changed)).get(door);
      expect(guards).toEqual(door === "applications.finalizeDeal" ? ["EXTRA_PILOT_DISABLED"] : undefined);
    }
  });

  test("Finance guards cover all four registered custody paths and reject unsafe preflight shapes", () => {
    const facade = "convex/financeDealCosts.ts";
    const migration = "convex/utils/financeDealCosts/custodyMigration.ts";
    const movement = "convex/utils/financeDealCosts/custodyMovement.ts";
    const reconciliation = "convex/utils/financeDealCosts/custodyReconciliation.ts";
    const sources = new Map([
      facade, migration, movement, reconciliation,
      "convex/functions.ts", "convex/utils/tenancy.ts", "convex/utils/rt11DoorContainment.ts",
      "convex/utils/financeDealCosts/custodyRecords.ts", "convex/utils/financeDealCosts/dealCostGuards.ts",
      "convex/utils/settlementDeductions.ts", "convex/utils/permissions.ts",
    ].map((file) => [file, readFileSync(path.resolve(__dirname, "..", file), "utf8")]));

    const doors = [
      { name: "migrateLegacyCustodyToLedger", file: migration, code: "CUSTODY_MIGRATION_PILOT_DISABLED" },
      { name: "reopenDealCustody", file: reconciliation, code: "CUSTODY_REOPEN_PILOT_DISABLED" },
      { name: "recordCustodyMovement", file: movement, code: "CUSTODY_FINALIZED_MOVEMENT_PILOT_DISABLED" },
      { name: "reconcileDealCustody", file: reconciliation, code: "CUSTODY_WRITEOFF_PILOT_DISABLED" },
    ] as const;
    const [migrate, reopen, move, writeOff] = doors;
    const guard = (code: string) => `assertRt11DoorAllowed("${code}");`;
    const verify = (snapshot: ReadonlyMap<string, string>, door: typeof doors[number], expected: boolean, label: string) => {
      const found = discoverGuardedPilotMutations(snapshot).get(`financeDealCosts.${door.name}`);
      expect.soft(found?.includes("assertRt11DoorAllowed") ?? false, label).toBe(expected);
    };
    const changed = (file: string, before: string, after: string) => {
      const source = sources.get(file);
      if (!source?.includes(before)) throw new Error(`Fixture target is missing from ${file}: ${before}`);
      return new Map(sources).set(file, source.replace(before, after));
    };

    const discovered = discoverGuardedPilotMutations(sources);
    for (const { name } of doors) expect(discovered.get(`financeDealCosts.${name}`)).toEqual(["assertRt11DoorAllowed"]);

    for (const door of doors) {
      const call = guard(door.code);
      verify(changed(door.file, call, `if (args.custodyId) return; ${call}`), door, false, `${door.name} conditional exit`);
      verify(changed(door.file, call, `if (false) { ${call} }`), door, false, `${door.name} dead branch`);
      verify(changed(door.file, call, `const unused = () => { ${call} };`), door, false, `${door.name} callback decoy`);
      verify(changed(door.file, call, `await ctx.db.patch(args.custodyId, {}); ${call}`), door, false, `${door.name} write first`);
    }

    const call = guard(migrate.code);
    verify(changed(migration, call, `const unused = () => { return false; }; ${call}`), migrate, true, "nested return does not exit handler");
    verify(changed(migration, call, `await using resource = () => {}; ${call}`), migrate, false, "resource declaration is not inert");
    verify(changed(migration, call, `await runWithIdempotency(ctx, {}, async () => null); ${call}`), migrate, false, "idempotency before guard");
    verify(changed(reconciliation, guard(reopen.code), `return args.custodyId; ${guard(reopen.code)}`), reopen, false, "unconditional early success");
    verify(changed(migration, call, `function assertRt11DoorAllowed() {} ${call}`), migrate, false, "shadowed guard");
    verify(changed(migration, call, guard(reopen.code)), migrate, false, "wrong switch");
    const migrationSource = sources.get(migration) ?? "";
    const standInGuards = 'const standIn = { assertRt11DoorAllowed() {} } as typeof import("../rt11DoorContainment");';
    for (const access of [".", "?."]) {
      const replacement = migrationSource.replace(call, `standIn${access}${call}`);
      verify(new Map(sources).set(migration, `${standInGuards}\n${replacement}`), migrate, false, `typed guard stand-in: ${access}`);
    }
    verify(changed(movement, 'if (args.kind === "REVERSAL"', 'if (args.custodyId) return; if (args.kind === "REVERSAL"'), move, false, "exit before applicable branch");
    verify(changed(movement, "ownedCustody.applicationId, APPLICATION_NOT_FOUND", "args.custodyId, APPLICATION_NOT_FOUND"), move, false, "wrong parent");
    verify(changed(movement, "if (dealEconomicsFrozen(parent).frozen)", "const dealEconomicsFrozen = () => ({ frozen: false }); if (dealEconomicsFrozen(parent).frozen)"), move, false, "shadowed condition helper");
    verify(changed(movement, 'args.kind === "REIMBURSED"', 'args.kind === "RETURNED"'), move, false, "wrong applicable movement");
    verify(changed(reconciliation, "args.writeOffReason?.trim()", "args.notes.trim()"), writeOff, false, "wrong write-off input");
    verify(changed(reconciliation, "loadActiveFees(ctx, owned.applicationId)", "loadActiveFees(ctx, args.custodyId)"), writeOff, false, "wrong summary inputs");
    verify(changed(reconciliation, "const notes = args.notes.trim();", "function ConvexError() {} const notes = args.notes.trim();"), writeOff, false, "shadowed note refusal");
    verify(changed(reconciliation, "const writeOffReason = args.writeOffReason?.trim()", "function undefined() {} const writeOffReason = args.writeOffReason?.trim()"), writeOff, false, "shadowed write-off default");

    const invocation = "migrateLegacyCustodyToLedgerHandler(ctx, args, accounting)";
    const facadeSource = sources.get(facade) ?? "";
    const standInHandler = 'const standIn = { migrateLegacyCustodyToLedgerHandler() {} } as typeof import("./utils/financeDealCosts/custodyMigration");';
    const replacement = facadeSource.replace(invocation, `standIn.${invocation}`);
    verify(new Map(sources).set(facade, `${standInHandler}\n${replacement}`), migrate, false, "typed handler stand-in");
    for (const wrong of [
      "recordCustodyMovementHandler(ctx, args, accounting)",
      "migrateLegacyCustodyToLedgerHandler({}, args, accounting)",
      "migrateLegacyCustodyToLedgerHandler(ctx, { ...args }, accounting)",
      "migrateLegacyCustodyToLedgerHandler(ctx, args, {})",
    ]) {
      verify(changed(facade, invocation, wrong), migrate, false, wrong);
    }
  });

  test("guard census resolves export, builder and guard aliases while ignoring other handlers and examples", () => {
    const sources = new Map([
      ["convex/functions.ts", "export const mutation = build(); export const internalMutation = build(); export const query = build();"],
      ["convex/_generated/server.d.ts", "export declare const mutation: unknown;"],
      ["convex/utils/reviewContainment.ts", "export function assertReviewAllowed() {} export function assertReviewEnabled() {}"],
      ["convex/review.ts", `
        import { mutation as command, internalMutation, query } from "./functions";
        import { assertReviewAllowed as refuse, assertReviewEnabled } from "./utils/reviewContainment";
        const local = command({ handler: () => { if (condition) refuse(); } });
        export { local as renamed };
        export const hidden = internalMutation({ handler: () => refuse() });
        export const reader = query({ handler: () => refuse() });
        export const unrelated = command({ args: refuse(), handler: () => "refuse()" });
        export const enabled = command({ handler() { assertReviewEnabled(); } });
        export function helper() { refuse(); }
      `],
      ["convex/raw.ts", `
        import * as server from "./_generated/server";
        import * as guards from "./utils/reviewContainment";
        export const raw = server.mutation({ handler: () => guards.assertReviewAllowed() });
      `],
      ["convex/review.test.ts", 'export const ignored = mutation({ handler: () => assertReviewAllowed() });'],
      ["convex/sub/nested.ts", 'export const ignored = mutation({ handler: () => assertReviewAllowed() });'],
    ]);
    expect([...discoverGuardedPilotMutations(sources)]).toEqual([
      ["review.renamed", ["assertReviewAllowed"]],
      ["review.enabled", ["assertReviewEnabled"]],
      ["raw.raw", ["assertReviewAllowed"]],
    ]);
  });
});
