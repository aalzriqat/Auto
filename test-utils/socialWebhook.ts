import { convexTestWithComponents } from "./convexTest";
import { vi, beforeAll, beforeEach, afterEach } from "vitest";
import schema from "../convex/schema";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { aggregateTriggers } from "../convex/aggregates";
import { wrapOwnNumberDB } from "../convex/utils/socialOwnNumberWrites";

/**
 * Shared fixtures for signed Meta webhook tests through the real HTTP routes.
 * Graph requests and delivery sends are stubbed; intake and persistence run.
 */

vi.mock("../convex/rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

vi.mock("../convex/utils/facebookApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../convex/utils/facebookApi")>();
  return {
    ...actual,
    postCommentReply: vi.fn().mockResolvedValue({ ok: true }),
    postDirectMessage: vi.fn().mockResolvedValue({ ok: true }),
  };
});

vi.mock("../convex/utils/instagramApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../convex/utils/instagramApi")>();
  return {
    ...actual,
    postCommentReply: vi.fn().mockResolvedValue({ ok: true }),
    postDirectMessage: vi.fn().mockResolvedValue({ ok: true }),
  };
});

const FB_SECRET = "fb_test_app_secret";
const IG_SECRET = "ig_test_app_secret";
export const PAGE_ID = "page_business_1";
export const IG_WEBHOOK_ID = "ig_webhook_1";
export const IG_BUSINESS_ID = "ig_business_1";

export type T = ReturnType<typeof convexTestWithComponents<typeof schema>>;

export function newT(transactionLimits = false): T {
  const t = convexTestWithComponents(schema, import.meta.glob("../convex/**/*.*s"), { transactionLimits });
  // Match the production patch fast path only in social fixtures. Start from
  // the raw context so the aggregate trigger lock is wrapped exactly once.
  const rawRun = t.runUnwrapped;
  t.run = ((fn: (ctx: never) => unknown) => rawRun(((ctx: never) =>
    fn(wrapOwnNumberDB(ctx as never, aggregateTriggers.wrapDB(ctx as never)) as never)) as never)) as typeof t.run;
  return t;
}

// The pinned global afterEach lazily imports DOM cleanup. Pay that shared
// module initialization here, before the first social scenario's deadline.
beforeAll(async () => {
  if (typeof document !== "undefined") await import("@testing-library/react");
});

/** One current row per source family; all fourteen contact fields are populated. */
export async function seedOwnContactCensus(t: T, orgId: Id<"organizations">) {
  return t.run(async (ctx) => {
    const member = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", orgId)).first();
    const settings = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique();
    if (!member || !settings) throw new Error("Synthetic contact census fixture missing");
    const phones = Array.from({ length: 14 }, (_, i) => `079000${String(i + 1).padStart(4, "0")}`);
    await ctx.db.patch(settings._id, { dealershipPhone: phones[0], dealershipPhones: [phones[1]] });
    await ctx.db.patch(member.userId, { whatsappPhone: phones[2] });
    await ctx.db.insert("branches", { orgId, name: "Synthetic", isActive: false, phone: phones[3], additionalPhones: [phones[4]] });
    await ctx.db.insert("marketplaceDealerProfiles", { orgId, whatsappNumber: phones[5], isOptedIn: false, areas: [], brandsCarried: [], badges: [], totalResponses: 0, totalAccepted: 0, tier: "FREE_FOUNDING", leadsUsedThisPeriod: 0, createdAt: 1, updatedAt: 1 });
    await ctx.db.insert("marketplaceWhatsAppFlows", { orgId, phone: phones[6], step: "COMPLETED", photoStorageIds: [], createdAt: 1, updatedAt: 1 });
    await ctx.db.insert("marketplaceIndividualSellerProfiles", { sellerUserId: member.userId, sellerKind: "INDIVIDUAL", phone: phones[9], createdAt: 1, updatedAt: 1 });
    await ctx.db.insert("marketplaceListings", { sellerUserId: member.userId, sellerKind: "INDIVIDUAL", sellerDisplayName: "Synthetic", sellerPhone: phones[7], sellerWhatsapp: phones[8],
      make: "Synthetic", model: "Fixture", year: 2020, mileage: 0, price: 1, currency: "JOD", transmission: "AUTO", fuelType: "OTHER", city: "Synthetic", description: "Fixture", condition: "GOOD", imageIds: [], status: "SOLD", createdAt: 1, updatedAt: 1 });
    const websiteSettingsId = await ctx.db.insert("websiteSettings", { orgId, enabled: true, status: "active", templateId: "synthetic", defaultLanguage: "en", supportedLanguages: ["en"], createdAt: 1, updatedAt: 1 });
    const snapshotId = await ctx.db.insert("websitePublishSnapshots", { orgId, websiteSettingsId, createdAt: 1, publishedByUserId: member.userId,
      snapshotJson: { profile: { phone: phones[10], phones: [phones[11]], branches: [{ phone: phones[12], phones: [phones[13]] }] } } });
    await ctx.db.patch(websiteSettingsId, { publishedSnapshotId: snapshotId });
    return phones;
  });
}

beforeEach(() => {
  vi.stubEnv("FACEBOOK_APP_SECRET", FB_SECRET);
  vi.stubEnv("INSTAGRAM_APP_SECRET", IG_SECRET);
  // Enrichment (profile name, post caption) reaches the Graph API. Answer
  // every call with an empty success so the route's own logic is what's tested.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function post(t: T, path: "/facebook-webhook" | "/instagram-webhook", payload: unknown, secretOverride?: string) {
  const body = JSON.stringify(payload);
  const secret = secretOverride ?? (path === "/facebook-webhook" ? FB_SECRET : IG_SECRET);
  const sig = await hmacHex(secret, body);
  return await t.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${sig}` },
    body,
  });
}

export async function seedOrg(t: T, settings: Partial<Doc<"orgSettings">>) {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Org", createdAt: Date.now() });
    await ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const userId = await ctx.db.insert("users", { clerkId: `mgr_${orgId}`, email: `m_${orgId}@t.com`, name: "Mgr" });
    const roleId = await ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: ["manage:users"] });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    await ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "د.أ",
      enabledPaymentTypes: ["CASH"],
      ...settings,
    });
    return orgId;
  });
}

// Mirrors the one connected production org (read 2026-10-04): comment→lead
// OFF on both platforms, DM→lead ON but only when the DM carries a mobile.
export const PROD_LIKE_FB = {
  facebookPageId: PAGE_ID,
  facebookPageAccessToken: "page_token_abc",
  facebookLeadFromCommentsEnabled: false,
  facebookLeadFromDmsEnabled: true,
  facebookLeadFromDmsRequiresMobile: true,
};
export const PROD_LIKE_IG = {
  instagramBusinessAccountId: IG_BUSINESS_ID,
  instagramWebhookAccountId: IG_WEBHOOK_ID,
  instagramAccessToken: "token_abc",
  instagramLeadFromCommentsEnabled: false,
  instagramLeadFromDmsEnabled: true,
  instagramLeadFromDmsRequiresMobile: true,
};

let seq = 0;
export function fbDm(sender: string, text: string | undefined, extra: Record<string, unknown> = {}, pageId = PAGE_ID) {
  seq += 1;
  return {
    object: "page",
    entry: [
      {
        id: pageId,
        time: 1_700_000_000_000 + seq,
        messaging: [
          {
            sender: { id: sender },
            recipient: { id: pageId },
            timestamp: 1_700_000_000_000 + seq,
            message: { mid: `m_fb_${seq}`, ...(text !== undefined ? { text } : {}), ...extra },
          },
        ],
      },
    ],
  };
}

export function fbComment(from: { id: string; name?: string } | undefined, message: string, verb = "add") {
  seq += 1;
  return {
    object: "page",
    entry: [
      {
        id: PAGE_ID,
        time: 1_700_000_000_000 + seq,
        changes: [
          {
            field: "feed",
            value: {
              item: "comment",
              verb,
              comment_id: `${PAGE_ID}_post_c${seq}`,
              post_id: `${PAGE_ID}_post`,
              ...(from ? { from } : {}),
              message,
              created_time: 1_700_000_000 + seq,
            },
          },
        ],
      },
    ],
  };
}

export function igDm(sender: string, text: string | undefined, extra: Record<string, unknown> = {}) {
  seq += 1;
  return {
    object: "instagram",
    entry: [
      {
        id: IG_WEBHOOK_ID,
        time: 1_700_000_000_000 + seq,
        messaging: [
          {
            sender: { id: sender },
            recipient: { id: IG_WEBHOOK_ID },
            timestamp: 1_700_000_000_000 + seq,
            message: { mid: `m_ig_${seq}`, ...(text !== undefined ? { text } : {}), ...extra },
          },
        ],
      },
    ],
  };
}

export function igComment(from: { id: string; username?: string } | undefined, text: string) {
  seq += 1;
  return {
    object: "instagram",
    entry: [
      {
        id: IG_WEBHOOK_ID,
        time: 1_700_000_000_000 + seq,
        changes: [
          {
            field: "comments",
            value: { id: `igc_${seq}`, ...(from ? { from } : {}), media: { id: "media_1" }, text },
          },
        ],
      },
    ],
  };
}

export async function snapshot(t: T, orgId: Id<"organizations">) {
  return await t.run(async (ctx) => ({
    customers: await ctx.db.query("customers").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect(),
    leads: await ctx.db.query("leads").withIndex("by_org_customer", (q) => q.eq("orgId", orgId)).collect(),
    fbEvents: await ctx.db.query("facebookEvents").withIndex("by_org_external", (q) => q.eq("orgId", orgId)).collect(),
    igEvents: await ctx.db.query("instagramEvents").withIndex("by_org_external", (q) => q.eq("orgId", orgId)).collect(),
  }));
}

