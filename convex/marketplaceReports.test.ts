import { convexTestWithComponents, registerRateLimiter, registerWeeklyReportWorkpool } from "../test-utils/convexTest";
import { afterEach, beforeAll, beforeEach, expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { vehicleSlug } from "./websiteProjection";
import { WEEKLY_REPORT_ORG_PAGE_SIZE, WEEKLY_SEND_WINDOW_MS } from "./marketplaceReports";

const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

type Harness = ReturnType<typeof convexTestWithComponents>;

async function seedDealerOrg(t: Harness, opts?: { name?: string; isOptedIn?: boolean; withOwner?: boolean }) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: opts?.name ?? "Dealer Org", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `owner_${orgId}`, email: `owner_${orgId}@test.com`, name: "Owner" })
  );
  if (opts?.withOwner !== false) {
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [], isSystemOwnerRole: true })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  }
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
  t: Harness,
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
  t: Harness,
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
  t: Harness,
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

async function seedVehicle(t: Harness, orgId: Id<"organizations">) {
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

async function seedPageView(t: Harness, orgId: Id<"organizations">, path: string, createdAt: number) {
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
      until: Date.now() + 1000,
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

    const until = Date.now() + 1000;
    const report = await t.query(internal.marketplaceReports.buildWeeklyReportForOrg, { orgId, since, until });

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
    expect(report?.lowerBound).toBeUndefined();
    expect(report?.unavailable).toBeUndefined();
  });

  test("counts a match as lost only once its request has expired unanswered inside the window", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId } = await seedDealerOrg(t);
    const since = Date.now() - ONE_WEEK_MS;

    const lostRequestId = await seedRequest(t, { status: "EXPIRED", expiresAt: Date.now() - 1000 });
    await seedMatch(t, lostRequestId, orgId, { matchedAt: since + 1000 });

    const stillOpenRequestId = await seedRequest(t, { status: "MATCHED", expiresAt: Date.now() + 100000 });
    await seedMatch(t, stillOpenRequestId, orgId, { matchedAt: since + 2000 });

    const until = Date.now() + 1000;
    const report = await t.query(internal.marketplaceReports.buildWeeklyReportForOrg, { orgId, since, until });
    expect(report).toMatchObject({ requestsMatched: 2, responsesSent: 0, requestsLost: 1 });
  });

  test("a response in the window answers a match from before the window", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId } = await seedDealerOrg(t);
    const now = Date.now();
    const since = now - ONE_WEEK_MS;

    const requestId = await seedRequest(t);
    // Matched 8 days ago, answered 1 hour after the window opened.
    await seedMatch(t, requestId, orgId, { matchedAt: since - 24 * 60 * 60 * 1000 });
    await seedResponse(t, requestId, orgId, userId, { createdAt: since + 60 * 60 * 1000 });

    const report = await t.query(internal.marketplaceReports.buildWeeklyReportForOrg, { orgId, since, until: now });
    expect(report).toMatchObject({ requestsMatched: 0, responsesSent: 1 });
    expect(report?.avgResponseMinutes).toBe(25 * 60);
  });

  test("a request answered BEFORE the window is not counted as lost when it expires inside it", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId } = await seedDealerOrg(t);
    const now = Date.now();
    const since = now - ONE_WEEK_MS;

    const answered = await seedRequest(t, { status: "EXPIRED", expiresAt: since + 1000 });
    await seedMatch(t, answered, orgId, { matchedAt: since - 3 * 24 * 60 * 60 * 1000 });
    await seedResponse(t, answered, orgId, userId, { createdAt: since - 2 * 24 * 60 * 60 * 1000 });
    // An unrelated in-window match so the report is not null.
    const other = await seedRequest(t);
    await seedMatch(t, other, orgId, { matchedAt: since + 5000 });

    const report = await t.query(internal.marketplaceReports.buildWeeklyReportForOrg, { orgId, since, until: now });
    expect(report?.requestsLost).toBe(0);
  });

  test("rows newer than `until` are excluded and cannot use up a cap", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId } = await seedDealerOrg(t);
    const now = Date.now();
    const since = now - ONE_WEEK_MS;

    const inWindow = await seedRequest(t);
    await seedMatch(t, inWindow, orgId, { matchedAt: now - 1000 });
    await seedPageView(t, orgId, "/", now - 1000);
    // After the frozen window: must not count.
    const later = await seedRequest(t);
    await seedMatch(t, later, orgId, { matchedAt: now + 1000 });
    await seedPageView(t, orgId, "/", now + 1000);

    const report = await t.query(internal.marketplaceReports.buildWeeklyReportForOrg, { orgId, since, until: now });
    expect(report).toMatchObject({ requestsMatched: 1, pageViews: 1 });
  });

  test("the window is [since, until): a row at `since` counts, a row exactly at `until` does not", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId } = await seedDealerOrg(t);
    const until = Date.now();
    const since = until - ONE_WEEK_MS;
    const requestId = await seedRequest(t);
    await seedMatch(t, requestId, orgId, { matchedAt: since });
    await seedMatch(t, requestId, orgId, { matchedAt: until - 1 });
    await seedMatch(t, requestId, orgId, { matchedAt: until });
    await seedPageView(t, orgId, "/", since - 1);
    await seedPageView(t, orgId, "/", until - 1);
    await seedPageView(t, orgId, "/", until);

    const report = await t.query(internal.marketplaceReports.buildWeeklyReportForOrg, { orgId, since, until });

    expect(report).toMatchObject({ requestsMatched: 2, pageViews: 1 });
  });

  test("exactly at the cap is exact; one over is reported as a lower bound and dependents as unavailable", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId } = await seedDealerOrg(t);
    const now = Date.now();
    const since = now - ONE_WEEK_MS;
    const requestId = await seedRequest(t);

    await t.run(async (ctx) => {
      for (let i = 0; i < 200; i++) {
        await ctx.db.insert("marketplaceRequestMatches", { requestId, orgId, matchedAt: since + 1000 + i });
      }
    });
    const exact = await t.query(internal.marketplaceReports.buildWeeklyReportForOrg, { orgId, since, until: now });
    expect(exact?.requestsMatched).toBe(200);
    expect(exact?.lowerBound).toBeUndefined();
    expect(exact?.unavailable).toBeUndefined();

    await t.run((ctx) =>
      ctx.db.insert("marketplaceRequestMatches", { requestId, orgId, matchedAt: since + 5000 })
    );
    const capped = await t.query(internal.marketplaceReports.buildWeeklyReportForOrg, { orgId, since, until: now });
    expect(capped?.requestsMatched).toBe(200);
    expect(capped?.lowerBound).toContain("requestsMatched");
    expect(capped?.unavailable).toEqual(expect.arrayContaining(["avgResponseMinutes", "requestsLost"]));
  });
});

// ─── Weekly automatic email run (SCRUM-807) ──────────────────────────────────

describe("weekly proof report run", () => {
  function setup(): Harness {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    registerRateLimiter(t);
    return t;
  }

  function setupWithPool(): Harness {
    const t = setup();
    registerWeeklyReportWorkpool(t);
    return t;
  }

  // convex-test imports each Convex module lazily the first time a scheduled
  // function reaches it. That import is real I/O, which fake-timer pumps do not
  // advance, so the FIRST drain in a cold file can spend all its pumps waiting
  // on it (Workpool then reports running:1 / completed:0 forever). Loading the
  // modules the run touches up front makes every drain pure timer work.
  beforeAll(async () => {
    await Promise.all([import("./marketplaceReports"), import("./email"), import("./adminSystem")]);
  });

  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key_not_real");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    resendSend.mockReset();
    resendSend.mockResolvedValue({ data: { id: "em_1" }, error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const providerError = (name: string, statusCode: number | null) => ({
    data: null,
    error: { name, statusCode, message: "refused" },
  });

  // Activity strictly BEFORE the run's cutoff. The window is [since, until) and
  // `until` is Date.now() at run start; under fake timers the clock is frozen,
  // so a match stamped Date.now() equals `until` and is correctly excluded.
  async function seedActivity(t: Harness, orgId: Id<"organizations">) {
    const requestId = await seedRequest(t);
    await seedMatch(t, requestId, orgId, { matchedAt: Date.now() - 1000 });
  }

  async function deliveries(t: Harness) {
    return await t.run((ctx) => ctx.db.query("marketplaceWeeklyReportDeliveries").take(500));
  }
  async function runs(t: Harness) {
    return await t.run((ctx) => ctx.db.query("marketplaceWeeklyReportRuns").take(50));
  }
  async function cronLogs(t: Harness) {
    const logs = await t.run((ctx) => ctx.db.query("webhookLogs").take(500));
    return logs.filter((log) => log.source === "marketplace-weekly-report" && !log.summary.startsWith("weekly-report ->"));
  }
  async function drain(t: Harness) {
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }

  // Direct-state fixtures, for the mutations that must hold under states the
  // happy path never reaches.
  async function insertRun(
    t: Harness,
    status: Doc<"marketplaceWeeklyReportRuns">["status"],
    extra: Partial<Omit<Doc<"marketplaceWeeklyReportRuns">, "_id" | "_creationTime" | "status">> = {}
  ) {
    const now = Date.now();
    return await t.run((ctx) =>
      ctx.db.insert("marketplaceWeeklyReportRuns", {
        weekKey: now,
        runStartedAt: now,
        since: now - ONE_WEEK_MS,
        until: now,
        status,
        cursor: null,
        ...extra,
      })
    );
  }
  async function insertDelivery(
    t: Harness,
    runId: Id<"marketplaceWeeklyReportRuns">,
    orgId: Id<"organizations">,
    state: Doc<"marketplaceWeeklyReportDeliveries">["state"],
    extra: Partial<Omit<Doc<"marketplaceWeeklyReportDeliveries">, "_id" | "_creationTime" | "runId" | "orgId" | "state">> = {}
  ) {
    const now = Date.now();
    return await t.run((ctx) =>
      ctx.db.insert("marketplaceWeeklyReportDeliveries", {
        runId,
        orgId,
        state,
        idempotencyKey: `mpw:test:${orgId}`,
        attempts: 0,
        anyAttemptAmbiguous: false,
        createdAt: now,
        updatedAt: now,
        ...extra,
      })
    );
  }
  const ENVELOPE = { from: "AutoFlow <a@b.test>", to: "o@b.test", subject: "s", html: "<p>frozen</p>" };

  test("a second start in the same week creates no second run and no second set of sends", async () => {
    vi.useFakeTimers();
    const t = setupWithPool();
    const { orgId } = await seedDealerOrg(t);
    await seedActivity(t, orgId);

    await t.mutation(internal.marketplaceReports.sendWeeklyProofReports, {});
    const second = await t.mutation(internal.marketplaceReports.sendWeeklyProofReports, {});
    await drain(t);

    expect(second).toContain("already exists");
    expect(await runs(t)).toHaveLength(1);
    expect(await deliveries(t)).toHaveLength(1);
    expect(resendSend).toHaveBeenCalledTimes(1);
  });

  test("end to end: activity is sent with a stable idempotency key, a quiet dealer is skipped, an unaddressable active dealer fails, run completes", async () => {
    vi.useFakeTimers();
    const t = setupWithPool();
    const active = await seedDealerOrg(t, { name: "Active" });
    const quiet = await seedDealerOrg(t, { name: "Quiet" });
    const noOwner = await seedDealerOrg(t, { name: "No Owner", withOwner: false });
    await seedActivity(t, active.orgId);
    await seedActivity(t, noOwner.orgId);

    await t.mutation(internal.marketplaceReports.sendWeeklyProofReports, {});
    await drain(t);

    const rows = await deliveries(t);
    const byOrg = new Map(rows.map((row) => [row.orgId, row]));
    expect(byOrg.get(active.orgId)?.state).toBe("ACCEPTED");
    expect(byOrg.get(active.orgId)?.providerEmailId).toBe("em_1");
    expect(byOrg.get(quiet.orgId)?.state).toBe("SKIPPED");
    expect(byOrg.get(noOwner.orgId)).toMatchObject({ state: "FAILED_TERMINAL", errorName: "missing_recipient" });

    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(resendSend.mock.calls[0][1]).toMatchObject({ idempotencyKey: byOrg.get(active.orgId)?.idempotencyKey });
    expect((await runs(t))[0].status).toBe("COMPLETE");
    // An unsent active report is a failure, so the run is not logged as success.
    expect((await cronLogs(t)).map((log) => log.status)).toEqual(["error"]);
  });

  test("a roster larger than one page is produced completely, once per dealer", async () => {
    vi.useFakeTimers();
    const t = setupWithPool();
    const total = WEEKLY_REPORT_ORG_PAGE_SIZE * 2 + 4;
    for (let i = 0; i < total; i++) await seedDealerOrg(t, { name: `Dealer ${i}` });

    await t.mutation(internal.marketplaceReports.sendWeeklyProofReports, {});
    await drain(t);

    const rows = await deliveries(t);
    expect(rows).toHaveLength(total);
    expect(new Set(rows.map((row) => row.orgId)).size).toBe(total);
    expect((await runs(t))[0].status).toBe("COMPLETE");
  });

  test("a stale or duplicate producer exits without advancing the roster or inserting rows", async () => {
    const t = setupWithPool();
    await seedDealerOrg(t);
    const runId = await insertRun(t, "PRODUCING", { cursor: "cursor-A" });

    await t.mutation(internal.marketplaceReports.produceWeeklyDeliveries, { runId, expectedCursor: null });
    await t.mutation(internal.marketplaceReports.produceWeeklyDeliveries, { runId, expectedCursor: "cursor-B" });

    expect(await deliveries(t)).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.get(runId)))?.cursor).toBe("cursor-A");
  });

  test("a producer that has produced everything marks the run PRODUCED, not COMPLETE, while rows are non-terminal", async () => {
    const t = setupWithPool();
    await seedDealerOrg(t);
    const runId = await insertRun(t, "PRODUCING");

    await t.mutation(internal.marketplaceReports.produceWeeklyDeliveries, { runId, expectedCursor: null });

    expect((await deliveries(t))[0].state).toBe("PENDING");
    expect((await t.run((ctx) => ctx.db.get(runId)))?.status).toBe("PRODUCED");
  });

  test("a run is not COMPLETE while another delivery is still non-terminal", async () => {
    const t = setupWithPool();
    const a = await seedDealerOrg(t, { name: "A" });
    const b = await seedDealerOrg(t, { name: "B" });
    const runId = await insertRun(t, "PRODUCED");
    const sending = await insertDelivery(t, runId, a.orgId, "SENDING", { envelope: ENVELOPE, attempts: 1, firstAttemptAt: Date.now() });
    await insertDelivery(t, runId, b.orgId, "FROZEN", { envelope: ENVELOPE });

    await t.mutation(internal.marketplaceReports.recordWeeklySendOutcome, {
      deliveryId: sending,
      outcome: "accepted",
      retryable: false,
      providerEmailId: "em_9",
    });

    expect((await t.run((ctx) => ctx.db.get(sending)))?.state).toBe("ACCEPTED");
    expect((await t.run((ctx) => ctx.db.get(runId)))?.status).toBe("PRODUCED");
  });

  test("freezing stores the complete envelope and later source changes do not alter what is sent", async () => {
    vi.useFakeTimers();
    const t = setupWithPool();
    const { orgId } = await seedDealerOrg(t, { name: "Frozen Cars" });
    await seedActivity(t, orgId);
    const runId = await insertRun(t, "PRODUCED");
    const deliveryId = await insertDelivery(t, runId, orgId, "PENDING");

    await t.mutation(internal.marketplaceReports.freezeWeeklyDelivery, { deliveryId });
    const frozen = await t.run((ctx) => ctx.db.get(deliveryId));
    expect(frozen?.state).toBe("FROZEN");
    expect(frozen?.envelope?.html).toContain("Frozen Cars");

    // More activity and a renamed org after the freeze must not reach the send.
    await seedActivity(t, orgId);
    await t.run((ctx) => ctx.db.patch(orgId, { name: "Renamed" }));
    const gate = await t.mutation(internal.marketplaceReports.beginWeeklySend, { deliveryId });

    expect(gate.go).toBe(true);
    if (gate.go) {
      expect(gate.send.html).toBe(frozen?.envelope?.html);
      expect(gate.send.html).not.toContain("Renamed");
      expect(gate.send.idempotencyKey).toBe(frozen?.idempotencyKey);
    }
  });

  test("a definite refusal ends FAILED_TERMINAL after one provider call and is not retried", async () => {
    vi.useFakeTimers();
    resendSend.mockResolvedValue(providerError("validation_error", 422));
    const t = setupWithPool();
    const { orgId } = await seedDealerOrg(t);
    await seedActivity(t, orgId);

    await t.mutation(internal.marketplaceReports.sendWeeklyProofReports, {});
    await drain(t);

    expect((await deliveries(t))[0].state).toBe("FAILED_TERMINAL");
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect((await cronLogs(t)).map((log) => log.status)).toEqual(["error"]);
  });

  test("an ambiguous first answer is retried under the SAME key and the ambiguity is remembered", async () => {
    vi.useFakeTimers();
    resendSend
      .mockResolvedValueOnce(providerError("application_error", 500))
      .mockResolvedValue({ data: { id: "em_2" }, error: null });
    const t = setupWithPool();
    const { orgId } = await seedDealerOrg(t);
    await seedActivity(t, orgId);

    await t.mutation(internal.marketplaceReports.sendWeeklyProofReports, {});
    await drain(t);

    const row = (await deliveries(t))[0];
    expect(row.state).toBe("ACCEPTED");
    expect(row.anyAttemptAmbiguous).toBe(true);
    expect(resendSend).toHaveBeenCalledTimes(2);
    expect(resendSend.mock.calls[1][1].idempotencyKey).toBe(resendSend.mock.calls[0][1].idempotencyKey);
  });

  test("a definite refusal after an ambiguous attempt is AMBIGUOUS, never FAILED_TERMINAL", async () => {
    const t = setupWithPool();
    const { orgId } = await seedDealerOrg(t);
    const runId = await insertRun(t, "PRODUCED");
    const deliveryId = await insertDelivery(t, runId, orgId, "SENDING", {
      envelope: ENVELOPE,
      attempts: 2,
      firstAttemptAt: Date.now(),
      anyAttemptAmbiguous: true,
    });

    await t.mutation(internal.marketplaceReports.recordWeeklySendOutcome, {
      deliveryId,
      outcome: "rejected",
      retryable: false,
      errorName: "validation_error",
    });

    expect((await t.run((ctx) => ctx.db.get(deliveryId)))?.state).toBe("AMBIGUOUS");
  });

  test("a retry attempt starting after an ambiguous one marks the row sticky-ambiguous", async () => {
    const t = setupWithPool();
    const { orgId } = await seedDealerOrg(t);
    const runId = await insertRun(t, "PRODUCED");
    const deliveryId = await insertDelivery(t, runId, orgId, "SENDING", {
      envelope: ENVELOPE,
      attempts: 1,
      firstAttemptAt: Date.now(),
      errorClass: "ambiguous",
    });

    await t.mutation(internal.marketplaceReports.beginWeeklySend, { deliveryId });

    expect((await t.run((ctx) => ctx.db.get(deliveryId)))?.anyAttemptAmbiguous).toBe(true);
  });

  test("a rejected-and-retryable answer (429) does not make the row ambiguous", async () => {
    const t = setupWithPool();
    const { orgId } = await seedDealerOrg(t);
    const runId = await insertRun(t, "PRODUCED");
    const deliveryId = await insertDelivery(t, runId, orgId, "SENDING", {
      envelope: ENVELOPE,
      attempts: 1,
      firstAttemptAt: Date.now(),
      errorClass: "rejected",
      errorName: "rate_limit_exceeded",
    });

    await t.mutation(internal.marketplaceReports.beginWeeklySend, { deliveryId });

    expect((await t.run((ctx) => ctx.db.get(deliveryId)))?.anyAttemptAmbiguous).toBe(false);
  });

  test("no attempt starts after the 23h idempotency-safe window; the row ends AMBIGUOUS", async () => {
    const t = setupWithPool();
    const { orgId } = await seedDealerOrg(t);
    const runId = await insertRun(t, "PRODUCED");
    const deliveryId = await insertDelivery(t, runId, orgId, "SENDING", {
      envelope: ENVELOPE,
      attempts: 3,
      firstAttemptAt: Date.now() - WEEKLY_SEND_WINDOW_MS - 1000,
      errorClass: "ambiguous",
    });

    const gate = await t.mutation(internal.marketplaceReports.beginWeeklySend, { deliveryId });

    expect(gate.go).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(deliveryId)))?.state).toBe("AMBIGUOUS");
  });

  test("without a Resend key the delivery is MOCK, never counted as accepted, and the run is not logged as success", async () => {
    vi.useFakeTimers();
    vi.stubEnv("RESEND_API_KEY", undefined);
    const t = setupWithPool();
    const { orgId } = await seedDealerOrg(t);
    await seedActivity(t, orgId);

    await t.mutation(internal.marketplaceReports.sendWeeklyProofReports, {});
    await drain(t);

    expect((await deliveries(t))[0].state).toBe("MOCK");
    expect(resendSend).not.toHaveBeenCalled();
    expect((await cronLogs(t)).map((log) => log.status)).toEqual(["error"]);
  });

  test("cancel: a frozen row that never reached the provider ends CANCELED and is not sent", async () => {
    const t = setupWithPool();
    const { orgId } = await seedDealerOrg(t);
    const runId = await insertRun(t, "PRODUCED");
    const deliveryId = await insertDelivery(t, runId, orgId, "FROZEN", { envelope: ENVELOPE });

    await t.mutation(internal.marketplaceReports.cancelWeeklyRun, { runId });
    const gate = await t.mutation(internal.marketplaceReports.beginWeeklySend, { deliveryId });

    expect(gate.go).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(deliveryId)))?.state).toBe("CANCELED");
    expect(resendSend).not.toHaveBeenCalled();
  });

  test("cancel: a row already SENDING after an ambiguous attempt is not relabelled CANCELED", async () => {
    const t = setupWithPool();
    const { orgId } = await seedDealerOrg(t);
    const runId = await insertRun(t, "PRODUCED");
    const deliveryId = await insertDelivery(t, runId, orgId, "SENDING", {
      envelope: ENVELOPE,
      attempts: 1,
      firstAttemptAt: Date.now(),
      errorClass: "ambiguous",
    });

    await t.mutation(internal.marketplaceReports.cancelWeeklyRun, { runId });
    await t.mutation(internal.marketplaceReports.beginWeeklySend, { deliveryId });

    expect((await t.run((ctx) => ctx.db.get(deliveryId)))?.state).toBe("AMBIGUOUS");
  });

  test("a producer that is stopped by cancel inserts nothing", async () => {
    const t = setupWithPool();
    await seedDealerOrg(t);
    const runId = await insertRun(t, "PRODUCING");
    await t.mutation(internal.marketplaceReports.cancelWeeklyRun, { runId });

    await t.mutation(internal.marketplaceReports.produceWeeklyDeliveries, { runId, expectedCursor: null });

    expect(await deliveries(t)).toHaveLength(0);
  });

  test("a late or duplicate outcome cannot move a settled delivery", async () => {
    const t = setupWithPool();
    const { orgId } = await seedDealerOrg(t);
    const runId = await insertRun(t, "PRODUCED");
    const deliveryId = await insertDelivery(t, runId, orgId, "ACCEPTED", { envelope: ENVELOPE, providerEmailId: "em_1" });

    const answer = await t.mutation(internal.marketplaceReports.recordWeeklySendOutcome, {
      deliveryId,
      outcome: "rejected",
      retryable: false,
      errorName: "validation_error",
    });

    expect(answer).toBe("done");
    expect((await t.run((ctx) => ctx.db.get(deliveryId)))?.state).toBe("ACCEPTED");
  });

  test("a freeze that really throws ends that dealer FAILED_TERMINAL (freeze_failed), is not retried, and does not stop later dealers or the run", async () => {
    vi.useFakeTimers();
    const t = setupWithPool();
    const failing = await seedDealerOrg(t, { name: "Failing" });
    const quiet = await seedDealerOrg(t, { name: "Quiet" });
    await seedActivity(t, failing.orgId);
    // Rendering reads the validated env, so an invalid app URL makes the freeze
    // MUTATION throw after the report was computed. A quiet dealer returns before
    // rendering and is unaffected.
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "not-a-url");

    await t.mutation(internal.marketplaceReports.sendWeeklyProofReports, {});
    await drain(t);

    const byOrg = new Map((await deliveries(t)).map((row) => [row.orgId, row]));
    expect(byOrg.get(failing.orgId)).toMatchObject({ state: "FAILED_TERMINAL", errorName: "freeze_failed" });
    expect(byOrg.get(failing.orgId)?.attempts).toBe(0);
    expect(byOrg.get(quiet.orgId)?.state).toBe("SKIPPED");
    expect(resendSend).not.toHaveBeenCalled();
    expect((await runs(t))[0].status).toBe("COMPLETE");
    expect((await cronLogs(t)).map((log) => log.status)).toEqual(["error"]);
  });

  test("an active dealer whose report cannot be addressed is FAILED_TERMINAL, not skipped, and the run is not logged as success", async () => {
    vi.useFakeTimers();
    const t = setupWithPool();
    const noOwner = await seedDealerOrg(t, { name: "No Owner", withOwner: false });
    await seedActivity(t, noOwner.orgId);

    await t.mutation(internal.marketplaceReports.sendWeeklyProofReports, {});
    await drain(t);

    expect((await deliveries(t))[0]).toMatchObject({ state: "FAILED_TERMINAL", errorName: "missing_recipient" });
    expect((await cronLogs(t)).map((log) => log.status)).toEqual(["error"]);
  });

  // Reconciliation: `weeklyItemDone` is called directly with Workpool's callback
  // arguments, so each failed/canceled shape is exercised on a known row state.
  describe("weeklyItemDone reconciliation", () => {
    const WORK_ID = "work_1";
    const failed = { kind: "failed", error: "boom" } as const;
    const canceled = { kind: "canceled" } as const;

    function done(
      t: Harness,
      context: { kind: "producer" | "freeze" | "send"; runId: Id<"marketplaceWeeklyReportRuns">; deliveryId?: Id<"marketplaceWeeklyReportDeliveries"> },
      result: typeof failed | typeof canceled
    ) {
      return t.mutation(internal.marketplaceReports.weeklyItemDone, { workId: WORK_ID, context, result });
    }
    const stateOf = async (t: Harness, id: Id<"marketplaceWeeklyReportDeliveries">) =>
      (await t.run((ctx) => ctx.db.get(id)))?.state;

    test("a failed producer marks a PRODUCING run STALLED and logs an error", async () => {
      const t = setupWithPool();
      const runId = await insertRun(t, "PRODUCING");

      await done(t, { kind: "producer", runId }, failed);

      expect((await t.run((ctx) => ctx.db.get(runId)))?.status).toBe("STALLED");
      expect((await cronLogs(t)).map((log) => log.status)).toEqual(["error"]);
    });

    test("a failed producer does not disturb a run that already finished producing", async () => {
      const t = setupWithPool();
      const runId = await insertRun(t, "PRODUCED");

      await done(t, { kind: "producer", runId }, failed);

      expect((await t.run((ctx) => ctx.db.get(runId)))?.status).toBe("PRODUCED");
    });

    test("a failed send item whose row is still FROZEN is FAILED_TERMINAL send_not_started, not CANCELED", async () => {
      const t = setupWithPool();
      const { orgId } = await seedDealerOrg(t);
      const runId = await insertRun(t, "PRODUCED");
      const deliveryId = await insertDelivery(t, runId, orgId, "FROZEN", { envelope: ENVELOPE });

      await done(t, { kind: "send", runId, deliveryId }, failed);

      const row = await t.run((ctx) => ctx.db.get(deliveryId));
      expect(row).toMatchObject({ state: "FAILED_TERMINAL", errorName: "send_not_started" });
    });

    test("a canceled send item whose row never reached the provider is CANCELED", async () => {
      const t = setupWithPool();
      const { orgId } = await seedDealerOrg(t);
      const runId = await insertRun(t, "PRODUCED");
      const deliveryId = await insertDelivery(t, runId, orgId, "FROZEN", { envelope: ENVELOPE });

      await done(t, { kind: "send", runId, deliveryId }, canceled);

      expect(await stateOf(t, deliveryId)).toBe("CANCELED");
    });

    test("a failed freeze item is found by its work id (batch context) and ends freeze_failed", async () => {
      const t = setupWithPool();
      const { orgId } = await seedDealerOrg(t);
      const runId = await insertRun(t, "PRODUCED");
      const deliveryId = await insertDelivery(t, runId, orgId, "PENDING", { freezeWorkId: WORK_ID });

      await done(t, { kind: "freeze", runId }, failed);

      const row = await t.run((ctx) => ctx.db.get(deliveryId));
      expect(row).toMatchObject({ state: "FAILED_TERMINAL", errorName: "freeze_failed" });
    });

    test("a canceled freeze item ends CANCELED", async () => {
      const t = setupWithPool();
      const { orgId } = await seedDealerOrg(t);
      const runId = await insertRun(t, "PRODUCED");
      const deliveryId = await insertDelivery(t, runId, orgId, "PENDING", { freezeWorkId: WORK_ID });

      await done(t, { kind: "freeze", runId }, canceled);

      expect(await stateOf(t, deliveryId)).toBe("CANCELED");
    });

    test("a send item that failed while SENDING settles by the ambiguity rule: AMBIGUOUS after an uncertain attempt", async () => {
      const t = setupWithPool();
      const { orgId } = await seedDealerOrg(t);
      const runId = await insertRun(t, "PRODUCED");
      const deliveryId = await insertDelivery(t, runId, orgId, "SENDING", {
        envelope: ENVELOPE,
        attempts: 4,
        firstAttemptAt: Date.now(),
        errorClass: "ambiguous",
      });

      await done(t, { kind: "send", runId, deliveryId }, failed);

      expect(await stateOf(t, deliveryId)).toBe("AMBIGUOUS");
    });

    test("a send item that failed while SENDING on a definite refusal with no earlier uncertainty is FAILED_TERMINAL", async () => {
      const t = setupWithPool();
      const { orgId } = await seedDealerOrg(t);
      const runId = await insertRun(t, "PRODUCED");
      const deliveryId = await insertDelivery(t, runId, orgId, "SENDING", {
        envelope: ENVELOPE,
        attempts: 4,
        firstAttemptAt: Date.now(),
        errorClass: "rejected",
        errorName: "rate_limit_exceeded",
      });

      await done(t, { kind: "send", runId, deliveryId }, failed);

      expect(await stateOf(t, deliveryId)).toBe("FAILED_TERMINAL");
    });

    test("a refusal after an earlier uncertain attempt stays AMBIGUOUS when retries are exhausted", async () => {
      const t = setupWithPool();
      const { orgId } = await seedDealerOrg(t);
      const runId = await insertRun(t, "PRODUCED");
      const deliveryId = await insertDelivery(t, runId, orgId, "SENDING", {
        envelope: ENVELOPE,
        attempts: 4,
        firstAttemptAt: Date.now(),
        errorClass: "rejected",
        errorName: "rate_limit_exceeded",
        anyAttemptAmbiguous: true,
      });

      await done(t, { kind: "send", runId, deliveryId }, failed);

      expect(await stateOf(t, deliveryId)).toBe("AMBIGUOUS");
    });

    test("a callback for a row that is already settled changes nothing", async () => {
      const t = setupWithPool();
      const { orgId } = await seedDealerOrg(t);
      const runId = await insertRun(t, "PRODUCED");
      const deliveryId = await insertDelivery(t, runId, orgId, "ACCEPTED", { envelope: ENVELOPE });

      await done(t, { kind: "send", runId, deliveryId }, failed);

      expect(await stateOf(t, deliveryId)).toBe("ACCEPTED");
    });

    test("reconciling the last non-terminal row completes the run", async () => {
      const t = setupWithPool();
      const { orgId } = await seedDealerOrg(t);
      const runId = await insertRun(t, "PRODUCED");
      const deliveryId = await insertDelivery(t, runId, orgId, "FROZEN", { envelope: ENVELOPE });

      await done(t, { kind: "send", runId, deliveryId }, failed);

      expect((await t.run((ctx) => ctx.db.get(runId)))?.status).toBe("COMPLETE");
    });
  });
});
