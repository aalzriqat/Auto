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
  // `readRewriteRegistry` is no longer imported: its only subject,
  // `CUSTOMER_REFERENCING_TABLES`, was deleted with the customer-merge seam. The
  // function itself is deliberately KEPT in the guard — R1 and R3 re-arm through
  // it if the module ever returns.
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
 * The authority surface — ⚠️ RE-BASELINED: it is now REAL, not overlaid.
 *
 * SCRUM-238 was authored before SCRUM-218-C. At that point `main` did not
 * declare the three tables, so every control that needed a live surface had to
 * BUILD one by overlaying the schema, the manifests and an owner-module stub,
 * and the repository control asserted `ABSENT` / `INACTIVE`.
 *
 * 218-C is integrated on this branch. The tables are declared in the real
 * `convex/schema.ts`, named in the real `RESET_TABLES` and the real
 * `ORGANIZATION_DELETION_STEPS`, and minted by the real
 * `convex/accounting/receiptMovement.ts`. So the whole synthetic surface is
 * deleted and every control now runs against the integrated tree.
 *
 * This is an integration-order adaptation, and it is STRICTLY STRONGER than
 * what it replaces: the ratcheted invariants used to be proved against a surface
 * the test itself wrote, and are now proved against the one the product ships.
 * The removal direction is what needs a fixture instead, and those two helpers
 * below still edit the REAL schema rather than a look-alike.
 * ------------------------------------------------------------------ */

/** The real schema with all three authority tables un-declared: surface ABSENT. */
function absentSurface(): Record<string, string | null> {
  return {
    [SCHEMA]: editFile(
      SCHEMA,
      ...AUTHORITY_TABLES.map(
        (table) => [`  ${table}: defineTable({`, `  unrelated_${table}: defineTable({`] as const
      )
    ),
  };
}

/** The real schema with ONE of the three un-declared: surface PARTIAL. */
function partialSurface(): Record<string, string | null> {
  return {
    [SCHEMA]: editFile(SCHEMA, [
      "  receiptApplications: defineTable({",
      "  unrelated_receiptApplications: defineTable({",
    ]),
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

    // The merge rewrite registry used to be read here. It no longer exists —
    // see the retirement block below — so the destructive manifests, which R5
    // actually reads at this head, are watched working instead.
    const reset = stringArrayManifest(parseModule(readReal(RESET), RESET), "RESET_TABLES");
    expect(reset.kind).toBe("ok");
    if (reset.kind !== "ok") throw new Error("unreachable");
    expect(reset.values.length).toBeGreaterThan(20);
    expect(reset.values).toContain("journalLines");

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

  test("every surviving invariant is SATISFIED, not skipped", () => {
    // ⚠️ R1, R2 and R3 are deliberately NOT in this list. They are RETIRED with
    // their deleted subject, and a retired rule must never be counted as a pass.
    const report = check();
    for (const id of ["R4", "R5", "R6"]) {
      expect(invariant(report, id).verdict, `${id} must be decided at this head`).toBe("SATISFIED");
    }
    expect(report.authoritySurface).toBe("PRESENT");
    expect([...report.declaredAuthorityTables].sort()).toEqual([...AUTHORITY_TABLES].sort());
  });

  test("the ratcheted invariant is decided against the REAL integrated surface", () => {
    // Re-baselined by SCRUM-218-C. Before integration this said ABSENT/INACTIVE;
    // asserting the counts rather than only the verdict is what keeps a silently
    // shortened enumeration from still reading as SATISFIED.
    const r5 = invariant(check(), "R5");
    expect(r5.verdict).toBe("SATISFIED");
    expect(r5.proved).toMatch(/\d+ reset entries/);
    expect(r5.proved).toMatch(/\d+ deletion steps inspected/);
    expect(Number(/(\d+) reset entries/.exec(r5.proved)?.[1])).toBeGreaterThan(20);
    expect(Number(/(\d+) deletion steps/.exec(r5.proved)?.[1])).toBeGreaterThan(40);
  });

  test("an INACTIVE verdict carries the enumeration that proves it has no subject", () => {
    // The failure mode this whole ticket exists to avoid is a quiet exit that
    // reads like a pass. Inactivity must be PROVED from the schema, and the
    // proof must be printed.
    //
    // The subject now exists at this head, so the property is exercised against
    // the real schema with the three declarations edited out — the surface the
    // repository had before 218-C, reconstructed from the file the repository
    // actually ships rather than asserted from a fixture.
    const report = check(absentSurface());
    expect(report.authoritySurface).toBe("ABSENT");
    const result = invariant(report, "R5");
    expect(result.verdict).toBe("INACTIVE");
    expect(result.inactiveBecause).toContain("0 of 3");
    expect(result.inactiveBecause).toMatch(/declares \d+ tables/);
    expect(formatRatchetReport(report)).toContain("It is not a pass.");
  });
});

/* ------------------------------------------------------------------ *
 * 2b. RETIRED — the customer-merge rules, and their deleted subject
 * ------------------------------------------------------------------ */

describe("R1, R2 and R3 are RETIRED with the customer-merge seam SCRUM-314 deleted", () => {
  /**
   * ⚠️ WHAT WAS REMOVED FROM THIS SUITE, AND WHY — stated rather than dropped.
   *
   * Fourteen failing-first controls used to live here and below:
   *
   *   - three R1 controls injecting each authority table into
   *     `CUSTOMER_REFERENCING_TABLES`;
   *   - two R3 "M13 lying finder" controls;
   *   - six R3 label/query-coupling controls (mismatch, dynamic table, no query,
   *     no finder, non-literal label, delegating finder);
   *   - three R2 controls removing each table from the sealed classification;
   *   - plus `deleting mergeHelpers.ts violates R1 and R3` and `a registry whose
   *     entries are not object literals is a violation`.
   *
   * Every one of them edited `convex/utils/mergeHelpers.ts`. SCRUM-314 deleted
   * that module, `CUSTOMER_REFERENCING_TABLES`, `CUSTOMER_NON_REASSIGNABLE_TABLES`,
   * `customers.mergeCustomers` / `previewMerge` / `findMergeCandidates` and the
   * frontend dialog. An adapted version of any of those controls would assert
   * nothing: its subject has ceased to exist.
   *
   * They are NOT counted as passing tests. `verdict === "RETIRED"` is not
   * `SATISFIED`, the report prints "NOT EXECUTED", and the executed-rule count
   * excludes them.
   *
   * ⚠️ AND THE POLARITY WAS NOT INVERTED. The original suite pinned that deleting
   * `mergeHelpers.ts` VIOLATES R1 and R3 rather than satisfying them, which is
   * correct and is the whole design of this programme: an absence must never read
   * as compliance. What changed is the question. The property those rules guarded
   * now holds BY CONSTRUCTION — no generic customer-rewriting registry exists
   * anywhere in `convex/` to be checked — which is stronger than a source guard
   * could establish. Owner ruling SCRUM-313 Option 1.
   *
   * Two things keep this from becoming a fail-open hiding place, and both are
   * tested below: the retirement is CONDITIONAL on the subject's absence and
   * re-arms if the module returns, and the original oracle is still executed
   * against real history at `BASELINE_218C` / `KNOWN_BAD_218C`, where the seam
   * still existed.
   */
  test("they report RETIRED — not SATISFIED, and not INACTIVE", () => {
    const report = check();
    for (const id of ["R1", "R2", "R3"]) {
      const result = invariant(report, id);
      expect(result.verdict).toBe("RETIRED");
      expect(result.verdict).not.toBe("SATISFIED");
      expect(result.verdict).not.toBe("INACTIVE");
      expect(result.retiredBecause).toContain("SCRUM-314");
      expect(result.retiredBecause).toContain("SCRUM-313");
    }
  });

  test("a retired rule is printed as NOT EXECUTED and excluded from the pass count", () => {
    const rendered = formatRatchetReport(check());
    expect(rendered).toContain("NOT EXECUTED — this rule proved nothing on this run.");
    expect(rendered).toContain("RETIRED (not executed, not counted as passing): R1, R2, R3.");
    // Three rules survive, and the printed count must say three — not six.
    expect(rendered).toContain("EXECUTED: 3 rule(s) — 3 SATISFIED, 0 VIOLATED, 0 INACTIVE.");
  });

  test("a retired rule does not make the run fail either", () => {
    // RETIRED is not a violation. If it were, the ratchet would be permanently
    // red and would get switched off, which is the other way this goes wrong.
    expect(check().ok).toBe(true);
  });

  test("THE RETIREMENT IS CONDITIONAL — restoring the module RE-ARMS R1 and R3", () => {
    // The failure this guards against: retirement becoming a blanket amnesty, so
    // that reintroducing the deleted seam inherits it and ships unchecked. The
    // rule bodies were left intact for exactly this reason.
    const restored =
      "import type { QueryCtx } from '../_generated/server';\n" +
      "export const CUSTOMER_REFERENCING_TABLES = [\n" +
      "  {\n" +
      '    table: "receiptMovements" as const,\n' +
      "    find: (ctx: QueryCtx, orgId: string, customerId: string) =>\n" +
      "      ctx.db\n" +
      '        .query("receiptMovements")\n' +
      '        .withIndex("by_org_customer", (q) => q.eq("orgId", orgId).eq("customerId", customerId))\n' +
      "        .collect(),\n" +
      "  },\n" +
      "] as const;\n";

    const report = check({ [MERGE]: restored });
    const r1 = invariant(report, "R1");
    expect(r1.verdict).not.toBe("RETIRED");
    expect(r1.verdict).toBe("VIOLATED");
    expect(r1.violations.join("\n")).toContain("receiptMovements");
    expect(report.ok).toBe(false);
  });

  test("the retirement precondition is the module's absence, nothing weaker", () => {
    // An EMPTY mergeHelpers.ts is readable, so it is not retired — it is
    // unparsable, and unparsable fails closed exactly as it always did.
    const report = check({ [MERGE]: "export const SOMETHING_ELSE = 1;\n" });
    for (const id of ["R1", "R3"]) {
      const result = invariant(report, id);
      expect(result.verdict).not.toBe("RETIRED");
      expect(result.verdict).toBe("VIOLATED");
      expect(result.violations.join("\n")).toContain("cannot prove the property");
    }
    expect(report.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 2c. SCRUM-314 — the removed product seam stays removed
 *
 * With R1/R2/R3 retired, this is what carries the claim. It is deliberately
 * NOT a generic absence analyzer: it names five things and reads for those five
 * names only. A repo-wide "no customer-rewriting mechanism exists anywhere"
 * analyzer would be a redesign of a certified artifact, and is out of scope for
 * this RC by owner ruling.
 * ------------------------------------------------------------------ */

describe("SCRUM-314 — the customer-merge seam is absent at this head", () => {
  test.each([
    ["convex/utils/mergeHelpers.ts", "the rewrite registry module"],
    ["components/customers/MergeCustomersDialog.tsx", "the frontend entry point"],
    ["convex/customerMergeRegistry.test.ts", "the registry's own suite"],
  ])("%s is absent (%s)", (file) => {
    expect(realSource.read(file)).toBeNull();
  });

  test.each(["mergeCustomers", "previewMerge", "findMergeCandidates"])(
    "customers.ts exports no %s",
    (name) => {
      const customers = readReal("convex/customers.ts");
      // The export form is what a caller can reach. Asserting on `export ...
      // <name>` rather than on the bare identifier keeps a comment mentioning
      // the removal from failing this, which would teach people to delete it.
      expect(customers).not.toMatch(new RegExp(`export\\s+const\\s+${name}\\b`));
      expect(customers).not.toMatch(new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`));
    }
  );

  test("no receipt-authority table was added back to a generic reassignment mechanism", () => {
    // R1's original question, asked of the only place an answer could now live.
    // If either registry name is ever DECLARED again, R1/R2/R3 re-arm on their
    // own (proved above) — this is the cheaper tripwire that says so sooner.
    for (const registry of ["CUSTOMER_REFERENCING_TABLES", "CUSTOMER_NON_REASSIGNABLE_TABLES"]) {
      for (const file of realSource.listConvexModules()) {
        const text = realSource.read(file);
        if (text === null) continue;
        expect(text, `${file} re-declares ${registry}`).not.toMatch(
          new RegExp(`export\\s+const\\s+${registry}\\b`)
        );
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. Failing-first controls — the ruling's evidence floor
 * ------------------------------------------------------------------ */

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

describe("R5 — the ratcheted invariant, decided against the REAL integrated surface", () => {
  // ⚠️ RE-BASELINED. This block used to be "R2 and R5", and used to build the
  // surface by overlay because `main` did not declare the tables. 218-C declares
  // them, so both the green control and every removal now edit the shipping
  // files. R2's three sealed-classification controls were REMOVED, not adapted:
  // their subject is the deleted `mergeHelpers.ts` (see the retirement block).
  test("the real surface is PRESENT and R5 is SATISFIED against the real manifests", () => {
    const report = check();
    expect(report.authoritySurface).toBe("PRESENT");
    expect(invariant(report, "R5").verdict).toBe("SATISFIED");
    expect(report.ok).toBe(true);
  });

  test.each([...AUTHORITY_TABLES])("removing %s from RESET_TABLES is a violation", (table) => {
    expect(invariant(check(), "R5").verdict).toBe("SATISFIED"); // green control

    const stripped = editFile(RESET, [`\n  "${table}",\n`, "\n"]);
    const result = invariant(check({ [RESET]: stripped }), "R5");
    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain("RESET_TABLES");
    expect(result.violations.join("\n")).toContain(table);
  });

  test.each([...AUTHORITY_TABLES])(
    "removing %s from ORGANIZATION_DELETION_STEPS is a violation",
    (table) => {
      expect(invariant(check(), "R5").verdict).toBe("SATISFIED"); // green control

      const stripped = editFile(ADMIN_ORGS, [
        `  { kind: "orgRows", table: "${table}", index: "by_org" },\n`,
        "",
      ]);
      const result = invariant(check({ [ADMIN_ORGS]: stripped }), "R5");
      expect(result.verdict).toBe("VIOLATED");
      expect(result.violations.join("\n")).toContain("ORGANIZATION_DELETION_STEPS");
      expect(result.violations.join("\n")).toContain(table);
    }
  );

  test("a HALF-declared surface is a violation in itself, not a ratchet that stays asleep", () => {
    const report = check(partialSurface());
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

  test("the REAL owner module's own inserts are permitted, and there are some", () => {
    // ⚠️ RE-BASELINED. This used to overlay a three-line owner stub, because no
    // owner module existed. 218-C ships one. Asserting the COUNT is the point:
    // "all 0 source sites are inside the owner module" was vacuously true before,
    // and would be vacuously true again if the enumeration ever went blind.
    const result = invariant(check(), "R6");
    expect(result.verdict).toBe("SATISFIED");
    expect(result.proved).toContain(AUTHORITY_OWNER_MODULE);
    expect(Number(/all (\d+) source sites/.exec(result.proved)?.[1])).toBeGreaterThan(0);
  });

  test("the fixture exemption is a LIST, not a `*.test.ts` wildcard", () => {
    // A wildcard would let a production module be exempted by renaming it. The
    // listed fixture is allowed; an unlisted test file is not.
    const listed = AUTHORITY_INSERT_FIXTURE_EXCLUSIONS[0] as string;
    const fixture =
      'const t = { db: { insert: (_a: string, _b: unknown) => 0 } };\nt.db.insert("receiptMovements", {});\n';
    expect(invariant(check({ [listed]: fixture }), "R6").verdict).toBe("SATISFIED");

    const result = invariant(check({ [listed]: fixture, "convex/someOther.test.ts": fixture }), "R6");
    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain("convex/someOther.test.ts");
  });

  test("an exempted site is still counted and PRINTED, never hidden", () => {
    const listed = AUTHORITY_INSERT_FIXTURE_EXCLUSIONS[0] as string;
    const report = check({
      [listed]:
        'declare const db: { insert: (a: string, b: unknown) => number };\ndb.insert("receiptApplications", {});\n',
    });
    expect(report.exemptedInsertSites.map((s) => s.file)).toContain(listed);
    expect(formatRatchetReport(report)).toContain("EXPLICITLY EXEMPTED FIXTURE SITES");
    expect(formatRatchetReport(report)).toContain(listed);
  });

  test("the owner module going missing while the surface exists is a violation", () => {
    const result = invariant(check({ [AUTHORITY_OWNER_MODULE]: null }), "R6");
    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain(AUTHORITY_OWNER_MODULE);
  });
});

/* ------------------------------------------------------------------ *
 * 4. A subject we cannot read is a VIOLATION, never a pass
 * ------------------------------------------------------------------ */

describe("an unreadable or unparsable subject fails closed", () => {
  // ⚠️ `deleting mergeHelpers.ts violates R1 and R3 rather than satisfying them`
  // used to be the first test here, and it is REMOVED rather than inverted. The
  // polarity it pinned is still correct and is still enforced — for a module that
  // is READABLE BUT UNPARSABLE, in `the retirement precondition is the module's
  // absence, nothing weaker`. What no longer applies is the case where the module
  // is simply gone: that is now a deliberate product decision (SCRUM-314), not an
  // unreadable subject, and it is recorded as RETIRED rather than counted either
  // way. See the retirement block above.

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

    test("CONTROL: the unedited schema enumerates completely and reports PRESENT", () => {
      // ⚠️ RE-BASELINED from ABSENT: 218-C declares the three tables. The control
      // still exists for the same reason — a blinded enumeration and a real one
      // must be distinguishable — only the expected answer moved.
      const report = check();
      expect(report.authoritySurface).toBe("PRESENT");
      expect(report.schemaTablesInspected).toBeGreaterThan(100);
      expect(report.invariants.find((i) => i.id === "R0")).toBeUndefined();
    });
  });

  // `a registry whose entries are not object literals is a violation, not an
  // empty pass` was REMOVED with R1/R3's subject. It edited
  // `CUSTOMER_REFERENCING_TABLES`, which has no declaration anywhere at this
  // head. The equivalent hazard for the surviving rules is covered by the
  // ADMIN_TABLES control immediately below and by the R4 smuggling battery.

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
    check(absentSurface()),
    check(partialSurface()),
    check({ [ADMIN_DATA]: null }),
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
    //
    // ⚠️ RE-BASELINED. Before 218-C this asserted "all 0 source sites", which was
    // also what a completely blind scan would print. The owner module now mints
    // real rows, so the number is the count of ITS inserts and nobody else's —
    // an assertion a blind scan can no longer satisfy.
    const sites = findAuthorityInserts(readReal(AUTHORITY_OWNER_MODULE), AUTHORITY_OWNER_MODULE);
    expect(sites.length).toBeGreaterThan(0);
    expect(invariant(check(), "R6").proved).toContain(`all ${sites.length} source sites`);
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
    expect(invariant(check(), "R5").verdict).toBe("SATISFIED");
  });
});

describe("INACTIVE is reserved for a surface PROVED absent", () => {
  test("CONTROL: with the three declarations removed the surface is ABSENT and R5 is INACTIVE", () => {
    // ⚠️ RE-BASELINED. This used to run against the unedited repository, because
    // the tables did not exist there. They do now, so the ABSENT case is
    // reconstructed from the real schema. R2 is no longer asserted here: it is
    // RETIRED with its deleted subject and is never INACTIVE again.
    const report = check(absentSurface());
    expect(report.authoritySurface).toBe("ABSENT");
    expect(invariant(report, "R5").verdict).toBe("INACTIVE");
    expect(invariant(report, "R2").verdict).toBe("RETIRED");
  });

  test.each([
    ["PARTIAL", partialSurface],
    ["UNREADABLE", (): Record<string, string | null> => ({ [SCHEMA]: "export default 42;" })],
  ])("a %s surface makes R5 VIOLATED, never INACTIVE", (_label, build) => {
    const report = check(build());
    const result = invariant(report, "R5");
    // "the subject does not exist yet" and "I could not tell" are different
    // claims, and only the first one is INACTIVE.
    expect(result.verdict).not.toBe("INACTIVE");
    expect(result.verdict).toBe("VIOLATED");
    expect(result.violations.join("\n")).toContain("could not be decided");
    expect(report.ok).toBe(false);
  });

  test("no report prints an INACTIVE verdict for a surface that is not ABSENT", () => {
    for (const overlay of [
      {},
      absentSurface(),
      partialSurface(),
      { [SCHEMA]: "export default 42;" },
    ] as Record<string, string | null>[]) {
      const report = check(overlay);
      if (report.invariants.some((i) => i.verdict === "INACTIVE")) {
        expect(report.authoritySurface).toBe("ABSENT");
      }
    }
  });
});
