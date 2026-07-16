import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const BUYER_PHONE = "+962791234567";

async function seedOrg(t: ReturnType<typeof convexTest>, name = "Bloom Cars") {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name, createdAt: Date.now() }));
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `u_${orgId}`, email: `u_${orgId}@test.com`, name: "Rep" })
  );
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "SALES", permissions: [] }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { orgId, userId };
}

async function seedRequestWithOffer(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"organizations">,
  userId: Id<"users">,
  publicId: string
) {
  const requestId = await t.run((ctx) =>
    ctx.db.insert("marketplaceRequests", {
      status: "OFFERS_RECEIVED",
      publicId,
      buyerFirstName: "Sami",
      buyerPhone: BUYER_PHONE,
      buyerCity: "Amman",
      make: "Toyota",
      model: "Corolla",
      paymentType: "FINANCE",
      buyerTimeframe: "ASAP",
      buyerIntent: "HOT",
      consentAcceptedAt: Date.now(),
      clientFingerprint: "fp-buyer",
      expiresAt: Date.now() + 100000,
      createdAt: Date.now(),
    })
  );
  const matchId = await t.run((ctx) =>
    ctx.db.insert("marketplaceRequestMatches", { requestId, orgId, matchedAt: Date.now() })
  );
  const responseId = await t.run((ctx) =>
    ctx.db.insert("marketplaceResponses", {
      requestId,
      orgId,
      respondingUserId: userId,
      kind: "HAVE_SIMILAR",
      offerPriceJod: 19000,
      createdAt: Date.now(),
    })
  );
  return { requestId, matchId, responseId };
}

describe("shortlistOffer / declineOffer", () => {
  test("shortlist stamps buyerAction without creating a lead or unlocking contact", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId } = await seedOrg(t);
    const { responseId } = await seedRequestWithOffer(t, orgId, userId, "tok-shortlist");

    await t.mutation(api.marketplaceBuyerActions.shortlistOffer, { publicId: "tok-shortlist", responseId });

    const response = await t.run((ctx) => ctx.db.get(responseId));
    expect(response?.buyerAction).toBe("SHORTLISTED");
    expect(response?.contactUnlockedAt).toBeUndefined();
    const leads = await t.run((ctx) => ctx.db.query("leads").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect());
    expect(leads).toHaveLength(0);
  });

  test("decline stamps buyerAction DECLINED", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId } = await seedOrg(t);
    const { responseId } = await seedRequestWithOffer(t, orgId, userId, "tok-decline");

    await t.mutation(api.marketplaceBuyerActions.declineOffer, { publicId: "tok-decline", responseId });

    expect((await t.run((ctx) => ctx.db.get(responseId)))?.buyerAction).toBe("DECLINED");
  });

  test("rejects a shortlist whose responseId belongs to a different request", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId } = await seedOrg(t);
    await seedRequestWithOffer(t, orgId, userId, "tok-a");
    const { responseId: foreignResponseId } = await seedRequestWithOffer(t, orgId, userId, "tok-b");

    await expect(
      t.mutation(api.marketplaceBuyerActions.shortlistOffer, { publicId: "tok-a", responseId: foreignResponseId })
    ).rejects.toThrow(/offer/i);
  });
});

describe("allowContact", () => {
  test("creates the customer + lead and unlocks contact for that one dealer, phone-gated", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId } = await seedOrg(t);
    const { requestId, matchId, responseId } = await seedRequestWithOffer(t, orgId, userId, "tok-allow");

    await t.mutation(api.marketplaceBuyerActions.allowContact, {
      publicId: "tok-allow",
      responseId,
      buyerPhone: BUYER_PHONE,
    });

    const leads = await t.run((ctx) => ctx.db.query("leads").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect());
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ orgId, sourceChannel: "marketplace", marketplaceRequestId: requestId, stage: "NEW" });

    const customers = await t.run((ctx) => ctx.db.query("customers").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect());
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ phone: BUYER_PHONE });

    expect((await t.run((ctx) => ctx.db.get(responseId)))?.contactUnlockedAt).toBeGreaterThan(0);
    expect((await t.run((ctx) => ctx.db.get(matchId)))?.contactUnlockedAt).toBeGreaterThan(0);
  });

  test("rejects a wrong phone and creates nothing", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId } = await seedOrg(t);
    const { responseId } = await seedRequestWithOffer(t, orgId, userId, "tok-wrong");

    await expect(
      t.mutation(api.marketplaceBuyerActions.allowContact, {
        publicId: "tok-wrong",
        responseId,
        buyerPhone: "+962700000000",
      })
    ).rejects.toThrow(/phone/i);

    const leads = await t.run((ctx) => ctx.db.query("leads").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect());
    expect(leads).toHaveLength(0);
  });

  test("is idempotent — a second allowContact does not create a duplicate lead", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId } = await seedOrg(t);
    const { responseId } = await seedRequestWithOffer(t, orgId, userId, "tok-twice");

    await t.mutation(api.marketplaceBuyerActions.allowContact, { publicId: "tok-twice", responseId, buyerPhone: BUYER_PHONE });
    await t.mutation(api.marketplaceBuyerActions.allowContact, { publicId: "tok-twice", responseId, buyerPhone: BUYER_PHONE });

    const leads = await t.run((ctx) => ctx.db.query("leads").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect());
    expect(leads).toHaveLength(1);
  });
});

describe("acceptOffer", () => {
  test("accepts the offer, marks the request ACCEPTED, and creates the lead", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId } = await seedOrg(t);
    const { requestId, responseId } = await seedRequestWithOffer(t, orgId, userId, "tok-accept");

    await t.mutation(api.marketplaceBuyerActions.acceptOffer, {
      publicId: "tok-accept",
      responseId,
      buyerPhone: BUYER_PHONE,
    });

    expect((await t.run((ctx) => ctx.db.get(responseId)))?.buyerAction).toBe("ACCEPTED");
    expect((await t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("ACCEPTED");
    const leads = await t.run((ctx) => ctx.db.query("leads").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect());
    expect(leads).toHaveLength(1);
  });

  test("writes offer.accepted and contact.unlocked events", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId } = await seedOrg(t);
    const { requestId, responseId } = await seedRequestWithOffer(t, orgId, userId, "tok-events");

    await t.mutation(api.marketplaceBuyerActions.acceptOffer, { publicId: "tok-events", responseId, buyerPhone: BUYER_PHONE });

    const events = await t.run((ctx) =>
      ctx.db.query("marketplaceEvents").withIndex("by_request", (q) => q.eq("requestId", requestId)).collect()
    );
    const names = events.map((e) => e.event);
    expect(names).toContain("offer.accepted");
    expect(names).toContain("contact.unlocked");
  });
});
