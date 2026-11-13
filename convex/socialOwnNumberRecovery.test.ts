import { beforeAll, expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import type { Id } from "./_generated/dataModel";
import { newT, seedOrg, snapshot, post, fbDm, igDm, PROD_LIKE_FB, PROD_LIKE_IG, type T } from "../test-utils/socialWebhook";
import "./http";
import "./socialOwnNumberMigration";

type Platform = "facebook" | "instagram";
const OWN = "0790000001";
const NEXT = "0770000003";
const CUSTOMER = "0780000002";
const drive = makeFunctionReference<"mutation", Record<string, never>, null>("socialOwnNumberMigration:drive");
const statusRef = makeFunctionReference<"query", Record<string, never>, { fenced: number; clear: number; recount: number; retry: number; blocked: number; waiting: number; oldestAgeMs: number }>("socialOwnNumberMigration:repairStatus");

async function signed(t: T, orgId: Id<"organizations">, platform: Platform, sender: string, text: string, expected?: string) {
  // Give just this receiving scope the provider routing key for this request.
  await t.runUnwrapped(async (ctx) => {
    for (const settings of await ctx.db.query("orgSettings").collect()) {
      await ctx.db.patch(settings._id, { facebookPageId: undefined, instagramWebhookAccountId: undefined, instagramBusinessAccountId: undefined });
      if (settings.orgId === orgId) await ctx.db.patch(settings._id, platform === "facebook" ? PROD_LIKE_FB : PROD_LIKE_IG);
    }
  });
  const response = platform === "facebook"
    ? await post(t, "/facebook-webhook", fbDm(sender, text))
    : await post(t, "/instagram-webhook", igDm(sender, text));
  expect(response.status).toBe(200);
  const state = await snapshot(t, orgId);
  const customer = state.customers.find((row) => platform === "facebook" ? row.facebookUserId === sender : row.instagramUserId === sender);
  expect(customer, "signed intake must reach the receiving organization").toBeDefined();
  expect(customer?.phone).toBe(expected);
}

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
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      await signed(t, orgId, platform, "still_fenced", CUSTOMER);
      await signed(t, healthy, platform, "healthy", CUSTOMER, CUSTOMER);
      const blocked = await t.run((ctx) => ctx.db.query("socialOwnNumberRepairs").withIndex("by_key", (q) => q.eq("key", `scope:${orgId}`)).unique());
      expect(blocked?.phase).toBe("blocked");
      expect(blocked).toMatchObject({ attempts: 5 });
      expect(await t.query(statusRef, {})).toMatchObject({ fenced: 1, blocked: 1, waiting: 0 });
      const before = await t.run((ctx) => ctx.db.query("socialOwnNumberRepairs").collect());
      await vi.advanceTimersByTimeAsync(3_600_000);
      await t.mutation(drive, {});
      expect(await t.run((ctx) => ctx.db.query("socialOwnNumberRepairs").collect())).toEqual(before);
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
