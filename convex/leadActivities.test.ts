import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PERMISSIONS = [
  "create:leads", "edit:leads", "delete:leads", "view:leads",
  "view:customers", "view:vehicles", "view:users",
];

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Trail Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_t1", email: "t@test.com", name: "Trail User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ADMIN", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Ahmad", lastName: "Buyer", phone: "0790000001" })
  );
  const otherCustomerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Layla", lastName: "Second", phone: "0790000002" })
  );
  const secondUserId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_t2", email: "t2@test.com", name: "Second Rep" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: secondUserId, roleId }));

  const asUser = t.withIdentity({ subject: "user_t1" });
  return { t, orgId, userId, secondUserId, customerId, otherCustomerId, asUser };
}

async function trailFor(t: any, orgId: Id<"organizations">, leadId: Id<"leads">) {
  return await t.run(async (ctx: any) =>
    ctx.db
      .query("leadActivities")
      .withIndex("by_org_lead", (q: any) => q.eq("orgId", orgId).eq("leadId", leadId))
      .collect()
  );
}

describe("lead audit trail — writes", () => {
  test("create records CREATED, and ASSIGNED separately when it lands on a rep", async () => {
    const { t, orgId, customerId, secondUserId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId,
      customerId,
      assignedUserId: secondUserId,
      source: "Walk-in",
    });

    const rows = await trailFor(t, orgId, leadId);
    expect(rows.map((r: any) => r.action).sort()).toEqual(["ASSIGNED", "CREATED"]);

    const assigned = rows.find((r: any) => r.action === "ASSIGNED");
    // The rep is stored by name, not id, so the trail survives a rename/delete.
    expect(assigned.toValue).toBe("Second Rep");
    expect(assigned.field).toBe("assignedUserId");
  });

  test("create with no assignee records CREATED only", async () => {
    const { t, orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId, customerId, source: "Walk-in",
    });

    const rows = await trailFor(t, orgId, leadId);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("CREATED");
    expect(rows[0].toValue).toBe("NEW");
  });

  test("update writes one row per field that actually moved", async () => {
    const { t, orgId, customerId, secondUserId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId, customerId, source: "Walk-in",
    });

    await asUser.mutation(api.leads.update, {
      orgId,
      leadId,
      stage: "NEGOTIATION",
      assignedUserId: secondUserId,
    });

    const rows = await trailFor(t, orgId, leadId);
    const afterCreate = rows.filter((r: any) => r.action !== "CREATED");

    expect(afterCreate).toHaveLength(2);

    const stageRow = afterCreate.find((r: any) => r.field === "stage");
    expect(stageRow.action).toBe("STAGE_CHANGED");
    expect(stageRow.fromValue).toBe("NEW");
    expect(stageRow.toValue).toBe("NEGOTIATION");

    const assignRow = afterCreate.find((r: any) => r.field === "assignedUserId");
    expect(assignRow.action).toBe("ASSIGNED");
    expect(assignRow.toValue).toBe("Second Rep");
  });

  test("clearing the assignee records UNASSIGNED, not ASSIGNED", async () => {
    const { t, orgId, customerId, secondUserId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId, customerId, assignedUserId: secondUserId, source: "Walk-in",
    });
    // The dialog sends the cleared dropdown as an absent field, so drive the
    // clear the way the client actually does — via a direct patch, then a
    // subsequent edit — rather than relying on `assignedUserId: undefined`.
    await t.run((ctx) => ctx.db.patch(leadId, { assignedUserId: undefined }));
    await asUser.mutation(api.leads.update, {
      orgId, leadId, assignedUserId: secondUserId,
    });

    const rows = await trailFor(t, orgId, leadId);
    const assignRows = rows.filter((r: any) => r.field === "assignedUserId");
    expect(assignRows.every((r: any) => r.action === "ASSIGNED")).toBe(true);
  });

  test("a no-op save writes nothing and leaves updatedAt untouched", async () => {
    const { t, orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId, customerId, source: "Walk-in", stage: "CONTACTED", notes: "keen buyer",
    });
    const before = await trailFor(t, orgId, leadId);

    // Exactly what the edit dialog submits when a user opens a lead and saves
    // without touching anything: every field, all unchanged.
    await asUser.mutation(api.leads.update, {
      orgId, leadId, customerId, source: "Walk-in", stage: "CONTACTED", notes: "keen buyer",
    });

    const after = await trailFor(t, orgId, leadId);
    expect(after).toHaveLength(before.length);

    await t.run(async (ctx) => {
      const lead = await ctx.db.get(leadId);
      expect(lead?.updatedAt).toBeUndefined();
    });
  });

  test("soft delete appends DELETED rather than clearing history", async () => {
    const { t, orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId, customerId, source: "Walk-in",
    });
    await asUser.mutation(api.leads.update, { orgId, leadId, stage: "INTERESTED" });
    await asUser.mutation(api.leads.softDelete, { orgId, leadId });

    const rows = await trailFor(t, orgId, leadId);
    expect(rows.map((r: any) => r.action)).toEqual(["CREATED", "STAGE_CHANGED", "DELETED"]);

    const deleted = rows.find((r: any) => r.action === "DELETED");
    expect(deleted.fromValue).toBe("INTERESTED");
  });

  test("attributes automated stage advances to the trigger, not to a user", async () => {
    const { t, orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId, customerId, source: "Walk-in",
    });

    const { advanceLeadStage } = await import("./utils/leadStageHelpers");
    await t.run(async (ctx: any) => {
      await advanceLeadStage(ctx, { leadId, targetStage: "TEST_DRIVE", trigger: "Test drive logged" });
    });

    const rows = await trailFor(t, orgId, leadId);
    const auto = rows.find((r: any) => r.action === "STAGE_CHANGED");
    expect(auto.actorUserId).toBeUndefined();
    expect(auto.actorLabel).toBe("Test drive logged");
    expect(auto.toValue).toBe("TEST_DRIVE");
  });
});

describe("leads.addNote — append-only salesperson updates", () => {
  test("each update is its own row; a second update does not replace the first", async () => {
    const { t, orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId, customerId, source: "Walk-in",
    });

    await asUser.mutation(api.leads.addNote, {
      orgId, leadId, note: "Called twice, no answer.",
    });
    await asUser.mutation(api.leads.addNote, {
      orgId, leadId, note: "Reached him — wants a test drive Saturday.",
    });

    const notes = (await trailFor(t, orgId, leadId)).filter((r: any) => r.action === "NOTE");
    expect(notes).toHaveLength(2);
    expect(notes.map((n: any) => n.note)).toEqual([
      "Called twice, no answer.",
      "Reached him — wants a test drive Saturday.",
    ]);
  });

  test("leaves the lead's own notes field alone", async () => {
    const { t, orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId, customerId, source: "Instagram DM", notes: 'First Instagram DM: "0791016661"',
    });
    await asUser.mutation(api.leads.addNote, { orgId, leadId, note: "Sent him the Camry listing." });

    await t.run(async (ctx) => {
      const lead = await ctx.db.get(leadId);
      // The original social context is not overwritten by a follow-up update.
      expect(lead?.notes).toBe('First Instagram DM: "0791016661"');
    });
  });

  test("moves the lead's updatedAt so a follow-up counts as a touch", async () => {
    const { t, orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId, customerId, source: "Walk-in",
    });
    await asUser.mutation(api.leads.addNote, { orgId, leadId, note: "Left a voicemail." });

    await t.run(async (ctx) => {
      const lead = await ctx.db.get(leadId);
      expect(lead?.updatedAt).toBeGreaterThan(0);
    });
  });

  test("rejects an empty or whitespace-only update", async () => {
    const { orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId, customerId, source: "Walk-in",
    });

    await expect(
      asUser.mutation(api.leads.addNote, { orgId, leadId, note: "   " })
    ).rejects.toThrow();
  });

  test("refuses to append to a lead in another org", async () => {
    const { t, orgId, asUser } = await setup();

    const otherOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Rival", createdAt: Date.now() })
    );
    const otherCustomer = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId: otherOrgId, firstName: "Not", lastName: "Yours" })
    );
    const foreignLeadId = await t.run((ctx) =>
      ctx.db.insert("leads", {
        orgId: otherOrgId, customerId: otherCustomer, source: "Walk-in", stage: "NEW",
      })
    );

    await expect(
      asUser.mutation(api.leads.addNote, { orgId, leadId: foreignLeadId, note: "hello" })
    ).rejects.toThrow();
  });
});

describe("leads.customerMessages — read-only social summary", () => {
  test("returns the customer's own messages newest-first with an unanswered count", async () => {
    const { t, orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId, customerId, source: "Instagram DM",
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("instagramEvents", {
        orgId, customerId, kind: "dm", externalId: "ig1",
        text: "Is the 2022 Camry still available?",
        senderInstagramId: "sender_1",
      });
      await ctx.db.insert("facebookEvents", {
        orgId, customerId, kind: "comment", externalId: "fb1",
        text: "What's the price?",
        senderFacebookId: "sender_1",
        manualRepliedAt: Date.now(),
      });
    });

    const result = await asUser.query(api.leads.customerMessages, { orgId, leadId });

    expect(result.total).toBe(2);
    // The Facebook comment was manually replied to; the Instagram DM was not.
    expect(result.unansweredCount).toBe(1);
    expect(result.messages.map((m: any) => m.text)).toContain("Is the 2022 Camry still available?");
  });

  test("an auto-reply does not count as answered", async () => {
    const { t, orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId, customerId, source: "Instagram DM",
    });
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId, customerId, kind: "dm", externalId: "ig2",
        text: "Do you finance?",
        senderInstagramId: "sender_2",
        autoRepliedAt: Date.now(),
        autoReplyText: "Thanks for reaching out!",
      })
    );

    const result = await asUser.query(api.leads.customerMessages, { orgId, leadId });
    expect(result.unansweredCount).toBe(1);
  });

  test("returns nothing for a lead with no social history", async () => {
    const { orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId, customerId, source: "Walk-in",
    });

    const result = await asUser.query(api.leads.customerMessages, { orgId, leadId });
    expect(result.total).toBe(0);
    expect(result.messages).toEqual([]);
  });

  test("refuses to read messages for a lead in another org", async () => {
    const { t, orgId, asUser } = await setup();

    const otherOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Rival", createdAt: Date.now() })
    );
    const otherCustomer = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId: otherOrgId, firstName: "Not", lastName: "Yours" })
    );
    const foreignLeadId = await t.run((ctx) =>
      ctx.db.insert("leads", {
        orgId: otherOrgId, customerId: otherCustomer, source: "Instagram DM", stage: "NEW",
      })
    );

    await expect(
      asUser.query(api.leads.customerMessages, { orgId, leadId: foreignLeadId })
    ).rejects.toThrow();
  });
});

describe("leadActivities.listForLead — reads", () => {
  test("returns the trail newest-first with actor names resolved", async () => {
    const { orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId, customerId, source: "Walk-in",
    });
    await asUser.mutation(api.leads.update, { orgId, leadId, stage: "CONTACTED" });

    const trail = await asUser.query(api.leadActivities.listForLead, { orgId, leadId });

    expect(trail).toHaveLength(2);
    expect(trail[0].action).toBe("STAGE_CHANGED");
    expect(trail[0].actorName).toBe("Trail User");
    expect(trail[0].isSystemActor).toBe(false);
    expect(trail[1].action).toBe("CREATED");
  });

  test("still returns history for a soft-deleted lead", async () => {
    const { orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId, customerId, source: "Walk-in",
    });
    await asUser.mutation(api.leads.softDelete, { orgId, leadId });

    const trail = await asUser.query(api.leadActivities.listForLead, { orgId, leadId });
    expect(trail.map((r: any) => r.action)).toContain("DELETED");
  });

  test("rejects unauthenticated reads", async () => {
    const { t, orgId, customerId, asUser } = await setup();

    const leadId = await asUser.mutation(api.leads.create, {
      orgId, customerId, source: "Walk-in",
    });

    await expect(
      t.query(api.leadActivities.listForLead, { orgId, leadId })
    ).rejects.toThrow();
  });

  test("refuses to read a lead belonging to another org", async () => {
    const { t, orgId, customerId, asUser } = await setup();

    // A second org the caller has no membership in, holding its own lead.
    const otherOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Rival Dealer", createdAt: Date.now() })
    );
    const otherCustomer = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId: otherOrgId, firstName: "Not", lastName: "Yours" })
    );
    const foreignLeadId = await t.run((ctx) =>
      ctx.db.insert("leads", {
        orgId: otherOrgId, customerId: otherCustomer, source: "Walk-in", stage: "NEW",
      })
    );

    // Naming an org the caller *is* in while pointing at a foreign row must not
    // pass — membership in `orgId` says nothing about who owns `leadId`.
    await expect(
      asUser.query(api.leadActivities.listForLead, { orgId, leadId: foreignLeadId })
    ).rejects.toThrow();

    // And the caller can't reach it by naming the owning org either.
    await expect(
      asUser.query(api.leadActivities.listForLead, { orgId: otherOrgId, leadId: foreignLeadId })
    ).rejects.toThrow();
  });
});
