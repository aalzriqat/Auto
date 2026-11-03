import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * Regression ratchet for SCRUM-324.
 *
 * The client talks to TWO Convex hosts: the reactive client on
 * `*.convex.cloud` (NEXT_PUBLIC_CONVEX_URL) and the httpAction router on
 * `*.convex.site` (NEXT_PUBLIC_CONVEX_SITE_URL, used by the /site-events
 * visitor beacon in lib/analytics/payload.ts). The CSP `connect-src` in
 * next.config.ts listed only the first, so every tracking POST was refused
 * by the browser in production — silently, because the beacon swallows
 * failures by design. This test reads the config source rather than
 * importing it: next.config.ts imports lib/env, which throws without the
 * real NEXT_PUBLIC_* variables.
 */
const configSource = readFileSync(resolve(__dirname, "..", "next.config.ts"), "utf8");

function directive(name: string): string[] {
  const match = configSource.match(new RegExp(`"${name}([^"]*)"`));
  if (!match) throw new Error(`CSP directive ${name} not found in next.config.ts`);
  return match[1].trim().split(/\s+/);
}

describe("Content-Security-Policy connect-src", () => {
  const connectSrc = directive("connect-src");

  it("allows the Convex reactive client host", () => {
    expect(connectSrc).toContain("https://*.convex.cloud");
    expect(connectSrc).toContain("wss://*.convex.cloud");
  });

  it("allows the Convex httpAction host used by the /site-events beacon (SCRUM-324)", () => {
    expect(connectSrc).toContain("https://*.convex.site");
  });
});

/**
 * SCRUM-892: the trusted browser swarm's frontend talks to a Convex backend on
 * the CI runner (http/ws 127.0.0.1:3210). The browser enforces connect-src, so
 * that exact origin must be allowed in the swarm build; and it must never be in
 * any other build, whose CSP stays exactly what it was.
 */
describe("Content-Security-Policy for the runner-local Convex backend (SCRUM-892)", () => {
  async function cspFor(swarmStandalone: boolean): Promise<Record<string, string[]>> {
    const previous = process.env.AUTOFLOW_SWARM_STANDALONE;
    if (swarmStandalone) process.env.AUTOFLOW_SWARM_STANDALONE = "1";
    else delete process.env.AUTOFLOW_SWARM_STANDALONE;
    try {
      vi.resetModules();
      vi.doMock("../lib/env", () => ({}));
      vi.doMock("@sentry/nextjs", () => ({ withSentryConfig: (config: unknown) => config }));
      const loaded = (await import("../next.config")) as {
        default: { headers: () => Promise<{ headers: { key: string; value: string }[] }[]> };
      };
      const rules = await loaded.default.headers();
      const value = rules[0]!.headers.find((header) => header.key === "Content-Security-Policy")!.value;
      return Object.fromEntries(
        value.split("; ").map((part) => {
          const [name, ...sources] = part.split(" ");
          return [name!, sources];
        }),
      );
    } finally {
      if (previous === undefined) delete process.env.AUTOFLOW_SWARM_STANDALONE;
      else process.env.AUTOFLOW_SWARM_STANDALONE = previous;
      vi.doUnmock("../lib/env");
      vi.doUnmock("@sentry/nextjs");
    }
  }

  it("allows exactly http and ws on 127.0.0.1:3210 for connect-src, and http for img-src, in the swarm build", async () => {
    const csp = await cspFor(true);
    expect(csp["connect-src"]).toContain("http://127.0.0.1:3210");
    expect(csp["connect-src"]).toContain("ws://127.0.0.1:3210");
    expect(csp["img-src"]).toContain("http://127.0.0.1:3210");
    // Nothing broader on loopback, and no other directive learns about it.
    for (const sources of Object.values(csp)) {
      const loopback = sources.filter((source) => /127\.0\.0\.1|localhost|\[::1\]|\*:/.test(source));
      expect(loopback.every((source) => source === "http://127.0.0.1:3210" || source === "ws://127.0.0.1:3210")).toBe(true);
    }
    expect(csp["script-src"]!.join(" ")).not.toContain("127.0.0.1");
    expect(csp["default-src"]).toEqual(["'self'"]);
  });

  it("leaves the CSP of every other build exactly as it was: no loopback source at all", async () => {
    const csp = await cspFor(false);
    expect(Object.values(csp).flat().filter((source) => /127\.0\.0\.1|localhost/.test(source))).toEqual([]);
    expect(csp["connect-src"]).toContain("https://*.convex.cloud");
    expect(csp["connect-src"]).toContain("wss://*.convex.cloud");
  });

  it("keeps the production directive literal free of the local origin", () => {
    expect(directive("connect-src").join(" ")).not.toContain("127.0.0.1");
  });
});
