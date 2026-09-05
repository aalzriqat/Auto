/**
 * SCRUM-238 (SCRUM-218-E) — the guard's own suite.
 *
 * ## How to read this file
 *
 * It has two halves and they prove different things, which is the whole point.
 *
 * **Half one — FIXTURE PROGRAMS.** In-memory TypeScript programs whose source
 * exists only to be judged. They prove the MECHANISM: each of the four write
 * operations is detected and classified, the owner module is exempt, and the
 * dynamic forms are either resolved or explicitly refused by name.
 *
 * **Half two — THE REAL BACKEND.** The same analyzer, run over the actual
 * `convex/` program with the actual Convex `GenericId` types. It proves the
 * analyzer VISITS AND CLASSIFIES REAL SOURCE, which no fixture can establish.
 *
 * ⚠️ The second half exists because of the specific way a type-aware analyzer
 * fails: if receiver recognition breaks, it finds zero sites, reports zero
 * violations and exits green — indistinguishable from a clean backend. Every
 * fixture test would still pass. So the real-source controls are not decoration
 * and must not be deleted to make an unrelated change go faster.
 *
 * ## ⚠️ WHAT A GREEN RUN OF THIS FILE DOES *NOT* MEAN
 *
 * `RECEIPT_AUTHORITY_DECLARATION` is EMPTY at this commit, because SCRUM-218-C
 * has not frozen its table names. So a green run proves the mechanism works and
 * that every database write in the backend has a statically provable target
 * table. It does **not** prove receipt authority is enforced — nothing is
 * declared yet. `the shipped declaration is unbound` below asserts exactly that,
 * so the distinction cannot be lost by reading only the exit code.
 */
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  auditAuthorityWrites,
  classifyWriteSite,
  collectDbWriteSites,
  compareStrings,
  createConvexAnalyzerProgram,
  createVirtualAnalyzerProgram,
  describeBinding,
  formatAuthorityAuditFailure,
  syntacticDbWriteCallSites,
  RECEIPT_AUTHORITY_DECLARATION,
  DB_WRITE_METHODS,
  type AnalyzerProgram,
  type AuthorityAuditResult,
  type AuthorityDeclaration,
  type DbWriteSite,
  type SiteFinding,
} from "./receiptAuthorityWriteGuard";

const REPO_ROOT = path.resolve(__dirname, "..");

/* ========================================================================= *
 * HALF ONE — FIXTURE PROGRAMS
 * ========================================================================= */

const OWNER_MODULE = "/virtual/authority/receiptAuthority.ts";

/**
 * ⚠️ `receiptMovements` HERE IS A FIXTURE NAME AND NOTHING ELSE.
 *
 * It is not a prediction of what SCRUM-218-C will call its tables, and nothing
 * in the shipped guard depends on it. The mechanism is name-agnostic; when
 * 218-C freezes real names they go into `RECEIPT_AUTHORITY_DECLARATION`, and
 * these fixtures do not change.
 */
const FIXTURE_DECLARATION: readonly AuthorityDeclaration[] = [
  { table: "receiptMovements", ownerModule: OWNER_MODULE },
];

/**
 * A writer shaped exactly like Convex's, declared locally.
 *
 * `Id<T> = string & { __tableName: T }` is Convex's real definition
 * (`convex/dist/esm-types/values/value.d.ts`), reproduced rather than imported
 * so a fixture program needs no module resolution into `node_modules` and no
 * generated data model. `Writer` is not named `…DatabaseWriter`, which is
 * deliberate: it forces these fixtures through the STRUCTURAL receiver check
 * rather than the symbol-name shortcut. The symbol-name path is exercised by
 * the real backend in half two.
 */
const PREAMBLE = [
  'type Id<TableName extends string> = string & { __tableName: TableName };',
  "interface Doc<TableName extends string> { _id: Id<TableName>; amountMinor: number }",
  "interface Writer {",
  "  insert<T extends string>(table: T, value: Record<string, unknown>): Promise<Id<T>>;",
  "  patch<T extends string>(id: Id<T>, value: Record<string, unknown>): Promise<void>;",
  "  replace<T extends string>(id: Id<T>, value: Record<string, unknown>): Promise<void>;",
  "  delete<T extends string>(id: Id<T>): Promise<void>;",
  "  get<T extends string>(id: Id<T>): Promise<Doc<T> | null>;",
  "}",
  "interface Ctx { db: Writer }",
  "declare const ctx: Ctx;",
  'declare const movementId: Id<"receiptMovements">;',
  'declare const vehicleId: Id<"vehicles">;',
  "",
].join("\n");

function fixture(...lines: string[]): string {
  return PREAMBLE + lines.join("\n") + "\n";
}

function auditFixture(
  files: Readonly<Record<string, string>>,
  declaration: readonly AuthorityDeclaration[] = FIXTURE_DECLARATION
): AuthorityAuditResult {
  return auditAuthorityWrites(createVirtualAnalyzerProgram(files), declaration);
}

/** One rogue module holding `body`, plus the (empty) declared owner module. */
function auditRogue(...body: string[]): AuthorityAuditResult {
  return auditFixture({
    "/virtual/rogue.ts": fixture(...body),
    [OWNER_MODULE]: fixture("export {};"),
  });
}

function methodsOf(findings: readonly SiteFinding[]): string[] {
  return findings.map((f) => f.site.method).sort(compareStrings);
}

function tablesOf(site: DbWriteSite): readonly string[] {
  return site.resolution.kind === "RESOLVED" ? site.resolution.tables : [];
}

/**
 * ⚠️ THE CONTROL THAT MAKES EVERY FIXTURE TEST BELOW MEAN SOMETHING.
 *
 * A virtual program that failed to load `lib.d.ts`, or failed to resolve its
 * own declarations, would hand the checker error types everywhere. Some of the
 * assertions below would still pass — an unresolvable type is refused, and
 * refusal is what several tests expect — so a broken fixture harness could look
 * like a working guard. These two tests assert the harness itself: real types,
 * no diagnostics, and a resolution that is only possible if the checker
 * genuinely read the brand.
 */
describe("the fixture harness itself", () => {
  it("builds a program with no type errors, so its verdicts come from real types", () => {
    const files = {
      "/virtual/rogue.ts": fixture(
        "export async function rogue() {",
        '  await ctx.db.insert("receiptMovements", { amountMinor: 1 });',
        "  await ctx.db.patch(movementId, { amountMinor: 2 });",
        "  await ctx.db.replace(movementId, { amountMinor: 3 });",
        "  await ctx.db.delete(movementId);",
        "}"
      ),
      [OWNER_MODULE]: fixture("export {};"),
    };
    const analyzer = createVirtualAnalyzerProgram(files);
    const diagnostics = analyzer.analysed.flatMap(([sourceFile]) =>
      analyzer.program.getSemanticDiagnostics(sourceFile)
    );
    expect(diagnostics.map((d) => `${d.file?.fileName}: ${d.messageText}`)).toEqual([]);
    expect(analyzer.analysed.map(([, name]) => name).sort(compareStrings)).toEqual(
      Object.keys(files).sort(compareStrings)
    );
  });

  it("distinguishes two ids that are textually identical and differ only by type", () => {
    const result = auditRogue(
      "export async function rogue(a: Id<\"receiptMovements\">, b: Id<\"vehicles\">) {",
      "  await ctx.db.delete(a);",
      "  await ctx.db.delete(b);",
      "}"
    );
    expect(result.coverage.writeSites).toBe(2);
    expect(result.violations).toHaveLength(1);
    expect(tablesOf(result.violations[0].site)).toEqual(["receiptMovements"]);
  });
});

describe("the four write operations, from a module that is not the declared owner", () => {
  /** Ticket evidence item 1. Kills the "disable insert detection" mutant. */
  it("refuses an unauthorized insert", () => {
    const result = auditRogue(
      "export async function rogue() {",
      '  await ctx.db.insert("receiptMovements", { amountMinor: 1 });',
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["insert"]);
    expect(result.violations[0].site.file).toBe("/virtual/rogue.ts");
    expect(tablesOf(result.violations[0].site)).toEqual(["receiptMovements"]);
  });

  /** Ticket evidence item 2. Kills the "disable patch detection" mutant. */
  it("refuses an unauthorized patch", () => {
    const result = auditRogue(
      "export async function rogue() {",
      "  await ctx.db.patch(movementId, { amountMinor: 2 });",
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["patch"]);
    expect(tablesOf(result.violations[0].site)).toEqual(["receiptMovements"]);
  });

  /** Ticket evidence item 2. Kills the "disable replace detection" mutant. */
  it("refuses an unauthorized replace", () => {
    const result = auditRogue(
      "export async function rogue() {",
      "  await ctx.db.replace(movementId, { amountMinor: 2 });",
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["replace"]);
    expect(tablesOf(result.violations[0].site)).toEqual(["receiptMovements"]);
  });

  /**
   * ⚠️ TICKET EVIDENCE ITEM 3 — THE CASE THE WHOLE TICKET EXISTS FOR.
   *
   * `ctx.db.delete(movementId)` contains no table name in any spelling. The
   * only thing that resolves it is the `__tableName` brand on the argument's
   * TYPE. Kills the "disable typed delete resolution" mutant.
   */
  it("refuses an unauthorized delete whose id is statically typed to the table", () => {
    const result = auditRogue("export async function rogue() {", "  await ctx.db.delete(movementId);", "}");
    expect(methodsOf(result.violations)).toEqual(["delete"]);
    expect(tablesOf(result.violations[0].site)).toEqual(["receiptMovements"]);
    expect(result.violations[0].site.snippet).toContain("delete(movementId)");
  });

  it("reports all four in one pass when a module does all four", () => {
    const result = auditRogue(
      "export async function rogue() {",
      '  await ctx.db.insert("receiptMovements", { amountMinor: 1 });',
      "  await ctx.db.patch(movementId, { amountMinor: 2 });",
      "  await ctx.db.replace(movementId, { amountMinor: 3 });",
      "  await ctx.db.delete(movementId);",
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["delete", "insert", "patch", "replace"]);
  });
});

describe("the declared owner module", () => {
  /**
   * Ticket evidence item 4, and the control that makes every test above mean
   * something: without it, a guard that simply failed on all four operations
   * everywhere would pass the whole "refuses" block.
   *
   * Kills the "incorrectly whitelist a table" mutant (which would empty
   * `violations` above) and the "allow an unauthorized module" mutant (which
   * would empty them too) — both of those break the pair, not this test alone.
   */
  it("may perform all four operations", () => {
    const result = auditFixture({
      [OWNER_MODULE]: fixture(
        "export async function owned() {",
        '  await ctx.db.insert("receiptMovements", { amountMinor: 1 });',
        "  await ctx.db.patch(movementId, { amountMinor: 2 });",
        "  await ctx.db.replace(movementId, { amountMinor: 3 });",
        "  await ctx.db.delete(movementId);",
        "}"
      ),
    });
    expect(result.violations).toEqual([]);
    expect(methodsOf(result.authorized)).toEqual(["delete", "insert", "patch", "replace"]);
  });

  it("is matched on the full path, not the basename", () => {
    const impostor = "/virtual/elsewhere/receiptAuthority.ts";
    const result = auditFixture({
      [impostor]: fixture("export async function rogue() {", "  await ctx.db.delete(movementId);", "}"),
      [OWNER_MODULE]: fixture("export {};"),
    });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].site.file).toBe(impostor);
  });
});

describe("writes that are none of this guard's business", () => {
  /** A guard that flags everything enforces nothing. */
  it("ignores writes to undeclared tables", () => {
    const result = auditRogue(
      "export async function ordinary() {",
      '  await ctx.db.insert("vehicles", { amountMinor: 1 });',
      "  await ctx.db.patch(vehicleId, { amountMinor: 2 });",
      "  await ctx.db.delete(vehicleId);",
      "}"
    );
    expect(result.violations).toEqual([]);
    expect(result.unproven).toEqual([]);
    expect(result.coverage.writeSites).toBe(3);
  });

  it("ignores same-named methods on objects that are not database writers", () => {
    const result = auditRogue(
      "interface Cache { delete(key: string): void; get(key: string): unknown }",
      "declare const cache: Cache;",
      "declare const bag: Map<string, number>;",
      "declare const list: { insert(value: number): void };",
      "export function noise() {",
      '  cache.delete("receiptMovements");',
      '  bag.delete("receiptMovements");',
      "  list.insert(1);",
      "}"
    );
    expect(result.coverage.writeSites).toBe(0);
    expect(result.violations).toEqual([]);
  });

  it("ignores a read-only context, which cannot write at all", () => {
    const result = auditRogue(
      "interface Reader { get<T extends string>(id: Id<T>): Promise<Doc<T> | null> }",
      "declare const queryCtx: { db: Reader };",
      "export async function readOnly() {",
      "  await queryCtx.db.get(movementId);",
      "}"
    );
    expect(result.coverage.writeSites).toBe(0);
  });
});

describe("dynamic and indirect forms — resolved where possible, named where not", () => {
  /** Ticket evidence item 6. A text scan cannot read a binding; a type can. */
  it("resolves an insert whose table name is a const-bound identifier", () => {
    const result = auditRogue(
      "export async function rogue() {",
      '  const table = "receiptMovements";',
      "  await ctx.db.insert(table, { amountMinor: 1 });",
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["insert"]);
    expect(result.unproven).toEqual([]);
  });

  it("resolves a conditional insert to the union of both table names", () => {
    const result = auditRogue(
      "declare const flag: boolean;",
      "export async function rogue() {",
      '  await ctx.db.insert(flag ? "receiptMovements" : "vehicles", { amountMinor: 1 });',
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["insert"]);
    expect(tablesOf(result.violations[0].site)).toEqual(["receiptMovements", "vehicles"]);
  });

  it("resolves an id read off a document, not just a declared parameter", () => {
    const result = auditRogue(
      "export async function rogue() {",
      "  const row = await ctx.db.get(movementId);",
      "  if (row) await ctx.db.delete(row._id);",
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["delete"]);
  });

  it("resolves an id returned by a helper in another module", () => {
    const result = auditFixture({
      "/virtual/helpers/lookup.ts": fixture(
        'export declare function findMovement(): Promise<Id<"receiptMovements">>;'
      ),
      "/virtual/rogue.ts": fixture(
        'import { findMovement } from "./helpers/lookup";',
        "export async function rogue() {",
        "  await ctx.db.delete(await findMovement());",
        "}"
      ),
      [OWNER_MODULE]: fixture("export {};"),
    });
    expect(methodsOf(result.violations)).toEqual(["delete"]);
    expect(result.violations[0].site.file).toBe("/virtual/rogue.ts");
  });

  it("sees a writer reached through a destructured binding", () => {
    const result = auditRogue(
      "export async function rogue() {",
      "  const { db } = ctx;",
      "  await db.delete(movementId);",
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["delete"]);
  });

  it("sees a writer passed as a plain parameter, with no `ctx` in sight", () => {
    const result = auditRogue(
      "export async function rogue(writer: Writer) {",
      "  await writer.delete(movementId);",
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["delete"]);
  });

  it("sees a write nested inside a callback", () => {
    const result = auditRogue(
      "export async function rogue() {",
      "  await Promise.all([movementId].map(async (id) => { await ctx.db.delete(id); }));",
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["delete"]);
  });

  /**
   * ⚠️ THE PAYLOAD IS IRRELEVANT HERE, AND THAT IS A REAL DIFFERENCE FROM
   * `commitmentWriteGuard`, WHICH IS BLIND TO A NON-LITERAL PAYLOAD.
   *
   * This guard asks which TABLE is written, and the table comes from the id.
   * A spread, a variable, a call result and a conditional payload are all
   * equally visible.
   */
  it("is unaffected by a spread or otherwise opaque payload", () => {
    const result = auditRogue(
      "declare const payload: Record<string, unknown>;",
      "declare function makePatch(): Record<string, unknown>;",
      "export async function rogue() {",
      "  await ctx.db.patch(movementId, { ...payload });",
      "  await ctx.db.replace(movementId, makePatch());",
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["patch", "replace"]);
    expect(result.unproven).toEqual([]);
  });

  /**
   * ⚠️ THE SPELLING THAT WALKS PAST A PROPERTY-ACCESS-ONLY ANALYZER.
   *
   * `ctx.db["delete"](id)` compiles to exactly the same delete. The first
   * version of this guard read only property accesses and missed it entirely —
   * the same class of hole as the single-quoted `insert('organizations', …)`
   * that defeated `commitmentWriteGuard`'s regex, one syntax node over. Found
   * by attacking my own detector before freezing it, not by a reviewer.
   */
  it("sees a bracket call by its literal method name", () => {
    const result = auditRogue(
      "export async function rogue() {",
      '  await ctx.db["delete"](movementId);',
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["delete"]);
    expect(result.unproven).toEqual([]);
  });

  it("sees a bracket call whose method name is a const binding", () => {
    const result = auditRogue(
      "export async function rogue() {",
      '  const operation = "patch";',
      "  await ctx.db[operation](movementId, { amountMinor: 1 });",
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["patch"]);
  });

  it("refuses a bracket call whose method name is not statically one method", () => {
    const result = auditRogue(
      "declare const flag: boolean;",
      "export async function rogue() {",
      '  await ctx.db[flag ? "delete" : "replace"](movementId);',
      "}"
    );
    expect(result.violations).toEqual([]);
    expect(result.unproven).toHaveLength(1);
    expect(result.unproven[0].site.method).toBe("unknown");
    expect(result.unproven[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "write-method-not-statically-known",
    });
  });

  it("refuses a bracket call indexed by a runtime string", () => {
    const result = auditRogue(
      "declare const operation: string;",
      "export async function rogue() {",
      "  await ctx.db[operation](movementId);",
      "}"
    );
    expect(result.unproven).toHaveLength(1);
    expect(result.unproven[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "write-method-not-statically-known",
    });
  });

  it("does not treat a bracket call to a read method as a write", () => {
    const result = auditRogue(
      "export async function rogue() {",
      '  await ctx.db["get"](movementId);',
      "}"
    );
    expect(result.coverage.writeSites).toBe(0);
  });

  /**
   * ⚠️ REGRESSION CONTROL — `as any` USED TO MAKE A WRITE VANISH ENTIRELY.
   *
   * Not a violation, not unproven: no site at all, which contradicted the
   * guard's own promise that nothing is silently skipped. `as any` is the
   * canonical TypeScript escape hatch, so it is the first thing anyone reaches
   * for. Found by two independent reviewers and reproduced with a positive
   * control (the same write spelled directly is still flagged) before the fix.
   */
  it("refuses a write whose receiver type is erased to `any`", () => {
    const result = auditRogue(
      "export async function rogue() {",
      "  await (ctx.db as any).delete(movementId);",
      "}"
    );
    expect(result.coverage.writeSites).toBe(1);
    expect(result.unproven).toHaveLength(1);
    expect(result.unproven[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "receiver-type-not-statically-known",
    });
  });

  it("refuses a write through an `any`-typed writer binding", () => {
    const result = auditRogue(
      "export async function rogue() {",
      "  const writer: any = ctx.db;",
      '  await writer.insert("receiptMovements", { amountMinor: 1 });',
      "}"
    );
    expect(result.unproven).toHaveLength(1);
    expect(result.unproven[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "receiver-type-not-statically-known",
    });
  });

  /**
   * The precision half of the same fix: a statically known method name that is
   * not one of the four clears the call whatever its receiver is. Without this
   * the fail-closed rule would flag every `(x as any).get(…)` in the codebase.
   */
  it("does not refuse a READ through an erased receiver", () => {
    const result = auditRogue(
      "export async function rogue() {",
      "  await (ctx.db as any).get(movementId);",
      '  await (ctx.db as any)["get"](movementId);',
      "}"
    );
    expect(result.coverage.writeSites).toBe(0);
  });

  /**
   * ⚠️ REGRESSION CONTROL — A WRITE METHOD TAKEN AS A VALUE HAS NO PROPERTY
   * ACCESS AT ITS CALL SITE, SO IT USED TO VANISH TOO.
   *
   * `delete` is a reserved word, so the rename-destructure below is the
   * ORDINARY way to hold a reference to it — this is not an exotic spelling.
   */
  it("refuses a write method pulled out by a renaming destructure", () => {
    const result = auditRogue(
      "export async function rogue() {",
      "  const { delete: removeRow } = ctx.db;",
      "  await removeRow(movementId);",
      "}"
    );
    expect(result.unproven).toHaveLength(1);
    expect(result.unproven[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "write-method-reference-escapes",
    });
    expect(result.unproven[0].site.method).toBe("delete");
  });

  it("refuses a write method handed to call, bind or Reflect.apply", () => {
    const result = auditRogue(
      "export async function rogue() {",
      "  await ctx.db.delete.call(ctx.db, movementId);",
      "  const bound = ctx.db.delete.bind(ctx.db);",
      "  await bound(movementId);",
      "  await Reflect.apply(ctx.db.delete, ctx.db, [movementId]);",
      "}"
    );
    expect(result.unproven.length).toBeGreaterThanOrEqual(3);
    expect(
      result.unproven.every(
        (f) => f.verdict.verdict === "UNPROVEN" && f.verdict.form === "write-method-reference-escapes"
      )
    ).toBe(true);
  });

  it("refuses a write method passed to a higher-order helper", () => {
    const result = auditRogue(
      "declare function callWith<T extends string>(",
      "  fn: (id: Id<T>) => Promise<void>,",
      "  id: Id<T>",
      "): Promise<void>;",
      "export async function rogue() {",
      "  await callWith(ctx.db.delete, movementId);",
      "}"
    );
    expect(result.unproven).toHaveLength(1);
    expect(result.unproven[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "write-method-reference-escapes",
    });
  });

  /**
   * The precision half again: an ordinary direct call must be counted ONCE, as
   * a violation, and must not also be reported as an escaping reference.
   */
  it("does not report an ordinary direct call as an escaping reference", () => {
    const result = auditRogue("export async function rogue() {", "  await ctx.db.delete(movementId);", "}");
    expect(result.coverage.writeSites).toBe(1);
    expect(result.unproven).toEqual([]);
    expect(methodsOf(result.violations)).toEqual(["delete"]);
  });

  it("treats an optional call as the write it is", () => {
    const result = auditRogue(
      "export async function rogue() {",
      "  await ctx.db?.delete(movementId);",
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["delete"]);
    expect(result.unproven).toEqual([]);
  });

  /** Ticket evidence item 6, refusal half. Named form, not a silent skip. */
  it("refuses an insert whose table name is computed at runtime", () => {
    const result = auditRogue(
      "declare const suffix: string;",
      "export async function rogue() {",
      "  await ctx.db.insert(`receipt${suffix}`, { amountMinor: 1 });",
      "}"
    );
    expect(result.violations).toEqual([]);
    expect(result.unproven).toHaveLength(1);
    expect(result.unproven[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "insert-table-name-not-statically-known",
    });
  });

  it("refuses a delete through a generic `Id<string>`, whose brand names no table", () => {
    const result = auditRogue(
      "declare const anyTable: Id<string>;",
      "export async function rogue() {",
      "  await ctx.db.delete(anyTable);",
      "}"
    );
    expect(result.unproven).toHaveLength(1);
    expect(result.unproven[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "id-table-brand-not-statically-known",
    });
  });

  /**
   * ⚠️ AN `any` ID IS REFUSED, NOT WAVED THROUGH.
   *
   * This is the direction that matters. `any` is exactly how a type-aware
   * check gets quietly defeated, and a guard whose green result is an
   * authorization must refuse what it cannot read.
   */
  it("refuses a delete through an `any`-typed id", () => {
    const result = auditRogue(
      "declare const untyped: any;",
      "export async function rogue() {",
      "  await ctx.db.delete(untyped);",
      "}"
    );
    expect(result.violations).toEqual([]);
    expect(result.unproven).toHaveLength(1);
    expect(result.unproven[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "id-type-carries-no-table-brand",
    });
  });

  /**
   * ⚠️ A DELIBERATE SEMANTIC CHANGE FROM `1ed1adff5`, RECORDED RATHER THAN
   * QUIETLY MADE.
   *
   * This object has all four method names and no `Id` anywhere. The old
   * detector refused it, because it recognised a writer by "has all four
   * names" — and that same heuristic is exactly what let `Pick<Writer,
   * "delete">` and a delete-only view escape entirely, which was the worse
   * failure by far. Recognition is now by whether the MEMBER handles a Convex
   * `Id`, so an object that merely shares the names is indistinguishable from a
   * cache and is cleared.
   *
   * The trade is stated plainly: a hand-rolled store with `string` ids is no
   * longer refused. It also cannot perform a Convex database write, which is
   * the only thing this guard is about.
   */
  it("ignores a look-alike whose members never handle a Convex id", () => {
    const result = auditRogue(
      "interface LooseWriter {",
      "  insert(table: string, value: unknown): Promise<void>;",
      "  patch(id: string, value: unknown): Promise<void>;",
      "  replace(id: string, value: unknown): Promise<void>;",
      "  delete(id: string): Promise<void>;",
      "}",
      "declare const loose: LooseWriter;",
      "export async function rogue() {",
      '  await loose.delete("someRowId");',
      "}"
    );
    expect(result.coverage.writeSites).toBe(0);
  });

  /**
   * The second form of the one quiet exit: an index that POSITIVELY cannot name
   * one of the four. Without it the guard reported `convJson.data?.[0]` — an
   * array index into parsed JSON — as an unreadable write on the real backend.
   */
  it("ignores a numeric index, which cannot name a write member", () => {
    const result = auditRogue(
      "declare const parsed: any;",
      "export function rogue() {",
      "  void parsed.data?.[0];",
      "  void parsed.rows?.[1];",
      "}"
    );
    expect(result.coverage.writeSites).toBe(0);
  });

  /**
   * ⚠️ FAIL-CLOSED IS INDEPENDENT OF THE DECLARATION.
   *
   * Kills the "make unresolved dynamic deletion silently pass" mutant. An
   * unreadable write is refused even with nothing declared — because with
   * nothing declared there is no table it can be cleared against.
   */
  it("still refuses an unreadable write when no authority table is declared", () => {
    const empty = auditFixture(
      {
        "/virtual/rogue.ts": fixture(
          "declare const untyped: any;",
          "export async function rogue() {",
          "  await ctx.db.delete(untyped);",
          "}"
        ),
      },
      []
    );
    expect(empty.binding.status).toBe("NOTHING_DECLARED");
    expect(empty.unproven).toHaveLength(1);
    expect(formatAuthorityAuditFailure(empty)).toContain("cannot be proven");
  });
});

/**
 * ⚠️ THE c17676 FAMILY — EVERY ONE OF THESE PRODUCED NO SITE AT ALL.
 *
 * Not a violation, not even an unproven one: the analyzer returned an empty set
 * and a clean exit. Two independent review seats found them, each spelling was
 * reproduced with ZERO compiler diagnostics, and the same write spelled
 * directly is still flagged — so the difference is the analyzer, not the
 * fixture.
 *
 * They are grouped because they share one cause. The old detector had MANY
 * quiet exits — receiver not structurally a writer, escape not a known write
 * method, destructuring key not an identifier, no member access at all — and
 * every hole found across two review rounds was one of them. The redesign
 * leaves exactly one: a statically known member name that is not one of the
 * four. Everything else becomes UNPROVEN.
 *
 * These tests were written RED against `1ed1adff5` and failed there, which is
 * the point of keeping that SHA as evidence rather than patching it.
 */
describe("the c17676 family — writes that used to vanish entirely", () => {
  it("refuses a write through a narrowed writer view", () => {
    const result = auditRogue(
      'declare function capability(writer: Writer): Pick<Writer, "delete">;',
      "export async function rogue() {",
      "  await capability(ctx.db).delete(movementId);",
      "}"
    );
    expect(result.coverage.writeSites).toBe(1);
    expect(methodsOf(result.violations)).toEqual(["delete"]);
  });

  it("refuses a write through a view that exposes only one of the four", () => {
    const result = auditRogue(
      "interface DeleteOnly { delete<T extends string>(id: Id<T>): Promise<void> }",
      "declare const view: DeleteOnly;",
      "export async function rogue() {",
      "  await view.delete(movementId);",
      "}"
    );
    expect(result.coverage.writeSites).toBe(1);
    expect(methodsOf(result.violations)).toEqual(["delete"]);
  });

  it("refuses a write through a union receiver", () => {
    const result = auditRogue(
      "interface DeleteOnly { delete<T extends string>(id: Id<T>): Promise<void> }",
      "declare const either: Writer | DeleteOnly;",
      "export async function rogue() {",
      "  await either.delete(movementId);",
      "}"
    );
    expect(result.coverage.writeSites).toBe(1);
    expect(methodsOf(result.violations)).toEqual(["delete"]);
  });

  it("refuses a write method taken off an erased receiver", () => {
    const result = auditRogue(
      "export async function rogue() {",
      "  const remove = (ctx.db as any).delete;",
      "  await remove(movementId);",
      "}"
    );
    expect(result.unproven).toHaveLength(1);
    expect(result.unproven[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "receiver-type-not-statically-known",
    });
  });

  /** `delete` is a reserved word, so a computed key is an ordinary spelling. */
  it("refuses a computed destructuring key on a writer", () => {
    const result = auditRogue(
      'declare const operation: "delete";',
      "export async function rogue() {",
      "  const { [operation]: removeRow } = ctx.db;",
      "  await removeRow(movementId);",
      "}"
    );
    expect(result.unproven).toHaveLength(1);
    expect(result.unproven[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "write-method-reference-escapes",
    });
  });

  it("refuses an assignment destructuring, which declares nothing", () => {
    const result = auditRogue(
      "export async function rogue() {",
      '  let removeRow!: Writer["delete"];',
      "  ({ delete: removeRow } = ctx.db);",
      "  await removeRow(movementId);",
      "}"
    );
    expect(result.unproven).toHaveLength(1);
    expect(result.unproven[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "write-method-reference-escapes",
    });
  });

  it("refuses an escaping bracket whose method name is a union of writes", () => {
    const result = auditRogue(
      'declare const operation: "patch" | "replace";',
      "declare function take(value: unknown): void;",
      "export function rogue() {",
      "  take(ctx.db[operation]);",
      "}"
    );
    expect(result.unproven).toHaveLength(1);
    expect(result.unproven[0].site.method).toBe("unknown");
  });

  /**
   * Reflective retrieval leaves no member access to find. It is refused by
   * name as a bounded unsupported form rather than followed — the ticket
   * permits a narrowly stated refusal, not a silent one.
   */
  it("refuses reflective retrieval of a write member", () => {
    const result = auditRogue(
      "export async function rogue() {",
      '  const remove = Reflect.get(ctx.db, "delete") as Writer["delete"];',
      "  await remove(movementId);",
      "}"
    );
    expect(result.unproven.length).toBeGreaterThanOrEqual(1);
    expect(
      result.unproven.some(
        (f) => f.verdict.verdict === "UNPROVEN" && f.verdict.form === "reflective-write-member-access"
      )
    ).toBe(true);
  });
});

/**
 * ⚠️ THE OTHER HALF OF THE REDESIGN. Widening detection is only safe if these
 * stay out — a guard that flags everything enforces nothing, and the fail-closed
 * rule is affordable exactly because it costs zero false positives here.
 */
describe("precision — the redesign must not start flagging these", () => {
  it("ignores containers that merely share the method names", () => {
    const result = auditRogue(
      "interface Cache { delete(key: string): void; get(key: string): unknown }",
      "declare const cache: Cache;",
      "declare const bag: Map<string, number>;",
      "declare const seen: Set<string>;",
      "declare const list: { insert(value: number): void };",
      "export function noise() {",
      '  cache.delete("receiptMovements");',
      '  bag.delete("k");',
      '  seen.delete("k");',
      "  list.insert(1);",
      "}"
    );
    expect(result.coverage.writeSites).toBe(0);
  });

  it("ignores a known non-write destructuring key on a writer", () => {
    const result = auditRogue(
      "export function rogue() {",
      "  const { get } = ctx.db;",
      "  void get;",
      "}"
    );
    expect(result.coverage.writeSites).toBe(0);
  });

  it("ignores destructuring a writer OFF something, rather than out of it", () => {
    const result = auditRogue(
      "export async function rogue() {",
      "  const { db } = ctx;",
      "  await db.delete(movementId);",
      "}"
    );
    expect(result.coverage.writeSites).toBe(1);
    expect(methodsOf(result.violations)).toEqual(["delete"]);
  });
});

/**
 * ⚠️ CONVEX SHIPS MORE THAN ONE WRITER SHAPE, AND THIS REPOSITORY'S IS ONLY ONE
 * OF THEM. Convex 1.42 also declares table-name-first `patch`/`replace`/`delete`
 * overloads and a table-scoped writer whose `insert(value)` names no table at
 * all. Hard-coding "argument 0 is the id" reported every one of those as
 * unprovable — fail-closed, but noisy enough to redden an unrelated pull request
 * for using valid Convex syntax. The id is found by its brand instead.
 */
describe("Convex's other writer shapes", () => {
  it("finds the id by its brand rather than by its position", () => {
    const result = auditRogue(
      "interface WriterWithTable {",
      "  insert<T extends string>(table: T, value: Record<string, unknown>): Promise<Id<T>>;",
      "  patch<T extends string>(table: T, id: Id<T>, value: Record<string, unknown>): Promise<void>;",
      "  delete<T extends string>(table: T, id: Id<T>): Promise<void>;",
      "}",
      "declare const scoped: WriterWithTable;",
      "export async function rogue() {",
      '  await scoped.delete("receiptMovements", movementId);',
      '  await scoped.patch("receiptMovements", movementId, { amountMinor: 1 });',
      "}"
    );
    expect(result.unproven).toEqual([]);
    expect(methodsOf(result.violations)).toEqual(["delete", "patch"]);
  });

  it("resolves a table-scoped insert from what it returns", () => {
    const result = auditRogue(
      "interface TableWriter<T extends string> {",
      "  insert(value: Record<string, unknown>): Promise<Id<T>>;",
      "}",
      'declare const scoped: TableWriter<"receiptMovements">;',
      "export async function rogue() {",
      "  await scoped.insert({ amountMinor: 1 });",
      "}"
    );
    expect(result.unproven).toEqual([]);
    expect(methodsOf(result.violations)).toEqual(["insert"]);
  });
});

describe("the failure report", () => {
  it("names the file, line, operation and table of every violation", () => {
    const result = auditRogue("export async function rogue() {", "  await ctx.db.delete(movementId);", "}");
    const message = formatAuthorityAuditFailure(result);
    expect(message).toContain("/virtual/rogue.ts:");
    expect(message).toContain("delete -> receiptMovements");
  });

  it("is empty when there is nothing to report", () => {
    expect(formatAuthorityAuditFailure(auditRogue("export {};"))).toBe("");
  });
});

/**
 * ⚠️ THE COMPARATOR IS LOAD-BEARING, SO IT GETS ITS OWN CONTROL.
 *
 * Every ordered result this guard produces is compared against another ordered
 * result. Sonar flagged the bare `.sort()` calls and suggested `localeCompare`;
 * `localeCompare` orders by the runner's ICU collation, which can differ
 * between a developer machine and a CI image, so the guard could disagree with
 * itself across environments. This asserts code-unit order specifically — the
 * expectation below is one `localeCompare` would not produce.
 */
describe("string ordering", () => {
  it("orders by code unit rather than by locale", () => {
    expect(["b", "a", "B", "A", "_x", "-y"].sort(compareStrings)).toEqual([
      "-y",
      "A",
      "B",
      "_x",
      "a",
      "b",
    ]);
    expect(compareStrings("same", "same")).toBe(0);
    expect(compareStrings("a", "b")).toBeLessThan(0);
    expect(compareStrings("b", "a")).toBeGreaterThan(0);
  });
});

/**
 * ⚠️ THE OWNER RULED TWO NARROW EXCEPTIONS AND NO OTHERS (`c17710`).
 *
 * `orgFinancialReset.ts` and `adminOrgs.ts` may DELETE an authority row during
 * a lifecycle sweep. Neither may create, patch or replace one, so a receipt
 * movement can never be EDITED from outside its owner — only destroyed with its
 * org. `customers.ts` was named explicitly as getting no exception at all.
 */
describe("lifecycle exceptions", () => {
  const RESET = "convex/orgFinancialReset.ts";
  const OWNED = "convex/accounting/receiptMovement.ts";
  const DECLARATION: readonly AuthorityDeclaration[] = [
    {
      table: "receiptMovements",
      ownerModule: OWNED,
      lifecycleExceptions: [{ module: RESET, operations: ["delete"] }],
    },
  ];

  const site = (
    file: string,
    method: DbWriteSite["method"],
    tables: string[]
  ): DbWriteSite => ({
    file,
    line: 1,
    method,
    resolution: { kind: "RESOLVED", tables },
    snippet: "ctx.db.delete(id)",
  });

  it("permits the excepted module its one operation on that exact table", () => {
    expect(classifyWriteSite(site(RESET, "delete", ["receiptMovements"]), DECLARATION)).toEqual({
      verdict: "AUTHORIZED",
      tables: ["receiptMovements"],
    });
  });

  it("refuses the excepted module any OTHER operation", () => {
    for (const method of ["insert", "patch", "replace"] as const) {
      expect(classifyWriteSite(site(RESET, method, ["receiptMovements"]), DECLARATION)).toEqual({
        verdict: "VIOLATION",
        tables: ["receiptMovements"],
      });
    }
  });

  it("refuses a module that holds no exception", () => {
    expect(
      classifyWriteSite(site("convex/customers.ts", "delete", ["receiptMovements"]), DECLARATION)
    ).toEqual({ verdict: "VIOLATION", tables: ["receiptMovements"] });
  });

  /**
   * ⚠️ THE FAIL-CLOSED READING OF "exact-table", AND THE ONE THE BINDING STEP
   * MUST RULE ON. A sweep deleting through `Id<TableNames>` resolves to every
   * table in the schema; that is not an exact-table write, so the exception
   * does not cover it. Both real sweep sites are of exactly this shape.
   */
  it("refuses an excepted delete whose id resolves to a SET of tables", () => {
    expect(
      classifyWriteSite(site(RESET, "delete", ["receiptMovements", "vehicles"]), DECLARATION)
    ).toEqual({ verdict: "VIOLATION", tables: ["receiptMovements"] });
  });

  it("refuses an excepted delete whose operation could not be read", () => {
    expect(classifyWriteSite(site(RESET, "unknown", ["receiptMovements"]), DECLARATION)).toEqual({
      verdict: "VIOLATION",
      tables: ["receiptMovements"],
    });
  });

  it("still lets the owner module do anything", () => {
    for (const method of DB_WRITE_METHODS) {
      expect(classifyWriteSite(site(OWNED, method, ["receiptMovements"]), DECLARATION)).toEqual({
        verdict: "AUTHORIZED",
        tables: ["receiptMovements"],
      });
    }
  });
});

describe("classification is decided on the worst table of a resolved set", () => {
  const site = (file: string, tables: string[]): DbWriteSite => ({
    file,
    line: 1,
    method: "delete",
    resolution: { kind: "RESOLVED", tables },
    snippet: "ctx.db.delete(id)",
  });

  it("flags a union that merely INCLUDES an authority table", () => {
    expect(classifyWriteSite(site("/virtual/rogue.ts", ["vehicles", "receiptMovements"]), FIXTURE_DECLARATION))
      .toEqual({ verdict: "VIOLATION", tables: ["receiptMovements"] });
  });

  it("clears the same union inside the owner module", () => {
    expect(classifyWriteSite(site(OWNER_MODULE, ["vehicles", "receiptMovements"]), FIXTURE_DECLARATION))
      .toEqual({ verdict: "AUTHORIZED", tables: ["receiptMovements"] });
  });

  it("clears a union with no authority table in it", () => {
    expect(classifyWriteSite(site("/virtual/rogue.ts", ["vehicles", "leads"]), FIXTURE_DECLARATION))
      .toEqual({ verdict: "UNRELATED" });
  });
});

/* ========================================================================= *
 * HALF TWO — THE REAL BACKEND
 * ========================================================================= */

describe("the analyzer against the real convex backend", () => {
  let backend: AnalyzerProgram;
  let sites: DbWriteSite[];

  beforeAll(() => {
    backend = createConvexAnalyzerProgram(REPO_ROOT);
    sites = collectDbWriteSites(backend);
  }, 180_000);

  /**
   * POSITIVE CONTROL — the analyzer really reached production source.
   *
   * Floors rather than exact counts: an unrelated pull request that adds a
   * `ctx.db.patch` must not fail this suite, but a refactor that silently
   * shrinks the analysed surface must. The exact-set control below is what
   * catches a partial detection failure that stays above the floor.
   */
  it("visits the whole backend and finds its writes", () => {
    expect(backend.analysed.length).toBeGreaterThanOrEqual(200);
    expect(sites.length).toBeGreaterThanOrEqual(800);
    const byMethod = { insert: 0, patch: 0, replace: 0, delete: 0, unknown: 0 };
    for (const site of sites) byMethod[site.method] += 1;
    expect(byMethod.insert).toBeGreaterThanOrEqual(250);
    expect(byMethod.patch).toBeGreaterThanOrEqual(450);
    expect(byMethod.delete).toBeGreaterThanOrEqual(50);
  }, 60_000);

  /**
   * ⚠️ REGRESSION CONTROL FOR THE `convex/`-ONLY FILE FILTER.
   *
   * The analysed set used to require the `convex/` prefix, which meant a helper
   * in `lib/` taking a `MutationCtx` and calling `ctx.db.delete(id)` was
   * compiled into this program, typechecked clean, and was invisible to the
   * guard. Reproduced against the real repository with a positive control
   * before being fixed.
   *
   * This can only be asserted here. A virtual fixture program has no directory
   * boundary at all, so no fixture — present or future — can express this
   * failure mode.
   */
  it("analyses every repository module in the program, not only convex/", () => {
    const names = backend.analysed.map(([, name]) => name);
    expect(names.some((name) => name.startsWith("convex/"))).toBe(true);
    expect(names.some((name) => name.startsWith("lib/"))).toBe(true);
    // The named exclusions, each a decision rather than an accident.
    expect(names.some((name) => name.includes("/_generated/"))).toBe(false);
    expect(names.some((name) => name.endsWith(".test.ts"))).toBe(false);
    expect(names.some((name) => name.startsWith("test-utils/"))).toBe(false);
    expect(names.some((name) => name.includes("node_modules"))).toBe(false);
  }, 60_000);

  /**
   * ⚠️ THE CONTROL THAT CATCHES THE QUIET FAILURE.
   *
   * A purely syntactic pass over the same files finds every `<expr>.db.<m>(`
   * call with no type information at all. If the type-aware pass ever stops
   * recognising a receiver, the two sets diverge and this fails — where a
   * count-based check would not, and where every fixture test would still pass.
   *
   * It is self-updating, so it does not churn on unrelated pull requests.
   *
   * ⚠️ CONTAINMENT, NOT EQUALITY, AND THE DIFFERENCE IS A REAL DEFECT I SHIPPED.
   * The type-aware pass legitimately sees MORE than a text scan can — Codex
   * demonstrated `const writer = ctx.db satisfies Writer; writer.delete(id)`,
   * which the type-aware pass resolves and the syntactic pass cannot see at
   * all. Under equality, CORRECT analyzer behaviour would have failed CI on an
   * unrelated pull request. Containment still kills a total detection failure:
   * 848 syntactic sites against 0 type-aware ones is not a subset.
   */
  it("sees every call site a type-free syntactic pass can see", () => {
    // Sorted with the guard's own comparator on both sides: the property under
    // test is set equality, and an ordering difference must not be able to
    // masquerade as one.
    // Escape sites are references, not calls, so they are excluded from a
    // comparison against a detector that only looks at call sites. There are
    // none in the backend today; the filter states the property precisely
    // rather than relying on that staying true.
    const typeAware = new Set(sites.map((s) => `${s.file}:${s.line}:${s.method}`));
    const unseen = syntacticDbWriteCallSites(backend).filter((site) => !typeAware.has(site));
    expect(unseen).toEqual([]);
  }, 60_000);

  /**
   * The measured basis for the fail-closed policy, asserted rather than
   * remembered. If a genuinely unreadable write ever lands, this fails and the
   * guard is amended deliberately — there is no allowlist to quietly grow.
   */
  it("proves the target table of every write in the backend", () => {
    const unresolved = sites.filter((s) => s.resolution.kind !== "RESOLVED");
    expect(unresolved.map((s) => `${s.file}:${s.line} ${s.method}`)).toEqual([]);
  }, 60_000);

  /**
   * ⚠️ THE HONESTY RATCHET FOR `replace`.
   *
   * The guard's header states that `ctx.db.replace` has zero production call
   * sites and that its detection is therefore fixture-proven only. That is a
   * claim about the repository, so it is pinned: the first real `replace` makes
   * this fail, and whoever adds it updates the claim instead of leaving a
   * stale one behind.
   */
  it("has no production `replace` call site, exactly as the guard's header claims", () => {
    expect(sites.filter((s) => s.method === "replace")).toEqual([]);
  }, 60_000);

  /**
   * ⚠️ POSITIVE CONTROL — REAL CONVEX TYPES, NOT THE FIXTURES' HAND-ROLLED ONE.
   *
   * The fixtures declare their own `Id<T> = string & { __tableName: T }`. This
   * runs the same classification against the real `GenericId` from
   * `convex/values` flowing through the generated data model, using a
   * TEST-LOCAL declaration over an existing table. Nothing is declared in the
   * shipped guard by this test, and no production behaviour is asserted about
   * `memberships` — it is a carrier for the mechanism.
   *
   * `delete` is checked on both sides of the boundary on purpose: that is the
   * operation the source-text approach could not express at all.
   */
  it("classifies real backend deletes against a real table's owner module", () => {
    const declaration: readonly AuthorityDeclaration[] = [
      { table: "memberships", ownerModule: "convex/memberships.ts" },
    ];
    const result = auditAuthorityWrites(backend, declaration);

    const authorizedDeletes = result.authorized.filter((f) => f.site.method === "delete");
    expect(authorizedDeletes.length).toBeGreaterThanOrEqual(1);
    expect(authorizedDeletes.every((f) => f.site.file === "convex/memberships.ts")).toBe(true);

    const violatingDeletes = result.violations.filter((f) => f.site.method === "delete");
    expect(violatingDeletes.length).toBeGreaterThanOrEqual(1);
    expect(violatingDeletes.some((f) => f.site.file === "convex/adminUsers.ts")).toBe(true);
    expect(violatingDeletes.every((f) => f.site.file !== "convex/memberships.ts")).toBe(true);

    expect(result.violations.some((f) => f.site.method === "insert")).toBe(true);
    expect(result.violations.some((f) => f.site.method === "patch")).toBe(true);
  }, 60_000);

  /**
   * ⚠️ THE ONE THING THIS SUITE MUST NOT BE READ AS SAYING.
   *
   * The shipped declaration is empty because SCRUM-218-C has not frozen its
   * table names. Everything above proves the mechanism; this proves that the
   * mechanism is not yet pointed at anything, so a green run is not evidence
   * that receipt authority is enforced.
   *
   * When 218-C freezes its names this test changes with the declaration, and
   * changing it is the deliberate act of binding the guard.
   */
  /**
   * ⚠️ THE ONE THING THIS SUITE MUST NOT BE READ AS SAYING.
   *
   * The declaration is real and fixed by owner ruling `c17710`, but the three
   * tables and their owner module are created by SCRUM-218-C and do not exist
   * on this tooling-only branch. A declaration naming absent modules produces no
   * violations for the same reason an empty one does, and the two are
   * indistinguishable from an exit code — so the binding report says which.
   *
   * When 218-C's corrected successor lands, this expectation changes in a
   * temporary integration worktree, and changing it is the deliberate act of
   * binding the guard.
   */
  it("declares real tables that are not in this program yet, and says so", () => {
    expect(RECEIPT_AUTHORITY_DECLARATION.map((entry) => entry.table)).toEqual([
      "receiptMovements",
      "receiptRetainedPositions",
      "receiptApplications",
    ]);

    const binding = describeBinding(backend);
    expect(binding.status).toBe("PENDING_218C_INTEGRATION");
    expect(binding.ownerModulesMissing).toEqual(["convex/accounting/receiptMovement.ts"]);
    expect(binding.ownerModulesPresent).toEqual([]);
    expect(binding.declaredTablesWritten).toEqual([]);

    const result = auditAuthorityWrites(backend);
    expect(result.violations).toEqual([]);
    expect(result.authorized).toEqual([]);
    expect(result.coverage.writeSites).toBeGreaterThanOrEqual(800);
  }, 60_000);

  /**
   * ⚠️ RECORDED FOR THE BINDING STEP, WITH THE EXACT SITES.
   *
   * These six writes resolve to a SET of tables because their id is a generic
   * `Id<TableNames>` or a union. Under the fail-closed reading of "exact-table
   * DELETE-only", a set is not an exact table, so the `orgFinancialReset` and
   * `adminOrgs` exceptions will NOT cover their sweep sites — and `adminData`
   * and `customers` have no exception at all. Every one of these becomes a
   * violation the moment the declaration resolves.
   *
   * That is the single-owner property working as specified. Whether the sweeps
   * should be covered anyway is an owner decision at binding time, not one this
   * analyzer takes quietly.
   */
  it("pins the generic sweeps that will be reported when the declaration binds", () => {
    const grouped: Record<string, number> = {};
    for (const site of sites) {
      if (site.resolution.kind !== "RESOLVED" || site.resolution.tables.length < 2) continue;
      const key = `${site.file}::${site.method}`;
      grouped[key] = (grouped[key] ?? 0) + 1;
    }
    expect(grouped).toEqual({
      "convex/adminData.ts::patch": 2,
      "convex/adminData.ts::delete": 1,
      "convex/adminOrgs.ts::delete": 1,
      "convex/customers.ts::patch": 1,
      "convex/orgFinancialReset.ts::delete": 1,
    });
  }, 60_000);

  /**
   * `ctx.storage.delete(id)` takes an `Id<"_storage">`, so the redesigned
   * detector resolves it like any other branded delete. Five such calls exist.
   * Pinned because it widens what "a write site" means, and a surprise in the
   * count should be read, not absorbed.
   */
  it("resolves storage deletes too, because they are addressed by an Id", () => {
    const storage = sites.filter(
      (site) => site.resolution.kind === "RESOLVED" && site.resolution.tables.includes("_storage")
    );
    expect(storage.length).toBeGreaterThanOrEqual(5);
    expect(storage.every((site) => site.method === "delete")).toBe(true);
  }, 60_000);

  /** What CI actually asserts today: fail-closed holds across the backend. */
  it("passes the shipped audit", () => {
    const result = auditAuthorityWrites(backend);
    expect(formatAuthorityAuditFailure(result)).toBe("");
  }, 60_000);
});
