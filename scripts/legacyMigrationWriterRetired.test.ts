/**
 * SCRUM-234 — structural assertions on the retired legacy-migration writer.
 *
 * `accountingMigration.migrateUnpostedTransactions` was the only production
 * function that originated an accounting event from a legacy `transactions`
 * row. It is retired: its handler is a single unconditional throw. The tests
 * below pin that one function's shape, so the retirement cannot be quietly
 * undone by editing it back.
 *
 * It lives in `scripts/` rather than `convex/` for a mechanical reason: it reads
 * the filesystem, and a `node:fs` import inside `convex/` is rejected because
 * Convex's default runtime is a V8 isolate with no Node builtins.
 *
 * ─── WHAT THIS FILE DELIBERATELY NO LONGER DOES ──────────────────────────────
 *
 * Earlier versions swept every non-test module under `convex/` with regexes, to
 * assert that no OTHER module names the legacy `transactions` source family or
 * points an operator at the retired migration tools. **That sweep is deleted,
 * and it is not coming back as a fourth regex.**
 *
 * It failed the same way three times, and the failures were the design, not the
 * patches. Across three revisions it produced: a double-quote-only matcher that
 * missed `'transactions'`; an over-broad forwarding pin that flagged
 * `collections.ts`, `vehicles.ts`, `subledger.ts` and `applications.ts` because
 * `sourceType` is an overloaded field name (receivables use it for
 * `INTERNAL_INSTALLMENT`/`CHEQUE`, vehicles for `STOCK`/`SOURCED`); a
 * hand-rolled `[Rr]` case fold that missed `RUN THE MIGRATION TOOLS`; a false
 * positive on harmless quoted JSON such as `'{"sourceType": "transactions"}'`;
 * a false negative on the computed key `{ ["sourceType"]: "transactions" }`; a
 * missing left word boundary that matched `resourceType: "transactions"`, a
 * convention already used 33 times in the very tree it scanned; and a
 * "reversal does not route through the posting engine" test that actually
 * asserted against a COMMENT in `postingRules.ts` — a comment describing a
 * guard is not the guard.
 *
 * Every one of those is the same fault: **a textual scan certifying a semantic
 * property it cannot measure.** Both review seats independently concluded the
 * current claims should not ship, and the adversarial-review convergence
 * breaker applies — a subsystem that injures itself repeatedly is reporting a
 * design fault, not a bad last patch.
 *
 * So the honest position is recorded here rather than simulated by a regex:
 *
 *   **Nothing prevents a future module from posting an accounting event under
 *   the legacy `transactions` source family.** `postAccountingEvent` accepts a
 *   caller-supplied `sourceType`, `accountingLedger.post` exposes it as a
 *   free-form `v.string()` on an `internalMutation`, and the outbox forwards a
 *   stored one on redrive. Enforcing the retirement there — a refusal at the
 *   posting boundary — is real enforcement and is the open question routed to
 *   the owner. A repo-wide grep was never a substitute for it, and pretending
 *   otherwise was worse than having nothing, because it read as coverage.
 *
 * Note for whoever implements that refusal: it would NOT affect reversal.
 * `reverseAccountingEvent` writes its own `accountingEvents` and
 * `journalEntries` rows directly and never calls `postAccountingEvent` — see
 * `convex/accounting/reversals.ts` and the standing comment in
 * `convex/accounting/postingRules.ts`. An earlier version of this file claimed
 * the opposite; that claim was false and is retracted.
 *
 * The behavioral evidence that the retirement actually holds lives in
 * `convex/accountingMigrationRetirement.test.ts`, which drives real domain
 * workflows and asserts a zero financial delta. That is the file to read to
 * know the retirement works; this one only pins the shape of the retired
 * function.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_MODULE = join("convex", "accountingMigration.ts");

/**
 * Strips block and line comments.
 *
 * Without this these assertions would pass on their own subject: the retirement
 * notice in `accountingMigration.ts` describes the very constructs being
 * checked for, and a check that cannot survive being documented is one nobody
 * will keep.
 */
function stripComments(source: string): string {
  const blockComment = new RegExp("/\\*[\\s\\S]*?\\*/", "g");
  return source.replace(blockComment, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The body of one exported declaration, comments removed. */
function exportedBody(source: string, name: string): string {
  const start = source.indexOf(`export const ${name}`);
  expect(start, `${name} should still be exported from ${MIGRATION_MODULE}`).toBeGreaterThan(-1);
  const fromDeclaration = source.slice(start);
  const nextExport = fromDeclaration.indexOf("\nexport const ", 1);
  return nextExport === -1 ? fromDeclaration : fromDeclaration.slice(0, nextExport);
}

describe("SCRUM-234 — the retired migration writer keeps its retired shape", () => {
  test("migrateUnpostedTransactions reaches neither the posting engine nor the database", () => {
    const source = stripComments(readFileSync(MIGRATION_MODULE, "utf8"));
    const body = exportedBody(source, "migrateUnpostedTransactions");

    expect(body).not.toMatch(/postAccountingEvent/);
    expect(body).not.toMatch(/ctx\.db\.(insert|patch|replace|delete)/);
    // And it fails closed rather than returning an empty success.
    expect(body).toMatch(/throw new ConvexError/);
  });

  test("its refusal is unconditional — no branch, no argument, no caller check", () => {
    // The owner's requirement is that the refusal lands before classification,
    // posting, migration bookkeeping and any mutation of a legacy row. The
    // strongest available form of that is a handler with no conditional at all,
    // which is what this asserts: `dryRun` cannot become an authority boundary
    // again without this failing.
    const source = stripComments(readFileSync(MIGRATION_MODULE, "utf8"));
    const body = exportedBody(source, "migrateUnpostedTransactions");
    const handler = body.slice(body.indexOf("handler:"));

    expect(handler).not.toMatch(/\bif\b/);
    expect(handler).not.toMatch(/\bdryRun\b/);
    expect(handler).not.toMatch(/requireTenantAuth/);
  });

  test("the module still exposes its read-only audit surface", () => {
    // Retiring the writer must not quietly take the truthful diagnostics with
    // it — the owner ruling keeps them, and they are what the refusal message
    // points a launch operator at.
    const source = readFileSync(MIGRATION_MODULE, "utf8");
    for (const surface of ["auditLegacyTransactions", "duplicateEventCheck", "migrationGapAnalysis"]) {
      expect(source).toMatch(new RegExp(`export const ${surface} = query\\(`));
    }
  });
});
