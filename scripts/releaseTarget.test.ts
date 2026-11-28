/**
 * SCRUM-1026 PR B: the production release path may target a self-hosted Convex
 * backend, and must fail closed doing so. Every refusal test has a passing
 * control in which ONLY the condition under test differs.
 */
import { describe, expect, test } from "vitest";
import {
  assertCloudTargetEnv,
  assertSelfHostedCliEnv,
  assertSelfHostedDeploymentIdentity,
  checkInstanceNameBody,
  fetchInstanceName,
  parseReleaseTarget,
  parseSelfHostedAdminKey,
  parseSelfHostedUrl,
  requireBoundSelfHostedKey,
  verifySelfHostedRelease,
} from "./releaseTarget.ts";

const INSTANCE = "autoflow-prod";
// Fixture, not a credential: a made-up, low-entropy admin-key token built at runtime.
const TOKEN = "fixture-token-".concat("x".repeat(24));
const KEY = `${INSTANCE}|${TOKEN}`;
const URL_OK = "https://convex.example.com";

const goodEnv = (over: Record<string, string | undefined> = {}) => ({
  CONVEX_PROD_TARGET: "self-hosted",
  CONVEX_PROD_DEPLOYMENT: INSTANCE,
  CONVEX_PROD_SELF_HOSTED_URL: URL_OK,
  CONVEX_PROD_SELF_HOSTED_ADMIN_KEY: KEY,
  ...over,
});

const reply = (status: number, body: string) => async () => new Response(body, { status });

describe("target selection", () => {
  test.each([undefined, "", "cloud"])("%j selects the cloud path", (raw) => {
    expect(parseReleaseTarget(raw)).toEqual({ ok: true, target: "cloud" });
  });
  test("self-hosted is selected only by the exact value", () => {
    expect(parseReleaseTarget("self-hosted")).toEqual({ ok: true, target: "self-hosted" });
  });
  test.each(["Self-Hosted", "self_hosted", " self-hosted", "selfhosted", "cloud ", "prod", "true", "  "])(
    "%j refuses",
    (raw) => {
      expect(parseReleaseTarget(raw).ok).toBe(false);
    }
  );
});

describe("self-hosted URL", () => {
  test("control: a plain https DNS origin passes, with or without the root slash", () => {
    expect(parseSelfHostedUrl(URL_OK)).toEqual({ ok: true, origin: URL_OK, host: "convex.example.com" });
    expect(parseSelfHostedUrl(`${URL_OK}/`)).toEqual({ ok: true, origin: URL_OK, host: "convex.example.com" });
  });
  test.each([
    ["http scheme", "http://convex.example.com"],
    ["userinfo", "https://user:pw@convex.example.com"],
    ["userinfo that spoofs a host", "https://convex.example.com@evil.example.net"],
    ["a path", "https://convex.example.com/api"],
    ["a query", "https://convex.example.com/?a=1"],
    ["an empty query", "https://convex.example.com/?"],
    ["a fragment", "https://convex.example.com/#x"],
    ["an explicit port", "https://convex.example.com:8443"],
    ["IPv4 literal", "https://203.0.113.7"],
    ["loopback IPv4", "https://127.0.0.1"],
    ["decimal IPv4", "https://2130706433"],
    ["hex IPv4", "https://0x7f.0.0.1"],
    ["IPv6 literal", "https://[::1]"],
    ["localhost", "https://localhost"],
    ["a localhost subdomain", "https://app.localhost"],
    ["a single label", "https://backend"],
    ["trailing dot", "https://convex.example.com."],
    ["convex.cloud", "https://happy-animal-123.convex.cloud"],
    ["convex.site", "https://happy-animal-123.convex.site"],
    ["upper-case convex.cloud", "https://Happy-Animal-123.CONVEX.CLOUD"],
    ["bare convex.cloud", "https://convex.cloud"],
    ["whitespace", " https://convex.example.com"],
    ["empty", ""],
    ["not a url", "convex.example.com"],
  ])("refuses %s", (_label, raw) => {
    expect(parseSelfHostedUrl(raw).ok).toBe(false);
  });
  test("control: the real production value passes, byte for byte", () => {
    expect(parseSelfHostedUrl("https://convex.autoflowdealer.com")).toEqual({
      ok: true,
      origin: "https://convex.autoflowdealer.com",
      host: "convex.autoflowdealer.com",
    });
  });
  // The raw variable is what the Convex CLI receives, so the accepted set is
  // exactly: raw === URL.origin, optionally followed by one `/` (the rule
  // lib/security/contentSecurityPolicy.ts already enforces).
  test.each([
    ["an explicit default port", "https://convex.example.com:443"],
    ["a zero-padded default port", "https://convex.example.com:0443"],
    ["an explicit default port and a slash", "https://convex.example.com:443/"],
    ["a single slash after the scheme", "https:/convex.example.com"],
    ["no slashes after the scheme", "https:convex.example.com"],
    ["a dot path segment", "https://convex.example.com/."],
    ["an encoded dot path segment", "https://convex.example.com/%2e"],
    ["a doubled slash", "https://convex.example.com//"],
    ["an upper-case host", "https://Convex.Example.com"],
    ["an upper-case scheme", "HTTPS://convex.example.com"],
    ["a percent-encoded host", "https://convex.%65xample.com"],
  ])("refuses a non-canonical spelling: %s", (_label, raw) => {
    expect(parseSelfHostedUrl(raw).ok).toBe(false);
  });
  test("the refusal for :443 says to drop the default port; the others say how to write it", () => {
    const withPort = parseSelfHostedUrl("https://convex.example.com:443");
    expect(withPort.ok === false && withPort.reason).toMatch(/drop :443, the default https port/);
    const encoded = parseSelfHostedUrl("https://convex.%65xample.com");
    expect(encoded.ok === false && encoded.reason).toMatch(/exactly as https:\/\/convex\.example\.com/);
  });
  test("a host that merely contains convex.cloud is not the cloud", () => {
    expect(parseSelfHostedUrl("https://convex.cloud.example.com").ok).toBe(true);
  });
  test("refusal text never repeats the candidate URL's userinfo", () => {
    const r = parseSelfHostedUrl("https://user:hunter2@convex.example.com");
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/hunter2/);
  });
});

describe("self-hosted admin key", () => {
  test("control: the documented shape names its instance", () => {
    expect(parseSelfHostedAdminKey(KEY)).toEqual({ kind: "self-hosted", instance: INSTANCE });
  });
  test.each([
    ["missing", undefined, "missing"],
    ["blank", "  ", "missing"],
    ["no separator", "justatokenjusatokenjustatoken", "malformed"],
    ["cloud prod key", `prod:${INSTANCE}|${TOKEN}`, "malformed"],
    ["cloud preview key", `preview:team:proj|${TOKEN}`, "malformed"],
    ["empty instance", `|${TOKEN}`, "malformed"],
    ["short token", `${INSTANCE}|abc`, "malformed"],
    ["two separators", `${INSTANCE}|${TOKEN}|${TOKEN}`, "malformed"],
    ["whitespace in key", `${INSTANCE}|${TOKEN} x`, "malformed"],
  ])("%s", (_label, raw, kind) => {
    expect(parseSelfHostedAdminKey(raw).kind).toBe(kind);
  });
  test("binding: control passes, a different instance name refuses, a prefix refuses", () => {
    expect(requireBoundSelfHostedKey(KEY, INSTANCE)).toEqual({ ok: true, instance: INSTANCE });
    expect(requireBoundSelfHostedKey(`other-prod|${TOKEN}`, INSTANCE).ok).toBe(false);
    expect(requireBoundSelfHostedKey(`autoflow|${TOKEN}`, INSTANCE).ok).toBe(false);
    expect(requireBoundSelfHostedKey(`${INSTANCE}x|${TOKEN}`, INSTANCE).ok).toBe(false);
  });
  test("binding refuses when the expected name is unset or unreadable, even if the key is fine", () => {
    expect(requireBoundSelfHostedKey(KEY, undefined).ok).toBe(false);
    expect(requireBoundSelfHostedKey(KEY, "").ok).toBe(false);
    expect(requireBoundSelfHostedKey(KEY, "bad name!").ok).toBe(false);
  });
  test("the token never appears in any refusal", () => {
    const r = requireBoundSelfHostedKey(`other-prod|${TOKEN}`, INSTANCE);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});

describe("instance-name report", () => {
  test("control: the same name passes (one trailing newline tolerated)", () => {
    expect(checkInstanceNameBody(INSTANCE, INSTANCE)).toEqual({ ok: true });
    expect(checkInstanceNameBody(`${INSTANCE}\n`, INSTANCE)).toEqual({ ok: true });
  });
  test.each([["empty", ""], ["blank", "  \n"], ["a different name", "other"], ["a prefix", "autoflow"], ["a superset", `${INSTANCE}-2`], ["an html page", "<html>autoflow-prod</html>"], ["a long body", "a".repeat(5000)]])(
    "refuses %s",
    (_label, body) => {
      expect(checkInstanceNameBody(body, INSTANCE).ok).toBe(false);
    }
  );
  test("fetch: control 200 with the name passes and asks without credentials and without following redirects", async () => {
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init };
      return new Response(INSTANCE, { status: 200 });
    };
    expect(await fetchInstanceName(URL_OK, INSTANCE, fetchImpl as typeof fetch)).toEqual({ ok: true });
    expect(seen?.url).toBe(`${URL_OK}/instance_name`);
    expect(seen?.init?.redirect).toBe("manual");
    expect(JSON.stringify(seen?.init?.headers ?? {})).not.toMatch(/authorization|convex/i);
  });
  test.each([[301], [302], [307], [404], [500], [201]])("status %i refuses even with the right body", async (status) => {
    const r = await fetchInstanceName(URL_OK, INSTANCE, reply(status, INSTANCE) as unknown as typeof fetch);
    expect(r.ok).toBe(false);
  });
  test("a network failure refuses and does not echo the error", async () => {
    const boom = async () => {
      throw new Error("connect ECONNREFUSED secret-detail");
    };
    const r = await fetchInstanceName(URL_OK, INSTANCE, boom as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/secret-detail/);
  });
  test("a different name refuses", async () => {
    expect((await fetchInstanceName(URL_OK, INSTANCE, reply(200, "someone-else") as unknown as typeof fetch)).ok).toBe(false);
  });
});

describe("environment separation", () => {
  test("self-hosted CLI step: control with no cloud variable passes", () => {
    expect(assertSelfHostedCliEnv({ CONVEX_SELF_HOSTED_URL: URL_OK }).ok).toBe(true);
  });
  // CONVEX_DEPLOYMENT_TOKEN is read by the CLI exactly like CONVEX_DEPLOY_KEY
  // (readDeployKeyFromEnv, convex 1.42.1) and wins over the self-hosted pair.
  test.each(["CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT_TOKEN", "CONVEX_DEPLOYMENT", "CONVEX_PREVIEW_DEPLOY_KEY"])("self-hosted CLI step refuses %s", (name) => {
    const r = assertSelfHostedCliEnv({ [name]: "x" });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain(name);
  });
  test("an empty cloud variable is not present", () => {
    expect(assertSelfHostedCliEnv({ CONVEX_DEPLOY_KEY: "" }).ok).toBe(true);
  });
  // The CLI trims nothing: a whitespace-only value is still a defined value it may read.
  test.each(["CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT_TOKEN", "CONVEX_DEPLOYMENT", "CONVEX_PREVIEW_DEPLOY_KEY"])(
    "self-hosted CLI step refuses a whitespace-only %s",
    (name) => {
      const r = assertSelfHostedCliEnv({ [name]: "   " });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).toContain(name);
    }
  );
  test("cloud branch: control with nothing self-hosted passes", () => {
    expect(assertCloudTargetEnv({}).ok).toBe(true);
    expect(assertCloudTargetEnv({ CONVEX_PROD_TARGET: "cloud" }).ok).toBe(true);
    expect(assertCloudTargetEnv({ CONVEX_PROD_SELF_HOSTED_ADMIN_KEY_PRESENT: "false" }).ok).toBe(true);
  });
  test.each([
    ["CONVEX_PROD_SELF_HOSTED_URL", URL_OK],
    ["CONVEX_PROD_SELF_HOSTED_ADMIN_KEY", KEY],
    ["CONVEX_PROD_SELF_HOSTED_ADMIN_KEY_PRESENT", "true"],
    ["CONVEX_SELF_HOSTED_URL", URL_OK],
    ["CONVEX_SELF_HOSTED_ADMIN_KEY", KEY],
  ])("cloud branch refuses %s", (name, value) => {
    const r = assertCloudTargetEnv({ [name]: value });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
  test("cloud branch refuses when the target says self-hosted", () => {
    expect(assertCloudTargetEnv({ CONVEX_PROD_TARGET: "self-hosted" }).ok).toBe(false);
  });
  test("cloud branch refuses an unreadable target", () => {
    expect(assertCloudTargetEnv({ CONVEX_PROD_TARGET: "clod" }).ok).toBe(false);
  });
});

describe("the whole pre-deploy decision", () => {
  const ok = reply(200, INSTANCE) as unknown as typeof fetch;
  test("control: everything addresses the expected instance", async () => {
    expect(await verifySelfHostedRelease(goodEnv(), ok)).toEqual({ ok: true, instance: INSTANCE, host: "convex.example.com", origin: URL_OK });
  });
  test("target not self-hosted refuses", async () => {
    expect((await verifySelfHostedRelease(goodEnv({ CONVEX_PROD_TARGET: undefined }), ok)).ok).toBe(false);
  });
  test("expected instance unset refuses", async () => {
    expect((await verifySelfHostedRelease(goodEnv({ CONVEX_PROD_DEPLOYMENT: "" }), ok)).ok).toBe(false);
  });
  test("URL variable unset refuses", async () => {
    expect((await verifySelfHostedRelease(goodEnv({ CONVEX_PROD_SELF_HOSTED_URL: "" }), ok)).ok).toBe(false);
  });
  test("a convex.cloud URL refuses", async () => {
    expect((await verifySelfHostedRelease(goodEnv({ CONVEX_PROD_SELF_HOSTED_URL: "https://x-y-1.convex.cloud" }), ok)).ok).toBe(false);
  });
  test("a key for another instance refuses", async () => {
    expect((await verifySelfHostedRelease(goodEnv({ CONVEX_PROD_SELF_HOSTED_ADMIN_KEY: `other|${TOKEN}` }), ok)).ok).toBe(false);
  });
  test("a backend that reports another name refuses", async () => {
    expect((await verifySelfHostedRelease(goodEnv(), reply(200, "other") as unknown as typeof fetch)).ok).toBe(false);
  });
  test("a cloud credential in the step refuses", async () => {
    expect((await verifySelfHostedRelease(goodEnv({ CONVEX_DEPLOY_KEY: "prod:x|y" }), ok)).ok).toBe(false);
  });
  test("a refusal before the network never reaches the network", async () => {
    let called = 0;
    const counting = (async () => {
      called += 1;
      return new Response(INSTANCE, { status: 200 });
    }) as unknown as typeof fetch;
    await verifySelfHostedRelease(goodEnv({ CONVEX_PROD_SELF_HOSTED_ADMIN_KEY: `other|${TOKEN}` }), counting);
    await verifySelfHostedRelease(goodEnv({ CONVEX_PROD_SELF_HOSTED_URL: "http://convex.example.com" }), counting);
    expect(called).toBe(0);
    await verifySelfHostedRelease(goodEnv(), counting);
    expect(called).toBe(1);
  });
  test("no refusal carries the token", async () => {
    const bad = await verifySelfHostedRelease(goodEnv({ CONVEX_PROD_SELF_HOSTED_ADMIN_KEY: `other|${TOKEN}` }), ok);
    expect(JSON.stringify(bad)).not.toContain(TOKEN);
  });
});

describe("function-runtime identity", () => {
  test("control: the reported URL is the configured origin", () => {
    expect(assertSelfHostedDeploymentIdentity(URL_OK, URL_OK)).toEqual({ ok: true });
    expect(assertSelfHostedDeploymentIdentity(`${URL_OK}/`, URL_OK)).toEqual({ ok: true });
  });
  test.each([[null], [undefined], [""], ["https://other.example.com"], ["http://convex.example.com"], ["https://x-y-1.convex.cloud"], ["https://convex.example.com.evil.net"]])(
    "%j refuses",
    (reported) => {
      expect(assertSelfHostedDeploymentIdentity(reported, URL_OK).ok).toBe(false);
    }
  );
  // A function-runtime answer is untrusted data: a non-string must be a refusal,
  // never a TypeError and never a pass.
  test.each([[123], [true], [{}], [["https://convex.example.com"]], [{ trim: () => URL_OK }]])(
    "a non-string report %j refuses without throwing",
    (reported) => {
      const decide = () => assertSelfHostedDeploymentIdentity(reported as unknown as string, URL_OK);
      expect(decide).not.toThrow();
      expect(decide().ok).toBe(false);
    }
  );
});
