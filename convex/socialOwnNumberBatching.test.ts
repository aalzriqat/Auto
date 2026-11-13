import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import { newT, seedOrg, PROD_LIKE_FB } from "../test-utils/socialWebhook";
import { recountOwnNumberSource, syncOwnNumberRow } from "./utils/socialOwnNumbers";
import "./socialOwnNumberMigration";

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
    const repairCtx = { ...ctx, ownNumberRepair: true };
    await expect(recountOwnNumberSource(repairCtx, source!)).rejects.toThrow("Malformed own-number contribution");
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


test("SCRUM-949 r7b: bootstrap processes one source per invocation and retains shared counters", async () => {
  const t = newT();
  const orgId = await seedOrg(t, PROD_LIKE_FB);
  await t.runUnwrapped(async (ctx) => {
    for (let index = 0; index < 32; index++) await ctx.db.insert("branches", { orgId, name: `Synthetic ${index}`, isActive: true, phone: "0790000804" });
    await ctx.db.insert("socialOwnNumberSources", { key: "migration:v1", scope: "deployment", kind: "migration", phones: [], migrationTable: 3 });
  });
  const samples = [];
  for (let invocation = 0; invocation < 34; invocation++) {
    samples.push(await t.runUnwrapped(async (ctx) => {
      await ctx.runMutation(internal.socialOwnNumberMigration.rebuildPage, {});
      return ctx.meta.getTransactionMetrics();
    }));
    const state = await t.run((ctx) => ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", "migration:v1")).unique());
    if (state?.migrationTable === 4) break;
  }
  const counts = await t.run((ctx) => ctx.db.query("socialOwnNumberCounts").withIndex("by_scope", (q) => q.eq("scope", orgId)).collect());
  expect(counts.map(({ phone, references }) => ({ phone, references }))).toEqual([{ phone: "0790000804", references: 32 }]);
  console.info("SCRUM-949 r7b bootstrap I/O", JSON.stringify(samples));
  expect(samples).toHaveLength(33);
});


test("SCRUM-949 r7b: batched recount refuses unsafe reference sums before writing", async () => {
  const t = newT();
  const orgId = await seedOrg(t, PROD_LIKE_FB);
  await t.runUnwrapped(async (ctx) => {
    await ctx.db.insert("socialOwnNumberCounts", { scope: orgId, phone: "0790000805", references: Number.MAX_SAFE_INTEGER - 1 });
    const sourceId = await ctx.db.insert("socialOwnNumberSources", { key: "overflow", scope: orgId, kind: "contact", phones: ["0790000805", "0790000805", "0790000805"] });
    const source = await ctx.db.get(sourceId);
    const repairCtx = { ...ctx, ownNumberRepair: true };
    await expect(recountOwnNumberSource(repairCtx, source!)).rejects.toThrow("Own-number index reference underflow");
    expect((await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope", (q) => q.eq("scope", orgId)).unique())?.references).toBe(9007199254740990);
  });
});

test("SCRUM-949 r7b: user readiness releases shared unknown membership contributions", async () => {
  const t = newT();
  const orgId = await seedOrg(t, PROD_LIKE_FB);
  await t.runUnwrapped(async (ctx) => {
    const role = await ctx.db.query("roles").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
    if (!role) throw new Error("Synthetic role missing");
    for (let index = 0; index < 2; index++) {
      const userId = await ctx.db.insert("users", { clerkId: `unknown_${index}`, email: `unknown_${index}@example.invalid` });
      const membershipId = await ctx.db.insert("memberships", { userId, orgId, roleId: role._id });
      await ctx.db.insert("socialOwnNumberSources", { key: `unknownUser:${userId}`, scope: userId, kind: "contact", phones: ["?"] });
      await ctx.db.insert("socialOwnNumberSources", { key: `memberships:${membershipId}`, scope: userId, kind: "member", phones: [], memberOrgId: orgId, membershipId, joinComplete: true });
      await ctx.db.insert("socialOwnNumberSources", { key: `join:${membershipId}:?`, scope: orgId, kind: "join", phones: ["?"], memberOrgId: orgId, membershipId });
      await ctx.db.insert("socialOwnNumberCounts", { scope: userId, phone: "?", references: 1 });
    }
    await ctx.db.insert("socialOwnNumberCounts", { scope: orgId, phone: "?", references: 2 });
    await ctx.db.insert("socialOwnNumberSources", { key: "migration:v1", scope: "deployment", kind: "migration", phones: [], migrationTable: 8 });
  });
  for (let invocation = 0; invocation < 5; invocation++) {
    await t.mutation(internal.socialOwnNumberMigration.rebuildPage, {});
    const state = await t.run((ctx) => ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", "migration:v1")).unique());
    if (state?.migrationTable === 9) break;
  }
  expect(await t.run((ctx) => ctx.db.query("socialOwnNumberCounts").withIndex("by_scope_phone", (q) => q.eq("scope", orgId).eq("phone", "?")).collect())).toEqual([]);
  expect((await t.run((ctx) => ctx.db.query("socialOwnNumberSources").withIndex("by_scope_kind", (q) => q.eq("scope", orgId).eq("kind", "join")).collect())).map(({ key }) => key)).toEqual([]);
});


test("SCRUM-949 r7b: membership copy deduplicates corrupt count rows before writing join keys", async () => {
  const t = newT();
  const orgId = await seedOrg(t, PROD_LIKE_FB);
  await t.runUnwrapped(async (ctx) => {
    const membership = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
    if (!membership) throw new Error("Synthetic membership missing");
    const marker = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", `memberships:${membership._id}`)).unique();
    if (!marker) throw new Error("Synthetic marker missing");
    await ctx.db.patch(marker._id, { joinComplete: false });
    await ctx.db.insert("socialOwnNumberCounts", { scope: membership.userId, phone: "0790000806", references: 1 });
    await ctx.db.insert("socialOwnNumberCounts", { scope: membership.userId, phone: "0790000806", references: 1 });
    await ctx.db.insert("socialOwnNumberSources", { key: "migration:v1", scope: "deployment", kind: "migration", phones: [], migrationTable: 9,
      migrationMemberId: membership._id, migrationMemberCursor: "", migrationMemberNextCursor: "", migrationMemberNextDone: true });
  });
  await t.mutation(internal.socialOwnNumberMigration.rebuildPage, {});
  const counts = await t.run((ctx) => ctx.db.query("socialOwnNumberCounts").withIndex("by_scope", (q) => q.eq("scope", orgId)).collect());
  expect(counts.map(({ phone, references }) => ({ phone, references }))).toEqual([{ phone: "0790000806", references: 1 }]);
  const joins = await t.run((ctx) => ctx.db.query("socialOwnNumberSources").withIndex("by_scope_kind", (q) => q.eq("scope", orgId).eq("kind", "join")).collect());
  expect(joins.map(({ phones }) => phones)).toEqual([["0790000806"]]);
});
