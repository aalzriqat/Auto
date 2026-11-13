import { beforeAll, expect, test } from "vitest";
import type { Doc, Id } from "./_generated/dataModel";
import type { ContactTable } from "./utils/socialOwnNumberContacts";
import { newT, seedOrg, seedOwnContactCensus, PROD_LIKE_FB, type T } from "../test-utils/socialWebhook";
import { signed, wrappedWrite, completeBootstrap } from "../test-utils/socialOwnNumberHarness";
import { internal } from "./_generated/api";
import schema from "./schema";
import { contactDescriptors, contactFields } from "./utils/socialOwnNumberContacts";
import "./http";
import "./socialOwnNumberMigration";

const OLD = "0790000901";
const NEXT = "0770000902";
const CUSTOMER = "0780000903";

beforeAll(async () => {
  const t = newT();
  const orgId = await seedOrg(t, PROD_LIKE_FB);
  await t.mutation(internal.facebookEngagement.handleIncomingFacebookEvent, { orgId, kind: "dm", senderFacebookId: "warm", externalId: "warm", senderText: "Warmup", text: "Warmup" });
});

async function fixture(t: T, table: ContactTable) {
  const orgId = await seedOrg(t, PROD_LIKE_FB);
  const otherOrg = await seedOrg(t, {});
  await seedOwnContactCensus(t, orgId);
  return t.run(async (ctx) => {
    const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
    const otherMember = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", otherOrg)).first();
    const settings = await ctx.db.query("websiteSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
    if (!member || !otherMember || !settings) throw new Error("Synthetic contact fixture missing");
    const snapshot = await ctx.db.insert("websitePublishSnapshots", { orgId, websiteSettingsId: settings._id, publishedByUserId: member.userId, createdAt: 1, snapshotJson: { profile: { phone: OLD } } });
    const nextSnapshot = await ctx.db.insert("websitePublishSnapshots", { orgId, websiteSettingsId: settings._id, publishedByUserId: member.userId, createdAt: 2, snapshotJson: { profile: { phone: NEXT } } });
    const domain = await ctx.db.insert("websiteDomains", { orgId, websiteSettingsId: settings._id, domain: "matrix.invalid", type: "external_custom_domain", status: "active", isPrimary: true, dnsStatus: "configured", sslStatus: "active", autoRenew: false, createdAt: 1, updatedAt: 1 });
    let id: Id<ContactTable>;
    switch (table) {
      case "users": id = member.userId; break;
      case "memberships": id = member._id; await ctx.db.patch(member.userId, { whatsappPhone: OLD }); await ctx.db.patch(otherMember.userId, { whatsappPhone: NEXT }); break;
      case "branches": { const row = await ctx.db.query("branches").withIndex("by_org", (q) => q.eq("orgId", orgId)).first(); if (!row) throw new Error("Missing branch"); id = row._id; break; }
      case "marketplaceListings": { const row = await ctx.db.query("marketplaceListings").withIndex("by_sellerUserId", (q) => q.eq("sellerUserId", member.userId)).first(); if (!row) throw new Error("Missing listing"); id = row._id; break; }
      case "marketplaceIndividualSellerProfiles": { const row = await ctx.db.query("marketplaceIndividualSellerProfiles").first(); if (!row) throw new Error("Missing seller"); id = row._id; break; }
      case "marketplaceDealerProfiles": { const row = await ctx.db.query("marketplaceDealerProfiles").first(); if (!row) throw new Error("Missing dealer"); id = row._id; break; }
      case "marketplaceWhatsAppFlows": { const row = await ctx.db.query("marketplaceWhatsAppFlows").first(); if (!row) throw new Error("Missing flow"); id = row._id; break; }
      case "websiteSettings": id = settings._id; await ctx.db.patch(id, { publishedSnapshotId: snapshot }); break;
      case "websiteDomains": id = domain; await ctx.db.patch(id, { publishedSnapshotId: snapshot }); break;
      case "websitePublishSnapshots": id = snapshot; await ctx.db.patch(settings._id, { publishedSnapshotId: snapshot }); break;
      default: throw new Error("No patch fields for organization insertion/deletion");
    }
    return { orgId, otherOrg, id, member, otherMember, settingsId: settings._id, domain, nextSnapshot };
  });
}

async function phoneField(table: ContactTable, field: string) {
  const t = newT();
  const f = await fixture(t, table);
  const patch = (phone: string): Partial<Doc<ContactTable>> => ({ [field]: field === "additionalPhones" ? [phone] : phone });
  await wrappedWrite(t, (ctx) => ctx.db.patch(f.id, patch(OLD)));
  await signed(t, f.orgId, "facebook", "old_excluded", `${OLD} / ${CUSTOMER}`, CUSTOMER);
  await wrappedWrite(t, (ctx) => ctx.db.patch(f.id, patch(NEXT)));
  await signed(t, f.orgId, "facebook", "new_excluded", NEXT);
  await signed(t, f.orgId, "facebook", "old_released", OLD, OLD);
}

async function scopeField(table: ContactTable, field: "orgId" | "sellerUserId" | "userId") {
  const t = newT();
  const f = await fixture(t, table);
  // Use the tested source as the sole owner of OLD in the receiving scope.
  if (table !== "memberships" && table !== "websiteSettings" && table !== "websiteDomains") {
    const phoneKey = table === "marketplaceListings" ? "sellerPhone" : table === "marketplaceDealerProfiles" ? "whatsappNumber" : "phone";
    await wrappedWrite(t, (ctx) => ctx.db.patch(f.id, { [phoneKey]: OLD }));
  }
  await signed(t, f.orgId, "facebook", "scope_before", OLD);
  await wrappedWrite(t, (ctx) => ctx.db.patch(f.id, { [field]: field === "orgId" ? f.otherOrg : f.otherMember.userId }));
  const recipient = field === "userId" ? f.orgId : f.otherOrg;
  const retained = field === "userId" ? NEXT : OLD;
  await signed(t, recipient, "facebook", "scope_after", retained);
  await signed(t, f.orgId, "facebook", "scope_released", OLD, OLD);
}

async function publishedField(table: "websiteSettings" | "websiteDomains" | "websitePublishSnapshots", field: "publishedSnapshotId" | "snapshotJson" | "orgId" | "websiteSettingsId") {
  const t = newT();
  const f = await fixture(t, table);
  await signed(t, f.orgId, "facebook", "projection_before", OLD);
  let next: unknown = field === "publishedSnapshotId" ? f.nextSnapshot : { profile: { phone: NEXT } };
  if (field === "orgId") next = f.otherOrg;
  if (field === "websiteSettingsId") {
    next = await t.run((ctx) => ctx.db.insert("websiteSettings", { orgId: f.orgId, enabled: true, status: "active", templateId: "synthetic", defaultLanguage: "en", supportedLanguages: ["en"], createdAt: 1, updatedAt: 1 }));
  }
  await wrappedWrite(t, (ctx) => ctx.db.patch(f.id, { [field]: next }));
  if (field === "orgId" || field === "websiteSettingsId") {
    // Authority mismatch is unknown evidence, not a known empty phone list.
    const recipient = table !== "websitePublishSnapshots" && field === "orgId" ? f.otherOrg : f.orgId;
    await signed(t, recipient, "facebook", "projection_invalid", CUSTOMER);
    const pointer = table === "websiteDomains" ? f.domain : f.settingsId;
    await wrappedWrite(t, (ctx) => ctx.db.patch(pointer, { publishedSnapshotId: undefined }));
  } else await signed(t, f.orgId, "facebook", "projection_after", NEXT);
  await signed(t, f.orgId, "facebook", "projection_released", OLD, OLD);
}

test("SCRUM-949 r7 field: users.whatsappPhone", () => phoneField("users", "whatsappPhone"));
test("SCRUM-949 r7 field: branches.phone", () => phoneField("branches", "phone"));
test("SCRUM-949 r7 field: branches.additionalPhones", () => phoneField("branches", "additionalPhones"));
test("SCRUM-949 r7 field: marketplaceListings.sellerPhone", () => phoneField("marketplaceListings", "sellerPhone"));
test("SCRUM-949 r7 field: marketplaceListings.sellerWhatsapp", () => phoneField("marketplaceListings", "sellerWhatsapp"));
test("SCRUM-949 r7 field: marketplaceIndividualSellerProfiles.phone", () => phoneField("marketplaceIndividualSellerProfiles", "phone"));
test("SCRUM-949 r7 field: marketplaceDealerProfiles.whatsappNumber", () => phoneField("marketplaceDealerProfiles", "whatsappNumber"));
test("SCRUM-949 r7 field: marketplaceWhatsAppFlows.phone", () => phoneField("marketplaceWhatsAppFlows", "phone"));
test("SCRUM-949 r7 field: branches.orgId", () => scopeField("branches", "orgId"));
test("SCRUM-949 r7 field: marketplaceListings.sellerUserId", () => scopeField("marketplaceListings", "sellerUserId"));
test("SCRUM-949 r7 field: marketplaceIndividualSellerProfiles.sellerUserId", () => scopeField("marketplaceIndividualSellerProfiles", "sellerUserId"));
test("SCRUM-949 r7 field: marketplaceDealerProfiles.orgId", () => scopeField("marketplaceDealerProfiles", "orgId"));
test("SCRUM-949 r7 field: marketplaceWhatsAppFlows.orgId", () => scopeField("marketplaceWhatsAppFlows", "orgId"));
test("SCRUM-949 r7 field: memberships.orgId", () => scopeField("memberships", "orgId"));
test("SCRUM-949 r7 field: memberships.userId", () => scopeField("memberships", "userId"));
test("SCRUM-949 r7 field: websiteSettings.orgId", () => publishedField("websiteSettings", "orgId"));
test("SCRUM-949 r7 field: websiteSettings.publishedSnapshotId", () => publishedField("websiteSettings", "publishedSnapshotId"));
test("SCRUM-949 r7 field: websiteDomains.orgId", () => publishedField("websiteDomains", "orgId"));
test("SCRUM-949 r7 field: websiteDomains.websiteSettingsId", () => publishedField("websiteDomains", "websiteSettingsId"));
test("SCRUM-949 r7 field: websiteDomains.publishedSnapshotId", () => publishedField("websiteDomains", "publishedSnapshotId"));
test("SCRUM-949 r7 field: websitePublishSnapshots.orgId", () => publishedField("websitePublishSnapshots", "orgId"));
test("SCRUM-949 r7 field: websitePublishSnapshots.websiteSettingsId", () => publishedField("websitePublishSnapshots", "websiteSettingsId"));
test("SCRUM-949 r7 field: websitePublishSnapshots.snapshotJson", () => publishedField("websitePublishSnapshots", "snapshotJson"));

async function bootstrapPhase(table: ContactTable, phase: string) {
  const t = newT();
  const f = await fixture(t, table);
  if (!["websiteSettings", "websiteDomains", "websitePublishSnapshots"].includes(table)) {
    const field = table === "users" ? "whatsappPhone" : table === "marketplaceListings" ? "sellerPhone" : table === "marketplaceDealerProfiles" ? "whatsappNumber" : "phone";
    await wrappedWrite(t, (ctx) => ctx.db.patch(f.id, { [field]: OLD }));
  }
  await t.runUnwrapped(async (ctx) => {
    for (const source of await ctx.db.query("socialOwnNumberSources").collect()) await ctx.db.delete(source._id);
    for (const count of await ctx.db.query("socialOwnNumberCounts").collect()) await ctx.db.delete(count._id);
  });
  await signed(t, f.orgId, "facebook", `${phase}_pending`, CUSTOMER);
  await completeBootstrap(t);
  await signed(t, f.orgId, "facebook", `${phase}_complete`, `${OLD} / ${CUSTOMER}`, CUSTOMER);
}

test("SCRUM-949 r7 bootstrap: users is the only contact source", () => bootstrapPhase("users", "users"));
test("SCRUM-949 r7 bootstrap: listings is the only contact source", () => bootstrapPhase("marketplaceListings", "listings"));
test("SCRUM-949 r7 bootstrap: seller profiles is the only contact source", () => bootstrapPhase("marketplaceIndividualSellerProfiles", "seller"));
test("SCRUM-949 r7 bootstrap: branches is the only contact source", () => bootstrapPhase("branches", "branches"));
test("SCRUM-949 r7 bootstrap: dealer profiles is the only contact source", () => bootstrapPhase("marketplaceDealerProfiles", "dealer"));
test("SCRUM-949 r7 bootstrap: flows is the only contact source", () => bootstrapPhase("marketplaceWhatsAppFlows", "flows"));
test("SCRUM-949 r7 bootstrap: settings pointer is the only contact source", () => bootstrapPhase("websiteSettings", "settings"));
test("SCRUM-949 r7 bootstrap: domain pointer is the only contact source", () => bootstrapPhase("websiteDomains", "domains"));
test("SCRUM-949 r7 bootstrap: user readiness enables membership capture", () => bootstrapPhase("users", "user_ready"));
test("SCRUM-949 r7 bootstrap: membership copy preserves staff exclusion", () => bootstrapPhase("users", "membership"));
test("SCRUM-949 r7 bootstrap: organization readiness enables capture", () => bootstrapPhase("branches", "org_ready"));

test("SCRUM-949 r7 schema: every phone-bearing contact-table field is described", () => {
  // Fixed table oracle: removing a descriptor cannot remove the table from this test.
  const tables = ["users", "memberships", "branches", "marketplaceListings", "marketplaceIndividualSellerProfiles", "marketplaceDealerProfiles", "marketplaceWhatsAppFlows", "websiteSettings", "websiteDomains", "websitePublishSnapshots", "organizations"] as const;
  const nonContact: Record<string, string> = {
    "marketplaceDealerProfiles.phoneVerifiedAt": "Verification timestamp, not a dialable contact.",
    "marketplaceDealerProfiles.phoneVerifiedBy": "Staff verifier identity, not a dialable contact.",
  };
  for (const table of tables) {
    expect(contactDescriptors[table]).toBeDefined();
    for (const [field, validator] of Object.entries(schema.tables[table].validator.fields)) {
      if (!/phone|whatsapp/i.test(field)) continue;
      const exception = nonContact[`${table}.${field}`];
      if (exception) { expect(exception.length).toBeGreaterThan(15); continue; }
      // Booleans and numeric status fields cannot carry phone evidence.
      const shape = validator.json;
      if (shape.type === "boolean" || shape.type === "number") continue;
      expect(contactFields(table), `${table}.${field} must participate in contact maintenance`).toContain(field);
    }
  }
});
