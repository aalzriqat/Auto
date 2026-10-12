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
      closed: false,
      newerInbound: false,
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

describe("support inbox: reply racing a newer inbound message (review F2, round 2 G1/G2)", () => {
  const reply = (threadId: Id<"supportThreads">, userId: Id<"users">, extra: Record<string, unknown> = {}) => ({
    threadId,
    fromEmail: "support@autoflowdealer.com",
    toEmail: "buyer@example.com",
    bodyText: "We are on it.",
    sentByUserId: userId,
    sentByEmail: "admin@autoflow.dev",
    ...extra,
  });
  const revisionOf = (thread: { inboundRevision?: number }) => thread.inboundRevision ?? 0;

  test("every inbound message bumps inboundRevision: 1 on insert, +1 on each patch", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const first = await inbound(t, { bodyText: "one" });
    expect(first.inboundRevision).toBe(1);
    const second = await inbound(t, { bodyText: "two" });
    expect(second.inboundRevision).toBe(2);
    const third = await inbound(t, { bodyText: "three" });
    expect(third.inboundRevision).toBe(3);
  });

  test("a newer inbound that arrived during the send is NOT hidden by Send & close", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { userId } = await seedUser(t, "admin", "admin@autoflow.dev");
    const thread = await inbound(t, { bodyText: "First question" });
    const observedInboundRevision = revisionOf(thread);

    // The customer writes again while the provider call is in flight.
    await inbound(t, { bodyText: "Second, more urgent question" });

    const result = await t.mutation(
      internal.support.recordOutboundMessage,
      reply(thread._id, userId, { observedInboundRevision, closeAfterSend: true })
    );
    expect(result).toEqual({ closed: false, newerInbound: true });

    const after = await getThread(t, thread._id);
    expect(after?.status).toBe("OPEN");
    expect(after?.awaitingReply).toBe(true);
    expect(after?.lastMessagePreview).toBe("Second, more urgent question");
    // The reply itself is still recorded and audited.
    const messages = await t.run((ctx) => ctx.db.query("supportMessages").collect());
    expect(messages.filter((m) => m.direction === "OUTBOUND" && m.sentByUserId)).toHaveLength(1);
    const audit = await t.run((ctx) => ctx.db.query("adminAuditLog").collect());
    expect(audit.filter((a) => a.action === "supportSendReply")).toHaveLength(1);
    expect(audit.filter((a) => a.action === "supportSetThreadStatus")).toHaveLength(0);
  });

  // G2: the guard used Date.now(), so an inbound in the SAME millisecond as the
  // observed one (or a clock that moved backwards) was "not newer".
  test("an inbound in the same millisecond as the observed one still counts as newer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    vi.setSystemTime(1000);
    const t = convexTestWithComponents(schema, MODULES);
    const { userId } = await seedUser(t, "admin", "admin@autoflow.dev");
    const thread = await inbound(t, { bodyText: "First question" });
    const observedInboundRevision = revisionOf(thread);

    await inbound(t, { bodyText: "Second question, same millisecond" });
    expect(Date.now()).toBe(1000);

    const result = await t.mutation(
      internal.support.recordOutboundMessage,
      reply(thread._id, userId, { observedInboundRevision, closeAfterSend: true })
    );
    expect(result).toEqual({ closed: false, newerInbound: true });
    const after = await getThread(t, thread._id);
    expect(after?.status).toBe("OPEN");
    expect(after?.awaitingReply).toBe(true);
    expect(after?.lastMessagePreview).toBe("Second question, same millisecond");
  });

  test("a clock that moves backwards between the two inbound messages still counts as newer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    vi.setSystemTime(5000);
    const t = convexTestWithComponents(schema, MODULES);
    const { userId } = await seedUser(t, "admin", "admin@autoflow.dev");
    const thread = await inbound(t, { bodyText: "First question" });
    const observedInboundRevision = revisionOf(thread);

    vi.setSystemTime(2000); // regression
    await inbound(t, { bodyText: "Second question, clock went back" });

    const result = await t.mutation(
      internal.support.recordOutboundMessage,
      reply(thread._id, userId, { observedInboundRevision, closeAfterSend: true })
    );
    expect(result).toEqual({ closed: false, newerInbound: true });
    expect((await getThread(t, thread._id))?.status).toBe("OPEN");
    expect((await getThread(t, thread._id))?.awaitingReply).toBe(true);
  });

  test("a newer inbound also keeps the flag and preview for a plain reply (no close)", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { userId } = await seedUser(t, "admin", "admin@autoflow.dev");
    const thread = await inbound(t, { bodyText: "First" });
    await inbound(t, { bodyText: "Newer" });
    const result = await t.mutation(
      internal.support.recordOutboundMessage,
      reply(thread._id, userId, { observedInboundRevision: revisionOf(thread) })
    );
    expect(result).toEqual({ closed: false, newerInbound: true });
    const after = await getThread(t, thread._id);
    expect(after?.awaitingReply).toBe(true);
    expect(after?.lastMessagePreview).toBe("Newer");
  });

  test("two admins: the second reply, observing the post-inbound revision, answers the thread", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { userId: adminA } = await seedUser(t, "admin", "admin@autoflow.dev");
    const thread = await inbound(t, { bodyText: "First" });
    const observedByA = revisionOf(thread);
    await inbound(t, { bodyText: "Second" });
    const observedByB = revisionOf((await getThread(t, thread._id))!);

    // A (observed before the second inbound) is told a newer message exists...
    const a = await t.mutation(
      internal.support.recordOutboundMessage,
      reply(thread._id, adminA, { observedInboundRevision: observedByA, closeAfterSend: true })
    );
    expect(a).toEqual({ closed: false, newerInbound: true });
    expect((await getThread(t, thread._id))?.awaitingReply).toBe(true);
    // ...and B (who saw the second message) answers it and closes.
    const b = await t.mutation(
      internal.support.recordOutboundMessage,
      reply(thread._id, adminA, { observedInboundRevision: observedByB, closeAfterSend: true })
    );
    expect(b).toEqual({ closed: true, newerInbound: false });
    expect((await getThread(t, thread._id))?.status).toBe("CLOSED");
  });

  test("control: no race and closeAfterSend clears the flag, closes, and writes a status audit row", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { userId } = await seedUser(t, "admin", "admin@autoflow.dev");
    const thread = await inbound(t, { bodyText: "Question" });
    const result = await t.mutation(
      internal.support.recordOutboundMessage,
      reply(thread._id, userId, { observedInboundRevision: revisionOf(thread), closeAfterSend: true })
    );
    expect(result).toEqual({ closed: true, newerInbound: false });
    const after = await getThread(t, thread._id);
    expect(after?.status).toBe("CLOSED");
    expect(after?.awaitingReply).toBe(false);
    expect(after?.lastMessagePreview).toBe("We are on it.");
    const audit = await t.run((ctx) => ctx.db.query("adminAuditLog").collect());
    const status = audit.filter((a) => a.action === "supportSetThreadStatus");
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({
      actorUserId: userId,
      actorEmail: "admin@autoflow.dev",
      targetTable: "supportThreads",
      targetId: thread._id,
      before: { status: "OPEN" },
      after: { status: "CLOSED" },
    });
  });

  // G1: the close branch used to re-read the user AFTER the provider had already
  // sent the email; a missing user threw and rolled the whole reply back, so the
  // admin saw a failure and retried -> duplicate email.
  test("Send & close still succeeds when the acting user's row is gone (audit uses the captured snapshot)", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { userId } = await seedUser(t, "admin", "admin@autoflow.dev");
    const thread = await inbound(t, { bodyText: "Question" });
    // The snapshot (id + email) was captured by sendReply; now the user doc disappears.
    await t.run((ctx) => ctx.db.delete(userId));

    const result = await t.mutation(
      internal.support.recordOutboundMessage,
      reply(thread._id, userId, { observedInboundRevision: revisionOf(thread), closeAfterSend: true })
    );
    expect(result).toEqual({ closed: true, newerInbound: false });
    const after = await getThread(t, thread._id);
    expect(after?.status).toBe("CLOSED");
    expect(after?.awaitingReply).toBe(false);
    const messages = await t.run((ctx) => ctx.db.query("supportMessages").collect());
    expect(messages.filter((m) => m.direction === "OUTBOUND" && m.sentByUserId)).toHaveLength(1);
    const audit = await t.run((ctx) => ctx.db.query("adminAuditLog").collect());
    expect(audit.filter((a) => a.action === "supportSendReply")).toHaveLength(1);
    const status = audit.filter((a) => a.action === "supportSetThreadStatus");
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({
      actorUserId: userId,
      actorEmail: "admin@autoflow.dev",
      before: { status: "OPEN" },
      after: { status: "CLOSED" },
    });
  });

  test("control: no race and no closeAfterSend replies without closing", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { userId } = await seedUser(t, "admin", "admin@autoflow.dev");
    const thread = await inbound(t, { bodyText: "Question" });
    const result = await t.mutation(
      internal.support.recordOutboundMessage,
      reply(thread._id, userId, { observedInboundRevision: revisionOf(thread) })
    );
    expect(result).toEqual({ closed: false, newerInbound: false });
    const after = await getThread(t, thread._id);
    expect(after?.status).toBe("OPEN");
    expect(after?.awaitingReply).toBe(false);
  });

  test("the automated acknowledgement never touches the flag, preview, status or revision", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const thread = await inbound(t, { bodyText: "Please call me" });
    const result = await t.mutation(internal.support.recordOutboundMessage, {
      threadId: thread._id,
      fromEmail: "support@autoflowdealer.com",
      toEmail: "buyer@example.com",
      bodyText: "(Automated acknowledgment — ...)",
    });
    expect(result).toEqual({ closed: false, newerInbound: false });
    const after = await getThread(t, thread._id);
    expect(after?.awaitingReply).toBe(true);
    expect(after?.status).toBe("OPEN");
    expect(after?.lastMessagePreview).toBe("Please call me");
    expect(after?.inboundRevision).toBe(1);
  });

  test("a legacy row with no revision replies and closes normally; its first new inbound reads as newer", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { userId } = await seedUser(t, "admin", "admin@autoflow.dev");
    const legacy = () =>
      t.run((ctx) =>
        ctx.db.insert("supportThreads", {
          participantEmail: "buyer@example.com",
          subject: "Old",
          status: "OPEN",
          inbox: "support",
          lastMessageAt: 1,
          awaitingReply: true,
        })
      );
    const threadId = await legacy();
    // sendReply captures `inboundRevision ?? 0` for such a row; nothing newer arrived.
    const result = await t.mutation(
      internal.support.recordOutboundMessage,
      reply(threadId, userId, { observedInboundRevision: 0, closeAfterSend: true })
    );
    expect(result).toEqual({ closed: true, newerInbound: false });
    expect((await getThread(t, threadId))?.status).toBe("CLOSED");

    // A new inbound on the legacy row sets revision 1 (> the observed 0): newer.
    await inbound(t, { bodyText: "Back again" });
    const row = (await t.run((ctx) => ctx.db.query("supportThreads").collect())).find(
      (r) => r.participantEmail === "buyer@example.com"
    )!;
    expect(row.inboundRevision).toBe(1);
    const again = await t.mutation(
      internal.support.recordOutboundMessage,
      reply(row._id, userId, { observedInboundRevision: 0, closeAfterSend: true })
    );
    expect(again).toEqual({ closed: false, newerInbound: true });
  });

  test("a caller that passes no observedInboundRevision keeps today's behaviour (unknown is not newer)", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { userId } = await seedUser(t, "admin", "admin@autoflow.dev");
    const thread = await inbound(t, { bodyText: "Question" });
    const result = await t.mutation(internal.support.recordOutboundMessage, reply(thread._id, userId));
    expect(result).toEqual({ closed: false, newerInbound: false });
    expect((await getThread(t, thread._id))?.awaitingReply).toBe(false);
  });

  test("sendReply with closeAfterSend closes the thread in one call and reports it", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    registerRateLimiter(t);
    const { as } = await seedUser(t, "admin", "admin@autoflow.dev");
    const thread = await inbound(t, { bodyText: "Question" });
    await expect(
      as.action(api.support.sendReply, { threadId: thread._id, bodyText: "Done", closeAfterSend: true })
    ).resolves.toEqual({ success: true, closed: true, newerInbound: false });
    expect((await getThread(t, thread._id))?.status).toBe("CLOSED");
  });
});

describe("support inbox: hostile HTML on the inbound path (review F1)", () => {
  test("a 480 KB hostile bodyHtml with no bodyText records the thread and message with a bounded preview", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const hostile = "<!--".repeat(120_000);
    const started = performance.now();
    const thread = await inbound(t, { bodyText: undefined, bodyHtml: hostile });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(Array.from(thread.lastMessagePreview ?? "").length).toBeLessThanOrEqual(160);
    const messages = await t.run((ctx) => ctx.db.query("supportMessages").collect());
    expect(messages.filter((m) => m.direction === "INBOUND")).toHaveLength(1);
    expect(messages[0]?.bodyHtml).toBe(hostile); // stored untouched
  });

  // Review H1 (round 3): an HTML-only body that opens with 400 invisible spacer
  // rows must still store the real sentence as the list preview.
  test("an HTML-only body with 400 spacer rows stores the invoice sentence in lastMessagePreview", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const html = `<table>${"<tr><td>&nbsp;</td></tr>".repeat(400)}</table><p>Hello, my invoice #123 is wrong.</p>`;
    const thread = await inbound(t, { bodyText: undefined, bodyHtml: html });
    expect(thread.lastMessagePreview).toBe("Hello, my invoice #123 is wrong.");
  });

  // Review J3 (round 5): a numeric reference to a surrogate decoded to a LONE surrogate,
  // which was then written to Convex inside this mutation. It must be U+FFFD.
  test("an inbound HTML body with a surrogate numeric reference stores a well-formed preview", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const thread = await inbound(t, { bodyText: undefined, bodyHtml: "<p>&#55357;x &#xDE00;y &#0;z</p>" });
    expect(thread.lastMessagePreview).toBe("�x �y �z");
    expect((thread.lastMessagePreview as unknown as { isWellFormed(): boolean }).isWellFormed()).toBe(true);
    const messages = await t.run((ctx) => ctx.db.query("supportMessages").collect());
    expect(messages.filter((m) => m.direction === "INBOUND")).toHaveLength(1);
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
