// @vitest-environment node
//
// Real-Chromium egress containment check (SCRUM-784).
//
// Opt-in: it needs an installed Playwright Chromium and a loopback that answers
// on 127.0.0.2, which the default unit-test runners do not guarantee, so it runs
// only with BROWSER_EGRESS_CHROMIUM_TESTS=1 (local verification). It is NOT the
// release gate: the same proof (browserEgressProof.mjs) is executed for real,
// against the real proxy process, by the "Prove browser egress containment"
// step of both candidate jobs in browser-attack-swarm.yml, and a failure there
// fails the job.
import http from "node:http";
import net from "node:net";
import { describe, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import {
  BROWSER_EGRESS_PROXY_ENV,
  buildEgressAllowlist,
  startEgressProxy,
} from "./browserEgressContainment.mjs";
import { runBrowserEgressProof } from "./browserEgressProof.mjs";

const PK = "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk"; // example.clerk.accounts.dev
const CONVEX = "https://happy-animal-123.convex.cloud";

async function listen(server: http.Server | net.Server, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return (server.address() as net.AddressInfo).port;
}

describe.runIf(process.env.BROWSER_EGRESS_CHROMIUM_TESTS === "1")(
  "real Chromium egress containment (SCRUM-784)",
  () => {
    it("control: without the egress proxy the same page DOES reach the collector", async () => {
      const hits: string[] = [];
      const collector = net.createServer((socket) => {
        hits.push("tcp");
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
      });
      const port = await listen(collector, "127.0.0.2");
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto("about:blank");
        await page.evaluate((p) => fetch(`http://127.0.0.2:${p}/x`, { mode: "no-cors" }).catch(() => null), port);
      } finally {
        await browser.close();
        collector.close();
      }
      expect(hits.length).toBeGreaterThan(0);
    }, 60_000);

    it("delivers nothing to a non-allowlisted collector over any channel, while the allowlisted origin works", async () => {
      const candidate = http.createServer((_req, res) => res.end("health-ok"));
      const candidatePort = await listen(candidate);
      const origin = `http://127.0.0.1:${candidatePort}`;
      const allow = buildEgressAllowlist({
        candidateOrigin: origin,
        convexUrl: CONVEX,
        clerkPublishableKey: PK,
      });
      const proxy = await startEgressProxy({ allow, port: 0 });
      try {
        const result = await runBrowserEgressProof({
          env: { [BROWSER_EGRESS_PROXY_ENV]: `http://127.0.0.1:${proxy.port}` },
          allowedOrigin: origin,
          allowedPath: "/api/health",
          readProxyLog: () => proxy.denied.join("\n"),
        });
        expect(result.failures).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.collector).toEqual({ tcpEvents: 0, udpPackets: 0 });
        expect(result.allowedStatus).toBe(200);
        // The attempts really happened and were refused by the proxy.
        expect(proxy.denied.length).toBeGreaterThan(0);
        // G4-01: the host is never logged; the probe is evidenced by reason code.
        expect(proxy.denied.join("\n")).not.toContain("127.0.0.2");
        expect(result.proxyDenials?.["not-allowlisted-loopback"]).toBeGreaterThan(0);
        expect(result.proxyDenials?.unrecognized).toBe(0);
        expect((result.channels as Record<string, string>)["service-worker"]).toBe("blocked");
        expect(JSON.stringify(proxy.denied)).not.toContain("SECRET");
      } finally {
        proxy.stop();
        candidate.close();
      }
    }, 120_000);
  },
);
