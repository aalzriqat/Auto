import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
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
  test("reverse-looks-up orgSettings by the Instagram business account id", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithManager(t);
    await seedSettings(t, orgId);

    const found = await t.run((ctx) =>
      ctx.runQuery(internal.instagramEngagement.getSettingsByInstagramAccountId, {
        instagramBusinessAccountId: "ig_business_1",
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
