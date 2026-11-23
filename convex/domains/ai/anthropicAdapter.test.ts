// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { anthropicDraftProvider, testAnthropicConnection } from "./anthropicAdapter";
import { DRAFT_OUTPUT_SCHEMA, DRAFT_SYSTEM_PROMPT } from "./draftPrompt";

const DUMMY_KEY = "sk-ant-test-FAKE-DUMMYKEY0000000000";
const PROVIDER_MESSAGE = "SENTINEL_PROVIDER_ERROR_MESSAGE";
const USER_MESSAGE = "<dealership_data>\n</dealership_data>\n\n<customer_conversation>\ncustomer: hi\n</customer_conversation>";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

let calls: CapturedCall[] = [];

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function stubFetch(respond: () => Response | Promise<Response>): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input instanceof Request ? input.url : input),
        method: init?.method ?? "GET",
        headers: headersOf(init),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return respond();
    }),
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-should-retry": "false" },
  });
}

function message(text: string, stopReason = "end_turn"): Response {
  return json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 111, output_tokens: 22 },
  });
}

function errorBody(status: number): Response {
  return json({ type: "error", error: { type: "api_error", message: PROVIDER_MESSAGE } }, status);
}

const REQUEST = { apiKey: DUMMY_KEY, system: DRAFT_SYSTEM_PROMPT, user: USER_MESSAGE };

let consoleCalls: string[][] = [];

beforeEach(() => {
  consoleCalls = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args.map(String));
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function everythingLogged(): string {
  return JSON.stringify(consoleCalls);
}

describe("anthropicDraftProvider request", () => {
  test("posts the designed request to the fixed Anthropic URL", async () => {
    stubFetch(() => message(JSON.stringify({ outcome: "draft", text: "Hi there" })));
    await anthropicDraftProvider(REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.method).toBe("POST");
    const body: Record<string, unknown> = JSON.parse(calls[0]?.body ?? "{}");
    expect(body).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 8192,
      system: DRAFT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: USER_MESSAGE }],
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: DRAFT_OUTPUT_SCHEMA },
      },
    });
    for (const forbidden of ["tools", "tool_choice", "temperature", "top_p", "top_k", "thinking", "betas"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
    expect(calls[0]?.body).not.toContain(DUMMY_KEY);
  });

  test("environment variables cannot redirect the request", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://evil.example.test");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-FAKE-FROM-ENV");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "FAKE-TOKEN-FROM-ENV");
    vi.stubEnv("ANTHROPIC_LOG", "debug");
    stubFetch(() => message(JSON.stringify({ outcome: "draft", text: "Hi" })));
    await anthropicDraftProvider(REQUEST);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${DUMMY_KEY}`);
    expect(everythingLogged()).toBe("[]");
  });
});

describe("anthropicDraftProvider result mapping", () => {
  test("a valid answer returns the parsed output and the token counts", async () => {
    stubFetch(() => message(JSON.stringify({ outcome: "draft", text: "Hello {{DEALERSHIP_NAME}}" })));
    await expect(anthropicDraftProvider(REQUEST)).resolves.toEqual({
      ok: true,
      output: { outcome: "draft", text: "Hello {{DEALERSHIP_NAME}}" },
      model: "claude-opus-5-5",
      inputTokens: 111,
      outputTokens: 22,
    });
  });

  test("a needs_person answer is passed through", async () => {
    stubFetch(() => message(JSON.stringify({ outcome: "needs_person", text: "" })));
    await expect(anthropicDraftProvider(REQUEST)).resolves.toMatchObject({
      ok: true,
      output: { outcome: "needs_person", text: "" },
    });
  });

  test("stop_reason refusal is a refusal, whatever the text says", async () => {
    stubFetch(() => message(JSON.stringify({ outcome: "draft", text: "words" }), "refusal"));
    await expect(anthropicDraftProvider(REQUEST)).resolves.toEqual({ ok: false, reason: "refusal" });
  });

  test("stop_reason max_tokens is truncated", async () => {
    stubFetch(() => message('{"outcome":"draft","text":"cut o', "max_tokens"));
    await expect(anthropicDraftProvider(REQUEST)).resolves.toEqual({ ok: false, reason: "truncated" });
  });

  test.each([
    ["invalid JSON", "not json at all"],
    ["an unknown outcome", JSON.stringify({ outcome: "send_it", text: "x" })],
    ["a missing text", JSON.stringify({ outcome: "draft" })],
    ["a non-string text", JSON.stringify({ outcome: "draft", text: 5 })],
    ["a JSON array", "[]"],
  ])("%s is invalid_output", async (_name, text) => {
    stubFetch(() => message(text));
    await expect(anthropicDraftProvider(REQUEST)).resolves.toEqual({ ok: false, reason: "invalid_output" });
  });

  test("an answer without a text block is invalid_output", async () => {
    stubFetch(() =>
      json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    await expect(anthropicDraftProvider(REQUEST)).resolves.toEqual({ ok: false, reason: "invalid_output" });
  });
});

describe("anthropicDraftProvider error mapping", () => {
  test.each([
    [401, "provider_auth"],
    [403, "provider_auth"],
    [429, "provider_rate_limited"],
    [500, "provider_error"],
    [529, "provider_error"],
    [400, "provider_error"],
  ])("HTTP %i is %s, with no text", async (status, reason) => {
    stubFetch(() => errorBody(status));
    const result = await anthropicDraftProvider(REQUEST);
    expect(result).toEqual({ ok: false, reason });
    expect(JSON.stringify(result)).not.toContain(PROVIDER_MESSAGE);
  });

  test("a timeout is timeout", async () => {
    stubFetch(() => {
      throw Object.assign(new Error("request aborted"), { name: "AbortError" });
    });
    await expect(anthropicDraftProvider(REQUEST)).resolves.toEqual({ ok: false, reason: "timeout" });
  });

  test("any other thrown value is provider_error", async () => {
    stubFetch(() => {
      throw new TypeError(`fetch failed ${DUMMY_KEY}`);
    });
    await expect(anthropicDraftProvider(REQUEST)).resolves.toEqual({ ok: false, reason: "provider_error" });
  });

  test("the key and the provider message appear in no console call and no result", async () => {
    for (const status of [401, 429, 500]) {
      stubFetch(() => errorBody(status));
      const result = await anthropicDraftProvider(REQUEST);
      expect(JSON.stringify(result)).not.toContain(DUMMY_KEY);
    }
    stubFetch(() => {
      throw new TypeError(`fetch failed ${DUMMY_KEY}`);
    });
    await anthropicDraftProvider(REQUEST);
    const logged = everythingLogged();
    expect(logged).not.toContain(DUMMY_KEY);
    expect(logged).not.toContain("DUMMYKEY");
    expect(logged).not.toContain(PROVIDER_MESSAGE);
    expect(logged).not.toContain("dealership_data");
  });

  test("a failure logs the error class name and status only", async () => {
    stubFetch(() => errorBody(429));
    await anthropicDraftProvider(REQUEST);
    const lines = consoleCalls.map((args) => args.join(" "));
    expect(lines).toEqual(["[aiDraft] provider failure RateLimitError 429"]);
  });
});

describe("testAnthropicConnection", () => {
  test("a retrievable model is ok, via the fixed models URL", async () => {
    stubFetch(() => json({ id: "claude-opus-5-5", type: "model", display_name: "Opus", created_at: "2026-01-01T00:00:00Z" }));
    await expect(testAnthropicConnection({ apiKey: DUMMY_KEY })).resolves.toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/models/claude-opus-5-5");
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${DUMMY_KEY}`);
  });

  test.each([
    [401, "AUTH_FAILED"],
    [403, "AUTH_FAILED"],
    [404, "MODEL_UNAVAILABLE"],
    [429, "PROVIDER_UNREACHABLE"],
    [500, "PROVIDER_UNREACHABLE"],
  ])("HTTP %i is %s", async (status, code) => {
    stubFetch(() => errorBody(status));
    await expect(testAnthropicConnection({ apiKey: DUMMY_KEY })).resolves.toEqual({ ok: false, code });
  });

  test("a network failure is PROVIDER_UNREACHABLE and leaks nothing", async () => {
    stubFetch(() => {
      throw new TypeError(`fetch failed ${DUMMY_KEY}`);
    });
    await expect(testAnthropicConnection({ apiKey: DUMMY_KEY })).resolves.toEqual({
      ok: false,
      code: "PROVIDER_UNREACHABLE",
    });
    expect(everythingLogged()).not.toContain(DUMMY_KEY);
  });
});
