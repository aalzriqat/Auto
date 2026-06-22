import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
}));

vi.mock("./utils/facebookApi", () => ({
  postCommentReply: vi.fn().mockResolvedValue({ ok: true }),
  postDirectMessage: vi.fn().mockResolvedValue({ ok: true }),
  FACEBOOK_GRAPH_VERSION: "v21.0",
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
    expect(notifications[0].title).toContain("Facebook Comment");
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
