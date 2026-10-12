/**
 * SCRUM-825: support inbox backend behind the mail-client UI.
 *
 * Harness-level proof only (convex-test): it models the data and the audit rows,
 * not Convex's real scheduler or OCC. The tests below pin behaviour, not shape:
 * what the list preview / needs-reply state says after each kind of message,
 * list ordering under a status filter, the no-reply refusal, and the category
 * override's authorization + audit trail.
 */
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const MODULES = import.meta.glob("./**/*.ts");
type TestConvex = ReturnType<typeof convexTestWithComponents>;

const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;
beforeEach(() => {
  // Fake only setTimeout so the scheduled auto-reply / notification never fires
  // behind the test's back (the scheduler is only drained when told to).
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  if (ORIGINAL_ALLOWLIST === undefined) delete process.env.SUPER_ADMIN_EMAILS;
  else process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
});

async function seedUser(t: TestConvex, clerkId: string, email: string) {
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId, email, name: clerkId }));
  return { userId, as: t.withIdentity({ subject: clerkId }) };
}

async function getThread(t: TestConvex, threadId: Id<"supportThreads">) {
  return t.run((ctx) => ctx.db.get(threadId));
}

async function inbound(
  t: TestConvex,
  overrides: Partial<{
    fromEmail: string;
    toEmail: string;
    subject: string;
    bodyText: string;
    bodyHtml: string;
  }> = {}
) {
  await t.mutation(internal.support.recordInboundMessage, {
    fromEmail: "buyer@example.com",
    toEmail: "support@autoflowdealer.com",
    subject: "Help",
    bodyText: "Hello team",
    ...overrides,
  });
  const rows = await t.run((ctx) => ctx.db.query("supportThreads").collect());
  return rows.find((r) => r.participantEmail === (overrides.fromEmail ?? "buyer@example.com"))!;
}

describe("support inbox: preview + awaitingReply", () => {
  test("a new inbound message sets a clean preview and awaitingReply=true", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const thread = await inbound(t, {
      bodyText: "Welcome\n\n\n<https://example.com/a?x=1>\n   second   line",
    });
    expect(thread.awaitingReply).toBe(true);
    expect(thread.lastMessagePreview).toBe("Welcome second line");
  });

  test("an HTML-only inbound message gets a tag-stripped preview", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const thread = await inbound(t, {
      bodyText: undefined,
      bodyHtml: "<html><head><style>p{}</style></head><body><p>Hi&nbsp;there</p><b>friend</b></body></html>",
    });
    expect(thread.lastMessagePreview).toBe("Hi there friend");
  });

  test("a second inbound message on an existing thread patches preview and re-arms awaitingReply", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const first = await inbound(t, { bodyText: "first" });
    const { userId } = await seedUser(t, "admin", "admin@autoflow.dev");
    await t.mutation(internal.support.recordOutboundMessage, {
      threadId: first._id,
      fromEmail: "support@autoflowdealer.com",
      toEmail: "buyer@example.com",
      bodyText: "answer",
      sentByUserId: userId,
      sentByEmail: "admin@autoflow.dev",
    });
    expect((await getThread(t, first._id))?.awaitingReply).toBe(false);

    const again = await inbound(t, { bodyText: "second question" });
    expect(again._id).toBe(first._id);
    expect(again.awaitingReply).toBe(true);
    expect(again.lastMessagePreview).toBe("second question");
  });

  test("a human reply flips awaitingReply to false and becomes the preview", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const thread = await inbound(t);
    const { userId } = await seedUser(t, "admin", "admin@autoflow.dev");
    await t.mutation(internal.support.recordOutboundMessage, {
      threadId: thread._id,
      fromEmail: "support@autoflowdealer.com",
      toEmail: "buyer@example.com",
      bodyText: "We are on it.",
      sentByUserId: userId,
      sentByEmail: "admin@autoflow.dev",
    });
    const after = await getThread(t, thread._id);
    expect(after?.awaitingReply).toBe(false);
    expect(after?.lastMessagePreview).toBe("We are on it.");
  });

  test("the automated acknowledgement changes neither awaitingReply nor the preview", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const thread = await inbound(t, { bodyText: "Please call me" });
    await t.mutation(internal.support.recordOutboundMessage, {
      threadId: thread._id,
      fromEmail: "support@autoflowdealer.com",
      toEmail: "buyer@example.com",
      bodyText: "(Automated acknowledgment — your message was received and a team member will follow up shortly.)",
    });
    const after = await getThread(t, thread._id);
    expect(after?.awaitingReply).toBe(true);
    expect(after?.lastMessagePreview).toBe("Please call me");
  });

  test("legacy rows without the new fields still list and open", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { as } = await seedUser(t, "admin", "admin@autoflow.dev");
    const threadId = await t.run((ctx) =>
      ctx.db.insert("supportThreads", {
        participantEmail: "old@example.com",
        subject: "Old",
        status: "OPEN",
        inbox: "support",
        lastMessageAt: 1,
      })
    );
    const page = await as.query(api.support.listThreads, {
      inbox: "support",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page.map((r) => r._id)).toEqual([threadId]);
    expect(page.page[0]?.awaitingReply).toBeUndefined();
    expect(page.page[0]?.lastMessagePreview).toBeUndefined();
  });
});

describe("support inbox: listThreads ordering", () => {
  test("with a status filter the list is newest-first by lastMessageAt, not by creation", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { as } = await seedUser(t, "admin", "admin@autoflow.dev");
    // Created in this order, but lastMessageAt is NOT monotonic with creation:
    // the old by_inbox_and_status index returned 200,100,300 here.
    const stamps: Array<[string, number, "OPEN" | "CLOSED"]> = [
      ["a@example.com", 300, "OPEN"],
      ["b@example.com", 100, "OPEN"],
      ["c@example.com", 200, "OPEN"],
      ["d@example.com", 999, "CLOSED"],
    ];
    for (const [email, lastMessageAt, status] of stamps) {
      await t.run((ctx) =>
        ctx.db.insert("supportThreads", {
          participantEmail: email,
          subject: email,
          status,
          inbox: "support",
          lastMessageAt,
        })
      );
    }
    const open = await as.query(api.support.listThreads, {
      inbox: "support",
      status: "OPEN",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(open.page.map((r) => r.lastMessageAt)).toEqual([300, 200, 100]);

    const closed = await as.query(api.support.listThreads, {
      inbox: "support",
      status: "CLOSED",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(closed.page.map((r) => r.participantEmail)).toEqual(["d@example.com"]);
  });
});

describe("support inbox: sendReply", () => {
  async function seedThread(t: TestConvex, participantEmail: string) {
    return t.run((ctx) =>
      ctx.db.insert("supportThreads", {
        participantEmail,
        subject: "Question",
        status: "OPEN",
        inbox: "info",
        lastMessageAt: Date.now(),
        awaitingReply: true,
        lastMessagePreview: "Question",
      })
    );
  }
  async function outboundRows(t: TestConvex) {
    return t.run((ctx) => ctx.db.query("supportMessages").collect());
  }

  test("refuses a no-reply participant before any email is attempted", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { as } = await seedUser(t, "admin", "admin@autoflow.dev");
    const threadId = await seedThread(t, "no-reply@email.claude.com");

    await expect(as.action(api.support.sendReply, { threadId, bodyText: "hi" })).rejects.toThrow(
      /does not accept replies/
    );
    // Nothing was recorded, nothing audited, state untouched.
    expect(await outboundRows(t)).toHaveLength(0);
    const audit = await t.run((ctx) => ctx.db.query("adminAuditLog").collect());
    expect(audit.filter((a) => a.action === "supportSendReply")).toHaveLength(0);
    expect((await getThread(t, threadId))?.awaitingReply).toBe(true);
  });

  test("control: a normal participant goes through, records the reply and clears awaitingReply", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    registerRateLimiter(t);
    const { as } = await seedUser(t, "admin", "admin@autoflow.dev");
    const threadId = await seedThread(t, "buyer@example.com");

    await expect(as.action(api.support.sendReply, { threadId, bodyText: "On it" })).resolves.toEqual({
      success: true,
    });
    expect(await outboundRows(t)).toHaveLength(1);
    const after = await getThread(t, threadId);
    expect(after?.awaitingReply).toBe(false);
    expect(after?.lastMessagePreview).toBe("On it");
  });

  test("a non-super-admin cannot send", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { as } = await seedUser(t, "member", "member@dealership.com");
    const threadId = await seedThread(t, "buyer@example.com");
    await expect(as.action(api.support.sendReply, { threadId, bodyText: "hi" })).rejects.toThrow();
    expect(await outboundRows(t)).toHaveLength(0);
  });
});

describe("support inbox: setThreadCategory", () => {
  async function seedThread(t: TestConvex) {
    return t.run((ctx) =>
      ctx.db.insert("supportThreads", {
        participantEmail: "notify@mail.notion.com",
        subject: "Invite",
        status: "OPEN",
        inbox: "info",
        lastMessageAt: Date.now(),
      })
    );
  }

  test("is forbidden for a non-super-admin and changes nothing", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { as } = await seedUser(t, "member", "member@dealership.com");
    const threadId = await seedThread(t);
    await expect(
      as.mutation(api.support.setThreadCategory, { threadId, category: "people" })
    ).rejects.toThrow();
    expect((await getThread(t, threadId))?.categoryOverride).toBeUndefined();
  });

  test("sets, then clears, the override and audits both changes", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { userId, as } = await seedUser(t, "admin", "admin@autoflow.dev");
    const threadId = await seedThread(t);

    await as.mutation(api.support.setThreadCategory, { threadId, category: "people" });
    expect((await getThread(t, threadId))?.categoryOverride).toBe("people");

    await as.mutation(api.support.setThreadCategory, { threadId, category: null });
    const cleared = await getThread(t, threadId);
    expect(cleared?.categoryOverride).toBeUndefined();

    const rows = (await t.run((ctx) => ctx.db.query("adminAuditLog").collect()))
      .filter((r) => r.action === "supportSetThreadCategory")
      .sort((a, b) => a.createdAt - b.createdAt);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      actorUserId: userId,
      targetTable: "supportThreads",
      targetId: threadId,
      before: { categoryOverride: null },
      after: { categoryOverride: "people" },
    });
    expect(rows[1]).toMatchObject({
      before: { categoryOverride: "people" },
      after: { categoryOverride: null },
    });
  });

  test("rejects an unknown thread with a safe message", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { as } = await seedUser(t, "admin", "admin@autoflow.dev");
    const threadId = await seedThread(t);
    await t.run((ctx) => ctx.db.delete(threadId));
    await expect(
      as.mutation(api.support.setThreadCategory, { threadId, category: "automated" })
    ).rejects.toThrow(/Thread not found/);
  });
});
