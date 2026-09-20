import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const MODULES = import.meta.glob("./**/*.ts");

async function setupDm() {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Message Dealer", createdAt: Date.now() })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [], isSystemOwnerRole: true })
  );
  const aliceId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "alice_dm", email: "alice@test.com", name: "Alice" })
  );
  const bobId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "bob_dm", email: "bob@test.com", name: "Bob" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: aliceId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: bobId, roleId }));

  const asAlice = t.withIdentity({ subject: "alice_dm", clerkId: "alice_dm" });
  const asBob = t.withIdentity({ subject: "bob_dm", clerkId: "bob_dm" });
  const conversationId = await asAlice.mutation(api.directMessages.getOrCreateDm, {
    orgId,
    otherUserId: bobId,
  });

  return { orgId, conversationId, asAlice, asBob };
}

type DmTestContext = Awaited<ReturnType<typeof setupDm>>;

async function latestStatus(actor: DmTestContext["asAlice"], conversationId: DmTestContext["conversationId"]) {
  const page = await actor.query(api.directMessages.listMessages, {
    conversationId,
    paginationOpts: { numItems: 10, cursor: null },
  });
  return page.page[0]?.status;
}

describe("directMessages receipts", () => {
  test("delivery upgrades a sent message without marking it read", async () => {
    const { orgId, conversationId, asAlice, asBob } = await setupDm();

    await asAlice.mutation(api.directMessages.sendMessage, {
      conversationId,
      body: "Can you check this?",
    });

    expect(await latestStatus(asAlice, conversationId)).toBe("sent");

    await asBob.mutation(api.directMessages.markDelivered, { conversationId });

    expect(await latestStatus(asAlice, conversationId)).toBe("delivered");
    expect(await asBob.query(api.directMessages.getUnreadCount, { orgId })).toBe(1);

    await asBob.mutation(api.directMessages.markRead, { conversationId });

    expect(await latestStatus(asAlice, conversationId)).toBe("seen");
    expect(await asBob.query(api.directMessages.getUnreadCount, { orgId })).toBe(0);
  });

  test("sender delivery acknowledgements do not deliver their own messages", async () => {
    const { conversationId, asAlice } = await setupDm();

    await asAlice.mutation(api.directMessages.sendMessage, {
      conversationId,
      body: "Still only sent.",
    });
    await asAlice.mutation(api.directMessages.markDelivered, { conversationId });

    expect(await latestStatus(asAlice, conversationId)).toBe("sent");
  });

  test("empty conversations are not unread or delivered", async () => {
    const { orgId, conversationId, asBob } = await setupDm();

    expect(await asBob.query(api.directMessages.getUnreadCount, { orgId })).toBe(0);

    await asBob.mutation(api.directMessages.markDelivered, { conversationId });

    const conversations = await asBob.query(api.directMessages.listConversations, { orgId });
    expect(conversations[0]?.hasUnread).toBe(false);
    expect(conversations[0]?.lastDeliveredAt).toBe(0);
  });
});

describe("directMessages member-scoped visibility", () => {
  test("other members' first 100 conversations cannot hide mine or my unread count", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Busy Message Dealer", createdAt: Date.now() })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [], isSystemOwnerRole: true })
    );
    const [aliceId, bobId, charlieId] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.insert("users", { clerkId: "alice_visibility", email: "alice.visibility@test.com", name: "Alice" }),
        ctx.db.insert("users", { clerkId: "bob_visibility", email: "bob.visibility@test.com", name: "Bob" }),
        ctx.db.insert("users", { clerkId: "charlie_visibility", email: "charlie.visibility@test.com", name: "Charlie" }),
      ])
    );
    await t.run(async (ctx) => {
      await Promise.all([
        ctx.db.insert("memberships", { orgId, userId: aliceId, roleId }),
        ctx.db.insert("memberships", { orgId, userId: bobId, roleId }),
        ctx.db.insert("memberships", { orgId, userId: charlieId, roleId }),
      ]);

      for (let index = 0; index < 100; index++) {
        await ctx.db.insert("dmConversations", {
          orgId,
          type: "DM",
          memberIds: [aliceId, charlieId],
          createdBy: aliceId,
          lastMessageAt: 10_000 + index,
          lastMessageBody: `noise-${index}`,
          lastMessageSenderId: aliceId,
        });
      }
    });

    const targetConversationId = await t.run(async (ctx) => {
      const conversationId = await ctx.db.insert("dmConversations", {
        orgId,
        type: "DM",
        memberIds: [aliceId, bobId],
        createdBy: aliceId,
        // Deliberately older activity than all 100 unrelated conversations.
        lastMessageAt: 1,
        lastMessageBody: "target",
        lastMessageSenderId: aliceId,
      });
      await ctx.db.insert("dmParticipantState", {
        conversationId,
        userId: bobId,
        orgId,
        conversationLastMessageAt: 1,
        hasUnread: true,
        lastReadAt: 0,
      });
      return conversationId;
    });

    const asBob = t.withIdentity({ subject: "bob_visibility", clerkId: "bob_visibility" });

    const conversations = await asBob.query(api.directMessages.listConversations, { orgId });
    expect(conversations.map((conversation) => conversation._id)).toContain(targetConversationId);

    const page = await asBob.query(api.directMessages.listConversationsPage, {
      orgId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page.map((conversation) => conversation._id)).toContain(targetConversationId);
    expect(await asBob.query(api.directMessages.getUnreadCount, { orgId })).toBe(1);
  });
});

describe("directMessages notifications", () => {
  test("sending a message notifies the other member in-app", async () => {
    const { orgId, conversationId, asAlice, asBob } = await setupDm();

    await asAlice.mutation(api.directMessages.sendMessage, {
      conversationId,
      body: "Hey, can you check this?",
    });

    const bobNotifications = await asBob.query(api.notifications.listPage, {
      orgId,
      showArchived: false,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(bobNotifications.page).toHaveLength(1);
    expect(bobNotifications.page[0].type).toBe("message.received");
    expect(bobNotifications.page[0].data).toEqual({ senderName: "Alice", preview: "Hey, can you check this?" });

    // The sender doesn't notify themselves.
    const aliceNotifications = await asAlice.query(api.notifications.listPage, {
      orgId,
      showArchived: false,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(aliceNotifications.page).toHaveLength(0);
  });

  test("muting a conversation suppresses its message notifications", async () => {
    const { orgId, conversationId, asAlice, asBob } = await setupDm();

    await asBob.mutation(api.directMessages.setMuted, { conversationId, isMuted: true });
    await asAlice.mutation(api.directMessages.sendMessage, {
      conversationId,
      body: "This should be muted.",
    });

    const bobNotifications = await asBob.query(api.notifications.listPage, {
      orgId,
      showArchived: false,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(bobNotifications.page).toHaveLength(0);
  });
});
