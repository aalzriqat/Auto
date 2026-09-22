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

describe("directMessages current-membership authority", () => {
  test("former org members cannot keep direct conversation read/write access from stale memberIds", async () => {
    const { t, orgId, conversationId, asBob } = await setupDm();

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) =>
          q.eq("orgId", orgId).eq("userId", (await ctx.db
            .query("users")
            .filter((q) => q.eq(q.field("clerkId"), "bob_dm"))
            .first())!._id),
        )
        .unique();
      if (!membership) throw new Error("Bob membership fixture missing");
      await ctx.db.delete(membership._id);
    });

    await expect(
      asBob.query(api.directMessages.listMessages, {
        conversationId,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow();

    await expect(
      asBob.query(api.directMessages.getConversation, { conversationId }),
    ).rejects.toThrow();

    await expect(
      asBob.mutation(api.directMessages.sendMessage, {
        conversationId,
        body: "former member must not send",
      }),
    ).rejects.toThrow();
  });
});

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

describe("directMessages member-scoped pagination", () => {
  test("pages only the caller's conversations in stable newest-first order without gaps or duplicates", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Paged Message Dealer", createdAt: Date.now() })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [], isSystemOwnerRole: true })
    );
    const [aliceId, bobId, charlieId] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.insert("users", { clerkId: "alice_paged", email: "alice.paged@test.com", name: "Alice" }),
        ctx.db.insert("users", { clerkId: "bob_paged", email: "bob.paged@test.com", name: "Bob" }),
        ctx.db.insert("users", { clerkId: "charlie_paged", email: "charlie.paged@test.com", name: "Charlie" }),
      ])
    );
    await t.run(async (ctx) => {
      await Promise.all([
        ctx.db.insert("memberships", { orgId, userId: aliceId, roleId }),
        ctx.db.insert("memberships", { orgId, userId: bobId, roleId }),
        ctx.db.insert("memberships", { orgId, userId: charlieId, roleId }),
      ]);

      for (let index = 0; index < 117; index++) {
        const lastMessageAt = 1_000 + index;
        const conversationId = await ctx.db.insert("dmConversations", {
          orgId,
          type: "DM",
          memberIds: [aliceId, bobId],
          createdBy: aliceId,
          lastMessageAt,
          lastMessageBody: `bob-${index}`,
          lastMessageSenderId: aliceId,
        });
        await ctx.db.insert("dmParticipantState", {
          conversationId,
          userId: bobId,
          orgId,
          conversationLastMessageAt: lastMessageAt,
          hasUnread: true,
          lastReadAt: 0,
        });
      }

      // More recent conversations for somebody else must have zero effect on
      // Bob's cursor or page size.
      for (let index = 0; index < 25; index++) {
        const lastMessageAt = 10_000 + index;
        const conversationId = await ctx.db.insert("dmConversations", {
          orgId,
          type: "DM",
          memberIds: [aliceId, charlieId],
          createdBy: aliceId,
          lastMessageAt,
          lastMessageBody: `charlie-${index}`,
          lastMessageSenderId: aliceId,
        });
        await ctx.db.insert("dmParticipantState", {
          conversationId,
          userId: charlieId,
          orgId,
          conversationLastMessageAt: lastMessageAt,
          hasUnread: true,
          lastReadAt: 0,
        });
      }
    });

    const asBob = t.withIdentity({ subject: "bob_paged", clerkId: "bob_paged" });
    const first = await asBob.query(api.directMessages.listConversationsPage, {
      orgId,
      paginationOpts: { numItems: 60, cursor: null },
    });
    expect(first.page).toHaveLength(60);
    expect(first.isDone).toBe(false);

    const second = await asBob.query(api.directMessages.listConversationsPage, {
      orgId,
      paginationOpts: { numItems: 60, cursor: first.continueCursor },
    });
    expect(second.page).toHaveLength(57);
    expect(second.isDone).toBe(true);

    const rows = [...first.page, ...second.page];
    expect(new Set(rows.map((row) => row._id)).size).toBe(117);
    expect(rows.every((row) => row.memberIds.includes(bobId))).toBe(true);
    expect(rows.map((row) => row.lastMessageAt)).toEqual(
      [...rows.map((row) => row.lastMessageAt)].sort((a, b) => b - a),
    );
  });
});

describe("directMessages projection compatibility", () => {
  test("legacy rows stay tenant-safe and getOrCreateDm self-heals the existing DM projection", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Legacy Projection Dealer", createdAt: Date.now() })
    );
    const otherOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [], isSystemOwnerRole: true })
    );
    const [aliceId, bobId] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.insert("users", { clerkId: "alice_legacy_dm", email: "alice.legacy@test.com", name: "Alice" }),
        ctx.db.insert("users", { clerkId: "bob_legacy_dm", email: "bob.legacy@test.com", name: "Bob" }),
      ])
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", { orgId, userId: aliceId, roleId });
      await ctx.db.insert("memberships", { orgId, userId: bobId, roleId });

      const conversationId = await ctx.db.insert("dmConversations", {
        orgId,
        type: "DM",
        memberIds: [aliceId, bobId],
        createdBy: aliceId,
        lastMessageAt: 500,
        lastMessageBody: "legacy target",
        lastMessageSenderId: aliceId,
      });
      await ctx.db.insert("dmParticipantState", {
        conversationId,
        userId: bobId,
        lastReadAt: 0,
      });

      const crossOrgConversationId = await ctx.db.insert("dmConversations", {
        orgId: otherOrgId,
        type: "DM",
        memberIds: [aliceId, bobId],
        createdBy: aliceId,
        lastMessageAt: 900,
        lastMessageBody: "wrong org",
        lastMessageSenderId: aliceId,
      });
      await ctx.db.insert("dmParticipantState", {
        conversationId: crossOrgConversationId,
        userId: bobId,
        lastReadAt: 0,
      });

      const orphanConversationId = await ctx.db.insert("dmConversations", {
        orgId,
        type: "DM",
        memberIds: [aliceId, bobId],
        createdBy: aliceId,
        lastMessageAt: 1_000,
        lastMessageBody: "deleted",
        lastMessageSenderId: aliceId,
      });
      await ctx.db.insert("dmParticipantState", {
        conversationId: orphanConversationId,
        userId: bobId,
        lastReadAt: 0,
      });
      await ctx.db.delete(orphanConversationId);

      return conversationId;
    });

    const targetConversation = await t.run((ctx) =>
      ctx.db
        .query("dmConversations")
        .withIndex("by_org_lastMessageAt", (q) => q.eq("orgId", orgId))
        .filter((q) => q.eq(q.field("lastMessageBody"), "legacy target"))
        .unique()
    );
    expect(targetConversation).not.toBeNull();

    const asBob = t.withIdentity({ subject: "bob_legacy_dm", clerkId: "bob_legacy_dm" });
    expect(await asBob.query(api.directMessages.getUnreadCount, { orgId })).toBe(1);

    const visible = await asBob.query(api.directMessages.listConversations, { orgId });
    expect(visible.map((conversation) => conversation._id)).toEqual([targetConversation!._id]);
    expect(visible[0]?.hasUnread).toBe(true);

    const existingId = await asBob.mutation(api.directMessages.getOrCreateDm, {
      orgId,
      otherUserId: aliceId,
    });
    expect(existingId).toBe(targetConversation!._id);

    const [bobState, aliceState] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db
          .query("dmParticipantState")
          .withIndex("by_conversation_user", (q) =>
            q.eq("conversationId", targetConversation!._id).eq("userId", bobId),
          )
          .unique(),
        ctx.db
          .query("dmParticipantState")
          .withIndex("by_conversation_user", (q) =>
            q.eq("conversationId", targetConversation!._id).eq("userId", aliceId),
          )
          .unique(),
      ])
    );

    expect(bobState?.orgId).toBe(orgId);
    expect(bobState?.conversationLastMessageAt).toBe(500);
    expect(bobState?.hasUnread).toBe(true);
    expect(aliceState?.orgId).toBe(orgId);
    expect(aliceState?.hasUnread).toBe(false);
  });

  test("typing updates remain projected and reversible", async () => {
    const { conversationId, asAlice, asBob } = await setupDm();

    await asBob.mutation(api.directMessages.setTyping, {
      conversationId,
      isTyping: true,
    });
    const typing = await asAlice.query(api.directMessages.getConversation, { conversationId });
    expect(typing?.typingUsers.map((user) => user?.name)).toContain("Bob");

    await asBob.mutation(api.directMessages.setTyping, {
      conversationId,
      isTyping: false,
    });
    const stopped = await asAlice.query(api.directMessages.getConversation, { conversationId });
    expect(stopped?.typingUsers).toEqual([]);
  });

  test("group creation validates every requested member and projects valid members", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Group Dealer", createdAt: Date.now() })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [], isSystemOwnerRole: true })
    );
    const [aliceId, bobId, charlieId, outsiderId] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.insert("users", { clerkId: "alice_group", email: "alice.group@test.com", name: "Alice" }),
        ctx.db.insert("users", { clerkId: "bob_group", email: "bob.group@test.com", name: "Bob" }),
        ctx.db.insert("users", { clerkId: "charlie_group", email: "charlie.group@test.com", name: "Charlie" }),
        ctx.db.insert("users", { clerkId: "outsider_group", email: "outsider.group@test.com", name: "Outsider" }),
      ])
    );
    await t.run(async (ctx) => {
      await Promise.all([
        ctx.db.insert("memberships", { orgId, userId: aliceId, roleId }),
        ctx.db.insert("memberships", { orgId, userId: bobId, roleId }),
        ctx.db.insert("memberships", { orgId, userId: charlieId, roleId }),
      ]);
    });

    const asAlice = t.withIdentity({ subject: "alice_group", clerkId: "alice_group" });

    await expect(
      asAlice.mutation(api.directMessages.createGroup, {
        orgId,
        name: "Too small after normalization",
        memberIds: [aliceId, bobId],
      }),
    ).rejects.toThrow("A group needs at least 2 distinct other members.");

    await expect(
      asAlice.mutation(api.directMessages.createGroup, {
        orgId,
        name: "Repeated member",
        memberIds: [bobId, bobId],
      }),
    ).rejects.toThrow("A group needs at least 2 distinct other members.");

    await expect(
      asAlice.mutation(api.directMessages.createGroup, {
        orgId,
        name: "Invalid group",
        memberIds: [bobId, outsiderId],
      }),
    ).rejects.toThrow("One or more users are not members of this org.");

    const groupId = await asAlice.mutation(api.directMessages.createGroup, {
      orgId,
      name: "Valid group",
      memberIds: [bobId, charlieId],
    });

    const states = await t.run((ctx) =>
      ctx.db
        .query("dmParticipantState")
        .withIndex("by_conversation_user", (q) => q.eq("conversationId", groupId))
        .collect()
    );
    expect(states).toHaveLength(3);
    expect(states.every((state) => state.orgId === orgId)).toBe(true);
    expect(states.every((state) => state.hasUnread === false)).toBe(true);
  });

  test("long message previews are truncated consistently in notifications", async () => {
    const { orgId, conversationId, asAlice, asBob } = await setupDm();
    const body = "x".repeat(100);

    await asAlice.mutation(api.directMessages.sendMessage, { conversationId, body });

    const bobNotifications = await asBob.query(api.notifications.listPage, {
      orgId,
      showArchived: false,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(bobNotifications.page[0]?.data).toEqual({
      senderName: "Alice",
      preview: "x".repeat(80) + "…",
    });
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
