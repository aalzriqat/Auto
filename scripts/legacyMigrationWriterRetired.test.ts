/**
 * SCRUM-234 — static guard: the retired legacy-migration writer stays retired,
 * and no production module regains a literal `transactions` source family.
 *
 * `accountingMigration.migrateUnpostedTransactions` was the only production
 * function that originated an accounting event from a legacy `transactions`
 * row, and it is retired. A behavioral test cannot establish that absence — it
 * can only knock on the doors it already knows about, so it would stay green if
 * the writer were reintroduced somewhere else under another name. This is a
 * source-level enumeration instead, in the same spirit as the other guards in
 * this directory (`tenantWriteGuard`, `commitmentWriteGuard`).
 *
 * It lives in `scripts/` rather than `convex/` for a mechanical reason: it reads
 * the filesystem, and a `node:fs` import inside `convex/` is rejected because
 * Convex's default runtime is a V8 isolate with no Node builtins.
 *
 * ─── WHAT THIS GUARD DOES **NOT** PROVE ──────────────────────────────────────
 *
 * Stated plainly, because the first version of this file overclaimed and an
 * adversarial reviewer was right to refuse it:
 *
 * A literal-string scan cannot see a source type that arrives as a VARIABLE.
 * Three production surfaces legitimately forward one:
 *
 *   convex/accounting/postingEngine.ts   `cmd.sourceType`      (the shared engine)
 *   convex/accountingOutbox.ts           `args/p/cmd.sourceType` (queue + redrive)
 *   convex/accounting/reversals.ts       `original.sourceType`   (reversal copies it)
 *
 * and `convex/accountingLedger.ts` exposes `post` as an `internalMutation`
 * taking a free-form `sourceType: v.string()`. An operator with deployment
 * credentials could therefore still hand-post a `transactions`-sourced event
 * through `npx convex run`, exactly as that same operator can already write
 * arbitrary rows through the Convex dashboard or `adminData.ts`'s raw-JSON
 * editor. That surface is PRE-EXISTING, has zero production callers, is not
 * reachable by any client, and is not created or widened by SCRUM-234.
 *
 * So this guard proves: **no production module names the legacy `transactions`
 * source family in a posting call.** It does NOT prove that the posting engine
 * refuses that family. Whether it should is routed to the owner.
 *
 * ⚠️ CORRECTION. An earlier version of this comment justified that routing by
 * claiming a blanket engine refusal "would make historical
 * `transactions`-sourced events unreversible". **That claim was FALSE**, and both
 * review seats refuted it independently. `reverseAccountingEvent` does NOT go
 * through `postAccountingEvent` at all — it inserts its own `accountingEvents`
 * and `journalEntries` rows directly (`reversals.ts:110` and `:129`), and
 * `postingRules.ts:77-78` already said so in as many words: "JOURNAL_REVERSAL is
 * intentionally excluded: it is written directly by reverseAccountingEvent() in
 * reversals.ts and never goes through postAccountingEvent()."
 *
 * The correction matters because it makes the routed option CHEAPER than it was
 * described: a refusal inside `postAccountingEvent` would leave reversal
 * untouched, and needs no coordinated "reversal source policy" for correctness.
 * Whether reversal of legacy-sourced history should ALSO be curtailed is a real
 * but separate question, not an automatic consequence of the engine refusal.
 *
 * The surviving reasons for routing rather than fixing here are scope — this lane
 * retires one mutation, not the shared engine every domain posts through — and
 * that the surface is pre-existing, has zero production callers, and is
 * unreachable by any client.
 *
 * ⚠️ An executable pin of those forwarding surfaces was TRIED and DELETED rather
 * than reworded. `sourceType` is an overloaded field name in this schema —
 * receivables use it for `INTERNAL_INSTALLMENT`/`CHEQUE`, vehicles for
 * `STOCK`/`SOURCED` — so every textual predicate wide enough to catch
 * `cmd.sourceType` also caught `collections.ts`, `vehicles.ts`, `subledger.ts`
 * and `applications.ts`, which have nothing to do with accounting-event source
 * families. Measured: 14 files on the first predicate, 9 on the second. A pin
 * that fails whenever an unrelated lane edits a vehicle would be deleted by the
 * next engineer who hit it, which is worse than no pin at all. Separating them
 * needs an AST, and building one for a single string literal is out of
 * proportion to the risk. So the blind spot is documented here, in prose,
 * instead of being papered over by a third regex.
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
 * Without this the guard would fail on its own subject: the retirement notice in
 * `accountingMigration.ts` quotes the very string being searched for, and a
 * guard that cannot survive being documented is a guard nobody will keep.
 */
export function stripComments(source: string): string {
  const blockComment = new RegExp("/\\*[\\s\\S]*?\\*/", "g");
  return source.replace(blockComment, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Matches `sourceType:` bound to the literal `transactions` in ANY quote style.
 *
 * The first version of this guard matched double quotes only. `eslint.config.mjs`
 * already records this team hitting the identical failure mode on a structurally
 * identical problem — a regex guard that missed single-quoted specifiers — which
 * is why that check was moved onto an AST-aware rule. Nothing here enforces a
 * quote style: there is no ESLint `quotes` rule configured, and no CI step runs
 * `prettier --check`, so a single-quoted reintroduction would otherwise pass
 * lint, typecheck and this guard together.
 */
export const LEGACY_SOURCE_LITERAL =
  /["'`]?sourceType["'`]?\s*:\s*\(?\s*(["'`])transactions\1/;

/**
 * The remedy SCRUM-234 made impossible: "run the migration tools".
 *
 * Case-insensitive on purpose. The first version was `/[Rr]un the migration
 * tools/`, a hand-rolled single-character case fold that missed
 * "RUN THE MIGRATION TOOLS" and "run the Migration Tools" — verified false by
 * execution. A guard whose whole job is "this defect must not come back" must
 * not be weaker than the one sitting beside it in the same file.
 */
export const RETIRED_REMEDY_PHRASE = /run the migration tools/i;

describe("SCRUM-234 — the legacy transactions GL writer stays retired", () => {
  test("the enumeration itself is not vacuous", () => {
    // A scan that silently found no files would pass every assertion below, and
    // an empty enumeration is indistinguishable from a true absence.
    const files = convexSourceFiles(CONVEX_DIR);
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(MIGRATION_MODULE);
    // The engine and the forwarding surfaces named in the header must still be
    // where the header says they are, so that documented limitation cannot go
    // stale without someone noticing.
    for (const surface of [
      join(CONVEX_DIR, "accounting", "postingEngine.ts"),
      join(CONVEX_DIR, "accounting", "reversals.ts"),
      join(CONVEX_DIR, "accountingOutbox.ts"),
      join(CONVEX_DIR, "accountingLedger.ts"),
    ]) {
      expect(files).toContain(surface);
    }
  });

  test("the literal matcher catches every quote style, not just the one in use", () => {
    // The guard's own blind spot, tested directly rather than assumed away.
    expect(LEGACY_SOURCE_LITERAL.test('sourceType: "transactions"')).toBe(true);
    expect(LEGACY_SOURCE_LITERAL.test("sourceType: 'transactions'")).toBe(true);
    expect(LEGACY_SOURCE_LITERAL.test("sourceType: `transactions`")).toBe(true);
    expect(LEGACY_SOURCE_LITERAL.test('sourceType:"transactions"')).toBe(true);
    expect(LEGACY_SOURCE_LITERAL.test('sourceType: "collectionPayments"')).toBe(false);
    // Both of these returned FALSE against the previous version of this regex,
    // so they are failing-first cases, not decorative ones.
    expect(LEGACY_SOURCE_LITERAL.test('"sourceType": "transactions"')).toBe(true);
    expect(LEGACY_SOURCE_LITERAL.test('sourceType: ("transactions")')).toBe(true);
  });

  test("the remedy-phrase matcher catches every casing, not just the one in use", () => {
    // The same defect class as the quote-style blind spot above, in the sibling
    // regex added in the same commit. All three of these returned FALSE against
    // the previous `[Rr]un the migration tools` pattern.
    expect(RETIRED_REMEDY_PHRASE.test("RUN THE MIGRATION TOOLS.")).toBe(true);
    expect(RETIRED_REMEDY_PHRASE.test("Please run the Migration Tools to fix this.")).toBe(true);
    expect(RETIRED_REMEDY_PHRASE.test("Kindly RUN the migration tools before signing off.")).toBe(true);
    expect(RETIRED_REMEDY_PHRASE.test("Clear the rows with the accounting reset.")).toBe(false);
  });

  test("reversal does not route through the posting engine — the fact the routing note rests on", () => {
    // Pinned so the architectural fact in this file's header cannot drift
    // silently. An earlier version of that header asserted the OPPOSITE and was
    // refuted by both review seats; a claim that load-bearing should be held by
    // an assertion, not by prose alone.
    const reversals = stripComments(readFileSync(join(CONVEX_DIR, "accounting", "reversals.ts"), "utf8"));
    expect(reversals).not.toMatch(/postAccountingEvent/);
    expect(readFileSync(join(CONVEX_DIR, "accounting", "postingRules.ts"), "utf8"))
      .toMatch(/never goes through postAccountingEvent/);
  });

  test("no production convex module names the legacy transactions source family", () => {
    const offenders = convexSourceFiles(CONVEX_DIR).filter((file) =>
      LEGACY_SOURCE_LITERAL.test(stripComments(readFileSync(file, "utf8")))
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
    // it — the owner ruling keeps them, and they are what the refusal message
    // points a launch operator at.
    const source = readFileSync(MIGRATION_MODULE, "utf8");
    for (const surface of ["auditLegacyTransactions", "duplicateEventCheck", "migrationGapAnalysis"]) {
      expect(source).toMatch(new RegExp(`export const ${surface} = query\\(`));
    }
  });

  test("no surviving refusal message points an operator at the retired migration tools", () => {
    // SCRUM-234 made "run the migration tools" an impossible instruction. A
    // thrown error must not name a remedy that no longer exists — both review
    // seats blocked on `accountingCutover.signOffCutover` saying exactly that.
    const offenders = convexSourceFiles(CONVEX_DIR).filter((file) =>
      RETIRED_REMEDY_PHRASE.test(stripComments(readFileSync(file, "utf8")))
    );
    expect(offenders).toEqual([]);
  });
});
