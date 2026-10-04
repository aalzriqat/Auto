import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { extractSharedMobileNumber } from "./utils/socialMobile";

/**
 * End-to-end replay of signed Meta webhooks through the real HTTP routes.
 *
 * Every other social test calls `handleIncoming*Event` directly, so the route
 * layer — signature, batch claim, org resolution, own-account/echo skips, the
 * comment `verb` filter and per-entry error handling — had no coverage. These
 * tests post the same envelopes Meta sends and assert what lands in the
 * customers / leads / events tables.
 */

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

vi.mock("./utils/facebookApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils/facebookApi")>();
  return {
    ...actual,
    postCommentReply: vi.fn().mockResolvedValue({ ok: true }),
    postDirectMessage: vi.fn().mockResolvedValue({ ok: true }),
  };
});

vi.mock("./utils/instagramApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils/instagramApi")>();
  return {
    ...actual,
    postCommentReply: vi.fn().mockResolvedValue({ ok: true }),
    postDirectMessage: vi.fn().mockResolvedValue({ ok: true }),
  };
});

const FB_SECRET = "fb_test_app_secret";
const IG_SECRET = "ig_test_app_secret";
const PAGE_ID = "page_business_1";
const IG_WEBHOOK_ID = "ig_webhook_1";
const IG_BUSINESS_ID = "ig_business_1";

type T = ReturnType<typeof convexTestWithComponents<typeof schema>>;

function newT(): T {
  return convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
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

async function post(t: T, path: "/facebook-webhook" | "/instagram-webhook", payload: unknown, secretOverride?: string) {
  const body = JSON.stringify(payload);
  const secret = secretOverride ?? (path === "/facebook-webhook" ? FB_SECRET : IG_SECRET);
  const sig = await hmacHex(secret, body);
  return await t.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${sig}` },
    body,
  });
}

async function seedOrg(t: T, settings: Record<string, unknown>) {
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
    } as never);
    return orgId;
  });
}

// Mirrors the one connected production org (read 2026-10-04): comment→lead
// OFF on both platforms, DM→lead ON but only when the DM carries a mobile.
const PROD_LIKE_FB = {
  facebookPageId: PAGE_ID,
  facebookPageAccessToken: "page_token_abc",
  facebookLeadFromCommentsEnabled: false,
  facebookLeadFromDmsEnabled: true,
  facebookLeadFromDmsRequiresMobile: true,
};
const PROD_LIKE_IG = {
  instagramBusinessAccountId: IG_BUSINESS_ID,
  instagramWebhookAccountId: IG_WEBHOOK_ID,
  instagramAccessToken: "token_abc",
  instagramLeadFromCommentsEnabled: false,
  instagramLeadFromDmsEnabled: true,
  instagramLeadFromDmsRequiresMobile: true,
};

let seq = 0;
function fbDm(sender: string, text: string, extra: Record<string, unknown> = {}, pageId = PAGE_ID) {
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
            message: { mid: `m_fb_${seq}`, text, ...extra },
          },
        ],
      },
    ],
  };
}

function fbComment(from: { id: string; name?: string } | undefined, message: string, verb = "add") {
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

function igDm(sender: string, text: string | undefined, extra: Record<string, unknown> = {}) {
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

function igComment(from: { id: string; username?: string } | undefined, text: string) {
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

async function snapshot(t: T, orgId: Id<"organizations">) {
  return await t.run(async (ctx) => ({
    customers: await ctx.db.query("customers").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect(),
    leads: await ctx.db.query("leads").withIndex("by_org_customer", (q) => q.eq("orgId", orgId)).collect(),
    fbEvents: await ctx.db.query("facebookEvents").withIndex("by_org_external", (q) => q.eq("orgId", orgId)).collect(),
    igEvents: await ctx.db.query("instagramEvents").withIndex("by_org_external", (q) => q.eq("orgId", orgId)).collect(),
  }));
}

describe("route envelope", () => {
  test("rejects a bad signature without writing anything", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_FB);
    const res = await post(t, "/facebook-webhook", fbDm("psid_x", "0791234567"), "wrong_secret");
    expect(res.status).toBe(401);
    const s = await snapshot(t, orgId);
    expect(s.customers).toHaveLength(0);
  });

  test("acknowledges an unknown page with 200 and writes nothing", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_FB);
    const res = await post(t, "/facebook-webhook", fbDm("psid_x", "0791234567", {}, "page_someone_else"));
    expect(res.status).toBe(200);
    expect((await snapshot(t, orgId)).customers).toHaveLength(0);
  });

  test("an identical redelivery creates one customer, one lead, one event", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_FB);
    const payload = fbDm("psid_dup", "رقمي 0791234567");
    expect((await post(t, "/facebook-webhook", payload)).status).toBe(200);
    expect((await post(t, "/facebook-webhook", payload)).status).toBe(200);
    const s = await snapshot(t, orgId);
    expect(s.customers).toHaveLength(1);
    expect(s.leads).toHaveLength(1);
    expect(s.fbEvents).toHaveLength(1);
  });

  test("the same mid inside a different envelope is still deduped", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_FB);
    const a = fbDm("psid_dup2", "0791234567");
    const b = structuredClone(a);
    b.entry[0].time += 999; // different bytes → different batch hash
    await post(t, "/facebook-webhook", a);
    await post(t, "/facebook-webhook", b);
    const s = await snapshot(t, orgId);
    expect(s.fbEvents).toHaveLength(1);
    expect(s.leads).toHaveLength(1);
  });

  test("a batch with two entries and two DMs processes every message", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_FB);
    const a = fbDm("psid_b1", "0791111111");
    const b = fbDm("psid_b2", "0782222222");
    const unknown = fbDm("psid_b3", "0773333333", {}, "page_unknown");
    const batch = { object: "page", entry: [a.entry[0], unknown.entry[0], b.entry[0]] };
    batch.entry[0].messaging.push(fbDm("psid_b4", "0794444444").entry[0].messaging[0]);
    expect((await post(t, "/facebook-webhook", batch)).status).toBe(200);
    const s = await snapshot(t, orgId);
    expect(s.leads).toHaveLength(3);
    expect(s.customers.map((c) => c.phone).sort()).toEqual(["0782222222", "0791111111", "0794444444"]);
  });
});

describe("Facebook DM → lead (production configuration)", () => {
  test("DM carrying a mobile creates customer + phone + NEW lead", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_FB);
    expect((await post(t, "/facebook-webhook", fbDm("psid_1", "مرحبا رقمي 0791234567"))).status).toBe(200);
    const s = await snapshot(t, orgId);
    expect(s.customers).toHaveLength(1);
    expect(s.customers[0].phone).toBe("0791234567");
    expect(s.customers[0].facebookUserId).toBe("psid_1");
    expect(s.leads).toHaveLength(1);
    expect(s.leads[0].source).toBe("Facebook DM");
    expect(s.leads[0].stage).toBe("NEW");
  });

  test("DM without a mobile is captured in the inbox but creates no lead", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_FB);
    await post(t, "/facebook-webhook", fbDm("psid_2", "كم السعر؟"));
    const s = await snapshot(t, orgId);
    expect(s.customers).toHaveLength(1);
    expect(s.fbEvents).toHaveLength(1);
    expect(s.leads).toHaveLength(0);
  });

  test("a later DM with the mobile converts the same contact into a lead", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_FB);
    await post(t, "/facebook-webhook", fbDm("psid_3", "كم السعر؟"));
    await post(t, "/facebook-webhook", fbDm("psid_3", "+962 79 123 4567"));
    const s = await snapshot(t, orgId);
    expect(s.customers).toHaveLength(1);
    expect(s.leads).toHaveLength(1);
    expect(s.customers[0].phone).toBe("+962791234567");
  });

  test("further DMs reuse the open lead instead of creating another", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_FB);
    await post(t, "/facebook-webhook", fbDm("psid_4", "0791234567"));
    await post(t, "/facebook-webhook", fbDm("psid_4", "again 0791234567"));
    expect((await snapshot(t, orgId)).leads).toHaveLength(1);
  });

  test("echo of our own outbound message is ignored", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_FB);
    await post(t, "/facebook-webhook", fbDm("psid_5", "0791234567", { is_echo: true }));
    const s = await snapshot(t, orgId);
    expect(s.customers).toHaveLength(0);
    expect(s.fbEvents).toHaveLength(0);
  });

  test("a DM quoting only the dealer's own number is not a lead", async () => {
    const t = newT();
    const orgId = await seedOrg(t, { ...PROD_LIKE_FB, dealershipPhone: "0799103353" });
    await post(t, "/facebook-webhook", fbDm("psid_6", "I saw your ad, call 0799103353?"));
    const s = await snapshot(t, orgId);
    expect(s.leads).toHaveLength(0);
    expect(s.customers[0].phone).toBeUndefined();
  });
});

describe("Facebook comments", () => {
  test("comment with comment→lead OFF is captured, no lead", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_FB);
    await post(t, "/facebook-webhook", fbComment({ id: "u_1", name: "Ali Saleh" }, "price?"));
    const s = await snapshot(t, orgId);
    expect(s.fbEvents).toHaveLength(1);
    expect(s.leads).toHaveLength(0);
    expect(s.customers[0].firstName).toBe("Ali");
  });

  test("comment with comment→lead ON creates a Facebook Comment lead", async () => {
    const t = newT();
    const orgId = await seedOrg(t, { ...PROD_LIKE_FB, facebookLeadFromCommentsEnabled: true });
    await post(t, "/facebook-webhook", fbComment({ id: "u_2", name: "Sara" }, "price?"));
    const s = await snapshot(t, orgId);
    expect(s.leads).toHaveLength(1);
    expect(s.leads[0].source).toBe("Facebook Comment");
  });

  test("the page's own comment is not reprocessed", async () => {
    const t = newT();
    const orgId = await seedOrg(t, { ...PROD_LIKE_FB, facebookLeadFromCommentsEnabled: true });
    await post(t, "/facebook-webhook", fbComment({ id: PAGE_ID, name: "Dealer" }, "Thanks!"));
    expect((await snapshot(t, orgId)).fbEvents).toHaveLength(0);
  });

  test("edited / removed comments (verb != add) are ignored", async () => {
    const t = newT();
    const orgId = await seedOrg(t, { ...PROD_LIKE_FB, facebookLeadFromCommentsEnabled: true });
    await post(t, "/facebook-webhook", fbComment({ id: "u_3", name: "X" }, "edited", "edited"));
    await post(t, "/facebook-webhook", fbComment({ id: "u_3", name: "X" }, "", "remove"));
    expect((await snapshot(t, orgId)).fbEvents).toHaveLength(0);
  });

  // Known defect SCRUM-626 — flip to `test` when fixed.
  test.fails("SCRUM-626: comments with no `from` do not collapse into one shared contact", async () => {
    // Meta omits `from` on comments from users who have not granted the app
    // visibility (and for some page-role users). Instagram's route skips an
    // empty sender id; Facebook's does not.
    const t = newT();
    const orgId = await seedOrg(t, { ...PROD_LIKE_FB, facebookLeadFromCommentsEnabled: true });
    await post(t, "/facebook-webhook", fbComment(undefined, "first anonymous"));
    await post(t, "/facebook-webhook", fbComment(undefined, "second anonymous"));
    const s = await snapshot(t, orgId);
    const blankIdCustomers = s.customers.filter((c) => c.facebookUserId === "");
    expect(blankIdCustomers).toHaveLength(0);
  });
});

describe("Instagram", () => {
  test("DM carrying a mobile creates customer + phone + Instagram DM lead", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_IG);
    expect((await post(t, "/instagram-webhook", igDm("igsid_1", "0781234567 please call"))).status).toBe(200);
    const s = await snapshot(t, orgId);
    expect(s.customers).toHaveLength(1);
    expect(s.customers[0].phone).toBe("0781234567");
    expect(s.leads).toHaveLength(1);
    expect(s.leads[0].source).toBe("Instagram DM");
  });

  test("DM without mobile: captured, no lead", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_IG);
    await post(t, "/instagram-webhook", igDm("igsid_2", "available?"));
    const s = await snapshot(t, orgId);
    expect(s.igEvents).toHaveLength(1);
    expect(s.leads).toHaveLength(0);
  });

  test("echo is ignored", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_IG);
    await post(t, "/instagram-webhook", igDm("igsid_3", "0781234567", { is_echo: true }));
    expect((await snapshot(t, orgId)).igEvents).toHaveLength(0);
  });

  test("own-account comment and sender-less comment are skipped; real comment captured", async () => {
    const t = newT();
    const orgId = await seedOrg(t, { ...PROD_LIKE_IG, instagramLeadFromCommentsEnabled: true });
    await post(t, "/instagram-webhook", igComment({ id: IG_BUSINESS_ID, username: "dealer" }, "thanks"));
    await post(t, "/instagram-webhook", igComment({ id: IG_WEBHOOK_ID, username: "dealer" }, "thanks"));
    await post(t, "/instagram-webhook", igComment(undefined, "anon"));
    await post(t, "/instagram-webhook", igComment({ id: "igu_1", username: "buyer" }, "price?"));
    const s = await snapshot(t, orgId);
    expect(s.igEvents).toHaveLength(1);
    expect(s.leads).toHaveLength(1);
    expect(s.leads[0].source).toBe("Instagram Comment");
  });

  test("an org whose Instagram webhook account id was never stored receives nothing", async () => {
    // Documents the dependency behind candidate F2: the route resolves the org
    // ONLY by `instagramWebhookAccountId`.
    const t = newT();
    const orgId = await seedOrg(t, { ...PROD_LIKE_IG, instagramWebhookAccountId: undefined });
    const payload = igDm("igsid_4", "0781234567");
    payload.entry[0].id = IG_BUSINESS_ID; // even if Meta sent the business id
    expect((await post(t, "/instagram-webhook", payload)).status).toBe(200);
    expect((await snapshot(t, orgId)).igEvents).toHaveLength(0);
  });

  test("media-only DM is stored with readable text, not just the attachment type", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_IG);
    await post(
      t,
      "/instagram-webhook",
      igDm("igsid_5", undefined, { attachments: [{ type: "image", payload: { url: "https://lookaside.fbsbx.com/x.jpg" } }] }),
    );
    const s = await snapshot(t, orgId);
    expect(s.igEvents).toHaveLength(1);
    // Today the stored text is the bare attachment type ("image"); asserted so a
    // change to what operators see is deliberate.
    expect(s.igEvents[0].text).toBe("image");
  });
});

async function ambiguityLogs(t: ReturnType<typeof newT>, source: "facebook" | "instagram") {
  const rows = await t.run((ctx) => ctx.db.query("webhookLogs").collect());
  return rows.filter((row) => row.source === source && row.status === "error" && /more than one org/.test(row.summary));
}

describe("cross-cutting", () => {
  // SCRUM-622: an ambiguous page/account is skipped — never guessed — and the
  // delivery is acknowledged instead of failing forever on redelivery.
  test("SCRUM-622: the same Facebook page connected to two orgs does not wedge every delivery", async () => {
    const t = newT();
    const orgA = await seedOrg(t, PROD_LIKE_FB);
    const orgB = await seedOrg(t, PROD_LIKE_FB);
    const res = await post(t, "/facebook-webhook", fbDm("psid_dup_page", "0791234567"));
    expect(res.status).toBe(200);
    expect((await snapshot(t, orgA)).fbEvents).toHaveLength(0);
    expect((await snapshot(t, orgB)).fbEvents).toHaveLength(0);
    // The dropped entry leaves a durable error row, so it is not mistaken for
    // an unconnected Page and can be found and replayed once one org disconnects.
    expect(await ambiguityLogs(t, "facebook")).toHaveLength(1);
  });

  test("SCRUM-622: an unconnected Page is skipped without an ambiguity row", async () => {
    const t = newT();
    await seedOrg(t, { ...PROD_LIKE_FB, facebookPageId: "some_other_page" });
    expect((await post(t, "/facebook-webhook", fbDm("psid_nobody", "hi"))).status).toBe(200);
    expect(await ambiguityLogs(t, "facebook")).toHaveLength(0);
  });

  test("SCRUM-622: the same Instagram account connected to two orgs", async () => {
    const t = newT();
    const orgA = await seedOrg(t, PROD_LIKE_IG);
    const orgB = await seedOrg(t, PROD_LIKE_IG);
    const res = await post(t, "/instagram-webhook", igDm("igsid_dup", "0781234567"));
    expect(res.status).toBe(200);
    expect((await snapshot(t, orgA)).igEvents).toHaveLength(0);
    expect((await snapshot(t, orgB)).igEvents).toHaveLength(0);
    expect(await ambiguityLogs(t, "instagram")).toHaveLength(1);
  });

  // Known defect SCRUM-625 — flip to `test` when fixed.
  test.fails("SCRUM-625: a mobile already on another customer still yields ONE contact for that person", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_FB);
    await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Walk", lastName: "In", phone: "0791234567", createdAt: Date.now() }),
    );
    await post(t, "/facebook-webhook", fbDm("psid_known", "رقمي 0791234567"));
    const s = await snapshot(t, orgId);
    expect(s.customers).toHaveLength(1);
  });

  // Known defect SCRUM-627 — flip to `test` when fixed.
  test.fails("SCRUM-627: a soft-deleted contact is not resurrected as the lead's customer", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_FB);
    const deletedId = await t.run((ctx) =>
      ctx.db.insert("customers", {
        orgId,
        firstName: "Old",
        lastName: "Contact",
        facebookUserId: "psid_deleted",
        isDeleted: true,
        createdAt: Date.now(),
      }),
    );
    await post(t, "/facebook-webhook", fbDm("psid_deleted", "0791234567"));
    const s = await snapshot(t, orgId);
    expect(s.leads).toHaveLength(1);
    expect(s.leads[0].customerId).not.toBe(deletedId);
  });

  test("a returning buyer after WON gets a new lead only when the gate passes", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_FB);
    await post(t, "/facebook-webhook", fbDm("psid_won", "0791234567"));
    await t.run(async (ctx) => {
      const lead = (await ctx.db.query("leads").collect())[0];
      await ctx.db.patch(lead._id, { stage: "WON" });
    });
    await post(t, "/facebook-webhook", fbDm("psid_won", "thanks for the car!"));
    expect((await snapshot(t, orgId)).leads).toHaveLength(1);
    await post(t, "/facebook-webhook", fbDm("psid_won", "my brother wants one, 0791234567"));
    expect((await snapshot(t, orgId)).leads).toHaveLength(2);
  });

  test("enrichment network failure does not fail the delivery after the event was recorded", async () => {
    const t = newT();
    const orgId = await seedOrg(t, PROD_LIKE_FB);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const res = await post(t, "/facebook-webhook", fbDm("psid_net", "0791234567"));
    const s = await snapshot(t, orgId);
    expect(s.leads).toHaveLength(1);
    expect(res.status).toBe(200);
  });
});

describe("Jordanian mobile extraction", () => {
  const recognised: Array<[string, string]> = [
    ["0791234567", "0791234567"],
    ["+962 79 123 4567", "0791234567"],
    ["00962791234567", "0791234567"],
    ["٠٧٩١٢٣٤٥٦٧", "0791234567"],
    ["079-123-4567", "0791234567"],
    ["السعر 15000, رقمي 0791234567", "0791234567"],
    ["2 cars 0791234567", "0791234567"],
    ["موديل 2019 رقمي 0791234567", "0791234567"],
    ["call me 0791234567 thanks 2", "0791234567"],
  ];
  for (const [input, expected] of recognised) {
    test(JSON.stringify(input), () => {
      expect(extractSharedMobileNumber(input)?.variants[0] ?? null).toBe(expected);
    });
  }

  // Known defect SCRUM-624: a number next to another number is glued into one
  // candidate and lost. Flip each to `test` as the extractor is fixed.
  const missed: Array<[string, string]> = [
    ["Elantra 2020 0791234567", "0791234567"],
    ["15000, 0791234567", "0791234567"],
    ["السعر 15000 0791234567", "0791234567"],
    ["0791234567 / 0781234567", "0791234567"],
    ["962791234567", "0791234567"],
    ["791234567", "0791234567"],
  ];
  for (const [input, expected] of missed) {
    test.fails(`SCRUM-624: ${JSON.stringify(input)}`, () => {
      expect(extractSharedMobileNumber(input)?.variants[0] ?? null).toBe(expected);
    });
  }
});

describe("Instagram connect when the profile lookup fails", () => {
  // Known defect SCRUM-623 — flip to `test` when fixed.
  test.fails("a transient profile failure must not leave an org 'connected' but deaf to every webhook", async () => {
    vi.stubEnv("INSTAGRAM_APP_ID", "ig_app");
    vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("api.instagram.com/oauth/access_token")) return json(200, { access_token: "short", user_id: 1234 });
        if (url.includes("graph.instagram.com/access_token")) return json(200, { access_token: "long", expires_in: 5184000 });
        if (url.includes("subscribed_apps")) return json(200, { success: true });
        // The profile read (username,user_id): a transient Graph outage.
        return json(500, { error: { message: "An unexpected error has occurred. Please retry your request later." } });
      }),
    );
    const t = newT();
    const orgId = await seedOrg(t, {});
    const { internal } = await import("./_generated/api");
    await t.action(internal.socialIntegrations.exchangeCodeForToken, { orgId, code: "abc" });
    const settings = await t.run((ctx) =>
      ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique(),
    );
    expect(settings?.instagramAccessToken).toBe("long");
    expect(settings?.instagramBusinessAccountId).toBe("1234");
    // Either the connect fails loudly, or the webhook id is captured — never
    // a silent "connected" with nothing routable.
    expect(settings?.instagramWebhookAccountId).toBeDefined();
  });
});

describe("Facebook surface classification", () => {
  test("ordinary words containing 'ad' do not relabel a plain post comment / DM as an Ad lead", async () => {
    const t = newT();
    const orgId = await seedOrg(t, { ...PROD_LIKE_FB, facebookLeadFromCommentsEnabled: true });
    await post(t, "/facebook-webhook", fbComment({ id: "u_ad1", name: "Omar" }, "is it already sold?"));
    await post(t, "/facebook-webhook", fbDm("psid_ad2", "I'm ready to trade, 0791234567"));
    const s = await snapshot(t, orgId);
    const sources = s.leads.map((l) => l.source).sort();
    expect(sources).toEqual(["Facebook Comment", "Facebook DM"]);
  });
});

describe("duplicate page blast radius", () => {
  test("a duplicated page in one entry does not block another org's entry in the same batch", async () => {
    const t = newT();
    await seedOrg(t, PROD_LIKE_FB);
    await seedOrg(t, PROD_LIKE_FB);
    const orgC = await seedOrg(t, { ...PROD_LIKE_FB, facebookPageId: "page_org_c" });
    const dupEntry = fbDm("psid_a", "0791234567").entry[0];
    const cEntry = fbDm("psid_c", "0781234567", {}, "page_org_c").entry[0];
    const res = await post(t, "/facebook-webhook", { object: "page", entry: [dupEntry, cEntry] });
    expect(res.status).toBe(200);
    expect((await snapshot(t, orgC)).fbEvents).toHaveLength(1);
  });

  test("a duplicated Instagram account does not block another org's entry in the same batch", async () => {
    const t = newT();
    await seedOrg(t, PROD_LIKE_IG);
    await seedOrg(t, PROD_LIKE_IG);
    const orgC = await seedOrg(t, { ...PROD_LIKE_IG, instagramWebhookAccountId: "ig_org_c", instagramBusinessAccountId: "ig_biz_c" });
    const dupEntry = igDm("igsid_a", "0791234567").entry[0];
    const cPayload = igDm("igsid_c", "0781234567");
    const cEntry = { ...cPayload.entry[0], id: "ig_org_c" };
    cEntry.messaging[0].recipient.id = "ig_org_c";
    const res = await post(t, "/instagram-webhook", { object: "instagram", entry: [dupEntry, cEntry] });
    expect(res.status).toBe(200);
    expect((await snapshot(t, orgC)).igEvents).toHaveLength(1);
  });
});
