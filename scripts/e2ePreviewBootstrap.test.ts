/**
 * SCRUM-143 — the targeting guard, tested against what it is actually for.
 *
 * ⚠️ NONE of these are cases where the command would have ERRORED. Every one is
 * a case where `convex run` would have succeeded — against something other
 * than the preview under test. `convex run` with a preview deploy key and no
 * target selector does not refuse; its deployment selection falls through to
 * `unspecified`, which the CLI resolves to the project's shared DEV
 * deployment. So the failure mode being guarded is a silent write to the wrong
 * database, which is exactly the class no runtime signal will report.
 */
import { describe, expect, test, vi } from "vitest";
import {
  PreviewTargetingError,
  assertPreviewTargeting,
  buildConvexRunArgs,
  isPreviewDeployKey,
  maskEmail,
  resolveClerkUserId,
  sanitizePreviewName,
} from "./e2ePreviewBootstrap.mjs";

/** Shaped exactly like the real thing: `preview:<team>:<project>|<token>`. */
const PREVIEW_KEY = "preview:autoflow-team:autoflow|abcdef0123456789";
const PROD_KEY = "prod:opulent-jackal-776|abcdef0123456789";
const DEV_KEY = "dev:vibrant-cat-418|abcdef0123456789";
const PROJECT_KEY = "project:autoflow-team:autoflow|abcdef0123456789";

describe("isPreviewDeployKey", () => {
  test("accepts a preview deploy key", () => {
    expect(isPreviewDeployKey(PREVIEW_KEY)).toBe(true);
  });

  test.each([
    ["a production key", PROD_KEY],
    ["a dev key", DEV_KEY],
    ["a project key", PROJECT_KEY],
    ["a bare admin key with no prefix", "abcdef0123456789"],
    ["a two-segment preview-looking prefix", "preview:autoflow|abcdef"],
    ["an empty string", ""],
  ])("rejects %s", (_label, key) => {
    expect(isPreviewDeployKey(key)).toBe(false);
  });

  test("rejects a non-string", () => {
    expect(isPreviewDeployKey(undefined)).toBe(false);
    expect(isPreviewDeployKey(null)).toBe(false);
  });
});

describe("assertPreviewTargeting", () => {
  test("accepts a preview key with an explicit preview name", () => {
    expect(
      assertPreviewTargeting({ deployKey: PREVIEW_KEY, previewName: "e2e-pr-143" }),
    ).toBe(true);
  });

  /** Failing-first case 7: a production-targeting attempt, refused up front. */
  test("refuses a production deploy key", () => {
    expect(() =>
      assertPreviewTargeting({ deployKey: PROD_KEY, previewName: "e2e-pr-143" }),
    ).toThrow(/not a PREVIEW deploy key/);
  });

  test("refuses a dev deploy key", () => {
    expect(() =>
      assertPreviewTargeting({ deployKey: DEV_KEY, previewName: "e2e-pr-143" }),
    ).toThrow(/not a PREVIEW deploy key/);
  });

  test("refuses a missing deploy key", () => {
    expect(() => assertPreviewTargeting({ deployKey: "", previewName: "e2e-pr-143" })).toThrow(
      /CONVEX_DEPLOY_KEY is not set/,
    );
  });

  /**
   * The one that is easiest to get wrong and hardest to see: without the flag
   * the CLI targets the shared DEV deployment and reports success.
   */
  test("refuses a missing preview name rather than letting the CLI default to dev", () => {
    expect(() => assertPreviewTargeting({ deployKey: PREVIEW_KEY, previewName: "" })).toThrow(
      /resolves an unspecified target to the project's DEV deployment/,
    );
  });

  test("refuses a preview name that could be read as another flag", () => {
    expect(() =>
      assertPreviewTargeting({ deployKey: PREVIEW_KEY, previewName: "--prod" }),
    ).toThrow(/not a safe identifier/);
  });

  test("refuses a preview name carrying a path separator", () => {
    expect(() =>
      assertPreviewTargeting({ deployKey: PREVIEW_KEY, previewName: "agent/scrum-143" }),
    ).toThrow(/not a safe identifier/);
  });

  test("refuses when CONVEX_DEPLOYMENT names a dev or production deployment", () => {
    expect(() =>
      assertPreviewTargeting({
        deployKey: PREVIEW_KEY,
        previewName: "e2e-pr-143",
        env: { CONVEX_DEPLOYMENT: "dev:vibrant-cat-418" },
      }),
    ).toThrow(/CONVEX_DEPLOYMENT is set/);
  });
});

describe("buildConvexRunArgs", () => {
  test("always appends the preview target", () => {
    const args = buildConvexRunArgs({
      functionName: "e2eBootstrap:bootstrapE2EOrganization",
      argsJson: '{"a":1}',
      previewName: "e2e-pr-143",
      deployKey: PREVIEW_KEY,
    });

    expect(args).toEqual([
      "exec",
      "convex",
      "run",
      "e2eBootstrap:bootstrapE2EOrganization",
      '{"a":1}',
      "--preview-name",
      "e2e-pr-143",
    ]);
  });

  test("refuses to build a command at all when targeting is unsafe", () => {
    expect(() =>
      buildConvexRunArgs({
        functionName: "e2eBootstrap:bootstrapE2EOrganization",
        argsJson: "{}",
        previewName: "e2e-pr-143",
        deployKey: PROD_KEY,
      }),
    ).toThrow(PreviewTargetingError);
  });

  test("refuses a function reference that is not module:function", () => {
    expect(() =>
      buildConvexRunArgs({
        functionName: "rm -rf /",
        argsJson: "{}",
        previewName: "e2e-pr-143",
        deployKey: PREVIEW_KEY,
      }),
    ).toThrow(/expected a "module:function" reference/);
  });
});

describe("sanitizePreviewName", () => {
  test.each([
    ["agent/scrum-143-e2e-preview-bootstrap", "agent-scrum-143-e2e-preview-bootstrap"],
    ["e2e-pr-143", "e2e-pr-143"],
    ["Feature/UPPER_Case", "feature-upper_case"],
    ["---leading-and-trailing---", "leading-and-trailing"],
  ])("%s -> %s", (raw, expected) => {
    expect(sanitizePreviewName(raw)).toBe(expected);
  });

  test("caps the length so the CLI never sees an oversized identifier", () => {
    expect(sanitizePreviewName("a".repeat(200)).length).toBeLessThanOrEqual(61);
  });
});

describe("resolveClerkUserId", () => {
  /**
   * A real `Response`, not a hand-shaped stand-in. The stand-in typechecked as
   * `any` at the seam and would have hidden a change to how the body is read.
   */
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  test("returns the single matching Clerk user id", async () => {
    let requestedUrl = "";
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      requestedUrl = String(url);
      return jsonResponse([{ id: "user_abc" }]);
    });

    const id = await resolveClerkUserId({
      email: "qa@example.com",
      secretKey: "sk_test_x",
      fetchImpl,
    });

    expect(id).toBe("user_abc");
    expect(requestedUrl).toContain("email_address=qa%40example.com");
  });

  test("reads Clerk's paginated envelope as well as a bare array", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: "user_envelope" }] }));

    await expect(
      resolveClerkUserId({ email: "qa@example.com", secretKey: "sk_test_x", fetchImpl }),
    ).resolves.toBe("user_envelope");
  });

  /**
   * Failing-first case 2, at its earliest reachable point: an identity that is
   * not provisioned in Clerk can never belong to the QA dealership, and saying
   * so here is far cheaper than a browser proving it twenty minutes later.
   */
  test("refuses when the address matches no Clerk user", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));

    await expect(
      resolveClerkUserId({ email: "missing@example.com", secretKey: "sk_test_x", fetchImpl }),
    ).rejects.toThrow(/No Clerk user exists with the address/);
  });

  test("refuses an ambiguous address", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ id: "user_a" }, { id: "user_b" }]));

    await expect(
      resolveClerkUserId({ email: "dup@example.com", secretKey: "sk_test_x", fetchImpl }),
    ).rejects.toThrow(/resolves to 2 Clerk users/);
  });

  test("names the likely cause when Clerk rejects the lookup", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));

    await expect(
      resolveClerkUserId({ email: "qa@example.com", secretKey: "sk_bad", fetchImpl }),
    ).rejects.toThrow(/same Clerk instance as NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY/);
  });

  test("refuses without a secret key rather than calling Clerk unauthenticated", async () => {
    const fetchImpl = vi.fn();

    await expect(
      resolveClerkUserId({ email: "qa@example.com", secretKey: "", fetchImpl }),
    ).rejects.toThrow(/CLERK_SECRET_KEY is not set/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("never puts a whole configured address in an error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));

    const error = await resolveClerkUserId({
      email: "autoflow-approver@example.com",
      secretKey: "sk_test_x",
      fetchImpl,
    }).catch((e: unknown) => e);

    expect(String(error)).not.toContain("autoflow-approver@example.com");
    expect(String(error)).toContain("au***************@example.com");
  });
});

describe("maskEmail", () => {
  test("keeps enough to tell two seats apart and no more", () => {
    expect(maskEmail("autoflow-e2e@example.com")).toBe("au**********@example.com");
    expect(maskEmail("not-an-address")).toBe("<redacted>");
  });
});
