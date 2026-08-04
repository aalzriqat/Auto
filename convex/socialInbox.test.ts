import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

async function seedOrgWithEditor(t: ReturnType<typeof convexTestWithComponents>) {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: "Test Org", createdAt: Date.now() })
  );
  await t.run(async (ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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

describe("socialInbox conversation display names", () => {
  test("never shows the raw PSID for a DM sender whose profile never resolved", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    // A Messenger DM carries a PSID and nothing else. Until the Graph profile
    // lookup lands, the customer holds the placeholder name — and the inbox
    // used to fall back to printing the PSID itself as the contact's name.
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Facebook",
        lastName: "Contact",
        facebookUserId: "28136656255928185",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("facebookEvents", {
        orgId,
        externalId: "inbox_fb_psid",
        kind: "dm",
        senderFacebookId: "28136656255928185",
        customerId,
        text: "كيف يمكنني الحصول على تمويل لشراء السيارة؟",
      })
    );

    const result = await asEditor.query(api.socialInbox.listConversations, {
      orgId,
      paginationOpts: { numItems: 25, cursor: null },
    });

    expect(result.page).toHaveLength(1);
    expect(result.page[0].senderDisplayName).not.toBe("28136656255928185");
    expect(result.page[0].senderDisplayName).toBe("Facebook Contact");
  });

  test("never shows a PSID that was split into firstName with 'Contact' left behind", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    // The other shape an unresolved record takes: intake splits a display name
    // on spaces, so an id passed through as a name lands in firstName with the
    // placeholder surname still attached. Comparing only the joined full name
    // against the id misses this one.
    const psid = "28136656255928185";
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: psid,
        lastName: "Contact",
        facebookUserId: psid,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("facebookEvents", {
        orgId,
        externalId: "inbox_fb_psid_split",
        kind: "dm",
        senderFacebookId: psid,
        customerId,
        text: "hello",
      })
    );

    const result = await asEditor.query(api.socialInbox.listConversations, {
      orgId,
      paginationOpts: { numItems: 25, cursor: null },
    });

    expect(result.page[0].senderDisplayName).not.toContain(psid);
    expect(result.page[0].senderDisplayName).toBe("Facebook Contact");
  });

  test("shows the customer's edited name instead of the stored social handle", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    // Staff renamed this auto-created contact to the person's real name. The
    // handle used to win, so the rename never reached the inbox even though
    // every other screen showed it.
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Layla",
        lastName: "Al Nimri",
        instagramUserId: "ig_renamed_1",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "inbox_ig_renamed",
        kind: "dm",
        senderInstagramId: "ig_renamed_1",
        senderUsername: "old_ig_handle",
        customerId,
        text: "hi",
      })
    );

    const result = await asEditor.query(api.socialInbox.listConversations, {
      orgId,
      paginationOpts: { numItems: 25, cursor: null },
    });

    expect(result.page).toHaveLength(1);
    expect(result.page[0].senderDisplayName).toBe("Layla Al Nimri");
    // The handle is still available separately — the profile/DM deep links
    // depend on it, so preferring the real name must not drop it.
    expect(result.page[0].latestSenderHandle).toBe("old_ig_handle");
  });

  test("falls back to the handle when the contact has only a placeholder name", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asEditor } = await seedOrgWithEditor(t);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Instagram",
        lastName: "Contact",
        instagramUserId: "ig_placeholder_1",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "inbox_ig_placeholder",
        kind: "comment",
        senderInstagramId: "ig_placeholder_1",
        senderUsername: "real_handle",
        customerId,
        text: "nice car",
      })
    );

    const result = await asEditor.query(api.socialInbox.listConversations, {
      orgId,
      paginationOpts: { numItems: 25, cursor: null },
    });

    expect(result.page[0].senderDisplayName).toBe("real_handle");
  });
});

describe("socialInbox.listEventsForCustomer", () => {
  test("returns merged Instagram + Facebook events for the customer, oldest first", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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

describe("socialInbox.setConversationVehicle tenant isolation", () => {
  test("refuses a vehicle that belongs to another organization", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, userId } = await seedOrgWithEditor(t);

    // setConversationVehicle needs approve:requests, which the shared fixture
    // role does not carry.
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
        .unique();
      const role = await ctx.db.get(membership!.roleId);
      await ctx.db.patch(membership!.roleId, {
        permissions: [...role!.permissions, "approve:requests"],
      });
    });
    const asEditor = t.withIdentity({ subject: "inbox_editor_001" });

    // A second, unrelated dealership with a vehicle of its own.
    const otherOrgId = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Rival Motors", createdAt: Date.now() })
    );
    const foreignVehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: otherOrgId,
        vin: "RIVALVIN0000000001",
        make: "Rival",
        model: "Secret Model",
        trim: "Confidential",
        year: 2031,
        mileage: 10,
        color: "Black",
        fuelType: "Electric",
        transmission: "Automatic",
        sellingPrice: 99000,
        status: "AVAILABLE",
      })
    );

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Cross",
        lastName: "Tenant",
        instagramUserId: "ig_cross_1",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "cross_ig_1",
        kind: "dm",
        senderInstagramId: "ig_cross_1",
        senderUsername: "cross_handle",
        customerId,
        text: "interested",
      })
    );

    // Attaching another org's vehicle used to succeed, and listConversations /
    // listConversationEvents then resolved it with a bare ctx.db.get and handed
    // back "2031 Rival Secret Model" as vehicleSummary — a cross-tenant read.
    await expect(
      asEditor.mutation(api.socialInbox.setConversationVehicle, {
        orgId,
        customerId,
        vehicleId: foreignVehicleId,
      })
    ).rejects.toThrow(/vehicle not found/i);

    const events = await asEditor.query(api.socialInbox.listEventsForConversation, {
      orgId,
      customerId,
      platform: "instagram",
      conversationKind: "dm",
    });
    expect(events[0].vehicleId ?? null).toBeNull();
    expect(events[0].vehicleSummary).toBeNull();
  });
});

describe("socialInboxBackfill artificial-surname repair", () => {
  test("drops the repeated surname without asking the platform for a name", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithEditor(t);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "mhty7220",
        lastName: "mhty7220",
        instagramUserId: "ig_dup_repair",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "ev_mhty7220",
        kind: "dm",
        senderInstagramId: "ig_dup_repair",
        senderUsername: "mhty7220",
        customerId,
      })
    );

    const collapsed = await t.run((ctx) =>
      ctx.runMutation(internal.socialInboxBackfill.collapseArtificialSurname, { customerId })
    );

    expect(collapsed).toBe(true);
    const repaired = await t.run((ctx) => ctx.db.get(customerId));
    expect(repaired?.firstName).toBe("mhty7220");
    expect(repaired?.lastName).toBe("");
  });

  test("leaves a name that is not duplicated alone", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithEditor(t);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Layla",
        lastName: "Al Nimri",
        instagramUserId: "ig_real_name",
      })
    );

    const collapsed = await t.run((ctx) =>
      ctx.runMutation(internal.socialInboxBackfill.collapseArtificialSurname, { customerId })
    );

    expect(collapsed).toBe(false);
    const untouched = await t.run((ctx) => ctx.db.get(customerId));
    expect(untouched?.lastName).toBe("Al Nimri");
  });
});

describe("socialInboxBackfill stray placeholder surname", () => {
  test("drops the leftover \"Contact\" surname beside a real Instagram handle", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithEditor(t);

    // The shape the old splitter produced for every single-token profile name:
    // `lastName: parts.slice(1).join(" ") || PLACEHOLDER_LAST_NAME`. The first
    // name is genuine so it is not a placeholder, and the halves differ so it
    // is not a duplicate — which left these invisible to every other repair.
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "kamalalia19",
        lastName: "Contact",
        instagramUserId: "1678691899891601",
      })
    );
    // The proof that intake manufactured the surname: the platform sent this
    // exact handle for this customer.
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "ev_kamalalia19",
        kind: "comment",
        senderInstagramId: "1678691899891601",
        senderUsername: "kamalalia19",
        customerId,
      })
    );

    const repaired = await t.run((ctx) =>
      ctx.runMutation(internal.socialInboxBackfill.collapseArtificialSurname, { customerId })
    );

    expect(repaired).toBe(true);
    const row = await t.run((ctx) => ctx.db.get(customerId));
    expect(row?.firstName).toBe("kamalalia19");
    expect(row?.lastName).toBe("");
  });

  test("leaves a true placeholder alone so it still gets a name lookup", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithEditor(t);

    // Shortening this to "Facebook" would destroy the signal that the contact
    // still needs a real name fetched.
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Facebook",
        lastName: "Contact",
        facebookUserId: "28007134862281013",
      })
    );

    const repaired = await t.run((ctx) =>
      ctx.runMutation(internal.socialInboxBackfill.collapseArtificialSurname, { customerId })
    );

    expect(repaired).toBe(false);
    const row = await t.run((ctx) => ctx.db.get(customerId));
    expect(row?.lastName).toBe("Contact");
  });

  test("does not touch a contact whose surname is genuinely something else", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithEditor(t);

    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Feras",
        lastName: "Al Nimri",
        facebookUserId: "27578165338517461",
      })
    );

    const repaired = await t.run((ctx) =>
      ctx.runMutation(internal.socialInboxBackfill.collapseArtificialSurname, { customerId })
    );

    expect(repaired).toBe(false);
    const row = await t.run((ctx) => ctx.db.get(customerId));
    expect(row?.lastName).toBe("Al Nimri");
  });

  test("the discovery query queues these rows for repair", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithEditor(t);

    const strayId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Feras",
        lastName: "Contact",
        facebookUserId: "27578165338517461",
      })
    );

    const found = await t.run((ctx) =>
      ctx.runQuery(internal.socialInboxBackfill.getUnresolvedSocialCustomers, { orgId })
    );

    expect(found.artificialSurnames).toContain(strayId);
  });
});

describe("socialInboxBackfill cross-platform placeholder", () => {
  test("a dual-id contact named 'Facebook Contact' is not shortened by the Instagram check", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithEditor(t);

    // Checking only the platform being repaired would clear this on the
    // Instagram test ("Facebook" is not "Instagram") and drop the surname,
    // leaving a row that looks repaired while having discarded the marker
    // saying a real name is still missing.
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Facebook",
        lastName: "Contact",
        facebookUserId: "28007134862281013",
        instagramUserId: "1678691899891601",
      })
    );

    const repaired = await t.run((ctx) =>
      ctx.runMutation(internal.socialInboxBackfill.collapseArtificialSurname, { customerId })
    );

    expect(repaired).toBe(false);
    const row = await t.run((ctx) => ctx.db.get(customerId));
    expect(row?.lastName).toBe("Contact");
  });
});

describe("socialInboxBackfill repair requires recorded evidence", () => {
  test("a genuine surname that happens to be 'Contact' is never dropped", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithEditor(t);

    // The platform sent "Jane Contact" as one name, so intake split a real
    // two-word name. The surname was chosen, not manufactured.
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Jane",
        lastName: "Contact",
        facebookUserId: "fb_jane_contact",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("facebookEvents", {
        orgId,
        externalId: "ev_jane",
        kind: "comment",
        senderFacebookId: "fb_jane_contact",
        senderName: "Jane Contact",
        customerId,
      })
    );

    const repaired = await t.run((ctx) =>
      ctx.runMutation(internal.socialInboxBackfill.collapseArtificialSurname, { customerId })
    );

    expect(repaired).toBe(false);
    const row = await t.run((ctx) => ctx.db.get(customerId));
    expect(row?.lastName).toBe("Contact");
  });

  test("a staff-corrected name ending in 'Contact' survives repeated resyncs", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithEditor(t);

    // Staff renamed a social contact by hand. customers.update keeps the
    // social id, so without the evidence check the next resync would delete
    // the surname they just typed — every single run.
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Ahmad",
        lastName: "Contact",
        instagramUserId: "ig_staff_edited",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "ev_staff_edited",
        kind: "dm",
        senderInstagramId: "ig_staff_edited",
        senderUsername: "some_other_handle",
        customerId,
      })
    );

    for (let run = 0; run < 2; run += 1) {
      const repaired = await t.run((ctx) =>
        ctx.runMutation(internal.socialInboxBackfill.collapseArtificialSurname, { customerId })
      );
      expect(repaired).toBe(false);
    }
    const row = await t.run((ctx) => ctx.db.get(customerId));
    expect(row?.lastName).toBe("Contact");
  });

  test("an ordinary customer named \"Ali Ali\" is not a candidate at all", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithEditor(t);

    // Equal given and family names are ordinary, particularly in Arabic. This
    // row has no social ids, so it must never enter the repair queue.
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Ali", lastName: "Ali" })
    );

    const found = await t.run((ctx) =>
      ctx.runQuery(internal.socialInboxBackfill.getUnresolvedSocialCustomers, { orgId })
    );
    expect(found.artificialSurnames).not.toContain(customerId);

    const repaired = await t.run((ctx) =>
      ctx.runMutation(internal.socialInboxBackfill.collapseArtificialSurname, { customerId })
    );
    expect(repaired).toBe(false);
    const row = await t.run((ctx) => ctx.db.get(customerId));
    expect(row?.lastName).toBe("Ali");
  });

  test("an archived customer is not repaired between discovery and the write", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOrgWithEditor(t);

    // Discovery skips deleted rows; the mutation must too, or a row archived
    // during the Graph lookups gets written and counted as repaired.
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "kamalalia19",
        lastName: "Contact",
        instagramUserId: "ig_archived",
        isDeleted: true,
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("instagramEvents", {
        orgId,
        externalId: "ev_archived",
        kind: "dm",
        senderInstagramId: "ig_archived",
        senderUsername: "kamalalia19",
        customerId,
      })
    );

    const repaired = await t.run((ctx) =>
      ctx.runMutation(internal.socialInboxBackfill.collapseArtificialSurname, { customerId })
    );

    expect(repaired).toBe(false);
    const row = await t.run((ctx) => ctx.db.get(customerId));
    expect(row?.lastName).toBe("Contact");
  });
});
