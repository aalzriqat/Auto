// @vitest-environment node
//
// SCRUM-350 G4 / SCRUM-784: the proxy branches browserEgressContainment.test.ts
// does not reach - upstream failures, CONNECT edge cases, address
// classification, name resolution and the CLI entry. Everything runs against
// real sockets on 127.0.0.1 ephemeral ports; DNS is the only thing faked, and
// only for names that never leave the machine.
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_EGRESS_PROXY_ENV,
  browserEgressLaunchOptions,
  buildEgressAllowlist,
  createEgressProxy,
  isPublicAddress,
  main,
  parseEgressDenialLog,
  resolveTarget,
  startEgressProxy,
} from "./browserEgressContainment.mjs";

// Delegates to the real resolver unless a test overrides a single lookup.
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import("node:dns/promises") }>();
  const lookup = vi.fn((...args: unknown[]) => (actual.default.lookup as (...a: unknown[]) => unknown)(...args));
  return { ...actual, default: { ...actual.default, lookup } };
});

const PK = "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk"; // example.clerk.accounts.dev
const CONVEX = "https://happy-animal-123.convex.cloud";

async function listen(server: http.Server | net.Server, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return (server.address() as net.AddressInfo).port;
}

/** A port nothing listens on: bind, read the port, release it. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

afterEach(() => vi.restoreAllMocks());

describe("buildEgressAllowlist edge cases", () => {
  it("refuses a candidate origin that is not plain http on loopback", () => {
    for (const candidateOrigin of ["https://127.0.0.1:3000", "http://evil.example:3000", "http://10.0.0.1:3000"]) {
      expect(() => buildEgressAllowlist({ candidateOrigin, convexUrl: CONVEX, clerkPublishableKey: PK })).toThrow(
        /Candidate origin must be http/,
      );
    }
  });

  it("uses the candidate's port (80 when omitted) for both loopback names", () => {
    const withPort = buildEgressAllowlist({ candidateOrigin: "http://localhost:4100", convexUrl: CONVEX, clerkPublishableKey: PK });
    expect(withPort).toContain("127.0.0.1:4100");
    expect(withPort).toContain("localhost:4100");
    const noPort = buildEgressAllowlist({ candidateOrigin: "http://127.0.0.1", convexUrl: CONVEX, clerkPublishableKey: PK });
    expect(noPort).toContain("127.0.0.1:80");
  });

  it("adds exact extra hostname:port entries and returns a stable sorted list", () => {
    const list = buildEgressAllowlist({
      convexUrl: "https://happy-animal-123.convex.cloud:8443",
      clerkPublishableKey: PK,
      extra: ["API.Example.com:8080"],
    });
    expect(list).toEqual([
      "127.0.0.1:3000",
      "api.example.com:8080",
      "example.clerk.accounts.dev:443",
      "happy-animal-123.convex.cloud:8443",
      "localhost:3000",
    ]);
    expect(list).toEqual([...list].sort());
  });

  it("refuses a Convex URL that is not a URL at all", () => {
    expect(() => buildEgressAllowlist({ convexUrl: "not a url", clerkPublishableKey: PK })).toThrow(/valid URL/);
  });
});

describe("browserEgressLaunchOptions malformed proxy", () => {
  it("rejects a proxy value that is not a URL", () => {
    expect(() => browserEgressLaunchOptions({ [BROWSER_EGRESS_PROXY_ENV]: "not a url" })).toThrow(
      /must be a valid URL/,
    );
  });
});

describe("isPublicAddress", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12::1",
    "::ffff:127.0.0.1",
  ])("treats %s as non-public", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(["93.184.216.34", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.15.0.1", "172.32.0.1", "2606:4700:4700::1111"])(
    "treats %s as public",
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    },
  );
});

describe("resolveTarget", () => {
  it("maps the loopback names to 127.0.0.1 without a DNS lookup", async () => {
    const lookup = vi.mocked(dns.lookup);
    lookup.mockClear();
    expect(await resolveTarget("localhost")).toBe("127.0.0.1");
    expect(await resolveTarget("127.0.0.1")).toBe("127.0.0.1");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns the first public address, skipping private ones", async () => {
    vi.mocked(dns.lookup).mockResolvedValueOnce([
      { address: "10.0.0.5", family: 4 },
      { address: "93.184.216.34", family: 4 },
    ] as never);
    expect(await resolveTarget("allowed.example")).toBe("93.184.216.34");
  });

  it("refuses a name whose every address is private (DNS rebinding to the runner's network)", async () => {
    vi.mocked(dns.lookup).mockResolvedValueOnce([
      { address: "169.254.169.254", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ] as never);
    await expect(resolveTarget("rebind.example")).rejects.toThrow("no public address");
  });

  it("propagates a resolution failure", async () => {
    vi.mocked(dns.lookup).mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(resolveTarget("nope.example")).rejects.toThrow("ENOTFOUND");
  });
});

describe("proxy upstream and tunnel failures", () => {
  function get(proxyPort: number, target: string, method = "GET"): Promise<{ status: number; body: string }> {
    const url = new URL(target);
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: proxyPort, method, path: target, headers: { host: url.host } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  function rawExchange(proxyPort: number, request: string, close = true): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      const socket = net.connect(proxyPort, "127.0.0.1", () => socket.write(request));
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
      socket.on("error", () => resolve(Buffer.concat(chunks).toString()));
      if (!close) setTimeout(() => socket.destroy(), 300);
    });
  }

  it("answers 502 when an allowlisted upstream refuses the connection, and counts it as permitted not denied", async () => {
    const dead = await closedPort();
    const lines: string[] = [];
    const proxy = await startEgressProxy({ allow: [`127.0.0.1:${dead}`], port: 0, log: (line) => lines.push(line) });
    try {
      const result = await get(proxy.port, `http://127.0.0.1:${dead}/x`);
      expect(result.status).toBe(502);
      expect(result.body).toBe("");
      expect(proxy.stats()).toEqual({ denied: 0, permitted: 1 });
      expect(lines).toEqual([]);
    } finally {
      proxy.stop();
    }
  });

  it("does not forward proxy-only headers and forwards the request body to an allowlisted upstream", async () => {
    let seen: { headers: http.IncomingHttpHeaders; body: string; url: string; method: string } | undefined;
    const upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        seen = { headers: req.headers, body, url: req.url ?? "", method: req.method ?? "" };
        res.writeHead(201, { "x-upstream": "yes" }).end("created");
      });
    });
    const upstreamPort = await listen(upstream);
    const proxy = await startEgressProxy({ allow: [`127.0.0.1:${upstreamPort}`], port: 0 });
    try {
      const response = await new Promise<{ status: number; header: string | undefined; body: string }>((resolve, reject) => {
        const target = `http://127.0.0.1:${upstreamPort}/path?q=1`;
        const req = http.request(
          {
            host: "127.0.0.1",
            port: proxy.port,
            method: "POST",
            path: target,
            headers: { host: `127.0.0.1:${upstreamPort}`, "proxy-connection": "keep-alive", "proxy-authorization": "Basic eA==" },
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, header: res.headers["x-upstream"] as string, body }));
          },
        );
        req.on("error", reject);
        req.end("payload");
      });
      expect(response).toEqual({ status: 201, header: "yes", body: "created" });
      expect(seen?.url).toBe("/path?q=1");
      expect(seen?.method).toBe("POST");
      expect(seen?.body).toBe("payload");
      expect(seen?.headers["proxy-connection"]).toBeUndefined();
      expect(seen?.headers["proxy-authorization"]).toBeUndefined();
    } finally {
      proxy.stop();
      upstream.close();
    }
  });

  it("denies an absolute-form request that is not plain http, even to an allowlisted authority", async () => {
    const lines: string[] = [];
    const proxy = await startEgressProxy({ allow: ["127.0.0.1:443"], port: 0, log: (line) => lines.push(line) });
    try {
      const raw = await rawExchange(proxy.port, "GET https://127.0.0.1:443/x HTTP/1.1\r\nHost: 127.0.0.1:443\r\nConnection: close\r\n\r\n");
      expect(raw.split("\r\n")[0]).toContain("403");
      expect(lines).toEqual(["egress-denied not-allowlisted-loopback"]);
    } finally {
      proxy.stop();
    }
  });

  it("records not-absolute-form for an origin-form request and emits only that fixed code", async () => {
    const lines: string[] = [];
    const proxy = await startEgressProxy({ allow: [], port: 0, log: (line) => lines.push(line) });
    try {
      const raw = await rawExchange(proxy.port, "GET /secret-path?token=SECRET HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      expect(raw.split("\r\n")[0]).toContain("403");
      expect(raw).toContain("egress denied");
      expect(lines).toEqual(["egress-denied not-absolute-form"]);
    } finally {
      proxy.stop();
    }
  });

  it("answers 502 to an allowlisted name that resolves only to private space, and logs a fixed code", async () => {
    vi.mocked(dns.lookup).mockResolvedValueOnce([{ address: "10.9.9.9", family: 4 }] as never);
    const lines: string[] = [];
    const proxy = await startEgressProxy({ allow: ["rebind.example:80"], port: 0, log: (line) => lines.push(line) });
    try {
      const result = await get(proxy.port, "http://rebind.example/");
      expect(result.status).toBe(502);
      expect(lines).toEqual(["egress-denied unresolvable-or-private"]);
      expect(proxy.stats()).toEqual({ denied: 1, permitted: 0 });
    } finally {
      proxy.stop();
    }
  });

  it("CONNECT to an allowlisted name that cannot be resolved is 502 with a fixed denial code", async () => {
    vi.mocked(dns.lookup).mockRejectedValueOnce(new Error("ENOTFOUND"));
    const lines: string[] = [];
    const proxy = await startEgressProxy({ allow: ["gone.example:443"], port: 0, log: (line) => lines.push(line) });
    try {
      const raw = await rawExchange(proxy.port, "CONNECT gone.example:443 HTTP/1.1\r\nHost: gone.example:443\r\n\r\n");
      expect(raw.split("\r\n")[0]).toContain("502");
      expect(lines).toEqual(["egress-denied unresolvable-or-private"]);
    } finally {
      proxy.stop();
    }
  });

  it("CONNECT to an allowlisted authority whose upstream refuses is 502, not a hang", async () => {
    const dead = await closedPort();
    const proxy = await startEgressProxy({ allow: [`127.0.0.1:${dead}`], port: 0 });
    try {
      const raw = await rawExchange(proxy.port, `CONNECT 127.0.0.1:${dead} HTTP/1.1\r\nHost: 127.0.0.1:${dead}\r\n\r\n`);
      expect(raw.split("\r\n")[0]).toContain("502");
      expect(proxy.stats()).toEqual({ denied: 0, permitted: 1 });
    } finally {
      proxy.stop();
    }
  });

  it("CONNECT with a malformed authority is denied and the reason class does not depend on the bytes", async () => {
    const lines: string[] = [];
    const proxy = await startEgressProxy({ allow: ["127.0.0.1:1"], port: 0, log: (line) => lines.push(line) });
    try {
      await rawExchange(proxy.port, "CONNECT !!bad HTTP/1.1\r\nHost: x\r\n\r\n");
      await rawExchange(proxy.port, "CONNECT 127.0.0.1:99999 HTTP/1.1\r\nHost: x\r\n\r\n");
      await rawExchange(proxy.port, "CONNECT evil.example HTTP/1.1\r\nHost: x\r\n\r\n");
      expect(lines).toEqual([
        "egress-denied not-allowlisted",
        "egress-denied not-allowlisted",
        "egress-denied not-allowlisted",
      ]);
    } finally {
      proxy.stop();
    }
  });

  it("relays bytes sent in the same packet as CONNECT (the head) to the upstream, then tunnels both ways", async () => {
    const received: string[] = [];
    const echo = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        received.push(chunk.toString());
        socket.write(`echo:${chunk.toString()}`);
      });
    });
    const echoPort = await listen(echo);
    const proxy = await startEgressProxy({ allow: [`127.0.0.1:${echoPort}`], port: 0 });
    try {
      const response = await new Promise<string>((resolve) => {
        let buffered = "";
        const socket = net.connect(proxy.port, "127.0.0.1", () =>
          socket.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: x\r\n\r\nhello-head`),
        );
        socket.on("data", (chunk) => {
          buffered += chunk.toString();
          if (buffered.includes("echo:hello-head")) {
            socket.destroy();
            resolve(buffered);
          }
        });
        socket.on("error", () => resolve(buffered));
      });
      expect(response).toContain("HTTP/1.1 200 Connection Established");
      expect(response).toContain("echo:hello-head");
      expect(received.join("")).toBe("hello-head");
    } finally {
      proxy.stop();
      echo.close();
    }
  });

  it("denies a plain Upgrade request with its own fixed code", async () => {
    const lines: string[] = [];
    const proxy = await startEgressProxy({ allow: ["127.0.0.1:1"], port: 0, log: (line) => lines.push(line) });
    try {
      const raw = await rawExchange(
        proxy.port,
        "GET http://127.0.0.1:1/ws HTTP/1.1\r\nHost: 127.0.0.1:1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      expect(raw.split("\r\n")[0]).toContain("403");
      expect(lines).toEqual(["egress-denied plain-upgrade-unsupported"]);
    } finally {
      proxy.stop();
    }
  });

  it("destroys a client socket that errors or idles out, and stop() tears down open tunnels", async () => {
    const proxy = await startEgressProxy({ allow: ["127.0.0.1:1"], port: 0 });
    const accepted: net.Socket[] = [];
    proxy.server.on("connection", (socket: net.Socket) => accepted.push(socket));
    try {
      const client = net.connect(proxy.port, "127.0.0.1");
      await new Promise<void>((resolve) => client.once("connect", () => resolve()));
      await vi.waitFor(() => expect(accepted).toHaveLength(1));
      const serverSide = accepted[0];
      serverSide.emit("error", new Error("boom"));
      await vi.waitFor(() => expect(serverSide.destroyed).toBe(true));

      const idle = net.connect(proxy.port, "127.0.0.1");
      await new Promise<void>((resolve) => idle.once("connect", () => resolve()));
      await vi.waitFor(() => expect(accepted).toHaveLength(2));
      accepted[1].emit("timeout");
      await vi.waitFor(() => expect(accepted[1].destroyed).toBe(true));

      const open = net.connect(proxy.port, "127.0.0.1");
      await new Promise<void>((resolve) => open.once("connect", () => resolve()));
      await vi.waitFor(() => expect(accepted).toHaveLength(3));
      proxy.stop();
      await vi.waitFor(() => expect(accepted[2].destroyed).toBe(true));
      client.destroy();
      idle.destroy();
      open.destroy();
    } finally {
      proxy.stop();
    }
  });

  it("emits nothing outside the fixed vocabulary across every denial path", async () => {
    const lines: string[] = [];
    const small = createEgressProxy({ allow: [], log: (line) => lines.push(line) });
    const port = await listen(small.server);
    try {
      await get(port, "http://127.0.0.2:9/x");
      await rawExchange(port, "GET /x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      await rawExchange(port, "CONNECT a.example:443 HTTP/1.1\r\nHost: a\r\n\r\n");
      expect(parseEgressDenialLog(lines.join("\n")).unrecognized).toBe(0);
      expect(lines).toHaveLength(3);
    } finally {
      small.stop();
    }
  });

  it("startEgressProxy rejects when the port is already taken", async () => {
    const blocker = net.createServer();
    const port = await listen(blocker);
    try {
      await expect(startEgressProxy({ allow: [], port })).rejects.toThrow(/EADDRINUSE/);
    } finally {
      blocker.close();
    }
  });
});

describe("main (the trusted workflow CLI)", () => {
  function captureProcess() {
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    let sigterm: (() => void) | undefined;
    vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => void) => {
      if (event === "SIGTERM") sigterm = handler;
      return process;
    }) as typeof process.on);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    return { written, exit, sigterm: () => sigterm };
  }

  it("prints the allowlist banner, then the listening banner the workflow waits for, and stops on SIGTERM", async () => {
    const captured = captureProcess();
    await main({
      NEXT_PUBLIC_CONVEX_URL: CONVEX,
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: PK,
      BROWSER_EGRESS_CANDIDATE_ORIGIN: "http://localhost:3999",
      BROWSER_EGRESS_EXTRA_ALLOW: " api.example.com:8443 , ,",
      BROWSER_EGRESS_PROXY_PORT: "0",
    });
    const output = captured.written.join("");
    const lines = output.split("\n").filter(Boolean);
    expect(lines[0]).toBe(
      "egress-allowlist 127.0.0.1:3999 api.example.com:8443 example.clerk.accounts.dev:443 happy-animal-123.convex.cloud:443 localhost:3999",
    );
    expect(lines[1]).toMatch(/^egress-proxy-listening 127\.0\.0\.1:\d+$/);
    expect(parseEgressDenialLog(output)).toEqual({ denials: {}, unrecognized: 0 });

    const handler = captured.sigterm();
    expect(handler).toBeTypeOf("function");
    handler?.();
    expect(captured.exit).toHaveBeenCalledWith(0);
  });

  it("uses the default candidate origin when none is given", async () => {
    const captured = captureProcess();
    await main({ NEXT_PUBLIC_CONVEX_URL: CONVEX, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: PK, BROWSER_EGRESS_PROXY_PORT: "0" });
    expect(captured.written.join("")).toContain("egress-allowlist 127.0.0.1:3000 example.clerk.accounts.dev:443");
    captured.sigterm()?.();
  });

  it("rejects, starting nothing, when the environment cannot produce an allowlist", async () => {
    const captured = captureProcess();
    await expect(main({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: PK, BROWSER_EGRESS_PROXY_PORT: "0" })).rejects.toThrow(
      /NEXT_PUBLIC_CONVEX_URL/,
    );
    expect(captured.written).toEqual([]);
    expect(captured.sigterm()).toBeUndefined();
  });
});
