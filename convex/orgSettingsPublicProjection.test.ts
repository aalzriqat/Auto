/**
 * SCRUM-843. `orgSettings.get` returned the raw `orgSettings` row to anyone with
 * `view:settings`, credentials included. These tests plant a distinctive sentinel
 * in every server-only field and prove no public query hands one back, to any
 * role, while everything the web and mobile screens read still arrives.
 *
 * Every secret here is a synthetic sentinel; none is a real credential.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import {
  PUBLIC_ORG_SETTINGS_FIELDS,
  SERVER_ONLY_ORG_SETTINGS_FIELDS,
  toPublicOrgSettings,
} from "./utils/orgSettingsProjection";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

type T = ReturnType<typeof convexTestWithComponents<typeof schema>>;

/** One sentinel per server-only field, so a leak names the field that leaked. */
const SENTINEL = (field: string) => `SENTINEL-${field}-7c1e`;
const SERVER_ONLY_VALUES = {
  whatsappApiToken: SENTINEL("whatsappApiToken"),
  whatsappWebhookSecret: SENTINEL("whatsappWebhookSecret"),
  instagramAccessToken: SENTINEL("instagramAccessToken"),
  facebookPageAccessToken: SENTINEL("facebookPageAccessToken"),
  facebookPendingCredentials: [{ id: "page_pending", name: "Pending Page", token: SENTINEL("facebookPendingToken") }],
  whatsappPhoneNumberId: SENTINEL("whatsappPhoneNumberId"),
  instagramBusinessAccountId: SENTINEL("instagramBusinessAccountId"),
  instagramWebhookAccountId: SENTINEL("instagramWebhookAccountId"),
  instagramTokenExpiresAt: 1_900_000_000_111,
  facebookPageId: SENTINEL("facebookPageId"),
  facebookConnectedByUserId: SENTINEL("facebookConnectedByUserId"),
  facebookTokenExpiresAt: 1_900_000_000_222,
  facebookDisconnectedAt: 1_900_000_000_333,
  facebookPendingAttemptId: SENTINEL("facebookPendingAttemptId"),
  instagramAutoReplyLastIndex: 7,
  facebookAutoReplyLastIndex: 8,
  instagramSmartReplyEnabled: true,
  facebookSmartReplyEnabled: true,
  smartReplyDefaultLocale: "ar" as const,
} satisfies Partial<Doc<"orgSettings">>;

/** A value for every public field except `orgId` (seeded separately) and the two that need a real foreign id. */
const PUBLIC_VALUES = {
  currency: "JOD",
  currencySymbol: "د.أ",
  vatRate: 16,
  country: "JO",
  timezone: "Asia/Amman",
  enabledPaymentTypes: ["CASH", "INSTALLMENT"],
  primaryColor: "#112233",
  dealershipName: "Sentinel Motors",
  legalCompanyName: "Sentinel Motors LLC",
  dealershipAddress: "1 Test Street",
  dealershipPhone: "+962700000001",
  dealershipPhones: ["+962700000001", "+962700000002"],
  approvalThresholdEnabled: true,
  approvalMinProfitPercent: 5,
  commissionTiers: [{ minProfitAmount: 100, commissionPct: 2 }],
  commissionMode: "AUTO_TIERS",
  reservationHoldDays: 3,
  instagramPageName: "sentinel_ig",
  socialAutoPostEnabled: true,
  instagramAutoReplyEnabled: true,
  instagramAutoReplyMessages: ["ig hello"],
  instagramAutoReplyMobileReceivedMessage: "ig mobile ok",
  instagramLeadFromCommentsEnabled: true,
  instagramLeadFromDmsEnabled: true,
  instagramLeadFromDmsRequiresMobile: false,
  facebookPageName: "Sentinel FB Page",
  facebookAutoReplyEnabled: true,
  facebookAutoReplyMessages: ["fb hello"],
  facebookAutoReplyMobileReceivedMessage: "fb mobile ok",
  facebookLeadFromCommentsEnabled: true,
  facebookLeadFromDmsEnabled: true,
  facebookLeadFromDmsRequiresMobile: false,
  generatedLeadAutoAssignmentEnabled: true,
  smartReplyFinancingMode: "calculated",
  smartReplyDefaultDownPaymentPercent: 20,
  smartReplyVisibility: "dm",
  facebookAutoReplyForDmsEnabled: true,
  facebookAutoReplyForCommentsEnabled: false,
  instagramAutoReplyForDmsEnabled: true,
  instagramAutoReplyForCommentsEnabled: false,
  facebookSmartReplyForDmsEnabled: true,
  facebookSmartReplyForCommentsEnabled: false,
  instagramSmartReplyForDmsEnabled: true,
  instagramSmartReplyForCommentsEnabled: false,
  smartReplyCustomTemplatesEn: "{}",
  smartReplyCustomTemplatesAr: "{}",
  facebookAvailablePages: [{ id: "page_1", name: "Sentinel FB Page" }],
} satisfies Partial<Doc<"orgSettings">>;

/** An org with a fully populated settings row and one member per role under test. */
async function seedOrgWithSecrets(t: T, label: string) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `${label} Org`, createdAt: Date.now() }));
  const member = async (clerkId: string, roleName: string, permissions: string[], isSystemOwnerRole = false) => {
    const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId, email: `${clerkId}@test.com`, name: clerkId }));
    const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: roleName, permissions, isSystemOwnerRole }));
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    return t.withIdentity({ subject: clerkId });
  };
  // The connection-status queries are gated on the Social Inbox plan feature.
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const asOwner = await member(`${label}_owner`, "OWNER", ALL_PERMISSIONS, true);
  const asViewer = await member(`${label}_viewer`, "MANAGER", ["view:settings"]);
  const asNoSettings = await member(`${label}_sales`, "SALES", ["view:vehicles"]);
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, ...PUBLIC_VALUES, ...SERVER_ONLY_VALUES } as never)
  );
  return { orgId, asOwner, asViewer, asNoSettings };
}

/** No sentinel value anywhere in a public result. */
function expectNoSentinels(result: unknown) {
  expect(JSON.stringify(result)).not.toContain("SENTINEL-");
}

/** A settings-shaped public result: no sentinel, and none of the server-only keys. */
function expectNoServerOnlyData(result: unknown) {
  expectNoSentinels(result);
  for (const field of SERVER_ONLY_ORG_SETTINGS_FIELDS) {
    expect(Object.keys((result ?? {}) as object), `leaked field ${field}`).not.toContain(field);
  }
}

describe("which orgSettings fields are public (SCRUM-843)", () => {
  const schemaFields = Object.keys(
    (schema.tables.orgSettings as unknown as { validator: { fields: Record<string, unknown> } }).validator.fields
  );

  test("every schema field is classified exactly once, as public or server-only", () => {
    const pub = new Set<string>(PUBLIC_ORG_SETTINGS_FIELDS);
    const server = new Set<string>(SERVER_ONLY_ORG_SETTINGS_FIELDS);
    expect([...pub].filter((f) => server.has(f)), "in both lists").toEqual([]);
    expect(schemaFields.filter((f) => !pub.has(f) && !server.has(f)), "unclassified").toEqual([]);
    expect([...pub, ...server].filter((f) => !schemaFields.includes(f)), "not in the schema").toEqual([]);
    expect(pub.size).toBe(PUBLIC_ORG_SETTINGS_FIELDS.length);
    expect(server.size).toBe(SERVER_ONLY_ORG_SETTINGS_FIELDS.length);
  });

  test("the fixtures plant a value in every server-only field, and in every public one that can be seeded", () => {
    expect(Object.keys(SERVER_ONLY_VALUES).sort()).toEqual([...SERVER_ONLY_ORG_SETTINGS_FIELDS].sort());
    const needsForeignIdOrSeededElsewhere = ["orgId", "logoStorageId", "smartReplyDefaultFinanceCompanyId"];
    expect(Object.keys(PUBLIC_VALUES).sort()).toEqual(
      PUBLIC_ORG_SETTINGS_FIELDS.filter((f) => !needsForeignIdOrSeededElsewhere.includes(f)).sort()
    );
  });

  test("a field that looks like a credential is never public", () => {
    const credentialLike = /token|secret|password|credential|apikey|api_key/i;
    expect(PUBLIC_ORG_SETTINGS_FIELDS.filter((f) => credentialLike.test(f))).toEqual([]);
    for (const field of ["whatsappApiToken", "whatsappWebhookSecret", "instagramAccessToken", "facebookPageAccessToken", "facebookPendingCredentials"]) {
      expect(SERVER_ONLY_ORG_SETTINGS_FIELDS).toContain(field);
    }
  });

  test("the projection copies only allowlisted keys, so a field added later is withheld", () => {
    const row = {
      _id: "settings_1",
      _creationTime: 1,
      orgId: "org_1",
      currency: "JOD",
      smartReplyDefaultFinanceCompanyId: "fc_1",
      logoStorageId: "storage_1",
      brandNewFutureSecret: "SENTINEL-future",
      ...SERVER_ONLY_VALUES,
    } as unknown as Doc<"orgSettings">;

    const projected = toPublicOrgSettings(row);

    expect(projected).toEqual({
      _id: "settings_1",
      _creationTime: 1,
      orgId: "org_1",
      currency: "JOD",
      smartReplyDefaultFinanceCompanyId: "fc_1",
      logoStorageId: "storage_1",
    });
    expectNoServerOnlyData(projected);
  });
});

describe("orgSettings.get keeps credentials out of every role's result (SCRUM-843)", () => {
  test.each([
    ["the owner", "asOwner"],
    ["a member with only view:settings", "asViewer"],
  ] as const)("%s receives every public field and no server-only field", async (_label, who) => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const org = await seedOrgWithSecrets(t, "a");

    const result = await org[who].query(api.orgSettings.get, { orgId: org.orgId });

    expect(result).not.toBeNull();
    expect(result).toMatchObject({ ...PUBLIC_VALUES, orgId: org.orgId });
    expect(result?._id).toBeDefined();
    expectNoServerOnlyData(result);
  });

  test("a member without view:settings gets nothing", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const org = await seedOrgWithSecrets(t, "a");
    expect(await org.asNoSettings.query(api.orgSettings.get, { orgId: org.orgId })).toBeNull();
  });

  test("an owner of another org, and an unauthenticated caller, get nothing for this org", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const orgA = await seedOrgWithSecrets(t, "a");
    const orgB = await seedOrgWithSecrets(t, "b");

    expect(await orgB.asOwner.query(api.orgSettings.get, { orgId: orgA.orgId })).toBeNull();
    expect(await t.query(api.orgSettings.get, { orgId: orgA.orgId })).toBeNull();
    // ...and each org's own owner reads only their own row.
    const own = await orgB.asOwner.query(api.orgSettings.get, { orgId: orgB.orgId });
    expect(own?.orgId).toBe(orgB.orgId);
    expectNoServerOnlyData(own);
  });
});

describe("the credentials are still stored, and backend code still reads them (SCRUM-843)", () => {
  test("the row holds every sentinel, and an internal reader still receives the Facebook token", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const org = await seedOrgWithSecrets(t, "a");

    const stored = await t.run((ctx) => ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", org.orgId)).unique());
    for (const [field, value] of Object.entries(SERVER_ONLY_VALUES)) {
      expect(stored?.[field as keyof Doc<"orgSettings">], field).toEqual(value);
    }

    // The webhook path resolves an org by Page id and needs the stored token.
    const viaWebhookLookup = await t.query(internal.facebookEngagement.getSettingsByFacebookPageId, {
      facebookPageId: SERVER_ONLY_VALUES.facebookPageId,
    });
    expect(viaWebhookLookup.settings?.facebookPageAccessToken).toBe(SERVER_ONLY_VALUES.facebookPageAccessToken);
  });

  test("the connection-status queries report state without returning a credential", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const org = await seedOrgWithSecrets(t, "a");

    const facebook = await org.asOwner.query(api.facebookIntegrations.getConnectionStatus, { orgId: org.orgId });
    const instagram = await org.asOwner.query(api.socialIntegrations.getConnectionStatus, { orgId: org.orgId });

    expect(facebook.facebookConnected).toBe(true);
    expect(instagram.instagramConnected).toBe(true);
    // Values only: these responses legitimately reuse two flag names as derived keys.
    expectNoSentinels(facebook);
    expectNoSentinels(instagram);
  });
});

describe("the platform admin's org detail (SCRUM-843 sibling)", () => {
  const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;
  beforeEach(() => {
    process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
  });
  afterEach(() => {
    if (ORIGINAL_ALLOWLIST === undefined) delete process.env.SUPER_ADMIN_EMAILS;
    else process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
  });

  test("getOrgDetail returns the org's public settings and never its credentials", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const org = await seedOrgWithSecrets(t, "a");
    await t.run((ctx) => ctx.db.insert("users", { clerkId: "dev_admin", email: "admin@autoflow.dev" }));
    const asAdmin = t.withIdentity({ subject: "dev_admin" });

    const detail = await asAdmin.query(api.adminOrgs.getOrgDetail, { orgId: org.orgId });

    expect(detail.settings).toMatchObject({ currency: "JOD", dealershipName: "Sentinel Motors" });
    expectNoServerOnlyData(detail.settings);
    expect(JSON.stringify(detail)).not.toContain("SENTINEL-");
  });

  test("a non-admin owner still cannot read it", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const org = await seedOrgWithSecrets(t, "a");
    await expect(org.asOwner.query(api.adminOrgs.getOrgDetail, { orgId: org.orgId })).rejects.toThrow(/Super-admin/);
  });

  // getOrgDetail hands the admin the settings row's id (the projection keeps `_id`), and
  // adminGetRecord resolves a record by its id's REAL table. Naming another browsable table
  // used to return the raw row, credentials included.
  test("adminGetRecord cannot be pointed at the settings row by naming a different table", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const org = await seedOrgWithSecrets(t, "a");
    await t.run((ctx) => ctx.db.insert("users", { clerkId: "dev_admin", email: "admin@autoflow.dev" }));
    const asAdmin = t.withIdentity({ subject: "dev_admin" });
    const settingsId = (await asAdmin.query(api.adminOrgs.getOrgDetail, { orgId: org.orgId })).settings!._id;

    await expect(asAdmin.query(api.adminData.adminGetRecord, { table: "vehicles", id: settingsId })).rejects.toThrow(
      /does not belong to table/
    );
    // The settings table itself is not a browsable admin table.
    await expect(asAdmin.query(api.adminData.adminGetRecord, { table: "orgSettings", id: settingsId })).rejects.toThrow(
      /not a browsable admin table/
    );
  });

  test("adminGetRecord still returns a record that does belong to the named table", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const org = await seedOrgWithSecrets(t, "a");
    await t.run((ctx) => ctx.db.insert("users", { clerkId: "dev_admin", email: "admin@autoflow.dev" }));
    const asAdmin = t.withIdentity({ subject: "dev_admin" });
    const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId: org.orgId, firstName: "Ada", lastName: "Test" }));

    const record = await asAdmin.query(api.adminData.adminGetRecord, { table: "customers", id: customerId });

    expect(record).toMatchObject({ _id: customerId, firstName: "Ada" });
  });
});
