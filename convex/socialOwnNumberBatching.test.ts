import { beforeAll, expect, test } from "vitest";
import { internal } from "./_generated/api";
import { newT, seedOrg, PROD_LIKE_FB } from "../test-utils/socialWebhook";
import { recountOwnNumberSource, syncOwnNumberRow } from "./utils/socialOwnNumbers";
import "./socialOwnNumberMigration";

beforeAll(async () => {
  if (typeof document !== "undefined") await import("@testing-library/react");
});

test("SCRUM-949 r7b: repair folds shared phones across 32 sources including duplicate stored entries", async () => {
  const t = newT();
  const orgId = await seedOrg(t, PROD_LIKE_FB);
  const jobId = await t.runUnwrapped(async (ctx) => {
    for (let index = 0; index < 32; index++) await ctx.db.insert("socialOwnNumberSources", {
      key: `batch:${index}`, scope: orgId, kind: "contact", phones: index === 0 ? ["0790000801", "0790000801"] : ["0790000801"],
    });
    return ctx.db.insert("socialOwnNumberRepairs", { key: `scope:${orgId}`, scope: orgId, phase: "recount", priority: 1 });
  });
  const metrics = await t.runUnwrapped(async (ctx) => {
    await ctx.runMutation(internal.socialOwnNumberMigration.repairScopePage, { jobId });
    return ctx.meta.getTransactionMetrics();
  });
  const rows = await t.run((ctx) => ctx.db.query("socialOwnNumberCounts").withIndex("by_scope", (q) => q.eq("scope", orgId)).collect());
  expect(rows.map(({ phone, references }) => ({ phone, references }))).toEqual([{ phone: "0790000801", references: 33 }]);
  console.info("SCRUM-949 r7b recount I/O", JSON.stringify(metrics));
  expect(metrics.documentsWritten.used).toBe(2);
});

test("SCRUM-949 r7b: malformed recount phone refuses before any write even if caller catches", async () => {
  const t = newT();
  const orgId = await seedOrg(t, PROD_LIKE_FB);
  await t.runUnwrapped(async (ctx) => {
    const id = await ctx.db.insert("socialOwnNumberSources", { key: "malformed", scope: orgId, kind: "contact", phones: ["0790000802", "bad"] });
    const source = await ctx.db.get(id);
    expect(source).not.toBeNull();
    await expect(recountOwnNumberSource({ ...ctx, ownNumberRepair: true }, source!)).rejects.toThrow("Malformed own-number contribution");
    expect(await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope", (q) => q.eq("scope", orgId)).collect()).toEqual([]);
  });
});

test("SCRUM-949 r7b: failed removals finish before additions can write", async () => {
  const t = newT();
  const orgId = await seedOrg(t, PROD_LIKE_FB);
  await t.runUnwrapped(async (ctx) => {
    const branchId = await ctx.db.insert("branches", { orgId, name: "Synthetic", isActive: true, phone: "0780000803" });
    await ctx.db.insert("socialOwnNumberSources", { key: `branches:${branchId}`, scope: orgId, kind: "contact", phones: ["0790000803"] });
    const doc = await ctx.db.get(branchId);
    expect(doc).not.toBeNull();
    await expect(syncOwnNumberRow(ctx, { table: "branches", doc: doc! })).rejects.toThrow("Own-number index reference underflow");
    expect(await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope", (q) => q.eq("scope", orgId)).collect()).toEqual([]);
  });
});
