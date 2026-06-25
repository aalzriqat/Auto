import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

vi.mock("./utils/facebookApi", () => ({
  postCommentReply: vi.fn().mockResolvedValue({ ok: true }),
  postDirectMessage: vi.fn().mockResolvedValue({ ok: true }),
  FACEBOOK_GRAPH_VERSION: "v25.0",
}));

async function seedOrgWithManager(t: ReturnType<typeof convexTest>) {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: "Test Org", createdAt: Date.now() })
  );
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId: "fb_manager_001", email: "fbmanager@test.com", name: "Manager" })
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: ["manage:users"] })
  );
  await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { orgId, userId };
}

async function seedOrgWithEditor(t: ReturnType<typeof convexTest>) {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: "Test Org", createdAt: Date.now() })
  );
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId: "fb_editor_001", email: "fbeditor@test.com", name: "Editor" })
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:leads", "edit:leads"] })
  );
  await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { orgId, userId, asEditor: t.withIdentity({ subject: "fb_editor_001" }) };
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
      facebookPageId: "page_business_1",
      facebookPageAccessToken: "page_token_abc",
      ...overrides,
    })
  );
}

describe("facebookEngagement.handleIncomingFacebookEvent", () => {
  test("creates a customer, an open lead, and notifies managers on a new comment", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId } = await seedOrgWithManager(t);

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, {
        orgId,
        kind: "comment",
        externalId: "fb_comment_1",
        senderFacebookId: "fb_user_1",
        senderName: "Jane Doe",
        text: "Is this still available?",
      })
    );
    expect(result?.shouldAutoReply).toBe(false);

    const customers = await t.run((ctx) => ctx.db.query("customers").collect());
    expect(customers.length).toBe(1);
    expect(customers[0].facebookUserId).toBe("fb_user_1");

    const leads = await t.run((ctx) => ctx.db.query("leads").collect());
    expect(leads.length).toBe(1);
    expect(leads[0].source).toBe("Facebook Comment");
    expect(leads[0].stage).toBe("NEW");

    const notifications = await t.run((ctx) =>
      ctx.db
        .query("notifications")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect()
    );
    expect(notifications.length).toBe(1);
    expect(notifications[0].type).toBe("social.lead_created");
    expect((notifications[0].data as any)?.platform).toContain("Facebook Comment");
  });

  test("links the new lead to the vehicle via the comment's post id", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId } = await seedOrgWithManager(t);

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "1HGCM82633A005555",
        make: "BYD",
        model: "Seal",
        year: 2025,
        mileage: 0,
        color: "White",
        fuelType: "Electric",
        transmission: "Automatic",
        sellingPrice: 28000,
        status: "AVAILABLE",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("socialPosts", {
        orgId,
        vehicleId,
        platform: "facebook",
        status: "PUBLISHED",
        imageStorageIds: [],
        externalPostId: "fb_post_123",
        triggeredBy: "manual",
        requestedBy: userId,
        requestedAt: Date.now(),
      })
    );

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, {
        orgId,
        kind: "comment",
        externalId: "fb_comment_with_post",
        senderFacebookId: "fb_user_vehicle_test",
        text: "Is this available?",
        mediaId: "fb_post_123",
      })
    );

    const lead = await t.run((ctx) => ctx.db.get(result!.leadId!));
    expect(lead?.vehicleId).toBe(vehicleId);
  });

  test("dedupes redelivered webhook events (same externalId processed once)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);

    const args = {
      orgId,
      kind: "dm" as const,
      externalId: "fb_msg_1",
      senderFacebookId: "fb_user_2",
      text: "Hi there",
    };
    const first = await t.run((ctx) => ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, args));
    const second = await t.run((ctx) => ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, args));

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const leads = await t.run((ctx) => ctx.db.query("leads").collect());
    expect(leads.length).toBe(1);
  });

  test("auto-replies round-robin and respects the 24h per-sender cooldown", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, {
      facebookAutoReplyEnabled: true,
      facebookAutoReplyMessages: ["Thanks!", "We'll be in touch."],
    });

    const first = await t.run((ctx) =>
      ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, {
        orgId,
        kind: "comment",
        externalId: "fb_auto_1",
        senderFacebookId: "fb_user_auto",
        text: "hi",
      })
    );
    expect(first?.shouldAutoReply).toBe(true);
    expect(first?.replyText).toBe("Thanks!");

    const second = await t.run((ctx) =>
      ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, {
        orgId,
        kind: "dm",
        externalId: "fb_auto_2",
        senderFacebookId: "fb_user_auto",
        text: "hi again",
      })
    );
    expect(second?.shouldAutoReply).toBe(false);
  });

  test("lead creation toggle off for comments: still captures the event, no lead, no notification", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, {
      facebookLeadFromCommentsEnabled: false,
      facebookAutoReplyEnabled: true,
      facebookAutoReplyMessages: ["Thanks for the comment!"],
    });

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, {
        orgId,
        kind: "comment",
        externalId: "fb_no_lead_comment",
        senderFacebookId: "fb_user_no_lead",
        text: "nice car",
      })
    );
    expect(result?.leadId).toBeUndefined();
    expect(result?.shouldAutoReply).toBe(true); // auto-reply is independent of lead creation
    expect(result?.customerId).toBeDefined();

    const leads = await t.run((ctx) => ctx.db.query("leads").collect());
    expect(leads.length).toBe(0);

    const event = await t.run((ctx) =>
      ctx.db
        .query("facebookEvents")
        .withIndex("by_org_external", (q) => q.eq("orgId", orgId).eq("externalId", "fb_no_lead_comment"))
        .unique()
    );
    expect(event).not.toBeNull();
    expect(event?.leadId).toBeUndefined();

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
    await seedSettings(t, orgId, { facebookLeadFromDmsEnabled: false });

    const commentResult = await t.run((ctx) =>
      ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, {
        orgId,
        kind: "comment",
        externalId: "fb_mixed_comment",
        senderFacebookId: "fb_user_mixed",
        text: "comment",
      })
    );
    expect(commentResult?.leadId).toBeDefined();

    const dmResult = await t.run((ctx) =>
      ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, {
        orgId,
        kind: "dm",
        externalId: "fb_mixed_dm",
        senderFacebookId: "fb_user_mixed_2",
        text: "dm",
      })
    );
    expect(dmResult?.leadId).toBeUndefined();
  });
});

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

async function seedSocialPost(t: ReturnType<typeof convexTest>, orgId: any, vehicleId: any, externalPostId: string) {
  const requestedBy = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `fb_poster_${externalPostId}`, email: `${externalPostId}@test.com`, name: "Poster" })
  );
  await t.run((ctx) =>
    ctx.db.insert("socialPosts", {
      orgId,
      vehicleId,
      platform: "facebook",
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
  senderFacebookId = `sender_${externalId}`
) {
  await seedSocialPost(t, orgId, vehicleId, `media_${externalId}`);
  return t.run((ctx) =>
    ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, {
      orgId,
      kind: "comment",
      externalId,
      senderFacebookId,
      text,
      mediaId: `media_${externalId}`,
    })
  );
}

describe("facebookEngagement.handleIncomingFacebookEvent — Smart Reply", () => {
  test("price match on an available vehicle returns the price template", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, { facebookSmartReplyEnabled: true });
    const vehicleId = await seedVehicle(t, orgId, { sellingPrice: 25000 });

    const result = await postCommentAboutVehicle(t, orgId, vehicleId, "fb_sr_price", "بكم هاي السيارة");

    expect(result?.shouldAutoReply).toBe(true);
    expect(result?.replyText).toContain("25000");

    const event = await t.run((ctx) =>
      ctx.db
        .query("facebookEvents")
        .withIndex("by_org_external", (q) => q.eq("orgId", orgId).eq("externalId", "fb_sr_price"))
        .unique()
    );
    expect(event?.autoReplySource).toBe("smart");
  });

  test("price match on a sold vehicle falls back to the unavailable template instead of a price", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, { facebookSmartReplyEnabled: true });
    const vehicleId = await seedVehicle(t, orgId, { status: "SOLD" });

    const result = await postCommentAboutVehicle(t, orgId, vehicleId, "fb_sr_price_sold", "how much is it");

    expect(result?.shouldAutoReply).toBe(true);
    expect(result?.replyText).not.toContain("25000");
  });

  test("financing match in calculated mode computes a monthly figure from the default finance company", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    const financeCompanyId = await seedFinanceCompany(t, orgId);
    await seedSettings(t, orgId, {
      facebookSmartReplyEnabled: true,
      smartReplyFinancingMode: "calculated",
      smartReplyDefaultFinanceCompanyId: financeCompanyId,
      smartReplyDefaultDownPaymentPercent: 20,
    });
    const vehicleId = await seedVehicle(t, orgId, { sellingPrice: 25000 });

    const result = await postCommentAboutVehicle(t, orgId, vehicleId, "fb_sr_finance", "monthly installment please");

    expect(result?.shouldAutoReply).toBe(true);
    expect(result?.replyText).toContain("/month");
  });

  test("a complaint suppresses both smart reply and canned reply and escalates to managers", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, {
      facebookSmartReplyEnabled: true,
      facebookAutoReplyEnabled: true,
      facebookAutoReplyMessages: ["Thanks for reaching out!"],
    });

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, {
        orgId,
        kind: "comment",
        externalId: "fb_sr_complaint",
        senderFacebookId: "sender_complaint",
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

  test("falls back to the canned reply when no vehicle is linked or no intent matches", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, {
      facebookSmartReplyEnabled: true,
      facebookAutoReplyEnabled: true,
      facebookAutoReplyMessages: ["Canned reply"],
    });

    const noVehicle = await t.run((ctx) =>
      ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, {
        orgId,
        kind: "comment",
        externalId: "fb_sr_no_vehicle",
        senderFacebookId: "sender_no_vehicle",
        text: "how much is this car",
      })
    );
    expect(noVehicle?.replyText).toBe("Canned reply");

    const noIntent = await t.run((ctx) =>
      ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, {
        orgId,
        kind: "comment",
        externalId: "fb_sr_no_intent",
        senderFacebookId: "sender_no_intent",
        text: "nice car!",
      })
    );
    expect(noIntent?.replyText).toBe("Canned reply");
  });

  test("Smart Reply disabled leaves the canned reply path fully unaffected (regression guard)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, {
      facebookSmartReplyEnabled: false,
      facebookAutoReplyEnabled: true,
      facebookAutoReplyMessages: ["Canned reply"],
    });
    const vehicleId = await seedVehicle(t, orgId);

    const result = await postCommentAboutVehicle(t, orgId, vehicleId, "fb_sr_disabled", "how much is it");

    expect(result?.shouldAutoReply).toBe(true);
    expect(result?.replyText).toBe("Canned reply");
  });

  test("visibility defaults to public, can be overridden to dm", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, { facebookSmartReplyEnabled: true });
    const vehicleId = await seedVehicle(t, orgId);

    const defaultResult = await postCommentAboutVehicle(t, orgId, vehicleId, "fb_sr_vis_default", "is it available?");
    expect(defaultResult?.smartReplyVisibility).toBe("public");

    const t2 = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId: orgId2 } = await seedOrgWithManager(t2);
    await seedSettings(t2, orgId2, { facebookSmartReplyEnabled: true, smartReplyVisibility: "dm" });
    const vehicleId2 = await seedVehicle(t2, orgId2);
    await seedSocialPost(t2, orgId2, vehicleId2, "media_fb_sr_vis_dm");

    const dmResult = await t2.run((ctx) =>
      ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, {
        orgId: orgId2,
        kind: "comment",
        externalId: "fb_sr_vis_dm",
        senderFacebookId: "sender_vis_dm",
        text: "is it available?",
        mediaId: "media_fb_sr_vis_dm",
      })
    );
    expect(dmResult?.smartReplyVisibility).toBe("dm");
  });

  test("DM-kind events always resolve to dm visibility, regardless of the visibility setting", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId, { facebookSmartReplyEnabled: true, smartReplyVisibility: "public" });
    const vehicleId = await seedVehicle(t, orgId);
    await seedSocialPost(t, orgId, vehicleId, "media_fb_sr_dm_kind");

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, {
        orgId,
        kind: "dm",
        externalId: "fb_sr_dm_kind",
        senderFacebookId: "sender_dm_kind",
        text: "is it available?",
        mediaId: "media_fb_sr_dm_kind",
      })
    );

    expect(result?.shouldAutoReply).toBe(true);
    expect(result?.smartReplyVisibility).toBe("dm");
  });

  test("reel-origin comments are labeled and stored with their source surface", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, {
        orgId,
        kind: "comment",
        externalId: "fb_reel_comment",
        senderFacebookId: "sender_reel_comment",
        text: "Interested in the BYD Song Pro 2025",
        mediaId: "page_reel_123",
        sourceSurface: "reel",
      })
    );

    const lead = await t.run((ctx) => ctx.db.get(result!.leadId!));
    expect(lead?.source).toBe("Facebook Reel Comment");
    expect(lead?.notes).toContain("Facebook Reel Comment");

    const event = await t.run((ctx) =>
      ctx.db
        .query("facebookEvents")
        .withIndex("by_org_external", (q) => q.eq("orgId", orgId).eq("externalId", "fb_reel_comment"))
        .unique()
    );
    expect(event?.sourceSurface).toBe("reel");
  });
});

describe("facebookEngagement.replyToFacebookComment", () => {
  test("posts the reply and records it on the event", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);
    await seedSettings(t, orgId);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Test", lastName: "Buyer", facebookUserId: "fb_reply_sender" })
    );
    const eventId = await t.run((ctx) =>
      ctx.db.insert("facebookEvents", {
        orgId,
        externalId: "fb_comment_to_reply",
        kind: "comment",
        senderFacebookId: "fb_reply_sender",
        customerId,
        text: "hello",
      })
    );

    await asEditor.action(api.facebookEngagement.replyToFacebookComment, {
      orgId,
      facebookEventId: eventId,
      message: "Thanks for reaching out!",
    });

    const event = await t.run((ctx) => ctx.db.get(eventId));
    expect(event?.manualReplyText).toBe("Thanks for reaching out!");
    expect(event?.manualRepliedAt).toBeDefined();
  });

  test("rejects replying to a DM event via the comment-reply action", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);
    await seedSettings(t, orgId);

    const eventId = await t.run((ctx) =>
      ctx.db.insert("facebookEvents", {
        orgId,
        externalId: "fb_dm_event",
        kind: "dm",
        senderFacebookId: "fb_dm_sender",
        text: "hi",
      })
    );

    await expect(
      asEditor.action(api.facebookEngagement.replyToFacebookComment, {
        orgId,
        facebookEventId: eventId,
        message: "hello",
      })
    ).rejects.toThrow(/not a comment/i);
  });
});

describe("facebookEngagement.sendFacebookDirectMessage", () => {
  test("sends to the most recent DM event's sender and records the reply there", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);
    await seedSettings(t, orgId);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "A", lastName: "B", facebookUserId: "fb_dm_sender2" })
    );
    const olderDmId = await t.run((ctx) =>
      ctx.db.insert("facebookEvents", { orgId, externalId: "fb_dm_old", kind: "dm", senderFacebookId: "fb_dm_sender2", customerId, text: "first" })
    );
    const newerDmId = await t.run((ctx) =>
      ctx.db.insert("facebookEvents", { orgId, externalId: "fb_dm_new", kind: "dm", senderFacebookId: "fb_dm_sender2", customerId, text: "second" })
    );

    await asEditor.action(api.facebookEngagement.sendFacebookDirectMessage, {
      orgId,
      customerId,
      message: "On our way!",
    });

    const older = await t.run((ctx) => ctx.db.get(olderDmId));
    const newer = await t.run((ctx) => ctx.db.get(newerDmId));
    expect(newer?.manualReplyText).toBe("On our way!");
    expect(older?.manualReplyText).toBeUndefined();
  });

  test("rejects sending a DM when the customer has no DM history", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);
    await seedSettings(t, orgId);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "A", lastName: "B" })
    );

    await expect(
      asEditor.action(api.facebookEngagement.sendFacebookDirectMessage, {
        orgId,
        customerId,
        message: "hello",
      })
    ).rejects.toThrow(/no facebook dm conversation/i);
  });
});
