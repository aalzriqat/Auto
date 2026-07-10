import { convexTest } from "convex-test";
import { expect, test, describe, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;

beforeEach(() => {
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
});

afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
});

async function seedRequestWithMatch(t: ReturnType<typeof convexTest>) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Dealer Org", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("marketplaceDealerProfiles", {
      orgId,
      isOptedIn: true,
      areas: [],
      brandsCarried: [],
      whatsappNumber: "+962791111111",
      badges: [],
      totalResponses: 0,
      totalAccepted: 0,
      tier: "FREE_FOUNDING",
      leadsUsedThisPeriod: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const requestId = await t.run((ctx) =>
    ctx.db.insert("marketplaceRequests", {
      status: "MATCHED",
      buyerFirstName: "Sami",
      buyerPhone: "+962791234567",
      buyerCity: "Amman",
      paymentType: "CASH",
      buyerTimeframe: "ASAP",
      buyerIntent: "WARM",
      consentAcceptedAt: Date.now(),
      clientFingerprint: "fp-1",
      expiresAt: Date.now() + 100000,
      createdAt: Date.now(),
    })
  );
  const matchId = await t.run((ctx) =>
    ctx.db.insert("marketplaceRequestMatches", { requestId, orgId, matchedAt: Date.now() })
  );

  await t.run((ctx) => ctx.db.insert("users", { clerkId: "dev_1", email: "admin@autoflow.dev" }));
  await t.run((ctx) => ctx.db.insert("users", { clerkId: "member_1", email: "member@dealer.com" }));

  return { orgId, requestId, matchId, asAdmin: t.withIdentity({ subject: "dev_1" }), asMember: t.withIdentity({ subject: "member_1" }) };
}

describe("adminMarketplace", () => {
  test("listRequests rejects a non-super-admin caller", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asMember } = await seedRequestWithMatch(t);
    await expect(asMember.query(api.adminMarketplace.listRequests, {})).rejects.toThrow();
  });

  test("listRequests enriches matches with dealer name and WhatsApp number", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asAdmin } = await seedRequestWithMatch(t);

    const requests = await asAdmin.query(api.adminMarketplace.listRequests, {});
    expect(requests).toHaveLength(1);
    expect(requests[0].matches).toHaveLength(1);
    expect(requests[0].matches[0]).toMatchObject({
      dealerName: "Dealer Org",
      whatsappNumber: "+962791111111",
      notifiedAt: null,
    });
  });

  test("markMatchNotified stamps notifiedAt/notifiedVia and writes an audit log", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asAdmin, matchId, orgId } = await seedRequestWithMatch(t);

    await asAdmin.mutation(api.adminMarketplace.markMatchNotified, { matchId });

    const match = await t.run((ctx) => ctx.db.get(matchId));
    expect(match?.notifiedVia).toBe("WHATSAPP_MANUAL");
    expect(match?.notifiedAt).toBeTypeOf("number");

    const auditRows = await t.run((ctx) => ctx.db.query("adminAuditLog").collect());
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ action: "marketplaceMarkMatchNotified", orgId });
  });

  test("markSpam sets status to SPAM and rejects a non-super-admin caller", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asAdmin, asMember, requestId } = await seedRequestWithMatch(t);

    await expect(asMember.mutation(api.adminMarketplace.markSpam, { requestId })).rejects.toThrow();

    await asAdmin.mutation(api.adminMarketplace.markSpam, { requestId });
    const request = await t.run((ctx) => ctx.db.get(requestId));
    expect(request?.status).toBe("SPAM");
  });
});
