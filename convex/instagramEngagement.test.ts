import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
}));

vi.mock("./utils/instagramApi", () => ({
  postCommentReply: vi.fn().mockResolvedValue({ ok: true }),
  postDirectMessage: vi.fn().mockResolvedValue({ ok: true }),
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
    expect(notifications[0].title).toContain("Instagram Comment");
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
      ctx.db.insert("instagramEvents", { orgId, externalId: "dm_old", kind: "dm", senderInstagramId: "sender_dm2", leadId, text: "first" })
    );
    const newerDmId = await t.run((ctx) =>
      ctx.db.insert("instagramEvents", { orgId, externalId: "dm_new", kind: "dm", senderInstagramId: "sender_dm2", leadId, text: "second" })
    );

    await asEditor.action(api.instagramEngagement.sendInstagramDirectMessage, {
      orgId,
      leadId,
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
    const leadId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId, source: "Walk-in", stage: "NEW" })
    );

    await expect(
      asEditor.action(api.instagramEngagement.sendInstagramDirectMessage, {
        orgId,
        leadId,
        message: "hello",
      })
    ).rejects.toThrow(/no instagram dm conversation/i);
  });
});
