// @vitest-environment node
import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BROWSER_EGRESS_PROXY_ENV,
  EGRESS_CHROMIUM_ARGS,
  EGRESS_CONTEXT_OPTIONS,
  browserEgressLaunchOptions,
  buildEgressAllowlist,
  createEgressProxy,
  startEgressProxy,
} from "./browserEgressContainment.mjs";

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
    expect(recorded).toContain("egress-denied GET 127.0.0.2:9 not-allowlisted");
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
    stop();
  });
});
