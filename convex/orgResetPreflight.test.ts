/**
 * SCRUM-565 D-17 (N9) — the count-only "reset in progress" preflight query.
 *
 * INVARIANT: the closed reset gate never reaches production while any org is
 * mid-reset under the generation protocol. This query is how the release
 * workflow proves that; it must count correctly, page correctly, and leak
 * nothing about any tenant.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { RESET_PREFLIGHT_PROTOCOL } from "./orgResetPreflight";

const MODULES = import.meta.glob("./**/*.*s");

type Fields = { financialResetGeneration?: number; financialResetCompletedGeneration?: number };

async function seed(orgs: Fields[]) {
  const t = convexTestWithComponents(schema, MODULES);
  await t.run(async (ctx) => {
    for (const [i, fields] of orgs.entries()) {
      await ctx.db.insert("organizations", { name: `Secret Org ${i}`, createdAt: Date.now(), ...fields });
    }
  });
  return t;
}

const page = (t: Awaited<ReturnType<typeof seed>>, numItems: number, cursor: string | null = null) =>
  t.query(internal.orgResetPreflight.countOrgsWithResetInProgress, { paginationOpts: { numItems, cursor } });

describe("countOrgsWithResetInProgress", () => {
  test("fields absent are not counted", async () => {
    const t = await seed([{}, {}]);
    const r = await page(t, 10);
    expect(r).toMatchObject({ protocol: RESET_PREFLIGHT_PROTOCOL, scanned: 2, inProgress: 0, isDone: true });
  });

  test("equal generations are not counted", async () => {
    const t = await seed([{ financialResetGeneration: 2, financialResetCompletedGeneration: 2 }]);
    expect((await page(t, 10)).inProgress).toBe(0);
  });

  test("generation 2 / completed 1 is counted", async () => {
    const t = await seed([{ financialResetGeneration: 2, financialResetCompletedGeneration: 1 }, {}]);
    const r = await page(t, 10);
    expect(r.inProgress).toBe(1);
    expect(r.scanned).toBe(2);
  });

  test("completed absent with generation 1 is counted", async () => {
    const t = await seed([{ financialResetGeneration: 1 }]);
    expect((await page(t, 10)).inProgress).toBe(1);
  });

  test("pages of one aggregate correctly and isDone ends the walk", async () => {
    const t = await seed([
      { financialResetGeneration: 1 },
      {},
      { financialResetGeneration: 3, financialResetCompletedGeneration: 2 },
      { financialResetGeneration: 1, financialResetCompletedGeneration: 1 },
    ]);
    let cursor: string | null = null;
    let scanned = 0;
    let inProgress = 0;
    let pages = 0;
    for (;;) {
      const r: Awaited<ReturnType<typeof page>> = await page(t, 1, cursor);
      pages += 1;
      scanned += r.scanned;
      inProgress += r.inProgress;
      if (r.isDone) break;
      cursor = r.continueCursor;
      expect(pages).toBeLessThan(20);
    }
    expect(scanned).toBe(4);
    expect(inProgress).toBe(2);
  });

  test("returns exactly the allowed keys and no org identifier", async () => {
    const t = await seed([{ financialResetGeneration: 1 }]);
    const r = await page(t, 10);
    expect(Object.keys(r).sort()).toEqual(["continueCursor", "inProgress", "isDone", "protocol", "scanned"]);
    expect(JSON.stringify(r)).not.toContain("Secret Org");
  });
});
