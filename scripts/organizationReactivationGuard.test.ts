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
 * A write that clears suspension. Matches the object-literal form the codebase
 * uses; the audit-log lines that merely REPORT `suspended: false` are excluded
 * because they sit inside an `after:` payload rather than a `ctx.db.patch`.
 */
function countReactivatingWrites(source: string) {
  let count = 0;
  for (const match of source.matchAll(/suspended:\s*false/g)) {
    const preceding = source.slice(Math.max(0, match.index - 400), match.index);
    // `after: { suspended: false }` in an audit payload is a description of the
    // change, not the change. Only a patch on the organizations row counts.
    const lastPatch = preceding.lastIndexOf("ctx.db.patch(");
    const lastAfter = preceding.lastIndexOf("after:");
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
});
