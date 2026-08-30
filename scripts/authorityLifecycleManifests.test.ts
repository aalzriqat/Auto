/**
 * SCRUM-208 c15825 — THE AUTHORITY LIFECYCLE TABLES MUST APPEAR IN EVERY
 * DESTRUCTIVE MANIFEST, NOT JUST THE ONE A GUARD HAPPENED TO WATCH.
 *
 * ⚠️ THIS GUARD EXISTS BECAUSE OF HOW THE LAST GAP WAS FOUND. When
 * `commitmentAuthorityWork` was introduced, `orgDeletionCoverage.test.ts`
 * failed because the table had no organization hard-delete step. I added the
 * step that guard asked for — and never asked which OTHER destructive path had
 * the same omission. `orgFinancialReset` did, and a reviewer found it, not me.
 *
 * One guard watching one manifest cannot tell you that a second manifest exists.
 * So the invariant is stated over the SET of destructive paths: a table in the
 * authority lifecycle must be removed by all of them, in dependency order.
 *
 * ⚠️ A RESET IS NOT A DELETE, AND THAT IS WHY IT IS EASY TO MISS. Hard deletion
 * removes the organization, so a surviving row is obviously orphaned. A
 * financial reset keeps the organization and clears its ledger — so authority
 * work left behind is not obviously wrong, it is just an instruction to settle
 * a car against a reversal that no longer exists, pointing at deleted
 * accounting rows, on a fresh ledger.
 */
import { describe, expect, test } from "vitest";
import { ORGANIZATION_DELETION_STEPS } from "../convex/adminOrgs";
import { RESET_TABLES_FOR_TEST } from "../convex/orgFinancialReset";

/**
 * The tables that carry deferred vehicle-authority settlement state, in
 * dependency order: each references the one after it.
 */
const AUTHORITY_LIFECYCLE_TABLES = [
  "commitmentAuthorityAttempt",
  "commitmentAuthorityWork",
  "pendingAccountingEvents",
] as const;

describe("authority lifecycle tables in destructive manifests", () => {
  test("organization hard deletion removes every one of them", () => {
    const deleted = ORGANIZATION_DELETION_STEPS.filter(
      (s): s is Extract<typeof s, { table: string }> => "table" in s
    ).map((s) => s.table as string);

    for (const table of AUTHORITY_LIFECYCLE_TABLES) {
      expect(
        deleted,
        `${table} carries authority settlement state and must be removed with its organization`
      ).toContain(table);
    }
  });

  test("financial reset clears every one of them", () => {
    for (const table of AUTHORITY_LIFECYCLE_TABLES) {
      expect(
        RESET_TABLES_FOR_TEST,
        `${table} survives a financial reset — it would instruct a settlement ` +
          `against accounting rows the same reset just deleted`
      ).toContain(table);
    }
  });

  test("both manifests remove them in dependency order", () => {
    // ⚠️ ORDER, NOT MERE PRESENCE. Each row points at the one below it, so a
    // manifest that removed the referent first would leave dangling pointers
    // for however long the step sequence takes — and these sequences are not
    // one transaction.
    const positionsIn = (manifest: readonly string[]) =>
      AUTHORITY_LIFECYCLE_TABLES.map((t) => manifest.indexOf(t));

    const deletionOrder = ORGANIZATION_DELETION_STEPS.filter(
      (s): s is Extract<typeof s, { table: string }> => "table" in s
    ).map((s) => s.table as string);

    for (const manifest of [deletionOrder, [...RESET_TABLES_FOR_TEST]]) {
      const positions = positionsIn(manifest);
      expect(positions.every((p) => p >= 0)).toBe(true);
      for (let i = 1; i < positions.length; i += 1) {
        expect(
          positions[i]! > positions[i - 1]!,
          `${AUTHORITY_LIFECYCLE_TABLES[i]} must be removed AFTER ` +
            `${AUTHORITY_LIFECYCLE_TABLES[i - 1]}, which references it`
        ).toBe(true);
      }
    }
  });
});
