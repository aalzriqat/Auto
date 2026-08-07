import { expect, test, describe } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * `socialBulkMutation` suppresses the per-write conversation recompute so a
 * bulk loop does not re-read each thread once per event. The price is that the
 * handler owes the recompute itself.
 *
 * That obligation fails open in the worst way: the mutation writes its event
 * rows perfectly, returns success, and simply leaves `socialConversations`
 * describing a state that no longer exists. Nothing throws, nothing logs, and
 * the Social Inbox shows a stale thread summary until some unrelated write to
 * the same thread happens to fix it. There is no runtime signal to alert on, so
 * the guard has to be at build time and it has to be exhaustive rather than a
 * list of known callers.
 *
 * Same shape, and the same reasoning, as `aggregateWiring.test.ts`.
 */

const CONVEX_DIR = path.join(process.cwd(), "convex");
/** Only this module may hand out the deferred builder. */
const BUILDER_OWNER = "functions.ts";

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

describe("deferred conversation sync", () => {
  test("every module using socialBulkMutation also syncs the threads it touched", () => {
    const offenders: string[] = [];

    for (const file of convexModules(CONVEX_DIR)) {
      const rel = path.relative(CONVEX_DIR, file).split(path.sep).join("/");
      if (rel === BUILDER_OWNER) continue;

      const source = fs.readFileSync(file, "utf8");
      if (!source.includes("socialBulkMutation")) continue;

      // Matched as CALLS, not bare identifiers. Checking for the name alone
      // matched the import statement, so deleting the actual call left the
      // guard passing — a guard against a fail-open invariant that itself
      // failed open, which is the exact shape this file exists to prevent.
      // Both halves are required: collecting without syncing leaves the rows
      // stale, and syncing without collecting silently recomputes nothing.
      if (!source.includes("syncDeferredSocialThreads(")) {
        offenders.push(`${rel}: uses socialBulkMutation but never calls syncDeferredSocialThreads`);
      }
      if (!source.includes("collectSocialThread(")) {
        offenders.push(`${rel}: uses socialBulkMutation but never calls collectSocialThread`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the guard is armed — it can actually see the builder in use", () => {
    // A guard nobody has watched fail is not a guard. If the builder is ever
    // renamed, the scan above silently matches nothing and passes having
    // checked no files at all.
    const users = convexModules(CONVEX_DIR).filter((file) => {
      const rel = path.relative(CONVEX_DIR, file).split(path.sep).join("/");
      return rel !== BUILDER_OWNER && fs.readFileSync(file, "utf8").includes("socialBulkMutation");
    });

    expect(users.length).toBeGreaterThan(0);
    const names = users.map((f) => path.basename(f)).sort();
    expect(names).toEqual(["customers.ts", "socialInbox.ts"]);
  });

  test("the builder itself is only defined in functions.ts", () => {
    const definitions = convexModules(CONVEX_DIR).filter((file) =>
      fs.readFileSync(file, "utf8").includes("export const socialBulkMutation")
    );
    expect(definitions.map((f) => path.basename(f))).toEqual(["functions.ts"]);
  });
});
