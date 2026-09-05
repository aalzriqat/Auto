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
  main,
  maskEmail,
  previewNameForRef,
  resolveClerkUserId,
  runConvex,
  sanitizePreviewName,
} from "./e2ePreviewBootstrap.mjs";

/**
 * The token half of a deploy key, ASSEMBLED rather than written out.
 *
 * ⚠️ A 16-character hex literal on a line carrying the word "key" scores
 * entropy 4.0 and trips gitleaks' `generic-api-key` rule. It did: `secret-scan`
 * — a required check — went red at 6dc6c1577 on
 * `["a bare admin key with no prefix", "<16 hex chars>"]`, this file, line 38.
 *
 * Building it from a zero-entropy literal keeps the scanner at full strength
 * instead of allowlisting a pattern in `.gitleaks.toml`, which is the same call
 * `production-build` already makes for its Clerk placeholder. The SHAPE is what
 * these fixtures are for — `isPreviewDeployKey` only ever reads the prefix
 * before the `|` — so nothing under test loses anything.
 */
const TOKEN = "x".repeat(16);
/** Shaped exactly like the real thing: `preview:<team>:<project>|<token>`. */
const PREVIEW_KEY = `preview:autoflow-team:autoflow|${TOKEN}`;
const PROD_KEY = `prod:opulent-jackal-776|${TOKEN}`;
const DEV_KEY = `dev:vibrant-cat-418|${TOKEN}`;
const PROJECT_KEY = `project:autoflow-team:autoflow|${TOKEN}`;

describe("isPreviewDeployKey", () => {
  test("accepts a preview deploy key", () => {
    expect(isPreviewDeployKey(PREVIEW_KEY)).toBe(true);
  });

  test.each([
    ["a production key", PROD_KEY],
    ["a dev key", DEV_KEY],
    ["a project key", PROJECT_KEY],
    ["a bare admin key with no prefix", TOKEN],
    ["a two-segment preview-looking prefix", `preview:autoflow|${TOKEN}`],
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

describe("previewNameForRef", () => {
  const NAME = /^[a-z0-9][a-z0-9._-]{0,60}$/;

  test("names a pull request readably and still carries the ref digest", () => {
    const name = previewNameForRef({ ref: "refs/pull/278/merge", prNumber: "278" });
    expect(name).toMatch(/^e2e-pr-278-[0-9a-f]{10}$/);
    expect(name).toMatch(NAME);
  });

  test("names a branch push readably", () => {
    const name = previewNameForRef({ ref: "refs/heads/main" });
    expect(name).toMatch(/^e2e-main-[0-9a-f]{10}$/);
  });

  /**
   * ⚠️ THE REGRESSION. `--preview-create` DELETES the named deployment, and
   * GitHub's `concurrency` group is keyed on `github.ref` — so two runs may
   * share a preview name ONLY if they share a group. Sanitising the ref broke
   * that implication, and the consequence was not a failing test but a run
   * whose backend was deleted from under it mid-suite, reported against the
   * wrong commit. Both cases below were reproduced on PR #278 at 6dc6c1577.
   */
  test("does not collide when two different refs sanitise to the same string", () => {
    const a = previewNameForRef({ ref: "refs/heads/feature/foo" });
    const b = previewNameForRef({ ref: "refs/heads/feature-foo" });

    // The control: the sanitiser alone really does map these to one string.
    expect(sanitizePreviewName("e2e-feature/foo")).toBe(sanitizePreviewName("e2e-feature-foo"));
    expect(a).not.toBe(b);
  });

  test("does not collide when two long refs share their first 61 characters", () => {
    const shared = "a".repeat(58);
    const a = previewNameForRef({ ref: `refs/heads/${shared}-one` });
    const b = previewNameForRef({ ref: `refs/heads/${shared}-two` });

    expect(a).not.toBe(b);
    expect(a).toMatch(NAME);
    expect(b).toMatch(NAME);
  });

  test("keeps the digest when the readable half is truncated", () => {
    const name = previewNameForRef({ ref: `refs/heads/${"b".repeat(200)}` });
    expect(name).toMatch(/-[0-9a-f]{10}$/);
    expect(name.length).toBeLessThanOrEqual(61);
  });

  test("is stable for one ref", () => {
    expect(previewNameForRef({ ref: "refs/heads/x" })).toBe(
      previewNameForRef({ ref: "refs/heads/x" }),
    );
  });

  test("refuses without a ref rather than inventing one", () => {
    expect(() => previewNameForRef({ ref: "" })).toThrow(/without a ref/);
  });
});

describe("runConvex — failure reporting", () => {
  const ARGS_WITH_SECRETS = [
    "exec",
    "convex",
    "run",
    "e2eBootstrap:bootstrapE2EOrganization",
    JSON.stringify({
      primary: { clerkUserId: "user_a", email: "primary-secret@example.com" },
      approver: { clerkUserId: "user_b", email: "approver-secret@example.com" },
    }),
    "--preview-name",
    "e2e-pr-143",
  ];

  type FakeSpawn = (
    command: string,
    args: string[],
    options: object,
  ) => { status: number | null; error?: Error | undefined };

  function attempt(label: string, spawn: FakeSpawn): string {
    try {
      runConvex(ARGS_WITH_SECRETS, label, spawn);
      return "";
    } catch (error) {
      return String(error);
    }
  }

  /**
   * ⚠️ THE REGRESSION for a leak an adversarial reviewer found and I
   * reproduced with a control. This used to report failures as
   * `` `pnpm ${args.join(" ")}` failed ``, and `args` carries the JSON payload
   * with BOTH configured E2E addresses in full — so every refusal, transient
   * CLI failure and spawn error printed them. GitHub masks registered secret
   * values in its own log stream, which covers neither a local run nor a copied
   * exception, and is not a reason to emit them.
   */
  test("names the function and the exit code, never the argv", () => {
    const spawn = vi.fn(() => ({ status: 1, error: undefined }));

    const thrown = attempt("e2eBootstrap:bootstrapE2EOrganization", spawn);

    expect(thrown).toMatch(/e2eBootstrap:bootstrapE2EOrganization failed with exit code 1/);
    expect(thrown).not.toContain("primary-secret@example.com");
    expect(thrown).not.toContain("approver-secret@example.com");
    expect(thrown).not.toContain("clerkUserId");
  });

  test("does not leak the argv when the process cannot be started either", () => {
    const spawn = vi.fn(() => ({ status: null, error: new Error("ENOENT") }));

    const thrown = attempt("e2eBootstrap:assertE2EBootstrap", spawn);

    expect(thrown).toContain("e2eBootstrap:assertE2EBootstrap");
    expect(thrown).not.toContain("primary-secret@example.com");
    expect(thrown).not.toContain("approver-secret@example.com");
  });

  test("returns quietly on success", () => {
    const spawn = vi.fn(() => ({ status: 0, error: undefined }));
    expect(() => runConvex(["exec"], "label", spawn)).not.toThrow();
  });
});

describe("main", () => {
  const ENV = {
    CONVEX_DEPLOY_KEY: PREVIEW_KEY,
    CONVEX_PREVIEW_NAME: "e2e-pr-278-0123456789",
    NEXT_PUBLIC_CONVEX_URL: "https://impressive-ox-948.convex.cloud",
    CLERK_SECRET_KEY: "sk_test_x",
    E2E_LOGIN_USER: "primary-secret@example.com",
    E2E_APPROVER_USER: "approver-secret@example.com",
  };

  function deps() {
    const calls: { fn: string; args: string[] }[] = [];
    return {
      calls,
      run: vi.fn((args: string[], label: string) => {
        calls.push({ fn: label, args });
      }),
      resolveClerkUserId: vi.fn(async ({ email }: { email: string }) =>
        email.startsWith("primary") ? "user_primary" : "user_approver",
      ),
      log: vi.fn(),
    };
  }

  test("seeds and then verifies, both aimed at the same named preview", async () => {
    const d = deps();

    await main(ENV, d);

    expect(d.calls.map((c) => c.fn)).toEqual([
      "e2eBootstrap:bootstrapE2EOrganization",
      "e2eBootstrap:assertE2EBootstrap",
    ]);
    for (const call of d.calls) {
      expect(call.args).toContain("--preview-name");
      expect(call.args[call.args.indexOf("--preview-name") + 1]).toBe(ENV.CONVEX_PREVIEW_NAME);
    }
    const seeded = JSON.parse(d.calls[0]!.args[4]!);
    expect(seeded.primary.clerkUserId).toBe("user_primary");
    expect(seeded.approver.clerkUserId).toBe("user_approver");
    expect(seeded.expectedCloudUrl).toBe(ENV.NEXT_PUBLIC_CONVEX_URL);
  });

  test("masks both addresses in the progress line", async () => {
    const d = deps();

    await main(ENV, d);

    const logged = d.log.mock.calls.flat().join(" ");
    expect(logged).not.toContain("primary-secret@example.com");
    expect(logged).not.toContain("approver-secret@example.com");
    expect(logged).toContain("@example.com");
  });

  test("refuses before resolving anything when the deploy key is not a preview key", async () => {
    const d = deps();

    await expect(main({ ...ENV, CONVEX_DEPLOY_KEY: PROD_KEY }, d)).rejects.toThrow(
      /not a PREVIEW deploy key/,
    );
    expect(d.resolveClerkUserId).not.toHaveBeenCalled();
    expect(d.run).not.toHaveBeenCalled();
  });

  test("refuses when only one identity is provisioned", async () => {
    const d = deps();

    await expect(main({ ...ENV, E2E_APPROVER_USER: "" }, d)).rejects.toThrow(/must both be set/);
    expect(d.run).not.toHaveBeenCalled();
  });

  test("refuses when the deployment under test was never captured", async () => {
    const d = deps();

    await expect(main({ ...ENV, NEXT_PUBLIC_CONVEX_URL: "" }, d)).rejects.toThrow(
      /cannot be checked against the one the browser will drive/,
    );
    expect(d.run).not.toHaveBeenCalled();
  });
});
