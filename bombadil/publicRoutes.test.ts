import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NON_PAGE_PUBLIC_ROUTES,
  PUBLIC_PAGE_ROUTES,
  isPublicPagePath,
  isSameOrigin,
} from "./publicRoutes";

function proxyPublicRoutes(): string[] {
  const source = readFileSync(path.resolve(process.cwd(), "proxy.ts"), "utf8");
  const block =
    /const isPublicRoute = createRouteMatcher\(\[([\s\S]*?)\]\);/.exec(source);
  if (!block?.[1])
    throw new Error("proxy.ts: createRouteMatcher list not found");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("Bombadil public route list", () => {
  it("equals the page routes of proxy.ts, with the non-page entries named", () => {
    const proxy = proxyPublicRoutes();
    expect(proxy.length).toBeGreaterThan(0);
    const pages = proxy.filter(
      (route) => !NON_PAGE_PUBLIC_ROUTES.includes(route),
    );
    expect(pages).toEqual([...PUBLIC_PAGE_ROUTES]);
    // Every excluded name must really be in proxy.ts, or the exclusion is stale.
    for (const route of NON_PAGE_PUBLIC_ROUTES) expect(proxy).toContain(route);
  });

  it("matches public pages and refuses protected ones", () => {
    for (const ok of [
      "/",
      "/sign-in",
      "/sign-in/factor-one",
      "/marketplace/cars",
      "/privacy",
      "/contact",
    ]) {
      expect(isPublicPagePath(ok), ok).toBe(true);
    }
    for (const no of [
      "/deals",
      "/accounting",
      "/privacy/x",
      "/contactus",
      "/dashboard",
    ]) {
      expect(isPublicPagePath(no), no).toBe(false);
    }
  });
});
describe("isSameOrigin", () => {
  const origin = "http://127.0.0.1:3000";
  it("accepts the same scheme, host and port", () => {
    expect(isSameOrigin("http://127.0.0.1:3000/terms?x=1#y", origin)).toBe(
      true,
    );
    expect(isSameOrigin("HTTP://127.0.0.1:3000", origin)).toBe(true);
    expect(
      isSameOrigin("https://example.org:443/a", "https://example.org"),
    ).toBe(true);
  });
  it("rejects a port, host or scheme that only shares a string prefix", () => {
    expect(isSameOrigin("http://127.0.0.1:30001/x", origin)).toBe(false);
    expect(isSameOrigin("http://127.0.0.1:3000.evil.test/x", origin)).toBe(
      false,
    );
    expect(isSameOrigin("http://127.0.0.1:3000@evil.test/x", origin)).toBe(
      false,
    );
    expect(isSameOrigin("https://127.0.0.1:3000/x", origin)).toBe(false);
    expect(isSameOrigin("mailto:a@b.c", origin)).toBe(false);
  });
});
