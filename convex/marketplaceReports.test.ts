import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { vehicleSlug } from "./websiteProjection";

async function seedDealerOrg(t: ReturnType<typeof convexTest>, opts?: { name?: string; isOptedIn?: boolean }) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: opts?.name ?? "Dealer Org", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `owner_${orgId}`, email: `owner_${orgId}@test.com`, name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [], isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("marketplaceDealerProfiles", {
      orgId,
      isOptedIn: opts?.isOptedIn ?? true,
      areas: [],
      brandsCarried: [],
      badges: [],
      totalResponses: 0,
      totalAccepted: 0,
      tier: "FREE_FOUNDING",
      leadsUsedThisPeriod: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  return { orgId, userId };
}

async function seedRequest(
  t: ReturnType<typeof convexTest>,
  overrides?: Partial<{ status: "OPEN" | "MATCHED" | "FULFILLED" | "EXPIRED" | "SPAM"; expiresAt: number; buyerPhone: string }>
) {
  return await t.run((ctx) =>
    ctx.db.insert("marketplaceRequests", {
      status: overrides?.status ?? "MATCHED",
      buyerFirstName: "Sami",
      buyerPhone: overrides?.buyerPhone ?? "+962791234567",
      buyerCity: "Amman",
      make: "Toyota",
      model: "Corolla",
      paymentType: "CASH",
      buyerTimeframe: "ASAP",
      buyerIntent: "HOT",
      consentAcceptedAt: Date.now(),
      clientFingerprint: "fp-1",
      expiresAt: overrides?.expiresAt ?? Date.now() + 100000,
      createdAt: Date.now(),
    })
  );
}

async function seedMatch(
  t: ReturnType<typeof convexTest>,
  requestId: Id<"marketplaceRequests">,
  orgId: Id<"organizations">,
  overrides?: Partial<{ matchedAt: number; notifiedAt: number }>
) {
  return await t.run((ctx) =>
    ctx.db.insert("marketplaceRequestMatches", {
      requestId,
      orgId,
      matchedAt: overrides?.matchedAt ?? Date.now(),
      notifiedAt: overrides?.notifiedAt,
    })
  );
}

async function seedResponse(
  t: ReturnType<typeof convexTest>,
  requestId: Id<"marketplaceRequests">,
  orgId: Id<"organizations">,
  userId: Id<"users">,
  overrides?: Partial<{ createdAt: number }>
) {
  return await t.run((ctx) =>
    ctx.db.insert("marketplaceResponses", {
      requestId,
      orgId,
      respondingUserId: userId,
      kind: "HAVE_MATCH",
      createdAt: overrides?.createdAt ?? Date.now(),
    })
  );
}

async function seedVehicle(t: ReturnType<typeof convexTest>, orgId: Id<"organizations">) {
  return await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      make: "Toyota",
      model: "Corolla",
      year: 2020,
      mileage: 50000,
      color: "White",
      fuelType: "Petrol",
      transmission: "Automatic",
      sellingPrice: 15000,
      status: "AVAILABLE",
      isDeleted: false,
    })
  );
}

async function seedPageView(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"organizations">,
  path: string,
  createdAt: number
) {
  await t.run((ctx) =>
    ctx.db.insert("siteVisitorEvents", {
      orgId,
      host: "dealer.example.com",
      visitorId: "visitor-1",
      sessionId: "session-1",
      type: "page_view",
      path,
      trafficSource: "direct",
      createdAt,
    })
  );
}

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

describe("buildWeeklyReportForOrg", () => {
  test("returns null when the org has no matches or responses in the window", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId } = await seedDealerOrg(t);

    const report = await t.query(internal.marketplaceReports.buildWeeklyReportForOrg, {
      orgId,
      since: Date.now() - ONE_WEEK_MS,
    });
    expect(report).toBeNull();
  });

  test("aggregates matches, responses, response time, page views, and most-viewed vehicle", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId } = await seedDealerOrg(t);
    const since = Date.now() - ONE_WEEK_MS;

    const requestId = await seedRequest(t);
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    await seedMatch(t, requestId, orgId, { matchedAt: tenMinutesAgo - 60000, notifiedAt: tenMinutesAgo });
    await seedResponse(t, requestId, orgId, userId, { createdAt: Date.now() });

    const vehicleId = await seedVehicle(t, orgId);
    const vehicle = await t.run((ctx) => ctx.db.get(vehicleId));
    const slug = vehicleSlug(vehicle!);
    await seedPageView(t, orgId, "/", Date.now());
    await seedPageView(t, orgId, `/inventory/${slug}`, Date.now());
    await seedPageView(t, orgId, `/inventory/${slug}`, Date.now());

    const report = await t.query(internal.marketplaceReports.buildWeeklyReportForOrg, { orgId, since });

    expect(report).toMatchObject({
      pageViews: 3,
      vehicleDetailViews: 2,
      requestsMatched: 1,
      responsesSent: 1,
      requestsLost: 0,
    });
    expect(report?.avgResponseMinutes).toBeGreaterThanOrEqual(9.9);
    expect(report?.avgResponseMinutes).toBeLessThanOrEqual(10.1);
    expect(report?.mostViewedVehicle).toMatchObject({ make: "Toyota", model: "Corolla", year: 2020, views: 2 });
  });

  test("counts a match as lost only once its request has expired unanswered inside the window", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId } = await seedDealerOrg(t);
    const since = Date.now() - ONE_WEEK_MS;

    const lostRequestId = await seedRequest(t, { status: "EXPIRED", expiresAt: Date.now() - 1000 });
    await seedMatch(t, lostRequestId, orgId, { matchedAt: since + 1000 });

    const stillOpenRequestId = await seedRequest(t, { status: "MATCHED", expiresAt: Date.now() + 100000 });
    await seedMatch(t, stillOpenRequestId, orgId, { matchedAt: since + 2000 });

    const report = await t.query(internal.marketplaceReports.buildWeeklyReportForOrg, { orgId, since });
    expect(report).toMatchObject({ requestsMatched: 2, responsesSent: 0, requestsLost: 1 });
  });
});

describe("listOptedInDealerOrgIds", () => {
  test("only returns opted-in, non-deleted dealer orgs", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId: optedInOrgId } = await seedDealerOrg(t, { name: "Opted In" });
    await seedDealerOrg(t, { name: "Opted Out", isOptedIn: false });

    const orgIds = await t.query(internal.marketplaceReports.listOptedInDealerOrgIds, {});
    expect(orgIds).toEqual([optedInOrgId]);
  });
});

describe("sendWeeklyProofReports", () => {
  // The email send itself (convex/email.ts) goes through the rate-limiter
  // component, which no test in this suite registers with convex-test yet —
  // same gap as the untested Phase 28 email actions this mirrors. Orchestration
  // (who has a report to send) is covered by buildWeeklyReportForOrg above;
  // this just checks the cron entrypoint runs cleanly with zero opted-in dealers.
  test("reports nothing sent when no dealers are opted in", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const summary = await t.action(internal.marketplaceReports.sendWeeklyProofReports, {});
    expect(summary).toBe("Sent 0 weekly proof report(s), skipped 0 dealer(s) with no activity.");
  });
});
