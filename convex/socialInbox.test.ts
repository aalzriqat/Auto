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

  test("splits same-customer events into separate comment and DM conversation threads", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "No", lastName: "Lead", instagramUserId: "ig_no_lead" })
    );
    // Comment that was auto-replied
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
    // DM that was NOT replied
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

    // Comment and DM are now separate conversation threads
    expect(result.page.length).toBe(2);
    expect(result.page.every((c) => c.customerId === customerId)).toBe(true);
    expect(result.page.every((c) => c.leadId === null)).toBe(true);

    const commentThread = result.page.find((c) => c.conversationKind === "comment");
    const dmThread = result.page.find((c) => c.conversationKind === "dm");
    expect(commentThread).toBeDefined();
    expect(dmThread).toBeDefined();
    expect(commentThread!.needsReply).toBe(false); // was auto-replied
    expect(dmThread!.needsReply).toBe(true);        // no reply yet
  });

  test("groups multiple comments on the same post into one thread", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Repeat", lastName: "Commenter" })
    );
    for (const externalId of ["c1", "c2", "c3"]) {
      await t.run((ctx) =>
        ctx.db.insert("facebookEvents", {
          orgId,
          externalId,
          kind: "comment",
          senderFacebookId: "fb_repeat",
          customerId,
          postId: "post_abc",
          text: `comment ${externalId}`,
        })
      );
    }

    const result = await asEditor.query(api.socialInbox.listConversations, {
      orgId,
      paginationOpts: { numItems: 25, cursor: null },
    });

    expect(result.page.length).toBe(1);
    expect(result.page[0].eventCount).toBe(3);
    expect(result.page[0].conversationKind).toBe("comment");
    expect(result.page[0].conversationPostId).toBe("post_abc");
  });

  test("splits same-customer comments on different posts into separate threads", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Multi", lastName: "Post" })
    );
    await t.run((ctx) =>
      ctx.db.insert("facebookEvents", {
        orgId, externalId: "ev1", kind: "comment",
        senderFacebookId: "fb_multi", customerId,
        postId: "post_kia", text: "interested in the kia",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("facebookEvents", {
        orgId, externalId: "ev2", kind: "comment",
        senderFacebookId: "fb_multi", customerId,
        postId: "post_bmw", text: "interested in the bmw",
      })
    );

    const result = await asEditor.query(api.socialInbox.listConversations, {
      orgId,
      paginationOpts: { numItems: 25, cursor: null },
    });

    expect(result.page.length).toBe(2);
    const postIds = result.page.map((c) => c.conversationPostId).sort();
    expect(postIds).toEqual(["post_bmw", "post_kia"]);
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

describe("socialInbox.listEventsForConversation", () => {
  test("returns only events matching the conversation (platform + kind + postId)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Conv", lastName: "Test" })
    );
    await t.run((ctx) =>
      ctx.db.insert("facebookEvents", {
        orgId, externalId: "conv_1", kind: "comment",
        senderFacebookId: "fb_conv", customerId,
        postId: "post_x", text: "on post x",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("facebookEvents", {
        orgId, externalId: "conv_2", kind: "comment",
        senderFacebookId: "fb_conv", customerId,
        postId: "post_y", text: "on post y",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("facebookEvents", {
        orgId, externalId: "conv_3", kind: "dm",
        senderFacebookId: "fb_conv", customerId,
        text: "dm message",
      })
    );

    // Only comments on post_x
    const postXEvents = await asEditor.query(api.socialInbox.listEventsForConversation, {
      orgId, customerId, platform: "facebook",
      conversationKind: "comment", conversationPostId: "post_x",
    });
    expect(postXEvents.length).toBe(1);
    expect(postXEvents[0].text).toBe("on post x");

    // Only DMs
    const dmEvents = await asEditor.query(api.socialInbox.listEventsForConversation, {
      orgId, customerId, platform: "facebook",
      conversationKind: "dm",
    });
    expect(dmEvents.length).toBe(1);
    expect(dmEvents[0].text).toBe("dm message");
  });

  test("returns vehicle suggestions from stored partial match hints", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "1HGCM82633A004352",
        make: "BYD",
        model: "Song Pro",
        trim: "Zero",
        year: 2025,
        mileage: 1200,
        color: "Silver",
        fuelType: "Hybrid",
        transmission: "Automatic",
        sellingPrice: 25000,
        status: "AVAILABLE",
      })
    );
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Hint", lastName: "Buyer", instagramUserId: "ig_hint" })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "hint_1",
        kind: "comment",
        senderInstagramId: "ig_hint",
        customerId,
        postId: "post_hint",
        text: "price?",
        vehicleMatchHintText: "#byd SONG PRO",
        vehicleMatchHintSource: "post",
      })
    );

    const events = await asEditor.query(api.socialInbox.listEventsForConversation, {
      orgId,
      customerId,
      platform: "instagram",
      conversationKind: "comment",
      conversationPostId: "post_hint",
    });

    expect(events[0].vehicleSuggestion?.source).toBe("post");
    expect(events[0].vehicleSuggestion?.candidates[0].vehicleId).toBe(vehicleId);
    expect(events[0].vehicleSuggestion?.missingDetails).toContain("year");
  });
});
