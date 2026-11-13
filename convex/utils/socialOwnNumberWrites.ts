import { DatabaseWriterWithTriggers, type Triggers } from "convex-helpers/server/triggers";
import { makeFunctionReference } from "convex/server";
import type { DataModel, Doc, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

import { contactFields, contactTables, contactDescriptors, contactScope, type ContactTable } from "./socialOwnNumberContacts";

const tables = contactTables;
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
  const job = { key, scope, priority: userId ? 0 : 1, phase: "clear" as const, cursor: undefined, attempts: 0, nextAttemptAt: 0 };
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
  await Promise.all(scopes.map(async (scope) => {
    const userId = ctx.db.normalizeId("users", scope);
    if (!userId) return;
    // Include both current relationships and a retained pre-delete join marker.
    for await (const member of ctx.db.query("memberships").withIndex("by_user", (q) => q.eq("userId", userId))) affected.add(member.orgId);
    for await (const member of ctx.db.query("socialOwnNumberSources").withIndex("by_scope_kind", (q) => q.eq("scope", userId).eq("kind", "member"))) {
      if (member.memberOrgId) affected.add(member.memberOrgId);
    }
  }));
  await Promise.all([...affected].map((scope) => invalidateScope(ctx, scope, table, id)));
}

export function contactRowScopes(table: ContactTable, doc: Doc<ContactTable> | null): string[] {
  if (!doc) return [];
  const scope = contactScope(table, doc);
  const organizationKey = contactDescriptors[table].organizationKey;
  const organization: unknown = organizationKey ? Reflect.get(doc, organizationKey) : undefined;
  return [scope, organization].filter((key): key is string => typeof key === "string");
}

export function registerOwnNumberTriggers<Ctx extends MutationCtx>(triggers: Triggers<DataModel, Ctx>) {
for (const table of tables) {
  triggers.register(table, async (ctx, change) => {
    if (change.operation === "update" && contactFields(table).every((field) =>
      JSON.stringify(Reflect.get(change.oldDoc, field)) === JSON.stringify(Reflect.get(change.newDoc, field)))) return;
    const scopes = [...contactRowScopes(table, change.oldDoc), ...contactRowScopes(table, change.newDoc)];
    try {
      // Native nested mutation: catching here cannot commit half an index delta.
      await ctx.runMutation(applyContactChange, { table, id: change.id, operation: change.operation });
    } catch {
      console.error("Own-number index unavailable; source write preserved");
      await invalidateOwnNumberScopes(ctx, scopes, table, change.id);
    }
  });
}
}

/** Native fallback keeps every other table's existing triggers and lock behavior. */
class OwnNumberWriter<Ctx extends MutationCtx> extends DatabaseWriterWithTriggers<DataModel, Ctx> {
  constructor(private readonly source: Ctx, triggers: Triggers<DataModel, Ctx>) {
    super(source, source.db, triggers);
  }

  override async patch<Table extends TableNames>(
    ...args: [table: Table, id: Id<Table>, fields: Partial<Doc<Table>>] | [id: Id<Table>, fields: Partial<Doc<Table>>]
  ): Promise<void> {
    const id = args.length === 3 ? args[1] : args[0];
    const fields = args.length === 3 ? args[2] : args[1];
    // Validate the explicit table/id pairing before considering a bypass.
    if (fields && typeof fields === "object" && (args.length !== 3 || this.source.db.normalizeId(args[0], id))) {
      if (await this.patchIdentity(id, fields) || await this.patchMarketplace(id, fields) || await this.patchWebsite(id, fields)) return;
    }
    // Memberships and organizations always retain counting/bank-generation triggers.
    if (args.length === 3) return super.patch(args[0], args[1], args[2]);
    return super.patch(args[0], args[1]);
  }

  private async patchIdentity(id: string, fields: object): Promise<boolean> {
    const usersId = this.source.db.normalizeId("users", id);
    if (usersId && !Object.keys(fields).some((field) => contactFields("users").includes(field))) {
      await this.source.db.patch("users", usersId, fields as Partial<Doc<"users">>);
      return true;
    }
    const branchesId = this.source.db.normalizeId("branches", id);
    if (branchesId && !Object.keys(fields).some((field) => contactFields("branches").includes(field))) {
      await this.source.db.patch("branches", branchesId, fields as Partial<Doc<"branches">>);
      return true;
    }
    return false;
  }

  private async patchMarketplace(id: string, fields: object): Promise<boolean> {
    const marketplaceListingsId = this.source.db.normalizeId("marketplaceListings", id);
    if (marketplaceListingsId && !Object.keys(fields).some((field) => contactFields("marketplaceListings").includes(field))) {
      await this.source.db.patch("marketplaceListings", marketplaceListingsId, fields as Partial<Doc<"marketplaceListings">>);
      return true;
    }
    const marketplaceIndividualSellerProfilesId = this.source.db.normalizeId("marketplaceIndividualSellerProfiles", id);
    if (marketplaceIndividualSellerProfilesId && !Object.keys(fields).some((field) => contactFields("marketplaceIndividualSellerProfiles").includes(field))) {
      await this.source.db.patch("marketplaceIndividualSellerProfiles", marketplaceIndividualSellerProfilesId, fields as Partial<Doc<"marketplaceIndividualSellerProfiles">>);
      return true;
    }
    const marketplaceDealerProfilesId = this.source.db.normalizeId("marketplaceDealerProfiles", id);
    if (marketplaceDealerProfilesId && !Object.keys(fields).some((field) => contactFields("marketplaceDealerProfiles").includes(field))) {
      await this.source.db.patch("marketplaceDealerProfiles", marketplaceDealerProfilesId, fields as Partial<Doc<"marketplaceDealerProfiles">>);
      return true;
    }
    const marketplaceWhatsAppFlowsId = this.source.db.normalizeId("marketplaceWhatsAppFlows", id);
    if (marketplaceWhatsAppFlowsId && !Object.keys(fields).some((field) => contactFields("marketplaceWhatsAppFlows").includes(field))) {
      await this.source.db.patch("marketplaceWhatsAppFlows", marketplaceWhatsAppFlowsId, fields as Partial<Doc<"marketplaceWhatsAppFlows">>);
      return true;
    }
    return false;
  }

  private async patchWebsite(id: string, fields: object): Promise<boolean> {
    const websiteSettingsId = this.source.db.normalizeId("websiteSettings", id);
    if (websiteSettingsId && !Object.keys(fields).some((field) => contactFields("websiteSettings").includes(field))) {
      await this.source.db.patch("websiteSettings", websiteSettingsId, fields as Partial<Doc<"websiteSettings">>);
      return true;
    }
    const websiteDomainsId = this.source.db.normalizeId("websiteDomains", id);
    if (websiteDomainsId && !Object.keys(fields).some((field) => contactFields("websiteDomains").includes(field))) {
      await this.source.db.patch("websiteDomains", websiteDomainsId, fields as Partial<Doc<"websiteDomains">>);
      return true;
    }
    const websitePublishSnapshotsId = this.source.db.normalizeId("websitePublishSnapshots", id);
    if (websitePublishSnapshotsId && !Object.keys(fields).some((field) => contactFields("websitePublishSnapshots").includes(field))) {
      await this.source.db.patch("websitePublishSnapshots", websitePublishSnapshotsId, fields as Partial<Doc<"websitePublishSnapshots">>);
      return true;
    }
    return false;
  }
}

export function wrapOwnNumberDB<Ctx extends MutationCtx>(ctx: Ctx, triggers: Triggers<DataModel, Ctx>): Ctx {
  return { ...ctx, db: new OwnNumberWriter(ctx, triggers) };
}

export function isContactTable(table: string): table is ContactTable {
  const names: readonly string[] = tables;
  return names.includes(table);
}
