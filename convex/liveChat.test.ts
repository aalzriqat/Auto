import { convexTest } from "convex-test";
import { expect, test, describe as vitestDescribe, vi, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

// Skipped while live chat is disabled (LIVE_CHAT_ENABLED = false in
// convex/liveChat.ts — every handler now throws "Live chat is currently
// disabled", which is the correct, expected behavior, not a regression).
// Re-enable these alongside flipping that flag back to true.
const describe = vitestDescribe.skip;

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
}));

beforeEach(() => {
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Flushes only immediately-due (delay-0) scheduled functions, without advancing real wall time past any longer-delay timers like the 30s offer-expiry. */
async function flushImmediate(t: ReturnType<typeof convexTest>) {
  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
}

async function seedOrgAndDealer(t: ReturnType<typeof convexTest>, suffix: string) {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: `Org ${suffix}`, createdAt: Date.now() })
  );
  const ownerRoleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ["view:org", "edit:org"] })
  );
  const dealerUserId = await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId: `dealer_${suffix}`, email: `dealer_${suffix}@test.com`, name: "Dealer" })
  );
  await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId: dealerUserId, roleId: ownerRoleId }));
  return { orgId, ownerRoleId, dealerUserId, asDealer: t.withIdentity({ subject: `dealer_${suffix}` }) };
}

async function seedAgent(
  t: ReturnType<typeof convexTest>,
  suffix: string,
  opts: { isActive?: boolean; isOnline?: boolean } = {}
) {
  const { isActive = true, isOnline = true } = opts;
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId: `agent_${suffix}`, email: `agent_${suffix}@autoflow.dev`, name: `Agent ${suffix}` })
  );
  const agentId = await t.run(async (ctx) =>
    ctx.db.insert("supportAgents", {
      userId,
      email: `agent_${suffix}@autoflow.dev`,
      isActive,
      isOnline,
      lastHeartbeatAt: isOnline ? Date.now() : undefined,
    })
  );
  return { agentId, userId, asAgent: t.withIdentity({ subject: `agent_${suffix}` }) };
}

describe("liveChat routing", () => {
  test("starting a chat offers it to the only online agent", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asDealer } = await seedOrgAndDealer(t, "1");
    const agentA = await seedAgent(t, "A1");

    const threadId = await asDealer.mutation(api.liveChat.startOrGetMyThread, { orgId });
    await flushImmediate(t);

    const queue = await agentA.asAgent.query(api.liveChat.listQueue, {});
    expect(queue.offeredToMe.map((th) => th._id)).toContain(threadId);

    const thread = await t.run(async (ctx) => ctx.db.get(threadId));
    expect(thread?.status).toBe("OFFERED");
    expect(thread?.offeredToUserId).toBe(agentA.userId);
  });

  test("a thread cannot be accepted or rejected by an agent it wasn't offered to", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asDealer } = await seedOrgAndDealer(t, "2");
    const agentA = await seedAgent(t, "A2");
    const agentB = await seedAgent(t, "B2");

    const threadId = await asDealer.mutation(api.liveChat.startOrGetMyThread, { orgId });
    await flushImmediate(t);

    const thread = await t.run(async (ctx) => ctx.db.get(threadId));
    expect(thread?.status).toBe("OFFERED");
    const offeredAgent = thread!.offeredToUserId === agentA.userId ? agentA : agentB;
    const otherAgent = offeredAgent === agentA ? agentB : agentA;

    await expect(otherAgent.asAgent.mutation(api.liveChat.acceptOffer, { threadId })).rejects.toThrow();
    await expect(otherAgent.asAgent.mutation(api.liveChat.rejectOffer, { threadId })).rejects.toThrow();
  });

  test("rejecting reassigns to the other online agent and excludes the rejecter", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asDealer } = await seedOrgAndDealer(t, "3");
    const agentA = await seedAgent(t, "A3");
    const agentB = await seedAgent(t, "B3");

    const threadId = await asDealer.mutation(api.liveChat.startOrGetMyThread, { orgId });
    await flushImmediate(t);

    let thread = (await t.run(async (ctx) => ctx.db.get(threadId)))!;
    const offeredAgent = thread.offeredToUserId === agentA.userId ? agentA : agentB;
    const otherAgent = offeredAgent === agentA ? agentB : agentA;

    await offeredAgent.asAgent.mutation(api.liveChat.rejectOffer, { threadId });
    await flushImmediate(t);

    thread = (await t.run(async (ctx) => ctx.db.get(threadId)))!;
    expect(thread.offeredToUserId).toBe(otherAgent.userId);
    expect(thread.rejectedByUserIds).toContain(offeredAgent.userId);
  });

  test("an expired offer reassigns automatically, falling back to WAITING once every agent has passed", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asDealer } = await seedOrgAndDealer(t, "4");
    const agentA = await seedAgent(t, "A4");
    const agentB = await seedAgent(t, "B4");

    const threadId = await asDealer.mutation(api.liveChat.startOrGetMyThread, { orgId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const thread = await t.run(async (ctx) => ctx.db.get(threadId));
    expect(thread?.status).toBe("WAITING");
    expect(thread?.offeredToUserId).toBeUndefined();
    expect(thread?.rejectedByUserIds).toEqual(expect.arrayContaining([agentA.userId, agentB.userId]));
  });

  test("with zero online agents a new thread lands in WAITING and is manually claimable", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asDealer } = await seedOrgAndDealer(t, "5");
    const offlineAgent = await seedAgent(t, "A5", { isOnline: false });

    const threadId = await asDealer.mutation(api.liveChat.startOrGetMyThread, { orgId });
    await flushImmediate(t);

    let thread = await t.run(async (ctx) => ctx.db.get(threadId));
    expect(thread?.status).toBe("WAITING");

    await offlineAgent.asAgent.mutation(api.liveChat.claimThread, { threadId });
    thread = await t.run(async (ctx) => ctx.db.get(threadId));
    expect(thread?.status).toBe("ACTIVE");
    expect(thread?.claimedByUserId).toBe(offlineAgent.userId);
  });
});

describe("liveChat agent status (break/offline deferral)", () => {
  test("requesting BREAK while handling an active chat is deferred, not applied immediately", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asDealer } = await seedOrgAndDealer(t, "9");
    const agent = await seedAgent(t, "A9");

    const threadId = await asDealer.mutation(api.liveChat.startOrGetMyThread, { orgId });
    await flushImmediate(t);
    await agent.asAgent.mutation(api.liveChat.acceptOffer, { threadId });

    const result = await agent.asAgent.mutation(api.liveChat.setAgentStatus, { status: "BREAK" });
    expect(result).toEqual({ applied: false, deferred: true });

    const agentRow = await t.run(async (ctx) => ctx.db.get(agent.agentId));
    expect(agentRow?.pendingBreak).toBe(true);
    expect(agentRow?.isOnline).toBe(true); // still online, just excluded from new offers

    const status = await agent.asAgent.query(api.liveChat.getMyAgentStatus, {});
    expect(status.pendingBreak).toBe(true);
    expect(status.activeChatCount).toBe(1);
  });

  test("a pending-break agent is excluded from new offers", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId: org1, asDealer: dealer1 } = await seedOrgAndDealer(t, "10a");
    const { orgId: org2, asDealer: dealer2 } = await seedOrgAndDealer(t, "10b");
    const agent = await seedAgent(t, "A10");

    const thread1 = await dealer1.mutation(api.liveChat.startOrGetMyThread, { orgId: org1 });
    await flushImmediate(t);
    await agent.asAgent.mutation(api.liveChat.acceptOffer, { threadId: thread1 });
    await agent.asAgent.mutation(api.liveChat.setAgentStatus, { status: "BREAK" });

    const thread2 = await dealer2.mutation(api.liveChat.startOrGetMyThread, { orgId: org2 });
    await flushImmediate(t);

    const thread2Doc = await t.run(async (ctx) => ctx.db.get(thread2));
    expect(thread2Doc?.status).toBe("WAITING"); // no eligible agent — the only one is pending-break
  });

  test("closing the last active chat applies the deferred break", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asDealer } = await seedOrgAndDealer(t, "11");
    const agent = await seedAgent(t, "A11");

    const threadId = await asDealer.mutation(api.liveChat.startOrGetMyThread, { orgId });
    await flushImmediate(t);
    await agent.asAgent.mutation(api.liveChat.acceptOffer, { threadId });
    await agent.asAgent.mutation(api.liveChat.setAgentStatus, { status: "BREAK" });

    await agent.asAgent.mutation(api.liveChat.closeThread, { threadId });

    const agentRow = await t.run(async (ctx) => ctx.db.get(agent.agentId));
    expect(agentRow?.status).toBe("BREAK");
    expect(agentRow?.isOnline).toBe(false);
    expect(agentRow?.pendingBreak).toBe(false);
  });

  test("setAgentStatus applies immediately when the agent has no active chats", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const agent = await seedAgent(t, "A12");

    const result = await agent.asAgent.mutation(api.liveChat.setAgentStatus, { status: "OFFLINE" });
    expect(result).toEqual({ applied: true });

    const agentRow = await t.run(async (ctx) => ctx.db.get(agent.agentId));
    expect(agentRow?.status).toBe("OFFLINE");
    expect(agentRow?.isOnline).toBe(false);
  });
});

describe("liveChat agent-joined notice", () => {
  test("accepting an offer posts a system notice that the agent joined", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asDealer } = await seedOrgAndDealer(t, "16");
    const agent = await seedAgent(t, "A16");

    const threadId = await asDealer.mutation(api.liveChat.startOrGetMyThread, { orgId });
    await flushImmediate(t);
    await agent.asAgent.mutation(api.liveChat.acceptOffer, { threadId });

    const messages = await t.run(async (ctx) =>
      ctx.db.query("liveChatMessages").withIndex("by_thread", (q) => q.eq("threadId", threadId)).collect()
    );
    const notice = messages.find((m) => m.isSystem);
    expect(notice).toBeDefined();
    expect(notice?.senderType).toBe("AGENT");
    expect(notice?.bodyText).toContain("joined the conversation");
  });

  test("manually claiming a waiting thread also posts the joined notice", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asDealer } = await seedOrgAndDealer(t, "17");
    const offlineAgent = await seedAgent(t, "A17", { isOnline: false });

    const threadId = await asDealer.mutation(api.liveChat.startOrGetMyThread, { orgId });
    await flushImmediate(t);
    await offlineAgent.asAgent.mutation(api.liveChat.claimThread, { threadId });

    const messages = await t.run(async (ctx) =>
      ctx.db.query("liveChatMessages").withIndex("by_thread", (q) => q.eq("threadId", threadId)).collect()
    );
    const notice = messages.find((m) => m.isSystem);
    expect(notice).toBeDefined();
    expect(notice?.senderType).toBe("AGENT");
  });
});

describe("liveChat dealer-initiated end", () => {
  test("a dealer can end their own active chat, posting a system notice", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asDealer } = await seedOrgAndDealer(t, "13");
    const agent = await seedAgent(t, "A13");

    const threadId = await asDealer.mutation(api.liveChat.startOrGetMyThread, { orgId });
    await flushImmediate(t);
    await agent.asAgent.mutation(api.liveChat.acceptOffer, { threadId });

    await asDealer.mutation(api.liveChat.endThreadByDealer, { threadId });

    const thread = await t.run(async (ctx) => ctx.db.get(threadId));
    expect(thread?.status).toBe("CLOSED");

    const messages = await t.run(async (ctx) =>
      ctx.db.query("liveChatMessages").withIndex("by_thread", (q) => q.eq("threadId", threadId)).collect()
    );
    const notice = messages.find((m) => m.isSystem && m.senderType === "DEALER");
    expect(notice).toBeDefined();
  });

  test("ending a chat from the dealer side also revokes any active org-access grant", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asDealer } = await seedOrgAndDealer(t, "14");
    const agent = await seedAgent(t, "A14");

    const threadId = await asDealer.mutation(api.liveChat.startOrGetMyThread, { orgId });
    await flushImmediate(t);
    await agent.asAgent.mutation(api.liveChat.acceptOffer, { threadId });
    await agent.asAgent.mutation(api.liveChat.requestOrgAccess, { threadId });

    await asDealer.mutation(api.liveChat.endThreadByDealer, { threadId });

    const membership = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", agent.userId))
        .unique()
    );
    expect(membership).toBeNull();
  });

  test("a dealer cannot end another dealer's thread", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asDealer } = await seedOrgAndDealer(t, "15a");
    const { asDealer: otherDealer } = await seedOrgAndDealer(t, "15b");

    const threadId = await asDealer.mutation(api.liveChat.startOrGetMyThread, { orgId });
    await flushImmediate(t);

    await expect(otherDealer.mutation(api.liveChat.endThreadByDealer, { threadId })).rejects.toThrow();
  });
});

describe("liveChat org access grant", () => {
  test("requestOrgAccess fails if the thread isn't ACTIVE and claimed by the caller", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asDealer } = await seedOrgAndDealer(t, "6");
    const agent = await seedAgent(t, "A6");

    const threadId = await asDealer.mutation(api.liveChat.startOrGetMyThread, { orgId });
    await flushImmediate(t);

    await expect(agent.asAgent.mutation(api.liveChat.requestOrgAccess, { threadId })).rejects.toThrow();
  });

  test("closing a thread revokes its org-access grant and deletes the synthetic membership", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asDealer } = await seedOrgAndDealer(t, "7");
    const agent = await seedAgent(t, "A7");

    const threadId = await asDealer.mutation(api.liveChat.startOrGetMyThread, { orgId });
    await flushImmediate(t);
    await agent.asAgent.mutation(api.liveChat.acceptOffer, { threadId });

    const { expiresAt } = await agent.asAgent.mutation(api.liveChat.requestOrgAccess, { threadId });
    expect(expiresAt).toBeGreaterThan(Date.now());

    const membershipBefore = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", agent.userId))
        .unique()
    );
    expect(membershipBefore).not.toBeNull();

    await agent.asAgent.mutation(api.liveChat.closeThread, { threadId });

    const membershipAfter = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", agent.userId))
        .unique()
    );
    expect(membershipAfter).toBeNull();

    const grant = await t.run(async (ctx) =>
      ctx.db
        .query("supportOrgAccessGrants")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .first()
    );
    expect(grant?.revokedAt).toBeDefined();
  });

  test("an agent who already has a real membership in the org is rejected by requestOrgAccess", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, ownerRoleId, asDealer } = await seedOrgAndDealer(t, "8");
    const agent = await seedAgent(t, "A8");
    // Agent is coincidentally already a real member of this same org.
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", { orgId, userId: agent.userId, roleId: ownerRoleId })
    );

    const threadId = await asDealer.mutation(api.liveChat.startOrGetMyThread, { orgId });
    await flushImmediate(t);
    await agent.asAgent.mutation(api.liveChat.acceptOffer, { threadId });

    await expect(agent.asAgent.mutation(api.liveChat.requestOrgAccess, { threadId })).rejects.toThrow();
  });
});

describe("liveChat lead (anonymous marketing-site) threads", () => {
  test("starting a lead thread offers it to the only online agent, same as a dealer chat", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const agentA = await seedAgent(t, "LA1");

    const threadId = await t.mutation(api.liveChat.startOrGetLeadThread, {
      leadId: "lead-1",
      name: "Visitor",
      email: "visitor@example.com",
    });
    await flushImmediate(t);

    const queue = await agentA.asAgent.query(api.liveChat.listQueue, {});
    expect(queue.offeredToMe.map((th) => th._id)).toContain(threadId);

    const thread = await t.run(async (ctx) => ctx.db.get(threadId));
    expect(thread?.status).toBe("OFFERED");
    expect(thread?.kind).toBe("LEAD");
    expect(thread?.orgId).toBeUndefined();
  });

  test("starting a lead thread twice with the same leadId reuses the existing thread", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const threadId1 = await t.mutation(api.liveChat.startOrGetLeadThread, { leadId: "lead-2" });
    const threadId2 = await t.mutation(api.liveChat.startOrGetLeadThread, { leadId: "lead-2", name: "Later Name" });

    expect(threadId2).toBe(threadId1);
    const thread = await t.run(async (ctx) => ctx.db.get(threadId1));
    expect(thread?.dealerName).toBe("Later Name");
  });

  test("sendLeadMessage rejects a leadId that doesn't match the thread's capability token", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const threadId = await t.mutation(api.liveChat.startOrGetLeadThread, { leadId: "lead-3" });

    await expect(
      t.mutation(api.liveChat.sendLeadMessage, { threadId, leadId: "someone-elses-token", bodyText: "hi" })
    ).rejects.toThrow();
  });

  test("requestOrgAccess is rejected for a LEAD thread (no organization to access)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const agent = await seedAgent(t, "LA4");
    const threadId = await t.mutation(api.liveChat.startOrGetLeadThread, { leadId: "lead-4" });
    await flushImmediate(t);
    await agent.asAgent.mutation(api.liveChat.acceptOffer, { threadId });

    await expect(agent.asAgent.mutation(api.liveChat.requestOrgAccess, { threadId })).rejects.toThrow();
  });

  test("an agent's reply is visible to the lead via getLeadThreadMessages", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const agent = await seedAgent(t, "LA5");
    const threadId = await t.mutation(api.liveChat.startOrGetLeadThread, { leadId: "lead-5" });
    await flushImmediate(t);
    await agent.asAgent.mutation(api.liveChat.acceptOffer, { threadId });
    await agent.asAgent.mutation(api.liveChat.sendAgentMessage, { threadId, bodyText: "Hello, how can I help?" });

    const messages = await t.query(api.liveChat.getLeadThreadMessages, { threadId, leadId: "lead-5" });
    expect(messages.some((m) => m.bodyText === "Hello, how can I help?" && m.senderType === "AGENT")).toBe(true);
  });
});
