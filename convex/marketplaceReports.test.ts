import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { afterEach, expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { vehicleSlug } from "./websiteProjection";
import {
  WEEKLY_REPORT_ORG_PAGE_SIZE,
  WEEKLY_REPORT_PAGE_DELAY_MS,
  deliverWeeklyReportsForOrgs,
} from "./marketplaceReports";

async function seedDealerOrg(t: ReturnType<typeof convexTestWithComponents>, opts?: { name?: string; isOptedIn?: boolean }) {
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
  t: ReturnType<typeof convexTestWithComponents>,
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
  t: ReturnType<typeof convexTestWithComponents>,
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
  t: ReturnType<typeof convexTestWithComponents>,
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

async function seedVehicle(t: ReturnType<typeof convexTestWithComponents>, orgId: Id<"organizations">) {
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
  t: ReturnType<typeof convexTestWithComponents>,
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId } = await seedDealerOrg(t);

    const report = await t.query(internal.marketplaceReports.buildWeeklyReportForOrg, {
      orgId,
      since: Date.now() - ONE_WEEK_MS,
    });
    expect(report).toBeNull();
  });

  test("aggregates matches, responses, response time, page views, and most-viewed vehicle", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
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

type Harness = ReturnType<typeof convexTestWithComponents>;

async function walkRoster(t: Harness): Promise<Id<"organizations">[]> {
  const seen: Id<"organizations">[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const page: { orgIds: Id<"organizations">[]; continueCursor: string; isDone: boolean } = await t.query(
      internal.marketplaceReports.listOptedInDealerOrgIdsPage,
      { cursor }
    );
    seen.push(...page.orgIds);
    if (page.isDone) return seen;
    cursor = page.continueCursor;
  }
  throw new Error("roster walk did not terminate");
}

describe("listOptedInDealerOrgIdsPage", () => {
  test("only returns opted-in, non-deleted dealer orgs", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId: optedInOrgId } = await seedDealerOrg(t, { name: "Opted In" });
    await seedDealerOrg(t, { name: "Opted Out", isOptedIn: false });
    const { orgId: deletedOrgId } = await seedDealerOrg(t, { name: "Deleted" });
    await t.run(async (ctx) => {
      const profiles = await ctx.db.query("marketplaceDealerProfiles").collect();
      const profile = profiles.find((candidate) => candidate.orgId === deletedOrgId);
      await ctx.db.patch(profile!._id, { isDeleted: true });
    });

    expect(await walkRoster(t)).toEqual([optedInOrgId]);
  });

  test("walks a roster larger than one page in order, with no gaps or repeats", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const expected: Id<"organizations">[] = [];
    for (let i = 0; i < WEEKLY_REPORT_ORG_PAGE_SIZE + 3; i++) {
      expected.push((await seedDealerOrg(t, { name: `Dealer ${i}` })).orgId);
    }

    const firstPage = await t.query(internal.marketplaceReports.listOptedInDealerOrgIdsPage, { cursor: null });
    expect(firstPage.orgIds).toHaveLength(WEEKLY_REPORT_ORG_PAGE_SIZE);
    expect(firstPage.isDone).toBe(false);

    expect(await walkRoster(t)).toEqual(expected);
  });
});

describe("deliverWeeklyReportsForOrgs", () => {
  test("a throwing org and a failed send are both counted and do not stop the orgs after them", async () => {
    const orgIds = ["org-a", "org-poison", "org-b", "org-failed", "org-c"] as unknown as Id<"organizations">[];
    const visited: string[] = [];
    const result = await deliverWeeklyReportsForOrgs(orgIds, async (orgId) => {
      const id = String(orgId);
      visited.push(id);
      if (id === "org-poison") throw new Error("boom");
      if (id === "org-failed") return "failed";
      return id === "org-c" ? "skipped" : "sent";
    });
    expect(visited).toEqual(orgIds);
    expect(result).toEqual({ sent: 2, skipped: 1, failed: 2 });
  });
});

describe("sendWeeklyProofReports", () => {
  // The real rate limiter is registered so the email action runs its real
  // (no Resend key => mock-send) path. A send is made to fail the way it does
  // in production: the dealer's own email bucket is exhausted first, so the
  // action returns { success: false, error: "rate_limited" } rather than
  // throwing.
  function setup(): Harness {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    registerRateLimiter(t);
    return t;
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function seedActivity(t: Harness, orgId: Id<"organizations">) {
    const requestId = await seedRequest(t);
    await seedMatch(t, requestId, orgId, { matchedAt: Date.now() });
  }

  /** Sends until the org's emailBulk bucket refuses, so the test does not depend on the bucket's capacity. */
  async function exhaustEmailBucket(t: Harness, orgId: Id<"organizations">) {
    for (let i = 0; i < 100; i++) {
      const delivery = await t.action(internal.email.sendMarketplaceWeeklyReportEmail, {
        orgId,
        toEmail: "drain@dealer.test",
        orgName: "Drain",
        pageViews: 0,
        vehicleDetailViews: 0,
        requestsMatched: 0,
        responsesSent: 0,
        avgResponseMinutes: null,
        mostViewedVehicle: null,
        requestsLost: 0,
      });
      if (delivery.error === "rate_limited") return;
    }
    throw new Error("email bucket never rate-limited");
  }

  /** The cron's own log rows, including crash rows; the email action's per-send rows start with "weekly-report ->". */
  async function pageLogs(t: Harness) {
    const logs = await t.run((ctx) => ctx.db.query("webhookLogs").collect());
    return logs
      .filter((log) => log.source === "marketplace-weekly-report" && !log.summary.startsWith("weekly-report ->"))
      .sort((a, b) => a._creationTime - b._creationTime);
  }

  async function pendingContinuations(t: Harness) {
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    return scheduled.filter(
      (fn) => fn.name.includes("sendWeeklyProofReportsPage") && fn.state.kind === "pending"
    );
  }

  test("reports nothing sent when no dealers are opted in", async () => {
    const t = setup();
    const summary = await t.action(internal.marketplaceReports.sendWeeklyProofReports, {});
    expect(summary).toBe("Sent 0 weekly proof report(s), skipped 0 dealer(s) with no activity.");
  });

  test("a delivered report is counted as sent", async () => {
    const t = setup();
    const { orgId } = await seedDealerOrg(t);
    await seedActivity(t, orgId);

    const summary = await t.action(internal.marketplaceReports.sendWeeklyProofReports, {});

    expect(summary).toBe("Sent 1 weekly proof report(s), skipped 0 dealer(s) with no activity.");
    expect((await pageLogs(t)).map((log) => log.status)).toEqual(["success"]);
  });

  test("a rate-limited send is counted failed, logged as an error, and does not stop other dealers", async () => {
    const t = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await seedDealerOrg(t, { name: "First" });
    const blocked = await seedDealerOrg(t, { name: "Blocked" });
    const last = await seedDealerOrg(t, { name: "Last" });
    for (const { orgId } of [first, blocked, last]) await seedActivity(t, orgId);
    await exhaustEmailBucket(t, blocked.orgId);

    const summary = await t.action(internal.marketplaceReports.sendWeeklyProofReports, {});

    expect(summary).toBe("Sent 2 weekly proof report(s), skipped 0 dealer(s) with no activity. 1 dealer(s) failed.");
    const logs = await pageLogs(t);
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("error");
    expect(logs[0].error).toContain("1 dealer report(s) failed");
    const logged = errors.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain(blocked.orgId);
    expect(logged).toContain("rate_limited");
    expect(logged).not.toContain("dealer.test");
    expect(logged).not.toContain("@test.com");
  });

  const skippedPage = (skipped: number, hasMore: boolean) =>
    `Sent 0 weekly proof report(s), skipped ${skipped} dealer(s) with no activity.` +
    (hasMore ? " More dealers continue in a follow-up run." : "");

  test("handles one page per invocation and defers the successor by the page delay", async () => {
    vi.useFakeTimers();
    const t = setup();
    for (let i = 0; i < WEEKLY_REPORT_ORG_PAGE_SIZE + 3; i++) await seedDealerOrg(t, { name: `Dealer ${i}` });
    const startedAt = Date.now();

    const summary = await t.action(internal.marketplaceReports.sendWeeklyProofReports, {});

    expect(summary).toBe(skippedPage(WEEKLY_REPORT_ORG_PAGE_SIZE, true));
    const pending = await pendingContinuations(t);
    expect(pending).toHaveLength(1);
    expect(pending[0].scheduledTime).toBeGreaterThanOrEqual(startedAt + WEEKLY_REPORT_PAGE_DELAY_MS);
    // Cancel the continuation this test deliberately leaves unrun, so nothing outlives it.
    await t.run(async (ctx) => {
      for (const fn of pending) await ctx.scheduler.cancel(fn._id);
    });
    expect(await pendingContinuations(t)).toHaveLength(0);
  });

  test("covers every opted-in dealer once across continuation pages, one page after another", async () => {
    vi.useFakeTimers();
    const t = setup();
    const total = WEEKLY_REPORT_ORG_PAGE_SIZE * 2 + 4;
    for (let i = 0; i < total; i++) await seedDealerOrg(t, { name: `Dealer ${i}` });

    await t.action(internal.marketplaceReports.sendWeeklyProofReports, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await pageLogs(t)).map((log) => log.summary)).toEqual([
      skippedPage(WEEKLY_REPORT_ORG_PAGE_SIZE, true),
      skippedPage(WEEKLY_REPORT_ORG_PAGE_SIZE, true),
      skippedPage(4, false),
    ]);
    expect(await pendingContinuations(t)).toHaveLength(0);
  });

  test("a failed send on one page does not stop the next page from running", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = setup();
    const { orgId: blockedOrgId } = await seedDealerOrg(t, { name: "Blocked" });
    // 1 blocked + PAGE_SIZE others: page one is full, page two holds exactly one dealer.
    for (let i = 0; i < WEEKLY_REPORT_ORG_PAGE_SIZE; i++) await seedDealerOrg(t, { name: `Dealer ${i}` });
    await seedActivity(t, blockedOrgId);
    await exhaustEmailBucket(t, blockedOrgId);

    await t.action(internal.marketplaceReports.sendWeeklyProofReports, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const logs = await pageLogs(t);
    expect(logs.map((log) => log.status)).toEqual(["error", "success"]);
    expect(logs[0].summary).toContain("1 dealer(s) failed");
    expect(logs[1].summary).toBe(skippedPage(1, false));
  });
});
