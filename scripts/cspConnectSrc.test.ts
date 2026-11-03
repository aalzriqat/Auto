import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
// SCRUM-892: the policy is built in lib/security/contentSecurityPolicy.ts,
// which next.config.ts uses as its only Content-Security-Policy value.
const configSource = readFileSync(
  resolve(__dirname, "..", "lib", "security", "contentSecurityPolicy.ts"),
  "utf8",
);
const nextConfigSource = readFileSync(resolve(__dirname, "..", "next.config.ts"), "utf8");

function directive(name: string): string[] {
  const match = configSource.match(new RegExp(`"${name}([^"]*)"`));
  if (!match) throw new Error(`CSP directive ${name} not found in lib/security/contentSecurityPolicy.ts`);
  return match[1].trim().split(/\s+/);
}

describe("Content-Security-Policy connect-src", () => {
  it("next.config.ts takes its policy from the shared builder", () => {
    expect(nextConfigSource).toContain("value: contentSecurityPolicy,");
    expect(nextConfigSource).toContain("buildContentSecurityPolicy(process.env)");
  });

  const connectSrc = directive("connect-src");

  it("allows the Convex reactive client host", () => {
    expect(connectSrc).toContain("https://*.convex.cloud");
    expect(connectSrc).toContain("wss://*.convex.cloud");
  });

  it("allows the Convex httpAction host used by the /site-events beacon (SCRUM-324)", () => {
    expect(connectSrc).toContain("https://*.convex.site");
  });
});
