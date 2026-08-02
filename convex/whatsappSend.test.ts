import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const MODULES = import.meta.glob("./**/*.ts");

/**
 * Registers the real rate-limiter component rather than stubbing it: the defect
 * under test is the bucket's *configuration*, and a mock that always answers
 * `{ ok: true }` cannot tell a per-org bucket from a deployment-wide one.
 */
function setup() {
  const t = convexTestWithComponents(schema, MODULES);
  registerRateLimiter(t);
  return t;
}

function seedOrg(t: ReturnType<typeof setup>, name: string): Promise<Id<"organizations">> {
  return t.run((ctx) => ctx.db.insert("organizations", { name, createdAt: Date.now() }));
}

const SEND_ARGS = {
  toPhone: "+962790000000",
  locale: "en",
  type: "lead.assigned",
  data: { leadName: "Dana" },
} as const;

/**
 * None of these orgs have WhatsApp credentials configured, so a send that gets
 * past the limiter stops at the settings lookup and reports
 * `whatsapp_not_configured`. That distinction is what the assertions rely on:
 * `whatsapp_not_configured` proves the call cleared the rate limiter,
 * `rate_limited` proves it did not — with no Meta credentials to seed and no
 * network stubbing needed to tell them apart.
 */
const PASSED_THE_LIMITER = { success: false, error: "whatsapp_not_configured" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendNotificationWhatsapp rate limiting", () => {
  test("the bucket is per-org: one dealership draining it does not block another", async () => {
    const t = setup();
    const orgA = await seedOrg(t, "Org A");
    const orgB = await seedOrg(t, "Org B");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    let dropped = 0;
    for (let i = 0; i < 45; i += 1) {
      const r = await t.action(internal.whatsappSend.sendNotificationWhatsapp, {
        orgId: orgA,
        ...SEND_ARGS,
      });
      if (r.error === "rate_limited") dropped += 1;
    }
    // Sanity: org A really did exhaust its own bucket.
    expect(dropped).toBeGreaterThan(0);

    // The whole point. Against a single unkeyed deployment-wide bucket, org B
    // is starved by org A's traffic and every one of its notifications is
    // dropped before it ever reaches the settings lookup.
    const forOrgB = await t.action(internal.whatsappSend.sendNotificationWhatsapp, {
      orgId: orgB,
      ...SEND_ARGS,
    });
    expect(forOrgB).toMatchObject(PASSED_THE_LIMITER);
  });

  test("a drop is logged with the org and type, never with the recipient's phone number", async () => {
    const t = setup();
    const orgId = await seedOrg(t, "Org A");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let i = 0; i < 45; i += 1) {
      await t.action(internal.whatsappSend.sendNotificationWhatsapp, { orgId, ...SEND_ARGS });
    }

    const logged = warn.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("dropped by rate limit");
    expect(logged).toContain(`org=${orgId}`);
    expect(logged).toContain("type=lead.assigned");
    expect(logged).toContain("retryAfterMs=");
    expect(logged).not.toContain(SEND_ARGS.toPhone);
  });
});
