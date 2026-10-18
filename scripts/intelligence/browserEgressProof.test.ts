// @vitest-environment node
//
// SCRUM-350 G4 / SCRUM-784: unit tests for the egress proof runner. A fake
// browser stands in for Chromium (the real-Chromium run is
// browserEgressChromium.test.ts and the "Prove browser egress containment"
// workflow step), so the proof's own control flow - evidence assembly, failure
// classification, cleanup and the CLI exit codes - is exercised without a
// browser or any external network. The collectors are real sockets on loopback.
import net from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EGRESS_PROOF_CHANNELS,
  assessProxyDenials,
  attackFromPage,
  collectProofFailures,
  runBrowserEgressProof,
  runBrowserEgressProofCli,
} from "./browserEgressProof.mjs";

const PROXY_ENV = { BROWSER_EGRESS_PROXY_SERVER: "http://127.0.0.1:3129" };
const GOOD_LOG = "egress-allowlist 127.0.0.1:3000\negress-denied not-allowlisted-loopback\n";

const goodOutcomes = (): Record<string, string> =>
  Object.fromEntries(Object.entries(EGRESS_PROOF_CHANNELS).map(([name, accepted]) => [name, accepted[0]]));

describe("collectProofFailures", () => {
  const pass = () => ({
    tcpEvents: 0,
    udpPackets: 0,
    attackResult: { outcomes: goodOutcomes(), allowedStatus: 200 },
    navigation: "response:403",
  });

  it("reports nothing for a full pass", () => {
    expect(collectProofFailures(pass())).toEqual([]);
  });

  it("reports collector traffic, a broken allowlisted origin and an escaped navigation, in that order", () => {
    const failures = collectProofFailures({
      ...pass(),
      tcpEvents: 2,
      udpPackets: 1,
      attackResult: { outcomes: goodOutcomes(), allowedStatus: 502 },
      navigation: "response:200",
    });
    expect(failures).toEqual([
      "collector received TCP traffic (2 events)",
      "collector received UDP traffic (1 packets)",
      "allowlisted origin was not reachable through the proxy (status 502)",
      "top-level navigation to the collector was not refused",
    ]);
  });

  it("treats a missing, uncontained or non-string probe outcome as a failure, never a skip", () => {
    const outcomes: Record<string, unknown> = { ...goodOutcomes(), websocket: "open", beacon: 7 };
    delete outcomes.fetch;
    const failures = collectProofFailures({ ...pass(), attackResult: { outcomes, allowedStatus: 200 } });
    expect(failures).toEqual([
      'mandatory probe "fetch" did not end in a contained outcome',
      'mandatory probe "beacon" did not end in a contained outcome',
      'mandatory probe "websocket" did not end in a contained outcome',
    ]);
  });

  it("flags a probe that is not on the mandatory list", () => {
    const failures = collectProofFailures({
      ...pass(),
      attackResult: { outcomes: { ...goodOutcomes(), sneaky: "done" }, allowedStatus: 200 },
    });
    expect(failures).toEqual(["an unlisted probe ran"]);
  });
});

describe("assessProxyDenials", () => {
  it("accepts a log that recorded the loopback collector denial", async () => {
    expect(await assessProxyDenials(() => GOOD_LOG)).toEqual({
      proxyDenials: { "not-allowlisted-loopback": 1, unrecognized: 0 },
      failures: [],
    });
  });

  it("fails closed when there is no way to read the log", async () => {
    expect(await assessProxyDenials(undefined)).toEqual({
      proxyDenials: null,
      failures: ["the proxy denial log could not be read"],
    });
  });

  it("fails closed when reading the log throws", async () => {
    const result = await assessProxyDenials(() => {
      throw new Error("ENOENT");
    });
    expect(result.proxyDenials).toBeNull();
    expect(result.failures).toEqual(["the proxy denial log could not be read"]);
  });

  it("fails when the loopback probe was never refused or the log holds unknown lines", async () => {
    const result = await assessProxyDenials(async () => "egress-denied not-allowlisted\nGET evil.example:443\n");
    expect(result.failures).toEqual([
      "the proxy did not record a denial of the loopback collector probe",
      "the proxy log contained lines outside the fixed vocabulary",
    ]);
    expect(result.proxyDenials).toEqual({ "not-allowlisted": 1, unrecognized: 1 });
  });
});

type Fake = {
  launched: Record<string, any>[];
  contextOptions: Record<string, any>[];
  routes: string[];
  gotos: string[];
  closed: number;
  launchBrowser: (options: Record<string, any>) => Promise<any>;
};

/**
 * A fake Playwright browser. `attack` receives the arguments the proof passes
 * to page.evaluate (including the collector ports) and returns what the page
 * would have reported.
 */
function fakeBrowser(options: {
  attack?: (args: any) => Promise<any> | any;
  navigation?: () => Promise<any>;
}): Fake {
  const fake: Fake = {
    launched: [],
    contextOptions: [],
    routes: [],
    gotos: [],
    closed: 0,
    launchBrowser: async (launchOptions) => {
      fake.launched.push(launchOptions);
      return {
        newContext: async (contextOptions: Record<string, any>) => {
          fake.contextOptions.push(contextOptions);
          return {
            route: async (url: string) => {
              fake.routes.push(url);
            },
            newPage: async () => ({
              goto: async (url: string) => {
                fake.gotos.push(url);
                if (url.includes("__egress_proof__")) return undefined;
                return options.navigation ? options.navigation() : { status: () => 403 };
              },
              evaluate: async (_fn: unknown, args: any) =>
                options.attack ? options.attack(args) : { outcomes: goodOutcomes(), allowedStatus: 200 },
            }),
          };
        },
        close: async () => {
          fake.closed += 1;
        },
      };
    },
  };
  return fake;
}

describe("runBrowserEgressProof with a fake browser", () => {
  it("passes and assembles the full evidence when every channel is contained", async () => {
    const fake = fakeBrowser({});
    const result = await runBrowserEgressProof({
      env: PROXY_ENV,
      readProxyLog: () => GOOD_LOG,
      launchBrowser: fake.launchBrowser,
      settleMs: 0,
    });
    expect(result).toEqual({
      ok: true,
      failures: [],
      collector: { tcpEvents: 0, udpPackets: 0 },
      allowedStatus: 200,
      topLevelNavigation: "response:403",
      channels: goodOutcomes(),
      proxyDenials: { "not-allowlisted-loopback": 1, unrecognized: 0 },
    });
    expect(fake.closed).toBe(1);
  });

  it("launches Chromium through the proxy with the hardening flags and blocks service workers", async () => {
    const fake = fakeBrowser({});
    await runBrowserEgressProof({
      env: PROXY_ENV,
      readProxyLog: () => GOOD_LOG,
      launchBrowser: fake.launchBrowser,
      settleMs: 0,
    });
    expect(fake.launched).toHaveLength(1);
    expect(fake.launched[0].headless).toBe(true);
    expect(fake.launched[0].proxy).toEqual({ server: "http://127.0.0.1:3129" });
    expect(fake.launched[0].args).toEqual(
      expect.arrayContaining(["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"]),
    );
    expect(fake.contextOptions).toEqual([{ serviceWorkers: "block" }]);
    expect(fake.routes).toEqual([
      "http://127.0.0.1:3000/__egress_proof__",
      "http://127.0.0.1:3000/__egress_sw.js",
    ]);
    expect(fake.gotos[0]).toBe("http://127.0.0.1:3000/__egress_proof__");
    expect(fake.gotos[1]).toMatch(/^http:\/\/127\.0\.0\.2:\d+\/exfil\?token=SECRET$/);
  });

  it("hands the page the allowlisted URL built from the configured origin and path", async () => {
    let seen: any;
    const fake = fakeBrowser({
      attack: (args) => {
        seen = args;
        return { outcomes: goodOutcomes(), allowedStatus: 200 };
      },
    });
    await runBrowserEgressProof({
      env: PROXY_ENV,
      allowedOrigin: "http://localhost:4000",
      allowedPath: "/ping",
      readProxyLog: () => GOOD_LOG,
      launchBrowser: fake.launchBrowser,
      settleMs: 0,
    });
    expect(seen.allowedUrl).toBe("http://localhost:4000/ping");
    expect(seen.host).toBe("127.0.0.2");
    expect(seen.tcpPort).toBeGreaterThan(0);
    expect(seen.udpPort).toBeGreaterThan(0);
  });

  it("refuses to launch at all when the proxy is not configured", async () => {
    const fake = fakeBrowser({});
    await expect(
      runBrowserEgressProof({ env: {}, readProxyLog: () => GOOD_LOG, launchBrowser: fake.launchBrowser, settleMs: 0 }),
    ).rejects.toThrow(/open egress/);
    expect(fake.launched).toHaveLength(0);
  });

  it("fails when the collector receives TCP traffic (a probe was not blocked)", async () => {
    const fake = fakeBrowser({
      attack: async ({ tcpPort, host }) => {
        await new Promise<void>((resolve) => {
          const socket = net.connect(tcpPort, host, () => socket.write("GET / HTTP/1.0\r\n\r\n"));
          socket.on("data", () => socket.destroy());
          socket.on("close", () => resolve());
          socket.on("error", () => resolve());
        });
        return { outcomes: goodOutcomes(), allowedStatus: 200 };
      },
    });
    const result = await runBrowserEgressProof({
      env: PROXY_ENV,
      readProxyLog: () => GOOD_LOG,
      launchBrowser: fake.launchBrowser,
      settleMs: 50,
    });
    expect(result.ok).toBe(false);
    expect(result.collector.tcpEvents).toBeGreaterThan(0);
    expect(result.failures[0]).toMatch(/^collector received TCP traffic/);
  });

  it("fails when a probe escaped, the allowlisted origin is down and navigation was not refused", async () => {
    const fake = fakeBrowser({
      attack: () => ({ outcomes: { ...goodOutcomes(), websocket: "open" }, allowedStatus: -1 }),
      navigation: async () => ({ status: () => 200 }),
    });
    const result = await runBrowserEgressProof({
      env: PROXY_ENV,
      readProxyLog: () => GOOD_LOG,
      launchBrowser: fake.launchBrowser,
      settleMs: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.topLevelNavigation).toBe("response:200");
    expect(result.failures).toEqual([
      "allowlisted origin was not reachable through the proxy (status -1)",
      'mandatory probe "websocket" did not end in a contained outcome',
      "top-level navigation to the collector was not refused",
    ]);
  });

  it("records a failed navigation as contained and a response without a status as response:none", async () => {
    const refused = await runBrowserEgressProof({
      env: PROXY_ENV,
      readProxyLog: () => GOOD_LOG,
      launchBrowser: fakeBrowser({ navigation: () => Promise.reject(new Error("net::ERR")) }).launchBrowser,
      settleMs: 0,
    });
    expect(refused.topLevelNavigation).toBe("failed");
    expect(refused.ok).toBe(true);

    const none = await runBrowserEgressProof({
      env: PROXY_ENV,
      readProxyLog: () => GOOD_LOG,
      launchBrowser: fakeBrowser({ navigation: async () => null }).launchBrowser,
      settleMs: 0,
    });
    expect(none.topLevelNavigation).toBe("response:none");
    expect(none.ok).toBe(false);
  });

  it("fails closed when no proxy log can be read", async () => {
    const result = await runBrowserEgressProof({
      env: PROXY_ENV,
      launchBrowser: fakeBrowser({}).launchBrowser,
      settleMs: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.proxyDenials).toBeNull();
    expect(result.failures).toEqual(["the proxy denial log could not be read"]);
  });

  it("reads the proxy log from the file named by BROWSER_EGRESS_PROXY_LOG by default", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "egress-proof-"));
    try {
      const file = path.join(dir, "proxy.log");
      writeFileSync(file, GOOD_LOG);
      const result = await runBrowserEgressProof({
        env: { ...PROXY_ENV, BROWSER_EGRESS_PROXY_LOG: file },
        launchBrowser: fakeBrowser({}).launchBrowser,
        settleMs: 0,
      });
      expect(result.ok).toBe(true);
      expect(result.proxyDenials).toEqual({ "not-allowlisted-loopback": 1, unrecognized: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("closes the browser and the collectors even when the page evaluation throws", async () => {
    const fake = fakeBrowser({
      attack: () => {
        throw new Error("page crashed");
      },
    });
    await expect(
      runBrowserEgressProof({
        env: PROXY_ENV,
        readProxyLog: () => GOOD_LOG,
        launchBrowser: fake.launchBrowser,
        settleMs: 0,
      }),
    ).rejects.toThrow("page crashed");
    expect(fake.closed).toBe(1);
  });

  it("still releases the collectors when closing the browser itself fails", async () => {
    const fake = fakeBrowser({});
    const result = await runBrowserEgressProof({
      env: PROXY_ENV,
      readProxyLog: () => GOOD_LOG,
      launchBrowser: async (options) => {
        const browser = await fake.launchBrowser(options);
        return { ...browser, close: () => Promise.reject(new Error("already gone")) };
      },
      settleMs: 0,
    });
    expect(result.ok).toBe(true);
  });
});

describe("runBrowserEgressProofCli", () => {
  function harness() {
    const out: string[] = [];
    const err: string[] = [];
    const codes: number[] = [];
    return {
      out,
      err,
      codes,
      io: {
        stdout: (text: string) => out.push(text),
        stderr: (text: string) => err.push(text),
        exit: (code: number) => codes.push(code),
      },
    };
  }

  it("exits 1 without running anything when the proxy variable is missing", async () => {
    const h = harness();
    const run = vi.fn();
    await runBrowserEgressProofCli({ env: {}, run, ...h.io });
    expect(run).not.toHaveBeenCalled();
    expect(h.err.join("")).toBe("BROWSER_EGRESS_PROXY_SERVER is required.\n");
    expect(h.codes).toEqual([1]);
  });

  it("prints the evidence JSON and exits 0 on a pass, forwarding the configured origin and path", async () => {
    const h = harness();
    const run = vi.fn(async () => ({ ok: true }) as any);
    await runBrowserEgressProofCli({
      env: { ...PROXY_ENV, BROWSER_EGRESS_ALLOWED_ORIGIN: "http://localhost:4000", BROWSER_EGRESS_ALLOWED_PATH: "/x" },
      run,
      ...h.io,
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ allowedOrigin: "http://localhost:4000", allowedPath: "/x" }),
    );
    expect(JSON.parse(h.out.join(""))).toEqual({ ok: true });
    expect(h.codes).toEqual([0]);
  });

  it("uses the default origin and path, and exits 1 when the proof does not pass", async () => {
    const h = harness();
    const run = vi.fn(async () => ({ ok: false, failures: ["x"] }) as any);
    await runBrowserEgressProofCli({ env: PROXY_ENV, run, ...h.io });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ allowedOrigin: "http://127.0.0.1:3000", allowedPath: "/api/health" }),
    );
    expect(h.codes).toEqual([1]);
  });

  it("exits 1 with only the error message when the proof cannot run", async () => {
    const h = harness();
    await runBrowserEgressProofCli({
      env: PROXY_ENV,
      run: async () => {
        throw new Error("browser missing");
      },
      ...h.io,
    });
    expect(h.err.join("")).toBe("Egress proof could not run: browser missing\n");
    expect(h.out).toEqual([]);
    expect(h.codes).toEqual([1]);

    const h2 = harness();
    await runBrowserEgressProofCli({
      env: PROXY_ENV,
      run: () => Promise.reject("not an error"),
      ...h2.io,
    });
    expect(h2.err.join("")).toBe("Egress proof could not run: unknown\n");
    expect(h2.codes).toEqual([1]);
  });
});

// attackFromPage runs inside the browser; here it runs against fake browser
// globals so every probe's branch (including the catch) executes.
describe("attackFromPage against fake browser globals", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubBrowser(overrides: { throwBeacon?: boolean; noServiceWorker?: boolean; registered?: boolean; fetchThrows?: boolean } = {}) {
    const realSetTimeout = globalThis.setTimeout;
    // Collapse the in-page waits (up to 2s each) so the test is instant.
    vi.stubGlobal("setTimeout", ((fn: () => void) => realSetTimeout(fn, 0)) as unknown as typeof setTimeout);
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(String(url));
      if (overrides.fetchThrows && String(url).includes("attacker")) {
        const error = new TypeError("Failed to fetch");
        throw error;
      }
      if (String(url).includes("/api/health")) return { type: "basic", status: 200 };
      return { type: "opaque", status: 0 };
    });
    vi.stubGlobal(
      "XMLHttpRequest",
      class {
        onloadend: (() => void) | undefined;
        open() {}
        send() {
          queueMicrotask(() => this.onloadend?.());
        }
      },
    );
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | undefined;
        onerror: (() => void) | undefined;
        set src(_value: string) {
          queueMicrotask(() => this.onerror?.());
        }
      },
    );
    vi.stubGlobal(
      "WebSocket",
      class {
        onerror: (() => void) | undefined;
        constructor() {
          queueMicrotask(() => this.onerror?.());
        }
      },
    );
    vi.stubGlobal(
      "EventSource",
      class {
        onerror: (() => void) | undefined;
        constructor() {
          queueMicrotask(() => this.onerror?.());
        }
        close() {}
      },
    );
    const appended: any[] = [];
    vi.stubGlobal("document", {
      body: { appendChild: (node: any) => appended.push(node) },
      createElement: (tag: string) => {
        const node: any = { tag };
        if (tag === "iframe") {
          Object.defineProperty(node, "src", {
            set() {
              queueMicrotask(() => node.onload?.());
            },
          });
        }
        if (tag === "form") node.submit = () => {};
        return node;
      },
    });
    vi.stubGlobal("window", { open: () => null });
    vi.stubGlobal(
      "RTCPeerConnection",
      class {
        createDataChannel() {}
        async createOffer() {
          return {};
        }
        async setLocalDescription() {}
        close() {}
      },
    );
    const navigatorStub: Record<string, unknown> = {
      sendBeacon: () => {
        if (overrides.throwBeacon) throw new TypeError("bad beacon");
        return true;
      },
    };
    if (!overrides.noServiceWorker) {
      navigatorStub.serviceWorker = {
        register: async () => undefined,
        getRegistrations: async () => (overrides.registered ? [{}] : []),
      };
    }
    vi.stubGlobal("navigator", navigatorStub);
    return { fetched, appended };
  }

  const args = { tcpPort: 1111, udpPort: 2222, host: "127.0.0.2", allowedUrl: "http://127.0.0.1:3000/api/health" };

  it("reports a contained outcome for every mandatory channel and the allowlisted status", async () => {
    const { fetched } = stubBrowser();
    const result = await attackFromPage(args);
    expect(Object.keys(result.outcomes).sort()).toEqual(Object.keys(EGRESS_PROOF_CHANNELS).sort());
    expect(result.allowedStatus).toBe(200);
    expect(result.outcomes).toMatchObject({
      fetch: "opaque",
      xhr: "done",
      image: "done",
      beacon: "true",
      websocket: "error",
      eventsource: "error",
      iframe: "done",
      "form-post": "submitted",
      popup: "false",
      webrtc: "attempted",
      "service-worker": "blocked",
    });
    // The exfil payload goes only to the configured collector host:port.
    expect(fetched).toContain("http://127.0.0.2:1111/exfil?token=SECRET");
    expect(fetched).toContain("http://attacker.invalid/exfil");
    expect(fetched).toContain(args.allowedUrl);
    // And the in-page outcomes are exactly what the verifier accepts.
    expect(collectProofFailures({ tcpEvents: 0, udpPackets: 0, attackResult: result, navigation: "failed" })).toEqual([]);
  });

  it("turns a throwing probe into a threw:<name> outcome instead of throwing itself", async () => {
    stubBrowser({ throwBeacon: true, fetchThrows: true });
    const result = await attackFromPage(args);
    expect(result.outcomes.beacon).toBe("threw:TypeError");
    expect(result.outcomes["fetch-unknown-name"]).toBe("threw:TypeError");
    // A beacon that throws is not an accepted contained outcome for that probe,
    // while a refused fetch (threw:TypeError) is.
    expect(collectProofFailures({ tcpEvents: 0, udpPackets: 0, attackResult: result, navigation: "failed" })).toEqual([
      'mandatory probe "beacon" did not end in a contained outcome',
    ]);
  });

  it("names an anonymous error 'threw:error'", async () => {
    stubBrowser();
    vi.stubGlobal("navigator", {
      sendBeacon: () => {
        throw null;
      },
      serviceWorker: { register: async () => undefined, getRegistrations: async () => [] },
    });
    const result = await attackFromPage(args);
    expect(result.outcomes.beacon).toBe("threw:error");
  });

  it("reports REGISTERED when a service worker is actually registered, and unavailable when the API is absent", async () => {
    stubBrowser({ registered: true });
    expect((await attackFromPage(args)).outcomes["service-worker"]).toBe("REGISTERED");
    vi.unstubAllGlobals();

    stubBrowser({ noServiceWorker: true });
    expect((await attackFromPage(args)).outcomes["service-worker"]).toBe("unavailable");
  });

  it("reports -1 when the allowlisted fetch itself fails", async () => {
    stubBrowser();
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("/api/health")) throw new TypeError("proxy down");
      return { type: "opaque" };
    });
    expect((await attackFromPage(args)).allowedStatus).toBe(-1);
  });
});
