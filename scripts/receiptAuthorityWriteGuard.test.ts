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
 * `RECEIPT_AUTHORITY_DECLARATION` names three tables and their owner, but those
 * tables DO NOT EXIST on this branch — SCRUM-218-C creates them. The binding
 * report therefore reads `PENDING_218C_INTEGRATION`, and a green run proves the
 * mechanism works and that every database write in the backend has a statically
 * provable target table. It does **not** prove receipt authority is enforced,
 * because there is nothing here to enforce it against. The binding test below
 * asserts that state explicitly, so the distinction cannot be lost by reading
 * only the exit code.
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
 * ⚠️ THE FIXTURES IMPORT THE REAL `convex` TYPES. THIS IS NOT OPTIONAL ANY MORE.
 *
 * The previous suite reproduced a Convex-shaped `Writer` and `Id` locally, so
 * that a fixture program needed no module resolution. Under the architecture
 * ruled in `SCRUM-238 c17726` that would prove the OPPOSITE of what it claims:
 * recognition is by DECLARATION SITE, and a locally declared look-alike writer
 * is correctly refused. Fixtures built that way would exercise no recognition
 * path at all and every one of them would pass while proving nothing.
 *
 * So `ctx` is a real `GenericMutationCtx`, `ctx.db` is a real
 * `GenericDatabaseWriter`, and both halves of this suite now ask the analyzer
 * exactly the same question — which is what the earlier mutation battery said
 * to insist on, after a mutant survived only because fixtures and real source
 * took different code paths.
 */
const PREAMBLE = [
  'import type { GenericDatabaseWriter, GenericMutationCtx } from "convex/server";',
  'import type { GenericId } from "convex/values";',
  "type Fields<D> = {",
  "  document: D;",
  "  fieldPaths: string;",
  "  indexes: Record<string, string[]>;",
  "  searchIndexes: Record<string, never>;",
  "  vectorIndexes: Record<string, never>;",
  "};",
  "type FixtureDataModel = {",
  '  receiptMovements: Fields<{ _id: GenericId<"receiptMovements">; _creationTime: number; amountMinor: number }>;',
  '  receiptApplications: Fields<{ _id: GenericId<"receiptApplications">; _creationTime: number; amountMinor: number }>;',
  '  vehicles: Fields<{ _id: GenericId<"vehicles">; _creationTime: number; amountMinor: number }>;',
  "};",
  "type Id<TableName extends string> = GenericId<TableName>;",
  "type Writer = GenericDatabaseWriter<FixtureDataModel>;",
  "type Ctx = GenericMutationCtx<FixtureDataModel>;",
  "interface Doc<TableName extends string> { _id: Id<TableName>; amountMinor: number }",
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
  return auditAuthorityWrites(createVirtualAnalyzerProgram(files, REPO_ROOT), declaration);
}

/** One rogue module holding `body`, plus the (empty) declared owner module. */
function auditRogue(...body: string[]): AuthorityAuditResult {
  return auditFixture({
    "/virtual/rogue.ts": fixture(...body),
    [OWNER_MODULE]: fixture("export {};"),
  });
}

/**
 * ⚠️ THE TWO REPORTS ARE SEPARATED HERE ON PURPOSE.
 *
 * The analyzer answers two different questions — "is this call a Convex
 * write?" and "did a root-derived writer just leave a convex-declared type?"
 * — and one construct can legitimately answer both. Folding them into a
 * single count would let a test pass because the OTHER report happened to fire,
 * so every assertion below names which one it means.
 */
const isErasure = (finding: SiteFinding): boolean =>
  finding.verdict.verdict === "UNPROVEN" && finding.verdict.form === "writer-provenance-erased";

function callFindings(findings: readonly SiteFinding[]): SiteFinding[] {
  return findings.filter((finding) => !isErasure(finding));
}

function erasureFindings(findings: readonly SiteFinding[]): SiteFinding[] {
  return findings.filter(isErasure);
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
    const analyzer = createVirtualAnalyzerProgram(files, REPO_ROOT);
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
    expect(callFindings(result.unproven)).toHaveLength(1);
    expect(callFindings(result.unproven)[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "receiver-type-not-statically-known",
    });
    // `as any` is also a conversion OUT of a convex-declared type.
    expect(erasureFindings(result.unproven)).toHaveLength(1);
  });

  /**
   * ⚠️ AN `any` ANNOTATION DOES NOT BREAK ROOT TRACKING, AND THAT IS THE POINT.
   * The alias is followed through its initializer, so the write still RESOLVES
   * to its table and is convicted rather than merely refused — while the
   * annotation itself is separately reported as an erasure.
   */
  it("refuses a write through an `any`-typed writer binding", () => {
    const result = auditRogue(
      "export async function rogue() {",
      "  const writer: any = ctx.db;",
      '  await writer.insert("receiptMovements", { amountMinor: 1 });',
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["insert"]);
    expect(erasureFindings(result.unproven)).toHaveLength(1);
    expect(callFindings(result.unproven)).toEqual([]);
  });

  /**
   * The precision half of the same fix: a statically known method name that is
   * not one of the four clears the call whatever its receiver is. Without this
   * the fail-closed rule would flag every `(x as any).get(…)` in the codebase.
   */
  it("does not refuse the READ ITSELF through an erased receiver", () => {
    const result = auditRogue(
      "export async function rogue() {",
      "  await (ctx.db as any).get(movementId);",
      '  await (ctx.db as any)["get"](movementId);',
      "}"
    );
    // Neither `get` is reported: a statically known non-write name is cleared
    // whatever its receiver is. The two CASTS remain erasures, because
    // `ctx.db as any` destroys the proof regardless of what is called next.
    expect(callFindings(result.unproven)).toEqual([]);
    expect(result.violations).toEqual([]);
    expect(erasureFindings(result.unproven)).toHaveLength(2);
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
    // Destructuring is a FOLLOWED boundary, inspected key by key, so it is not
    // reported as an erasure as well. One construct, one finding.
    expect(erasureFindings(result.unproven)).toEqual([]);
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
    expect(callFindings(result.unproven).length).toBeGreaterThanOrEqual(3);
    // `Reflect.apply` is caught by the reflection report rather than the member
    // escape, so both forms are legitimate here — what matters is that no
    // spelling leaves without a finding.
    expect(
      callFindings(result.unproven).every(
        (f) =>
          f.verdict.verdict === "UNPROVEN" &&
          (f.verdict.form === "write-method-reference-escapes" ||
            f.verdict.form === "reflective-write-member-access")
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
  /**
   * ⚠️ THE FIXTURE USES `GenericDataModel` BECAUSE THE REAL TYPES FORBID THE
   * OBVIOUS SPELLING. Against a concrete data model Convex constrains the table
   * argument to a literal union, so a runtime-computed name does not compile at
   * all — the template-literal version of this fixture carried a real type
   * error while still appearing to pass. A helper written over
   * `GenericDataModel` has `TableNamesInDataModel = string`, which is how this
   * form is genuinely reachable in a repository.
   */
  it("refuses an insert whose table name is computed at runtime", () => {
    const result = auditRogue(
      'import type { GenericDataModel, GenericDatabaseWriter as GDW } from "convex/server";',
      "declare const generic: GDW<GenericDataModel>;",
      "declare const suffix: string;",
      "export async function rogue() {",
      "  await generic.insert(suffix, { amountMinor: 1 });",
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

  /**
   * ⚠️ REFUSED, NOT CONVICTED — AND THE DIFFERENCE IS THE ARCHITECTURE.
   *
   * `DeleteOnly` is declared in the fixture, so nothing proves it IS Convex's
   * writer. The previous architecture answered that question from the member's
   * SHAPE, called it a violation, and paid for it by reporting
   * `new Set<Id<"receiptMovements">>().delete(id)` as an authority violation
   * too. Shape may now raise suspicion and nothing more: the site is UNPROVEN,
   * which still fails the guard, without asserting something unproven.
   */
  it("refuses a write through a view that exposes only one of the four", () => {
    const result = auditRogue(
      "interface DeleteOnly { delete<T extends string>(id: Id<T>): Promise<void> }",
      "declare const view: DeleteOnly;",
      "export async function rogue() {",
      "  await view.delete(movementId);",
      "}"
    );
    expect(result.coverage.writeSites).toBe(1);
    expect(result.violations).toEqual([]);
    expect(result.unproven[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "writer-provenance-not-established",
    });
  });

  it("refuses a write through a union receiver it cannot vouch for", () => {
    const result = auditRogue(
      'interface DeleteOnly { delete(id: Id<"receiptMovements">): Promise<void> }',
      "declare const either: Writer | DeleteOnly;",
      "export async function rogue() {",
      "  await either.delete(movementId);",
      "}"
    );
    expect(result.coverage.writeSites).toBe(1);
    expect(result.unproven[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "writer-provenance-not-established",
    });
  });

  /**
   * The same union shape, but every constituent is Convex's own type — so it
   * RESOLVES rather than being refused. Without this control the test above
   * would pass just as well against an analyzer that refused every union.
   */
  it("still resolves a union whose constituents are all Convex's own", () => {
    const result = auditRogue(
      'declare const either: Writer | Pick<Writer, "delete">;',
      "export async function rogue() {",
      "  await either.delete(movementId);",
      "}"
    );
    expect(result.unproven).toEqual([]);
    expect(methodsOf(result.violations)).toEqual(["delete"]);
    expect(tablesOf(result.violations[0].site)).toEqual(["receiptMovements"]);
  });

  it("refuses a write method taken off an erased receiver", () => {
    const result = auditRogue(
      "export async function rogue() {",
      "  const remove = (ctx.db as any).delete;",
      "  await remove(movementId);",
      "}"
    );
    expect(callFindings(result.unproven)).toHaveLength(1);
    expect(callFindings(result.unproven)[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "receiver-type-not-statically-known",
    });
    expect(erasureFindings(result.unproven)).toHaveLength(1);
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
  /**
   * Convex's OTHER writer, `db.table(name)`, reached through the real
   * `GenericDatabaseWriterWithTable` rather than a hand-written imitation of
   * it. `patch` and `delete` take the id first here as well, but `insert(value)`
   * names no table anywhere in the call.
   */
  it("resolves patch and delete through Convex's table-scoped writer", () => {
    const result = auditRogue(
      'import type { GenericDatabaseWriterWithTable } from "convex/server";',
      "declare const scoped: GenericDatabaseWriterWithTable<FixtureDataModel>;",
      "export async function rogue() {",
      '  await scoped.table("receiptMovements").delete(movementId);',
      '  await scoped.table("receiptMovements").patch(movementId, { amountMinor: 1 });',
      "}"
    );
    expect(result.unproven).toEqual([]);
    expect(methodsOf(result.violations)).toEqual(["delete", "patch"]);
  });

  it("resolves a table-scoped insert from what it returns", () => {
    const result = auditRogue(
      'import type { GenericDatabaseWriterWithTable } from "convex/server";',
      "declare const scoped: GenericDatabaseWriterWithTable<FixtureDataModel>;",
      "export async function rogue() {",
      '  await scoped.table("receiptMovements").insert({ amountMinor: 1 });',
      "}"
    );
    expect(result.unproven).toEqual([]);
    expect(methodsOf(result.violations)).toEqual(["insert"]);
    expect(tablesOf(result.violations[0].site)).toEqual(["receiptMovements"]);
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
   * ⚠️ RULED IN `SCRUM-238 c17726`, AND IT REVERSES THE PREVIOUS BEHAVIOUR.
   *
   * A lifecycle sweep deletes through a generic `Id<TableNames>` that resolves
   * to EVERY table in the schema. The earlier guard required
   * `resolvedTables.length === 1` and so refused those sweeps — which was
   * fail-closed and still wrong, because those sweeps are the only non-owner
   * writes to these tables, and the granted exception therefore covered
   * nothing at all.
   *
   * Permission is `table + module + operation`. The set is intersected with the
   * declaration and each authority table in it is judged on its own.
   */
  it("permits an excepted delete whose id resolves to a SET of tables", () => {
    expect(
      classifyWriteSite(site(RESET, "delete", ["receiptMovements", "vehicles"]), DECLARATION)
    ).toEqual({ verdict: "AUTHORIZED", tables: ["receiptMovements"] });
  });

  /**
   * ⚠️ THE NEGATIVE CONTROL THAT KEEPS THE ABOVE FROM BEING A WILDCARD.
   *
   * The identical generic sweep, against a FOURTH declared authority table
   * whose declaration grants this module nothing. If the exception had become
   * module-wide, this would pass silently — which is precisely the outcome the
   * ruling forbids.
   */
  it("refuses that same sweep for a declared table with no exception of its own", () => {
    const withFourth: readonly AuthorityDeclaration[] = [
      ...DECLARATION,
      { table: "receiptRetainedPositions", ownerModule: OWNED },
    ];
    expect(
      classifyWriteSite(
        site(RESET, "delete", ["receiptMovements", "receiptRetainedPositions", "vehicles"]),
        withFourth
      )
    ).toEqual({ verdict: "VIOLATION", tables: ["receiptRetainedPositions"] });
  });

  /** The grant is per operation as well as per table: a sweep may not PATCH. */
  it("refuses a generic PATCH from a module granted only DELETE", () => {
    expect(
      classifyWriteSite(site(RESET, "patch", ["receiptMovements", "vehicles"]), DECLARATION)
    ).toEqual({ verdict: "VIOLATION", tables: ["receiptMovements"] });
  });

  /** `convex/customers.ts` holds no exception, generic or otherwise. */
  it("refuses a generic PATCH from the customer-merge module", () => {
    expect(
      classifyWriteSite(
        site("convex/customers.ts", "patch", ["customers", "receiptMovements", "vehicles"]),
        DECLARATION
      )
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

describe("the c17717 family — the three findings that ended the shape architecture", () => {
  /**
   * ⚠️ A — STRUCTURAL WIDENING. NO CAST, NO DIAGNOSTIC, NO SITE.
   *
   * `WeakDelete` is a repository interface, so the later call is not
   * recognisable as Convex's by any honest test — the previous architecture
   * reported NOTHING here. The conversion is where the proof stops, so the
   * conversion is what is refused.
   */
  it("A — reports plain structural widening at the conversion", () => {
    const result = auditRogue(
      "interface WeakDelete { delete(id: string): Promise<void> }",
      "export async function rogue() {",
      "  const writer: WeakDelete = ctx.db;",
      "  await writer.delete(movementId);",
      "}"
    );
    expect(erasureFindings(result.unproven)).toHaveLength(1);
    expect(erasureFindings(result.unproven)[0].site.file).toBe("/virtual/rogue.ts");
  });

  it("A — reports the same erasure through a parameter, a return, a property and a cast", () => {
    const result = auditRogue(
      "interface WeakDelete { delete(id: string): Promise<void> }",
      "declare function take(writer: WeakDelete): void;",
      "export function viaParameter() { take(ctx.db); }",
      "export function viaReturn(): WeakDelete { return ctx.db; }",
      "export function viaProperty(): { writer: WeakDelete } { return { writer: ctx.db }; }",
      "export function viaCast() { return ctx.db as WeakDelete; }"
    );
    expect(erasureFindings(result.unproven)).toHaveLength(4);
  });

  /**
   * ⚠️ THE CONTROL THAT STOPS THE ABOVE PASSING FOR THE WRONG REASON.
   *
   * The same four flows, into Convex's OWN writer type, must all stay silent.
   * Without this, an analyzer that reported every use of `ctx.db` would satisfy
   * the erasure tests perfectly — and would redden every mutation in the
   * repository.
   */
  it("A — control: the same four flows into Convex's own type are not erasures", () => {
    const result = auditRogue(
      "declare function take(writer: Writer): void;",
      "export function viaParameter() { take(ctx.db); }",
      "export function viaReturn(): Writer { return ctx.db; }",
      "export function viaProperty(): { writer: Writer } { return { writer: ctx.db }; }",
      "export function viaCast() { return ctx.db as Writer; }"
    );
    expect(result.unproven).toEqual([]);
  });

  /**
   * ⚠️ B — A MEMBER BEHIND AN INDEX SIGNATURE. `getPropertyOfType` returns no
   * symbol for it, and the previous architecture read "no symbol" as "not a
   * writer" and dropped the call entirely.
   */
  it("B — sees a write member reached through an index signature", () => {
    const result = auditRogue(
      'declare const bag: Record<string, Writer["delete"]>;',
      "export async function rogue() {",
      '  await bag["delete"](movementId);',
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["delete"]);
    expect(tablesOf(result.violations[0].site)).toEqual(["receiptMovements"]);
  });

  /**
   * ⚠️ C — THE FALSE POSITIVE, AND THE ONE THAT CHANGED THE ARGUMENT.
   *
   * `Set<T>.delete(value: T)` is a member named `delete` whose parameter
   * carries the `Id` brand, so it satisfied the previous recognition rule
   * exactly. The moment 218-C's tables were declared, an ordinary in-memory
   * `Set` would have failed CI as an unauthorized authority write. It clears
   * here positively, because `Set.prototype.delete` is declared in a TypeScript
   * standard library — not because anything about its shape was re-examined.
   */
  it("C — positively clears an ordinary Set of authority ids", () => {
    const result = auditRogue(
      "export function rogue() {",
      '  const seen = new Set<Id<"receiptMovements">>();',
      "  seen.delete(movementId);",
      "}"
    );
    expect(result.coverage.writeSites).toBe(0);
  });

  it("C — positively clears an ordinary Map keyed by authority ids", () => {
    const result = auditRogue(
      "export function rogue() {",
      '  const seen = new Map<Id<"receiptMovements">, number>();',
      "  seen.delete(movementId);",
      "}"
    );
    expect(result.coverage.writeSites).toBe(0);
  });

  /**
   * ⚠️ THE CONTROL WITHOUT WHICH THE TWO ABOVE PROVE NOTHING. An analyzer that
   * had simply stopped working would clear the `Set` too. A real write in the
   * same module, in the same run, must still be convicted.
   */
  it("C — control: a real write in the same module is still convicted", () => {
    const result = auditRogue(
      "export async function rogue() {",
      '  const seen = new Set<Id<"receiptMovements">>();',
      "  seen.delete(movementId);",
      "  await ctx.db.delete(movementId);",
      "}"
    );
    expect(result.coverage.writeSites).toBe(1);
    expect(methodsOf(result.violations)).toEqual(["delete"]);
  });

  /**
   * ⚠️ THE EVASION THAT THE ERASURE REPORT EXISTS TO CLOSE.
   *
   * Laundering a real writer into a builtin type would otherwise be cleared by
   * the very declaration test that fixes C: at the call, this IS
   * `Set.prototype.delete`. It is refused at the double cast instead, which is
   * the only place the truth is still visible.
   */
  it("C — refuses laundering a writer into a builtin with `as unknown as`", () => {
    const result = auditRogue(
      "export function rogue() {",
      '  const laundered = ctx.db as unknown as Set<Id<"receiptMovements">>;',
      "  laundered.delete(movementId);",
      "}"
    );
    expect(erasureFindings(result.unproven)).toHaveLength(1);
  });
});

describe("laundering — a writer moved through a path root tracking does not follow", () => {
  /**
   * ⚠️ FOUND BY ATTACKING MY OWN ARCHITECTURE, BEFORE FREEZING A SHA.
   *
   * Each of these widens a real writer into `{ delete(id: string) }` — a member
   * whose signature mentions no `Id`, so member suspicion clears it — through an
   * intermediate that root tracking does not follow. All four produced ZERO
   * sites: not a violation, not even unproven. The header claimed the erasure
   * report made clearing repository-declared methods sound, and that claim was
   * false for exactly these four shapes.
   *
   * They are refused now because the CALL still hands a branded `Id` to
   * something named `delete`. UNPROVEN rather than VIOLATION: handing an id to
   * a `delete` is suspicious, not proof.
   */
  const WEAK = "interface WeakDelete { delete(id: string): Promise<void> }";

  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["an array element", ["  const holder = [ctx.db];", "  const w: WeakDelete = holder[0];"]],
    ["an object property", ["  const holder = { inner: ctx.db };", "  const w: WeakDelete = holder.inner;"]],
    ["a let binding", ["  let held = ctx.db;", "  const w: WeakDelete = held;"]],
  ];

  for (const [label, lines] of cases) {
    it(`refuses a writer laundered through ${label}`, () => {
      const result = auditRogue(
        WEAK,
        "export async function rogue() {",
        ...lines,
        "  await w.delete(movementId);",
        "}"
      );
      expect(callFindings(result.unproven)).toHaveLength(1);
      expect(callFindings(result.unproven)[0].verdict).toEqual({
        verdict: "UNPROVEN",
        form: "writer-provenance-not-established",
      });
    });
  }

  it("refuses a writer laundered through a function whose return type is inferred", () => {
    const result = auditRogue(
      WEAK,
      "function give() { return ctx.db; }",
      "export async function rogue() {",
      "  const w: WeakDelete = give();",
      "  await w.delete(movementId);",
      "}"
    );
    expect(callFindings(result.unproven)).toHaveLength(1);
    expect(callFindings(result.unproven)[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "writer-provenance-not-established",
    });
  });

  /**
   * ⚠️ THE CONTROL THAT KEEPS ARGUMENT SUSPICION FROM BECOMING A BLANKET.
   *
   * An ordinary `Set` is handed the very same branded id, by the very same
   * method name, and must still clear — because `Set.prototype.delete` is
   * declared in a TypeScript standard library and that test runs FIRST. If
   * argument suspicion ever moved above the declaration tests, this fails.
   */
  it("control: argument suspicion does not resurrect the Set false positive", () => {
    const result = auditRogue(
      "export function rogue() {",
      '  const seen = new Set<Id<"receiptMovements">>();',
      "  seen.delete(movementId);",
      "}"
    );
    expect(result.coverage.writeSites).toBe(0);
  });

  /**
   * A repository method named `delete` that is handed something which is NOT a
   * Convex id stays cleared — otherwise every cache and every `Map`-like helper
   * in the repository would redden CI.
   */
  it("control: a repository delete handed a plain string is still cleared", () => {
    const result = auditRogue(
      "interface Cache { delete(key: string): void }",
      "declare const cache: Cache;",
      "export function rogue() {",
      '  cache.delete("some-key");',
      "}"
    );
    expect(result.coverage.writeSites).toBe(0);
  });
});

describe("provenance, positively", () => {
  /**
   * ⚠️ THIS SHAPE IS NOT HYPOTHETICAL — IT IS ELEVEN REAL WRITES.
   *
   * `convex/aggregates.ts` and `convex/utils/materialization.ts` declare helper
   * parameters as `ctx: { db: GenericDatabaseWriter<DataModel> }` and write
   * through them. There is no `ctx.db` ROOT anywhere in those functions, so
   * root provenance alone would miss every one of them. They are recognised
   * because the member resolves into the convex package.
   */
  it("recognises a write through a helper parameter with no ctx root in sight", () => {
    const result = auditRogue(
      "export async function helper(local: { db: Writer }) {",
      "  await local.db.delete(movementId);",
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["delete"]);
    expect(result.unproven).toEqual([]);
  });

  it("follows a const alias of a root", () => {
    const result = auditRogue(
      "export async function rogue() {",
      "  const db = ctx.db;",
      "  await db.delete(movementId);",
      "}"
    );
    expect(methodsOf(result.violations)).toEqual(["delete"]);
    expect(result.unproven).toEqual([]);
  });

  /**
   * `"insert" in ctx.db` occurs in `convex/utils/tenancy.ts`. Neither operand
   * position can reach a member, so both are cleared positively rather than
   * refused — which is what keeps the erasure report affordable on real source.
   */
  it("clears the two uses of a root that cannot reach a member", () => {
    const result = auditRogue(
      "export function rogue() {",
      '  const present = "insert" in ctx.db;',
      "  const kind = typeof ctx.db;",
      "  void present;",
      "  void kind;",
      "}"
    );
    expect(result.coverage.writeSites).toBe(0);
  });

  /**
   * ⚠️ THE ONE CASE ARGUMENT SUSPICION CANNOT SEE, AND WHY THE MEMBER TEST STAYS.
   *
   * A table-scoped `insert(value)` names no table and takes no id — its only
   * Convex brand is in its RETURN type. Argument suspicion finds nothing here,
   * so without the member test this call would be cleared in silence. Found by
   * a surviving mutant: removing member suspicion killed no test, which meant a
   * gap in the suite rather than dead code.
   */
  it("refuses an unvouched scoped insert whose only brand is its return type", () => {
    const result = auditRogue(
      'interface ScopedInsert { insert(value: { amountMinor: number }): Promise<Id<"receiptMovements">> }',
      "declare const scoped: ScopedInsert;",
      "export async function rogue() {",
      "  await scoped.insert({ amountMinor: 1 });",
      "}"
    );
    expect(result.violations).toEqual([]);
    expect(result.unproven).toHaveLength(1);
    expect(result.unproven[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "writer-provenance-not-established",
    });
  });

  /**
   * ⚠️ A LOOK-ALIKE DECLARED IN THE REPOSITORY IS NOT PROMOTED TO A ROOT.
   * It is not cleared either — it is refused, which is the ruling's rule for
   * anything whose provenance cannot be established.
   */
  it("does not promote a repository look-alike to a writer root", () => {
    const result = auditRogue(
      "interface FakeWriter { delete<T extends string>(id: Id<T>): Promise<void> }",
      "declare const fake: { db: FakeWriter };",
      "export async function rogue() {",
      "  await fake.db.delete(movementId);",
      "}"
    );
    expect(result.violations).toEqual([]);
    expect(result.unproven[0].verdict).toEqual({
      verdict: "UNPROVEN",
      form: "writer-provenance-not-established",
    });
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
   * 853 syntactic sites against 0 type-aware ones is not a subset.
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
   * ⚠️ THE MEASURED BASIS FOR CLEARING NON-CONVEX METHODS AT THE CALL.
   *
   * The analyzer clears a call whose method is declared outside the convex
   * package, and that is sound only because a root-derived writer cannot reach
   * such a method without passing a conversion this report refuses. The cost of
   * that report on real source is therefore load-bearing evidence, not trivia:
   * every one of the 2746 root uses in the backend is either a direct call, a
   * `const` alias, or one of the two positively harmless forms.
   *
   * The single interesting case is `convex/aggregates.ts`, which returns
   * `{ db: wrapped.db }` from a module-private helper. It is NOT an erasure,
   * because the property it flows into is declared as Convex's own
   * `GenericDatabaseWriter` — and the writes made through it downstream are
   * recognised by the member-declaration rule. If either half of that stopped
   * being true, this would fail.
   */
  it("finds no point in the backend where writer provenance is erased", () => {
    const erased = sites.filter(
      (site) =>
        site.resolution.kind === "UNPROVEN" && site.resolution.form === "writer-provenance-erased"
    );
    expect(erased.map((site) => `${site.file}:${site.line}`)).toEqual([]);
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
   * ⚠️ POSITIVE CONTROL — THE REAL GENERATED DATA MODEL.
   *
   * The fixtures import the real `GenericId` and the real writer, but they
   * declare their own small data model. This runs the same classification
   * against `GenericId` flowing through the GENERATED data model, using a
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
