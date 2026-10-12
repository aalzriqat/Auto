import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { clerkTestFrontendApiOrigin } from "./clerkPublicJwtKey.mjs";

/**
 * SCRUM-784 browser egress containment.
 *
 * Invariant: candidate-controlled page content must not export authenticated QA
 * authority beyond the candidate origin, the exact Convex preview deployment and
 * the Clerk test Frontend API.
 *
 * The saved QA storageState lives in host Chromium on an Internet-connected
 * runner, so a Playwright `route()` is not enough (it does not see service
 * workers, WebSockets, browser-process traffic or popups). Instead the whole
 * browser is pointed at this TRUSTED deny-by-default forward proxy, which
 * allowlists exact host:port pairs. This file is trusted-main code and never
 * loaded from the candidate checkout.
 */

export const BROWSER_EGRESS_PROXY_ENV = "BROWSER_EGRESS_PROXY_SERVER";
export const BROWSER_EGRESS_REQUIRED_ENV = "BROWSER_EGRESS_REQUIRED";
export const DEFAULT_EGRESS_PROXY_PORT = 3129;
export const DEFAULT_CANDIDATE_ORIGIN = "http://127.0.0.1:3000";

/** Context options every candidate-facing browser context must use. */
export const EGRESS_CONTEXT_OPTIONS = Object.freeze({ serviceWorkers: "block" });

/**
 * Chromium flags that close paths a proxy setting alone leaves open:
 * - no local DNS resolution at all (the proxy resolves; a page cannot make the
 *   browser process resolve an attacker name, which would be a DNS channel);
 * - WebRTC may only use the proxy, never direct UDP (STUN/TURN is an exfil
 *   channel that ignores --proxy-server);
 * - no QUIC/HTTP3 (UDP that would bypass an HTTP proxy).
 */
export const EGRESS_CHROMIUM_ARGS = Object.freeze([
  "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-quic",
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

/**
 * The complete vocabulary of the proxy's denial log (SCRUM-350 G4-01). The log
 * is uploaded as a workflow artifact from a public repository, so it may carry
 * only these trusted constants: never a method, host, port, path or any other
 * byte the candidate chose. `not-allowlisted-loopback` is a coarse class
 * (127.0.0.0/8 or localhost, but not an allowlisted authority); it exists so the
 * proof can show its deliberate 127.0.0.2 collector probe was refused without
 * the host being logged.
 */
export const EGRESS_DENIAL_REASONS = Object.freeze([
  "not-allowlisted",
  "not-allowlisted-loopback",
  "unresolvable-or-private",
  "not-absolute-form",
  "plain-upgrade-unsupported",
]);
const EGRESS_DENIED_PREFIX = "egress-denied ";

/** @param {string} host */
function isLoopbackName(host) {
  return host === "localhost" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === "[::1]";
}

/**
 * Count the proxy log's denials by reason. Any line that is not a denial with a
 * known reason, the allowlist banner or the listening banner is counted as
 * `unrecognized`, so a regression that logs raw request data is visible.
 *
 * @param {string} text
 * @returns {{ denials: Record<string, number>, unrecognized: number }}
 */
export function parseEgressDenialLog(text) {
  /** @type {Record<string, number>} */
  const denials = {};
  let unrecognized = 0;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line === "") continue;
    if (line.startsWith("egress-allowlist ") || /^egress-proxy-listening 127\.0\.0\.1:\d+$/.test(line)) continue;
    const reason = line.startsWith(EGRESS_DENIED_PREFIX) ? line.slice(EGRESS_DENIED_PREFIX.length) : "";
    if (EGRESS_DENIAL_REASONS.includes(reason)) {
      denials[reason] = (denials[reason] ?? 0) + 1;
    } else {
      unrecognized += 1;
    }
  }
  return { denials, unrecognized };
}

/**
 * Playwright `launchOptions` for the egress proxy, or undefined when egress
 * containment is not requested. When BROWSER_EGRESS_REQUIRED=1 a missing or
 * malformed proxy is an error, never a silent fall-back to open egress.
 *
 * Playwright adds `--proxy-bypass-list=<-loopback>` itself when no bypass is
 * given, so loopback traffic (including the candidate) also traverses the proxy.
 *
 * @param {Record<string, string | undefined>} env
 */
export function browserEgressLaunchOptions(env) {
  const server = env[BROWSER_EGRESS_PROXY_ENV]?.trim();
  if (!server) {
    if (env[BROWSER_EGRESS_REQUIRED_ENV] === "1") {
      throw new Error(
        `${BROWSER_EGRESS_REQUIRED_ENV}=1 but ${BROWSER_EGRESS_PROXY_ENV} is not set; refusing to launch a browser with open egress.`,
      );
    }
    return undefined;
  }
  let parsed;
  try {
    parsed = new URL(server);
  } catch {
    throw new Error(`${BROWSER_EGRESS_PROXY_ENV} must be a valid URL.`);
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `${BROWSER_EGRESS_PROXY_ENV} must be exactly http://127.0.0.1:<port>.`,
    );
  }
  return { proxy: { server: parsed.origin }, args: [...EGRESS_CHROMIUM_ARGS] };
}

/** @param {string} value @param {number} defaultPort */
function parseAuthority(value, defaultPort) {
  const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/i.exec(
    String(value ?? "").trim(),
  );
  if (!match) return null;
  const port = match[2] === undefined ? defaultPort : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1].toLowerCase(), port };
}

/**
 * Exact host:port allowlist. No wildcards, no suffix matching.
 *
 * @param {{
 *   candidateOrigin?: string,
 *   convexUrl: string | undefined,
 *   clerkPublishableKey: string | undefined,
 *   extra?: string[],
 * }} input
 * @returns {string[]} sorted "host:port" entries
 */
export function buildEgressAllowlist({
  candidateOrigin = DEFAULT_CANDIDATE_ORIGIN,
  convexUrl,
  clerkPublishableKey,
  extra = [],
}) {
  const entries = new Set();

  const candidate = new URL(candidateOrigin);
  if (candidate.protocol !== "http:" || !LOOPBACK_HOSTS.has(candidate.hostname)) {
    throw new Error("Candidate origin must be http on 127.0.0.1 or localhost.");
  }
  const candidatePort = candidate.port || "80";
  // The same relay answers on both names; both are mapped to 127.0.0.1.
  entries.add(`127.0.0.1:${candidatePort}`);
  entries.add(`localhost:${candidatePort}`);

  let convex;
  try {
    convex = new URL(convexUrl ?? "");
  } catch {
    throw new Error("NEXT_PUBLIC_CONVEX_URL must be a valid URL for the egress allowlist.");
  }
  if (convex.protocol !== "https:" || !/^[a-z0-9-]+\.convex\.cloud$/.test(convex.hostname)) {
    throw new Error("Egress allowlist requires an exact https *.convex.cloud preview deployment.");
  }
  entries.add(`${convex.hostname}:${convex.port || "443"}`);

  const clerk = new URL(clerkTestFrontendApiOrigin(clerkPublishableKey));
  entries.add(`${clerk.hostname}:${clerk.port || "443"}`);

  for (const item of extra) {
    const parsed = parseAuthority(item, 0);
    if (!parsed || parsed.port === 0 || net.isIP(parsed.host) || LOOPBACK_HOSTS.has(parsed.host)) {
      throw new Error("Extra egress entries must be exact hostname:port (no IPs, loopback or wildcards).");
    }
    entries.add(`${parsed.host}:${parsed.port}`);
  }
  return [...entries].sort();
}

/** @param {string} ip */
function isPublicAddress(ip) {
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return !(
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fe80:") ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("::ffff:")
    );
  }
  const [a, b] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/**
 * Resolve an allowlisted authority to the one address the proxy will dial.
 * Loopback names map to 127.0.0.1; any other name must resolve to a public
 * address, so an allowed name cannot be turned into a path to the runner's
 * private network.
 *
 * @param {string} host
 */
async function resolveTarget(host) {
  if (LOOPBACK_HOSTS.has(host)) return "127.0.0.1";
  const addresses = await dns.lookup(host, { all: true });
  const usable = addresses.find((entry) => isPublicAddress(entry.address));
  if (!usable) throw new Error("no public address");
  return usable.address;
}

/**
 * Deny-by-default forward proxy. Handles absolute-form HTTP (the candidate over
 * http) and CONNECT (https and WebSockets). Plain `Upgrade` requests are denied:
 * Chromium tunnels ws:// and wss:// through CONNECT.
 *
 * Denials are recorded as `egress-denied <reason>` where reason is one of the
 * fixed EGRESS_DENIAL_REASONS. The method, host, port, path, query, headers and
 * bodies of a denied request are never logged: every one of them is
 * candidate-controlled and can carry the very credentials this proxy exists to
 * contain (a page can encode a token into host labels of a request it knows
 * will be denied), and the log is uploaded as a workflow artifact.
 *
 * @param {{ allow: string[], log?: (line: string) => void }} options
 */
export function createEgressProxy({ allow, log = () => {} }) {
  const allowed = new Set(allow.map((entry) => entry.toLowerCase()));
  /** @type {string[]} */
  const denied = [];
  /** @type {string[]} */
  const permitted = [];
  const sockets = new Set();

  /** @param {string} reason one of EGRESS_DENIAL_REASONS */
  function deny(reason) {
    // Defence in depth: a reason outside the vocabulary can never be emitted.
    const safe = EGRESS_DENIAL_REASONS.includes(reason) ? reason : "not-allowlisted";
    const line = `${EGRESS_DENIED_PREFIX}${safe}`;
    denied.push(line);
    log(line);
  }

  /** @param {string} host */
  function notAllowlistedReason(host) {
    return isLoopbackName(host) ? "not-allowlisted-loopback" : "not-allowlisted";
  }

  /** @param {import("node:net").Socket} socket */
  function track(socket) {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(120_000, () => socket.destroy());
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? "");
    } catch {
      deny("not-absolute-form");
      res.writeHead(403).end("egress denied");
      return;
    }
    const authority = `${url.hostname}:${url.port || "80"}`.toLowerCase();
    if (url.protocol !== "http:" || !allowed.has(authority)) {
      deny(notAllowlistedReason(url.hostname));
      res.writeHead(403, { "content-type": "text/plain" }).end("egress denied");
      return;
    }
    let address;
    try {
      address = await resolveTarget(url.hostname);
    } catch {
      deny("unresolvable-or-private");
      res.writeHead(502).end("egress denied");
      return;
    }
    permitted.push(`${req.method} ${authority}`);
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = http.request(
      {
        host: address,
        port: Number(url.port || 80),
        method: req.method,
        path: url.pathname + url.search,
        headers,
        agent: false,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on("connection", track);
  server.maxConnections = 512;

  server.on("connect", async (req, clientSocket, head) => {
    const parsed = parseAuthority(req.url ?? "", 0);
    const authority = parsed ? `${parsed.host}:${parsed.port}` : "-";
    if (!parsed || parsed.port === 0 || !allowed.has(authority)) {
      deny(notAllowlistedReason(parsed ? parsed.host : ""));
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    let address;
    try {
      address = await resolveTarget(parsed.host);
    } catch {
      deny("unresolvable-or-private");
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      return;
    }
    permitted.push(`CONNECT ${authority}`);
    const upstream = net.connect({ host: address, port: parsed.port });
    track(upstream);
    upstream.on("connect", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => {
      if (!clientSocket.destroyed) {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      }
    });
    upstream.on("close", () => clientSocket.destroy());
    clientSocket.on("close", () => upstream.destroy());
  });

  server.on("upgrade", (req, socket) => {
    deny("plain-upgrade-unsupported");
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });

  function stop() {
    for (const socket of sockets) socket.destroy();
    server.close();
  }

  return { server, denied, permitted, stop };
}

/**
 * @param {{ allow: string[], port?: number, log?: (line: string) => void }} options
 */
export function startEgressProxy({ allow, port = DEFAULT_EGRESS_PROXY_PORT, log }) {
  const proxy = createEgressProxy({ allow, log });
  return new Promise((resolve, reject) => {
    proxy.server.once("error", reject);
    proxy.server.listen(port, "127.0.0.1", () => {
      proxy.server.off("error", reject);
      const address = proxy.server.address();
      resolve({
        ...proxy,
        port: typeof address === "object" && address ? address.port : port,
      });
    });
  });
}

/** CLI used by the trusted workflow. Fails closed: any problem exits non-zero. */
async function main(env) {
  const allow = buildEgressAllowlist({
    candidateOrigin: env.BROWSER_EGRESS_CANDIDATE_ORIGIN || DEFAULT_CANDIDATE_ORIGIN,
    convexUrl: env.NEXT_PUBLIC_CONVEX_URL,
    clerkPublishableKey: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    extra: (env.BROWSER_EGRESS_EXTRA_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean),
  });
  const port = Number(env.BROWSER_EGRESS_PROXY_PORT || DEFAULT_EGRESS_PROXY_PORT);
  const proxy = await startEgressProxy({
    allow,
    port,
    log: (line) => process.stdout.write(line + "\n"),
  });
  process.stdout.write(`egress-allowlist ${allow.join(" ")}\n`);
  // The workflow waits for exactly this line before it trusts the proxy.
  process.stdout.write(`egress-proxy-listening 127.0.0.1:${proxy.port}\n`);
  process.on("SIGTERM", () => {
    proxy.stop();
    process.exit(0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.env).catch((error) => {
    process.stderr.write(`Could not start egress proxy: ${error instanceof Error ? error.message : "unknown"}\n`);
    process.exit(1);
  });
}
