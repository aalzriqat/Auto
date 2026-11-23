// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { FAKE_KEY, MASTER_KEY, draftReply, drain, pauseScheduler, seedDealership, stubNetwork, switchOnAi } from "../test-utils/aiDraftsFixture";
import type { AiTest, Dealership } from "../test-utils/aiDraftsFixture";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { runGenerateDraft } from "./domains/ai/draftLifecycle";
import type { DraftJob } from "./domains/ai/draftJob";

const SENTINEL = "SENTINEL_OBJECT_CONTENT_5150";
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

async function ready(): Promise<{ t: AiTest; d: Dealership }> {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const d = await seedDealership(t);
  await switchOnAi(t, d);
  return { t, d };
}

const requestDraft = async (t: AiTest, d: Dealership): Promise<Id<"aiDrafts">> =>
  (
    await t
      .withIdentity({ subject: d.subject })
      .mutation(api.aiDrafts.requestDraft, { orgId: d.orgId, customerId: d.customerId, platform: "instagram" })
  ).draftId;

const sinkOn = () => {
  process.env.AUTOFLOW_DEPLOYMENT_CLASS = "preview";
  process.env.CONVEX_CLOUD_URL = "https://preview-deployment-123.convex.cloud";
};

/** A stored key that cannot be opened: the master key changed after it was sealed. */
const breakMasterKey = () => {
  process.env.AI_KEY_ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
};

describe("a sunk egress channel is checked before the stored key is opened", () => {
  test("the draft job ends egress_sunk even when the key could not be opened", async () => {
    const { t, d } = await ready();
    const network = stubNetwork(() => draftReply("greeting"));
    const draftId = await requestDraft(t, d);
    breakMasterKey();
    sinkOn();
    await drain(t);
    expect(await t.run((ctx) => ctx.db.get(draftId))).toMatchObject({ status: "failed", failureReason: "egress_sunk" });
    expect(network.anthropic).toHaveLength(0);
  });

  test("control: with the sink off the same unopenable key ends key_unavailable", async () => {
    const { t, d } = await ready();
    stubNetwork(() => draftReply("greeting"));
    const draftId = await requestDraft(t, d);
    breakMasterKey();
    await drain(t);
    expect(await t.run((ctx) => ctx.db.get(draftId))).toMatchObject({ status: "failed", failureReason: "key_unavailable" });
  });
});

describe("a stored key sealed under another master key (PR 878 Seat 1 LOW-4)", () => {
  /** The values that must never reach a log line: ciphertext, IV, the dummy plaintext and the decrypt error text. */
  async function secretsOf(t: AiTest): Promise<string[]> {
    const row = await t.run((ctx) => ctx.db.query("aiProviderKeys").first());
    return [row!.ciphertext, row!.iv, FAKE_KEY, "could not be decrypted"];
  }

  test("the draft job makes no provider call, stores no text and logs the error class only", async () => {
    const { t, d } = await ready();
    const network = stubNetwork(() => draftReply("greeting"));
    const draftId = await requestDraft(t, d);
    breakMasterKey();
    await drain(t);
    const row = await t.run((ctx) => ctx.db.get(draftId));
    expect(row).toMatchObject({ status: "failed", failureReason: "key_unavailable" });
    expect(row?.draftText).toBeUndefined();
    expect(network.anthropic).toHaveLength(0);
    expect(network.meta).toHaveLength(0);
    expect(consoleLines).toEqual(["AI draft key decryption failed Error"]);
    for (const secret of await secretsOf(t)) expect(consoleLines.join("\n")).not.toContain(secret);
  });

  test("the admin connection test reports a fixed code, calls no provider and logs the error class only", async () => {
    const { t } = await ready();
    process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
    await t.run((ctx) => ctx.db.insert("users", { clerkId: "admin_x", email: "admin@autoflow.dev" }));
    const network = stubNetwork(() => draftReply("greeting"));
    breakMasterKey();
    const result = await t
      .withIdentity({ subject: "admin_x" })
      .action(api.aiAdmin.testProviderConnection, { provider: "anthropic" });
    expect(result).toEqual({ ok: false, code: "ENCRYPTION_NOT_CONFIGURED" });
    expect(network.anthropic).toHaveLength(0);
    expect(consoleLines).toEqual(["AI key test decryption failed Error"]);
    for (const secret of await secretsOf(t)) expect(consoleLines.join("\n")).not.toContain(secret);
  });
});

describe("the connection test with a sunk egress channel", () => {

  test("the connection test reports EGRESS_SUNK, and KEY_NOT_SET still comes first", async () => {
    const { t } = await ready();
    process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
    await t.run((ctx) => ctx.db.insert("users", { clerkId: "admin_x", email: "admin@autoflow.dev" }));
    const admin = t.withIdentity({ subject: "admin_x" });
    breakMasterKey();
    sinkOn();
    expect(await admin.action(api.aiAdmin.testProviderConnection, { provider: "anthropic" })).toEqual({
      ok: false,
      code: "EGRESS_SUNK",
    });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("aiProviderKeys").take(2)) await ctx.db.delete(row._id);
    });
    expect(await admin.action(api.aiAdmin.testProviderConnection, { provider: "anthropic" })).toEqual({
      ok: false,
      code: "KEY_NOT_SET",
    });
  });
});

describe("a failing internal call never leaks its message", () => {
  // A validator failure message carries the whole object. The two calls are
  // injected because a stored row cannot be made to disagree with its validator.
  const leaky = () => new TypeError(`ReturnsValidationError: Object: {conversation: "${SENTINEL}", ciphertext: "${SENTINEL}"}`);
  const okJob = { ok: false, reason: "not_enabled" } satisfies DraftJob;

  test("a failing job loader is logged by class only and ends the draft as failed", async () => {
    const outcomes: unknown[] = [];
    await runGenerateDraft({
      load: async () => {
        throw leaky();
      },
      complete: async (outcome) => {
        outcomes.push(outcome);
      },
    });
    expect(outcomes).toEqual([{ status: "failed", failureReason: "provider_error" }]);
    expect(consoleLines.length).toBeGreaterThan(0);
    expect(JSON.stringify(consoleLines)).not.toContain(SENTINEL);
    expect(consoleLines.join("\n")).toContain("TypeError");
  });

  test("a failing completion is logged by class only and does not escape", async () => {
    await expect(
      runGenerateDraft({
        load: async () => okJob,
        complete: async () => {
          throw leaky();
        },
      })
    ).resolves.toBeUndefined();
    expect(consoleLines.length).toBeGreaterThan(0);
    expect(JSON.stringify(consoleLines)).not.toContain(SENTINEL);
  });

  test("a failing loader and a failing completion together still leak nothing", async () => {
    await expect(
      runGenerateDraft({
        load: async () => {
          throw leaky();
        },
        complete: async () => {
          throw leaky();
        },
      })
    ).resolves.toBeUndefined();
    expect(JSON.stringify(consoleLines)).not.toContain(SENTINEL);
  });
});

describe("handlers and their validators agree on every variant", () => {
  test("loadDraftJob returns each variant through its returns validator", async () => {
    const { t, d } = await ready();
    const draftId = await requestDraft(t, d);
    const load = () => t.query(internal.aiDrafts.loadDraftJob, { draftId });

    const ok = await load();
    if (!ok.ok) throw new Error(`job refused: ${ok.reason}`);
    expect(Object.keys(ok).sort()).toEqual(["conversation", "ok", "sealedKey", "sentences"]);
    expect(ok.conversation).toEqual([{ direction: "customer", text: "Is this car still available?" }]);
    expect(ok.sentences.en.price).toBe("Qin L (2025) is priced at 25000 JD. Would you like a sales rep to follow up?");
    expect(ok.sentences.ar.location).toBe("يمكنك زيارتنا في Acme Motors, 1 Main Street.");

    await t.run(async (ctx) => {
      const events = await ctx.db.query("instagramEvents").take(5);
      for (const event of events) await ctx.db.delete(event._id);
    });
    expect(await load()).toEqual({ ok: false, reason: "no_conversation" });

    await t.run(async (ctx) => {
      const row = await ctx.db.query("aiSettings").first();
      if (row) await ctx.db.patch(row._id, { draftsEnabled: false });
    });
    expect(await load()).toEqual({ ok: false, reason: "not_enabled" });

    await t.run((ctx) => ctx.db.patch(d.orgId, { suspended: true }));
    expect(await load()).toEqual({ ok: false, reason: "org_unavailable" });

    await t.run((ctx) => ctx.db.patch(draftId, { status: "failed", failureReason: "timeout" }));
    expect(await load()).toEqual({ ok: false, reason: "not_pending" });
    // key_missing is unreachable here: the enabled check already requires a
    // stored key, so not_enabled is returned first.
  });

  const pendingRow = (t: AiTest, d: Dealership) =>
    t.run((ctx) =>
      ctx.db.insert("aiDrafts", {
        orgId: d.orgId,
        customerId: d.customerId,
        platform: "instagram",
        requestedBy: d.userId,
        requestedAt: Date.now(),
        status: "pending",
        model: "claude-opus-5-5",
      })
    );

  const usage = { model: "claude-opus-5-5", inputTokens: 10, outputTokens: 5 };

  test.each([
    ["ready", { status: "ready", text: "Hello", handoverFallback: false, ...usage }, { status: "ready", handoverFallback: false }],
    ["ready with the handover fallback", { status: "ready", text: "Hand over", handoverFallback: true, ...usage }, { status: "ready", handoverFallback: true }],
    ["needs_person", { status: "needs_person", ...usage }, { status: "needs_person" }],
  ] as const)("completeDraft accepts %s", async (_label, outcome, expected) => {
    const { t, d } = await ready();
    const draftId = await pendingRow(t, d);
    await t.mutation(internal.aiDrafts.completeDraft, { draftId, outcome });
    expect(await t.run((ctx) => ctx.db.get(draftId))).toMatchObject(expected);
  });

  test.each([
    "timeout", "provider_error", "provider_auth", "provider_rate_limited", "refusal",
    "truncated", "invalid_output", "key_unavailable", "egress_sunk", "not_enabled",
  ] as const)("completeDraft accepts a failure with reason %s", async (failureReason) => {
    const { t, d } = await ready();
    const draftId = await pendingRow(t, d);
    await t.mutation(internal.aiDrafts.completeDraft, { draftId, outcome: { status: "failed", failureReason } });
    expect(await t.run((ctx) => ctx.db.get(draftId))).toMatchObject({ status: "failed", failureReason });
  });
});
