import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const MODULES = import.meta.glob("./**/*.ts");

/**
 * The real rate-limiter component is registered here rather than stubbed with
 * `vi.mock("./rateLimit")` (the pattern most suites use) precisely because the
 * defect under test lives in the bucket configuration: a mocked limiter that
 * always answers `{ ok: true }` cannot tell a per-recipient bucket from one
 * shared by the entire deployment, which is exactly how the unkeyed `email`
 * bucket survived for as long as it did.
 *
 * RESEND_API_KEY is deliberately left unset (see vitest.config.ts), so every
 * send takes the built-in mock path and no test here touches the network. That
 * path still runs the rate limiter first, which is the whole point.
 */
function setup() {
  const t = convexTestWithComponents(schema, MODULES);
  registerRateLimiter(t);
  return t;
}

const NOTIFICATION_ARGS = { locale: "en", type: "lead.assigned", data: { leadName: "Dana" } } as const;

/** Drains `address`'s bulk-email budget, returning how many sends were refused. */
async function drainBulkBudget(t: ReturnType<typeof setup>, address: string): Promise<number> {
  let dropped = 0;
  for (let i = 0; i < 30; i += 1) {
    const r = await t.action(internal.email.sendNotificationEmail, {
      toEmail: address,
      ...NOTIFICATION_ARGS,
    });
    if (!r.success && r.error === "rate_limited") dropped += 1;
  }
  return dropped;
}

function seedOrg(t: ReturnType<typeof setup>, name: string): Promise<Id<"organizations">> {
  return t.run((ctx) => ctx.db.insert("organizations", { name, createdAt: Date.now() }));
}

const WEEKLY_REPORT_STATS = {
  pageViews: 10,
  vehicleDetailViews: 4,
  requestsMatched: 2,
  responsesSent: 1,
  avgResponseMinutes: 12,
  mostViewedVehicle: null,
  requestsLost: 0,
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("outbound email rate limiting is keyed, not deployment-wide", () => {
  test("one recipient draining the bulk budget does not starve anybody else", async () => {
    const t = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const dropped = await drainBulkBudget(t, "busy@dealer.test");
    // Sanity: the first recipient really did exhaust their own bucket.
    expect(dropped).toBeGreaterThan(0);

    // The whole point. Against a single unkeyed deployment-wide bucket, the
    // second recipient is starved by the first one's traffic and gets nothing.
    const forSomeoneElse = await t.action(internal.email.sendNotificationEmail, {
      toEmail: "quiet@other-dealer.test",
      ...NOTIFICATION_ARGS,
    });
    expect(forSomeoneElse).toMatchObject({ success: true });
  });

  test("addresses are normalized, so casing and stray whitespace don't mint a fresh budget", async () => {
    const t = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await drainBulkBudget(t, "busy@dealer.test")).toBeGreaterThan(0);

    const viaVariant = await t.action(internal.email.sendNotificationEmail, {
      toEmail: "  BUSY@Dealer.TEST ",
      ...NOTIFICATION_ARGS,
    });
    expect(viaVariant).toMatchObject({ success: false, error: "rate_limited" });
  });

  test("a team invite still goes out to an address whose bulk budget is spent", async () => {
    const t = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await drainBulkBudget(t, "newhire@dealer.test")).toBeGreaterThan(0);

    // Transactional mail deliberately does not share a bucket with automated
    // fan-out: being throttled out of an invite means a colleague cannot join
    // the dealership at all, which is a far worse failure than a late digest.
    await expect(
      t.action(internal.email.sendTeamInvite, {
        toEmail: "newhire@dealer.test",
        orgName: "Bloom Cars",
        inviteToken: "tok_123",
      })
    ).resolves.toMatchObject({ success: true });
  });

  test("the per-org digest bucket isolates tenants from each other", async () => {
    const t = setup();
    const orgA = await seedOrg(t, "Org A");
    const orgB = await seedOrg(t, "Org B");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    let dropped = 0;
    for (let i = 0; i < 30; i += 1) {
      const r = await t.action(internal.email.sendMarketplaceWeeklyReportEmail, {
        orgId: orgA,
        toEmail: "owner@a.test",
        orgName: "Org A",
        ...WEEKLY_REPORT_STATS,
      });
      if (!r.success && r.error === "rate_limited") dropped += 1;
    }
    expect(dropped).toBeGreaterThan(0);

    const forOrgB = await t.action(internal.email.sendMarketplaceWeeklyReportEmail, {
      orgId: orgB,
      toEmail: "owner@b.test",
      orgName: "Org B",
      ...WEEKLY_REPORT_STATS,
    });
    expect(forOrgB).toMatchObject({ success: true });
  });
});

describe("outbound email rate-limit logging", () => {
  test("a drop is logged with the bucket that refused it and never with the address", async () => {
    const t = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await drainBulkBudget(t, "busy@dealer.test")).toBeGreaterThan(0);

    const logged = warn.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("sendNotificationEmail");
    expect(logged).toContain("bucket=emailBulk");
    expect(logged).toContain("retryAfterMs=");
    // Recipient addresses must never reach the function logs — only the
    // correlation digest does.
    expect(logged).not.toContain("busy@dealer.test");
    expect(logged).not.toContain("dealer.test");
  });

  test("an org-keyed drop logs the orgId, which is an internal id and safe to log", async () => {
    const t = setup();
    const orgId = await seedOrg(t, "Org A");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let i = 0; i < 30; i += 1) {
      await t.action(internal.email.sendMarketplaceWeeklyReportEmail, {
        orgId,
        toEmail: "owner@a.test",
        orgName: "Org A",
        ...WEEKLY_REPORT_STATS,
      });
    }

    const logged = warn.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain(`org:${orgId}`);
    expect(logged).not.toContain("owner@a.test");
  });
});

describe("email paths that previously had no limit at all", () => {
  test("upgrade requests are capped per requesting org and surface the refusal to the caller", async () => {
    const t = setup();
    const orgId = await seedOrg(t, "Org A");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const send = () =>
      t.action(internal.email.sendUpgradeRequestEmail, {
        orgName: "Org A",
        orgId,
        currentPlan: "free",
        targetPlan: "pro",
        userName: "Dana",
        userEmail: "dana@a.test",
        phone: "+962790000000",
        message: undefined,
      });

    // Thrown, not returned: requestUpgrade ignores this action's return value,
    // so a returned failure would show the dealer a success toast for an email
    // that was never sent.
    let threwAfter = 0;
    for (let i = 0; i < 20; i += 1) {
      try {
        await send();
      } catch {
        threwAfter = i;
        break;
      }
    }
    expect(threwAfter).toBeGreaterThan(0);
  });

  test("support-inbox notifications are keyed by the external sender, not by our staff inbox", async () => {
    const t = setup();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const notify = (fromEmail: string) =>
      t.action(internal.email.sendSupportInboxNotification, {
        toEmails: ["support-staff@autoflowdealer.com"],
        inbox: "support",
        fromEmail,
        subject: "Help",
        bodyPreview: undefined,
      });

    let dropped = 0;
    for (let i = 0; i < 20; i += 1) {
      const r = await notify("flooder@spam.test");
      if (!r.success && r.error === "rate_limited") dropped += 1;
    }
    expect(dropped).toBeGreaterThan(0);

    // Keying by recipient here would have rebuilt the global bucket exactly:
    // every one of these lands in the same fixed staff inbox.
    await expect(notify("real-customer@dealer.test")).resolves.toMatchObject({ success: true });
  });
});
