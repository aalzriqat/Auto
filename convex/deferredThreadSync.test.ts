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
 * the inbox shows a stale thread summary until some unrelated write to the same
 * thread happens to fix it. There is no runtime signal to alert on, so the
 * guard has to be at build time and it has to be exhaustive.
 *
 * ## Why this checks each mutation, not each file
 *
 * The first version scanned whole modules. That passed as soon as *any*
 * mutation in the file synced — so a second, non-syncing `socialBulkMutation`
 * added later was invisible. That is not hypothetical: `socialInbox.ts` no
 * longer imports the ordinary `mutation` builder at all, so the deferred one is
 * what a future author reaches for by default in exactly the module where the
 * next such mutation would be written.
 *
 * It also stripped nothing, so a comment mentioning `syncDeferredSocialThreads(`
 * satisfied it. Both holes are the same shape as the bug the file exists to
 * prevent, and both are closed below.
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

/** Comments cannot satisfy the obligation, so they are removed before scanning. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * One entry per exported Convex function, split on the same boundary
 * `scripts/tenantWriteGuard.ts` uses.
 */
export function deferredMutationOffenders(source: string, rel: string): string[] {
  const offenders: string[] = [];
  const code = stripComments(source);

  for (const raw of code.split(/\nexport const /).slice(1)) {
    const whole = "export const " + raw;
    // Bounded at this definition's own closing `});`. Splitting alone runs a
    // chunk to the next `export const` — or to EOF for the last one — so a
    // non-exported helper defined *after* an offending mutation leaked its
    // calls into the offender's chunk and the offender went unreported.
    const end = whole.search(/\n\}\);/);
    const chunk = end === -1 ? whole : whole.slice(0, end);
    const name = raw.match(/^(\w+)/)?.[1];
    if (!name) continue;
    if (!/=\s*socialBulkMutation\(/.test(chunk)) continue;

    // Both halves are required. Collecting without syncing leaves the rows
    // stale; syncing without collecting recomputes an empty set, which looks
    // exactly like success.
    if (!chunk.includes("syncDeferredSocialThreads(")) {
      offenders.push(`${rel}:${name} uses socialBulkMutation but never calls syncDeferredSocialThreads`);
    }
    if (!chunk.includes("collectSocialThread(")) {
      offenders.push(`${rel}:${name} uses socialBulkMutation but never calls collectSocialThread`);
    }
  }

  return offenders;
}

describe("deferred conversation sync", () => {
  test("every mutation built on socialBulkMutation syncs the threads it touched", () => {
    const offenders: string[] = [];

    for (const file of convexModules(CONVEX_DIR)) {
      const rel = path.relative(CONVEX_DIR, file).split(path.sep).join("/");
      if (rel === BUILDER_OWNER) continue;
      offenders.push(...deferredMutationOffenders(fs.readFileSync(file, "utf8"), rel));
    }

    expect(offenders).toEqual([]);
  });

  test("a second non-syncing mutation in an already-compliant module is caught", () => {
    // The exact hole the per-file version had: `setConversationVehicle` syncs,
    // so the module passed no matter what was added beside it.
    const source = `
import { socialBulkMutation } from "./functions";

export const good = socialBulkMutation({
  args: {},
  handler: async (ctx) => {
    const threads = newDeferredSocialThreads();
    collectSocialThread(threads, "instagram", doc);
    await syncDeferredSocialThreads(ctx, threads);
  },
});

export const bad = socialBulkMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.patch(id, { vehicleId: undefined });
  },
});
`;
    const offenders = deferredMutationOffenders(source, "socialInbox.ts");
    expect(offenders).toEqual([
      "socialInbox.ts:bad uses socialBulkMutation but never calls syncDeferredSocialThreads",
      "socialInbox.ts:bad uses socialBulkMutation but never calls collectSocialThread",
    ]);
  });

  test("a comment mentioning the call does not satisfy the obligation", () => {
    const source = `
import { socialBulkMutation } from "./functions";

// Remember to call syncDeferredSocialThreads(ctx, threads) and
// collectSocialThread(threads, platform, doc) here.
export const bad = socialBulkMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.patch(id, {});
  },
});
`;
    expect(deferredMutationOffenders(source, "x.ts")).toHaveLength(2);
  });

  test("a helper defined after the offender cannot lend it the calls", () => {
    // The chunk for `bad` used to run to the next `export const` — here, to
    // EOF — swallowing the helper below and its two calls, so `bad` passed.
    const source = `
import { socialBulkMutation } from "./functions";

export const bad = socialBulkMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.patch(id, {});
  },
});

async function unrelatedHelper(ctx) {
  const threads = newDeferredSocialThreads();
  collectSocialThread(threads, "instagram", doc);
  await syncDeferredSocialThreads(ctx, threads);
}
`;
    expect(deferredMutationOffenders(source, "x.ts")).toEqual([
      "x.ts:bad uses socialBulkMutation but never calls syncDeferredSocialThreads",
      "x.ts:bad uses socialBulkMutation but never calls collectSocialThread",
    ]);
  });

  test("every Convex module has balanced block-comment delimiters", () => {
    // `stripComments` deletes everything between `/*` and the next `*/`. An
    // unbalanced `/*` inside a string or regex literal would therefore swallow
    // real code — including, in the worst case, a non-syncing mutation, which
    // would vanish from the scan entirely. That is the one shape in the
    // stripper that fails OPEN rather than merely producing a noisy build, so
    // it is pinned rather than reasoned about.
    const unbalanced: string[] = [];
    for (const file of convexModules(CONVEX_DIR)) {
      const source = fs.readFileSync(file, "utf8");
      const opens = (source.match(/\/\*/g) ?? []).length;
      const closes = (source.match(/\*\//g) ?? []).length;
      if (opens !== closes) {
        unbalanced.push(`${path.relative(CONVEX_DIR, file)}: ${opens} open vs ${closes} close`);
      }
    }
    expect(unbalanced).toEqual([]);
  });

  test("the guard is armed — it sees the real mutations", () => {
    // A guard nobody has watched fail is not a guard. If the builder is renamed
    // the scan silently matches nothing and passes having checked no code.
    const found: string[] = [];
    for (const file of convexModules(CONVEX_DIR)) {
      const rel = path.relative(CONVEX_DIR, file).split(path.sep).join("/");
      if (rel === BUILDER_OWNER) continue;
      const code = stripComments(fs.readFileSync(file, "utf8"));
      for (const raw of code.split(/\nexport const /).slice(1)) {
        const chunk = "export const " + raw;
        const name = raw.match(/^(\w+)/)?.[1];
        if (name && /=\s*socialBulkMutation\(/.test(chunk)) found.push(`${rel}:${name}`);
      }
    }

    expect(found.sort()).toEqual([
      "customers.ts:mergeCustomers",
      "socialInbox.ts:setConversationVehicle",
    ]);
  });

  test("the builder itself is only defined in functions.ts", () => {
    const definitions = convexModules(CONVEX_DIR).filter((file) =>
      fs.readFileSync(file, "utf8").includes("export const socialBulkMutation")
    );
    expect(definitions.map((f) => path.basename(f))).toEqual(["functions.ts"]);
  });
});
