// @vitest-environment node
//
// SCRUM-350 G4: proxy.ts wraps Clerk's middleware so the offline-swarm mode can
// fail closed. This file lives under scripts/ so the Sonar coverage run (which
// executes only convex/ and scripts/) measures proxy.ts: it drives the
// wrapped Clerk handler itself - dealer-site rewrite, analytics script, public
// versus protected routes - and the refusal path, with Clerk mocked.
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OFFLINE_SWARM_CLERK_FLAG,
  OFFLINE_SWARM_CLERK_PLACEHOLDER_SECRET,
} from "@/lib/offlineSwarmClerk";

type Handler = (auth: { protect: () => Promise<void> }, req: NextRequest) => Promise<Response | undefined>;
type Options = (req: Request) => { jwtKey?: string };

const captured: { handler?: Handler; options?: Options } = {};
const delegated: Request[] = [];

vi.mock("@clerk/nextjs/server", () => ({
  // A path list stands in for Clerk's route matcher: "/x(.*)" is a prefix.
  createRouteMatcher: (patterns: string[]) => (req: { nextUrl: { pathname: string } }) =>
    patterns.some((pattern) =>
      pattern.endsWith("(.*)") ? req.nextUrl.pathname.startsWith(pattern.slice(0, -4)) : req.nextUrl.pathname === pattern,
    ),
  clerkMiddleware: (handler: Handler, options: Options) => {
    captured.handler = handler;
    captured.options = options;
    return (req: Request) => {
      delegated.push(req);
      return new Response("clerk-ran", { status: 200 });
    };
  },
}));

const PEM = "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----";
const ENV_KEYS = [
  OFFLINE_SWARM_CLERK_FLAG,
  "CLERK_SECRET_KEY",
  "CLERK_JWT_KEY",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_APP_URL",
];

async function loadProxy() {
  vi.resetModules();
  const mod = await import("../../proxy");
  return mod.default as unknown as (req: NextRequest, event: unknown) => Promise<Response> | Response;
}

function request(url: string, host?: string): NextRequest {
  return new NextRequest(url, { headers: host ? { host } : {} });
}

describe("proxy.ts wrapped Clerk handler", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    captured.handler = undefined;
    captured.options = undefined;
    delegated.length = 0;
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.restoreAllMocks();
  });

  async function handle(req: NextRequest) {
    await loadProxy();
    const auth = { protect: vi.fn(async () => {}) };
    const result = await captured.handler!(auth, req);
    return { result, auth };
  }

  it("lets a public route through without protecting it", async () => {
    const { result, auth } = await handle(request("http://localhost:3000/marketplace/cars", "localhost:3000"));
    expect(result).toBeUndefined();
    expect(auth.protect).not.toHaveBeenCalled();
  });

  // SCRUM-842: Meta's data-deletion callback returns this page's URL to the end
  // user, who has no AutoFlow session; behind auth.protect() they would be sent to sign-in.
  it("lets the Meta data-deletion status page through without protecting it", async () => {
    const { result, auth } = await handle(
      request("http://localhost:3000/data-deletion-status?id=0123456789abcdef0123456789abcdef", "localhost:3000"),
    );
    expect(result).toBeUndefined();
    expect(auth.protect).not.toHaveBeenCalled();
  });

  // SCRUM-842 (LOW follow-up from review): the public entry is the exact page, not a
  // prefix. Widening it to `/data-deletion-status(.*)` would publish whatever is later
  // added beside it, so adjacent paths must stay behind auth.protect().
  it.each([
    "/data-deletion-status-admin",
    "/data-deletion-statusx",
    "/data-deletion-status/admin",
    "/data-deletion-status/export?id=0123456789abcdef0123456789abcdef",
  ])("keeps %s, a path beside the Meta data-deletion status page, protected", async (path) => {
    const { result, auth } = await handle(request(`http://localhost:3000${path}`, "localhost:3000"));
    expect(result).toBeUndefined();
    expect(auth.protect).toHaveBeenCalledTimes(1);
  });

  it("protects every non-public route", async () => {
    const { result, auth } = await handle(request("http://localhost:3000/dashboard", "localhost:3000"));
    expect(result).toBeUndefined();
    expect(auth.protect).toHaveBeenCalledTimes(1);
  });

  it("passes the Vercel analytics script through without protecting it", async () => {
    const { result, auth } = await handle(request("http://localhost:3000/0123456789abcdef/script.js", "localhost:3000"));
    expect(result?.headers.get("x-middleware-next")).toBe("1");
    expect(auth.protect).not.toHaveBeenCalled();
  });

  it("rewrites a dealer-site host onto /dealer-site and carries the host as a query parameter", async () => {
    const { result, auth } = await handle(request("https://cars.dealer-example.com/inventory", "cars.dealer-example.com"));
    const rewrite = result?.headers.get("x-middleware-rewrite") ?? "";
    expect(new URL(rewrite).pathname).toBe("/dealer-site/inventory");
    expect(new URL(rewrite).searchParams.get("host")).toBe("cars.dealer-example.com");
    expect(auth.protect).not.toHaveBeenCalled();
  });

  it("maps the dealer-site root to /dealer-site", async () => {
    const { result } = await handle(request("https://cars.dealer-example.com/", "cars.dealer-example.com"));
    expect(new URL(result?.headers.get("x-middleware-rewrite") ?? "").pathname).toBe("/dealer-site");
  });

  it("serves the manifest and an empty analytics script for dealer-site hosts", async () => {
    const manifest = await handle(request("https://cars.dealer-example.com/manifest.webmanifest", "cars.dealer-example.com"));
    expect(manifest.result?.status).toBe(200);
    const analytics = await handle(request("https://cars.dealer-example.com/0123456789abcdef/script.js", "cars.dealer-example.com"));
    expect(analytics.result?.status).toBe(200);
    expect(await analytics.result?.text()).toBe("");
  });

  it("gives Clerk empty options (identical to passing none) outside offline swarm mode", async () => {
    await loadProxy();
    expect(captured.options!(new Request("http://localhost:3000/"))).toEqual({});
  });

  it("answers 503 with no-store and logs the reasons, never the key, when offline swarm mode is refused", async () => {
    process.env[OFFLINE_SWARM_CLERK_FLAG] = "1";
    process.env.CLERK_SECRET_KEY = "sk_test_a_real_looking_key";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_Zm9v";
    process.env.CLERK_JWT_KEY = PEM;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const proxy = await loadProxy();
    const response = await proxy(request("http://localhost:3000/dashboard", "localhost:3000"), {});
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(delegated).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("Offline swarm Clerk mode refused");
    expect(String(error.mock.calls[0][0])).not.toContain(PEM);
    expect(String(error.mock.calls[0][0])).not.toContain("sk_test_a_real_looking_key");
  });

  it("delegates to Clerk when the flag is absent or the offline mode is fully valid", async () => {
    const proxy = await loadProxy();
    expect((await proxy(request("http://localhost:3000/dashboard", "localhost:3000"), {})).status).toBe(200);
    process.env[OFFLINE_SWARM_CLERK_FLAG] = "1";
    process.env.CLERK_SECRET_KEY = OFFLINE_SWARM_CLERK_PLACEHOLDER_SECRET;
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_Zm9v";
    process.env.CLERK_JWT_KEY = PEM;
    expect((await proxy(request("http://localhost:3000/dashboard", "localhost:3000"), {})).status).toBe(200);
    expect(delegated).toHaveLength(2);
  });
});
