/**
 * Every super-admin write is supposed to leave an `adminAuditLog` row naming
 * who did it. Several did not, and the gap was invisible: each of these
 * mutations works perfectly, changes real state, and simply records nothing.
 * `subscriptions.adminUpdateSubscription` is the sharpest case — a plan or
 * billing-status change on any org, with no trace of the actor.
 *
 * These pin the audit row itself rather than the state change, because the
 * state change was never the part that was broken.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const MODULES = import.meta.glob("./**/*.ts");

const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;
beforeEach(() => {
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
});
afterEach(() => {
  if (ORIGINAL_ALLOWLIST === undefined) delete process.env.SUPER_ADMIN_EMAILS;
  else process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
});

async function seedSuperAdmin(t: ReturnType<typeof convexTestWithComponents>) {
  const adminId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "admin", email: "admin@autoflow.dev", name: "Admin" })
  );
  return { adminId, asAdmin: t.withIdentity({ subject: "admin" }) };
}

async function auditRows(t: ReturnType<typeof convexTestWithComponents>, action: string) {
  const rows = await t.run((ctx) => ctx.db.query("adminAuditLog").collect());
  return rows.filter((row) => row.action === action);
}

describe("super-admin writes leave an audit trail", () => {
  test("adminUpdateSubscription records the actor on both create and update", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { adminId, asAdmin } = await seedSuperAdmin(t);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Bloom Cars", createdAt: Date.now() })
    );

    // First call creates the subscription row — there is no `before` yet.
    await asAdmin.mutation(api.subscriptions.adminUpdateSubscription, {
      orgId,
      plan: "starter",
      status: "active",
    });

    let rows = await auditRows(t, "adminUpdateSubscription");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: adminId,
      actorEmail: "admin@autoflow.dev",
      targetTable: "subscriptions",
      orgId,
      after: { plan: "starter", status: "active" },
    });
    expect(rows[0].before).toBeUndefined();

    // Second call upgrades it — the prior plan has to be recoverable from the
    // log, or "who moved this org to enterprise, and from what" is unanswerable.
    await asAdmin.mutation(api.subscriptions.adminUpdateSubscription, {
      orgId,
      plan: "enterprise",
      status: "active",
      billingInterval: "annual",
    });

    rows = await auditRows(t, "adminUpdateSubscription");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      orgId,
      before: { plan: "starter", status: "active" },
      after: { plan: "enterprise", status: "active", billingInterval: "annual" },
    });
    expect(rows[1].targetId).toBeDefined();
  });

  test("adminUpdateSubscription cannot store an active plan whose period already ended", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { asAdmin } = await seedSuperAdmin(t);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Lapsed Cars", createdAt: Date.now() })
    );

    // SCRUM-145: the read path now trusts stored state, so a row saying
    // "active" with a period that ended would hand out paid access until the
    // next sweep — and the old read-time clock check that used to absorb this
    // is gone. Both writers settle through the same transition.
    await asAdmin.mutation(api.subscriptions.adminUpdateSubscription, {
      orgId,
      plan: "enterprise",
      status: "active",
      currentPeriodEnd: Date.now() - 60_000,
    });

    const row = await t.run((ctx) =>
      ctx.db.query("subscriptions").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
    );
    expect(row?.status).toBe("expired");

    // The audit row must agree with the row that was written. Logging the
    // requested status would leave the trail claiming "active" for a
    // subscription stored as "expired".
    const rows = await auditRows(t, "adminUpdateSubscription");
    expect(rows[rows.length - 1]).toMatchObject({
      after: { plan: "enterprise", status: "expired" },
    });
    // ...and it must still say what the admin actually asked for. "Chose
    // expired" and "chose active and was overruled by normalisation" are
    // different acts; a billing audit that records only the effective state
    // cannot tell them apart afterwards.
    expect((rows[rows.length - 1].after as Record<string, unknown>).requestedStatus).toBe("active");

    // A renewal through the same path restores it — `expired` is not a
    // one-way door.
    await asAdmin.mutation(api.subscriptions.adminUpdateSubscription, {
      orgId,
      plan: "enterprise",
      status: "active",
      currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });

    const renewed = await t.run((ctx) =>
      ctx.db.query("subscriptions").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
    );
    expect(renewed?.status).toBe("active");

    // Nothing was overruled this time, so the trail carries no phantom
    // "requested" value to puzzle over later.
    const afterRenewal = await auditRows(t, "adminUpdateSubscription");
    expect(
      (afterRenewal[afterRenewal.length - 1].after as Record<string, unknown>).requestedStatus
    ).toBeUndefined();
  });

  test("a free plan is never stamped expired, however stale its period end", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { asAdmin } = await seedSuperAdmin(t);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Downgraded Cars", createdAt: Date.now() })
    );

    // Downgrading to free does not require clearing the optional period-end
    // field, so this shape is ordinary admin output. The free plan has no paid
    // period, so nothing about it can lapse — stamping it `expired` would make
    // getMySubscription report a lapsed entitlement to an org that never had
    // one. This is the writer-side half of the same guard the reconciler relies
    // on; the reconciler's own copy is now unreachable for free rows because
    // the query filters them out, so this is where it is actually load-bearing.
    await asAdmin.mutation(api.subscriptions.adminUpdateSubscription, {
      orgId,
      plan: "free",
      status: "active",
      currentPeriodEnd: Date.now() - 10_000_000,
    });

    const row = await t.run((ctx) =>
      ctx.db.query("subscriptions").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
    );
    expect(row?.status).toBe("active");
    expect(row?.plan).toBe("free");
  });

  test("setSiteConfig records the previous and new value", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { adminId, asAdmin } = await seedSuperAdmin(t);

    await asAdmin.mutation(api.adminSystem.setSiteConfig, { key: "marketplace.banner", value: "old" });
    await asAdmin.mutation(api.adminSystem.setSiteConfig, { key: "marketplace.banner", value: "new" });

    const rows = await auditRows(t, "setSiteConfig");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      actorUserId: adminId,
      targetTable: "siteConfig",
      after: { key: "marketplace.banner", value: "old" },
    });
    expect(rows[1]).toMatchObject({
      before: { key: "marketplace.banner", value: "old" },
      after: { key: "marketplace.banner", value: "new" },
    });
    // Both entries must point at the same row — the second call patches.
    expect(rows[1].targetId).toBe(rows[0].targetId);
  });

  test("feedback status changes and replies are attributed to the admin", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { adminId, asAdmin } = await seedSuperAdmin(t);
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Bloom Cars", createdAt: Date.now() })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "member", email: "member@example.com", name: "Member" })
    );
    const feedbackId = await t.run((ctx) =>
      ctx.db.insert("feedback", {
        orgId,
        userId,
        type: "BUG",
        title: "Export is broken",
        status: "OPEN",
        createdAt: Date.now(),
      })
    );

    await asAdmin.mutation(api.feedback.adminReply, { feedbackId, reply: "Fixed in the next release." });
    await asAdmin.mutation(api.feedback.adminSetStatus, { feedbackId, status: "CLOSED" });

    const replyRows = await auditRows(t, "feedbackReply");
    expect(replyRows).toHaveLength(1);
    expect(replyRows[0]).toMatchObject({
      actorUserId: adminId,
      targetTable: "feedback",
      targetId: feedbackId,
      orgId,
      after: { adminReply: "Fixed in the next release." },
    });

    const statusRows = await auditRows(t, "feedbackSetStatus");
    expect(statusRows).toHaveLength(1);
    expect(statusRows[0]).toMatchObject({
      targetId: feedbackId,
      orgId,
      before: { status: "OPEN" },
      after: { status: "CLOSED" },
    });
  });

  test("closing a support thread is attributed to the admin", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { adminId, asAdmin } = await seedSuperAdmin(t);
    const threadId = await t.run((ctx) =>
      ctx.db.insert("supportThreads", {
        participantEmail: "buyer@example.com",
        subject: "Billing question",
        status: "OPEN",
        inbox: "subscriptions",
        lastMessageAt: Date.now(),
      })
    );

    await asAdmin.mutation(api.support.setThreadStatus, { threadId, status: "CLOSED" });

    const rows = await auditRows(t, "supportSetThreadStatus");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: adminId,
      targetTable: "supportThreads",
      targetId: threadId,
      before: { status: "OPEN" },
      after: { status: "CLOSED" },
    });
  });

  test("an admin support reply is audited but an automated acknowledgment is not", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { adminId } = await seedSuperAdmin(t);
    const threadId = await t.run((ctx) =>
      ctx.db.insert("supportThreads", {
        participantEmail: "buyer@example.com",
        subject: "Billing question",
        status: "OPEN",
        inbox: "subscriptions",
        lastMessageAt: Date.now(),
      })
    );

    // `sendReply` is an action, so the audit row is written by the mutation it
    // hands the actor down to — the same shape adminUsers.deleteUser uses.
    await t.mutation(internal.support.recordOutboundMessage, {
      threadId,
      fromEmail: "subscriptions@autoflowdealer.com",
      toEmail: "buyer@example.com",
      bodyText: "Your plan has been updated.",
      sentByUserId: adminId,
      sentByEmail: "admin@autoflow.dev",
    });

    const rows = await auditRows(t, "supportSendReply");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: adminId,
      actorEmail: "admin@autoflow.dev",
      targetTable: "supportThreads",
      targetId: threadId,
    });

    // The auto-reply path passes no actor. It is not an admin action and must
    // not manufacture an audit row attributing it to one.
    await t.mutation(internal.support.recordOutboundMessage, {
      threadId,
      fromEmail: "subscriptions@autoflowdealer.com",
      toEmail: "buyer@example.com",
      bodyText: "(Automated acknowledgment.)",
    });
    expect(await auditRows(t, "supportSendReply")).toHaveLength(1);
  });

  test("an actor id with no actor email is refused rather than logged unattributed", async () => {
    const t = convexTestWithComponents(schema, MODULES);
    const { adminId } = await seedSuperAdmin(t);
    const threadId = await t.run((ctx) =>
      ctx.db.insert("supportThreads", {
        participantEmail: "buyer@example.com",
        subject: "Billing question",
        status: "OPEN",
        inbox: "support",
        lastMessageAt: Date.now(),
      })
    );

    await expect(
      t.mutation(internal.support.recordOutboundMessage, {
        threadId,
        fromEmail: "support@autoflowdealer.com",
        toEmail: "buyer@example.com",
        bodyText: "Reply with no attribution.",
        sentByUserId: adminId,
      })
    ).rejects.toThrow(/sentByEmail is required/);
  });
});
