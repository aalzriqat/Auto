/**
 * SCRUM-297 — structural ratchet: every writer that returns an organization to
 * service must consult the irreversible-purge guard.
 *
 * The first version of that fix guarded `unsuspendOrg` and missed
 * `rejectDeletionRequest`, which clears `suspended` with exactly the same
 * effect. Nothing in the toolchain could tell the two apart — one had a guard,
 * the other had a comment explaining why it did not need one, and the comment
 * was wrong.
 *
 * This is deliberately a SOURCE test rather than a behavioral one. A behavioral
 * test can only exercise the reactivation paths somebody already thought of;
 * the defect here was a path nobody enumerated. Checking the source means a
 * THIRD writer of `suspended: false` fails this test the moment it is written,
 * whether or not anyone remembers to test it.
 *
 * ⚠️ If this fails because you added a legitimate new reactivation path, the fix
 * is to call `assertNoIrreversiblePurgeHistory` in it — not to add it to an
 * exemption list.
 *
 * ⚠️ WHAT THIS ACTUALLY GUARANTEES, which is less than it first claimed.
 * It catches a new writer spelled as an object literal `suspended: false`
 * inside a `ctx.db.patch(...)`. It does NOT defeat deliberate obfuscation: a
 * computed key (`{ [field]: false }`) or a patch object built once and reused
 * from several call sites would still undercount, because this reads text
 * rather than the syntax tree. It is a detective control against the ACCIDENTAL
 * addition that actually happened here, not a proof of absence.
 *
 * That distinction is the finding that produced this paragraph: the first
 * version of this docstring promised a third writer "fails this test the moment
 * it is written, whether or not anyone remembers to test it", while the
 * heuristic below silently returned zero for a genuine write whose preceding
 * COMMENT happened to contain the substring "after:". A detective control that
 * overclaims is worse than none — it manufactures confidence. Comments are now
 * stripped before counting and the audit-payload exclusion is anchored to
 * `after: {`, and the meta-tests at the bottom of this file pin both.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

const CONVEX_DIR = path.join(__dirname, "..", "convex");

/** Every non-test source file under convex/, recursively. */
function convexSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_generated") continue;
      out.push(...convexSourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * Blank out comments while preserving offsets, so a comment can never be
 * mistaken for code. Lengths are kept identical so every index computed against
 * the result still lines up with the original source.
 */
function stripComments(source: string) {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank);
}

/** Index of the last match of `pattern` at or before `limit`, or -1. */
function lastMatchIndex(source: string, pattern: RegExp, limit: number) {
  let found = -1;
  for (const match of source.matchAll(pattern)) {
    if (match.index === undefined || match.index >= limit) break;
    found = match.index;
  }
  return found;
}

/**
 * A write that clears suspension. Matches the object-literal form the codebase
 * uses; the audit-log lines that merely REPORT `suspended: false` are excluded
 * because they sit inside an `after: {` payload rather than a `ctx.db.patch`.
 *
 * The `after:` exclusion is anchored to `after: {` rather than the bare
 * substring — "after:" alone occurs in ordinary prose, and matching it there
 * silently suppressed a real write. See the meta-tests below.
 */
export function countReactivatingWrites(rawSource: string) {
  const source = stripComments(rawSource);
  let count = 0;
  for (const match of source.matchAll(/suspended:\s*false/g)) {
    if (match.index === undefined) continue;
    const lastPatch = lastMatchIndex(source, /ctx\.db\.patch\(/g, match.index);
    const lastAfter = lastMatchIndex(source, /after:\s*\{/g, match.index);
    if (lastPatch > lastAfter) count += 1;
  }
  return count;
}

describe("SCRUM-297 organization reactivation guard", () => {
  test("every file that reactivates an organization also calls the guard", () => {
    const offenders: string[] = [];

    for (const file of convexSourceFiles(CONVEX_DIR)) {
      const source = fs.readFileSync(file, "utf8");
      const writes = countReactivatingWrites(source);
      if (writes === 0) continue;

      const guards = source.match(/assertNoIrreversiblePurgeHistory\(/g)?.length ?? 0;
      // One definition plus one call per write, when the guard lives in this file.
      const defines = source.includes("async function assertNoIrreversiblePurgeHistory");
      const calls = defines ? guards - 1 : guards;

      if (calls < writes) {
        offenders.push(
          `${path.relative(CONVEX_DIR, file)}: ${writes} reactivating write(s), ${calls} guard call(s)`
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the reactivating writes are where we think they are", () => {
    // Pins the blast radius itself. If reactivation spreads to a new file, this
    // fails even when that file happens to guard itself correctly — a new
    // reactivation surface is a decision worth making on purpose.
    const files = convexSourceFiles(CONVEX_DIR)
      .filter((file) => countReactivatingWrites(fs.readFileSync(file, "utf8")) > 0)
      .map((file) => path.relative(CONVEX_DIR, file).replace(/\\/g, "/"))
      .sort();

    expect(files).toEqual(["adminOrgs.ts"]);
  });

  /**
   * Meta-tests for the detector itself.
   *
   * A ratchet nobody tests is a ratchet nobody knows is broken. The first
   * version of this file undercounted a real write whose preceding comment
   * contained "after:" — a false green in the exact direction that matters,
   * found by an adversarial reviewer rather than by this suite.
   */
  describe("the detector itself", () => {
    test("counts a real write whose comment happens to contain the word after:", () => {
      const source = [
        "await ctx.db.patch(args.orgId, {",
        "  // safe to flip suspended after: the support ticket is closed",
        "  suspended: false,",
        "});",
      ].join("\n");

      expect(countReactivatingWrites(source)).toBe(1);
    });

    test("counts a real write inside a block comment mentioning an audit after: payload", () => {
      const source = [
        "/**",
        " * Mirrors the shape logged as after: { suspended: false }.",
        " */",
        "await ctx.db.patch(args.orgId, { suspended: false });",
      ].join("\n");

      expect(countReactivatingWrites(source)).toBe(1);
    });

    test("still ignores the audit payload that only REPORTS the change", () => {
      const source = 'logAdminAction(ctx, admin, { after: { suspended: false } });';

      expect(countReactivatingWrites(source)).toBe(0);
    });

    test("finds both real writers in the production file", () => {
      const source = fs.readFileSync(path.join(CONVEX_DIR, "adminOrgs.ts"), "utf8");

      expect(countReactivatingWrites(source)).toBe(2);
    });
  });
});
