import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

vi.mock("./utils/instagramApi", () => ({
  postCommentReply: vi.fn().mockResolvedValue({ ok: true }),
  postDirectMessage: vi.fn().mockResolvedValue({ ok: true }),
  INSTAGRAM_GRAPH_VERSION: "v21.0",
}));

async function seedOrgWithManager(t: ReturnType<typeof convexTest>) {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: "Test Org", createdAt: Date.now() })
  );
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId: "manager_001", email: "manager@test.com", name: "Manager" })
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: ["manage:users"] })
  );
  await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { orgId, userId };
}

/** A user with view:leads + edit:leads, for the public listing/reply actions. */
async function seedOrgWithEditor(t: ReturnType<typeof convexTest>) {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: "Test Org", createdAt: Date.now() })
  );
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId: "editor_001", email: "editor@test.com", name: "Editor" })
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:leads", "edit:leads"] })
  );
  await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { orgId, userId, asEditor: t.withIdentity({ subject: "editor_001" }) };
}

async function seedSettings(
  t: ReturnType<typeof convexTest>,
  orgId: any,
  overrides: Record<string, unknown> = {}
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "د.أ",
      enabledPaymentTypes: ["CASH"],
      instagramBusinessAccountId: "ig_business_1",
      instagramWebhookAccountId: "ig_webhook_1",
      instagramAccessToken: "token_abc",
      ...overrides,
    })
  );
}

async function seedVehicle(
  t: ReturnType<typeof convexTest>,
  orgId: any,
  overrides: Record<string, unknown> = {}
) {
  return await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: `VIN_${Math.random().toString(36).slice(2)}`,
      make: "BYD",
      model: "Qin L",
      year: 2025,
      mileage: 1200,
      color: "Black",
      fuelType: "Electric",
      transmission: "Automatic",
      sellingPrice: 25000,
      status: "AVAILABLE",
      ...overrides,
    })
  );
}

async function seedFinanceCompany(
  t: ReturnType<typeof convexTest>,
  orgId: any,
  overrides: Record<string, unknown> = {}
) {
  return await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name: "Test Bank",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      insuranceRate: 1,
      adminFees: 100,
      commission: 0,
      isActive: true,
      ...overrides,
    })
  );
}

describe("instagramEngagement.handleIncomingInstagramEvent", () => {
  test("creates a customer, an open lead, and notifies managers on a new comment", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId } = await seedOrgWithManager(t);

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "comment",
        externalId: "comment_1",
        senderInstagramId: "ig_user_1",
        senderUsername: "jane_doe",
        text: "Is this still available?",
      })
    );
    expect(result?.shouldAutoReply).toBe(false);

    const customers = await t.run((ctx) => ctx.db.query("customers").collect());
    expect(customers.length).toBe(1);
    expect(customers[0].instagramUserId).toBe("ig_user_1");

    const leads = await t.run((ctx) => ctx.db.query("leads").collect());
    expect(leads.length).toBe(1);
    expect(leads[0].source).toBe("Instagram Comment");
    expect(leads[0].stage).toBe("NEW");

    const notifications = await t.run((ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    );
    expect(notifications.length).toBe(1);
    expect(notifications[0].type).toBe("social.lead_created");
    expect((notifications[0].data as any)?.platform).toContain("Instagram Comment");
  });

  test("flags needsProfileEnrichment for a DM with no username, not for a comment with one", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);

    const dmResult = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "dm",
        externalId: "dm_no_username",
        senderInstagramId: "ig_user_dm",
        text: "hi",
      })
    );
    expect(dmResult?.needsProfileEnrichment).toBe(true);
    expect(dmResult?.customerId).toBeDefined();

    const commentResult = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "comment",
        externalId: "comment_with_username",
        senderInstagramId: "ig_user_comment",
        senderUsername: "real_handle",
        text: "hi",
      })
    );
    expect(commentResult?.needsProfileEnrichment).toBe(false);
  });

  test("links the new lead to the vehicle via the comment's media id", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId } = await seedOrgWithManager(t);

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "1HGCM82633A004444",
        make: "BYD",
        model: "Qin L",
        year: 2025,
        mileage: 0,
        color: "Black",
        fuelType: "Electric",
        transmission: "Automatic",
        sellingPrice: 25000,
        status: "AVAILABLE",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("socialPosts", {
        orgId,
        vehicleId,
        platform: "instagram",
        status: "PUBLISHED",
        imageStorageIds: [],
        externalPostId: "media_123",
        triggeredBy: "manual",
        requestedBy: userId,
        requestedAt: Date.now(),
      })
    );

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "comment",
        externalId: "comment_with_media",
        senderInstagramId: "ig_user_vehicle_test",
        text: "Is this available?",
        mediaId: "media_123",
      })
    );

    const lead = await t.run((ctx) => ctx.db.get(result!.leadId!));
    expect(lead?.vehicleId).toBe(vehicleId);

    const event = await t.run((ctx) =>
      ctx.db
        .query("instagramEvents")
        .withIndex("by_org_external", (q) => q.eq("orgId", orgId).eq("externalId", "comment_with_media"))
        .unique()
    );
    expect(event?.vehicleId).toBe(vehicleId);
  });

  test("dedupes redelivered webhook events (same externalId processed once)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);

    const args = {
      orgId,
      kind: "dm" as const,
      externalId: "msg_1",
      senderInstagramId: "ig_user_2",
      text: "Hi there",
    };
    const first = await t.run((ctx) => ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, args));
    const second = await t.run((ctx) => ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, args));

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const leads = await t.run((ctx) => ctx.db.query("leads").collect());
    expect(leads.length).toBe(1);
  });

  test("reuses an existing open lead instead of creating a duplicate", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);

    await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "comment",
        externalId: "comment_1",
        senderInstagramId: "ig_user_3",
        text: "First message",
      })
    );
    await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "comment",
        externalId: "comment_2",
        senderInstagramId: "ig_user_3",
        text: "Second message",
      })
    );

    const leads = await t.run((ctx) => ctx.db.query("leads").collect());
    expect(leads.length).toBe(1);

    const events = await t.run((ctx) => ctx.db.query("instagramEvents").collect());
    expect(events.length).toBe(2);
  });

  test("lead creation toggle off for comments: still captures the event, no lead, no notification", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, {
      instagramLeadFromCommentsEnabled: false,
      instagramAutoReplyEnabled: true,
      instagramAutoReplyMessages: ["Thanks for the comment!"],
    });

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "comment",
        externalId: "ig_no_lead_comment",
        senderInstagramId: "ig_user_no_lead",
        text: "nice car",
      })
    );
    expect(result?.leadId).toBeUndefined();
    expect(result?.shouldAutoReply).toBe(true); // auto-reply is independent of lead creation
    expect(result?.customerId).toBeDefined();

    const leads = await t.run((ctx) => ctx.db.query("leads").collect());
    expect(leads.length).toBe(0);

    const notifications = await t.run((ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    );
    expect(notifications.length).toBe(0);
  });

  test("lead creation toggle off for DMs only: comments still create leads, DMs don't", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, { instagramLeadFromDmsEnabled: false });

    const commentResult = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "comment",
        externalId: "ig_mixed_comment",
        senderInstagramId: "ig_user_mixed",
        text: "comment",
      })
    );
    expect(commentResult?.leadId).toBeDefined();

    const dmResult = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "dm",
        externalId: "ig_mixed_dm",
        senderInstagramId: "ig_user_mixed_2",
        text: "dm",
      })
    );
    expect(dmResult?.leadId).toBeUndefined();
  });

  test("rotates round-robin through active auto-reply messages and skips when disabled", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);

    await seedSettings(t, orgId, {
      instagramAutoReplyEnabled: true,
      instagramAutoReplyMessages: ["Reply A", "Reply B", "Reply C"],
    });

    const r1 = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "comment",
        externalId: "c1",
        senderInstagramId: "sender_1",
        text: "hi",
      })
    );
    const r2 = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "comment",
        externalId: "c2",
        senderInstagramId: "sender_2",
        text: "hi",
      })
    );
    const r3 = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "comment",
        externalId: "c3",
        senderInstagramId: "sender_3",
        text: "hi",
      })
    );

    expect([r1?.replyText, r2?.replyText, r3?.replyText]).toEqual(["Reply A", "Reply B", "Reply C"]);
    expect([r1?.shouldAutoReply, r2?.shouldAutoReply, r3?.shouldAutoReply]).toEqual([true, true, true]);
  });

  test("suppresses a repeat auto-reply to the same sender within the cooldown window", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);

    await seedSettings(t, orgId, {
      instagramAutoReplyEnabled: true,
      instagramAutoReplyMessages: ["Reply A"],
    });

    const first = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "dm",
        externalId: "m1",
        senderInstagramId: "repeat_sender",
        text: "hi",
      })
    );
    const second = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "dm",
        externalId: "m2",
        senderInstagramId: "repeat_sender",
        text: "hi again",
      })
    );

    expect(first?.shouldAutoReply).toBe(true);
    expect(second?.shouldAutoReply).toBe(false);

    // Still logs the second event for audit, and still reuses the same open lead.
    const events = await t.run((ctx) => ctx.db.query("instagramEvents").collect());
    expect(events.length).toBe(2);
    const leads = await t.run((ctx) => ctx.db.query("leads").collect());
    expect(leads.length).toBe(1);
  });

  test("does not auto-reply when disabled even with messages configured", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);

    await seedSettings(t, orgId, {
      instagramAutoReplyEnabled: false,
      instagramAutoReplyMessages: ["Reply A"],
    });

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "comment",
        externalId: "c1",
        senderInstagramId: "sender_x",
        text: "hi",
      })
    );

    expect(result?.shouldAutoReply).toBe(false);
  });
});

async function seedSocialPost(t: ReturnType<typeof convexTest>, orgId: any, vehicleId: any, externalPostId: string) {
  const requestedBy = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `poster_${externalPostId}`, email: `${externalPostId}@test.com`, name: "Poster" })
  );
  await t.run((ctx) =>
    ctx.db.insert("socialPosts", {
      orgId,
      vehicleId,
      platform: "instagram",
      status: "PUBLISHED",
      imageStorageIds: [],
      externalPostId,
      triggeredBy: "manual",
      requestedBy,
      requestedAt: Date.now(),
    })
  );
}

async function postCommentAboutVehicle(
  t: ReturnType<typeof convexTest>,
  orgId: any,
  vehicleId: any,
  externalId: string,
  text: string,
  senderInstagramId = `sender_${externalId}`
) {
  await seedSocialPost(t, orgId, vehicleId, `media_${externalId}`);
  return t.run((ctx) =>
    ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
      orgId,
      kind: "comment",
      externalId,
      senderInstagramId,
      text,
      mediaId: `media_${externalId}`,
    })
  );
}

describe("instagramEngagement.handleIncomingInstagramEvent — Smart Reply", () => {
  test("price match on an available vehicle returns the price template", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, { instagramSmartReplyEnabled: true });
    const vehicleId = await seedVehicle(t, orgId, { sellingPrice: 25000 });

    const result = await postCommentAboutVehicle(t, orgId, vehicleId, "sr_price", "كم سعرها؟");

    expect(result?.shouldAutoReply).toBe(true);
    expect(result?.replyText).toContain("25000");

    const event = await t.run((ctx) =>
      ctx.db
        .query("instagramEvents")
        .withIndex("by_org_external", (q) => q.eq("orgId", orgId).eq("externalId", "sr_price"))
        .unique()
    );
    expect(event?.autoReplySource).toBe("smart");
  });

  test("price match on a sold vehicle falls back to the unavailable template instead of a price", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, { instagramSmartReplyEnabled: true });
    const vehicleId = await seedVehicle(t, orgId, { status: "SOLD" });

    const result = await postCommentAboutVehicle(t, orgId, vehicleId, "sr_price_sold", "how much is it");

    expect(result?.shouldAutoReply).toBe(true);
    expect(result?.replyText).not.toContain("25000");
  });

  test("financing match in calculated mode computes a monthly figure from the default finance company", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    const financeCompanyId = await seedFinanceCompany(t, orgId);
    await seedSettings(t, orgId, {
      instagramSmartReplyEnabled: true,
      smartReplyFinancingMode: "calculated",
      smartReplyDefaultFinanceCompanyId: financeCompanyId,
      smartReplyDefaultDownPaymentPercent: 20,
    });
    const vehicleId = await seedVehicle(t, orgId, { sellingPrice: 25000 });

    const result = await postCommentAboutVehicle(t, orgId, vehicleId, "sr_finance_calc", "monthly installment please");

    expect(result?.shouldAutoReply).toBe(true);
    expect(result?.replyText).toMatch(/\d/); // contains a computed number
  });

  test("financing match in generic mode (default) has no computed number", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, { instagramSmartReplyEnabled: true });
    const vehicleId = await seedVehicle(t, orgId);

    const result = await postCommentAboutVehicle(t, orgId, vehicleId, "sr_finance_generic", "تقسيط");

    expect(result?.shouldAutoReply).toBe(true);
    expect(result?.replyText).not.toContain("/month");
  });

  test("financing calculated mode without a configured finance company falls back to generic, does not throw", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, {
      instagramSmartReplyEnabled: true,
      smartReplyFinancingMode: "calculated",
    });
    const vehicleId = await seedVehicle(t, orgId);

    const result = await postCommentAboutVehicle(t, orgId, vehicleId, "sr_finance_nocompany", "financing?");

    expect(result?.shouldAutoReply).toBe(true);
    expect(result?.replyText).not.toContain("/month");
  });

  test("availability match reflects each vehicle status", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, { instagramSmartReplyEnabled: true });

    const availableId = await seedVehicle(t, orgId, { status: "AVAILABLE" });
    const soldId = await seedVehicle(t, orgId, { status: "SOLD" });
    const reservedId = await seedVehicle(t, orgId, { status: "RESERVED" });

    const r1 = await postCommentAboutVehicle(t, orgId, availableId, "sr_avail_1", "is it still available?");
    const r2 = await postCommentAboutVehicle(t, orgId, soldId, "sr_avail_2", "available?");
    const r3 = await postCommentAboutVehicle(t, orgId, reservedId, "sr_avail_3", "still have it?");

    expect(r1?.replyText).toBeDefined();
    expect(r2?.replyText).toBeDefined();
    expect(r3?.replyText).toBeDefined();
    expect(r1?.replyText).not.toBe(r2?.replyText);
    expect(r2?.replyText).not.toBe(r3?.replyText);
  });

  test("vehicleInfo match returns vehicle spec details", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, { instagramSmartReplyEnabled: true });
    const vehicleId = await seedVehicle(t, orgId, { mileage: 4500 });

    const result = await postCommentAboutVehicle(t, orgId, vehicleId, "sr_vehicleinfo", "كم ماشيتها");

    expect(result?.shouldAutoReply).toBe(true);
    expect(result?.replyText).toContain("4500");
  });

  test("location match uses dealershipAddress when set, falls back to a generic message otherwise", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId: orgWithAddress } = await seedOrgWithManager(t);
    await seedSettings(t, orgWithAddress, {
      instagramSmartReplyEnabled: true,
      dealershipName: "AutoFlow Motors",
      dealershipAddress: "Amman, Jordan",
    });

    const withAddress = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId: orgWithAddress,
        kind: "comment",
        externalId: "sr_location_1",
        senderInstagramId: "sender_loc_1",
        text: "where is your showroom",
      })
    );
    expect(withAddress?.replyText).toContain("Amman, Jordan");

    const t2 = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId: orgNoAddress } = await seedOrgWithManager(t2);
    await seedSettings(t2, orgNoAddress, { instagramSmartReplyEnabled: true });

    const noAddress = await t2.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId: orgNoAddress,
        kind: "comment",
        externalId: "sr_location_2",
        senderInstagramId: "sender_loc_2",
        text: "وين موقعكم",
      })
    );
    expect(noAddress?.shouldAutoReply).toBe(true);
    expect(noAddress?.replyText).not.toContain("Amman");
  });

  test("greeting only fires when no higher-priority intent also matches", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, { instagramSmartReplyEnabled: true });

    const greetingOnly = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "comment",
        externalId: "sr_greet_1",
        senderInstagramId: "sender_greet_1",
        text: "hello!",
      })
    );
    expect(greetingOnly?.shouldAutoReply).toBe(true);

    const vehicleId = await seedVehicle(t, orgId);
    const greetingAndPrice = await postCommentAboutVehicle(t, orgId, vehicleId, "sr_greet_2", "hi, how much is it");
    expect(greetingAndPrice?.replyText).toMatch(/\d/); // resolved to price, not the static greeting
  });

  test("a complaint suppresses both smart reply and canned reply and escalates to managers", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, {
      instagramSmartReplyEnabled: true,
      instagramAutoReplyEnabled: true,
      instagramAutoReplyMessages: ["Thanks for reaching out!"],
    });

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "comment",
        externalId: "sr_complaint",
        senderInstagramId: "sender_complaint",
        text: "there is a serious problem with this car",
      })
    );

    expect(result?.shouldAutoReply).toBe(false);
    expect(result?.replyText).toBeUndefined();

    const notifications = await t.run((ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    );
    expect(notifications.some((n) => n.type === "social.possible_complaint")).toBe(true);
  });

  test("Smart Reply enabled but no vehicle linked falls back to the canned reply for vehicle-dependent intents", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, {
      instagramSmartReplyEnabled: true,
      instagramAutoReplyEnabled: true,
      instagramAutoReplyMessages: ["Canned reply"],
    });

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "comment",
        externalId: "sr_no_vehicle",
        senderInstagramId: "sender_no_vehicle",
        text: "how much is this car",
      })
    );

    expect(result?.shouldAutoReply).toBe(true);
    expect(result?.replyText).toBe("Canned reply");
  });

  test("Smart Reply enabled but no intent matched falls back to the canned reply", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, {
      instagramSmartReplyEnabled: true,
      instagramAutoReplyEnabled: true,
      instagramAutoReplyMessages: ["Canned reply"],
    });

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "comment",
        externalId: "sr_no_intent",
        senderInstagramId: "sender_no_intent",
        text: "nice car!",
      })
    );

    expect(result?.shouldAutoReply).toBe(true);
    expect(result?.replyText).toBe("Canned reply");

    const event = await t.run((ctx) =>
      ctx.db
        .query("instagramEvents")
        .withIndex("by_org_external", (q) => q.eq("orgId", orgId).eq("externalId", "sr_no_intent"))
        .unique()
    );
    expect(event?.autoReplySource).toBe("canned");
  });

  test("Smart Reply disabled leaves the canned reply path fully unaffected (regression guard)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, {
      instagramSmartReplyEnabled: false,
      instagramAutoReplyEnabled: true,
      instagramAutoReplyMessages: ["Canned reply"],
    });
    const vehicleId = await seedVehicle(t, orgId);

    const result = await postCommentAboutVehicle(t, orgId, vehicleId, "sr_disabled", "how much is it");

    expect(result?.shouldAutoReply).toBe(true);
    expect(result?.replyText).toBe("Canned reply");
  });

  test("visibility defaults to public, can be overridden to dm, for comment-kind matches", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, { instagramSmartReplyEnabled: true });
    const vehicleId = await seedVehicle(t, orgId);

    const defaultResult = await postCommentAboutVehicle(t, orgId, vehicleId, "sr_vis_default", "is it available?");
    expect(defaultResult?.smartReplyVisibility).toBe("public");

    const t2 = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId: orgId2 } = await seedOrgWithManager(t2);
    await seedSettings(t2, orgId2, { instagramSmartReplyEnabled: true, smartReplyVisibility: "dm" });
    const vehicleId2 = await seedVehicle(t2, orgId2);
    await seedSocialPost(t2, orgId2, vehicleId2, "media_sr_vis_dm");
    const dmResult = await t2.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId: orgId2,
        kind: "comment",
        externalId: "sr_vis_dm",
        senderInstagramId: "sender_vis_dm",
        text: "is it available?",
        mediaId: "media_sr_vis_dm",
      })
    );
    expect(dmResult?.smartReplyVisibility).toBe("dm");
  });

  test("DM-kind events always resolve to dm visibility, regardless of the visibility setting", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, { instagramSmartReplyEnabled: true, smartReplyVisibility: "public" });
    const vehicleId = await seedVehicle(t, orgId);
    await seedSocialPost(t, orgId, vehicleId, "media_sr_dm_kind");

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
        orgId,
        kind: "dm",
        externalId: "sr_dm_kind",
        senderInstagramId: "sender_dm_kind",
        text: "is it available?",
        mediaId: "media_sr_dm_kind",
      })
    );

    expect(result?.shouldAutoReply).toBe(true);
    expect(result?.smartReplyVisibility).toBe("dm");
  });

  test("Smart Reply is not subject to the 24h canned-reply cooldown — two distinct questions both get answered", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, { instagramSmartReplyEnabled: true });
    const vehicleId = await seedVehicle(t, orgId);

    const first = await postCommentAboutVehicle(t, orgId, vehicleId, "sr_cooldown_1", "how much is it?", "sender_cooldown");
    const second = await postCommentAboutVehicle(t, orgId, vehicleId, "sr_cooldown_2", "is it still available?", "sender_cooldown");

    expect(first?.shouldAutoReply).toBe(true);
    expect(second?.shouldAutoReply).toBe(true);
  });
});

describe("instagramEngagement.getSettingsByInstagramAccountId", () => {
  test("reverse-looks-up orgSettings by the webhook account id (not the OAuth business account id)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId);

    const found = await t.run((ctx) =>
      ctx.runQuery(internal.instagramEngagement.getSettingsByInstagramAccountId, {
        instagramBusinessAccountId: "ig_webhook_1",
      })
    );
    expect(found?.orgId).toBe(orgId);

    const notFound = await t.run((ctx) =>
      ctx.runQuery(internal.instagramEngagement.getSettingsByInstagramAccountId, {
        instagramBusinessAccountId: "does_not_exist",
      })
    );
    expect(notFound).toBeNull();
  });
});

describe("instagramEngagement.listEvents", () => {
  test("returns a paginated, org-wide list with hydrated vehicle/lead info", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "VIN_LIST_1",
        make: "Kia",
        model: "Sportage",
        year: 2024,
        mileage: 0,
        color: "White",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 20000,
        status: "AVAILABLE",
      })
    );
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Buyer", instagramUserId: "sender_list" })
    );
    const leadId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId, vehicleId, source: "Instagram Comment", stage: "NEW" })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "ev1",
        kind: "comment",
        senderInstagramId: "sender_list",
        leadId,
        vehicleId,
        text: "hi",
      })
    );

    const result = await asEditor.query(api.instagramEngagement.listEvents, {
      orgId,
      paginationOpts: { numItems: 25, cursor: null },
    });

    expect(result.page.length).toBe(1);
    expect(result.page[0].vehicleSummary).toBe("2024 Kia Sportage");
    expect(result.page[0].leadStage).toBe("NEW");
  });
});

describe("instagramEngagement.listConversations", () => {
  test("collapses multiple events on one lead into a single conversation row", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "VIN_CONV_1",
        make: "Kia",
        model: "Sportage",
        year: 2024,
        mileage: 0,
        color: "White",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 20000,
        status: "AVAILABLE",
      })
    );
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Buyer", instagramUserId: "sender_conv" })
    );
    const leadId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId, vehicleId, source: "Instagram Comment", stage: "NEW" })
    );

    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "conv1",
        kind: "comment",
        senderInstagramId: "sender_conv",
        leadId,
        customerId,
        vehicleId,
        text: "first",
        autoRepliedAt: Date.now(),
        autoReplyText: "thanks!",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "conv2",
        kind: "dm",
        senderInstagramId: "sender_conv",
        leadId,
        customerId,
        vehicleId,
        text: "second",
      })
    );

    const result = await asEditor.query(api.instagramEngagement.listConversations, {
      orgId,
      paginationOpts: { numItems: 25, cursor: null },
    });

    expect(result.page.length).toBe(1);
    expect(result.page[0].leadId).toBe(leadId);
    expect(result.page[0].eventCount).toBe(2);
    expect(result.page[0].needsReply).toBe(true); // the DM has no reply yet
    expect(result.page[0].vehicleCount).toBe(1);
    expect(result.page[0].latestText).toBe("second"); // most recently inserted
  });

  test("keeps separate leads as separate conversations, most recent first", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const customerAId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "A", lastName: "Buyer", instagramUserId: "sender_a" })
    );
    const customerBId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "B", lastName: "Buyer", instagramUserId: "sender_b" })
    );
    const leadAId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId: customerAId, source: "Instagram Comment", stage: "NEW" })
    );
    const leadBId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId: customerBId, source: "Instagram Comment", stage: "NEW" })
    );

    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "leadA-1",
        kind: "comment",
        senderInstagramId: "sender_a",
        leadId: leadAId,
        customerId: customerAId,
        text: "from A",
        manualRepliedAt: Date.now(),
        manualReplyText: "reply to A",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "leadB-1",
        kind: "comment",
        senderInstagramId: "sender_b",
        leadId: leadBId,
        customerId: customerBId,
        text: "from B",
      })
    );

    const result = await asEditor.query(api.instagramEngagement.listConversations, {
      orgId,
      paginationOpts: { numItems: 25, cursor: null },
    });

    expect(result.page.length).toBe(2);
    // Most recently active conversation (leadB, inserted last) comes first.
    expect(result.page[0].leadId).toBe(leadBId);
    expect(result.page[0].needsReply).toBe(true);
    expect(result.page[1].leadId).toBe(leadAId);
    expect(result.page[1].needsReply).toBe(false);
  });
});

describe("instagramEngagement.listEventsForLead", () => {
  test("returns only events for the given lead, oldest first", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "A", lastName: "B", instagramUserId: "sender_a" })
    );
    const leadId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId, source: "Instagram Comment", stage: "NEW" })
    );
    const otherLeadId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId, source: "Instagram Comment", stage: "WON" })
    );

    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", { orgId, externalId: "a1", kind: "comment", senderInstagramId: "sender_a", leadId, text: "first" })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", { orgId, externalId: "a2", kind: "dm", senderInstagramId: "sender_a", leadId, text: "second" })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", { orgId, externalId: "a3", kind: "comment", senderInstagramId: "sender_a", leadId: otherLeadId, text: "unrelated" })
    );

    const events = await asEditor.query(api.instagramEngagement.listEventsForLead, { orgId, leadId });
    expect(events.length).toBe(2);
    expect(events.map((e) => e.text)).toEqual(["first", "second"]);
  });
});

describe("instagramEngagement.replyToInstagramComment", () => {
  test("posts the reply and records it on the event", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);
    await seedSettings(t, orgId);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "A", lastName: "B", instagramUserId: "sender_reply" })
    );
    const leadId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId, source: "Instagram Comment", stage: "NEW" })
    );
    const eventId = await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "comment_to_reply",
        kind: "comment",
        senderInstagramId: "sender_reply",
        leadId,
        text: "Is this available?",
      })
    );

    await asEditor.action(api.instagramEngagement.replyToInstagramComment, {
      orgId,
      instagramEventId: eventId,
      message: "Yes, still available!",
    });

    const event = await t.run((ctx) => ctx.db.get(eventId));
    expect(event?.manualReplyText).toBe("Yes, still available!");
    expect(event?.manualRepliedAt).toBeTypeOf("number");
  });

  test("rejects replying to a DM event as if it were a comment", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);
    await seedSettings(t, orgId);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "A", lastName: "B", instagramUserId: "sender_dm" })
    );
    const leadId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId, source: "Instagram DM", stage: "NEW" })
    );
    const eventId = await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "dm_event",
        kind: "dm",
        senderInstagramId: "sender_dm",
        leadId,
        text: "hi",
      })
    );

    await expect(
      asEditor.action(api.instagramEngagement.replyToInstagramComment, {
        orgId,
        instagramEventId: eventId,
        message: "hello",
      })
    ).rejects.toThrow(/not a comment/i);
  });
});

describe("instagramEngagement.sendInstagramDirectMessage", () => {
  test("sends to the most recent DM event's sender and records the reply there", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);
    await seedSettings(t, orgId);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "A", lastName: "B", instagramUserId: "sender_dm2" })
    );
    const leadId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId, source: "Instagram DM", stage: "NEW" })
    );
    const olderDmId = await t.run((ctx) =>
      ctx.db.insert("instagramEvents", { orgId, externalId: "dm_old", kind: "dm", senderInstagramId: "sender_dm2", customerId, leadId, text: "first" })
    );
    const newerDmId = await t.run((ctx) =>
      ctx.db.insert("instagramEvents", { orgId, externalId: "dm_new", kind: "dm", senderInstagramId: "sender_dm2", customerId, leadId, text: "second" })
    );

    await asEditor.action(api.instagramEngagement.sendInstagramDirectMessage, {
      orgId,
      customerId,
      message: "On our way!",
    });

    const older = await t.run((ctx) => ctx.db.get(olderDmId));
    const newer = await t.run((ctx) => ctx.db.get(newerDmId));
    expect(newer?.manualReplyText).toBe("On our way!");
    expect(older?.manualReplyText).toBeUndefined();
  });

  test("rejects sending a DM when the lead has no DM history", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);
    await seedSettings(t, orgId);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "A", lastName: "B" })
    );

    await expect(
      asEditor.action(api.instagramEngagement.sendInstagramDirectMessage, {
        orgId,
        customerId,
        message: "hello",
      })
    ).rejects.toThrow(/no instagram dm conversation/i);
  });
});

describe("instagramEngagement.enrichCustomerProfile", () => {
  test("fetches the sender's real name and applies it to the placeholder customer", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Instagram",
        lastName: "Contact",
        instagramUserId: "ig_user_enrich",
      })
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ username: "real_username" }) })
    );

    await t.action(internal.instagramEngagement.enrichCustomerProfile, {
      orgId,
      customerId,
      senderInstagramId: "ig_user_enrich",
    });

    const customer = await t.run((ctx) => ctx.db.get(customerId));
    expect(customer?.firstName).toBe("real_username");

    vi.unstubAllGlobals();
  });

  test("does not overwrite a name that's already been resolved", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Already",
        lastName: "Named",
        instagramUserId: "ig_user_named",
      })
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ username: "should_not_apply" }) })
    );

    await t.action(internal.instagramEngagement.enrichCustomerProfile, {
      orgId,
      customerId,
      senderInstagramId: "ig_user_named",
    });

    const customer = await t.run((ctx) => ctx.db.get(customerId));
    expect(customer?.firstName).toBe("Already");

    vi.unstubAllGlobals();
  });
});

describe("instagramEngagement.listEvents / listEventsForLead — senderDisplayName", () => {
  test("prefers the event's username, falls back to the customer's resolved name, then the raw id", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const namedCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Resolved", lastName: "Name", instagramUserId: "ig_named" })
    );
    const placeholderCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Instagram", lastName: "Contact", instagramUserId: "ig_unresolved" })
    );

    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "disp_1",
        kind: "comment",
        senderInstagramId: "ig_with_username",
        senderUsername: "has_username",
        text: "hi",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "disp_2",
        kind: "dm",
        senderInstagramId: "ig_named",
        customerId: namedCustomerId,
        text: "hi",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "disp_3",
        kind: "dm",
        senderInstagramId: "ig_unresolved",
        customerId: placeholderCustomerId,
        text: "hi",
      })
    );

    const result = await asEditor.query(api.instagramEngagement.listEvents, {
      orgId,
      paginationOpts: { numItems: 25, cursor: null },
    });
    const byExternalId = Object.fromEntries(result.page.map((e: any) => [e.externalId, e.senderDisplayName]));

    expect(byExternalId["disp_1"]).toBe("has_username");
    expect(byExternalId["disp_2"]).toBe("Resolved Name");
    expect(byExternalId["disp_3"]).toBe("ig_unresolved");
  });
});
