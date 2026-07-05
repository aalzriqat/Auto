import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const MODULES = import.meta.glob("./**/*.ts");

async function setupDm() {
  const t = convexTest(schema, MODULES);
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
