/**
 * SCRUM-892: CI runs the app against a self-hosted Convex backend on the
 * runner's loopback instead of a cloud preview deployment. The browser then
 * talks to `http://127.0.0.1:3210` and `ws://127.0.0.1:3210`, which the
 * cloud-only CSP refuses, so every authenticated page stalls on
 * "Loading your workspace...".
 *
 * ⚠️ The loopback sources are added ONLY when BOTH hold:
 *   - the explicit CI switch `AUTOFLOW_LOCAL_CONVEX_CI` is exactly "1", and
 *   - the build's Convex URL is exactly the local CI backend.
 * With the switch unset and a Convex Cloud configuration (or an empty
 * environment) the policy is byte-identical to the cloud-only one; a self-hosted
 * configuration (SCRUM-1026 below) deliberately changes it. A switch that is set where
 * it must not be — on Vercel, or with any other Convex URL — throws, so the
 * build fails instead of shipping a loosened policy.
 */
export const LOCAL_CONVEX_URL = "http://127.0.0.1:3210";
export const LOCAL_CONVEX_CI_FLAG = "AUTOFLOW_LOCAL_CONVEX_CI";

type Env = Record<string, string | undefined>;

export interface LocalConvexCspSources {
  connect: string[];
  img: string[];
}

export function localConvexCspSources(env: Env): LocalConvexCspSources {
  if (env[LOCAL_CONVEX_CI_FLAG] !== "1") return { connect: [], img: [] };
  if (env.VERCEL) {
    throw new Error(`${LOCAL_CONVEX_CI_FLAG} must never be set on a Vercel build.`);
  }
  if (env.NEXT_PUBLIC_CONVEX_URL !== LOCAL_CONVEX_URL) {
    throw new Error(
      `${LOCAL_CONVEX_CI_FLAG}=1 requires NEXT_PUBLIC_CONVEX_URL to be exactly ${LOCAL_CONVEX_URL}.`,
    );
  }
  return {
    connect: [LOCAL_CONVEX_URL, LOCAL_CONVEX_URL.replace(/^http:/, "ws:")],
    // File storage URLs are served from the backend origin.
    img: [LOCAL_CONVEX_URL],
  };
}

/**
 * SCRUM-1026: self-hosted Convex. Production may reach Convex at two public
 * HTTPS hostnames of our own domain instead of `*.convex.cloud` / `*.convex.site`.
 * The policy then names exactly those two origins, built from the validated
 * parts of the parsed URL (never from the raw value), and the Convex Cloud
 * wildcards are dropped. Any value that is not a plain `https://<dns-host>[:port]`
 * origin throws, so the build fails instead of shipping a loosened or broken
 * policy. A port is allowed and kept in every source: a host-source without a
 * port only matches the scheme's default port, so dropping it would block the
 * connection, while keeping it names exactly the origin that was configured.
 */
const CLOUD_WILDCARDS = new Set(["https://*.convex.cloud", "wss://*.convex.cloud", "https://*.convex.site"]);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FORBIDDEN_RAW = /[^\x21-\x7e]|[\\;,'"*<>`|^{}]/;

type ConvexAddressKind = "absent" | "cloud" | "selfHosted";

const BARE_CONVEX_DOMAINS = new Set(["convex.cloud", "convex.site"]);

function hostnameOf(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

/**
 * A hostname equal to or under `convex.cloud` / `convex.site` is a Convex Cloud
 * address in EITHER variable and is never self-hosted. Each variable accepts
 * only its own suffix (API: `.convex.cloud`, site: `.convex.site`); the other
 * suffix is the wrong variable and throws, as does a bare Convex domain.
 */
function classify(name: string, value: string | undefined, ownSuffix: string, otherSuffix: string): ConvexAddressKind {
  if (!value) return "absent";
  // The CI loopback address (policy unchanged without the switch) is not self-hosted.
  if (value === LOCAL_CONVEX_URL) return "cloud";
  const host = hostnameOf(value);
  if (host === undefined) return "selfHosted"; // selfHostedHost names the refusal
  if (BARE_CONVEX_DOMAINS.has(host)) {
    throw new Error(`${name} must be a deployment address, not the bare ${host} domain.`);
  }
  if (host.endsWith(otherSuffix)) {
    throw new Error(`${name} holds a ${otherSuffix} address, which belongs in the other Convex variable.`);
  }
  return host.endsWith(ownSuffix) ? "cloud" : "selfHosted";
}

/** The `host[:port]` of a self-hosted origin, or a thrown, named refusal. */
function selfHostedHost(name: string, value: string): string {
  const refuse = (why: string): never => {
    throw new Error(`${name} must be a plain https://<dns-hostname>[:port] origin: ${why}.`);
  };
  if (FORBIDDEN_RAW.test(value)) refuse("it contains whitespace, control, non-ASCII or CSP-significant characters");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse("it is not a URL");
  }
  if (url.protocol !== "https:") refuse("the scheme is not https");
  if (url.username || url.password) refuse("it carries credentials");
  if (url.pathname !== "/" || url.search || url.hash || /[?#]/.test(value)) {
    refuse("it has a path, query or fragment");
  }
  const labels = url.hostname.split(".");
  const tld = labels[labels.length - 1] ?? "";
  if (labels.length < 2 || !labels.every((label) => DNS_LABEL.test(label)) || /^[0-9]+$/.test(tld)) {
    refuse("the host is not a DNS hostname (IP literals, single-label names and trailing dots are refused)");
  }
  if (url.hostname.length > 253) refuse("the host is longer than 253 characters");
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) refuse("the host is loopback");
  if (url.hostname === "convex.cloud" || url.hostname === "convex.site") refuse("the host is not a deployment");
  if (url.port === "0") refuse("port 0 is not allowed");
  // The Convex client splits the raw string on "://", so the raw value must be
  // exactly what the URL parser would emit. WHATWG URL elides a default port,
  // so `https://host:443` can never be canonical (URL.origin is `https://host`).
  if (value !== url.origin && value !== `${url.origin}/`) {
    refuse(
      /:443\/?$/.test(value)
        ? "drop :443, the default https port"
        : `write it exactly as ${url.origin} (canonical form: lowercase, no empty port, no percent-encoding)`,
    );
  }
  return url.host;
}

/**
 * Sources for a self-hosted Convex configuration, or null for the Convex Cloud
 * configuration (the policy is then left untouched).
 */
export function selfHostedConvexCspSources(env: Env): LocalConvexCspSources | null {
  const api = classify("NEXT_PUBLIC_CONVEX_URL", env.NEXT_PUBLIC_CONVEX_URL, ".convex.cloud", ".convex.site");
  const site = classify("NEXT_PUBLIC_CONVEX_SITE_URL", env.NEXT_PUBLIC_CONVEX_SITE_URL, ".convex.site", ".convex.cloud");
  const apiHosted = api === "selfHosted";
  const siteHosted = site === "selfHosted";
  if (!apiHosted && !siteHosted) return null;
  if (!apiHosted || (site === "cloud")) {
    throw new Error(
      "NEXT_PUBLIC_CONVEX_URL and NEXT_PUBLIC_CONVEX_SITE_URL mix Convex Cloud and self-hosted addresses.",
    );
  }
  const apiHost = selfHostedHost("NEXT_PUBLIC_CONVEX_URL", env.NEXT_PUBLIC_CONVEX_URL ?? "");
  const siteHost = siteHosted
    ? selfHostedHost("NEXT_PUBLIC_CONVEX_SITE_URL", env.NEXT_PUBLIC_CONVEX_SITE_URL ?? "")
    : undefined;
  const connect = [`https://${apiHost}`, `wss://${apiHost}`];
  if (siteHost !== undefined && !connect.includes(`https://${siteHost}`)) connect.push(`https://${siteHost}`);
  // File storage URLs are served from the API origin.
  return { connect, img: [`https://${apiHost}`] };
}

function withSources(directive: string, sources: string[]): string {
  return sources.length > 0 ? `${directive} ${sources.join(" ")}` : directive;
}

function withoutCloudWildcards(directive: string): string {
  return directive
    .split(" ")
    .filter((source) => !CLOUD_WILDCARDS.has(source))
    .join(" ");
}

/** The Content-Security-Policy header value for this build. */
export function buildContentSecurityPolicy(env: Env): string {
  const ci = localConvexCspSources(env);
  // The CI switch and a self-hosted address are mutually exclusive: with the
  // switch set the Convex URL must be the loopback backend, which throws above.
  const hosted = env[LOCAL_CONVEX_CI_FLAG] === "1" ? null : selfHostedConvexCspSources(env);
  const drop = hosted ? withoutCloudWildcards : (directive: string) => directive;
  const local = hosted ?? ci;
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://clerk.accounts.dev https://*.clerk.accounts.dev https://clerk.autoflowdealer.com https://challenges.cloudflare.com https://static.cloudflareinsights.com",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    withSources(
      drop(
        "img-src 'self' data: blob: https://*.convex.cloud https://img.clerk.com https://lh3.googleusercontent.com https://*.googleusercontent.com",
      ),
      local.img,
    ),
    withSources(
      drop(
        "connect-src 'self' https://*.convex.cloud wss://*.convex.cloud https://*.convex.site https://*.clerk.accounts.dev https://clerk.autoflowdealer.com https://clerk-telemetry.com https://vpic.nhtsa.dot.gov https://o4511556361715712.ingest.de.sentry.io https://cloudflareinsights.com https://vitals.vercel-insights.com",
      ),
      local.connect,
    ),
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
  ].join("; ");
}
