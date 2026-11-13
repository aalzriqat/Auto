import type { Doc, Id } from "../_generated/dataModel";
import { contactDescriptors, contactScope, contactPhones, contactProperty, type ContactTable } from "./socialOwnNumberContacts";
import type { MutationCtx } from "../_generated/server";
import { z } from "zod";
import { ownNumberExclusions } from "./socialMobile";
import type { websitePublicProjection } from "../websiteProjection";
import { isContactTable } from "./socialOwnNumberWrites";
import { makeFunctionReference } from "convex/server";

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

function sourceByKey(ctx: MutationCtx, key: string) {
  return ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", key)).unique();
}

async function adjustCount(ctx: MutationCtx, scope: string, phone: string, delta: number): Promise<boolean> {
  if (!("ownNumberRepair" in ctx)) {
    const repair = await ctx.db.query("socialOwnNumberRepairs").withIndex("by_key", (q) => q.eq("key", `scope:${scope}`)).first();
    if (repair) throw new Error("Own-number scope is being repaired");
  }
  const orgId = ctx.db.normalizeId("organizations", scope);
  // A purge can interleave with retained source cleanup. Deleted scopes must
  // never be recreated, nor decremented after their count rows were purged.
  if (orgId && !await ctx.db.get(orgId)) return false;
  const row = await ctx.db.query("socialOwnNumberCounts")
    .withIndex("by_scope_phone", (q) => q.eq("scope", scope).eq("phone", phone)).unique();
  const before = row?.references ?? 0;
  const after = before + delta;
  if (!Number.isSafeInteger(before) || before < 0 || after < 0) throw new Error("Own-number index reference underflow");
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

function contactPhoneKeys(scope: string | undefined, values: readonly (string | undefined)[] | null): string[] {
  if (!scope) return [];
  if (values === null) return ["?"];
  return phoneKeys(values);
}

async function settleContactChanges(changes: Promise<unknown>[]) {
  const results = await Promise.allSettled(changes);
  const failed = results.find((change) => change.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

async function updateContactPhones(ctx: MutationCtx, prior: Doc<"socialOwnNumberSources"> | null, scope: string | undefined, phones: string[], isUser: boolean) {
  const removed = new Map<string, number>();
  for (const phone of prior?.phones ?? []) {
    if (prior && (prior.scope !== scope || !phones.includes(phone))) removed.set(phone, (removed.get(phone) ?? 0) - 1);
  }
  // Each phone owns distinct scope/phone counters and membership/phone join keys.
  // Settle every removal, including failures, before starting any addition.
  if (prior) await settleContactChanges([...removed].map(([phone, delta]) => adjustContact(ctx, prior.scope, phone, delta, isUser)));
  if (!scope) return;
  const addedPhones = phones.filter((phone) => prior?.scope !== scope || !prior?.phones.includes(phone));
  await settleContactChanges(addedPhones.map((phone) => adjustContact(ctx, scope, phone, 1, isUser)));
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
  const phones = contactPhoneKeys(scope, values);
  await updateContactPhones(ctx, prior, scope, phones, isUser);
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

function membershipContact(ctx: MutationCtx, row: Doc<"memberships">) {
    const user = contactScope("memberships", row);
    const organization = contactProperty("memberships", row, "organizationKey");
    const userId = typeof user === "string" ? ctx.db.normalizeId("users", user) : null;
    const orgId = typeof organization === "string" ? ctx.db.normalizeId("organizations", organization) : null;
    if (!userId || !orgId) throw new Error("Invalid membership contact scope");
    return { ...row, userId, orgId };
}

export async function prepareOwnNumberMembership(ctx: MutationCtx, id: Id<"memberships">, row: Doc<"memberships"> | null) {
  if (row) row = membershipContact(ctx, row);
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
  const staffPhoneCounts = ctx.db.query("socialOwnNumberCounts").withIndex("by_scope", (q) => q.eq("scope", row.userId));
  for await (const phone of staffPhoneCounts) await syncJoinedOwnNumber(ctx, id, row.orgId, phone.phone, true);
  await ctx.db.patch(marker._id, { joinComplete: true });
}

async function syncPublished(
  ctx: MutationCtx,
  key: string,
  row: Doc<"websiteSettings"> | Doc<"websiteDomains"> | null,
) {
  const table = key.startsWith("websiteSettings:") ? "websiteSettings" : "websiteDomains";
  const pointer = row ? contactProperty(table, row, "pointerKey") : undefined;
  const snapshotId = typeof pointer === "string" ? ctx.db.normalizeId("websitePublishSnapshots", pointer) : null;
  const snapshot = snapshotId ? await ctx.db.get(snapshotId) : null;
  const scope = row ? contactScope(table, row) : undefined;
  const settingsId = row ? contactProperty(table, row, "settingsKey") : undefined;
  const valid = snapshot && row && contactScope("websitePublishSnapshots", snapshot) === scope
    && contactProperty("websitePublishSnapshots", snapshot, "settingsKey") === settingsId;
  const parsed = valid ? publishedContacts.safeParse(contactProperty("websitePublishSnapshots", snapshot, "projectionKey")) : null;
  // No pointer means no published contact source. A bad *current* pointer is
  // unknown; malformed or superseded unreferenced history is never consulted.
  let values: (string | undefined)[] | null = pointer ? null : [];
  if (valid && parsed?.success) {
    values = [parsed.data.profile.phone ?? undefined, ...(parsed.data.profile.phones ?? []),
      ...(parsed.data.profile.branches ?? []).flatMap((branch) => [branch.phone ?? undefined, ...(branch.phones ?? [])])];
  }
  await syncContact(ctx, key, scope, values, false, snapshotId ?? undefined);
}

export async function markOwnNumbersReady(ctx: MutationCtx, orgId: Id<"organizations">) {
  if (await ctx.db.query("socialOwnNumberRepairs").withIndex("by_key", (q) => q.eq("key", `scope:${orgId}`)).first()) return;
  const key = `ready:${orgId}`;
  if (!await sourceByKey(ctx, key)) {
    await ctx.db.insert("socialOwnNumberSources", { key, scope: orgId, kind: "ready", phones: [] });
  }
}

export async function markUserOwnNumbersReady(ctx: MutationCtx, userId: Id<"users">) {
  if (!("ownNumberRepair" in ctx) && await ctx.db.query("socialOwnNumberRepairs").withIndex("by_key", (q) => q.eq("key", `scope:${userId}`)).first()) return;
  const key = `readyUser:${userId}`;
  if (!await sourceByKey(ctx, key)) {
    await ctx.db.insert("socialOwnNumberSources", { key, scope: userId, kind: "ready", phones: [] });
  }
  await syncContact(ctx, `unknownUser:${userId}`, undefined, [], true);
}

/** Shared by incremental writers and the idempotent migration. */
export function syncOwnNumberRow(ctx: MutationCtx, row:
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
    case "websiteSettings": return syncPublished(ctx, key, row.doc);
    case "websiteDomains": return syncPublished(ctx, key, row.doc);
    case "memberships": return syncMembership(ctx, row.doc._id, row.doc);
    default: return syncContact(ctx, key, contactScope(row.table, row.doc), contactPhones(row.table, row.doc), contactDescriptors[row.table].kind === "user");
  }
}

/** Called inside an isolated nested mutation; a fault rolls back its entire delta. */
export async function applyOwnNumberChange(ctx: MutationCtx, table: string, id: string, operation: string) {
  if (!isContactTable(table)) throw new Error("Unsupported contact source");
  await sourceChanges[table](ctx, id, operation);
}

const sourceChanges = {
  users: async (ctx: MutationCtx, id: string, operation: string) => {
    const rowId = ctx.db.normalizeId("users", id);
    if (!rowId) throw new Error("Invalid contact source id");
    const doc = await ctx.db.get(rowId);
    if (doc) await syncOwnNumberRow(ctx, { table: "users", doc });
    else await syncContact(ctx, `users:${id}`, rowId, null, true);
    if (operation === "insert") await markUserOwnNumbersReady(ctx, rowId);
    return;
  },
  branches: async (ctx: MutationCtx, id: string) => {
    const rowId = ctx.db.normalizeId("branches", id);
    if (!rowId) throw new Error("Invalid contact source id");
    const doc = await ctx.db.get(rowId);
    if (doc) await syncOwnNumberRow(ctx, { table: "branches", doc });
    else await syncContact(ctx, `branches:${id}`, undefined, []);
    return;
  },
  marketplaceDealerProfiles: async (ctx: MutationCtx, id: string) => {
    const rowId = ctx.db.normalizeId("marketplaceDealerProfiles", id);
    if (!rowId) throw new Error("Invalid contact source id");
    const doc = await ctx.db.get(rowId);
    if (doc) await syncOwnNumberRow(ctx, { table: "marketplaceDealerProfiles", doc });
    else await syncContact(ctx, `marketplaceDealerProfiles:${id}`, undefined, []);
    return;
  },
  marketplaceWhatsAppFlows: async (ctx: MutationCtx, id: string) => {
    const rowId = ctx.db.normalizeId("marketplaceWhatsAppFlows", id);
    if (!rowId) throw new Error("Invalid contact source id");
    const doc = await ctx.db.get(rowId);
    if (doc) await syncOwnNumberRow(ctx, { table: "marketplaceWhatsAppFlows", doc });
    else await syncContact(ctx, `marketplaceWhatsAppFlows:${id}`, undefined, []);
    return;
  },
  marketplaceListings: async (ctx: MutationCtx, id: string) => {
    const rowId = ctx.db.normalizeId("marketplaceListings", id);
    if (!rowId) throw new Error("Invalid contact source id");
    const doc = await ctx.db.get(rowId);
    if (doc) await syncOwnNumberRow(ctx, { table: "marketplaceListings", doc });
    else await syncContact(ctx, `marketplaceListings:${id}`, undefined, [], true);
    return;
  },
  marketplaceIndividualSellerProfiles: async (ctx: MutationCtx, id: string) => {
    const rowId = ctx.db.normalizeId("marketplaceIndividualSellerProfiles", id);
    if (!rowId) throw new Error("Invalid contact source id");
    const doc = await ctx.db.get(rowId);
    if (doc) await syncOwnNumberRow(ctx, { table: "marketplaceIndividualSellerProfiles", doc });
    else await syncContact(ctx, `marketplaceIndividualSellerProfiles:${id}`, undefined, [], true);
    return;
  },
  websiteSettings: async (ctx: MutationCtx, id: string) => {
    const rowId = ctx.db.normalizeId("websiteSettings", id);
    if (!rowId) throw new Error("Invalid contact source id");
    const doc = await ctx.db.get(rowId);
    if (doc) await syncOwnNumberRow(ctx, { table: "websiteSettings", doc });
    else await syncContact(ctx, `websiteSettings:${id}`, undefined, []);
    return;
  },
  websiteDomains: async (ctx: MutationCtx, id: string) => {
    const rowId = ctx.db.normalizeId("websiteDomains", id);
    if (!rowId) throw new Error("Invalid contact source id");
    const doc = await ctx.db.get(rowId);
    if (doc) await syncOwnNumberRow(ctx, { table: "websiteDomains", doc });
    else await syncContact(ctx, `websiteDomains:${id}`, undefined, []);
    return;
  },
  memberships: async (ctx: MutationCtx, id: string) => {
    const rowId = ctx.db.normalizeId("memberships", id);
    if (!rowId) throw new Error("Invalid membership id");
    await syncMembership(ctx, rowId, await ctx.db.get(rowId));
    return;
  },
  websitePublishSnapshots: async (ctx: MutationCtx, id: string) => {
    const rowId = ctx.db.normalizeId("websitePublishSnapshots", id);
    if (!rowId) throw new Error("Invalid snapshot id");
    const refs = ctx.db.query("socialOwnNumberSources").withIndex("by_snapshot", (q) => q.eq("snapshotId", rowId));
    for await (const ref of refs) {
      const settingsId = ctx.db.normalizeId("websiteSettings", ref.key.slice("websiteSettings:".length));
      const domainId = ctx.db.normalizeId("websiteDomains", ref.key.slice("websiteDomains:".length));
      if (ref.key.startsWith("websiteSettings:") && settingsId) await syncPublished(ctx, ref.key, await ctx.db.get(settingsId));
      if (ref.key.startsWith("websiteDomains:") && domainId) await syncPublished(ctx, ref.key, await ctx.db.get(domainId));
    }
    return;
  },
  organizations: async (ctx: MutationCtx, id: string, operation: string) => {
    const orgId = ctx.db.normalizeId("organizations", id);
    if (!orgId) throw new Error("Invalid organization id");
    if (operation === "insert") await markOwnNumbersReady(ctx, orgId);
    if (operation === "delete") {
      const ready = await sourceByKey(ctx, `ready:${id}`);
      if (ready) await ctx.db.delete(ready._id);
      await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation", { orgId: Id<"organizations"> }, null>("socialOwnNumberMigration:purgeDeletedOrgPage"), { orgId });
    }
    return;
  },
} satisfies Record<ContactTable, (ctx: MutationCtx, id: string, operation: string) => Promise<void>>;

/** Validate the complete page before starting writes; retain stored multiplicity. */
export function ownNumberSourceDeltas(sources: readonly Doc<"socialOwnNumberSources">[]): Map<string, number> {
  const deltas = new Map<string, number>();
  for (const source of sources) {
    if (source.kind !== "contact" && source.kind !== "join") continue;
    for (const phone of source.phones) {
      if (phone !== "?" && !/^0\d{7,14}$/.test(phone)) throw new Error("Malformed own-number contribution");
      deltas.set(phone, (deltas.get(phone) ?? 0) + 1);
    }
  }
  return deltas;
}

/** One read-modify-write per distinct scope/phone key, never per contribution. */
export async function applyOwnNumberDeltas(ctx: MutationCtx, scope: string, deltas: Map<string, number>) {
  await settleContactChanges([...deltas].map(([phone, delta]) => adjustCount(ctx, scope, phone, delta)));
}

/** Recount only the stored contribution ledger while intake for the scope is closed. */
export async function recountOwnNumberSource(ctx: MutationCtx, source: Doc<"socialOwnNumberSources">) {
  const deltas = ownNumberSourceDeltas([source]);
  await applyOwnNumberDeltas(ctx, source.scope, deltas);
}
