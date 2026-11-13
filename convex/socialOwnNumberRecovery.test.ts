import { beforeAll, expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { newT, seedOrg, PROD_LIKE_FB, PROD_LIKE_IG } from "../test-utils/socialWebhook";
import "./http";
import "./socialOwnNumberMigration";
import { api } from "./_generated/api";
import "./users";

import { signed, type Platform } from "../test-utils/socialOwnNumberHarness";
const OWN = "0790000001";
const NEXT = "0770000003";
const CUSTOMER = "0780000002";
const drive = makeFunctionReference<"mutation", Record<string, never>, null>("socialOwnNumberMigration:drive");
const statusRef = makeFunctionReference<"query", Record<string, never>, { fenced: number; clear: number; recount: number; retry: number; blocked: number; waiting: number; oldestAgeMs: number }>("socialOwnNumberMigration:repairStatus");


beforeAll(async () => {
  vi.stubEnv("FACEBOOK_APP_SECRET", "fb_test_app_secret");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
  try {
    const t = newT();
    await signed(t, await seedOrg(t, PROD_LIKE_FB), "facebook", "warm", CUSTOMER, CUSTOMER);
  } finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
});

async function failedRepair(platform: Platform, permanent: boolean) {
  vi.useFakeTimers();
  try {
    const t = newT();
    const orgId = await seedOrg(t, platform === "facebook" ? PROD_LIKE_FB : PROD_LIKE_IG);
    const branch = await t.run((ctx) => ctx.db.insert("branches", { orgId, name: "Synthetic", isActive: true, phone: OWN }));
    await t.mutation(drive, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const ledgerId = await t.runUnwrapped(async (ctx) => {
      const ledger = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", `branches:${branch}`)).unique();
      if (!ledger) throw new Error("Synthetic source missing");
      await ctx.db.patch(ledger._id, { phones: ["invalid-derived-key"] });
      return ledger._id;
    });
    // Index delta fails, but the real source patch commits in its parent.
    await t.run((ctx) => ctx.db.patch(branch, { phone: NEXT }));
    expect((await t.run((ctx) => ctx.db.get(branch)))?.phone).toBe(NEXT);
    await signed(t, orgId, platform, "fenced", CUSTOMER);
    await t.mutation(drive, {}); // clear
    await vi.advanceTimersByTimeAsync(1000);
    await t.finishInProgressScheduledFunctions(); // recount fails in the scheduled child
    const job = await t.run((ctx) => ctx.db.query("socialOwnNumberRepairs").withIndex("by_key", (q) => q.eq("key", `scope:${orgId}`)).unique());
    expect(job).not.toBeNull();
    expect(job?.phase === "blocked" || (job && "attempts" in job && job.attempts === 1)).toBe(true);
    const status = await t.query(statusRef, {});
    expect(status).toEqual({ fenced: 1, clear: 0, recount: 1, retry: 0, blocked: 0, waiting: 1, oldestAgeMs: 1000 });
    expect(job?.attempts).toBe(1);
    expect(job?.nextAttemptAt).toBe(Date.now() + 2000);
    const notDue = await t.run(async (ctx) => {
      await ctx.runMutation(drive, {});
      return ctx.meta.getTransactionMetrics();
    });
    expect(notDue.documentsWritten.used).toBe(0);
    if (!permanent) {
      // The fault disappears without touching the job or resetting its queue.
      await t.runUnwrapped((ctx) => ctx.db.patch(ledgerId, { phones: [OWN] }));
      const retryIO = await t.run(async (ctx) => {
        // Advance the logical clock only; the durable wake is still pending.
        vi.setSystemTime(Date.now() + 2000);
        await ctx.runMutation(drive, {});
        return ctx.meta.getTransactionMetrics();
      });
      console.info("SCRUM-949 r7 retry tick I/O", JSON.stringify(retryIO));
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      await signed(t, orgId, platform, "recovered", `${NEXT} / ${CUSTOMER}`, CUSTOMER);
      await signed(t, orgId, platform, "released", OWN, OWN);
    } else {
      const healthy = await seedOrg(t, platform === "facebook" ? PROD_LIKE_FB : PROD_LIKE_IG);
      const healthyBranch = await t.run((ctx) => ctx.db.insert("branches", { orgId: healthy, name: "Healthy repair", isActive: true, phone: OWN }));
      await t.runUnwrapped(async (ctx) => {
        const count = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope_phone", (q) => q.eq("scope", healthy).eq("phone", OWN)).unique();
        if (!count) throw new Error("Synthetic count missing");
        await ctx.db.patch(count._id, { references: 0 });
      });
      await t.run((ctx) => ctx.db.patch(healthyBranch, { phone: NEXT }));
      await signed(t, healthy, platform, "healthy_pending", CUSTOMER);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      await signed(t, orgId, platform, "still_fenced", CUSTOMER);
      await signed(t, healthy, platform, "healthy", `${NEXT} / ${CUSTOMER}`, CUSTOMER);
      const blocked = await t.run((ctx) => ctx.db.query("socialOwnNumberRepairs").withIndex("by_key", (q) => q.eq("key", `scope:${orgId}`)).unique());
      expect(blocked?.phase).toBe("blocked");
      expect(blocked).toMatchObject({ attempts: 5 });
      expect(await t.query(statusRef, {})).toMatchObject({ fenced: 1, blocked: 1, waiting: 0 });
      const before = await t.run((ctx) => ctx.db.query("socialOwnNumberRepairs").collect());
      await vi.advanceTimersByTimeAsync(3_600_000);
      const idle = await t.run(async (ctx) => { await ctx.runMutation(drive, {}); return ctx.meta.getTransactionMetrics(); });
      expect(idle.databaseQueries.used).toBe(2);
      expect(idle.documentsRead.used).toBe(1);
      expect(idle.documentsWritten.used).toBe(0);
      expect(await t.run((ctx) => ctx.db.query("socialOwnNumberRepairs").collect())).toEqual(before);
      // Fixing derived evidence must not require changing the legitimate phone.
      await t.runUnwrapped((ctx) => ctx.db.patch(ledgerId, { phones: [OWN] }));
      const restart = makeFunctionReference<"mutation", Record<string, never>, { restarted: number }>("socialOwnNumberMigration:restartBlockedRepairs");
      expect(await t.mutation(restart, {})).toEqual({ restarted: 1 });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect((await t.run((ctx) => ctx.db.get(branch)))?.phone).toBe(NEXT);
      await signed(t, orgId, platform, "corrected_after_bound", `${NEXT} / ${CUSTOMER}`, CUSTOMER);
    }
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
}

test("SCRUM-949 r7: facebook repair recovers automatically after its fault disappears", () => failedRepair("facebook", false));
test("SCRUM-949 r7: instagram repair recovers automatically after its fault disappears", () => failedRepair("instagram", false));
test("SCRUM-949 r7: facebook poisoned scope exhausts retries without starving healthy intake", () => failedRepair("facebook", true));
test("SCRUM-949 r7: instagram poisoned scope exhausts retries without starving healthy intake", () => failedRepair("instagram", true));

async function recoveredDependency(platform: Platform) {
  vi.useFakeTimers();
  try {
    const t = newT();
    const orgId = await seedOrg(t, platform === "facebook" ? PROD_LIKE_FB : PROD_LIKE_IG);
    const userId = await t.run(async (ctx) => {
      const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
      if (!member) throw new Error("Synthetic member missing");
      await ctx.db.patch(member.userId, { whatsappPhone: OWN });
      return member.userId;
    });
    await t.mutation(drive, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const source = await t.runUnwrapped(async (ctx) => {
      const row = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", `users:${userId}`)).unique();
      if (!row) throw new Error("Synthetic source missing");
      await ctx.db.patch(row._id, { phones: ["invalid-dependency"] });
      return row._id;
    });
    await t.run((ctx) => ctx.db.patch(userId, { whatsappPhone: NEXT }));
    await t.mutation(drive, {});
    // Drive only until the first user failure. Repair has not exhausted its budget.
    await vi.advanceTimersByTimeAsync(1000);
    await t.finishInProgressScheduledFunctions();
    await signed(t, orgId, platform, "dependency_fenced", CUSTOMER);
    await t.runUnwrapped((ctx) => ctx.db.patch(source, { phones: [OWN] }));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(statusRef, {})).toMatchObject({ fenced: 0 });
    await signed(t, orgId, platform, "dependency_recovered", `${NEXT} / ${CUSTOMER}`, CUSTOMER);
    await signed(t, orgId, platform, "dependency_released", OWN, OWN);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
}
test("SCRUM-949 r7: facebook resumes when the staff dependency recovers", () => recoveredDependency("facebook"));
test("SCRUM-949 r7: instagram resumes when the staff dependency recovers", () => recoveredDependency("instagram"));

async function pausedOrganization(platform: Platform) {
  vi.useFakeTimers();
  const t = newT();
  try {
    const orgId = await seedOrg(t, platform === "facebook" ? PROD_LIKE_FB : PROD_LIKE_IG);
    const user = await t.run(async (ctx) => {
      const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
      if (!member) throw new Error("Synthetic member missing");
      await ctx.db.patch(member.userId, { whatsappPhone: OWN });
      for (let index = 0; index < 32; index++) {
        await ctx.db.insert("marketplaceListings", { sellerUserId: member.userId, sellerKind: "INDIVIDUAL", sellerDisplayName: "Synthetic", sellerPhone: `079100${String(index).padStart(4, "0")}`,
          make: "Synthetic", model: "Fixture", year: 2020, mileage: 0, price: 1, currency: "JOD", transmission: "AUTO", fuelType: "OTHER", city: "Synthetic", description: "Fixture", condition: "GOOD", imageIds: [], status: "SOLD", createdAt: 1, updatedAt: 1 });
      }
      return (await ctx.db.get(member.userId))!;
    });
    await t.mutation(drive, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const poisoned = await t.runUnwrapped(async (ctx) => {
      const joins = await ctx.db.query("socialOwnNumberSources").withIndex("by_scope_kind", (q) => q.eq("scope", orgId).eq("kind", "join")).collect();
      expect(joins.flatMap((join) => join.phones).sort()).toEqual([OWN, ...Array.from({ length: 32 }, (_, index) => `079100${String(index).padStart(4, "0")}`)].sort());
      expect(joins[0].phones).toEqual([OWN]);
      const last = joins[32];
      await ctx.db.patch(last._id, { phones: ["invalid-second-page"] });
      const count = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope_phone", (q) => q.eq("scope", user._id).eq("phone", OWN)).unique();
      if (!count) throw new Error("Synthetic count missing");
      await ctx.db.patch(count._id, { references: 0 });
      return last;
    });
    await t.withIdentity({ subject: user.clerkId }).mutation(api.users.updateMyNotificationProfile, { whatsappPhone: NEXT });
    await t.mutation(drive, {});
    let paused = false;
    for (let tick = 0; tick < 30; tick++) {
      await vi.advanceTimersByTimeAsync(1000);
      await t.finishInProgressScheduledFunctions();
      const job = await t.run((ctx) => ctx.db.query("socialOwnNumberRepairs").withIndex("by_key", (q) => q.eq("key", `scope:${orgId}`)).unique());
      if ((job?.attempts ?? 0) >= 1) { paused = true; break; }
    }
    expect(paused, "organization second page must actually fail").toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await t.finishInProgressScheduledFunctions(); // user retry must not cross the paused org cursor
    await t.runUnwrapped((ctx) => ctx.db.patch(poisoned._id, { phones: poisoned.phones }));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await signed(t, orgId, platform, "paused_org_recovered", `${NEXT} / ${CUSTOMER}`, CUSTOMER);
    await t.withIdentity({ subject: user.clerkId }).mutation(api.users.updateMyNotificationProfile, { whatsappPhone: "" });
    await signed(t, orgId, platform, "paused_org_released", NEXT, NEXT);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
}
test("SCRUM-949 r7: facebook user retry waits for a paused organization recount", () => pausedOrganization("facebook"));
test("SCRUM-949 r7: instagram user retry waits for a paused organization recount", () => pausedOrganization("instagram"));

async function legacyParkedRepair(platform: Platform) {
  vi.useFakeTimers();
  const t = newT();
  try {
    const orgId = await seedOrg(t, platform === "facebook" ? PROD_LIKE_FB : PROD_LIKE_IG);
    const branch = await t.run((ctx) => ctx.db.insert("branches", { orgId, name: "Legacy repair", isActive: true, phone: OWN }));
    await t.mutation(drive, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.runUnwrapped(async (ctx) => {
      const count = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope_phone", (q) => q.eq("scope", orgId).eq("phone", OWN)).unique();
      if (!count) throw new Error("Synthetic count missing");
      await ctx.db.patch(count._id, { references: 0 });
    });
    await t.run((ctx) => ctx.db.patch(branch, { phone: NEXT }));
    await t.runUnwrapped(async (ctx) => {
      const job = await ctx.db.query("socialOwnNumberRepairs").withIndex("by_key", (q) => q.eq("key", `scope:${orgId}`)).unique();
      const progress = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", "migration:v1")).unique();
      if (!job || !progress) throw new Error("Synthetic legacy state missing");
      await ctx.db.patch(job._id, { attempts: undefined, nextAttemptAt: undefined, phase: "blocked", priority: 4 });
      await ctx.db.patch(progress._id, { repairQueueVersion: undefined });
    });
    await signed(t, orgId, platform, "legacy_pending", CUSTOMER);
    await t.mutation(drive, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await signed(t, orgId, platform, "legacy_recovered", `${NEXT} / ${CUSTOMER}`, CUSTOMER);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
}
test("SCRUM-949 r7: facebook adopts a previously parked repair automatically", () => legacyParkedRepair("facebook"));
test("SCRUM-949 r7: instagram adopts a previously parked repair automatically", () => legacyParkedRepair("instagram"));

test("SCRUM-949 r7: operator restart is bounded and diagnostics disclose counts only", async () => {
  vi.useFakeTimers();
  const t = newT();
  try {
    await t.runUnwrapped(async (ctx) => {
      await ctx.db.insert("socialOwnNumberSources", { key: "migration:v1", scope: "deployment", kind: "migration", phones: [], migrationTable: 11, repairQueueVersion: 1 });
      for (let index = 0; index < 33; index++) {
        const orgId = await ctx.db.insert("organizations", { name: "Synthetic", createdAt: 1 });
        await ctx.db.insert("socialOwnNumberRepairs", { key: `scope:${orgId}`, scope: orgId, phase: "blocked", priority: 4, attempts: 5 });
      }
    });
    const restart = makeFunctionReference<"mutation", Record<string, never>, { restarted: number }>("socialOwnNumberMigration:restartBlockedRepairs");
    expect(await t.mutation(restart, {})).toEqual({ restarted: 32 });
    vi.setSystemTime(Date.now() + 1000);
    const status = await t.query(statusRef, {});
    expect(status).toEqual({ fenced: 33, clear: 32, recount: 0, retry: 0, blocked: 1, waiting: 0, oldestAgeMs: expect.closeTo(1000, 0) });
    expect(await t.mutation(restart, {})).toEqual({ restarted: 1 });
    const idleRestart = await t.run(async (ctx) => { await ctx.runMutation(restart, {}); return ctx.meta.getTransactionMetrics(); });
    expect(idleRestart.documentsWritten.used).toBe(0);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});

async function sharedCounterRepair(platform: Platform) {
  vi.useFakeTimers();
  const t = newT();
  try {
    const orgId = await seedOrg(t, platform === "facebook" ? PROD_LIKE_FB : PROD_LIKE_IG);
    const branches = await t.run(async (ctx) => {
      const first = await ctx.db.insert("branches", { orgId, name: "First", isActive: true, phone: OWN });
      const second = await ctx.db.insert("branches", { orgId, name: "Second", isActive: true, phone: OWN });
      return { first, second };
    });
    await t.mutation(drive, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.runUnwrapped(async (ctx) => {
      const count = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope_phone", (q) => q.eq("scope", orgId).eq("phone", OWN)).unique();
      if (!count) throw new Error("Synthetic shared count missing");
      await ctx.db.patch(count._id, { references: 0 });
    });
    await t.run((ctx) => ctx.db.delete(branches.first));
    await signed(t, orgId, platform, "shared_count_fenced", CUSTOMER);
    await t.mutation(drive, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await signed(t, orgId, platform, "shared_count_repaired", `${OWN} / ${CUSTOMER}`, CUSTOMER);
    await t.run((ctx) => ctx.db.delete(branches.second));
    await signed(t, orgId, platform, "shared_count_released", OWN, OWN);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
}
test("SCRUM-949 r7: facebook repair preserves two contributions to the same counter", () => sharedCounterRepair("facebook"));
test("SCRUM-949 r7: instagram repair preserves two contributions to the same counter", () => sharedCounterRepair("instagram"));

async function signedRepairFence(platform: Platform) {
  vi.useFakeTimers();
  const t = newT();
  try {
    const orgId = await seedOrg(t, platform === "facebook" ? PROD_LIKE_FB : PROD_LIKE_IG);
    const branch = await t.run((ctx) => ctx.db.insert("branches", { orgId, name: "Synthetic", isActive: true, phone: OWN }));
    await t.runUnwrapped(async (ctx) => {
      await ctx.db.insert("socialOwnNumberSources", { key: `ready:${orgId}`, scope: orgId, kind: "ready", phones: [] });
      const count = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope_phone", (q) => q.eq("scope", orgId).eq("phone", OWN)).unique();
      if (!count) throw new Error("Synthetic count missing");
      await ctx.db.patch(count._id, { references: 0 });
    });
    await t.run((ctx) => ctx.db.patch(branch, { phone: NEXT }));
    expect(await t.run((ctx) => ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", `ready:${orgId}`)).first())).not.toBeNull();
    await signed(t, orgId, platform, "duplicate_ready_fenced", CUSTOMER);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
}
test("SCRUM-949 r7: facebook repair marker overrides duplicate readiness through signed intake", () => signedRepairFence("facebook"));
test("SCRUM-949 r7: instagram repair marker overrides duplicate readiness through signed intake", () => signedRepairFence("instagram"));

test("SCRUM-949 r7: retry budget terminates and exhausted cron ticks write nothing", async () => {
  vi.useFakeTimers();
  const t = newT();
  try {
    const orgId = await seedOrg(t, PROD_LIKE_FB);
    const branch = await t.run((ctx) => ctx.db.insert("branches", { orgId, name: "Poisoned", isActive: true, phone: OWN }));
    await t.mutation(drive, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.runUnwrapped(async (ctx) => {
      const source = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", `branches:${branch}`)).unique();
      if (!source) throw new Error("Synthetic source missing");
      await ctx.db.patch(source._id, { phones: ["invalid-derived-key"] });
    });
    await t.run((ctx) => ctx.db.patch(branch, { phone: NEXT }));
    await t.mutation(drive, {});
    // Finite logical-time budget: this test still reaches assertions if attempt
    // persistence is broken and a poisoned job would otherwise retry forever.
    for (let tick = 0; tick < 45; tick++) {
      await vi.advanceTimersByTimeAsync(1000);
      await t.finishInProgressScheduledFunctions();
    }
    expect(await t.query(statusRef, {})).toMatchObject({ fenced: 1, blocked: 1, waiting: 0 });
    vi.setSystemTime(Date.now() + 60_000);
    const idle = await t.run(async (ctx) => { await ctx.runMutation(drive, {}); return ctx.meta.getTransactionMetrics(); });
    expect(idle.databaseQueries.used).toBe(2);
    expect(idle.documentsRead.used).toBe(1);
    expect(idle.documentsWritten.used).toBe(0);
    await signed(t, orgId, "facebook", "exhausted_fence", CUSTOMER);
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});
