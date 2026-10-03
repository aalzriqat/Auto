/**
 * SCRUM-565 N1 — the journalLines <-> accountSnapshots pairing ratchet.
 *
 * INVARIANT: the all-time ledger position of an account is the sum of its
 * accountSnapshots, so a source file that inserts a `journalLines` row without
 * also maintaining the snapshot silently diverges the two. The planned reset
 * preflight (SCRUM-565 S1b) will read the snapshot sum as the proof that
 * nothing was posted, which would make an unpaired writer a way to evade it.
 *
 * Enforcement is file-level and deliberately conservative: every non-test
 * convex source that contains an `insert("journalLines"` must also reference
 * `incrementAccountSnapshot(`. The manifest below pins the exact writer set, so
 * a NEW journalLines writer fails this test until it is reviewed and listed,
 * and a writer that stops pairing fails it too.
 *
 * Scope boundary: this proves the two calls live in the same file, not that
 * every code path through the file reaches both. It is a ratchet against a new
 * unpaired door, not a proof of per-path atomicity.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { convexSourceFiles } from "./commitmentWriteGuard";

const CONVEX_ROOT = path.resolve(__dirname, "..", "convex");

const JOURNAL_LINES_INSERT = /\.insert\(\s*["'`]journalLines["'`]/g;
const SNAPSHOT_INCREMENT = /\bincrementAccountSnapshot\s*\(/;

export interface JournalLinesWriter {
  file: string;
  inserts: number;
  paired: boolean;
}

/** Pure scanner: classify one source text. Returns null when it writes no journalLines. */
export function scanSource(file: string, text: string): JournalLinesWriter | null {
  const inserts = (text.match(JOURNAL_LINES_INSERT) ?? []).length;
  if (inserts === 0) return null;
  return { file, inserts, paired: SNAPSHOT_INCREMENT.test(text) };
}

function scanTree(): JournalLinesWriter[] {
  const writers: JournalLinesWriter[] = [];
  for (const full of convexSourceFiles(CONVEX_ROOT)) {
    const rel = path.relative(CONVEX_ROOT, full).split(path.sep).join("/");
    const hit = scanSource(rel, fs.readFileSync(full, "utf8"));
    if (hit) writers.push(hit);
  }
  return writers.sort((a, b) => a.file.localeCompare(b.file));
}

/** Every file that writes journalLines today, with its insert-site count. */
const MANIFEST: Record<string, number> = {
  "accounting/postingEngine.ts": 1,
  "accounting/reversals.ts": 1,
  "accountingCutover.ts": 1,
  "financialAudit.ts": 1,
};

describe("SCRUM-565 N1 scanner self-tests (a guard nobody has watched fail is not a guard)", () => {
  test("a paired writer passes", () => {
    const hit = scanSource(
      "fixture/paired.ts",
      `await ctx.db.insert("journalLines", { a: 1 });\nawait incrementAccountSnapshot(ctx, args);`,
    );
    expect(hit).toEqual({ file: "fixture/paired.ts", inserts: 1, paired: true });
  });

  test("an unpaired writer is detected as unpaired", () => {
    const hit = scanSource(
      "fixture/unpaired.ts",
      `await ctx.db.insert('journalLines', { a: 1 });\nawait ctx.db.insert("journalLines", { a: 2 });`,
    );
    expect(hit).toEqual({ file: "fixture/unpaired.ts", inserts: 2, paired: false });
  });

  test("a mere import of the helper without a call does not count as pairing", () => {
    const hit = scanSource(
      "fixture/import-only.ts",
      `import { incrementAccountSnapshot } from "./x";\nawait ctx.db.insert("journalLines", {});`,
    );
    expect(hit?.paired).toBe(false);
  });

  test("a file that writes no journalLines is not a writer", () => {
    expect(scanSource("fixture/none.ts", `await ctx.db.insert("journalEntries", {});`)).toBeNull();
  });
});

describe("SCRUM-565 N1 journalLines writers are paired with the snapshot", () => {
  const writers = scanTree();

  test("the scan is live (finds writers rather than an empty tree)", () => {
    expect(writers.length).toBeGreaterThan(0);
  });

  test("every journalLines writer also maintains accountSnapshots", () => {
    const unpaired = writers.filter((w) => !w.paired).map((w) => w.file);
    expect(unpaired, `journalLines written without incrementAccountSnapshot: ${unpaired.join(", ")}`).toEqual([]);
  });

  test("the writer set and insert-site counts match the reviewed manifest exactly", () => {
    const observed = Object.fromEntries(writers.map((w) => [w.file, w.inserts]));
    expect(observed).toEqual(MANIFEST);
  });
});
