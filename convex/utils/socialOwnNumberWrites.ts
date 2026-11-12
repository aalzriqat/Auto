import type { Triggers } from "convex-helpers/server/triggers";
import { makeFunctionReference } from "convex/server";
import type { DataModel, Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

// Patch keys let unrelated writes bypass contact trigger hydration altogether.
const contactFields = {
  users: ["whatsappPhone"], memberships: ["orgId", "userId"],
  branches: ["orgId", "phone", "additionalPhones"],
  marketplaceListings: ["sellerUserId", "sellerPhone", "sellerWhatsapp"],
  marketplaceIndividualSellerProfiles: ["sellerUserId", "phone"],
  marketplaceDealerProfiles: ["orgId", "whatsappNumber"],
  marketplaceWhatsAppFlows: ["orgId", "phone"],
  websiteSettings: ["orgId", "publishedSnapshotId"],
  websiteDomains: ["orgId", "websiteSettingsId", "publishedSnapshotId"],
  websitePublishSnapshots: ["orgId", "websiteSettingsId", "snapshotJson"],
  organizations: [],
} satisfies Partial<Record<keyof DataModel, string[]>>;

export type ContactTable = keyof typeof contactFields;
const tables = Object.keys(contactFields) as ContactTable[];
export const applyContactChange = makeFunctionReference<"mutation", {
  table: string; id: string; operation: "insert" | "update" | "delete"; repair?: boolean;
}, null>("socialOwnNumberMigration:applyChange");

async function invalidateScope(ctx: MutationCtx, scope: string, table: string, id: string) {
  const userId = ctx.db.normalizeId("users", scope);
  const ready = await ctx.db.query("socialOwnNumberSources").withIndex("by_key", (q) => q.eq("key", `${userId ? "readyUser" : "ready"}:${scope}`)).first();
  if (ready) await ctx.db.delete(ready._id);
  const key = `scope:${scope}`;
  const prior = await ctx.db.query("socialOwnNumberRepairs").withIndex("by_key", (q) => q.eq("key", key)).first();
  // A new contact write during repair restarts its recount, avoiding cursor races.
  const job = { key, scope, priority: userId ? 0 : 1, phase: "clear" as const, cursor: undefined };
  if (prior) await ctx.db.patch(prior._id, job);
  else await ctx.db.insert("socialOwnNumberRepairs", job);
  const retryKey = `retry:${scope}:${table}:${id}`;
  if (!await ctx.db.query("socialOwnNumberRepairs").withIndex("by_key", (q) => q.eq("key", retryKey)).first()) {
    await ctx.db.insert("socialOwnNumberRepairs", { key: retryKey, scope, priority: 5, phase: "blocked", retryTable: table, retryId: id });
  }
}

/** Parent transaction fences extraction after the failed child has rolled back. */
export async function invalidateOwnNumberScopes(ctx: MutationCtx, scopes: readonly string[], table: string, id: string) {
  const affected = new Set(scopes);
  for (const scope of scopes) {
    const userId = ctx.db.normalizeId("users", scope);
    if (!userId) continue;
    // Include both current relationships and a retained pre-delete join marker.
    for await (const member of ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", userId))) affected.add(member.orgId);
    for await (const member of ctx.db.query("socialOwnNumberSources").withIndex("by_scope_kind", (q) => q.eq("scope", userId).eq("kind", "member"))) {
      if (member.memberOrgId) affected.add(member.memberOrgId);
    }
  }
  for (const scope of affected) await invalidateScope(ctx, scope, table, id);
}

export function contactRowScopes(table: ContactTable, doc: Doc<ContactTable> | null): string[] {
  if (!doc) return [];
  if (table === "users" || table === "organizations") return [doc._id];
  const scopes: string[] = [];
  if ("orgId" in doc) scopes.push(doc.orgId);
  if ("userId" in doc) scopes.push(doc.userId);
  if ("sellerUserId" in doc && doc.sellerUserId) scopes.push(doc.sellerUserId);
  return scopes;
}

export function registerOwnNumberTriggers<Ctx extends MutationCtx>(triggers: Triggers<DataModel, Ctx>) {
for (const table of tables) {
  triggers.register(table, async (ctx, change) => {
    if (change.operation === "update" && contactFields[table].every((field) =>
      JSON.stringify(Reflect.get(change.oldDoc, field)) === JSON.stringify(Reflect.get(change.newDoc, field)))) return;
    const scopes = [...contactRowScopes(table, change.oldDoc), ...contactRowScopes(table, change.newDoc)];
    try {
      // Native nested mutation: catching here cannot commit half an index delta.
      await ctx.runMutation(applyContactChange, { table, id: change.id, operation: change.operation });
    } catch (error) {
      console.error("Own-number index unavailable; source write preserved", error);
      await invalidateOwnNumberScopes(ctx, scopes, table, change.id);
    }
  });
}
}

export function wrapOwnNumberDB<Ctx extends MutationCtx>(ctx: Ctx, wrapped: Ctx): Ctx {
  const patch: MutationCtx["db"]["patch"] = (async (...args: unknown[]) => {
    const id = args.length === 3 ? args[1] : args[0];
    const fields = args.length === 3 ? args[2] : args[1];
    const table = tables.find((candidate) => typeof id === "string" && ctx.db.normalizeId(candidate, id));
    // These two tables also have pre-existing counting/bank-generation triggers.
    const skip = table && table !== "memberships" && table !== "organizations" && fields !== null && typeof fields === "object"
      && !Object.keys(fields).some((field) => contactFields[table].some((contactField) => contactField === field));
    return Reflect.apply(skip ? ctx.db.patch : wrapped.db.patch, skip ? ctx.db : wrapped.db, args);
  }) as MutationCtx["db"]["patch"];
  return { ...wrapped, db: { ...wrapped.db, patch } };
}

export function isContactTable(table: string): table is ContactTable {
  return tables.some((candidate) => candidate === table);
}
