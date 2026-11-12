import { convexTestWithComponents } from "./convexTest";
import { vi, beforeEach, afterEach } from "vitest";
import schema from "../convex/schema";
import type { Doc, Id } from "../convex/_generated/dataModel";

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

export function newT(): T {
  return convexTestWithComponents(schema, import.meta.glob("../convex/**/*.*s"));
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

