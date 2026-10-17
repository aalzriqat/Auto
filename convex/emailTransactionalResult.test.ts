import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

/**
 * SCRUM-807 weekly-report design rev5 §2: the shared transactional sender must
 * report what the provider actually answered. The Resend SDK (6.12.4) returns
 * `{ data, error }` and does not throw on API errors, so a sender that only
 * guards `await send()` with try/catch reports every refusal as success.
 *
 * Resend is stubbed at the client seam, so "reached the provider", the options
 * argument and the answer are observed directly. Nothing here sends mail.
 */

const MODULES = import.meta.glob("./**/*.ts");

const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

function setup() {
  const t = convexTestWithComponents(schema, MODULES);
  registerRateLimiter(t);
  return t;
}

function seedOrg(t: ReturnType<typeof setup>): Promise<Id<"organizations">> {
  return t.run((ctx) => ctx.db.insert("organizations", { name: "Bloom Cars", createdAt: Date.now() }));
}

const REPORT = {
  toEmail: "owner@bloom.test",
  orgName: "Bloom Cars",
  pageViews: 10,
  vehicleDetailViews: 4,
  requestsMatched: 2,
  responsesSent: 1,
  avgResponseMinutes: 12,
  mostViewedVehicle: null,
  requestsLost: 0,
} as const;

async function sendWeekly(t: ReturnType<typeof setup>, extra: { idempotencyKey?: string } = {}) {
  const orgId = await seedOrg(t);
  return t.action(internal.email.sendMarketplaceWeeklyReportEmail, { orgId, ...REPORT, ...extra });
}

async function sendReminder(t: ReturnType<typeof setup>) {
  const orgId = await seedOrg(t);
  return t.action(internal.email.sendSubscriptionReminderEmail, {
    orgId,
    toEmail: "owner@bloom.test",
    orgName: "Bloom Cars",
    kind: "renewal_due",
    planName: "Pro",
    endsAt: Date.UTC(2026, 10, 1),
  });
}

function providerError(name: string, statusCode: number | null) {
  return { data: null, error: { name, statusCode, message: "owner@bloom.test refused" } };
}

/** The webhook log rows the sender writes, newest last. */
async function sentLogs(t: ReturnType<typeof setup>, source: string) {
  const rows = await t.run((ctx) => ctx.db.query("webhookLogs").take(100));
  return rows.filter((r) => r.source === source);
}

/**
 * RESEND_API_KEY is optional in the validated env but, when present, must start
 * with "re_" — an empty string fails validation before any sender runs. "No
 * key" is therefore the variable being absent, never blank.
 */
function unsetResendKey() {
  vi.stubEnv("RESEND_API_KEY", undefined);
}

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test_key_not_real");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  resendSend.mockReset();
});

/** Everything the sender wrote to the server log. */
function serverLog(): string {
  return errorLog.mock.calls.flat().map(String).join("\n");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a provider answer is reported honestly", () => {
  test("accepted: reports the provider id and providerAccepted", async () => {
    resendSend.mockResolvedValue({ data: { id: "email_123" }, error: null });
    const t = setup();

    const result = await sendWeekly(t);

    expect(result).toMatchObject({
      success: true,
      outcome: "accepted",
      providerAccepted: true,
      resendEmailId: "email_123",
    });
  });

  test("a resolved { data: null, error } is a failure, not a success (the original bug)", async () => {
    resendSend.mockResolvedValue(providerError("validation_error", 422));
    const t = setup();

    const result = await sendWeekly(t);

    expect(result).toMatchObject({ success: false, outcome: "rejected", providerAccepted: false });
    const logs = await sentLogs(t, "marketplace-weekly-report");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: "error" });
  });

  test("error detail returned and logged carries the provider code, never its message or the address", async () => {
    resendSend.mockResolvedValue(providerError("validation_error", 422));
    const t = setup();

    const result = await sendWeekly(t);

    const logs = await sentLogs(t, "marketplace-weekly-report");
    const surfaced = JSON.stringify({ result, logs: logs.map((l) => l.error) });
    expect(surfaced).toContain("validation_error");
    expect(surfaced).not.toContain("refused");
    expect(surfaced).not.toContain("re_test_key_not_real");
    expect(String(result.error)).not.toContain("owner@bloom.test");
  });

  test.each([
    ["validation_error", 422],
    ["invalid_from_address", 422],
    ["missing_api_key", 401],
    ["invalid_api_key", 403],
    ["restricted_api_key", 401],
    ["daily_quota_exceeded", 429],
    ["monthly_quota_exceeded", 429],
    ["rate_limit_exceeded", 429],
  ])("%s is a definite refusal", async (name, status) => {
    resendSend.mockResolvedValue(providerError(name, status));
    const t = setup();

    const result = await sendWeekly(t);

    expect(result).toMatchObject({ success: false, outcome: "rejected", providerAccepted: false });
  });

  test("only a rate limit is marked retryable among definite refusals", async () => {
    const t = setup();
    resendSend.mockResolvedValueOnce(providerError("rate_limit_exceeded", 429));
    expect(await sendWeekly(t)).toMatchObject({ outcome: "rejected", retryable: true });

    resendSend.mockResolvedValueOnce(providerError("validation_error", 422));
    expect(await sendWeekly(t)).toMatchObject({ outcome: "rejected", retryable: false });
  });

  test.each([
    ["internal_server_error", 500],
    ["application_error", null],
    ["concurrent_idempotent_requests", 409],
    ["invalid_idempotent_request", 409],
    ["a_name_resend_added_later", 418],
  ])("%s does not prove the email was not sent, so it is ambiguous", async (name, status) => {
    resendSend.mockResolvedValue(providerError(name, status));
    const t = setup();

    const result = await sendWeekly(t);

    expect(result).toMatchObject({ success: false, outcome: "ambiguous", providerAccepted: false });
  });

  test.each([
    ["data is empty", { data: {}, error: null }],
    ["data is null", { data: null, error: null }],
    ["the id is blank", { data: { id: "" }, error: null }],
  ])("no error but no email id (%s) is not an acceptance", async (_label, answer) => {
    resendSend.mockResolvedValue(answer);
    const t = setup();

    const result = await sendWeekly(t);

    expect(result).toMatchObject({ success: false, outcome: "ambiguous", providerAccepted: false });
    expect(result.resendEmailId).toBeUndefined();
  });

  test("a thrown transport error is ambiguous and neither the result nor the webhook log carries its detail", async () => {
    resendSend.mockRejectedValue(new Error("socket hang up for owner@bloom.test"));
    const t = setup();

    const result = await sendWeekly(t);

    expect(result).toMatchObject({ success: false, outcome: "ambiguous", providerAccepted: false });
    expect(JSON.stringify(result)).not.toContain("owner@bloom.test");
    const logs = await sentLogs(t, "marketplace-weekly-report");
    expect(JSON.stringify(logs.map((l) => l.error))).not.toContain("owner@bloom.test");
  });

  test("the server log keeps diagnosable detail for a provider answer, with the address and key masked", async () => {
    resendSend.mockResolvedValue({
      data: null,
      error: {
        name: "validation_error",
        statusCode: 422,
        message: "The `to` field owner@bloom.test is invalid (key re_test_key_not_real)",
      },
    });
    const t = setup();

    await sendWeekly(t);

    const logged = serverLog();
    expect(logged).toContain("marketplace-weekly-report");
    expect(logged).toContain("code=validation_error");
    expect(logged).toContain("status=422");
    expect(logged).toContain("is invalid");
    expect(logged).not.toContain("owner@bloom.test");
    expect(logged).not.toContain("re_test_key_not_real");
  });

  test("the server log keeps the class and masked message of a thrown error", async () => {
    resendSend.mockRejectedValue(new TypeError("fetch failed for owner@bloom.test"));
    const t = setup();

    await sendWeekly(t);

    const logged = serverLog();
    expect(logged).toContain("TypeError");
    expect(logged).toContain("fetch failed");
    expect(logged).not.toContain("owner@bloom.test");
  });

  test("no Resend key is a mock: success for existing callers, but never provider-accepted", async () => {
    unsetResendKey();
    const t = setup();

    const result = await sendWeekly(t);

    expect(resendSend).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, outcome: "mock", providerAccepted: false });
    expect(result.resendEmailId).toBeUndefined();
  });
});

describe("a preview egress sink is a mock, not a provider answer", () => {
  test("with a key present on a sunk preview nothing is sent and the result is mock", async () => {
    vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", "preview");
    vi.stubEnv("CONVEX_CLOUD_URL", "https://combative-gerbil-860.convex.cloud");
    const t = setup();

    const result = await sendWeekly(t);

    expect(resendSend).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true, outcome: "mock", providerAccepted: false });
  });
});

describe("idempotency key and frozen envelope", () => {
  test("the key is forwarded as the SDK's second argument and the envelope is passed whole", async () => {
    resendSend.mockResolvedValue({ data: { id: "email_1" }, error: null });
    const t = setup();

    await sendWeekly(t, { idempotencyKey: "mpw:2026-W42:org_1" });

    expect(resendSend).toHaveBeenCalledTimes(1);
    const [payload, options] = resendSend.mock.calls[0];
    expect(options).toEqual({ idempotencyKey: "mpw:2026-W42:org_1" });
    expect(payload).toMatchObject({
      from: "AutoFlow Marketplace <marketplace@autoflowdealer.com>",
      to: "owner@bloom.test",
    });
    expect(typeof payload.subject).toBe("string");
    expect(typeof payload.html).toBe("string");
  });

  test("without a key no options argument is sent (existing behaviour)", async () => {
    resendSend.mockResolvedValue({ data: { id: "email_1" }, error: null });
    const t = setup();

    await sendWeekly(t);

    expect(resendSend.mock.calls[0]).toHaveLength(1);
  });

  test("repeating a send with the same key and inputs hands the provider the same payload and options (nothing is persisted here)", async () => {
    resendSend.mockResolvedValue({ data: { id: "email_1" }, error: null });
    const t = setup();
    const orgId = await seedOrg(t);
    const args = { orgId, ...REPORT, idempotencyKey: "mpw:2026-W42:org_1" };

    await t.action(internal.email.sendMarketplaceWeeklyReportEmail, args);
    await t.action(internal.email.sendMarketplaceWeeklyReportEmail, args);

    expect(resendSend.mock.calls[1][0]).toEqual(resendSend.mock.calls[0][0]);
    expect(resendSend.mock.calls[1][1]).toEqual(resendSend.mock.calls[0][1]);
  });

  test("a key over Resend's 256-character limit is refused locally and never reaches the provider", async () => {
    const t = setup();

    const result = await sendWeekly(t, { idempotencyKey: "k".repeat(257) });

    expect(resendSend).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, outcome: "rejected", retryable: false, providerAccepted: false });
  });

  test("an explicitly empty key is refused locally, never sent unkeyed", async () => {
    const t = setup();

    const result = await sendWeekly(t, { idempotencyKey: "" });

    expect(resendSend).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false, outcome: "rejected", retryable: false, providerAccepted: false });
  });

  test("the 1- and 256-character boundaries are accepted and forwarded", async () => {
    resendSend.mockResolvedValue({ data: { id: "email_1" }, error: null });
    const t = setup();

    await sendWeekly(t, { idempotencyKey: "k" });
    await sendWeekly(t, { idempotencyKey: "k".repeat(256) });

    expect(resendSend.mock.calls.map((call) => call[1])).toEqual([
      { idempotencyKey: "k" },
      { idempotencyKey: "k".repeat(256) },
    ]);
  });

  test("the provider's own invalid_idempotency_key answer is a definite refusal", async () => {
    resendSend.mockResolvedValue(providerError("invalid_idempotency_key", 400));
    const t = setup();

    const result = await sendWeekly(t, { idempotencyKey: "mpw:2026-W42:org_1" });

    expect(result).toMatchObject({ success: false, outcome: "rejected", retryable: false, providerAccepted: false });
  });
});

describe("the subscription reminder keeps its contract", () => {
  test("accepted keeps { success: true } and gains the honest fields", async () => {
    resendSend.mockResolvedValue({ data: { id: "email_9" }, error: null });
    const t = setup();

    const result = await sendReminder(t);

    expect(result).toMatchObject({ success: true, outcome: "accepted", providerAccepted: true });
    expect(resendSend.mock.calls[0]).toHaveLength(1);
  });

  test("a provider refusal is now reported instead of being logged as success", async () => {
    resendSend.mockResolvedValue(providerError("validation_error", 422));
    const t = setup();

    const result = await sendReminder(t);

    expect(result).toMatchObject({ success: false, outcome: "rejected" });
    const logs = await sentLogs(t, "subscription-reminder");
    expect(logs[0]).toMatchObject({ status: "error" });
  });

  test("no key stays a successful mock", async () => {
    unsetResendKey();
    const t = setup();

    expect(await sendReminder(t)).toMatchObject({ success: true, outcome: "mock", providerAccepted: false });
  });
});

describe("the early rate-limit return is unchanged", () => {
  test("the per-org bulk budget still answers { success: false, error: 'rate_limited' } without calling the provider", async () => {
    resendSend.mockResolvedValue({ data: { id: "email_1" }, error: null });
    const t = setup();
    const orgId = await seedOrg(t);

    let limited: { success: boolean; error?: string } | undefined;
    let accepted = 0;
    for (let i = 0; i < 30 && !limited; i += 1) {
      const r = await t.action(internal.email.sendMarketplaceWeeklyReportEmail, { orgId, ...REPORT });
      if (r.success) accepted += 1;
      else limited = r;
    }

    expect(limited).toMatchObject({ success: false, error: "rate_limited" });
    // The refused send never reached the provider: one provider call per accepted send, none for the limited one.
    expect(accepted).toBeGreaterThan(0);
    expect(resendSend).toHaveBeenCalledTimes(accepted);
  });
});
