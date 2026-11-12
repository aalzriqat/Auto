import { expect, test, vi } from "vitest";
import { makeFunctionReference } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { newT, seedOrg, snapshot, PROD_LIKE_IG, PROD_LIKE_FB, type T } from "../test-utils/socialWebhook";
import { readSettingsAndSharedMobile } from "./utils/socialMobile";
import { mutation, internalMutation, socialBulkMutation } from "./functions";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import "./http";

const OWN = "0790000001";
const CUSTOMER = "0780000002";
const rebuild = makeFunctionReference<"mutation", Record<string, never>, { done: boolean }>("socialOwnNumberMigration:rebuildPage");

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

test("SCRUM-949 round4: a caught projection error rolls back in every mutation builder", async () => {
  const t = newT();
  const orgId = await org(t);
  const branchId = await t.run((ctx) => ctx.db.insert("branches", { orgId, name: "Synthetic", isActive: true, phone: OWN }));
  // Only corrupt the derived counter to force a real index error. Every builder
  // must roll back a swallowed trigger error, regardless of its cause.
  await t.runUnwrapped(async (ctx) => {
    const count = await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope_phone", (q) => q.eq("scope", orgId).eq("phone", OWN)).first();
    if (!count) throw new Error("Synthetic count missing");
    await ctx.db.patch(count._id, { references: 0 });
  });
  const definition = { args: {}, returns: v.null(), handler: async (ctx: MutationCtx) => {
    try {
      await ctx.db.delete(branchId);
    } catch {
      // Reproduces a caller swallowing a trigger error. Builder finalization
      // must still abort this transaction outside that catch.
    }
    return null;
  } };
  const before = await t.run((ctx) => ctx.db.get(branchId));
  for (const registered of [mutation(definition), internalMutation(definition), socialBulkMutation(definition)]) {
    // convex-test uses this installed SDK entry point too. Its public d.ts
    // hides it, so validate the runtime boundary instead of casting to any.
    if (!("_handler" in registered) || typeof registered._handler !== "function") throw new Error("Installed mutation handler unavailable");
    const handler = registered._handler;
    await expect(t.mutation(async (ctx) => {
      const result: unknown = await handler(ctx, {});
      return result;
    })).rejects.toThrow("Unable to update contact matching");
    expect(await t.run((ctx) => ctx.db.get(branchId))).toEqual(before);
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

test("SCRUM-949 round4: existing staff with 257 distinct listing phones completes bootstrap with an interleaved contact update", async () => {
  const t = newT(true);
  const orgId = await org(t);
  await seedPausedStaffHistory(t, orgId, false);
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

test("SCRUM-949 round4: staff with 257 distinct listing phones can leave", async () => {
  const t = newT(true);
  const orgId = await org(t);
  const memberId = await seedPausedStaffHistory(t, orgId, true);
  await t.run((ctx) => ctx.db.delete(memberId));
  const result = await t.run((ctx) => readSettingsAndSharedMobile(ctx, orgId, "dm", OWN));
  expect(result.sharedMobileNumber?.normalized).toBe(OWN);
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
  await t.run(async (ctx) => {
    await ctx.db.insert("branches", { orgId, name: "Synthetic", isActive: true, phone: OWN });
    await ctx.db.delete(orgId);
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await finishRebuild(t);
  const retained = await t.run(async (ctx) => ({
    sources: (await ctx.db.query("socialOwnNumberSources").collect()).filter((row) => row.scope === orgId || row.memberOrgId === orgId),
    counts: await ctx.db.query("socialOwnNumberCounts").withIndex("by_scope", (q) => q.eq("scope", orgId)).collect(),
  }));
  expect(retained.sources).toEqual([]);
  expect(retained.counts).toEqual([]);
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
