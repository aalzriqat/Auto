import { beforeAll, describe, expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { newT, seedOrg, seedOwnContactCensus, snapshot, post, fbDm, PROD_LIKE_IG, PROD_LIKE_FB, type T } from "../test-utils/socialWebhook";
import { readSettingsAndSharedMobile } from "./utils/socialMobile";
import { mutation, internalMutation, socialBulkMutation } from "./functions";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import "./http";
import "./websites";
import "./users";
import "./memberships";
import "./instagramEngagement";
import "./socialOwnNumberMigration";
import crons from "./crons";
import { api } from "./_generated/api";

const OWN = "0790000001";
const CUSTOMER = "0780000002";
const rebuild = makeFunctionReference<"mutation", Record<string, never>, { done: boolean }>("socialOwnNumberMigration:rebuildPage");

// Initialize lazy component/intake modules and fake timers once, in a disposable
// database. Each scenario still seeds its own sources and drives every page.
beforeAll(async () => {
  vi.useFakeTimers();
  try {
    const t = newT();
    await intake(t, await org(t), CUSTOMER, "module_warmup", CUSTOMER);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
    // Warm the lazy scheduler modules, independently of the cron-registry
    // decision tested below. This database is discarded before any scenario.
    await t.run((ctx) => ctx.scheduler.runAfter(0, makeFunctionReference<"mutation", Record<string, never>, null>("socialOwnNumberMigration:drive"), {}));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

async function enqueueBootstrap(t: T) {
  const job = Object.values(crons.crons).find((entry) => entry.name === "socialOwnNumberMigration:drive");
  expect(job, "bootstrap must start from the deployed cron registry").toBeDefined();
  await t.run((ctx) => ctx.scheduler.runAfter(0, makeFunctionReference<"mutation", Record<string, never>, null>(job!.name), {}));
}

async function scheduleBootstrap(t: T) {
  await enqueueBootstrap(t);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

test("SCRUM-949 round5 F1: deployed cron bootstraps existing organizations without an operator", async () => {
  vi.useFakeTimers();
  try {
    const t = newT();
    const orgId = await org(t);
    const phones = await seedOwnContactCensus(t, orgId);
    await t.runUnwrapped(async (ctx) => {
      for (const row of await ctx.db.query("socialOwnNumberSources").collect()) await ctx.db.delete(row._id);
      for (const row of await ctx.db.query("socialOwnNumberCounts").collect()) await ctx.db.delete(row._id);
    });
    await intake(t, orgId, `${phones.join(" / ")} / ${CUSTOMER}`, "r5_pending");
    await scheduleBootstrap(t);
    await intake(t, orgId, `${phones.join(" / ")} / ${CUSTOMER}`, "r5_ready", CUSTOMER);
  } finally { vi.useRealTimers(); }
});

test("SCRUM-949 round5 F1: an interrupted chain resumes and completed cron ticks write nothing", async () => {
  vi.useFakeTimers();
  try {
    const t = newT();
    const orgId = await org(t);
    await t.runUnwrapped(async (ctx) => {
      const ready = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", `ready:${orgId}`)).unique();
      if (ready) await ctx.db.delete(ready._id);
    });
    await enqueueBootstrap(t);
    await vi.advanceTimersByTimeAsync(0);
    await t.finishInProgressScheduledFunctions();
    await t.run(async (ctx) => {
      const progress = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", "migration:v1")).unique();
      expect(progress?.migrationTable).toBeGreaterThan(0);
      expect(progress?.migrationTable).toBeLessThan(11);
      const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
      for (const pending of scheduled.filter((row) => row.state.kind === "pending")) await ctx.scheduler.cancel(pending._id);
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await scheduleBootstrap(t);
    expect((await t.run((ctx) => ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", "migration:v1")).unique()))?.migrationTable).toBe(11);
    await intake(t, orgId, CUSTOMER, "r5_resumed", CUSTOMER);
    const before = await t.run((ctx) => ctx.db.query("socialOwnNumberSources").collect());
    await scheduleBootstrap(t);
    expect(await t.run((ctx) => ctx.db.query("socialOwnNumberSources").collect())).toEqual(before);
    const metrics = await t.run(async (ctx) => {
      await ctx.runMutation(makeFunctionReference<"mutation", Record<string, never>, null>("socialOwnNumberMigration:drive"), {});
      return ctx.meta.getTransactionMetrics();
    });
    expect(metrics.documentsRead.used).toBe(1);
    expect(metrics.documentsWritten.used).toBe(0);
    console.info("SCRUM-949 round5 completed tick I/O", JSON.stringify(metrics));
  } finally { vi.useRealTimers(); }
});

test("SCRUM-949 round5 F1: poisoned source stays unready while another tenant completes", async () => {
  vi.useFakeTimers();
  try {
    const t = newT();
    const badOrg = await org(t);
    const goodOrg = await org(t);
    await t.run(async (ctx) => { await ctx.db.insert("branches", { orgId: badOrg, name: "Synthetic poison", isActive: true, phone: OWN }); });
    await t.runUnwrapped(async (ctx) => {
      const sources = await ctx.db.query("socialOwnNumberSources").withIndex("by_scope_kind", (q) => q.eq("scope", badOrg).eq("kind", "contact")).collect();
      expect(sources).toHaveLength(1);
      await ctx.db.patch(sources[0]._id, { phones: ["malformed-derived-contact"] });
      for (const orgId of [badOrg, goodOrg]) {
        const ready = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", `ready:${orgId}`)).unique();
        if (ready) await ctx.db.delete(ready._id);
      }
    });
    await scheduleBootstrap(t);
    await intake(t, badOrg, CUSTOMER, "r5_bad_org");
    await intake(t, goodOrg, OWN, "r5_other_tenant", OWN);
    const blocked = await t.run((ctx) => ctx.db.query("socialOwnNumberRepairs").withIndex("by_key", (q) => q.eq("key", `scope:${badOrg}`)).unique());
    expect(blocked?.phase).toBe("blocked");
  } finally { vi.useRealTimers(); }
});

test("SCRUM-949 round5 F1: a failed page backs off and resumes after its persisted cursor is repaired", async () => {
  vi.useFakeTimers();
  try {
    const t = newT();
    await org(t);
    const stateId = await t.runUnwrapped((ctx) => ctx.db.insert("socialOwnNumberSources", { key: "migration:v1", scope: "deployment", kind: "migration", phones: [], migrationTable: 0, migrationCursor: "invalid-cursor" }));
    await enqueueBootstrap(t);
    await vi.advanceTimersByTimeAsync(0);
    await t.finishInProgressScheduledFunctions();
    const state = await t.run((ctx) => ctx.db.get(stateId));
    expect(state?.retryAttempts).toBe(1);
    expect(state?.retryAt).toBe(Date.now() + 2000);
    await t.runUnwrapped((ctx) => ctx.db.patch(stateId, { migrationCursor: undefined }));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run((ctx) => ctx.db.get(stateId)))?.migrationTable).toBe(11);
  } finally { vi.useRealTimers(); }
});

test("SCRUM-949 round5 F2: a blocked staff repair cannot certify its organization", async () => {
  vi.useFakeTimers();
  try {
    const t = newT();
    const orgId = await org(t);
    const user = await t.run(async (ctx) => {
      const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
      if (!member) throw new Error("Synthetic membership missing");
      await ctx.db.patch(member.userId, { whatsappPhone: OWN });
      return (await ctx.db.get(member.userId))!;
    });
    await scheduleBootstrap(t);
    await t.runUnwrapped(async (ctx) => {
      await ctx.db.insert("socialOwnNumberSources", { key: "synthetic-poison", scope: user._id, kind: "contact", phones: ["bad-phone-key"] });
      await ctx.db.insert("socialOwnNumberCounts", { scope: orgId, phone: "0770000003", references: Number.NaN });
    });
    await t.run((ctx) => ctx.db.insert("marketplaceIndividualSellerProfiles", { sellerUserId: user._id, sellerKind: "INDIVIDUAL", phone: "0770000003", createdAt: 1, updatedAt: 1 }));
    await scheduleBootstrap(t);
    await intake(t, orgId, "0770000003 / 0780000002", "r5_blocked_staff");
    const job = await t.run((ctx) => ctx.db.query("socialOwnNumberRepairs").withIndex("by_key", (q) => q.eq("key", `scope:${orgId}`)).unique());
    expect(job?.phase).toBe("blocked");
  } finally { vi.useRealTimers(); }
});

test("SCRUM-949 round5 F2: duplicate ready rows cannot bypass a detected fault", async () => {
  const t = newT();
  const orgId = await org(t);
  const branch = await t.run((ctx) => ctx.db.insert("branches", { orgId, name: "Synthetic", isActive: true, phone: OWN }));
  await t.runUnwrapped(async (ctx) => {
    await ctx.db.insert("socialOwnNumberSources", { key: `ready:${orgId}`, scope: orgId, kind: "ready", phones: [] });
    const count = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope_phone", (q) => q.eq("scope", orgId).eq("phone", OWN)).unique();
    if (!count) throw new Error("Synthetic count missing");
    await ctx.db.patch(count._id, { references: 0 });
  });
  await t.run((ctx) => ctx.db.patch(branch, { phone: "0770000003" }));
  await intake(t, orgId, "0770000003", "r5_duplicate_ready");
});

async function assertUserProfileRepair(counterScope: "user" | "organization") {
  vi.useFakeTimers();
  try {
    const t = newT();
    const orgId = await org(t);
    const user = await t.run(async (ctx) => {
      const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
      if (!member) throw new Error("Synthetic membership missing");
      await ctx.db.patch(member.userId, { whatsappPhone: OWN });
      return (await ctx.db.get(member.userId))!;
    });
    await scheduleBootstrap(t);
    await t.runUnwrapped(async (ctx) => {
      const count = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope_phone", (q) => q.eq("scope", counterScope === "user" ? user._id : orgId).eq("phone", OWN)).unique();
      if (!count) throw new Error("Synthetic count missing");
      await ctx.db.patch(count._id, { references: 0 });
    });
    const beforeCounts = await t.run((ctx) => ctx.db.query("socialOwnNumberCounts").collect());
    await t.withIdentity({ subject: user.clerkId }).mutation(api.users.updateMyNotificationProfile, { whatsappPhone: "0770000003" });
    expect((await t.run((ctx) => ctx.db.get(user._id)))?.whatsappPhone).toBe("0770000003");
    expect(await t.run((ctx) => ctx.db.query("socialOwnNumberCounts").collect())).toEqual(beforeCounts);
    await intake(t, orgId, "0770000003 / 0780000002", "r5_fault");
    await scheduleBootstrap(t);
    await intake(t, orgId, "0770000003 / 0780000002", "r5_repaired", CUSTOMER);
  } finally { vi.useRealTimers(); }
}

test("SCRUM-949 round5 F2: user profile commits on derived underflow and intake refuses until repair", () => assertUserProfileRepair("user"));
test("SCRUM-949 round5 F2: organization underflow during staff phone change repairs both scopes", () => assertUserProfileRepair("organization"));

async function org(t: T) {
  return seedOrg(t, { ...PROD_LIKE_IG, instagramAutoReplyEnabled: true,
    instagramAutoReplyMessages: ["Please type your number."], instagramAutoReplyMobileReceivedMessage: "Number received." });
}

async function intake(t: T, orgId: Id<"organizations">, text: string, event: string, expected?: string) {
  await t.mutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
    orgId, kind: "dm", senderInstagramId: event, externalId: event, senderText: text, text,
  });
  const state = await snapshot(t, orgId);
  const customer = state.customers.find((row) => row.instagramUserId === event);
  expect(customer?.phone).toBe(expected);
}

async function finishRebuild(t: T) {
  for (let page = 0; page < 2000; page++) {
    if ((await t.mutation(rebuild, {})).done) return;
  }
  throw new Error("Synthetic bootstrap did not terminate");
}

test("SCRUM-949 round5 F2: offboarding finalizes despite a malformed derived counter", async () => {
  vi.useFakeTimers();
  try {
    const t = newT();
    const orgId = await org(t);
    const jobId = await t.run(async (ctx) => {
      const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
      if (!member) throw new Error("Synthetic membership missing");
      await ctx.db.patch(member.userId, { whatsappPhone: OWN });
      return ctx.db.insert("membershipOffboardingJobs", { orgId, membershipId: member._id, userId: member.userId, clerkId: "synthetic", requestedBy: member.userId,
        requiresClerkUserDeletion: false, status: "PENDING", attempts: 0, nextAttemptAt: 1, createdAt: 1, updatedAt: 1 });
    });
    await scheduleBootstrap(t);
    await t.runUnwrapped(async (ctx) => {
      const count = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope_phone", (q) => q.eq("scope", orgId).eq("phone", OWN)).unique();
      if (!count) throw new Error("Synthetic count missing");
      await ctx.db.patch(count._id, { references: 0 });
    });
    expect(await t.mutation(internal.memberships.finalizeMembershipOffboardingJob, { jobId, clerkUserDeleted: false })).toEqual({ status: "SUCCEEDED" });
    expect((await t.run((ctx) => ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect()))).toEqual([]);
    await intake(t, orgId, CUSTOMER, "r5_offboard_fault");
    await scheduleBootstrap(t);
    await intake(t, orgId, OWN, "r5_offboard_repaired", OWN);
  } finally { vi.useRealTimers(); }
});

test("SCRUM-949 round5 F2: website publish commits and remains fail-safe while its projection repairs", async () => {
  vi.useFakeTimers();
  try {
    const t = newT();
    const orgId = await org(t);
    const { clerkId, settingsId } = await t.run(async (ctx) => {
      const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
      if (!member) throw new Error("Synthetic membership missing");
      const user = await ctx.db.get(member.userId);
      if (!user) throw new Error("Synthetic user missing");
      await ctx.db.patch(member.roleId, { permissions: ["website.publish", "website.manage"] });
      const subscription = await ctx.db.query("subscriptions").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique();
      if (!subscription) throw new Error("Synthetic subscription missing");
      await ctx.db.patch(subscription._id, { plan: "enterprise" });
      const settingsId = await ctx.db.insert("websiteSettings", { orgId, enabled: true, status: "active", templateId: "synthetic", defaultLanguage: "en", supportedLanguages: ["en"], createdAt: 1, updatedAt: 1 });
      const snapshotId = await ctx.db.insert("websitePublishSnapshots", { orgId, websiteSettingsId: settingsId, createdAt: 1, publishedByUserId: user._id, snapshotJson: { profile: { phone: OWN } } });
      await ctx.db.patch(settingsId, { publishedSnapshotId: snapshotId });
      await ctx.db.insert("websiteDomains", { orgId, websiteSettingsId: settingsId, domain: "synthetic-publish.invalid", type: "platform_subdomain", status: "active", isPrimary: true, dnsStatus: "configured", sslStatus: "active", autoRenew: false, createdAt: 1, updatedAt: 1 });
      const settings = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique();
      if (!settings) throw new Error("Synthetic settings missing");
      await ctx.db.patch(settings._id, { dealershipPhone: "0770000003" });
      return { clerkId: user.clerkId, settingsId };
    });
    await scheduleBootstrap(t);
    await t.runUnwrapped(async (ctx) => {
      const count = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope_phone", (q) => q.eq("scope", orgId).eq("phone", OWN)).unique();
      if (!count) throw new Error("Synthetic count missing");
      await ctx.db.patch(count._id, { references: 0 });
    });
    const published = await t.withIdentity({ subject: clerkId }).mutation(api.websites.publish, { orgId });
    expect((await t.run((ctx) => ctx.db.get(settingsId)))?.publishedSnapshotId).toBe(published.snapshotId);
    await intake(t, orgId, `0770000003 / ${CUSTOMER}`, "r5_publish_fault");
    await scheduleBootstrap(t);
    await intake(t, orgId, `0770000003 / ${CUSTOMER}`, "r5_publish_repaired", CUSTOMER);
  } finally { vi.useRealTimers(); }
});

test("SCRUM-949 round4: bootstrap refuses an unindexed global staff user then admits customer after complete rebuild", async () => {
  const t = newT();
  // A user/listing predating deployment bypasses the new triggers, as real
  // retained data would. No source or completeness row exists for this user.
  const userId = await t.runUnwrapped(async (ctx) => {
    const id = await ctx.db.insert("users", { clerkId: "synthetic_legacy", email: "legacy@example.invalid", whatsappPhone: OWN });
    await ctx.db.insert("marketplaceIndividualSellerProfiles", { sellerUserId: id, sellerKind: "INDIVIDUAL", phone: "0770000003", createdAt: 1, updatedAt: 1 });
    return id;
  });
  const orgId = await org(t);
  await t.run(async (ctx) => {
    const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
    if (!member) throw new Error("Synthetic member missing");
    await ctx.db.insert("memberships", { orgId, userId, roleId: member.roleId });
  });
  await intake(t, orgId, `${OWN} / ${CUSTOMER}`, "bootstrap_pending");
  await finishRebuild(t);
  await intake(t, orgId, `${OWN} / 0770000003 / ${CUSTOMER}`, "bootstrap_done", CUSTOMER);
  const before = await t.run((ctx) => ctx.db.query("socialOwnNumberCounts").collect());
  await finishRebuild(t);
  const after = await t.run((ctx) => ctx.db.query("socialOwnNumberCounts").collect());
  expect(after).toEqual(before);
});

test("SCRUM-949 round4: an existing organization stays unavailable until its bootstrap is complete", async () => {
  const t = newT();
  const orgId = await org(t);
  await t.runUnwrapped(async (ctx) => {
    const ready = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", `ready:${orgId}`)).first();
    if (!ready) throw new Error("Synthetic readiness marker missing");
    await ctx.db.delete(ready._id);
  });
  await intake(t, orgId, CUSTOMER, "org_pending");
  await finishRebuild(t);
  await intake(t, orgId, CUSTOMER, "org_ready", CUSTOMER);
});

test("SCRUM-949 round5 F2: every mutation builder preserves its source and closes extraction on a failed child", async () => {
  for (const builder of [mutation, internalMutation, socialBulkMutation]) {
    const t = newT();
    const orgId = await org(t);
    const branchId = await t.run((ctx) => ctx.db.insert("branches", { orgId, name: "Synthetic", isActive: true, phone: OWN }));
    await t.runUnwrapped(async (ctx) => {
      const count = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope_phone", (q) => q.eq("scope", orgId).eq("phone", OWN)).unique();
      if (!count) throw new Error("Synthetic count missing");
      await ctx.db.patch(count._id, { references: 0 });
    });
    const registered = builder({ args: {}, returns: v.null(), handler: async (ctx: MutationCtx) => {
      await ctx.db.delete(branchId);
      return null;
    } });
    if (!("_handler" in registered) || typeof registered._handler !== "function") throw new Error("Installed mutation handler unavailable");
    const handler = registered._handler;
    await t.mutation(async (ctx) => { await handler(ctx, {}); });
    expect(await t.run((ctx) => ctx.db.get(branchId))).toBeNull();
    const result = await t.run((ctx) => readSettingsAndSharedMobile(ctx, orgId, "dm", CUSTOMER));
    expect(result.sharedMobileNumber).toBeNull();
    // The child rollback keeps its prior ledger; repair has the source to retry.
    const ledger = await t.run((ctx) => ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", `branches:${branchId}`)).unique());
    expect(ledger?.phones).toEqual([OWN]);
  }
});

async function seedPausedStaffHistory(t: T, orgId: Id<"organizations">, complete: boolean) {
  return t.runUnwrapped(async (ctx) => {
    const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
    if (!member) throw new Error("Synthetic member missing");
    for (const row of await ctx.db.query("socialOwnNumberSources").collect()) await ctx.db.delete(row._id);
    for (const row of await ctx.db.query("socialOwnNumberCounts").collect()) await ctx.db.delete(row._id);
    // Valid retained source rows and their completed source-phase projection.
    // This is the persisted v1 bootstrap boundary before membership copying.
    for (let i = 0; i < 257; i++) {
      const phone = String(790000000 + i).padStart(10, "0");
      const id = await ctx.db.insert("marketplaceListings", { sellerUserId: member.userId, sellerKind: "INDIVIDUAL", sellerDisplayName: "Synthetic",
        sellerPhone: phone, make: "Synthetic", model: "Fixture", year: 2020, mileage: 0, price: 1,
        currency: "JOD", transmission: "AUTO", fuelType: "OTHER", city: "Synthetic", description: "Fixture", condition: "GOOD", imageIds: [], status: "SOLD", createdAt: i, updatedAt: i });
      await ctx.db.insert("socialOwnNumberSources", { key: `marketplaceListings:${id}`, scope: member.userId, kind: "contact", phones: [phone] });
      await ctx.db.insert("socialOwnNumberCounts", { scope: member.userId, phone, references: 1 });
      if (complete) {
        await ctx.db.insert("socialOwnNumberCounts", { scope: orgId, phone, references: 1 });
        await ctx.db.insert("socialOwnNumberSources", { key: `join:${member._id}:${phone}`, scope: orgId, kind: "join", phones: [phone], membershipId: member._id, memberOrgId: orgId });
      }
    }
    await ctx.db.insert("socialOwnNumberSources", { key: `readyUser:${member.userId}`, scope: member.userId, kind: "ready", phones: [] });
    if (complete) {
      await ctx.db.insert("socialOwnNumberSources", { key: `ready:${orgId}`, scope: orgId, kind: "ready", phones: [] });
      await ctx.db.insert("socialOwnNumberSources", { key: `memberships:${member._id}`, scope: member.userId, kind: "member", phones: [], membershipId: member._id, memberOrgId: orgId, joinComplete: true });
    } else await ctx.db.insert("socialOwnNumberSources", { key: "migration:v1", scope: "deployment", kind: "migration", phones: [], migrationTable: 9 });
    return member._id;
  });
}

describe("paused 257-phone staff bootstrap", () => {
  let t: T;
  let orgId: Id<"organizations">;
  beforeAll(async () => {
    t = newT(true);
    orgId = await org(t);
    await seedPausedStaffHistory(t, orgId, false);
  });
test("SCRUM-949 round4: existing staff with 257 distinct listing phones completes bootstrap with an interleaved contact update", async () => {
  await t.mutation(rebuild, {}); // Select the membership; its phone walk has not run.
  // Selection must end this invocation before a second paginated query starts.
  expect(await t.run((ctx) => ctx.db.query("socialOwnNumberCounts").withIndex("by_scope", (q) => q.eq("scope", orgId)).collect())).toEqual([]);
  const changedId = await t.run(async (ctx) => {
    const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
    if (!member) throw new Error("Synthetic member missing");
    const listing = await ctx.db.query("marketplaceListings").withIndex("by_sellerUserId", (q) => q.eq("sellerUserId", member.userId)).first();
    if (!listing) throw new Error("Synthetic listing missing");
    await ctx.db.patch(listing._id, { sellerPhone: "0790000999" });
    return listing._id;
  });
  await finishRebuild(t);
  await intake(t, orgId, `${OWN} / 0790000999 / ${CUSTOMER}`, "many_history_ready", CUSTOMER);
  await t.run((ctx) => ctx.db.delete(changedId));
  const result = await t.run((ctx) => readSettingsAndSharedMobile(ctx, orgId, "dm", "0790000999"));
  expect(result.sharedMobileNumber?.normalized).toBe("0790000999");
});
});

describe("completed 257-phone staff join", () => {
  let t: T;
  let orgId: Id<"organizations">;
  let memberId: Id<"memberships">;
  beforeAll(async () => {
    t = newT(true);
    orgId = await org(t);
    memberId = await seedPausedStaffHistory(t, orgId, true);
  });
test("SCRUM-949 round4: staff with 257 distinct listing phones can leave", async () => {
  await t.run((ctx) => ctx.db.delete(memberId));
  const result = await t.run((ctx) => readSettingsAndSharedMobile(ctx, orgId, "dm", OWN));
  expect(result.sharedMobileNumber?.normalized).toBe(OWN);
});
});

test("SCRUM-949 round4: deleting one duplicate source retains exclusion and deleting the last admits customer", async () => {
  const t = newT();
  const orgId = await org(t);
  const ids = await t.run(async (ctx) => [
    await ctx.db.insert("branches", { orgId, name: "Synthetic A", isActive: false, phone: OWN }),
    await ctx.db.insert("branches", { orgId, name: "Synthetic B", isActive: true, additionalPhones: [OWN] }),
  ]);
  await t.run((ctx) => ctx.db.delete(ids[0]));
  await intake(t, orgId, `${OWN} / ${CUSTOMER}`, "duplicate_retained", CUSTOMER);
  await t.run((ctx) => ctx.db.delete(ids[1]));
  await intake(t, orgId, OWN, "last_removed", OWN);
});

test("SCRUM-949 round4: membership removal unjoins seller contacts without changing the other tenant", async () => {
  const t = newT();
  const orgId = await org(t);
  const otherOrgId = await seedOrg(t, {});
  const memberId = await t.run(async (ctx) => {
    const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", otherOrgId)).first();
    const role = await ctx.db.query("roles").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
    if (!member || !role) throw new Error("Synthetic membership missing");
    await ctx.db.insert("marketplaceIndividualSellerProfiles", { sellerUserId: member.userId, sellerKind: "INDIVIDUAL", phone: OWN, createdAt: 1, updatedAt: 1 });
    return ctx.db.insert("memberships", { orgId, userId: member.userId, roleId: role._id });
  });
  await intake(t, orgId, OWN, "seller_joined");
  await t.run((ctx) => ctx.db.delete(memberId));
  await intake(t, orgId, OWN, "seller_left", OWN);
  const result = await t.run((ctx) => readSettingsAndSharedMobile(ctx, otherOrgId, "dm", OWN));
  expect(result.sharedMobileNumber).toBeNull();
});

test("SCRUM-949 round4: current domain snapshot remains excluded after settings advances and unreferenced malformed history is ignored", async () => {
  const t = newT();
  const orgId = await org(t);
  const ids = await t.run(async (ctx) => {
    const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
    if (!member) throw new Error("Synthetic member missing");
    const settingsId = await ctx.db.insert("websiteSettings", { orgId, enabled: true, status: "active", templateId: "synthetic", defaultLanguage: "en", supportedLanguages: ["en"], createdAt: 1, updatedAt: 1 });
    const snapshotId = await ctx.db.insert("websitePublishSnapshots", { orgId, websiteSettingsId: settingsId, publishedByUserId: member.userId, createdAt: 1,
      snapshotJson: { profile: { phone: OWN, branches: [{ phone: "0770000003" }] } } });
    const domainId = await ctx.db.insert("websiteDomains", { orgId, websiteSettingsId: settingsId, domain: "synthetic.example.invalid", type: "external_custom_domain", status: "active", isPrimary: true, dnsStatus: "configured", sslStatus: "active", autoRenew: false, createdAt: 1, updatedAt: 1, publishedSnapshotId: snapshotId });
    const current = await ctx.db.insert("websitePublishSnapshots", { orgId, websiteSettingsId: settingsId, publishedByUserId: member.userId, createdAt: 2, snapshotJson: { profile: { phone: "" } } });
    await ctx.db.patch(settingsId, { publishedSnapshotId: current });
    await ctx.db.insert("websitePublishSnapshots", { orgId, websiteSettingsId: settingsId, publishedByUserId: member.userId, createdAt: 0, snapshotJson: { unknownLegacy: true } });
    return { domainId, snapshotId };
  });
  await intake(t, orgId, `${OWN} / 0770000003 / ${CUSTOMER}`, "domain_retained", CUSTOMER);
  await t.run((ctx) => ctx.db.patch(ids.snapshotId, { snapshotJson: { profile: { phone: { malformed: true } } } }));
  await intake(t, orgId, CUSTOMER, "current_unreadable");
  await t.run((ctx) => ctx.db.patch(ids.domainId, { publishedSnapshotId: undefined }));
  await intake(t, orgId, OWN, "superseded_boundary", OWN);
});

test("SCRUM-949 round4: current snapshot organization and settings mismatches refuse extraction", async () => {
  for (const mismatch of ["org", "settings"] as const) {
    const t = newT();
    const orgId = await org(t);
    const otherOrgId = await seedOrg(t, {});
    await t.run(async (ctx) => {
      const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
      if (!member) throw new Error("Synthetic member missing");
      const values = { orgId, enabled: true, status: "active" as const, templateId: "synthetic", defaultLanguage: "en" as const, supportedLanguages: ["en" as const], createdAt: 1, updatedAt: 1 };
      const id = await ctx.db.insert("websiteSettings", values);
      const wrongId = await ctx.db.insert("websiteSettings", values);
      const publishedSnapshotId = await ctx.db.insert("websitePublishSnapshots", { orgId: mismatch === "org" ? otherOrgId : orgId,
        websiteSettingsId: mismatch === "settings" ? wrongId : id, publishedByUserId: member.userId, createdAt: 1, snapshotJson: { profile: { phone: OWN } } });
      await ctx.db.patch(id, { publishedSnapshotId });
    });
    await intake(t, orgId, CUSTOMER, `mismatch_${mismatch}`);
  }
});

test("SCRUM-949 round4: large retained projections do not consume intake transaction bytes", async () => {
  const t = newT(true);
  const orgId = await org(t);
  const settings = await t.run(async (ctx) => {
    const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
    if (!member) throw new Error("Synthetic member missing");
    const id = await ctx.db.insert("websiteSettings", { orgId, enabled: true, status: "active", templateId: "synthetic", defaultLanguage: "en", supportedLanguages: ["en"], createdAt: 1, updatedAt: 1 });
    return { id, userId: member.userId };
  });
  for (let i = 0; i < 20; i++) {
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("websitePublishSnapshots", { orgId, websiteSettingsId: settings.id, publishedByUserId: settings.userId, createdAt: i,
        snapshotJson: { profile: { phone: OWN }, vehicles: [], padding: "x".repeat(900_000) } });
      await ctx.db.patch(settings.id, { publishedSnapshotId: id });
    });
  }
  const metrics = await t.run(async (ctx) => {
    await ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, { orgId, kind: "dm", senderInstagramId: "large_history", externalId: "large_history", senderText: `${OWN} / ${CUSTOMER}`, text: `${OWN} / ${CUSTOMER}` });
    return ctx.meta.getTransactionMetrics();
  });
  const state = await snapshot(t, orgId);
  expect(state.customers[0]?.phone).toBe(CUSTOMER);
  expect(metrics.bytesRead.used).toBeLessThan(30_000);
  console.info("SCRUM-949 round4 large-snapshot door I/O", JSON.stringify(metrics));
});

test("SCRUM-949 round4: organization deletion purges derived tenant contacts in bounded pages", async () => {
  vi.useFakeTimers();
  try {
  const t = newT();
  const orgId = await org(t);
  const branch = await t.run((ctx) => ctx.db.insert("branches", { orgId, name: "Synthetic", isActive: true, phone: OWN }));
  await t.runUnwrapped(async (ctx) => {
    const count = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope_phone", (q) => q.eq("scope", orgId).eq("phone", OWN)).unique();
    if (!count) throw new Error("Synthetic count missing");
    await ctx.db.patch(count._id, { references: 0 });
  });
  await t.run((ctx) => ctx.db.patch(branch, { phone: "0770000003" }));
  expect(await t.run((ctx) => ctx.db.query("socialOwnNumberRepairs").withIndex("by_scope", (q) => q.eq("scope", orgId)).collect())).toHaveLength(2);
  await t.run((ctx) => ctx.db.delete(orgId));
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await finishRebuild(t);
  const retained = await t.run(async (ctx) => ({
    sources: (await ctx.db.query("socialOwnNumberSources").collect()).filter((row) => row.scope === orgId || row.memberOrgId === orgId),
    counts: await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope", (q) => q.eq("scope", orgId)).collect(),
    repairs: await ctx.db.query("socialOwnNumberRepairs").withIndex("by_scope", (q) => q.eq("scope", orgId)).collect(),
  }));
  expect(retained.sources).toEqual([]);
  expect(retained.counts).toEqual([]);
  expect(retained.repairs).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("SCRUM-949 round4: cleanup refuses a live organization without changing its index", async () => {
  const t = newT();
  const orgId = await org(t);
  await t.run((ctx) => ctx.db.insert("branches", { orgId, name: "Synthetic", isActive: true, phone: OWN }));
  const before = await t.run((ctx) => ctx.db.query("socialOwnNumberSources").collect());
  const purge = makeFunctionReference<"mutation", { orgId: Id<"organizations"> }, null>("socialOwnNumberMigration:purgeDeletedOrgPage");
  await expect(t.mutation(purge, { orgId })).rejects.toThrow("Unable to finish contact cleanup");
  expect(await t.run((ctx) => ctx.db.query("socialOwnNumberSources").collect())).toEqual(before);
  const result = await t.run((ctx) => readSettingsAndSharedMobile(ctx, orgId, "dm", OWN));
  expect(result.sharedMobileNumber).toBeNull();
});

async function measureNoCandidate(platform: "instagram" | "facebook") {
  const t = newT();
  const orgId = await seedOrg(t, { ...(platform === "instagram" ? PROD_LIKE_IG : PROD_LIKE_FB),
    [`${platform}AutoReplyEnabled`]: true, [`${platform}AutoReplyMessages`]: ["Please type your number."] });
  const metrics = await t.run(async (ctx) => {
    const args = { orgId, kind: "dm" as const, externalId: "no_candidate", senderText: "Interested", text: "Interested" };
    if (platform === "instagram") await ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, { ...args, senderInstagramId: "no_candidate" });
    else await ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, { ...args, senderFacebookId: "no_candidate" });
    return ctx.meta.getTransactionMetrics();
  });
  console.info("SCRUM-949 round4 no-candidate door I/O", JSON.stringify({ platform, metrics }));
  expect((await snapshot(t, orgId)).customers[0]?.phone).toBeUndefined();
  expect(metrics.databaseQueries.used).toBeLessThanOrEqual(platform === "instagram" ? 38 : 39);
  expect(metrics.documentsRead.used).toBeLessThanOrEqual(37);
}

test("SCRUM-949 round4: instagram no-candidate canned reply pays no projection reads at the intake door", () => measureNoCandidate("instagram"));
test("SCRUM-949 round4: facebook no-candidate canned reply pays no projection reads at the intake door", () => measureNoCandidate("facebook"));

test("SCRUM-949 round5: unchanged-contact hot writers add zero document I/O", async () => {
  const t = newT();
  const orgId = await org(t);
  await seedOwnContactCensus(t, orgId);
  const ids = await t.run(async (ctx) => ({
    member: (await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first())!,
    listing: (await ctx.db.query("marketplaceListings").first())!,
    settings: (await ctx.db.query("websiteSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).first())!,
    branch: (await ctx.db.query("branches").first())!,
    seller: (await ctx.db.query("marketplaceIndividualSellerProfiles").first())!,
    dealer: (await ctx.db.query("marketplaceDealerProfiles").first())!,
    flow: (await ctx.db.query("marketplaceWhatsAppFlows").first())!,
    snapshot: (await ctx.db.query("websitePublishSnapshots").first())!,
  }));
  const domainId = await t.run((ctx) => ctx.db.insert("websiteDomains", { orgId, websiteSettingsId: ids.settings._id,
    domain: "synthetic.example.invalid", type: "external_custom_domain", status: "active", isPrimary: true,
    dnsStatus: "configured", sslStatus: "active", autoRenew: false, createdAt: 1, updatedAt: 1 }));
  const cases = [
    { writer: "users profile", patch: (ctx: MutationCtx) => ctx.db.patch(ids.member.userId, { name: "Synthetic updated" }) },
    { writer: "membership role", patch: (ctx: MutationCtx) => ctx.db.patch(ids.member._id, { roleId: ids.member.roleId }) },
    { writer: "listing status", patch: (ctx: MutationCtx) => ctx.db.patch(ids.listing._id, { status: "LIVE" }) },
    { writer: "website settings save", patch: (ctx: MutationCtx) => ctx.db.patch(ids.settings._id, { updatedAt: 2 }) },
    { writer: "branches name", patch: (ctx: MutationCtx) => ctx.db.patch(ids.branch._id, { name: "Synthetic updated" }) },
    { writer: "seller profile save", patch: (ctx: MutationCtx) => ctx.db.patch(ids.seller._id, { updatedAt: 2 }) },
    { writer: "dealer profile save", patch: (ctx: MutationCtx) => ctx.db.patch(ids.dealer._id, { updatedAt: 2 }) },
    { writer: "WhatsApp flow save", patch: (ctx: MutationCtx) => ctx.db.patch(ids.flow._id, { updatedAt: 2 }) },
    { writer: "website domain save", patch: (ctx: MutationCtx) => ctx.db.patch(domainId, { updatedAt: 2 }) },
    { writer: "website snapshot metadata", patch: (ctx: MutationCtx) => ctx.db.patch(ids.snapshot._id, { createdAt: 2 }) },
    { writer: "organization name", patch: (ctx: MutationCtx) => ctx.db.patch(orgId, { name: "Synthetic updated" }) },
  ];
  for (let sample = 0; sample < 5; sample++) {
  for (const entry of cases) {
    const metrics = await t.run(async (ctx) => { await entry.patch(ctx); return ctx.meta.getTransactionMetrics(); });
    console.info("SCRUM-949 round5 hot writer I/O", JSON.stringify({ writer: entry.writer, sample, metrics }));
    expect.soft(metrics.documentsRead.used).toBe(entry.writer === "membership role" ? 13 : entry.writer === "organization name" ? 3 : 1);
    expect.soft(metrics.documentsWritten.used).toBe(entry.writer === "membership role" ? 3 : 1);
  }
  }
});

test("SCRUM-949 5d: a changed branch contact stays excluded through signed public intake", async () => {
  const t = newT();
  const orgId = await seedOrg(t, PROD_LIKE_FB);
  const branchId = await t.run((ctx) => ctx.db.insert("branches", { orgId, name: "Synthetic", isActive: true, phone: "0790000001" }));
  await t.run((ctx) => ctx.db.patch(branchId, { phone: "0770000003" }));
  expect((await post(t, "/facebook-webhook", fbDm("synthetic_changed_contact", "0770000003"))).status).toBe(200);
  const excluded = await snapshot(t, orgId);
  expect(excluded.fbEvents).toHaveLength(1);
  expect(excluded.customers).toHaveLength(1);
  expect(excluded.customers[0]?.phone).toBeUndefined();
  expect(excluded.leads).toHaveLength(0);
  // Exercise the explicit-table overload and prove the old number is released.
  await t.run((ctx) => ctx.db.patch("branches", branchId, { phone: "0790000004" }));
  expect((await post(t, "/facebook-webhook", fbDm("synthetic_released_contact", "0770000003"))).status).toBe(200);
  const released = await snapshot(t, orgId);
  expect(released.customers.find((row) => row.facebookUserId === "synthetic_released_contact")?.phone).toBe("0770000003");
  expect(released.leads).toHaveLength(1);
});
