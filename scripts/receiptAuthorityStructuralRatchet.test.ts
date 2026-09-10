/**
 * SCRUM-238 — evidence for the receipt authority STRUCTURAL RATCHET.
 *
 * ## Why every control edits REAL source
 *
 * The previous (retired) analyzer's suite reproduced look-alike `Writer` and
 * `Id` declarations locally. Under the recognition rule that analyzer actually
 * used, such a fixture exercised NO recognition path at all — it passed while
 * proving nothing. That lesson is designed into this file:
 *
 *   Every failing-first control here takes the ACTUAL production file, makes
 *   ONE surgical edit, and asserts the verdict flips.
 *
 * `replaceOnce` throws when its anchor is missing or ambiguous, so a control
 * can never silently decay into a no-op edit that "passes". A control that
 * stops matching the repository fails loudly instead of quietly proving nothing.
 *
 * ## Green controls, both ends
 *
 * Every failing-first test asserts the unedited tree is SATISFIED for the same
 * invariant first. A red run is not evidence on its own — the control is what
 * shows the edit caused it.
 *
 * ## What this suite deliberately does NOT attempt
 *
 * There is no test asserting that some construct is "not a database write",
 * because this guard makes no such claim. It reads literals. Anything that does
 * not name a table in source is outside its scope by design, and the report
 * says so. See the header of the guard for why that limit is deliberate.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

// The real-repository controls parse every module under convex/. The first
// (cold) computation is measured in seconds under CI's V8 coverage
// instrumentation, which exceeds vitest's 5s default and then makes every later
// test restart the aborted scan. The work is real, so the limit is raised rather
// than the work faked.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import {
  AUTHORITY_INSERT_FIXTURE_EXCLUSIONS,
  AUTHORITY_OWNER_MODULE,
  AUTHORITY_TABLES,
  FORBIDDEN_TOTALITY_PHRASES,
  analyzeFinder,
  checkStructuralRatchet,
  fileSystemSource,
  findAuthorityInserts,
  formatRatchetReport,
  objectArrayManifest,
  overlaySource,
  parseModule,
  readRewriteRegistry,
  schemaDeclaredTables,
  stringArrayManifest,
  unwrap,
  variableInitializer,
  type InvariantResult,
  type RatchetReport,
  type SourceProvider,
} from "./receiptAuthorityStructuralRatchet";

const REPO_ROOT = path.resolve(__dirname, "..");

/** The real repository, with file reads memoized so 20 checks stay quick. */
const realSource: SourceProvider = (() => {
  const base = fileSystemSource(REPO_ROOT);
  const reads = new Map<string, string | null>();
  let modules: string[] | null = null;
  return {
    describe: () => base.describe(),
    read(relativePath) {
      if (!reads.has(relativePath)) reads.set(relativePath, base.read(relativePath));
      return reads.get(relativePath) ?? null;
    },
    listConvexModules() {
      modules ??= base.listConvexModules();
      return modules;
    },
  };
})();

const SCHEMA = "convex/schema.ts";
const MERGE = "convex/utils/mergeHelpers.ts";
const ADMIN_DATA = "convex/adminData.ts";
const RESET = "convex/orgFinancialReset.ts";
const ADMIN_ORGS = "convex/adminOrgs.ts";

/**
 * Reads a real file with line endings normalised to LF.
 *
 * `core.autocrlf` gives a Windows working tree CRLF while the repository and
 * every CI runner store LF. Without this, an anchor spanning a newline matches
 * on one platform and not the other — a control that silently stops testing
 * anything on exactly one of them. Normalising makes every control behave the
 * same everywhere; the guard parses either form identically.
 */
function readReal(file: string): string {
  const text = realSource.read(file);
  if (text === null) throw new Error(`the repository has no ${file}`);
  return text.replace(/\r\n/g, "\n");
}

/**
 * Replaces an anchor that must occur EXACTLY once.
 *
 * The throw is the point. A control whose anchor has drifted would otherwise
 * become an unedited copy of the file and report a false green.
 */
function replaceOnce(text: string, anchor: string, replacement: string, where: string): string {
  const occurrences = text.split(anchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `control anchor occurs ${occurrences} times in ${where} (expected exactly 1): ${anchor.slice(0, 90)}`
    );
  }
  return text.replace(anchor, replacement);
}

function editFile(file: string, ...pairs: readonly (readonly [string, string])[]): string {
  let text = readReal(file);
  for (const [anchor, replacement] of pairs) text = replaceOnce(text, anchor, replacement, file);
  return text;
}

/**
 * The report is a pure function of the source, so identical inputs are cached.
 *
 * Test-local on purpose: the guard itself stays free of mutable state. Without
 * this the suite rescans 400+ convex modules for every green control, which is
 * pure waste on a required CI check.
 */
const reportCache = new Map<string, RatchetReport>();

function check(overrides: Readonly<Record<string, string | null>> = {}): RatchetReport {
  const key = JSON.stringify(Object.entries(overrides).sort());
  let report = reportCache.get(key);
  if (report === undefined) {
    report = checkStructuralRatchet(overlaySource(realSource, overrides));
    reportCache.set(key, report);
  }
  return report;
}

function invariant(report: RatchetReport, id: string): InvariantResult {
  const found = report.invariants.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no invariant ${id} in report`);
  return found;
}

/* ------------------------------------------------------------------ *
 * The authority surface, built by surgical edits to the real files.
 *
 * `main` does not declare these tables — they arrive with SCRUM-218-C. The
 * ratcheted invariants (R2, R5) therefore have no subject on `main`, so their
 * controls must first bring the surface into existence. Doing that by editing
 * the REAL schema and the REAL manifests keeps the parsers pointed at real
 * syntax rather than at a fixture written to be parsed.
 * ------------------------------------------------------------------ */

const AUTHORITY_TABLE_DECLARATIONS = AUTHORITY_TABLES.map(
  (table) => `  ${table}: defineTable({ orgId: v.id("organizations") }).index("by_org", ["orgId"]),`
).join("\n");

function authoritySurface(): Record<string, string | null> {
  return {
    [SCHEMA]: editFile(SCHEMA, [
      "export default defineSchema({",
      `export default defineSchema({\n${AUTHORITY_TABLE_DECLARATIONS}`,
    ]),
    [MERGE]: editFile(MERGE, [
      'export const CUSTOMER_DERIVED_TABLES = ["socialConversations"] as const;',
      'export const CUSTOMER_DERIVED_TABLES = ["socialConversations"] as const;\n\n' +
        "export const CUSTOMER_NON_REASSIGNABLE_TABLES = [\n" +
        AUTHORITY_TABLES.map((table) => `  "${table}",`).join("\n") +
        "\n] as const;",
    ]),
    [RESET]: editFile(RESET, [
      "const RESET_TABLES = [",
      `const RESET_TABLES = [\n${AUTHORITY_TABLES.map((t) => `  "${t}",`).join("\n")}`,
    ]),
    [ADMIN_ORGS]: editFile(ADMIN_ORGS, [
      "export const ORGANIZATION_DELETION_STEPS: DeletionStep[] = [",
      "export const ORGANIZATION_DELETION_STEPS: DeletionStep[] = [\n" +
        AUTHORITY_TABLES.map(
          (t) => `  { kind: "orgRows", table: "${t}", index: "by_org" },`
        ).join("\n"),
    ]),
    [AUTHORITY_OWNER_MODULE]:
      "import { MutationCtx } from '../_generated/server';\n" +
      "export async function recordReceiptMovement(ctx: MutationCtx) {\n" +
      AUTHORITY_TABLES.map((t) => `  await ctx.db.insert("${t}", {});`).join("\n") +
      "\n}\n",
  };
}

/* ------------------------------------------------------------------ *
 * 1. The guard actually sees the repository
 * ------------------------------------------------------------------ */

describe("the ratchet is looking at the real repository", () => {
  test("it parses the real schema, registry and manifests, not empty stubs", () => {
    // A guard nobody has watched work is not a guard. If any of these came back
    // empty, every absence assertion below would pass vacuously.
    const schema = schemaDeclaredTables(parseModule(readReal(SCHEMA), SCHEMA));
    expect(schema.incomplete).toEqual([]);
    expect(schema.tables.length).toBeGreaterThan(100);
    expect(schema.tables).toContain("customers");
    expect(schema.tables).toContain("journalLines");

    const registry = readRewriteRegistry(parseModule(readReal(MERGE), MERGE));
    expect(registry.kind).toBe("ok");
    if (registry.kind !== "ok") throw new Error("unreachable");
    expect(registry.entries.length).toBeGreaterThan(20);
    expect(registry.entries.map((e) => e.label)).toContain("commitmentRoots");

    const admin = objectArrayManifest(parseModule(readReal(ADMIN_DATA), ADMIN_DATA), "ADMIN_TABLES", "table");
    expect(admin.kind).toBe("ok");
    if (admin.kind !== "ok") throw new Error("unreachable");
    expect(admin.values).toContain("customers");

    expect(realSource.listConvexModules().length).toBeGreaterThan(300);
  });

  test("the fixed oracle is exactly the three authority tables", () => {
    expect([...AUTHORITY_TABLES]).toEqual([
      "receiptMovements",
      "receiptRetainedPositions",
      "receiptApplications",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Green control: the repository as it stands
 * ------------------------------------------------------------------ */

describe("the repository as it stands", () => {
  test("has no violated invariant", () => {
    const report = check();
    expect(
      report.invariants.filter((i) => i.verdict === "VIOLATED").map((i) => `${i.id}: ${i.violations.join("; ")}`)
    ).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test("the always-active invariants are SATISFIED, not skipped", () => {
    const report = check();
    for (const id of ["R1", "R3", "R4", "R6"]) {
      expect(invariant(report, id).verdict, `${id} must be decided on main`).toBe("SATISFIED");
    }
  });

  test("an INACTIVE verdict carries the enumeration that proves it has no subject", () => {
    // The failure mode this whole ticket exists to avoid is a quiet exit that
    // reads like a pass. Inactivity must be PROVED from the schema, and the
    // proof must be printed.
    const report = check();
    expect(report.authoritySurface).toBe("ABSENT");
    for (const id of ["R2", "R5"]) {
      const result = invariant(report, id);
      expect(result.verdict).toBe("INACTIVE");
      expect(result.inactiveBecause).toContain("0 of 3");
      expect(result.inactiveBecause).toMatch(/declares \d+ tables/);
    }
    expect(formatRatchetReport(report)).toContain("It is not a pass.");
  });
});

/* ------------------------------------------------------------------ *
 * 3. Failing-first controls — the ruling's evidence floor
 * ------------------------------------------------------------------ */

describe("R1 — moving an authority table into the merge REWRITE registry", () => {
  test.each([...AUTHORITY_TABLES])("%s in CUSTOMER_REFERENCING_TABLES is a violation", (table) => {
    expect(invariant(check(), "R1").verdict).toBe("SATISFIED"); // green control

    const injected = editFile(MERGE, [
      "export const CUSTOMER_REFERENCING_TABLES = [",
      "export const CUSTOMER_REFERENCING_TABLES = [\n" +
        "  {\n" +
        `    table: "${table}" as const,\n` +
        "    find: (ctx: QueryCtx, orgId: Id<\"organizations\">, customerId: Id<\"customers\">) =>\n" +
        "      ctx.db\n" +
        `        .query("${table}")\n` +
        '        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))\n' +
        "        .collect(),\n" +
        "  },",
    ]);

    const result = invariant(check({ [MERGE]: injected }), "R1");
    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain(table);
    expect(check({ [MERGE]: injected }).ok).toBe(false);
  });
});

describe("R3 — the M13 lying finder", () => {
  test("an ordinary label whose finder ALSO returns authority rows is a violation", () => {
    expect(invariant(check(), "R3").verdict).toBe("SATISFIED"); // green control

    // The registry entry keeps its innocent label. Only the finder changes: it
    // appends receipt authority rows to what it returns. Nothing about the
    // declared table is false on its face — which is exactly why a label is not
    // a constraint, and why the coupling has to be checked against the query.
    const lying = editFile(MERGE, [
      '        .query("commitmentRoots")\n' +
        '        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))\n' +
        "        .collect(),",
      '        .query("commitmentRoots")\n' +
        '        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))\n' +
        "        .collect()\n" +
        "        .then(async (roots) => [\n" +
        "          ...roots,\n" +
        "          ...(await ctx.db\n" +
        '            .query("receiptRetainedPositions")\n' +
        '            .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))\n' +
        "            .collect()),\n" +
        "        ]),",
    ]);

    const report = check({ [MERGE]: lying });
    const result = invariant(report, "R3");
    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain("commitmentRoots");
    expect(result.violations.join("\n")).toContain("receiptRetainedPositions");
    expect(report.ok).toBe(false);
  });

  test("R1 alone would NOT have caught it — the label is still innocent", () => {
    // Stated as its own assertion because it is the reason R3 exists. The
    // registry label never names an authority table, so the absence check
    // passes; only the finder gives it away.
    const lying = editFile(MERGE, [
      '        .query("commitmentRoots")\n' +
        '        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))\n' +
        "        .collect(),",
      '        .query("commitmentRoots")\n' +
        '        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))\n' +
        "        .collect()\n" +
        "        .then(async (roots) => [\n" +
        "          ...roots,\n" +
        '          ...(await ctx.db.query("receiptRetainedPositions").collect()),\n' +
        "        ]),",
    ]);
    expect(invariant(check({ [MERGE]: lying }), "R1").verdict).toBe("SATISFIED");
    expect(invariant(check({ [MERGE]: lying }), "R3").verdict).toBe("VIOLATED");
  });
});

describe("R3 — label/query mismatch", () => {
  test("a finder querying a different table than its label is a violation", () => {
    expect(invariant(check(), "R3").verdict).toBe("SATISFIED"); // green control

    const mismatched = editFile(MERGE, ['.query("journalLines")', '.query("receiptApplications")']);
    const result = invariant(check({ [MERGE]: mismatched }), "R3");
    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain("journalLines");
    expect(result.violations.join("\n")).toContain("receiptApplications");
  });

  test("a finder whose table is chosen dynamically fails the structural check", () => {
    // Ruling c17733: a finder the simple grammar cannot decide must FAIL, never
    // receive an inferred blessing. Inference is what was retired.
    const dynamic = editFile(MERGE, ['.query("leads")', ".query(chosenTable)"]);
    const result = invariant(check({ [MERGE]: dynamic }), "R3");
    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain("not a single string literal");
  });

  test("a finder containing no query at all fails the structural check", () => {
    // Found while designing the mutation battery: without this, a mutant that
    // blesses a zero-query finder survives. A finder that names no table proves
    // no table.
    const empty = editFile(MERGE, [
      "      ctx.db\n" +
        '        .query("tasks")\n' +
        '        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))\n' +
        "        .collect(),",
      "      cachedTaskRows,",
    ]);
    const result = invariant(check({ [MERGE]: empty }), "R3");
    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain("no literal .query");
  });

  test("a registry entry declaring no find function fails the structural check", () => {
    const noFinder = editFile(MERGE, [
      "export const CUSTOMER_REFERENCING_TABLES = [",
      "export const CUSTOMER_REFERENCING_TABLES = [\n" +
        "  {\n" +
        '    table: "leads" as const,\n' +
        "  },",
    ]);
    const result = invariant(check({ [MERGE]: noFinder }), "R3");
    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain("no `find` function");
  });

  test("a registry entry whose table is not a literal fails the structural check", () => {
    const computed = editFile(MERGE, ['table: "sales" as const,', "table: chosenTable,"]);
    const result = invariant(check({ [MERGE]: computed }), "R3");
    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain("not a string literal");
  });

  test("a finder that delegates to a helper fails the structural check", () => {
    const indirected = editFile(MERGE, [
      "      ctx.db\n" +
        '        .query("quotes")\n' +
        '        .withIndex("by_customer", (q) => q.eq("customerId", customerId))\n' +
        "        .collect(),",
      "      findRowsFor(ctx, customerId),",
    ]);
    const result = invariant(check({ [MERGE]: indirected }), "R3");
    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain("findRowsFor");
  });
});

describe("R4 — the raw admin data editor", () => {
  test.each([...AUTHORITY_TABLES])("%s in ADMIN_TABLES is a violation", (table) => {
    expect(invariant(check(), "R4").verdict).toBe("SATISFIED"); // green control

    const exposed = editFile(ADMIN_DATA, [
      "const ADMIN_TABLES: { table: TableNames; index: string }[] = [",
      "const ADMIN_TABLES: { table: TableNames; index: string }[] = [\n" +
        `  { table: "${table}", index: "by_org" },`,
    ]);
    const result = invariant(check({ [ADMIN_DATA]: exposed }), "R4");
    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain(table);
  });
});

describe("R2 and R5 — ratcheted invariants activate when the schema declares the tables", () => {
  test("declaring the three tables activates R2 and R5, and a complete surface satisfies them", () => {
    const report = check(authoritySurface());
    expect(report.authoritySurface).toBe("PRESENT");
    expect(invariant(report, "R2").verdict).toBe("SATISFIED");
    expect(invariant(report, "R5").verdict).toBe("SATISFIED");
    expect(report.ok).toBe(true);
  });

  test.each([...AUTHORITY_TABLES])(
    "removing %s from the sealed classification is a violation",
    (table) => {
      const overlay = authoritySurface();
      overlay[MERGE] = replaceOnce(overlay[MERGE] as string, `  "${table}",\n`, "", MERGE);
      const result = invariant(check(overlay), "R2");
      expect(result.verdict).toBe("VIOLATED");
      expect(result.violations.join("\n")).toContain(table);
    }
  );

  test.each([...AUTHORITY_TABLES])("removing %s from RESET_TABLES is a violation", (table) => {
    const overlay = authoritySurface();
    overlay[RESET] = replaceOnce(overlay[RESET] as string, `  "${table}",\n`, "", RESET);
    const result = invariant(check(overlay), "R5");
    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain("RESET_TABLES");
    expect(result.violations.join("\n")).toContain(table);
  });

  test.each([...AUTHORITY_TABLES])(
    "removing %s from ORGANIZATION_DELETION_STEPS is a violation",
    (table) => {
      const overlay = authoritySurface();
      overlay[ADMIN_ORGS] = replaceOnce(
        overlay[ADMIN_ORGS] as string,
        `  { kind: "orgRows", table: "${table}", index: "by_org" },\n`,
        "",
        ADMIN_ORGS
      );
      const result = invariant(check(overlay), "R5");
      expect(result.verdict).toBe("VIOLATED");
      expect(result.violations.join("\n")).toContain("ORGANIZATION_DELETION_STEPS");
      expect(result.violations.join("\n")).toContain(table);
    }
  );

  test("a HALF-declared surface is a violation in itself, not a ratchet that stays asleep", () => {
    const overlay = authoritySurface();
    overlay[SCHEMA] = replaceOnce(
      overlay[SCHEMA] as string,
      `  receiptApplications: defineTable({ orgId: v.id("organizations") }).index("by_org", ["orgId"]),\n`,
      "",
      SCHEMA
    );
    const report = check(overlay);
    expect(report.authoritySurface).toBe("PARTIAL");
    expect(invariant(report, "R0").verdict).toBe("VIOLATED");
    expect(report.ok).toBe(false);
  });
});

describe("R6 — literal authority creation outside the owner module", () => {
  test.each([...AUTHORITY_TABLES])("a literal insert of %s in another module is a violation", (table) => {
    expect(invariant(check(), "R6").verdict).toBe("SATISFIED"); // green control

    const stray = `${readReal("convex/customers.ts")}\n
export async function backfillSomething(ctx: MutationCtx) {
  await ctx.db.insert("${table}", { orgId: "x" });
}
`;
    const result = invariant(check({ "convex/customers.ts": stray }), "R6");
    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain("convex/customers.ts");
    expect(result.violations.join("\n")).toContain(table);
  });

  test("the same insert inside the owner module is permitted", () => {
    const report = check(authoritySurface());
    expect(invariant(report, "R6").verdict).toBe("SATISFIED");
    expect(invariant(report, "R6").proved).toContain(AUTHORITY_OWNER_MODULE);
  });

  test("the fixture exemption is a LIST, not a `*.test.ts` wildcard", () => {
    // A wildcard would let a production module be exempted by renaming it. The
    // listed fixture is allowed; an unlisted test file is not.
    const listed = AUTHORITY_INSERT_FIXTURE_EXCLUSIONS[0] as string;
    const overlay = authoritySurface();
    overlay[listed] = 'const t = { db: { insert: (_a: string, _b: unknown) => 0 } };\nt.db.insert("receiptMovements", {});\n';
    expect(invariant(check(overlay), "R6").verdict).toBe("SATISFIED");

    const unlisted = { ...overlay, "convex/someOther.test.ts": overlay[listed] as string };
    const result = invariant(check(unlisted), "R6");
    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain("convex/someOther.test.ts");
  });

  test("an exempted site is still counted and PRINTED, never hidden", () => {
    const listed = AUTHORITY_INSERT_FIXTURE_EXCLUSIONS[0] as string;
    const overlay = authoritySurface();
    overlay[listed] = 'declare const db: { insert: (a: string, b: unknown) => number };\ndb.insert("receiptApplications", {});\n';
    const report = check(overlay);
    expect(report.exemptedInsertSites.map((s) => s.file)).toContain(listed);
    expect(formatRatchetReport(report)).toContain("EXPLICITLY EXEMPTED FIXTURE SITES");
    expect(formatRatchetReport(report)).toContain(listed);
  });

  test("the owner module going missing while the surface exists is a violation", () => {
    const overlay = authoritySurface();
    overlay[AUTHORITY_OWNER_MODULE] = null;
    const result = invariant(check(overlay), "R6");
    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain(AUTHORITY_OWNER_MODULE);
  });
});

/* ------------------------------------------------------------------ *
 * 4. A subject we cannot read is a VIOLATION, never a pass
 * ------------------------------------------------------------------ */

describe("an unreadable or unparsable subject fails closed", () => {
  test("deleting mergeHelpers.ts violates R1 and R3 rather than satisfying them", () => {
    const report = check({ [MERGE]: null });
    expect(invariant(report, "R1").verdict).toBe("VIOLATED");
    expect(invariant(report, "R3").verdict).toBe("VIOLATED");
    expect(invariant(report, "R1").violations.join()).toContain("cannot prove the property");
  });

  test("deleting adminData.ts violates R4", () => {
    expect(invariant(check({ [ADMIN_DATA]: null }), "R4").verdict).toBe("VIOLATED");
  });

  test("a schema that cannot be parsed is UNREADABLE and violates R0", () => {
    const report = check({ [SCHEMA]: "export default 42;" });
    expect(report.authoritySurface).toBe("UNREADABLE");
    expect(invariant(report, "R0").verdict).toBe("VIOLATED");
    expect(report.ok).toBe(false);
  });

  describe("the ratchet TRIGGER fails closed — an incomplete enumeration is never ABSENT", () => {
    // The single highest-value defect this design could have: if the schema
    // enumeration silently under-reports, R2 and R5 stay INACTIVE forever while
    // the tables really exist, and the guard reports a clean run for a surface
    // it never looked at. An empty result and a blind result are indistinguish-
    // able from the outside, so the guard must tell them apart itself.
    test.each([
      [
        "a spread hides an unknown set of tables",
        ["export default defineSchema({", "export default defineSchema({\n  ...extraTables,"] as const,
      ],
      [
        "a computed key names no table literal",
        [
          "export default defineSchema({",
          "export default defineSchema({\n  [dynamicName]: defineTable({}),",
        ] as const,
      ],
    ])("%s", (_label, [anchor, replacement]) => {
      const blinded = editFile(SCHEMA, [anchor, replacement]);
      const report = check({ [SCHEMA]: blinded });

      expect(report.authoritySurface).toBe("UNREADABLE");
      expect(report.authoritySurface).not.toBe("ABSENT");
      const r0 = invariant(report, "R0");
      expect(r0.verdict).toBe("VIOLATED");
      expect(r0.violations.join("\n")).toContain("cannot decide the ratchet trigger");
      expect(report.ok).toBe(false);
    });

    test("defineSchema given a variable instead of a literal is UNREADABLE", () => {
      const indirect = editFile(SCHEMA, [
        "export default defineSchema({",
        "export default defineSchema(allTables);\nconst unusedOriginalSchema = ({",
      ]);
      const report = check({ [SCHEMA]: indirect });
      expect(report.authoritySurface).toBe("UNREADABLE");
      expect(invariant(report, "R0").violations.join("\n")).toContain("inline object literal");
    });

    test("CONTROL: the unedited schema enumerates completely and reports ABSENT", () => {
      const report = check();
      expect(report.authoritySurface).toBe("ABSENT");
      expect(report.schemaTablesInspected).toBeGreaterThan(100);
      expect(report.invariants.find((i) => i.id === "R0")).toBeUndefined();
    });
  });

  test("a registry whose entries are not object literals is a violation, not an empty pass", () => {
    const spread = editFile(MERGE, [
      "export const CUSTOMER_REFERENCING_TABLES = [",
      "export const CUSTOMER_REFERENCING_TABLES = [\n  ...extraEntries,",
    ]);
    const report = check({ [MERGE]: spread });
    expect(invariant(report, "R1").verdict).toBe("VIOLATED");
    expect(invariant(report, "R3").verdict).toBe("VIOLATED");
  });

  test("a non-literal ADMIN_TABLES entry is a violation, not a pass", () => {
    const computed = editFile(ADMIN_DATA, [
      '{ table: "vehicles", index: "by_org" },',
      "{ table: chosenTable, index: \"by_org\" },",
    ]);
    expect(invariant(check({ [ADMIN_DATA]: computed }), "R4").verdict).toBe("VIOLATED");
  });
});

/* ------------------------------------------------------------------ *
 * 5. Ruling 6 — the guard must claim exactly what it proves
 * ------------------------------------------------------------------ */

describe("the report never claims totality", () => {
  const reports = (): RatchetReport[] => [
    check(),
    check(authoritySurface()),
    check({ [MERGE]: null }),
    check({ [SCHEMA]: "export default 42;" }),
    check({
      [SCHEMA]: editFile(SCHEMA, [
        "export default defineSchema({",
        "export default defineSchema({\n  ...extraTables,",
      ]),
    }),
  ];

  test("a VIOLATED result always carries at least one reason", () => {
    // A violation with no message is a build failure nobody can act on, and it
    // is how a blinded check still looks like it is working.
    for (const report of reports()) {
      for (const result of report.invariants) {
        if (result.verdict !== "VIOLATED") continue;
        expect(result.violations.length, `${result.id} failed with no reason given`).toBeGreaterThan(0);
      }
    }
  });

  test.each(FORBIDDEN_TOTALITY_PHRASES)("no report contains %j", (phrase) => {
    for (const report of reports()) {
      expect(formatRatchetReport(report).toLowerCase()).not.toContain(phrase.toLowerCase());
    }
  });

  test("every result names its own subject and what it individually proved", () => {
    for (const report of reports()) {
      for (const result of report.invariants) {
        expect(result.subject.length).toBeGreaterThan(0);
        expect(result.proved.length).toBeGreaterThan(0);
        const rendered = formatRatchetReport(report);
        expect(rendered).toContain(result.id);
        expect(rendered).toContain(result.title);
      }
    }
  });

  test("the limits block always states it is not a security proof", () => {
    for (const report of reports()) {
      const rendered = formatRatchetReport(report);
      expect(rendered).toContain("WHAT THIS DOES NOT PROVE");
      expect(rendered).toContain("NOT an adversarial");
      expect(rendered).toContain("SCRUM-231");
      expect(rendered).toContain("SCRUM-250");
    }
  });

  test("a VIOLATED result prints what it did NOT prove, not a bare failure", () => {
    const rendered = formatRatchetReport(check({ [ADMIN_DATA]: null }));
    expect(rendered).toContain("NOT proved");
  });
});

/* ------------------------------------------------------------------ *
 * 6. Syntax helpers — decided from source only
 * ------------------------------------------------------------------ */

describe("the syntax layer uses no type inference", () => {
  test("unwrap sees through `as const`, `satisfies` and parentheses", () => {
    const file = parseModule(
      'const a = (["x"] as const);\nconst b = ["y"] satisfies string[];\n',
      "t.ts"
    );
    for (const name of ["a", "b"]) {
      const initializer = variableInitializer(file, name);
      expect(initializer).not.toBeNull();
      expect(unwrap(initializer!).kind.toString()).toBeTruthy();
    }
    expect(stringArrayManifest(file, "a")).toEqual({ kind: "ok", values: ["x"] });
    expect(stringArrayManifest(file, "b")).toEqual({ kind: "ok", values: ["y"] });
  });

  test("a missing manifest and an unparsable one are different, and neither is ok", () => {
    const file = parseModule('const a = ["x", y];\n', "t.ts");
    expect(stringArrayManifest(file, "nope").kind).toBe("missing");
    expect(stringArrayManifest(file, "a").kind).toBe("unparsable");
  });

  test("objectArrayManifest skips entries that declare no such property", () => {
    // The real deletion manifest holds storage-aware steps naming no table.
    // Skipping them is deliberate; a PRESENT but non-literal value is not.
    const steps = objectArrayManifest(
      parseModule(readReal(ADMIN_ORGS), ADMIN_ORGS),
      "ORGANIZATION_DELETION_STEPS",
      "table"
    );
    expect(steps.kind).toBe("ok");
    if (steps.kind !== "ok") throw new Error("unreachable");
    expect(steps.values.length).toBeGreaterThan(40);
    expect(steps.values).toContain("journalLines");
    expect(steps.values).not.toContain(undefined);
  });

  test("analyzeFinder reports literals and problems separately", () => {
    const file = parseModule(
      'const f = (ctx: any) => ctx.db.query("leads").collect();\n' +
        'const g = (ctx: any) => ctx.db.query(name).collect();\n' +
        "const h = (ctx: any) => helper(ctx);\n" +
        "const i = (ctx: any) => ctx.db.get(id);\n",
      "t.ts"
    );
    expect(analyzeFinder(variableInitializer(file, "f")!)).toEqual({
      queryLiterals: ["leads"],
      problems: [],
    });
    expect(analyzeFinder(variableInitializer(file, "g")!).problems.join()).toContain(
      "not a single string literal"
    );
    expect(analyzeFinder(variableInitializer(file, "h")!).problems.join()).toContain("helper");
    expect(analyzeFinder(variableInitializer(file, "i")!).problems.join()).toContain("ctx.db.get");
  });

  test("findAuthorityInserts reads the literal, including a bracketed member", () => {
    const sites = findAuthorityInserts(
      'ctx.db.insert("receiptMovements", {});\n' +
        'ctx.db["insert"]("receiptApplications", {});\n' +
        'ctx.db.insert("customers", {});\n' +
        "ctx.db.insert(tableName, {});\n",
      "convex/x.ts"
    );
    expect(sites.map((s) => s.table)).toEqual(["receiptMovements", "receiptApplications"]);
  });

  test("a non-authority table is never reported by R6", () => {
    // Precision control: the guard reads a fixed oracle, so ordinary inserts
    // across 400+ real modules produce nothing.
    expect(invariant(check(), "R6").proved).toContain("all 0 source sites");
  });
});

/* ------------------------------------------------------------------ *
 * Integration against REAL HISTORY — the frozen SCRUM-218-C baseline
 * ------------------------------------------------------------------ */

function git(args: readonly string[], input?: string): Buffer | null {
  try {
    return execFileSync("git", [...args], {
      cwd: REPO_ROOT,
      input,
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * Reads many blobs from one revision in a SINGLE git process.
 *
 * Spawning `git show` once per module costs ~90s for a 400-module tree, which
 * is slow enough that the control would get quietly deleted later. `cat-file
 * --batch` streams every blob through one process instead.
 */
function batchRead(rev: string, paths: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const stdout = git(["cat-file", "--batch"], paths.map((p) => `${rev}:${p}`).join("\n") + "\n");
  if (stdout === null) return out;

  let offset = 0;
  for (const file of paths) {
    const newline = stdout.indexOf(0x0a, offset);
    if (newline === -1) break;
    const header = stdout.subarray(offset, newline).toString("utf8");
    offset = newline + 1;
    // "<oid> <type> <size>" on success; "<spec> missing" when absent.
    const parts = header.split(" ");
    if (parts.length < 3) continue;
    const size = Number(parts[2]);
    if (!Number.isFinite(size)) continue;
    out.set(file, stdout.subarray(offset, offset + size).toString("utf8"));
    offset += size + 1;
  }
  return out;
}

/**
 * Aims the guard at a git revision, so an integration needs no second worktree
 * and no `node_modules` junction.
 *
 * This exercises the SAME `checkStructuralRatchet` code path as the live
 * repository check — only the `SourceProvider` differs.
 */
function gitSource(rev: string): SourceProvider {
  let modules: string[] | null = null;
  const cache = new Map<string, string | null>();
  let bulkLoaded = false;

  const list = (): string[] => {
    if (modules === null) {
      const listed = git(["ls-tree", "-r", "--name-only", rev, "--", "convex/"]);
      modules =
        listed === null
          ? []
          : listed
              .toString("utf8")
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.endsWith(".ts") || line.endsWith(".tsx"))
              .filter((line) => !line.includes("/_generated/"))
              .sort();
    }
    return modules;
  };

  const bulk = (): void => {
    if (bulkLoaded) return;
    bulkLoaded = true;
    for (const [file, content] of batchRead(rev, list())) cache.set(file, content);
  };

  return {
    describe: () => `git ${rev}`,
    read(relativePath) {
      if (relativePath.startsWith("convex/")) bulk();
      if (cache.has(relativePath)) return cache.get(relativePath) ?? null;
      const single = git(["show", `${rev}:${relativePath}`]);
      const text = single === null ? null : single.toString("utf8");
      cache.set(relativePath, text);
      return text;
    },
    listConvexModules: list,
  };
}

/** SCRUM-218-C, ACCEPTED / SOURCE-COMPLETE. The authority surface exists here. */
const BASELINE_218C = "ca68b2b0ef8f0b336c473172d524ef0c4013b71c";

/**
 * Real history, not a synthetic mutant: at this commit all three authority
 * tables were literally registered in `CUSTOMER_REFERENCING_TABLES`, so a
 * customer merge would have repointed sealed receipt authority. This is the
 * exact regression the ratchet exists to prevent, taken from the branch's own
 * past rather than invented for the test.
 */
const KNOWN_BAD_218C = "8ca29afd9fa0d993ef8e85bd2d3cd0febf15fa02";

function revisionAvailable(rev: string): boolean {
  return git(["cat-file", "-e", `${rev}^{commit}`]) !== null;
}

/**
 * These controls read commits that live on an unmerged branch. A shallow or
 * single-ref CI checkout may not have the objects; there the control is
 * UNAVAILABLE — skipped loudly, and never to be reported as a pass.
 */
const historyAvailable = revisionAvailable(BASELINE_218C) && revisionAvailable(KNOWN_BAD_218C);
if (!historyAvailable) {
  console.warn(
    `[SCRUM-238] integration controls SKIPPED — NOT PASSED: this checkout lacks ` +
      `${BASELINE_218C.slice(0, 9)} and/or ${KNOWN_BAD_218C.slice(0, 9)}.`
  );
}

const reportAtRevision = new Map<string, RatchetReport>();
function reportAt(rev: string): RatchetReport {
  let report = reportAtRevision.get(rev);
  if (report === undefined) {
    report = checkStructuralRatchet(gitSource(rev));
    reportAtRevision.set(rev, report);
  }
  return report;
}

describe.skipIf(!historyAvailable)("integration against the frozen 218-C baseline", () => {
  test(`every invariant is SATISFIED at ${BASELINE_218C.slice(0, 9)}`, () => {
    const report = reportAt(BASELINE_218C);

    // A vacuous pass is the failure mode here: an empty module list would make
    // R6 trivially true. Prove the enumeration actually saw the tree.
    expect(gitSource(BASELINE_218C).listConvexModules().length).toBeGreaterThan(300);
    expect(report.schemaTablesInspected).toBeGreaterThan(50);

    // The ratcheted invariants must be ACTIVE here, or "all satisfied" would
    // only mean "R2 and R5 had no subject".
    expect(report.authoritySurface).toBe("PRESENT");
    expect([...report.declaredAuthorityTables].sort()).toEqual([...AUTHORITY_TABLES].sort());
    expect(report.invariants.filter((i) => i.verdict === "INACTIVE").map((i) => i.id)).toEqual([]);

    expect(
      report.invariants
        .filter((i) => i.verdict === "VIOLATED")
        .map((i) => `${i.id}: ${i.violations.join("; ")}`)
    ).toEqual([]);
    expect(report.invariants.map((i) => i.id).sort()).toEqual(["R1", "R2", "R3", "R4", "R5", "R6"]);
    expect(report.ok).toBe(true);
  });

  test(`the historical merge-registry defect at ${KNOWN_BAD_218C.slice(0, 9)} is REJECTED`, () => {
    const report = reportAt(KNOWN_BAD_218C);

    expect(report.authoritySurface).toBe("PRESENT");
    expect(report.ok).toBe(false);

    const r1 = report.invariants.find((i) => i.id === "R1");
    expect(r1?.verdict).toBe("VIOLATED");
    // Every one of the three must be named — a guard that caught only the
    // first would look identical on a summary line.
    for (const table of AUTHORITY_TABLES) {
      expect(r1?.violations.join("\n")).toContain(`"${table}"`);
    }
  });

  test("the two revisions disagree, so neither control is vacuous", () => {
    expect(reportAt(BASELINE_218C).ok).toBe(true);
    expect(reportAt(KNOWN_BAD_218C).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 7. Reviewer findings — a blind enumeration must never read as absence
 * ------------------------------------------------------------------ */

const ADMIN_ANCHOR = "const ADMIN_TABLES: { table: TableNames; index: string }[] = [";

describe("R4 — an entry whose key the grammar cannot read is not an absence", () => {
  // The hazard: `objectArrayManifest` SKIPS an entry that declares no readable
  // `table` property, because the deletion manifest legitimately holds steps
  // that name no table. For R5 (presence) a skipped entry fails closed. For R4
  // (absence) it fails OPEN: the entry vanishes and the table it named is
  // reported absent from a manifest that was never fully read.
  test.each([
    [
      "shorthand property",
      'const table = "receiptMovements" as const;\nconst index = "by_org";\n',
      "  { table, index },",
    ],
    [
      "computed key",
      'const KEY = "table";\n',
      '  { [KEY]: "receiptRetainedPositions", index: "by_org" },',
    ],
    [
      "object spread",
      'const SMUGGLED = { table: "receiptApplications" as const, index: "by_org" };\n',
      "  { ...SMUGGLED },",
    ],
  ])("an ADMIN_TABLES entry hidden behind a %s is not read as absence", (_label, preamble, entry) => {
    expect(invariant(check(), "R4").verdict).toBe("SATISFIED"); // green control

    const smuggled = editFile(ADMIN_DATA, [
      ADMIN_ANCHOR,
      `${preamble}${ADMIN_ANCHOR}\n${entry}`,
    ]);
    const report = check({ [ADMIN_DATA]: smuggled });
    const result = invariant(report, "R4");

    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain("cannot prove the property");
    expect(report.ok).toBe(false);
  });

  test("CONTROL: the real ADMIN_TABLES is read whole, and the printed count proves it", () => {
    const result = invariant(check(), "R4");
    expect(result.verdict).toBe("SATISFIED");
    const counted = Number(/among the (\d+) admin-browsable/.exec(result.proved)?.[1]);
    // A silently shortened enumeration would still say SATISFIED; only the
    // count gives it away, so the count is asserted rather than the verdict.
    expect(counted).toBeGreaterThan(15);
  });

  test("CONTROL: deletion-manifest steps that legitimately name no table still parse", () => {
    // ORGANIZATION_DELETION_STEPS holds storage-aware steps with no `table`.
    // Failing closed on unreadable keys must not turn those into violations.
    expect(invariant(check(authoritySurface()), "R5").verdict).toBe("SATISFIED");
  });
});

describe("INACTIVE is reserved for a surface PROVED absent", () => {
  test("CONTROL: on the repository as it stands the surface is ABSENT and R2/R5 are INACTIVE", () => {
    const report = check();
    expect(report.authoritySurface).toBe("ABSENT");
    expect(invariant(report, "R2").verdict).toBe("INACTIVE");
    expect(invariant(report, "R5").verdict).toBe("INACTIVE");
  });

  test.each([
    [
      "PARTIAL",
      (): Record<string, string | null> => {
        const overlay = authoritySurface();
        overlay[SCHEMA] = replaceOnce(
          overlay[SCHEMA] as string,
          `  receiptApplications: defineTable({ orgId: v.id("organizations") }).index("by_org", ["orgId"]),\n`,
          "",
          SCHEMA
        );
        return overlay;
      },
    ],
    ["UNREADABLE", (): Record<string, string | null> => ({ [SCHEMA]: "export default 42;" })],
  ])("a %s surface makes R2 and R5 VIOLATED, never INACTIVE", (_label, build) => {
    const report = check(build());
    for (const id of ["R2", "R5"]) {
      const result = invariant(report, id);
      // "the subject does not exist yet" and "I could not tell" are different
      // claims, and only the first one is INACTIVE.
      expect(result.verdict).not.toBe("INACTIVE");
      expect(result.verdict).toBe("VIOLATED");
      expect(result.violations.join("\n")).toContain("could not be decided");
    }
    expect(report.ok).toBe(false);
  });

  test("no report prints an INACTIVE verdict for a surface that is not ABSENT", () => {
    for (const overlay of [
      {},
      { [SCHEMA]: "export default 42;" },
    ] as Record<string, string | null>[]) {
      const report = check(overlay);
      if (report.invariants.some((i) => i.verdict === "INACTIVE")) {
        expect(report.authoritySurface).toBe("ABSENT");
      }
    }
  });
});
