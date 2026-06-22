import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

async function seedOrgWithEditor(t: ReturnType<typeof convexTest>) {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: "Test Org", createdAt: Date.now() })
  );
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId: "inbox_editor_001", email: "inboxeditor@test.com", name: "Editor" })
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:leads", "edit:leads"] })
  );
  await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { orgId, userId, asEditor: t.withIdentity({ subject: "inbox_editor_001" }) };
}

describe("socialInbox.listConversations", () => {
  test("merges Instagram and Facebook events for the same org into separate, platform-tagged conversations", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const igCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "IG", lastName: "Buyer", instagramUserId: "ig_inbox_1" })
    );
    const igLeadId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId: igCustomerId, source: "Instagram Comment", stage: "NEW" })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "inbox_ig_1",
        kind: "comment",
        senderInstagramId: "ig_inbox_1",
        senderUsername: "ig_handle",
        customerId: igCustomerId,
        leadId: igLeadId,
        text: "ig comment",
      })
    );

    const fbCustomerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "FB", lastName: "Buyer", facebookUserId: "fb_inbox_1" })
    );
    const fbLeadId = await t.run((ctx) =>
      ctx.db.insert("leads", { orgId, customerId: fbCustomerId, source: "Facebook Comment", stage: "NEW" })
    );
    await t.run((ctx) =>
      ctx.db.insert("facebookEvents", {
        orgId,
        externalId: "inbox_fb_1",
        kind: "comment",
        senderFacebookId: "fb_inbox_1",
        senderName: "FB Handle",
        customerId: fbCustomerId,
        leadId: fbLeadId,
        text: "fb comment",
      })
    );

    const result = await asEditor.query(api.socialInbox.listConversations, {
      orgId,
      paginationOpts: { numItems: 25, cursor: null },
    });

    expect(result.page.length).toBe(2);
    const platforms = result.page.map((c) => c.platform).sort();
    expect(platforms).toEqual(["facebook", "instagram"]);
  });

  test("groups multiple events for the same customer into one conversation, and shows up even with no lead", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "No", lastName: "Lead", instagramUserId: "ig_no_lead" })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "no_lead_1",
        kind: "comment",
        senderInstagramId: "ig_no_lead",
        customerId,
        text: "first",
        autoRepliedAt: Date.now(),
        autoReplyText: "thanks",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "no_lead_2",
        kind: "dm",
        senderInstagramId: "ig_no_lead",
        customerId,
        text: "second",
      })
    );

    const result = await asEditor.query(api.socialInbox.listConversations, {
      orgId,
      paginationOpts: { numItems: 25, cursor: null },
    });

    expect(result.page.length).toBe(1);
    expect(result.page[0].customerId).toBe(customerId);
    expect(result.page[0].leadId).toBeNull();
    expect(result.page[0].eventCount).toBe(2);
    expect(result.page[0].needsReply).toBe(true);
  });
});

describe("socialInbox.listEventsForCustomer", () => {
  test("returns merged Instagram + Facebook events for the customer, oldest first", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Multi", lastName: "Platform" })
    );

    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "merge_ig_1",
        kind: "comment",
        senderInstagramId: "ig_merge",
        customerId,
        text: "first (ig)",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("facebookEvents", {
        orgId,
        externalId: "merge_fb_1",
        kind: "comment",
        senderFacebookId: "fb_merge",
        customerId,
        text: "second (fb)",
      })
    );

    const events = await asEditor.query(api.socialInbox.listEventsForCustomer, { orgId, customerId });
    expect(events.length).toBe(2);
    expect(events.map((e) => e.text)).toEqual(["first (ig)", "second (fb)"]);
    expect(events.map((e) => e.platform)).toEqual(["instagram", "facebook"]);
  });
});
