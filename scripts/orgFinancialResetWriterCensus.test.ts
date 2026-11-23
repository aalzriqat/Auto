import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { RESET_TABLES_FOR_TEST } from "../convex/orgFinancialReset";
import { convexSourceFiles } from "./commitmentWriteGuard";
import { scanReceivableDocumentWriters, type ReceivableWriterScan } from "./orgFinancialResetWriterCensus";

/**
 * `receivableDocuments.sourceId` is an opaque string, so the v.id walk above
 * cannot see it, yet each known `sourceType` makes it a reference to a row in a
 * reset-scoped table. Pinned here so a new kind cannot appear unnoticed.
 *
 * `sourceId` is only compared through the by_org source index and written; no
 * reader turns it back into a row id today (SCRUM-559 recon). `subledger
 * .createReceivable` (internal) accepts arbitrary strings, so the scan below
 * covers the in-repo writers only; the open-ended input is tracked in SCRUM-563.
 */
const RECEIVABLE_DOCUMENT_SOURCE_KINDS: Record<string, string> = {
  finance_application: "financeApplications",
  legacy_receivable: "receivables",
  sales: "sales",
};

const CONVEX_DIR = path.join(__dirname, "..", "convex");

const render = (title: string, keys: string[]) =>
  `${title}\n${keys.map((k) => `  - ${k}`).join("\n")}`;

interface CensusPin {
  /** Exact writer-site count per file. A new file, or a changed count, fails. */
  sites: Record<string, number>;
  /** Exact multiset of unparsed reasons per file (reason -> count). */
  unparsed: Record<string, Record<string, number>>;
}

/**
 * The receivableDocuments writer census, as an exact pin. Verified against
 * convex/ with the AST scanner (SCRUM-559 R1). The generic writer and its
 * registered subledger mutation forward caller arguments, so their unparsed
 * sites stay pinned by reason AND count, so a second identical pass-through fails instead of being
 * swallowed by a Set.
 */
const WRITER_CENSUS: CensusPin = {
  sites: { "accounting/openingAllocations.ts": 1, "collections.ts": 1, "domains/deal/financeReceivables.ts": 1, "subledger.ts": 1, "utils/receivableDocumentWriter.ts": 2, "utils/saleCompletion.ts": 1 },
  unparsed: {
    "subledger.ts": {
      "spread args: { ...args, actorId: user._id }": 1, // the internal createReceivable mutation
    },
    "utils/receivableDocumentWriter.ts": {
      "unresolved sourceType: args.sourceType": 1, // the insert inside createReceivableDocument
      "no inline object argument: args": 1, // ensureReceivableDocument -> createReceivableDocument(ctx, args)
    },
  },
};

const countBy = (xs: readonly string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
};

/** Every way the scan differs from the pin; empty when it equals it exactly. */
function censusProblems(scans: Record<string, ReceivableWriterScan>, pin: CensusPin): string[] {
  const problems: string[] = [];
  const files = new Set([
    ...Object.entries(scans).filter(([, s]) => s.sites > 0).map(([f]) => f),
    ...Object.keys(pin.sites),
  ]);
  for (const file of [...files].sort()) {
    const actual = scans[file]?.sites ?? 0;
    const expected = pin.sites[file] ?? 0;
    if (actual !== expected) {
      problems.push(
        `${file}: ${actual} receivableDocuments writer site(s), pinned ${expected}. Decide the new site's reset handling, then update WRITER_CENSUS.`
      );
    }
    const actualReasons = countBy(scans[file]?.unparsed ?? []);
    const expectedReasons = pin.unparsed[file] ?? {};
    if (JSON.stringify(Object.entries(actualReasons).sort()) !== JSON.stringify(Object.entries(expectedReasons).sort())) {
      problems.push(
        `${file}: unparsed sites ${JSON.stringify(actualReasons)} differ from the pin ${JSON.stringify(expectedReasons)}`
      );
    }
    for (const kind of scans[file]?.literals ?? []) {
      if (!(kind in RECEIVABLE_DOCUMENT_SOURCE_KINDS)) {
        problems.push(`${file}: sourceType kind "${kind}" has no pinned target table (decide its reset handling)`);
      }
    }
  }
  return problems;
}

function scanConvex(): Record<string, ReceivableWriterScan> {
  const out: Record<string, ReceivableWriterScan> = {};
  for (const file of convexSourceFiles(CONVEX_DIR)) {
    const rel = path.relative(CONVEX_DIR, file).replace(/\\/g, "/");
    out[rel] = scanReceivableDocumentWriters(fs.readFileSync(file, "utf8"), rel);
  }
  return out;
}

describe("receivableDocuments.sourceId opaque references stay pinned", () => {
  // Parses the whole convex tree with the TS compiler API. Whole-tree AST tests carry their own
  // explicit timeout (precedent: scripts/organizationReactivationGuard.test.ts L485-501): on CI
  // under coverage they crossed vitest's 5000ms default. The scan itself is not narrowed.
  test("the writer census equals its pin and every kind is a pinned kind", () => {
    const scans = scanConvex();
    const literals = new Set(Object.values(scans).flatMap((s) => s.literals));
    // Sanity: the scan must actually see the known writers, or it proves nothing.
    for (const kind of Object.keys(RECEIVABLE_DOCUMENT_SOURCE_KINDS)) expect(literals).toContain(kind);
    const problems = censusProblems(scans, WRITER_CENSUS);
    expect(problems, render("receivableDocuments writer census differs from its pin:", problems)).toEqual([]);
  }, 60_000);

  test("MUTATION CONTROL: a direct insert with a new literal kind is detected", () => {
    const scan = scanReceivableDocumentWriters(
      'await ctx.db.insert("receivableDocuments", { orgId, sourceType: "new_kind", sourceId: x });'
    );
    expect(scan.literals).toEqual(["new_kind"]);
    expect(scan.unparsed).toEqual([]);
  });

  test("MUTATION CONTROL: a direct insert with an unresolved identifier is unparsed", () => {
    const scan = scanReceivableDocumentWriters(
      'await ctx.db.insert("receivableDocuments", { orgId, sourceType: someVar, sourceId: x });'
    );
    expect(scan.literals).toEqual([]);
    expect(scan.unparsed).toEqual(["unresolved sourceType: someVar"]);
  });

  test("MUTATION CONTROL: a helper call without an inline object argument is unparsed", () => {
    const scan = scanReceivableDocumentWriters("await createReceivableDocument(ctx, args);");
    expect(scan.literals).toEqual([]);
    expect(scan.unparsed).toEqual(["no inline object argument: args"]);
  });

  test("MUTATION CONTROL: spread args, a missing key, and a computed value are unparsed", () => {
    expect(scanReceivableDocumentWriters("await ensureReceivableDocument(ctx, { ...base, sourceType: 'x' });").unparsed).toHaveLength(1);
    expect(scanReceivableDocumentWriters("await ensureReceivableDocument(ctx, { orgId, sourceId: x });").unparsed).toEqual([
      "no sourceType key: { orgId, sourceId: x }",
    ]);
    expect(
      scanReceivableDocumentWriters('await ensureReceivableDocument(ctx, { sourceType: a ? "x" : "y" });').unparsed
    ).toEqual(['unresolved sourceType: a ? "x" : "y"']);
  });

  test("MUTATION CONTROL: a helper call resolving through a _SOURCE const yields the kind", () => {
    const scan = scanReceivableDocumentWriters(
      'const FOO_SOURCE = "foo_kind";\nawait ensureReceivableDocument(ctx, { sourceType: FOO_SOURCE, sourceId: x });'
    );
    expect(scan.literals).toEqual(["foo_kind"]);
    expect(scan.unparsed).toEqual([]);
  });

  test("MUTATION CONTROL: a known literal resolves, and definitions, imports and type positions are not sites", () => {
    const scan = scanReceivableDocumentWriters(
      [
        "import { ensureReceivableDocument } from './subledger';",
        "export async function createReceivableDocument(ctx, args) { return 1; }",
        "type T = Parameters<typeof ensureReceivableDocument>[1];",
        "// createReceivableDocument(ctx, args) in a comment",
        'await ensureReceivableDocument(ctx, { sourceType: "sales", sourceId: x });',
      ].join("\n")
    );
    expect(scan).toEqual({ sites: 1, literals: ["sales"], unparsed: [] });
  });

  // ── SCRUM-559 R1: forgeries Codex proved against the regex scanner ──────────
  const NEW = 'await ctx.db.insert("receivableDocuments", { sourceType: "new_kind" });';

  test("MUTATION CONTROL (a): a table name held in a const is unparsed, not skipped", () => {
    const scan = scanReceivableDocumentWriters(
      'const TABLE = "receivableDocuments"; await ctx.db.insert(TABLE, { sourceType: "new_kind" });'
    );
    expect(scan.sites).toBe(1);
    expect(scan.unparsed).toHaveLength(1);
  });

  test("MUTATION CONTROL (b): whitespace before the call paren does not hide the site", () => {
    const scan = scanReceivableDocumentWriters(
      'await ctx.db.insert ("receivableDocuments", { sourceType: "new_kind" });'
    );
    expect(scan.literals).toEqual(["new_kind"]);
  });

  test("MUTATION CONTROL (c): an import alias of a helper is still a site", () => {
    const scan = scanReceivableDocumentWriters(
      'import { ensureReceivableDocument as ensure } from "./subledger"; await ensure(ctx, { sourceType: "new_kind" });'
    );
    expect(scan.literals).toEqual(["new_kind"]);
  });

  test("MUTATION CONTROL (d): a string containing // does not swallow the next call", () => {
    const scan = scanReceivableDocumentWriters(`const u = "a//b"; ${NEW}`);
    expect(scan.literals).toEqual(["new_kind"]);
  });

  test("MUTATION CONTROL (e): an inner-scope shadow of a const is unparsed, not resolved", () => {
    const scan = scanReceivableDocumentWriters(
      'const KIND = "sales"; { const KIND = args.sourceType; await ensureReceivableDocument(ctx, { sourceType: KIND }); }'
    );
    expect(scan.literals).toEqual([]);
    expect(scan.unparsed).toHaveLength(1);
  });

  test("MUTATION CONTROL: a namespace-import call is a site", () => {
    const scan = scanReceivableDocumentWriters(
      'import * as sl from "./subledger"; await sl.createReceivableDocument(ctx, { sourceType: "new_kind" });'
    );
    expect(scan.literals).toEqual(["new_kind"]);
  });

  test("MUTATION CONTROL: the runMutation function-reference form is a site", () => {
    const scan = scanReceivableDocumentWriters(
      'await ctx.runMutation(internal.subledger.createReceivable, { sourceType: "new_kind" });'
    );
    expect(scan.literals).toEqual(["new_kind"]);
  });

  test("MUTATION CONTROL: a re-export of a helper under a new name is unparsed", () => {
    const scan = scanReceivableDocumentWriters('export { ensureReceivableDocument as renamed } from "./subledger";');
    expect(scan.unparsed).toHaveLength(1);
  });

  test("MUTATION CONTROL: a db alias insert is a site", () => {
    const scan = scanReceivableDocumentWriters(
      'const db = ctx.db; await db.insert("receivableDocuments", { sourceType: "new_kind" });'
    );
    expect(scan.literals).toEqual(["new_kind"]);
  });

  test("MUTATION CONTROL: a shorthand { sourceType } is unparsed", () => {
    const scan = scanReceivableDocumentWriters(
      'const sourceType = "sales"; await ensureReceivableDocument(ctx, { sourceType });'
    );
    expect(scan.literals).toEqual([]);
    expect(scan.unparsed).toHaveLength(1);
  });

  test("MUTATION CONTROL: an identifier with two declarations is unparsed; a single top-level const resolves", () => {
    const twice = scanReceivableDocumentWriters(
      'const K = "a"; function f(K: string) {} await ensureReceivableDocument(ctx, { sourceType: K });'
    );
    expect(twice.literals).toEqual([]);
    expect(twice.unparsed).toHaveLength(1);
    const once = scanReceivableDocumentWriters(
      'const K = "kind_a"; await ensureReceivableDocument(ctx, { sourceType: K });'
    );
    expect(once.literals).toEqual(["kind_a"]);
    expect(once.unparsed).toEqual([]);
  });

  // ── SCRUM-559 R1 round 2: indirect-call escapes, keyed by NAME not call shape ──
  test.each([
    ["an element-access callee", 'await ctx.db["insert"]("receivableDocuments", { sourceType: "new_kind" });'],
    ["insert.call", 'await ctx.db.insert.call(ctx.db, "receivableDocuments", { sourceType: "new_kind" });'],
    ["insert.apply", 'await ctx.db.insert.apply(ctx.db, ["receivableDocuments", { sourceType: "new_kind" }]);'],
    ["a destructured insert", 'const { insert } = ctx.db; await insert("receivableDocuments", { sourceType: "new_kind" });'],
    ["a parenthesised insert callee", 'await (ctx.db.insert)("receivableDocuments", { sourceType: "new_kind" });'],
    [
      "a namespace helper stored in a variable",
      'import * as sl from "./subledger"; const f = sl.ensureReceivableDocument; await f(ctx, { sourceType: "new_kind" });',
    ],
    [
      "a helper destructured out of a namespace",
      'import * as sl from "./subledger"; const { ensureReceivableDocument: f } = sl; await f(ctx, { sourceType: "new_kind" });',
    ],
    [
      "a function reference stored in a variable",
      'const ref = internal.subledger.createReceivable; await ctx.runMutation(ref, { sourceType: "new_kind" });',
    ],
    [
      "a function reference through an element access",
      'await ctx.runMutation(internal.subledger["createReceivable"], { sourceType: "new_kind" });',
    ],
  ])("MUTATION CONTROL: %s is reported, never skipped", (_name, source) => {
    const scan = scanReceivableDocumentWriters(source);
    expect(scan.unparsed.length).toBeGreaterThan(0);
    expect(scan.unparsed.some((u) => /^indirect use of /.test(u))).toBe(true);
  });

  // ── SCRUM-559 round 3: rebinding a watched function under ANY other name is visible ──
  test.each([
    ["(1) a re-export of createReceivable under a new name", 'export { createReceivable as renamed } from "./subledger";'],
    [
      "(2) an import alias of createReceivable, exported",
      'import { createReceivable as r } from "./subledger"; export { r };',
    ],
    [
      "(3a) an import alias of a helper, exported",
      'import { ensureReceivableDocument as e } from "./subledger"; export { e };',
    ],
    [
      "(3b) an import alias of a helper, exported under yet another name",
      'import { ensureReceivableDocument as e } from "./subledger"; export { e as other };',
    ],
    [
      "(4) an import alias of createReceivable used as a value",
      'import { createReceivable as r } from "./subledger"; const f = r;',
    ],
  ])("MUTATION CONTROL: %s is exactly one unparsed site", (_name, source) => {
    const scan = scanReceivableDocumentWriters(source);
    expect(scan.sites).toBe(1);
    expect(scan.unparsed).toHaveLength(1);
  });

  // ── SCRUM-559 round 4: identity is the IMPORT BINDING, never the spelling ──
  test.each([
    [
      "(5) createReceivable imported under a helper's spelling, then exported",
      'import { createReceivable as ensureReceivableDocument } from "./subledger"; export { ensureReceivableDocument };',
    ],
    [
      "(7) a helper imported under createReceivable's spelling, then exported",
      'import { ensureReceivableDocument as createReceivable } from "./subledger"; export { createReceivable };',
    ],
  ])("MUTATION CONTROL: %s is exactly one unparsed site", (_name, source) => {
    const scan = scanReceivableDocumentWriters(source);
    expect(scan.sites).toBe(1);
    expect(scan.unparsed).toHaveLength(1);
  });

  test("MUTATION CONTROL (6): createReceivable under a helper's spelling is not parsed as a helper call", () => {
    const scan = scanReceivableDocumentWriters(
      'import { createReceivable as ensureReceivableDocument } from "./subledger"; await ensureReceivableDocument(ctx, { sourceType: "sales" });'
    );
    expect(scan.sites).toBe(1);
    expect(scan.unparsed).toHaveLength(1);
    expect(scan.literals).toEqual([]);
  });

  test("MUTATION CONTROL: importing and exporting a helper under its own name is not a site", () => {
    expect(
      scanReceivableDocumentWriters(
        'import { ensureReceivableDocument } from "./subledger"; export { ensureReceivableDocument };'
      )
    ).toEqual({ sites: 0, literals: [], unparsed: [] });
  });

  test("MUTATION CONTROL: a same-name re-export of an original watched name is not a site", () => {
    expect(scanReceivableDocumentWriters('export { ensureReceivableDocument } from "./subledger";')).toEqual({
      sites: 0,
      literals: [],
      unparsed: [],
    });
    expect(
      scanReceivableDocumentWriters("export const createReceivable = internalMutation({}); export { createReceivable };")
    ).toEqual({ sites: 0, literals: [], unparsed: [] });
  });

  test("MUTATION CONTROL: benign look-alikes are NOT sites (no false red)", () => {
    const scan = scanReceivableDocumentWriters(
      [
        'await ctx.db.insert("receivables", { a: 1 });',
        "const o = { insert: 1 };",
        "await aggregate.insertIfDoesNotExist(ctx, x);",
      ].join("\n")
    );
    expect(scan).toEqual({ sites: 0, literals: [], unparsed: [] });
  });

  test("MUTATION CONTROL (F2): an unresolvable insert table says it is counted as a possible writer", () => {
    const scan = scanReceivableDocumentWriters("await ctx.db.insert(table, { a: 1 });");
    expect(scan.unparsed).toHaveLength(1);
    expect(scan.unparsed[0]).toMatch(
      /^insert with an unresolvable table: counted as a possible receivableDocuments writer: table/
    );
  });

  test("MUTATION CONTROL (D2): a second identical pass-through site is not swallowed by the census", () => {
    const pass = { sites: 2, literals: [], unparsed: ["unresolved sourceType: args.sourceType", "unresolved sourceType: args.sourceType"] };
    const pin = { sites: { "subledger.ts": 2 }, unparsed: { "subledger.ts": { "unresolved sourceType: args.sourceType": 1 } } };
    expect(censusProblems({ "subledger.ts": pass }, pin)).not.toEqual([]);
    const one = { sites: 1, literals: [], unparsed: ["unresolved sourceType: args.sourceType"] };
    expect(censusProblems({ "subledger.ts": one }, { sites: { "subledger.ts": 1 }, unparsed: pin.unparsed })).toEqual([]);
  });

  test("MUTATION CONTROL: a new writer file and an unpinned kind each fail the census", () => {
    const pin = { sites: { "a.ts": 1 }, unparsed: {} };
    const ok = { sites: 1, literals: ["sales"], unparsed: [] };
    expect(censusProblems({ "a.ts": ok }, pin)).toEqual([]);
    expect(censusProblems({ "a.ts": ok, "b.ts": ok }, pin)).not.toEqual([]);
    expect(censusProblems({ "a.ts": { ...ok, literals: ["new_kind"] } }, pin)).not.toEqual([]);
    expect(censusProblems({ "a.ts": { ...ok, sites: 2 } }, pin)).not.toEqual([]);
  });

  test("every pinned kind targets a reset-scoped table", () => {
    const resetSet = new Set<string>(RESET_TABLES_FOR_TEST);
    for (const [kind, table] of Object.entries(RECEIVABLE_DOCUMENT_SOURCE_KINDS)) {
      expect(resetSet.has(table), `${kind} -> ${table}`).toBe(true);
    }
  });
});
