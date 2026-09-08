/**
 * SCRUM-234 — static guard: no production module originates an accounting
 * event from a legacy `transactions` row.
 *
 * `accountingMigration.migrateUnpostedTransactions` was the only such writer,
 * and it is retired. A behavioral test cannot establish that absence: it can
 * only knock on the doors it already knows about, so it would stay green if the
 * writer were reintroduced somewhere else under another name. This is a
 * source-level enumeration of every non-test module under `convex/` instead,
 * which is the same shape as the other guards in this directory
 * (`tenantWriteGuard`, `commitmentWriteGuard`).
 *
 * It lives in `scripts/` rather than `convex/` for a mechanical reason: it
 * reads the filesystem, and a `node:fs` import inside `convex/` is rejected —
 * Convex's default runtime is a V8 isolate with no Node builtins.
 *
 * Scope boundary, stated so a future reader does not over-read this guard:
 * it forbids ORIGINATING an accounting event whose `sourceType` is the legacy
 * `transactions` table. It says nothing about reading such events (the audit
 * queries legitimately do), and nothing about the Phase 17 minor-unit backfills
 * in the same module, which widen existing money columns in place.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CONVEX_DIR = "convex";
const MIGRATION_MODULE = join(CONVEX_DIR, "accountingMigration.ts");

/** Every non-test, non-generated `.ts` module under `convex/`. */
function convexSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "_generated" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...convexSourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strips block and line comments.
 *
 * Without this the guard would fail on its own subject: the retirement notice
 * in `accountingMigration.ts` quotes the very string being searched for, and a
 * guard that cannot survive being documented is a guard nobody will keep.
 */
function stripComments(source: string): string {
  const blockComment = new RegExp("/\\*[\\s\\S]*?\\*/", "g");
  return source.replace(blockComment, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("SCRUM-234 — the legacy transactions GL writer stays retired", () => {
  test("the enumeration itself is not vacuous", () => {
    // A scan that silently found no files would pass every assertion below,
    // and an empty enumeration is indistinguishable from a true absence.
    const files = convexSourceFiles(CONVEX_DIR);
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(MIGRATION_MODULE);
  });

  test("no production convex module posts an accounting event sourced from transactions", () => {
    const offenders = convexSourceFiles(CONVEX_DIR).filter((file) =>
      /sourceType\s*:\s*"transactions"/.test(stripComments(readFileSync(file, "utf8")))
    );
    expect(offenders).toEqual([]);
  });

  test("migrateUnpostedTransactions reaches neither the posting engine nor the database", () => {
    const source = stripComments(readFileSync(MIGRATION_MODULE, "utf8"));
    const start = source.indexOf("export const migrateUnpostedTransactions");
    expect(start).toBeGreaterThan(-1);

    const fromDeclaration = source.slice(start);
    const nextExport = fromDeclaration.indexOf("\nexport const ", 1);
    const body = nextExport === -1 ? fromDeclaration : fromDeclaration.slice(0, nextExport);

    expect(body).not.toMatch(/postAccountingEvent/);
    expect(body).not.toMatch(/ctx\.db\.(insert|patch|replace|delete)/);
    // And it fails closed rather than returning an empty success.
    expect(body).toMatch(/throw new ConvexError/);
  });

  test("the module still exposes its read-only audit surface", () => {
    // Retiring the writer must not quietly take the truthful diagnostics with
    // it — the owner ruling keeps them, and they are what a launch operator is
    // pointed at by the refusal message.
    const source = readFileSync(MIGRATION_MODULE, "utf8");
    for (const surface of ["auditLegacyTransactions", "duplicateEventCheck", "migrationGapAnalysis"]) {
      expect(source).toMatch(new RegExp(`export const ${surface} = query\\(`));
    }
  });
});
