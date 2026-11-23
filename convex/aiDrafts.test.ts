// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { expectAppError } from "../test-utils/expectAppError";
import {
  FAKE_KEY,
  MASTER_KEY,
  anthropicError,
  draftReply,
  drain,
  pauseScheduler,
  seedDealership,
  stubNetwork,
  switchOnAi,
} from "../test-utils/aiDraftsFixture";
import type { AiTest, Dealership } from "../test-utils/aiDraftsFixture";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const NOT_ENABLED = "AI drafts are not turned on for this dealership.";
const NO_CONVERSATION = "This customer has no private message conversation.";
const RATE_LIMITED = "Too many draft requests. Please wait and try again.";
const NOT_FOUND = "This draft was not found.";
const NOT_MEMBER = "Unauthorized: You are not a member of this organization.";

const ORIGINAL_ENV = {
  master: process.env.AI_KEY_ENCRYPTION_KEY,
  admins: process.env.SUPER_ADMIN_EMAILS,
  deployClass: process.env.AUTOFLOW_DEPLOYMENT_CLASS,
  cloudUrl: process.env.CONVEX_CLOUD_URL,
};

let consoleLines: string[] = [];

beforeEach(() => {
  process.env.AI_KEY_ENCRYPTION_KEY = MASTER_KEY;
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
  delete process.env.AUTOFLOW_DEPLOYMENT_CLASS;
  consoleLines = [];
  // Literal method names on purpose: test-utils/pilotConfigParity.ts treats a spyOn with a
  // non-literal method name as a possible pilot-door replacement.
  const capture = (...args: unknown[]) => {
    consoleLines.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "info").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(console, "debug").mockImplementation(capture);
  pauseScheduler();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("AI_KEY_ENCRYPTION_KEY", ORIGINAL_ENV.master);
  restore("SUPER_ADMIN_EMAILS", ORIGINAL_ENV.admins);
  restore("AUTOFLOW_DEPLOYMENT_CLASS", ORIGINAL_ENV.deployClass);
  restore("CONVEX_CLOUD_URL", ORIGINAL_ENV.cloudUrl);
});

function newT(): AiTest {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  return t;
}

async function ready(): Promise<{ t: AiTest; d: Dealership }> {
  const t = newT();
  const d = await seedDealership(t);
  await switchOnAi(t, d);
  return { t, d };
}

const draftRows = (t: AiTest) => t.run((ctx) => ctx.db.query("aiDrafts").take(50));

describe("tenancy", () => {
  test("a member of another dealership cannot request, read or link a draft", async () => {
    const { t, d } = await ready();
    const other = await seedDealership(t, { name: "Other Motors", subject: "sales_2" });
    await switchOnAi(t, other, { master: false, key: false });
    const outsider = t.withIdentity({ subject: other.subject });
    const insider = t.withIdentity({ subject: d.subject });

    await expectAppError(
      outsider.mutation(api.aiDrafts.requestDraft, { orgId: d.orgId, customerId: d.customerId, platform: "instagram" }),
      "UNAUTHORIZED",
      NOT_MEMBER
    );
    await expectAppError(
      outsider.mutation(api.aiDrafts.requestDraft, { orgId: other.orgId, customerId: d.customerId, platform: "instagram" }),
      "AI_DRAFT_NO_CONVERSATION",
      NO_CONVERSATION
    );
    expect(await draftRows(t)).toHaveLength(0);

    stubNetwork(() => draftReply("availability"));
    const { draftId } = await insider.mutation(api.aiDrafts.requestDraft, {
      orgId: d.orgId,
      customerId: d.customerId,
      platform: "instagram",
    });
    await drain(t);
    expect(await insider.query(api.aiDrafts.getDraft, { orgId: d.orgId, draftId })).toMatchObject({ status: "ready" });
    expect(await outsider.query(api.aiDrafts.getDraft, { orgId: other.orgId, draftId })).toBeNull();
    await expectAppError(outsider.query(api.aiDrafts.getDraft, { orgId: d.orgId, draftId }), "UNAUTHORIZED", NOT_MEMBER);

    const network = stubNetwork(() => draftReply("greeting"));
    await expectAppError(
      outsider.action(api.instagramEngagement.sendInstagramDirectMessage, {
        orgId: other.orgId,
        customerId: other.customerId,
        message: "hello",
        aiDraftId: draftId,
      }),
      "AI_DRAFT_NOT_FOUND",
      NOT_FOUND
    );
    expect(network.meta).toHaveLength(0);
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.sentAt).toBeUndefined();
  });
});

describe("gate", () => {
  test.each([
    ["the platform switch is off", { master: false }],
    ["the dealership switch is off", { org: false }],
    ["no key is stored", { key: false }],
  ])("a request is refused and leaves no row when %s", async (_label, parts) => {
    const t = newT();
    const d = await seedDealership(t);
    await switchOnAi(t, d, parts);
    await expectAppError(
      t.withIdentity({ subject: d.subject }).mutation(api.aiDrafts.requestDraft, {
        orgId: d.orgId,
        customerId: d.customerId,
        platform: "instagram",
      }),
      "AI_DRAFT_NOT_ENABLED",
      NOT_ENABLED
    );
    expect(await draftRows(t)).toHaveLength(0);
    expect(await t.withIdentity({ subject: d.subject }).query(api.aiDrafts.getAvailability, { orgId: d.orgId })).toEqual({
      enabled: false,
    });
  });

  test("a customer with only comments is refused", async () => {
    const { t, d } = await ready();
    await t.run(async (ctx) => {
      const events = await ctx.db.query("instagramEvents").take(5);
      for (const event of events) await ctx.db.delete(event._id);
      await ctx.db.insert("instagramEvents", {
        orgId: d.orgId,
        externalId: "ig_comment_1",
        kind: "comment",
        senderInstagramId: "ig_sender_1",
        customerId: d.customerId,
        text: "nice car",
      });
    });
    await expectAppError(
      t.withIdentity({ subject: d.subject }).mutation(api.aiDrafts.requestDraft, {
        orgId: d.orgId,
        customerId: d.customerId,
        platform: "instagram",
      }),
      "AI_DRAFT_NO_CONVERSATION",
      NO_CONVERSATION
    );
    expect(await draftRows(t)).toHaveLength(0);
  });

  /** `count` more customers of the dealership, each with one Instagram DM. */
  async function addCustomersWithDms(t: AiTest, d: Dealership, count: number): Promise<Id<"customers">[]> {
    return await t.run(async (ctx) => {
      const made: Id<"customers">[] = [];
      for (let i = 0; i < count; i += 1) {
        const customerId = await ctx.db.insert("customers", { orgId: d.orgId, firstName: `C${i}`, lastName: "Extra" });
        await ctx.db.insert("instagramEvents", {
          orgId: d.orgId,
          externalId: `ig_dm_extra_${i}`,
          kind: "dm",
          senderInstagramId: `ig_sender_extra_${i}`,
          customerId,
          text: "hello",
        });
        made.push(customerId);
      }
      return made;
    });
  }

  test("a member at the per-user limit is refused and makes no row", async () => {
    const { t, d } = await ready();
    const member = t.withIdentity({ subject: d.subject });
    const others = await addCustomersWithDms(t, d, 5);
    const press = (customerId: Id<"customers">) =>
      member.mutation(api.aiDrafts.requestDraft, { orgId: d.orgId, customerId, platform: "instagram" });
    for (const customerId of [d.customerId, ...others.slice(0, 4)]) await press(customerId);
    await expectAppError(press(others[4] as Id<"customers">), "AI_DRAFT_RATE_LIMITED", RATE_LIMITED);
    expect(await draftRows(t)).toHaveLength(5);
  });

  test("a repeat press on a pending draft returns it and uses no rate-limit token", async () => {
    const { t, d } = await ready();
    const member = t.withIdentity({ subject: d.subject });
    const others = await addCustomersWithDms(t, d, 4);
    const press = (customerId: Id<"customers">) =>
      member.mutation(api.aiDrafts.requestDraft, { orgId: d.orgId, customerId, platform: "instagram" });
    const first = await press(d.customerId);
    for (let i = 0; i < 8; i += 1) expect(await press(d.customerId)).toEqual(first);
    for (const customerId of others) await press(customerId);
    expect(await draftRows(t)).toHaveLength(5);
  });

  test("a dealership at the 20 per minute limit is refused for every member", async () => {
    const { t, d } = await ready();
    const subjects = await t.run(async (ctx) => {
      const role = await ctx.db.query("roles").first();
      if (!role) throw new Error("seed role missing");
      const made: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const subject = `extra_${i}`;
        const userId = await ctx.db.insert("users", { clerkId: subject, email: `${subject}@example.com`, name: "Extra" });
        await ctx.db.insert("memberships", { orgId: d.orgId, userId, roleId: role._id });
        made.push(subject);
      }
      return made;
    });
    const customers = [d.customerId, ...(await addCustomersWithDms(t, d, 20))];
    const press = (subject: string, customerId: Id<"customers">) =>
      t.withIdentity({ subject }).mutation(api.aiDrafts.requestDraft, { orgId: d.orgId, customerId, platform: "instagram" });
    for (let i = 0; i < 20; i += 1) await press(subjects[i % 5] ?? "extra_0", customers[i] as Id<"customers">);
    await expectAppError(press(subjects[5] ?? "extra_5", customers[20] as Id<"customers">), "AI_DRAFT_RATE_LIMITED", RATE_LIMITED);
    // guardrail-4-fixture: the per-organization limit is 20 drafts a minute
    expect(await draftRows(t)).toHaveLength(20);
  });
});

describe("job lifecycle", () => {
  async function requestOne(t: AiTest, d: Dealership): Promise<Id<"aiDrafts">> {
    const { draftId } = await t
      .withIdentity({ subject: d.subject })
      .mutation(api.aiDrafts.requestDraft, { orgId: d.orgId, customerId: d.customerId, platform: "instagram" });
    return draftId;
  }

  test.each([
    ["the platform switch is turned off", async (t: AiTest) => t.run(async (ctx) => { const row = await ctx.db.query("aiSettings").first(); if (row) await ctx.db.patch(row._id, { draftsEnabled: false }); })],
    ["the dealership is suspended", async (t: AiTest, d: Dealership) => t.run((ctx) => ctx.db.patch(d.orgId, { suspended: true }))],
    ["the dealership is being deleted", async (t: AiTest, d: Dealership) => t.run((ctx) => ctx.db.patch(d.orgId, { deletionRequestedAt: Date.now() }))],
    ["the row expired", async (t: AiTest) => t.run(async (ctx) => { const row = await ctx.db.query("aiDrafts").first(); if (row) await ctx.db.patch(row._id, { status: "failed", failureReason: "timeout" }); })],
  ])("no provider call is made when %s between the request and the job", async (_label, change) => {
    const { t, d } = await ready();
    const network = stubNetwork(() => draftReply("greeting"));
    const draftId = await requestOne(t, d);
    await change(t, d);
    await drain(t);
    expect(network.anthropic).toHaveLength(0);
    const row = await t.run((ctx) => ctx.db.get(draftId));
    expect(row?.draftText).toBeUndefined();
  });

  test("a second press while pending returns the same draft, one job and one provider call", async () => {
    const { t, d } = await ready();
    const network = stubNetwork(() => draftReply("greeting"));
    const first = await requestOne(t, d);
    const second = await requestOne(t, d);
    expect(second).toBe(first);
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(10));
    expect(scheduled.map((job) => job.name).sort()).toEqual(["aiDrafts:expireDraft", "aiDrafts:generateDraft"]);
    await drain(t);
    expect(network.anthropic).toHaveLength(1);
    expect(await draftRows(t)).toHaveLength(1);
  });

  test("a stale pending draft is replaced and its late job writes and calls nothing", async () => {
    const { t, d } = await ready();
    const network = stubNetwork(() => draftReply("greeting"));
    const oldId = await t.run((ctx) =>
      ctx.db.insert("aiDrafts", {
        orgId: d.orgId,
        customerId: d.customerId,
        platform: "instagram",
        requestedBy: d.userId,
        requestedAt: Date.now() - 200_000,
        status: "pending",
        model: "claude-opus-5-5",
      })
    );
    const newId = await requestOne(t, d);
    expect(newId).not.toBe(oldId);
    const old = await t.run((ctx) => ctx.db.get(oldId));
    expect(old).toMatchObject({ status: "failed", failureReason: "timeout" });

    await t.action(internal.aiDrafts.generateDraft, { draftId: oldId });
    expect(network.anthropic).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.get(oldId))).toMatchObject({ status: "failed", failureReason: "timeout" });
  });

  test("a settled draft is not changed by a late expiry or a late completion", async () => {
    const { t, d } = await ready();
    stubNetwork(() => draftReply("greeting", "handover"));
    const draftId = await requestOne(t, d);
    await drain(t);
    const settled = await t.run((ctx) => ctx.db.get(draftId));
    expect(settled).toMatchObject({ status: "ready", draftText: "Hi! 👋 Ask us about price, financing, or availability for any vehicle.\nThank you for your message. One of our sales team will get back to you shortly with the details." });

    await t.mutation(internal.aiDrafts.expireDraft, { draftId });
    await t.mutation(internal.aiDrafts.completeDraft, {
      draftId,
      outcome: { status: "failed", failureReason: "provider_error" },
    });
    expect(await t.run((ctx) => ctx.db.get(draftId))).toEqual(settled);
  });

  test("expireDraft fails a pending row whose job never ran, visible through getDraft", async () => {
    const { t, d } = await ready();
    const draftId = await requestOne(t, d);
    await t.mutation(internal.aiDrafts.expireDraft, { draftId });
    expect(await t.withIdentity({ subject: d.subject }).query(api.aiDrafts.getDraft, { orgId: d.orgId, draftId })).toEqual({
      status: "failed",
    });
  });

  test("a sunk egress channel makes no provider call and fails the draft", async () => {
    const { t, d } = await ready();
    process.env.AUTOFLOW_DEPLOYMENT_CLASS = "preview";
    process.env.CONVEX_CLOUD_URL = "https://preview-deployment-123.convex.cloud";
    const network = stubNetwork(() => draftReply("greeting"));
    const draftId = await requestOne(t, d);
    await drain(t);
    expect(network.anthropic).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.get(draftId))).toMatchObject({ status: "failed", failureReason: "egress_sunk" });
  });

  test("the key plaintext appears in no row, log, error or scheduled argument", async () => {
    const { t, d } = await ready();
    const network = stubNetwork(() => anthropicError(401));
    const draftId = await requestOne(t, d);
    const scheduledBefore = JSON.stringify(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(20)));
    await drain(t);
    // Positive control: the key does reach the provider, in the header only.
    expect(network.anthropic[0]?.apiKeyHeader).toBe(FAKE_KEY);
    const row = await t.run((ctx) => ctx.db.get(draftId));
    expect(row).toMatchObject({ status: "failed", failureReason: "provider_auth" });

    const keyRow = (await t.run((ctx) => ctx.db.query("aiProviderKeys").take(2)))[0];
    const scheduledAfter = JSON.stringify(await t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(20)));
    const tables = JSON.stringify([
      await draftRows(t),
      await t.run((ctx) => ctx.db.query("instagramEvents").take(20)),
      await t.run((ctx) => ctx.db.query("orgSettings").take(5)),
    ]);
    for (const text of [scheduledBefore, scheduledAfter, tables, consoleLines.join("\n"), JSON.stringify(keyRow)]) {
      expect(text).not.toContain(FAKE_KEY);
    }
    for (const text of [scheduledBefore, scheduledAfter, tables, consoleLines.join("\n")]) {
      expect(text).not.toContain(keyRow?.ciphertext ?? "missing");
    }
    expect(consoleLines.join("\n")).not.toContain("SENTINEL_PROVIDER_TEXT");
  });
});

describe("sending a draft", () => {
  async function readyDraft(t: AiTest, d: Dealership): Promise<Id<"aiDrafts">> {
    const { draftId } = await t
      .withIdentity({ subject: d.subject })
      .mutation(api.aiDrafts.requestDraft, { orgId: d.orgId, customerId: d.customerId, platform: "instagram" });
    await drain(t);
    return draftId;
  }

  const send = (t: AiTest, d: Dealership, message: string, aiDraftId?: Id<"aiDrafts">) =>
    t.withIdentity({ subject: d.subject }).action(api.instagramEngagement.sendInstagramDirectMessage, {
      orgId: d.orgId,
      customerId: d.customerId,
      message,
      aiDraftId,
    });

  const newestDm = (t: AiTest) => t.run(async (ctx) => (await ctx.db.query("instagramEvents").take(5))[0]);

  test("a ready draft is linked once; a second send is delivered unlinked; a plain send clears the link", async () => {
    const { t, d } = await ready();
    const network = stubNetwork(() => draftReply("availability"));
    const draftId = await readyDraft(t, d);

    await send(t, d, "Edited by staff", draftId);
    expect((await newestDm(t))?.manualReplyAiDraftId).toBe(draftId);
    expect(await t.run((ctx) => ctx.db.get(draftId))).toMatchObject({
      sentBy: d.userId,
      sentText: "Edited by staff",
      sentAt: expect.any(Number),
    });

    await send(t, d, "Second text", draftId);
    expect(network.meta).toHaveLength(2);
    expect((await newestDm(t))?.manualReplyAiDraftId).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(draftId)))?.sentText).toBe("Edited by staff");

    const again = await readyDraft(t, d);
    await send(t, d, "Third text", again);
    expect((await newestDm(t))?.manualReplyAiDraftId).toBe(again);
    await send(t, d, "Plain text");
    expect((await newestDm(t))?.manualReplyAiDraftId).toBeUndefined();
    expect(network.meta).toHaveLength(4);
  });

  test("a ready draft is still linked when the platform switch was turned off after it was written", async () => {
    const { t, d } = await ready();
    stubNetwork(() => draftReply("availability"));
    const draftId = await readyDraft(t, d);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("aiSettings").first();
      if (row) await ctx.db.patch(row._id, { draftsEnabled: false });
    });
    await send(t, d, "Edited by staff", draftId);
    expect((await newestDm(t))?.manualReplyAiDraftId).toBe(draftId);
    expect(await t.run((ctx) => ctx.db.get(draftId))).toMatchObject({ sentBy: d.userId, sentText: "Edited by staff" });
  });

  test("a draft that is not ready is delivered unlinked", async () => {
    const { t, d } = await ready();
    const network = stubNetwork(() => anthropicError(500));
    const draftId = await readyDraft(t, d);
    expect((await t.run((ctx) => ctx.db.get(draftId)))?.status).toBe("failed");
    await send(t, d, "Typed by hand", draftId);
    expect(network.meta).toHaveLength(1);
    expect((await newestDm(t))?.manualReplyAiDraftId).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(draftId)))?.sentAt).toBeUndefined();
  });
});

describe("test connection and deletion", () => {
  test("only a super admin may test the connection; each provider outcome maps to a fixed code", async () => {
    const { t, d } = await ready();
    process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
    await t.run((ctx) => ctx.db.insert("users", { clerkId: "admin_x", email: "admin@autoflow.dev" }));
    const admin = t.withIdentity({ subject: "admin_x" });
    await expectAppError(
      t.withIdentity({ subject: d.subject }).action(api.aiAdmin.testProviderConnection, { provider: "anthropic" }),
      "FORBIDDEN",
      "Forbidden: Super-admin access only."
    );

    const model = (status: number) =>
      status === 200
        ? new Response(JSON.stringify({ id: "claude-opus-5-5", type: "model", display_name: "x", created_at: "2025-01-01T00:00:00Z" }), {
            status: 200,
            headers: { "content-type": "application/json", "x-should-retry": "false" },
          })
        : anthropicError(status);
    const cases: [number, unknown][] = [
      [200, { ok: true }],
      [401, { ok: false, code: "AUTH_FAILED" }],
      [404, { ok: false, code: "MODEL_UNAVAILABLE" }],
      [500, { ok: false, code: "PROVIDER_UNREACHABLE" }],
    ];
    for (const [status, expected] of cases) {
      stubNetwork(() => model(status));
      expect(await admin.action(api.aiAdmin.testProviderConnection, { provider: "anthropic" })).toEqual(expected);
    }
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("aiProviderKeys").take(2)) await ctx.db.delete(row._id);
    });
    expect(await admin.action(api.aiAdmin.testProviderConnection, { provider: "anthropic" })).toEqual({
      ok: false,
      code: "KEY_NOT_SET",
    });
    expect(JSON.stringify(consoleLines)).not.toContain(FAKE_KEY);
  });

  test("deleting the organization removes its drafts", async () => {
    const { t, d } = await ready();
    process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
    await t.run(async (ctx) => {
      await ctx.db.insert("users", { clerkId: "admin_x", email: "admin@autoflow.dev" });
      await ctx.db.insert("aiDrafts", {
        orgId: d.orgId,
        customerId: d.customerId,
        platform: "instagram",
        requestedBy: d.userId,
        requestedAt: Date.now(),
        status: "ready",
        draftText: "kept until deletion",
        model: "claude-opus-5-5",
      });
    });
    const { requestId } = await t
      .withIdentity({ subject: "admin_x" })
      .mutation(api.adminOrgs.hardDeleteOrg, { orgId: d.orgId, confirmName: "Acme Motors" });
    for (let i = 0; i < 300; i += 1) {
      const request = await t.run((ctx) => ctx.db.get(requestId));
      if (request?.status !== "RUNNING") break;
      await t.mutation(internal.adminOrgs.runDeletionRequestBatch, { requestId });
    }
    expect((await t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("COMPLETED");
    expect(await draftRows(t)).toHaveLength(0);
  });
});
