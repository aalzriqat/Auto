import { expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The aggregate component is only correct if *every* write to a counted table
 * goes through a mutation whose ctx.db fires the triggers in
 * `convex/functions.ts`.
 *
 * This is the dangerous class of bug, because it fails open: a mutation built
 * from the raw `_generated/server` builder writes the row perfectly well and
 * simply doesn't tell the B-tree. Nothing throws, nothing logs, and the
 * dashboard quietly reports a number that drifts further from the truth on
 * every such write. There is no runtime signal to alert on — so the guard has
 * to be at build time, and it has to be exhaustive rather than a list of known
 * offenders.
 */

const CONVEX_DIR = path.join(process.cwd(), "convex");
/** Only this module may take the unwrapped builders — it is what wraps them. */
const ALLOWED = new Set(["functions.ts"]);

function convexModules(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_generated") continue;
      convexModules(full, acc);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

test("no Convex module imports a mutation builder straight from _generated/server", () => {
  const offenders: string[] = [];

  for (const file of convexModules(CONVEX_DIR)) {
    const rel = path.relative(CONVEX_DIR, file).split(path.sep).join("/");
    if (ALLOWED.has(rel)) continue;

    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*"\.{1,2}\/_generated\/server"/g,
    )) {
      const names = match[1].split(",").map((n) => n.trim());
      if (names.includes("mutation") || names.includes("internalMutation")) {
        offenders.push(rel);
      }
    }
  }

  expect(offenders).toEqual([]);
});

test("a trigger is registered for every table an aggregate counts", () => {
  // Mounting an aggregate without registering its trigger is the same
  // fail-open bug one level up: the tree exists, nothing maintains it.
  const aggregates = fs.readFileSync(path.join(CONVEX_DIR, "aggregates.ts"), "utf8");

  const countedTables = Array.from(
    aggregates.matchAll(/TableName:\s*"([A-Za-z]+)"/g),
  ).map((m) => m[1]);

  expect(countedTables.length).toBeGreaterThan(0);
  for (const table of countedTables) {
    expect(aggregates).toContain(`aggregateTriggers.register("${table}"`);
  }
});
