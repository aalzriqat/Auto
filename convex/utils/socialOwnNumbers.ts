import type { Triggers } from "convex-helpers/server/triggers";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { z } from "zod";
import { ownNumberExclusions } from "./socialMobile";
import type { websitePublicProjection } from "../websiteProjection";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";

const INDEX_ERROR = "Unable to update contact matching. Please try again later.";

/** Captured by mutation builders, never exposed on a handler's context. */
export function ownNumberFailureBoundary() {
  let failed = false;
  return {
    record: () => { failed = true; },
    verify: () => { if (failed) throw new ConvexError(INDEX_ERROR); },
  };
}

// The writer's profile type pins these contact paths. Arrays were absent in
// the first published version, so they remain optional at the storage boundary.
type PublishedProfile = Awaited<ReturnType<typeof websitePublicProjection>>["profile"];
const contact = z.object({ phone: z.string().nullish(), phones: z.array(z.string()).optional() });
const publishedContacts: z.ZodType<{
  profile: Partial<Pick<PublishedProfile, "phone" | "phones">> & {
    branches?: Array<Partial<Pick<PublishedProfile["branches"][number], "phone" | "phones">>>;
  };
}> = z.object({ profile: contact.extend({ branches: z.array(contact).optional() }) });

/** `?` is evidence of an unreadable contact, never a dialable number. */
function phoneKeys(values: readonly (string | undefined)[]): string[] {
  const excluded = ownNumberExclusions(null, values);
  return excluded === null ? ["?"] : [...excluded].filter((phone) => phone.startsWith("0") && !phone.startsWith("00"));
}

async function sourceByKey(ctx: MutationCtx, key: string) {
  return ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", key)).unique();
}

async function adjustCount(ctx: MutationCtx, scope: string, phone: string, delta: number): Promise<boolean> {
  const orgId = ctx.db.normalizeId("organizations", scope);
  // A purge can interleave with retained source cleanup. Deleted scopes must
  // never be recreated, nor decremented after their count rows were purged.
  if (orgId && !await ctx.db.get(orgId)) return false;
  const row = await ctx.db.query("socialOwnNumberCounts")
    .withIndex("by_scope_phone", (q) => q.eq("scope", scope).eq("phone", phone)).unique();
  const before = row?.references ?? 0;
  const after = before + delta;
  if (after < 0) throw new Error("Own-number index reference underflow");
  if (row) {
    if (after === 0) await ctx.db.delete(row._id);
    else await ctx.db.patch(row._id, { references: after });
  } else if (after > 0) {
    await ctx.db.insert("socialOwnNumberCounts", { scope, phone, references: after });
  }
  return (before === 0) !== (after === 0);
}

async function adjustContact(ctx: MutationCtx, scope: string, phone: string, delta: number, isUser: boolean) {
  const changedPresence = await adjustCount(ctx, scope, phone, delta);
  if (!isUser || !changedPresence) return;
  // Only membership edges, never listing history, are fanned out. Duplicate
  // retained listings only change the user's reference count, not this join.
  const members = ctx.db.query("socialOwnNumberSources")
    .withIndex("by_scope_kind", (q) => q.eq("scope", scope).eq("kind", "member"));
  for await (const member of members) {
    if (member.memberOrgId && member.membershipId) {
      await syncJoinedOwnNumber(ctx, member.membershipId, member.memberOrgId, phone, delta > 0);
    }
  }
}

async function syncContact(
  ctx: MutationCtx,
  key: string,
  scope: string | undefined,
  values: readonly (string | undefined)[] | null,
  isUser = false,
  snapshotId?: Id<"websitePublishSnapshots">,
) {
  if (scope && !isUser) {
    const orgId = ctx.db.normalizeId("organizations", scope);
    if (orgId && !await ctx.db.get(orgId)) scope = undefined;
  }
  const prior = await sourceByKey(ctx, key);
  const phones = scope ? values === null ? ["?"] : phoneKeys(values) : [];
  for (const phone of prior?.phones ?? []) {
    if (prior && (prior.scope !== scope || !phones.includes(phone))) await adjustContact(ctx, prior.scope, phone, -1, isUser);
  }
  for (const phone of phones) {
    if (scope && (prior?.scope !== scope || !prior?.phones.includes(phone))) await adjustContact(ctx, scope, phone, 1, isUser);
  }
  if (!scope) {
    if (prior) await ctx.db.delete(prior._id);
    return;
  }
  const fields = { key, scope, kind: "contact" as const, phones, snapshotId };
  if (prior) await ctx.db.patch(prior._id, fields);
  else await ctx.db.insert("socialOwnNumberSources", fields);
}

/** One idempotent contribution per membership/phone, including during bootstrap. */
export async function syncJoinedOwnNumber(ctx: MutationCtx, membershipId: Id<"memberships">, orgId: Id<"organizations">, phone: string, present: boolean) {
  const key = `join:${membershipId}:${phone}`;
  const prior = await sourceByKey(ctx, key);
  if (present && !prior) {
    if (!await ctx.db.get(orgId)) return;
    await adjustCount(ctx, orgId, phone, 1);
    await ctx.db.insert("socialOwnNumberSources", { key, scope: orgId, kind: "join", phones: [phone], membershipId, memberOrgId: orgId });
  } else if (!present && prior) {
    await adjustCount(ctx, prior.scope, phone, -1);
    await ctx.db.delete(prior._id);
  }
}

export async function prepareOwnNumberMembership(ctx: MutationCtx, id: Id<"memberships">, row: Doc<"memberships"> | null) {
  const key = `memberships:${id}`;
  const prior = await sourceByKey(ctx, key);
  if (row && !await ctx.db.get(row.orgId)) row = null;
  if (prior && prior.scope === row?.userId && prior.memberOrgId === row?.orgId) return prior;
  if (prior) {
    const joins = ctx.db.query("socialOwnNumberSources")
      .withIndex("by_membership_kind", (q) => q.eq("membershipId", id).eq("kind", "join"));
    for await (const join of joins) {
      if (prior.memberOrgId) await syncJoinedOwnNumber(ctx, id, prior.memberOrgId, join.phones[0], false);
    }
    await ctx.db.delete(prior._id);
  }
  if (!row) return null;
  const user = await ctx.db.get(row.userId);
  const userReady = await sourceByKey(ctx, `readyUser:${row.userId}`);
  if (!user || !userReady) await syncContact(ctx, `unknownUser:${row.userId}`, row.userId, null, true);
  const sourceId = await ctx.db.insert("socialOwnNumberSources", { key, scope: row.userId, kind: "member", phones: [], memberOrgId: row.orgId, membershipId: id, joinComplete: false });
  return ctx.db.get(sourceId);
}

async function syncMembership(ctx: MutationCtx, id: Id<"memberships">, row: Doc<"memberships"> | null) {
  const marker = await prepareOwnNumberMembership(ctx, id, row);
  if (!row || !marker || marker.joinComplete) return;
  // Live membership changes are atomic, with native transaction limits. There
  // is no history-count refusal. The legacy bootstrap uses resumable pages.
  const phones = ctx.db.query("socialOwnNumberCounts").withIndex("by_scope", (q) => q.eq("scope", row.userId));
  for await (const phone of phones) await syncJoinedOwnNumber(ctx, id, row.orgId, phone.phone, true);
  await ctx.db.patch(marker._id, { joinComplete: true });
}

async function syncPublished(
  ctx: MutationCtx,
  key: string,
  row: Doc<"websiteSettings"> | Doc<"websiteDomains"> | null,
) {
  const snapshot = row?.publishedSnapshotId ? await ctx.db.get(row.publishedSnapshotId) : null;
  const settingsId = row && ("websiteSettingsId" in row ? row.websiteSettingsId : row._id);
  const valid = snapshot && row && snapshot.orgId === row.orgId && snapshot.websiteSettingsId === settingsId;
  const parsed = valid ? publishedContacts.safeParse(snapshot.snapshotJson) : null;
  // No pointer means no published contact source. A bad *current* pointer is
  // unknown; malformed or superseded unreferenced history is never consulted.
  const values = !row?.publishedSnapshotId ? [] : !valid || !parsed?.success
    ? null
    : [parsed.data.profile.phone ?? undefined, ...(parsed.data.profile.phones ?? []),
      ...(parsed.data.profile.branches ?? []).flatMap((branch) => [branch.phone ?? undefined, ...(branch.phones ?? [])])];
  await syncContact(ctx, key, row?.orgId, values, false, row?.publishedSnapshotId);
}

export async function markOwnNumbersReady(ctx: MutationCtx, orgId: Id<"organizations">) {
  const key = `ready:${orgId}`;
  if (!await sourceByKey(ctx, key)) {
    await ctx.db.insert("socialOwnNumberSources", { key, scope: orgId, kind: "ready", phones: [] });
  }
}

export async function markUserOwnNumbersReady(ctx: MutationCtx, userId: Id<"users">) {
  const key = `readyUser:${userId}`;
  if (!await sourceByKey(ctx, key)) {
    await ctx.db.insert("socialOwnNumberSources", { key, scope: userId, kind: "ready", phones: [] });
  }
  await syncContact(ctx, `unknownUser:${userId}`, undefined, [], true);
}

/** Shared by incremental writers and the idempotent migration. */
export async function syncOwnNumberRow(ctx: MutationCtx, row:
  | { table: "users"; doc: Doc<"users"> }
  | { table: "branches"; doc: Doc<"branches"> }
  | { table: "marketplaceDealerProfiles"; doc: Doc<"marketplaceDealerProfiles"> }
  | { table: "marketplaceWhatsAppFlows"; doc: Doc<"marketplaceWhatsAppFlows"> }
  | { table: "marketplaceListings"; doc: Doc<"marketplaceListings"> }
  | { table: "marketplaceIndividualSellerProfiles"; doc: Doc<"marketplaceIndividualSellerProfiles"> }
  | { table: "websiteSettings"; doc: Doc<"websiteSettings"> }
  | { table: "websiteDomains"; doc: Doc<"websiteDomains"> }
  | { table: "memberships"; doc: Doc<"memberships"> }
) {
  const key = `${row.table}:${row.doc._id}`;
  switch (row.table) {
    case "users": return syncContact(ctx, key, row.doc._id, [row.doc.whatsappPhone], true);
    case "branches": return syncContact(ctx, key, row.doc.orgId, [row.doc.phone, ...(row.doc.additionalPhones ?? [])]);
    case "marketplaceDealerProfiles": return syncContact(ctx, key, row.doc.orgId, [row.doc.whatsappNumber]);
    case "marketplaceWhatsAppFlows": return syncContact(ctx, key, row.doc.orgId, [row.doc.phone]);
    case "marketplaceListings": return syncContact(ctx, key, row.doc.sellerUserId, [row.doc.sellerPhone, row.doc.sellerWhatsapp], true);
    case "marketplaceIndividualSellerProfiles": return syncContact(ctx, key, row.doc.sellerUserId, [row.doc.phone], true);
    case "websiteSettings": return syncPublished(ctx, key, row.doc);
    case "websiteDomains": return syncPublished(ctx, key, row.doc);
    case "memberships": return syncMembership(ctx, row.doc._id, row.doc);
  }
}

export function registerOwnNumberTriggers<Ctx extends MutationCtx>(triggers: Triggers<DataModel, Ctx>) {
  const register: typeof triggers.register = (table, handler) => triggers.register(table, async (ctx, change) => {
    try {
      await handler(ctx, change);
    } catch (error) {
      // A handler may catch a DB error and return. The builder checks this
      // private failure latch after it returns, so partial index work rolls back.
      if ("ownNumberFailure" in ctx && typeof ctx.ownNumberFailure === "function") ctx.ownNumberFailure();
      console.error("Own-number index update failed", error);
      throw new ConvexError(INDEX_ERROR);
    }
  });
  // Explicit registrations keep the table/document correlation checked by TS.
  register("users", async (ctx, c) => {
    if (c.newDoc) await syncOwnNumberRow(ctx, { table: "users", doc: c.newDoc });
    else await syncContact(ctx, `users:${c.id}`, c.id, null, true);
    // New users cannot have unindexed pre-deployment listings. Existing users
    // become complete only after the bootstrap has visited all seller sources.
    if (c.operation === "insert") await markUserOwnNumbersReady(ctx, c.id);
  });
  register("branches", (ctx, c) => c.newDoc ? syncOwnNumberRow(ctx, { table: "branches", doc: c.newDoc }) : syncContact(ctx, `branches:${c.id}`, undefined, []));
  register("marketplaceDealerProfiles", (ctx, c) => c.newDoc ? syncOwnNumberRow(ctx, { table: "marketplaceDealerProfiles", doc: c.newDoc }) : syncContact(ctx, `marketplaceDealerProfiles:${c.id}`, undefined, []));
  register("marketplaceWhatsAppFlows", (ctx, c) => c.newDoc ? syncOwnNumberRow(ctx, { table: "marketplaceWhatsAppFlows", doc: c.newDoc }) : syncContact(ctx, `marketplaceWhatsAppFlows:${c.id}`, undefined, []));
  register("marketplaceListings", (ctx, c) => c.newDoc ? syncOwnNumberRow(ctx, { table: "marketplaceListings", doc: c.newDoc }) : syncContact(ctx, `marketplaceListings:${c.id}`, undefined, [], true));
  register("marketplaceIndividualSellerProfiles", (ctx, c) => c.newDoc ? syncOwnNumberRow(ctx, { table: "marketplaceIndividualSellerProfiles", doc: c.newDoc }) : syncContact(ctx, `marketplaceIndividualSellerProfiles:${c.id}`, undefined, [], true));
  register("memberships", (ctx, c) => syncMembership(ctx, c.id, c.newDoc));
  register("websiteSettings", (ctx, c) => syncPublished(ctx, `websiteSettings:${c.id}`, c.newDoc));
  register("websiteDomains", (ctx, c) => syncPublished(ctx, `websiteDomains:${c.id}`, c.newDoc));
  register("websitePublishSnapshots", async (ctx, c) => {
    const oldContacts = publishedContacts.safeParse(c.oldDoc?.snapshotJson);
    const newContacts = publishedContacts.safeParse(c.newDoc?.snapshotJson);
    if (c.operation === "update" && oldContacts.success && newContacts.success
      && JSON.stringify(oldContacts.data) === JSON.stringify(newContacts.data)) return;
    const refs = ctx.db.query("socialOwnNumberSources").withIndex("by_snapshot", (q) => q.eq("snapshotId", c.id));
    for await (const ref of refs) {
      const settingsId = ctx.db.normalizeId("websiteSettings", ref.key.slice("websiteSettings:".length));
      const domainId = ctx.db.normalizeId("websiteDomains", ref.key.slice("websiteDomains:".length));
      if (ref.key.startsWith("websiteSettings:") && settingsId) await syncPublished(ctx, ref.key, await ctx.db.get(settingsId));
      if (ref.key.startsWith("websiteDomains:") && domainId) await syncPublished(ctx, ref.key, await ctx.db.get(domainId));
    }
  });
  register("organizations", async (ctx, c) => {
    if (c.operation === "insert") await markOwnNumbersReady(ctx, c.id);
    if (c.operation === "delete") {
      const ready = await sourceByKey(ctx, `ready:${c.id}`);
      if (ready) await ctx.db.delete(ready._id);
      await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation", { orgId: Id<"organizations"> }, null>("socialOwnNumberMigration:purgeDeletedOrgPage"), { orgId: c.id });
    }
  });
}
