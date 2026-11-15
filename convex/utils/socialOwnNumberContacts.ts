import type { Doc, TableNames } from "../_generated/dataModel";

type ContactKind = "user" | "organization" | "member" | "published" | "snapshot" | "orgContact";
type ContactDescriptor<Table extends TableNames> = {
  kind: ContactKind;
  scopeKey: keyof Doc<Table>;
  phones?: Partial<Record<keyof Doc<Table>, "one" | "many">>;
  organizationKey?: keyof Doc<Table>;
  settingsKey?: keyof Doc<Table>;
  pointerKey?: keyof Doc<Table>;
  projectionKey?: keyof Doc<Table>;
};

function describe<Table extends TableNames>(_table: Table, descriptor: ContactDescriptor<Table>) { return descriptor; }

/** Field ownership, scope and extraction are declared together, once per source. */
export const contactDescriptors = {
  users: describe("users", { kind: "user", scopeKey: "_id", phones: { whatsappPhone: "one" } }),
  memberships: describe("memberships", { kind: "member", scopeKey: "userId", organizationKey: "orgId" }),
  branches: describe("branches", { kind: "orgContact", scopeKey: "orgId", phones: { phone: "one", additionalPhones: "many" } }),
  marketplaceListings: describe("marketplaceListings", { kind: "user", scopeKey: "sellerUserId", phones: { sellerPhone: "one", sellerWhatsapp: "one" } }),
  marketplaceIndividualSellerProfiles: describe("marketplaceIndividualSellerProfiles", { kind: "user", scopeKey: "sellerUserId", phones: { phone: "one" } }),
  marketplaceDealerProfiles: describe("marketplaceDealerProfiles", { kind: "orgContact", scopeKey: "orgId", phones: { whatsappNumber: "one" } }),
  marketplaceWhatsAppFlows: describe("marketplaceWhatsAppFlows", { kind: "orgContact", scopeKey: "orgId", phones: { phone: "one" } }),
  websiteSettings: describe("websiteSettings", { kind: "published", scopeKey: "orgId", settingsKey: "_id", pointerKey: "publishedSnapshotId" }),
  websiteDomains: describe("websiteDomains", { kind: "published", scopeKey: "orgId", settingsKey: "websiteSettingsId", pointerKey: "publishedSnapshotId" }),
  websitePublishSnapshots: describe("websitePublishSnapshots", { kind: "snapshot", scopeKey: "orgId", settingsKey: "websiteSettingsId", projectionKey: "snapshotJson" }),
  organizations: describe("organizations", { kind: "organization", scopeKey: "_id" }),
};
export type ContactTable = keyof typeof contactDescriptors;
export const contactTables = Object.keys(contactDescriptors) as ContactTable[];

export function contactFields(table: ContactTable): string[] {
  const descriptor = contactDescriptors[table];
  return [descriptor.scopeKey, descriptor.organizationKey, descriptor.settingsKey, descriptor.pointerKey, descriptor.projectionKey,
    ...Object.keys(descriptor.phones ?? {})].filter((key): key is string => typeof key === "string" && key !== "_id");
}

export function contactScope(table: ContactTable, doc: Doc<ContactTable>): string | undefined {
  const scope: unknown = Reflect.get(doc, contactDescriptors[table].scopeKey);
  return typeof scope === "string" ? scope : undefined;
}

export function contactPhones(table: ContactTable, doc: Doc<ContactTable>): (string | undefined)[] {
  return Object.entries(contactDescriptors[table].phones ?? {}).flatMap(([key, cardinality]) => {
    const value: unknown = Reflect.get(doc, key);
    if (value === undefined) return [];
    if (cardinality === "one" && typeof value === "string") return [value];
    if (cardinality === "many" && Array.isArray(value) && value.every((phone: unknown) => typeof phone === "string")) return value as string[];
    throw new Error("Malformed contact field");
  });
}

export function contactProperty(table: ContactTable, doc: Doc<ContactTable>, role: "organizationKey" | "settingsKey" | "pointerKey" | "projectionKey"): unknown {
  const key = contactDescriptors[table][role];
  return key ? Reflect.get(doc, key) : undefined;
}
