import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  LOCAL_CONVEX_CI_FLAG,
  LOCAL_CONVEX_URL,
  localConvexCspSources,
} from "./contentSecurityPolicy";
import { SWARM_LOCAL_CONVEX_ORIGIN } from "../../scripts/intelligence/swarmConvexOrigin.mjs";

describe("local Convex origin", () => {
  it("is the same origin the CI backend runner and the swarm validators use", () => {
    expect(LOCAL_CONVEX_URL).toBe(SWARM_LOCAL_CONVEX_ORIGIN);
  });
});

/**
 * The exact header value origin/main shipped before SCRUM-892 (next.config.ts
 * at 803c73c08). The Convex Cloud configuration and the empty environment must
 * reproduce it byte for byte; a self-hosted configuration (SCRUM-1026) and the
 * CI switch (SCRUM-892) deliberately change it.
 */
const PRODUCTION_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://clerk.accounts.dev https://*.clerk.accounts.dev https://clerk.autoflowdealer.com https://challenges.cloudflare.com https://static.cloudflareinsights.com; " +
  "worker-src 'self' blob:; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: blob: https://*.convex.cloud https://img.clerk.com https://lh3.googleusercontent.com https://*.googleusercontent.com; " +
  "connect-src 'self' https://*.convex.cloud wss://*.convex.cloud https://*.convex.site https://*.clerk.accounts.dev https://clerk.autoflowdealer.com https://clerk-telemetry.com https://vpic.nhtsa.dot.gov https://o4511556361715712.ingest.de.sentry.io https://cloudflareinsights.com https://vitals.vercel-insights.com; " +
  "frame-src https://challenges.cloudflare.com; " +
  "frame-ancestors 'none'";

const PROD_URL = "https://clever-mockingbird-719.convex.cloud";

describe("buildContentSecurityPolicy (SCRUM-892)", () => {
  it.each([
    ["no switch, production URL", { NEXT_PUBLIC_CONVEX_URL: PROD_URL }],
    ["no switch, Vercel build", { NEXT_PUBLIC_CONVEX_URL: PROD_URL, VERCEL: "1" }],
    ["no switch, even with the local URL", { NEXT_PUBLIC_CONVEX_URL: LOCAL_CONVEX_URL }],
    ["switch not exactly 1", { [LOCAL_CONVEX_CI_FLAG]: "true", NEXT_PUBLIC_CONVEX_URL: LOCAL_CONVEX_URL }],
    ["empty environment", {}],
  ])("is byte-identical to the production policy: %s", (_label, env) => {
    expect(buildContentSecurityPolicy(env)).toBe(PRODUCTION_CSP);
  });

  it("adds only the local backend's HTTP and websocket origins when the CI switch and URL both match", () => {
    const policy = buildContentSecurityPolicy({
      [LOCAL_CONVEX_CI_FLAG]: "1",
      NEXT_PUBLIC_CONVEX_URL: LOCAL_CONVEX_URL,
    });
    expect(policy).toBe(
      PRODUCTION_CSP.replace(
        "https://*.googleusercontent.com;",
        "https://*.googleusercontent.com http://127.0.0.1:3210;",
      ).replace(
        "https://vitals.vercel-insights.com;",
        "https://vitals.vercel-insights.com http://127.0.0.1:3210 ws://127.0.0.1:3210;",
      ),
    );
  });

  it("refuses the switch on a Vercel build instead of loosening its policy", () => {
    expect(() =>
      buildContentSecurityPolicy({
        [LOCAL_CONVEX_CI_FLAG]: "1",
        NEXT_PUBLIC_CONVEX_URL: LOCAL_CONVEX_URL,
        VERCEL: "1",
      }),
    ).toThrow(/never be set on a Vercel build/);
  });

  it.each([
    PROD_URL,
    "http://127.0.0.1:3210/",
    "http://localhost:3210",
    "http://127.0.0.1:3211",
    "https://127.0.0.1:3210",
    "",
    undefined,
  ])("refuses the switch with any Convex URL but the local backend: %s", (url) => {
    expect(() =>
      localConvexCspSources({ [LOCAL_CONVEX_CI_FLAG]: "1", NEXT_PUBLIC_CONVEX_URL: url }),
    ).toThrow(/requires NEXT_PUBLIC_CONVEX_URL/);
  });
});

/**
 * SCRUM-1026: the web app can point at a self-hosted Convex backend reached at
 * two public HTTPS hostnames. The policy then names exactly those origins and
 * drops the Convex Cloud wildcards; anything it cannot validate fails the build.
 */
const API = "https://convex.example.com";
const SITE = "https://convex-site.example.com";
const WILDCARDS = ["https://*.convex.cloud", "wss://*.convex.cloud", "https://*.convex.site"];

function selfHosted(url: string, site?: string, extra: Record<string, string> = {}) {
  return { NEXT_PUBLIC_CONVEX_URL: url, ...(site === undefined ? {} : { NEXT_PUBLIC_CONVEX_SITE_URL: site }), ...extra };
}

function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split("; ").map((d) => {
      const [name, ...sources] = d.split(" ");
      return [name, sources];
    }),
  );
}

const SELF_HOSTED_CSP =
  PRODUCTION_CSP.replace("https://*.convex.cloud https://img.clerk.com", "https://img.clerk.com")
    .replace("https://*.googleusercontent.com;", "https://*.googleusercontent.com https://convex.example.com;")
    .replace("https://*.convex.cloud wss://*.convex.cloud https://*.convex.site ", "")
    .replace(
      "https://vitals.vercel-insights.com;",
      "https://vitals.vercel-insights.com https://convex.example.com wss://convex.example.com https://convex-site.example.com;",
    );

describe("buildContentSecurityPolicy, self-hosted Convex (SCRUM-1026)", () => {
  it("cloud configuration with a site address stays byte-identical", () => {
    expect(
      buildContentSecurityPolicy(selfHosted(PROD_URL, "https://clever-mockingbird-719.convex.site")),
    ).toBe(PRODUCTION_CSP);
  });

  it("names exactly the API and site origins and drops every Convex Cloud wildcard", () => {
    const policy = buildContentSecurityPolicy(selfHosted(API, SITE));
    expect(policy).toBe(SELF_HOSTED_CSP);
    for (const wildcard of WILDCARDS) expect(policy).not.toContain(wildcard);
    expect(policy).not.toMatch(/convex\.(cloud|site)/);
  });

  it("leaves the site address out when it is unset or empty", () => {
    const expected = SELF_HOSTED_CSP.replace(" https://convex-site.example.com", "");
    expect(buildContentSecurityPolicy(selfHosted(API))).toBe(expected);
    expect(buildContentSecurityPolicy(selfHosted(API, ""))).toBe(expected);
  });

  it("works on a Vercel build (no CI switch)", () => {
    expect(buildContentSecurityPolicy(selfHosted(API, SITE, { VERCEL: "1" }))).toBe(SELF_HOSTED_CSP);
  });

  it("adds the site origin to connect-src only, never to img-src", () => {
    const d = directives(buildContentSecurityPolicy(selfHosted(API, SITE)));
    expect(d["connect-src"]).toContain("https://convex-site.example.com");
    expect(d["img-src"]).not.toContain("https://convex-site.example.com");
    expect(d["img-src"]).toContain("https://convex.example.com");
    expect(d["img-src"]).not.toContain("wss://convex.example.com");
  });

  it("does not repeat an origin when both addresses share a host", () => {
    const d = directives(buildContentSecurityPolicy(selfHosted(API, API)));
    expect(d["connect-src"].filter((s) => s === "https://convex.example.com")).toHaveLength(1);
  });

  it.each([
    ["an explicit port is kept in every source", "https://convex.example.com:8443", "https://convex.example.com:8443", "wss://convex.example.com:8443"],
    ["a trailing slash is accepted", "https://convex.example.com/", "https://convex.example.com", "wss://convex.example.com"],
    ["a punycode host is kept as ASCII", "https://xn--80ak6aa92e.example.com", "https://xn--80ak6aa92e.example.com", "wss://xn--80ak6aa92e.example.com"],
    ["a lookalike of the cloud suffix is only an exact origin", "https://x.convex.cloud.evil.example", "https://x.convex.cloud.evil.example", "wss://x.convex.cloud.evil.example"],
  ])("%s", (_label, url, https, wss) => {
    const d = directives(buildContentSecurityPolicy(selfHosted(url)));
    expect(d["connect-src"].slice(-2)).toEqual([https, wss]);
    expect(d["img-src"].at(-1)).toBe(https);
    for (const wildcard of WILDCARDS) expect(d["connect-src"]).not.toContain(wildcard);
  });

  it.each([
    ["http scheme", "http://convex.example.com"],
    ["ws scheme", "wss://convex.example.com"],
    ["no scheme", "convex.example.com"],
    ["userinfo", "https://user:pw@convex.example.com"],
    ["cloud-looking userinfo", "https://a.convex.cloud@evil.example"],
    ["a path", "https://convex.example.com/api"],
    ["cloud-looking path", "https://evil.example/.convex.cloud"],
    ["a query", "https://convex.example.com/?a=1"],
    ["an empty query", "https://convex.example.com?"],
    ["a fragment", "https://convex.example.com/#x"],
    ["an empty fragment", "https://convex.example.com#"],
    ["an IPv4 literal", "https://203.0.113.7"],
    ["a short IPv4 literal", "https://127.1"],
    ["an IPv6 literal", "https://[2001:db8::1]"],
    ["localhost", "https://localhost"],
    ["a .localhost name", "https://convex.localhost"],
    ["a single-label host", "https://convex"],
    ["an empty host", "https://"],
    ["a trailing dot", "https://convex.example.com."],
    ["a wildcard host", "https://*.example.com"],
    ["an underscore host", "https://con_vex.example.com"],
    ["a space (source injection)", "https://convex.example.com *"],
    ["a leading space", " https://convex.example.com"],
    ["a semicolon (directive injection)", "https://convex.example.com;script-src *"],
    ["a comma", "https://convex.example.com,https://evil.example"],
    ["a quote", "https://convex.example.com'"],
    ["a newline", "https://convex.example.com\nscript-src *"],
    ["a tab", "https://convex\t.example.com"],
    ["a backslash", "https://convex.example.com\\@evil.example"],
    ["non-ASCII characters", "https://bücher.example.com"],
    ["the bare cloud domain", "https://convex.cloud"],
    ["the bare site domain", "https://convex.site"],
    ["an unparseable value", "https://exa mple.com"],
  ])("refuses a Convex URL with %s", (_label, url) => {
    expect(() => buildContentSecurityPolicy(selfHosted(url))).toThrow(/NEXT_PUBLIC_CONVEX_URL/);
  });

  it.each([
    ["http scheme", "http://convex-site.example.com"],
    ["a path", "https://convex-site.example.com/x"],
    ["userinfo", "https://a@convex-site.example.com"],
    ["an IP literal", "https://203.0.113.7"],
    ["a space", "https://convex-site.example.com *"],
    ["a semicolon", "https://convex-site.example.com;img-src *"],
  ])("refuses a site URL with %s", (_label, site) => {
    expect(() => buildContentSecurityPolicy(selfHosted(API, site))).toThrow(/NEXT_PUBLIC_CONVEX_SITE_URL/);
  });

  // Canonical form: the raw value must be exactly `url.origin` or `url.origin + "/"`,
  // because the Convex client splits the raw string on "://" (it does not use URL).
  // WHATWG URL elides a default port, so `:443` can never be canonical.
  it("accepts the canonical control form the refusals below differ from", () => {
    expect(buildContentSecurityPolicy(selfHosted(API))).toBe(SELF_HOSTED_CSP.replace(" https://convex-site.example.com", ""));
  });

  it.each([
    ["a single-slash scheme", "https:/convex.example.com"],
    ["a scheme without slashes", "https:convex.example.com"],
    ["an empty port", "https://convex.example.com:"],
    ["an uppercase scheme and host", "HTTPS://Convex.EXAMPLE.com/"],
    ["a percent-encoded host", "https://%63onvex.example.com"],
    ["a percent-encoded dot", "https://convex%2eexample.com"],
  ])("refuses a non-canonical Convex URL: %s", (_label, url) => {
    expect(() => buildContentSecurityPolicy(selfHosted(url))).toThrow(/NEXT_PUBLIC_CONVEX_URL.*(canonical|exactly)/);
  });

  it("refuses an explicit default port and tells the operator to drop :443", () => {
    expect(() => buildContentSecurityPolicy(selfHosted("https://convex.example.com:443"))).toThrow(
      /NEXT_PUBLIC_CONVEX_URL.*drop :443/,
    );
  });

  it("refuses a non-canonical site URL: an explicit default port", () => {
    expect(() => buildContentSecurityPolicy(selfHosted(API, "https://convex-site.example.com:443"))).toThrow(
      /NEXT_PUBLIC_CONVEX_SITE_URL.*drop :443/,
    );
  });

  it("refuses port 0", () => {
    expect(() => buildContentSecurityPolicy(selfHosted("https://convex.example.com:0"))).toThrow(
      /NEXT_PUBLIC_CONVEX_URL.*port 0/,
    );
  });

  // 3 x 63 + 61 characters + 3 dots = 253 (the DNS maximum), one more is 254.
  const host253 = [..."a".repeat(3).split("").map(() => "a".repeat(63)), "a".repeat(61)].join(".");
  it("accepts a 253-character hostname (control for the length refusal)", () => {
    // guardrail-4-fixture: the hostname under test must be exactly the 253-character DNS maximum
    expect(host253).toHaveLength(253);
    expect(() => buildContentSecurityPolicy(selfHosted(`https://${host253}`))).not.toThrow();
  });

  it("refuses a 254-character hostname", () => {
    const host254 = `${host253}a`;
    // guardrail-4-fixture: one character over the 253-character DNS maximum
    expect(host254).toHaveLength(254);
    expect(() => buildContentSecurityPolicy(selfHosted(`https://${host254}`))).toThrow(/NEXT_PUBLIC_CONVEX_URL.*253/);
  });

  it("refuses a Convex Cloud address in the site variable beside a self-hosted API", () => {
    expect(() => buildContentSecurityPolicy(selfHosted("https://api.example.com", "https://x.convex.cloud"))).toThrow(
      /NEXT_PUBLIC_CONVEX_SITE_URL holds a \.convex\.cloud address/,
    );
  });

  it("refuses a Convex Cloud address in the site variable beside a cloud API", () => {
    expect(() => buildContentSecurityPolicy(selfHosted(PROD_URL, "https://x.convex.cloud"))).toThrow(
      /NEXT_PUBLIC_CONVEX_SITE_URL holds a \.convex\.cloud address/,
    );
  });

  it("refuses a .convex.site address in the API variable instead of treating it as self-hosted", () => {
    expect(() => buildContentSecurityPolicy(selfHosted("https://x.convex.site"))).toThrow(/NEXT_PUBLIC_CONVEX_URL holds a \.convex\.site address/);
  });

  it("refuses a .convex.site address in the API variable beside a self-hosted site", () => {
    expect(() => buildContentSecurityPolicy(selfHosted("https://x.convex.site", SITE))).toThrow(/NEXT_PUBLIC_CONVEX_URL holds a \.convex\.site address/);
  });

  it("refuses the bare cloud and site domains in the site variable", () => {
    expect(() => buildContentSecurityPolicy(selfHosted(API, "https://convex.cloud"))).toThrow(/NEXT_PUBLIC_CONVEX_SITE_URL/);
    expect(() => buildContentSecurityPolicy(selfHosted(API, "https://convex.site"))).toThrow(/NEXT_PUBLIC_CONVEX_SITE_URL/);
  });

  it.each([
    ["cloud API with a self-hosted site", selfHosted(PROD_URL, SITE)],
    ["self-hosted API with a cloud site", selfHosted(API, "https://clever-mockingbird-719.convex.site")],
    ["no API address with a self-hosted site", { NEXT_PUBLIC_CONVEX_SITE_URL: SITE }],
  ])("refuses a mixed configuration: %s", (_label, env) => {
    expect(() => buildContentSecurityPolicy(env)).toThrow(/mix/);
  });

  it("leaves the CI loopback policy unchanged when a site address is also set", () => {
    const ci = { [LOCAL_CONVEX_CI_FLAG]: "1", NEXT_PUBLIC_CONVEX_URL: LOCAL_CONVEX_URL };
    expect(
      buildContentSecurityPolicy({ ...ci, NEXT_PUBLIC_CONVEX_SITE_URL: "http://127.0.0.1:3211" }),
    ).toBe(buildContentSecurityPolicy(ci));
  });

  it("does not let the CI switch open a self-hosted address", () => {
    expect(() => buildContentSecurityPolicy(selfHosted(API, SITE, { [LOCAL_CONVEX_CI_FLAG]: "1" }))).toThrow(
      /requires NEXT_PUBLIC_CONVEX_URL/,
    );
  });
});
