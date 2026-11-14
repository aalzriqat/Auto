import { beforeAll, expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { newT, seedOrg, PROD_LIKE_FB } from "../test-utils/socialWebhook";
import { signed, wrappedWrite, type Platform } from "../test-utils/socialOwnNumberHarness";
import "./http";
import "./socialOwnNumberMigration";

const OWN = "0790000701";
const CUSTOMER = "0780000702";
const drive = makeFunctionReference<"mutation", Record<string, never>, null>("socialOwnNumberMigration:drive");

beforeAll(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
  try {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_FB);
    await t.mutation(internal.facebookEngagement.handleIncomingFacebookEvent, { orgId, kind: "dm", senderFacebookId: "warm", externalId: "warm", senderText: "Warmup", text: "Warmup" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});

async function organizationTransfer(platform: Platform) {
  vi.useFakeTimers();
  const t = newT();
  try {
    const a = await seedOrg(t, {});
    const b = await seedOrg(t, {});
    const last = await t.run(async (ctx) => {
      let lastBranch: Id<"branches"> | undefined;
      for (let index = 0; index < 33; index++) {
        lastBranch = await ctx.db.insert("branches", { orgId: b, name: "Synthetic receiver", isActive: true, phone: `079200${String(index).padStart(4, "0")}` });
      }
      const source = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", `branches:${lastBranch}`)).unique();
      if (!source) throw new Error("Synthetic receiver source missing");
      return source;
    });
    vi.setSystemTime(Date.now() + 1000);
    const moving = await t.run((ctx) => ctx.db.insert("branches", { orgId: a, name: "Moving source", isActive: true, phone: OWN }));
    await t.mutation(drive, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.runUnwrapped(async (ctx) => {
      const source = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", `branches:${moving}`)).unique();
      expect(source?._creationTime).toBeGreaterThan(last._creationTime);
      await ctx.db.patch(last._id, { phones: ["invalid-recipient-page"] });
      const count = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope_phone", (q) => q.eq("scope", a).eq("phone", OWN)).unique();
      if (!count) throw new Error("Synthetic old count missing");
      await ctx.db.patch(count._id, { references: 0 });
    });
    await wrappedWrite(t, (ctx) => ctx.db.patch(moving, { orgId: b }));
    expect((await t.run((ctx) => ctx.db.get(moving)))?.orgId).toBe(b);
    await signed(t, b, platform, "transfer_pending", CUSTOMER);
    await t.mutation(drive, {});
    let paused = false;
    for (let tick = 0; tick < 30; tick++) {
      await vi.advanceTimersByTimeAsync(1000);
      await t.finishInProgressScheduledFunctions();
      const job = await t.run((ctx) => ctx.db.query("socialOwnNumberRepairs").withIndex("by_key", (q) => q.eq("key", `scope:${b}`)).unique());
      if ((job?.attempts ?? 0) >= 1) { paused = true; break; }
    }
    expect(paused).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await t.finishInProgressScheduledFunctions();
    await t.runUnwrapped((ctx) => ctx.db.patch(last._id, { phones: last.phones }));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await signed(t, b, platform, "transfer_repaired", `${OWN} / ${CUSTOMER}`, CUSTOMER);
    await signed(t, a, platform, "old_scope_released", OWN, OWN);
    await wrappedWrite(t, (ctx) => ctx.db.delete(moving));
    await signed(t, b, platform, "recipient_released", OWN, OWN);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
}

async function userTransfer(platform: Platform) {
  vi.useFakeTimers();
  const t = newT();
  try {
    const a = await seedOrg(t, {});
    const b = await seedOrg(t, {});
    const setup = await t.run(async (ctx) => {
      const oldMember = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", a)).first();
      const newMember = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", b)).first();
      if (!oldMember || !newMember) throw new Error("Synthetic member missing");
      const listing = await ctx.db.insert("marketplaceListings", { sellerUserId: oldMember.userId, sellerKind: "INDIVIDUAL", sellerDisplayName: "Synthetic", sellerPhone: OWN,
        make: "Synthetic", model: "Fixture", year: 2020, mileage: 0, price: 1, currency: "JOD", transmission: "AUTO", fuelType: "OTHER", city: "Synthetic", description: "Fixture", condition: "GOOD", imageIds: [], status: "SOLD", createdAt: 1, updatedAt: 1 });
      return { oldMember, newMember, listing };
    });
    await t.mutation(drive, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.runUnwrapped(async (ctx) => {
      const count = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope_phone", (q) => q.eq("scope", setup.oldMember.userId).eq("phone", OWN)).unique();
      if (!count) throw new Error("Synthetic old count missing");
      await ctx.db.patch(count._id, { references: 0 });
    });
    await wrappedWrite(t, (ctx) => ctx.db.patch(setup.listing, { sellerUserId: setup.newMember.userId }));
    expect((await t.run((ctx) => ctx.db.get(setup.listing)))?.sellerUserId).toBe(setup.newMember.userId);
    await signed(t, b, platform, "user_transfer_pending", CUSTOMER);
    await t.mutation(drive, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await signed(t, b, platform, "user_transfer_repaired", `${OWN} / ${CUSTOMER}`, CUSTOMER);
    await signed(t, a, platform, "old_user_scope_released", OWN, OWN);
    await wrappedWrite(t, (ctx) => ctx.db.delete(setup.listing));
    await signed(t, b, platform, "new_user_scope_released", OWN, OWN);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
}

test("SCRUM-949 r7: facebook organization transfer waits for the recipient recount", () => organizationTransfer("facebook"));
test("SCRUM-949 r7: instagram organization transfer waits for the recipient recount", () => organizationTransfer("instagram"));
test("SCRUM-949 r7: facebook user-scoped transfer avoids cyclic repair dependencies", () => userTransfer("facebook"));
test("SCRUM-949 r7: instagram user-scoped transfer avoids cyclic repair dependencies", () => userTransfer("instagram"));
