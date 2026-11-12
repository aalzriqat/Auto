import { describe, expect, test } from "vitest";
import { readSettingsAndSharedMobile } from "./utils/socialMobile";
// Load real route modules during collection, rather than the first signed request.
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { T } from "../test-utils/socialWebhook";
import { newT, seedOrg, post, igDm, fbDm, snapshot, PROD_LIKE_IG, PROD_LIKE_FB } from "../test-utils/socialWebhook";
import "./http";

type ContactCase = {
  platform: "instagram" | "facebook";
  extra: Record<string, unknown>;
  text?: string;
  eventContext?: Record<string, unknown>;
  requiresMobile?: boolean;
  senders?: string[];
  expectedPhone?: string;
  expectedLeads?: number;
};

const sharedPost = (type: string) => ({
  attachments: [{ type, payload: { title: "Synthetic showroom caption 0790000001" } }],
});

type OwnNumberSource = "settingsPrimary" | "settingsExtra" | "staff" | "branch" | "branchExtra"
  | "dealerProfile" | "dealerFlow" | "staffSellerPhone" | "staffSellerWhatsapp" | "staffSellerProfile";
const OWN_PHONE = "0790000001";
const CUSTOMER_PHONE = "0780000002";

async function seedOwnNumber(t: T, orgId: Id<"organizations">, source: OwnNumberSource, phone = OWN_PHONE) {
  await t.run(async (ctx) => {
    const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
    if (!member) throw new Error("Synthetic staff fixture missing");
    if (source === "settingsPrimary" || source === "settingsExtra") {
      const settings = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique();
      if (!settings) throw new Error("Synthetic settings fixture missing");
      await ctx.db.patch(settings._id, source === "settingsPrimary" ? { dealershipPhone: phone } : { dealershipPhones: [phone] });
    } else if (source === "staff") {
      await ctx.db.patch(member.userId, { whatsappPhone: phone });
    } else if (source === "branch" || source === "branchExtra") {
      await ctx.db.insert("branches", { orgId, name: "Synthetic branch", isActive: true,
        ...(source === "branch" ? { phone } : { additionalPhones: [phone] }) });
    } else if (source === "dealerProfile") {
      await ctx.db.insert("marketplaceDealerProfiles", { orgId, whatsappNumber: phone, isOptedIn: false,
        areas: [], brandsCarried: [], badges: [], totalResponses: 0, totalAccepted: 0,
        tier: "FREE_FOUNDING", leadsUsedThisPeriod: 0, createdAt: 1, updatedAt: 1 });
    } else if (source === "dealerFlow") {
      await ctx.db.insert("marketplaceWhatsAppFlows", { orgId, phone, step: "COMPLETED", photoStorageIds: [], createdAt: 1, updatedAt: 1 });
    } else if (source === "staffSellerProfile") {
      await ctx.db.insert("marketplaceIndividualSellerProfiles", { sellerUserId: member.userId,
        sellerKind: "INDIVIDUAL", phone, createdAt: 1, updatedAt: 1 });
    } else {
      // Orgless seller records can outlive the seller joining a dealership.
      await ctx.db.insert("marketplaceListings", { sellerUserId: member.userId, sellerKind: "INDIVIDUAL",
        sellerDisplayName: "Synthetic seller", sellerPhone: source === "staffSellerPhone" ? phone : "",
        sellerWhatsapp: source === "staffSellerWhatsapp" ? phone : undefined,
        make: "Synthetic", model: "Fixture", year: 2020, mileage: 0, price: 1, currency: "JOD",
        transmission: "AUTO", fuelType: "OTHER", city: "Synthetic", description: "Fixture",
        condition: "GOOD", imageIds: [], status: "SOLD", createdAt: 1, updatedAt: 1 });
    }
  });
}

async function ownNumberOrg(t: T, platform: "instagram" | "facebook") {
  return seedOrg(t, {
    ...(platform === "instagram" ? PROD_LIKE_IG : PROD_LIKE_FB),
    [`${platform}AutoReplyEnabled`]: true,
    [`${platform}AutoReplyMessages`]: ["Please type your number."],
    [`${platform}AutoReplyMobileReceivedMessage`]: "Number received.",
  });
}

async function assertOwnNumberIntake(t: T, orgId: Id<"organizations">, platform: "instagram" | "facebook", text: string, expectedPhone?: string) {
  const args = { orgId, kind: "dm" as const, externalId: `synthetic_${text}`, senderText: text, text };
  const result = platform === "instagram"
    ? await t.mutation(internal.instagramEngagement.handleIncomingInstagramEvent, { ...args, senderInstagramId: "synthetic_sender" })
    : await t.mutation(internal.facebookEngagement.handleIncomingFacebookEvent, { ...args, senderFacebookId: "synthetic_sender" });
  const state = await snapshot(t, orgId);
  expect(state.customers).toHaveLength(1);
  expect.soft(state.customers[0].phone).toBe(expectedPhone);
  expect.soft(state.customers[0].whatsapp).toBeUndefined();
  expect.soft(state.leads).toHaveLength(expectedPhone ? 1 : 0);
  expect.soft(result?.leadId).toBe(expectedPhone ? state.leads[0]?._id : undefined);
  expect.soft(result?.shouldAutoReply).toBe(true);
  expect.soft(result?.replyText).toBe(expectedPhone ? "Number received." : "Please type your number.");
}

async function assertOwnSource(platform: "instagram" | "facebook", source: OwnNumberSource, mixed: boolean) {
  const t = newT();
  const orgId = await ownNumberOrg(t, platform);
  await seedOwnNumber(t, orgId, source);
  await assertOwnNumberIntake(t, orgId, platform, mixed ? `${OWN_PHONE} / ${CUSTOMER_PHONE}` : OWN_PHONE, mixed ? CUSTOMER_PHONE : undefined);
}

async function measureSocialReads(platform: "instagram" | "facebook") {
  const t = newT();
  const orgId = await ownNumberOrg(t, platform);
  for (const source of ["settingsPrimary", "settingsExtra", "staff", "branch", "branchExtra", "dealerProfile", "dealerFlow", "staffSellerPhone", "staffSellerWhatsapp", "staffSellerProfile"] as const) {
    await seedOwnNumber(t, orgId, source);
  }
  const text = `${OWN_PHONE} / ${CUSTOMER_PHONE}`;
  const readerMetrics = await t.run(async (ctx) => {
    const result = await readSettingsAndSharedMobile(ctx, orgId, "dm", text);
    expect(result.sharedMobileNumber?.normalized).toBe(CUSTOMER_PHONE);
    return ctx.meta.getTransactionMetrics();
  });
  const doorMetrics = await t.run(async (ctx) => {
    const args = { orgId, kind: "dm" as const, externalId: "synthetic_metrics", senderText: text, text };
    const result = platform === "instagram"
      ? await ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, { ...args, senderInstagramId: "synthetic_metrics" })
      : await ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, { ...args, senderFacebookId: "synthetic_metrics" });
    expect(result?.leadId).toBeDefined();
    expect(result?.replyText).toBe("Number received.");
    return ctx.meta.getTransactionMetrics();
  });
  // Actual convex-test DB I/O, not production billing or platform/OCC evidence.
  console.info("SCRUM-949 measured I/O", JSON.stringify({ platform, readerMetrics, doorMetrics }));
  expect(readerMetrics.documentsRead.used).toBeLessThan(20);
  expect(doorMetrics.documentsRead.used).toBeLessThan(100);
}

test("SCRUM-949: instagram own-number census measured reads stay bounded", () => measureSocialReads("instagram"));
test("SCRUM-949: facebook own-number census measured reads stay bounded", () => measureSocialReads("facebook"));

async function assertForeignStaffTail(platform: "instagram" | "facebook") {
  const t = newT();
  const orgId = await ownNumberOrg(t, platform);
  await seedOwnNumber(t, orgId, "staff", "+213 780 000 002");
  await assertOwnNumberIntake(t, orgId, platform, CUSTOMER_PHONE, CUSTOMER_PHONE);
}

test("SCRUM-949: instagram foreign staff tail does not exclude a Jordanian customer", () => assertForeignStaffTail("instagram"));
test("SCRUM-949: facebook foreign staff tail does not exclude a Jordanian customer", () => assertForeignStaffTail("facebook"));

async function assertForeignStaffLandline(platform: "instagram" | "facebook") {
  const t = newT();
  const orgId = await ownNumberOrg(t, platform);
  await seedOwnNumber(t, orgId, "staff", "+39 06 000 0001");
  await assertOwnNumberIntake(t, orgId, platform, "060000001", "060000001");
}

async function assertAmbiguousStaffField(platform: "instagram" | "facebook") {
  const t = newT();
  const orgId = await ownNumberOrg(t, platform);
  await seedOwnNumber(t, orgId, "staff", "+971 50 0000000 0790000001");
  await assertOwnNumberIntake(t, orgId, platform, `${OWN_PHONE} / ${CUSTOMER_PHONE}`);
}

test("SCRUM-949: instagram foreign national zero does not exclude a Jordanian landline", () => assertForeignStaffLandline("instagram"));
test("SCRUM-949: facebook foreign national zero does not exclude a Jordanian landline", () => assertForeignStaffLandline("facebook"));
test("SCRUM-949: instagram ambiguous foreign staff field refuses extraction", () => assertAmbiguousStaffField("instagram"));
test("SCRUM-949: facebook ambiguous foreign staff field refuses extraction", () => assertAmbiguousStaffField("facebook"));

async function assertSourceOverflow(source: "branch" | "dealerProfile" | "dealerFlow" | "staffSellerPhone" | "staffSellerProfile") {
  const t = newT();
  const orgId = await ownNumberOrg(t, "instagram");
  for (let i = 0; i < 101; i++) await seedOwnNumber(t, orgId, source);
  await assertOwnNumberIntake(t, orgId, "instagram", `${CUSTOMER_PHONE} / ${OWN_PHONE}`);
}

test("SCRUM-949: branch census overflow refuses all extraction", () => assertSourceOverflow("branch"));
test("SCRUM-949: dealer profile census overflow refuses all extraction", () => assertSourceOverflow("dealerProfile"));
test("SCRUM-949: dealer flow census overflow refuses all extraction", () => assertSourceOverflow("dealerFlow"));
test("SCRUM-949: staff seller listing census overflow refuses all extraction", () => assertSourceOverflow("staffSellerPhone"));
test("SCRUM-949: duplicate staff seller profiles refuse all extraction", () => assertSourceOverflow("staffSellerProfile"));

test("SCRUM-949: missing staff user refuses all extraction", async () => {
  const t = newT();
  const orgId = await ownNumberOrg(t, "instagram");
  await t.run(async (ctx) => {
    const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
    if (!member) throw new Error("Synthetic staff fixture missing");
    await ctx.db.delete(member.userId);
  });
  await assertOwnNumberIntake(t, orgId, "instagram", CUSTOMER_PHONE);
});

test("SCRUM-949: exactly 100 staff still exclude the last staff number and admit the customer", async () => {
  const t = newT();
  const orgId = await ownNumberOrg(t, "instagram");
  await t.run(async (ctx) => {
    const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
    if (!member) throw new Error("Synthetic staff fixture missing");
    for (let i = 0; i < 99; i++) {
      const userId = await ctx.db.insert("users", { clerkId: `synthetic_${i}`, email: `synthetic_${i}@example.invalid`, whatsappPhone: i === 98 ? OWN_PHONE : undefined });
      await ctx.db.insert("memberships", { orgId, userId, roleId: member.roleId });
    }
  });
  await assertOwnNumberIntake(t, orgId, "instagram", `${OWN_PHONE} / ${CUSTOMER_PHONE}`, CUSTOMER_PHONE);
  const metrics = await t.run(async (ctx) => {
    const result = await readSettingsAndSharedMobile(ctx, orgId, "dm", `${OWN_PHONE} / ${CUSTOMER_PHONE}`);
    expect(result.sharedMobileNumber?.normalized).toBe(CUSTOMER_PHONE);
    return ctx.meta.getTransactionMetrics();
  });
  console.info("SCRUM-949 100-staff reader I/O", JSON.stringify(metrics));
  expect(metrics.documentsRead.used).toBeLessThanOrEqual(201);
});

describe("SCRUM-949 instagram complete own-number sources", () => {
  const platform = "instagram" as const;
  test("SCRUM-949: instagram refuses only primary settings phone", () => assertOwnSource(platform, "settingsPrimary", false));
  test("SCRUM-949: instagram preserves customer number beside primary settings phone", () => assertOwnSource(platform, "settingsPrimary", true));
  test("SCRUM-949: instagram refuses only extra settings phone", () => assertOwnSource(platform, "settingsExtra", false));
  test("SCRUM-949: instagram preserves customer number beside extra settings phone", () => assertOwnSource(platform, "settingsExtra", true));
  test("SCRUM-949: instagram refuses only staff WhatsApp", () => assertOwnSource(platform, "staff", false));
  test("SCRUM-949: instagram preserves customer number beside staff WhatsApp", () => assertOwnSource(platform, "staff", true));
  test("SCRUM-949: instagram refuses only branch phone", () => assertOwnSource(platform, "branch", false));
  test("SCRUM-949: instagram preserves customer number beside branch phone", () => assertOwnSource(platform, "branch", true));
  test("SCRUM-949: instagram refuses only additional branch phone", () => assertOwnSource(platform, "branchExtra", false));
  test("SCRUM-949: instagram preserves customer number beside additional branch phone", () => assertOwnSource(platform, "branchExtra", true));
  test("SCRUM-949: instagram refuses only dealer profile WhatsApp", () => assertOwnSource(platform, "dealerProfile", false));
  test("SCRUM-949: instagram preserves customer number beside dealer profile WhatsApp", () => assertOwnSource(platform, "dealerProfile", true));
  test("SCRUM-949: instagram refuses only dealer flow phone", () => assertOwnSource(platform, "dealerFlow", false));
  test("SCRUM-949: instagram preserves customer number beside dealer flow phone", () => assertOwnSource(platform, "dealerFlow", true));
  test("SCRUM-949: instagram refuses only staff seller phone", () => assertOwnSource(platform, "staffSellerPhone", false));
  test("SCRUM-949: instagram preserves customer number beside staff seller phone", () => assertOwnSource(platform, "staffSellerPhone", true));
  test("SCRUM-949: instagram refuses only staff seller WhatsApp", () => assertOwnSource(platform, "staffSellerWhatsapp", false));
  test("SCRUM-949: instagram preserves customer number beside staff seller WhatsApp", () => assertOwnSource(platform, "staffSellerWhatsapp", true));
  test("SCRUM-949: instagram refuses only staff seller profile phone", () => assertOwnSource(platform, "staffSellerProfile", false));
  test("SCRUM-949: instagram preserves customer number beside staff seller profile phone", () => assertOwnSource(platform, "staffSellerProfile", true));
    test("SCRUM-949: instagram does not exclude another tenant staff number", async () => {
      const t = newT();
      const orgId = await ownNumberOrg(t, platform);
      const otherOrgId = await seedOrg(t, {});
      await seedOwnNumber(t, otherOrgId, "staff");
      await assertOwnNumberIntake(t, orgId, platform, OWN_PHONE, OWN_PHONE);
    });

    test("SCRUM-949: instagram refuses extraction when staff census exceeds 100", async () => {
      const t = newT();
      const orgId = await ownNumberOrg(t, platform);
      await t.run(async (ctx) => {
        const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
        if (!member) throw new Error("Synthetic staff fixture missing");
        for (let i = 0; i < 100; i++) {
          const userId = await ctx.db.insert("users", { clerkId: `synthetic_${i}`, email: `synthetic_${i}@example.invalid`, whatsappPhone: i === 99 ? OWN_PHONE : undefined });
          await ctx.db.insert("memberships", { orgId, userId, roleId: member.roleId });
        }
      });
      await assertOwnNumberIntake(t, orgId, platform, `${CUSTOMER_PHONE} / ${OWN_PHONE}`);
    });

    test("SCRUM-949: instagram excludes stored staff format variants", async () => {
      for (const stored of ["79 000 0001", "＋٩٦٢ (٠)٧٩ ٠٠٠ ٠٠٠١", "962\u200b79\u200b000\u200b0001", "79 000 0001 / 78 000 0003", "79 000 0001 78 000 0003", "+971 50 1234567 / 0790000001"]) {
        const t = newT();
        const orgId = await ownNumberOrg(t, platform);
        await seedOwnNumber(t, orgId, "staff", stored);
        await assertOwnNumberIntake(t, orgId, platform, `${OWN_PHONE} / ${CUSTOMER_PHONE}`, CUSTOMER_PHONE);
      }
    });

    test("SCRUM-949: instagram excludes deactivated and offboarding staff", async () => {
      const t = newT();
      const orgId = await ownNumberOrg(t, platform);
      await seedOwnNumber(t, orgId, "staff");
      await t.run(async (ctx) => {
        const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
        if (!member) throw new Error("Synthetic staff fixture missing");
        await ctx.db.patch(member.userId, { disabled: true, clerkDeletedAt: 1 });
        await ctx.db.patch(member._id, { offboardingStatus: "PENDING_EXTERNAL_REMOVAL" });
      });
      await assertOwnNumberIntake(t, orgId, platform, OWN_PHONE);
    });

    test("SCRUM-949: instagram staff buying as a customer cannot qualify using own number", async () => {
      const t = newT();
      const orgId = await ownNumberOrg(t, platform);
      await seedOwnNumber(t, orgId, "staff");
      await t.run(async (ctx) => {
        await ctx.db.insert("customers", { orgId, firstName: "Synthetic", lastName: "Staff buyer", createdAt: 1,
          instagramUserId: "synthetic_sender" });
      });
      await assertOwnNumberIntake(t, orgId, platform, OWN_PHONE);
    });

    test("SCRUM-949: instagram excludes branch landline variants", async () => {
      const t = newT();
      const orgId = await ownNumberOrg(t, platform);
      await seedOwnNumber(t, orgId, "branch", "+962 6 000 0001");
      await assertOwnNumberIntake(t, orgId, platform, `06 000 0001 / ${CUSTOMER_PHONE}`, CUSTOMER_PHONE);
    });

    test("SCRUM-949: instagram excludes a number shared by two organizations", async () => {
      const t = newT();
      const orgId = await ownNumberOrg(t, platform);
      const otherOrgId = await seedOrg(t, {});
      await seedOwnNumber(t, orgId, "staff");
      await seedOwnNumber(t, otherOrgId, "staff");
      await assertOwnNumberIntake(t, orgId, platform, `${OWN_PHONE} / ${CUSTOMER_PHONE}`, CUSTOMER_PHONE);
    });
});

describe("SCRUM-949 facebook complete own-number sources", () => {
  const platform = "facebook" as const;
  test("SCRUM-949: facebook refuses only primary settings phone", () => assertOwnSource(platform, "settingsPrimary", false));
  test("SCRUM-949: facebook preserves customer number beside primary settings phone", () => assertOwnSource(platform, "settingsPrimary", true));
  test("SCRUM-949: facebook refuses only extra settings phone", () => assertOwnSource(platform, "settingsExtra", false));
  test("SCRUM-949: facebook preserves customer number beside extra settings phone", () => assertOwnSource(platform, "settingsExtra", true));
  test("SCRUM-949: facebook refuses only staff WhatsApp", () => assertOwnSource(platform, "staff", false));
  test("SCRUM-949: facebook preserves customer number beside staff WhatsApp", () => assertOwnSource(platform, "staff", true));
  test("SCRUM-949: facebook refuses only branch phone", () => assertOwnSource(platform, "branch", false));
  test("SCRUM-949: facebook preserves customer number beside branch phone", () => assertOwnSource(platform, "branch", true));
  test("SCRUM-949: facebook refuses only additional branch phone", () => assertOwnSource(platform, "branchExtra", false));
  test("SCRUM-949: facebook preserves customer number beside additional branch phone", () => assertOwnSource(platform, "branchExtra", true));
  test("SCRUM-949: facebook refuses only dealer profile WhatsApp", () => assertOwnSource(platform, "dealerProfile", false));
  test("SCRUM-949: facebook preserves customer number beside dealer profile WhatsApp", () => assertOwnSource(platform, "dealerProfile", true));
  test("SCRUM-949: facebook refuses only dealer flow phone", () => assertOwnSource(platform, "dealerFlow", false));
  test("SCRUM-949: facebook preserves customer number beside dealer flow phone", () => assertOwnSource(platform, "dealerFlow", true));
  test("SCRUM-949: facebook refuses only staff seller phone", () => assertOwnSource(platform, "staffSellerPhone", false));
  test("SCRUM-949: facebook preserves customer number beside staff seller phone", () => assertOwnSource(platform, "staffSellerPhone", true));
  test("SCRUM-949: facebook refuses only staff seller WhatsApp", () => assertOwnSource(platform, "staffSellerWhatsapp", false));
  test("SCRUM-949: facebook preserves customer number beside staff seller WhatsApp", () => assertOwnSource(platform, "staffSellerWhatsapp", true));
  test("SCRUM-949: facebook refuses only staff seller profile phone", () => assertOwnSource(platform, "staffSellerProfile", false));
  test("SCRUM-949: facebook preserves customer number beside staff seller profile phone", () => assertOwnSource(platform, "staffSellerProfile", true));
    test("SCRUM-949: facebook does not exclude another tenant staff number", async () => {
      const t = newT();
      const orgId = await ownNumberOrg(t, platform);
      const otherOrgId = await seedOrg(t, {});
      await seedOwnNumber(t, otherOrgId, "staff");
      await assertOwnNumberIntake(t, orgId, platform, OWN_PHONE, OWN_PHONE);
    });

    test("SCRUM-949: facebook refuses extraction when staff census exceeds 100", async () => {
      const t = newT();
      const orgId = await ownNumberOrg(t, platform);
      await t.run(async (ctx) => {
        const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
        if (!member) throw new Error("Synthetic staff fixture missing");
        for (let i = 0; i < 100; i++) {
          const userId = await ctx.db.insert("users", { clerkId: `synthetic_${i}`, email: `synthetic_${i}@example.invalid`, whatsappPhone: i === 99 ? OWN_PHONE : undefined });
          await ctx.db.insert("memberships", { orgId, userId, roleId: member.roleId });
        }
      });
      await assertOwnNumberIntake(t, orgId, platform, `${CUSTOMER_PHONE} / ${OWN_PHONE}`);
    });

    test("SCRUM-949: facebook excludes stored staff format variants", async () => {
      for (const stored of ["79 000 0001", "＋٩٦٢ (٠)٧٩ ٠٠٠ ٠٠٠١", "962\u200b79\u200b000\u200b0001", "79 000 0001 / 78 000 0003", "79 000 0001 78 000 0003", "+971 50 1234567 / 0790000001"]) {
        const t = newT();
        const orgId = await ownNumberOrg(t, platform);
        await seedOwnNumber(t, orgId, "staff", stored);
        await assertOwnNumberIntake(t, orgId, platform, `${OWN_PHONE} / ${CUSTOMER_PHONE}`, CUSTOMER_PHONE);
      }
    });

    test("SCRUM-949: facebook excludes deactivated and offboarding staff", async () => {
      const t = newT();
      const orgId = await ownNumberOrg(t, platform);
      await seedOwnNumber(t, orgId, "staff");
      await t.run(async (ctx) => {
        const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
        if (!member) throw new Error("Synthetic staff fixture missing");
        await ctx.db.patch(member.userId, { disabled: true, clerkDeletedAt: 1 });
        await ctx.db.patch(member._id, { offboardingStatus: "PENDING_EXTERNAL_REMOVAL" });
      });
      await assertOwnNumberIntake(t, orgId, platform, OWN_PHONE);
    });

    test("SCRUM-949: facebook staff buying as a customer cannot qualify using own number", async () => {
      const t = newT();
      const orgId = await ownNumberOrg(t, platform);
      await seedOwnNumber(t, orgId, "staff");
      await t.run(async (ctx) => {
        await ctx.db.insert("customers", { orgId, firstName: "Synthetic", lastName: "Staff buyer", createdAt: 1,
          facebookUserId: "synthetic_sender" });
      });
      await assertOwnNumberIntake(t, orgId, platform, OWN_PHONE);
    });

    test("SCRUM-949: facebook excludes branch landline variants", async () => {
      const t = newT();
      const orgId = await ownNumberOrg(t, platform);
      await seedOwnNumber(t, orgId, "branch", "+962 6 000 0001");
      await assertOwnNumberIntake(t, orgId, platform, `06 000 0001 / ${CUSTOMER_PHONE}`, CUSTOMER_PHONE);
    });

    test("SCRUM-949: facebook excludes a number shared by two organizations", async () => {
      const t = newT();
      const orgId = await ownNumberOrg(t, platform);
      const otherOrgId = await seedOrg(t, {});
      await seedOwnNumber(t, orgId, "staff");
      await seedOwnNumber(t, otherOrgId, "staff");
      await assertOwnNumberIntake(t, orgId, platform, `${OWN_PHONE} / ${CUSTOMER_PHONE}`, CUSTOMER_PHONE);
    });
});

async function assertContactProvenance(input: ContactCase) {
  const t = newT();
  const prefix = input.platform;
  const orgId = await seedOrg(t, {
    ...(prefix === "instagram" ? PROD_LIKE_IG : PROD_LIKE_FB),
    dealershipPhone: "0790000003",
    [`${prefix}LeadFromDmsRequiresMobile`]: input.requiresMobile ?? true,
    [`${prefix}AutoReplyEnabled`]: true,
    [`${prefix}AutoReplyMessages`]: ["Please type your number."],
    [`${prefix}AutoReplyMobileReceivedMessage`]: "Number received.",
  });
  for (const sender of input.senders ?? ["synthetic_sender"]) {
    const payload = prefix === "instagram"
      ? igDm(sender, input.text, input.extra)
      : fbDm(sender, input.text, input.extra);
    Object.assign(payload.entry[0].messaging[0], input.eventContext);
    expect((await post(t, `/${prefix}-webhook`, payload)).status).toBe(200);
  }
  const state = await snapshot(t, orgId);
  const events = prefix === "instagram" ? state.igEvents : state.fbEvents;
  expect(state.customers).toHaveLength(input.senders?.length ?? 1);
  expect(state.leads).toHaveLength(input.expectedLeads ?? 0);
  expect(state.customers.map((customer) => customer.phone)).toEqual(
    (input.senders ?? ["synthetic_sender"]).map(() => input.expectedPhone),
  );
  for (const event of events) {
    expect(event.autoReplyText).toBe(input.expectedPhone ? "Number received." : "Please type your number.");
  }
  expect(events).toHaveLength(input.senders?.length ?? 1);
  if (input.extra.attachments || input.eventContext?.referral) {
    expect(events[0].text).toContain("0790000001");
    if (input.expectedLeads) expect(state.leads[0].notes).toContain("0790000001");
  }
}

async function assertUnprovenContactText(platform: "instagram" | "facebook", kind: "dm" | "comment", senderText?: string) {
  const t = newT();
  const orgId = await seedOrg(t, {
    ...(platform === "instagram" ? PROD_LIKE_IG : PROD_LIKE_FB),
    [`${platform}LeadFromCommentsEnabled`]: true,
    [`${platform}AutoReplyEnabled`]: true,
    [`${platform}AutoReplyMessages`]: ["Please type your number."],
    [`${platform}AutoReplyMobileReceivedMessage`]: "Number received.",
  });
  const args = { orgId, kind, externalId: "synthetic_replay", text: "Stored caption 0790000001", senderText };
  const result = platform === "instagram"
    ? await t.mutation(internal.instagramEngagement.handleIncomingInstagramEvent, { ...args, senderInstagramId: "synthetic_sender" })
    : await t.mutation(internal.facebookEngagement.handleIncomingFacebookEvent, { ...args, senderFacebookId: "synthetic_sender" });
  const state = await snapshot(t, orgId);
  expect(state.leads).toHaveLength(kind === "comment" ? 1 : 0);
  expect(state.customers[0].phone).toBeUndefined();
  expect(result?.replyText).toBe("Please type your number.");
}

describe("SCRUM-949 sender contact provenance", () => {
  test("SCRUM-949: Instagram ig_post caption cannot qualify a contact", () =>
    assertContactProvenance({ platform: "instagram", extra: sharedPost("ig_post") }));
  test("SCRUM-949: Instagram ig_reel caption cannot qualify a contact", () =>
    assertContactProvenance({ platform: "instagram", extra: sharedPost("ig_reel") }));
  test("SCRUM-949: Facebook share title cannot qualify a contact", () =>
    assertContactProvenance({ platform: "facebook", extra: sharedPost("share") }));
  test("SCRUM-949: Facebook fallback attachment title cannot qualify a contact", () =>
    assertContactProvenance({ platform: "facebook", extra: sharedPost("unknown") }));
  test("SCRUM-949: Facebook ad referral cannot qualify a contact", () =>
    assertContactProvenance({ platform: "facebook", extra: {}, eventContext: { referral: {
      source: "ADS", ad_id: "synthetic_ad", ref: "Call showroom 0790000001",
    } } }));
  test("SCRUM-949: two Instagram senders sharing one post receive no phone or lead", () =>
    assertContactProvenance({ platform: "instagram", extra: sharedPost("ig_post"), senders: ["synthetic_a", "synthetic_b"] }));
  test("SCRUM-949: two Facebook senders sharing one post receive no phone or lead", () =>
    assertContactProvenance({ platform: "facebook", extra: sharedPost("share"), senders: ["synthetic_a", "synthetic_b"] }));
  test("SCRUM-949: Instagram uses the typed phone beside a shared caption", () =>
    assertContactProvenance({ platform: "instagram", extra: sharedPost("ig_post"), text: "Call me 0790000002", expectedPhone: "0790000002", expectedLeads: 1 }));
  test("SCRUM-949: Facebook uses the typed phone beside a shared caption", () =>
    assertContactProvenance({ platform: "facebook", extra: sharedPost("share"), text: "Call me 0790000002", expectedPhone: "0790000002", expectedLeads: 1 }));
  test("SCRUM-949: Instagram still excludes the typed settings phone", () =>
    assertContactProvenance({ platform: "instagram", extra: {}, text: "0790000003" }));
  test("SCRUM-949: Facebook still excludes the typed settings phone", () =>
    assertContactProvenance({ platform: "facebook", extra: {}, text: "0790000003" }));
  test("SCRUM-949: Instagram share creates a phoneless lead when mobile is optional", () =>
    assertContactProvenance({ platform: "instagram", extra: sharedPost("ig_post"), requiresMobile: false, expectedLeads: 1 }));
  test("SCRUM-949: Facebook share creates a phoneless lead when mobile is optional", () =>
    assertContactProvenance({ platform: "facebook", extra: sharedPost("share"), requiresMobile: false, expectedLeads: 1 }));
  test("SCRUM-949: Instagram quick reply title and payload cannot qualify a contact", () =>
    assertContactProvenance({ platform: "instagram", extra: { quick_reply: { payload: "0790000001" } }, text: "0790000001" }));
  test("SCRUM-949: Facebook quick reply title and payload cannot qualify a contact", () =>
    assertContactProvenance({ platform: "facebook", extra: { quick_reply: { payload: "0790000001" } }, text: "0790000001" }));
  test("SCRUM-949: Instagram story reply context cannot qualify a contact", () =>
    assertContactProvenance({ platform: "instagram", extra: { reply_to: { story: { id: "synthetic_story" }, text: "0790000001" } } }));
  test("SCRUM-949: Instagram story mention cannot qualify a contact", () =>
    assertContactProvenance({ platform: "instagram", extra: sharedPost("story_mention") }));
  test("SCRUM-949: Facebook stored combined text without provenance refuses contact extraction", () =>
    assertUnprovenContactText("facebook", "dm"));
  test("SCRUM-949: Instagram stored combined text without provenance refuses contact extraction", () =>
    assertUnprovenContactText("instagram", "dm"));
  test("SCRUM-949: Instagram empty sender text never falls back to combined text", () =>
    assertUnprovenContactText("instagram", "dm", ""));
  test("SCRUM-949: Facebook empty sender text never falls back to combined text", () =>
    assertUnprovenContactText("facebook", "dm", ""));
  test("SCRUM-949: Instagram comments never extract a phone even from sender text", () =>
    assertUnprovenContactText("instagram", "comment", "0790000001"));
  test("SCRUM-949: Facebook comments never extract a phone even from sender text", () =>
    assertUnprovenContactText("facebook", "comment", "0790000001"));
});

