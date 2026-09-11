/**
 * The rehearsal runner's REFUSALS, proved rather than asserted.
 *
 * Everything worth testing here is a way the rehearsal could quietly run
 * somewhere it must not, or report success it did not earn. The orchestration
 * itself only runs in CI against a live preview and is not simulated here — a
 * mock of a Convex deployment would test the mock.
 */
import { describe, expect, test } from "vitest";
import {
  assertRehearsalEnv,
  convexCall,
  isClerkSessionId,
  isPreviewCloudUrl,
  mintConvexToken,
  recordCase,
  rehearsalRefScope,
  sanitizeClerkSessionId,
  summarize,
  unproven,
  exitCodeForSummary,
  bannerForSummary,
} from "./accountingPreviewRehearsal.mjs";
import { previewNameForRef } from "./e2ePreviewBootstrap.mjs";

const VALID = {
  CONVEX_DEPLOY_KEY: "preview:acme:proj|abcdef",
  CONVEX_PREVIEW_NAME: "rehearsal-branch-0123456789",
  NEXT_PUBLIC_CONVEX_URL: "https://fine-gerbil-123.convex.cloud",
  CLERK_SECRET_KEY: "sk_test_xxx",
  E2E_LOGIN_USER: "sales@example.test",
  E2E_APPROVER_USER: "approver@example.test",
};

describe("the rehearsal refuses rather than degrades", () => {
  test("it accepts a complete, preview-shaped environment", () => {
    const config = assertRehearsalEnv({ ...VALID });
    expect(config.convexUrl).toBe("https://fine-gerbil-123.convex.cloud");
    expect(config.previewName).toBe("rehearsal-branch-0123456789");
  });

  test.each([
    "CONVEX_DEPLOY_KEY",
    "CONVEX_PREVIEW_NAME",
    "NEXT_PUBLIC_CONVEX_URL",
    "CLERK_SECRET_KEY",
    "E2E_LOGIN_USER",
    "E2E_APPROVER_USER",
  ])("a missing %s is a refusal, never a default", (key) => {
    const env = { ...VALID, [key]: "" };
    expect(() => assertRehearsalEnv(env)).toThrow(new RegExp(key));
  });

  test.each([
    ["prod", "prod:acme:proj|abcdef"],
    ["dev", "dev:acme:proj|abcdef"],
    ["project", "project:acme:proj|abcdef"],
    ["a bare admin key", "acme|abcdef"],
  ])("a %s deploy key is refused before any argument is assembled", (_label, key) => {
    // The single most important refusal in this file: every one of these keys
    // can reach a REAL deployment, and `convex run` — unlike `--preview-create`
    // — does not refuse them on its own.
    expect(() => assertRehearsalEnv({ ...VALID, CONVEX_DEPLOY_KEY: key })).toThrow(/PREVIEW deploy key/);
  });

  test.each([
    ["a local backend", "http://127.0.0.1:3210"],
    ["a bare hostname", "fine-gerbil-123.convex.cloud"],
    ["something else entirely", "https://example.com"],
  ])("%s is refused as a target URL", (_label, url) => {
    expect(() => assertRehearsalEnv({ ...VALID, NEXT_PUBLIC_CONVEX_URL: url })).toThrow(/Convex cloud deployment URL/);
  });
});

describe("the rehearsal preview is a DIFFERENT destructive key from the browser suite's", () => {
  test("the same ref yields a different preview name for the rehearsal", () => {
    // `--preview-create` DELETES the deployment it names. If this job and the
    // Playwright job derived the same name from the same branch, the rehearsal
    // would destroy the browser suite's backend mid-run — the exact failure the
    // Playwright workflow's own naming comment records. They are in different
    // concurrency groups, so they must be in different names.
    const ref = "refs/heads/agent/accounting-rc-integration";
    const browserName = previewNameForRef({ ref, prNumber: "299" });
    const rehearsalName = previewNameForRef({ ref: rehearsalRefScope(ref), prNumber: "299" });
    expect(rehearsalName).not.toBe(browserName);
  });

  test("the scope is deterministic, so re-running a branch reuses its own preview", () => {
    expect(rehearsalRefScope("refs/heads/x")).toBe(rehearsalRefScope("refs/heads/x"));
    expect(rehearsalRefScope("refs/heads/x")).not.toBe(rehearsalRefScope("refs/heads/y"));
  });
});

describe("convexCall reports failures as data, not exceptions", () => {
  const fakeFetch = (payload: unknown, status = 200) =>
    async () => ({ status, text: async () => JSON.stringify(payload) }) as unknown as Response;

  test("a success carries the value through", async () => {
    const result = await convexCall(
      { convexUrl: "https://x.convex.cloud", token: "t", kind: "query", path: "a:b", args: {} },
      fakeFetch({ status: "success", value: 42 }) as unknown as typeof fetch
    );
    expect(result).toEqual({ ok: true, value: 42 });
  });

  test("a ConvexError's message is surfaced, not the wrapper", async () => {
    const result = await convexCall(
      { convexUrl: "https://x.convex.cloud", token: "t", kind: "mutation", path: "a:b", args: {} },
      fakeFetch({ status: "error", errorData: { message: "nothing left to refund" } }) as unknown as typeof fetch
    );
    expect(result).toEqual({ ok: false, error: "nothing left to refund" });
  });

  test("a non-JSON body is a hard failure, because it usually means the wrong URL", async () => {
    const notJson = async () => ({ status: 502, text: async () => "<html>bad gateway" }) as unknown as Response;
    await expect(
      convexCall(
        { convexUrl: "https://x.convex.cloud", token: "t", kind: "query", path: "a:b", args: {} },
        notJson as unknown as typeof fetch
      )
    ).rejects.toThrow(/non-JSON response/);
  });
});

describe("token minting surfaces a denial instead of working around it", () => {
  test("a refused session says so, and names why no bypass was added", async () => {
    const denied = async () => ({ ok: false, status: 403, text: async () => "forbidden" }) as unknown as Response;
    await expect(
      mintConvexToken({ userId: "user_1", secretKey: "sk_test" }, denied as unknown as typeof fetch)
    ).rejects.toThrow(/refused to create a session/);
  });

  test("a session without a convex-template token is refused too", async () => {
    let call = 0;
    const partial = async () => {
      call += 1;
      if (call === 1) {
        return { ok: true, json: async () => ({ id: "sess_2abcDEF3456789ghijk" }) } as unknown as Response;
      }
      return { ok: false, status: 404, text: async () => "no template" } as unknown as Response;
    };
    await expect(
      mintConvexToken({ userId: "user_1", secretKey: "sk_test" }, partial as unknown as typeof fetch)
    ).rejects.toThrow(/`convex` template token/);
  });

  test("a malformed session id from Clerk never reaches the token URL", async () => {
    // The SSRF shape Sonar flagged, as a behavioural test rather than a promise:
    // if the remote response carries a traversal, the SECOND request — the one
    // that would carry the Clerk secret to the wrong path — must never be made.
    let calls = 0;
    const hostile = async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, json: async () => ({ id: "sess_../../../../tokens" }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({ jwt: "should-never-be-reached" }) } as unknown as Response;
    };
    await expect(
      mintConvexToken({ userId: "user_1", secretKey: "sk_test" }, hostile as unknown as typeof fetch)
    ).rejects.toThrow(/does not match the expected/);
    expect(calls, "the token request must not have been attempted").toBe(1);
  });
});

describe("values that reach a URL are validated before they get there", () => {
  test.each([
    ["a path traversal", "sess_../../../admin"],
    ["an absolute URL", "https://evil.example/x"],
    ["a protocol-relative URL", "//evil.example"],
    ["an empty id", ""],
    ["a non-string", null],
  ])("%s is refused as a Clerk session id", (_label, value) => {
    // These reach a URL PATH on an authenticated request carrying the Clerk
    // secret. A response is not trustworthy input just because the host is.
    expect(isClerkSessionId(value as string)).toBe(false);
  });

  test("a real Clerk session id is accepted", () => {
    expect(isClerkSessionId("sess_2abcDEF3456789ghijk")).toBe(true);
  });

  test("the id that reaches the URL is REBUILT from the matched characters", () => {
    // Not merely validated. Testing a value and then using the original leaves
    // the untrusted string flowing into the request; reconstructing means what
    // reaches the URL can only ever be `sess_` plus admitted characters.
    expect(sanitizeClerkSessionId("sess_2abcDEF3456789ghijk")).toBe("sess_2abcDEF3456789ghijk");
    expect(sanitizeClerkSessionId("sess_../../../admin")).toBeNull();
    expect(sanitizeClerkSessionId("https://evil.example")).toBeNull();
    expect(sanitizeClerkSessionId(undefined)).toBeNull();
  });

  test.each([
    ["a local backend", "http://127.0.0.1:3210"],
    ["an attacker host", "https://evil.example"],
    ["a path suffix", "https://x.convex.cloud/evil"],
  ])("%s is refused as a mutation target", (_label, value) => {
    expect(isPreviewCloudUrl(value)).toBe(false);
  });

  test("a Convex cloud deployment URL is accepted", () => {
    expect(isPreviewCloudUrl("https://energized-pheasant-272.convex.cloud")).toBe(true);
  });
});

describe("case recording keeps a failure as evidence", () => {
  test("a thrown assertion becomes a FAIL record rather than aborting the run", async () => {
    const results: Array<Record<string, unknown>> = [];
    await recordCase(results, "X1", "a case that fails", () => {
      throw new Error("released 4000, expected 2000");
    });
    await recordCase(results, "X2", "a case that passes", () => ({ released: 2000 }));
    expect(results.map((r) => r.status)).toEqual(["FAIL", "PASS"]);
    expect(results[0].detail).toMatch(/released 4000/);
    expect(summarize(results)).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      failedIds: ["X1"],
      unproven: 0,
      unprovenIds: [],
      complete: false,
    });
  });

  test("a case that could not be tested is UNPROVEN, and the run is not complete", async () => {
    // The whole point of the third status: this run found no defect AND
    // demonstrated nothing. Counting it as a pass would let a rehearsal that
    // skipped a requirement be quoted as one that met it.
    const results: Array<Record<string, unknown>> = [];
    await recordCase(results, "P1", "a case that could not run", () => {
      unproven("no OPEN period existed to close");
    });
    await recordCase(results, "A1", "a case that ran", () => ({ ok: true }));
    expect(results.map((r) => r.status)).toEqual(["UNPROVEN", "PASS"]);
    const summary = summarize(results);
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(1);
    expect(summary.unproven).toBe(1);
    expect(summary.unprovenIds).toEqual(["P1"]);
    expect(summary.complete).toBe(false);
  });

  test("the process exit code is non-zero for UNPROVEN, not only for FAIL (Sonnet F1b / Codex RG-02)", () => {
    // Both seats found this independently: an UNPROVEN case returned 0, so an
    // INCOMPLETE rehearsal was a GREEN job. That was my deliberate design and it
    // was wrong by this repository's own rule — an unexecuted gate is
    // UNAVAILABLE, never PASS. To a release gate, 'could not test it' and 'it
    // failed' are the same answer: not certified. The JSON and the banner keep
    // the two distinct because they invite different responses.
    const base = { total: 3, passed: 3, failed: 0, failedIds: [], unproven: 0, unprovenIds: [], complete: true };
    expect(exitCodeForSummary(base)).toBe(0);
    expect(exitCodeForSummary({ ...base, passed: 2, failed: 1, failedIds: ["D2"], complete: false })).toBe(1);
    expect(exitCodeForSummary({ ...base, passed: 2, unproven: 1, unprovenIds: ["P1"], complete: false })).toBe(1);
    // Distinguishable in the banner, identical at the process boundary.
    expect(bannerForSummary({ ...base, passed: 2, unproven: 1, unprovenIds: ["P1"], complete: false })).toMatch(
      /INCOMPLETE — NOT CERTIFIED.*P1/
    );
    expect(bannerForSummary({ ...base, passed: 2, failed: 1, failedIds: ["D2"], complete: false })).toMatch(/FAILED.*D2/);
    expect(bannerForSummary(base)).toMatch(/REHEARSAL PASSED: 3 of 3/);
  });

  test("an all-passing run reports no failures", () => {
    expect(summarize([{ id: "A", status: "PASS" }])).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      failedIds: [],
      unproven: 0,
      unprovenIds: [],
      complete: true,
    });
  });
});

test("a run that both FAILED and left cases UNPROVEN names BOTH lists in the banner (Sonnet MAX LOW)", () => {
  const banner = bannerForSummary({
    total: 5,
    passed: 2,
    failed: 2,
    failedIds: ["D2", "D3"],
    unproven: 1,
    unprovenIds: ["C1"],
    complete: false,
  });
  expect(banner).toMatch(/FAILED: 2 of 5/);
  expect(banner).toMatch(/D2, D3/);
  expect(banner).toMatch(/1 UNPROVEN \(C1\)/);
});
