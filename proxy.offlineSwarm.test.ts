// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OFFLINE_SWARM_CLERK_FLAG,
  OFFLINE_SWARM_CLERK_PLACEHOLDER_SECRET,
} from "@/lib/offlineSwarmClerk";

type ClerkOptions =
  | { jwtKey?: string }
  | ((req: Request) => { jwtKey?: string });

const captured: { handler?: unknown; options?: ClerkOptions } = {};
const clerkInvocations: Request[] = [];

vi.mock("@clerk/nextjs/server", () => ({
  createRouteMatcher: () => () => true,
  clerkMiddleware: (handler: unknown, options?: ClerkOptions) => {
    captured.handler = handler;
    captured.options = options;
    return (req: Request) => {
      clerkInvocations.push(req);
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
];

function optionsFor(req: Request): { jwtKey?: string } | undefined {
  const options = captured.options;
  return typeof options === "function" ? options(req) : options;
}

async function loadProxy() {
  vi.resetModules();
  return (await import("./proxy")).default as unknown as (
    req: Request,
  ) => Promise<Response> | Response;
}

describe("proxy.ts offline swarm Clerk wiring", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    captured.handler = undefined;
    captured.options = undefined;
    clerkInvocations.length = 0;
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const req = new Request("http://127.0.0.1:3000/dashboard");

  it("keeps production middleware options unchanged when the flag is absent, even with CLERK_JWT_KEY set", async () => {
    process.env.CLERK_JWT_KEY = PEM;
    process.env.CLERK_SECRET_KEY = "sk_live_real";
    const proxy = await loadProxy();
    expect(optionsFor(req) ?? {}).toEqual({});
    expect(await proxy(req)).toHaveProperty("status", 200);
    expect(clerkInvocations).toHaveLength(1);
  });

  it("hands Clerk the public jwtKey only in fully valid offline swarm mode", async () => {
    process.env[OFFLINE_SWARM_CLERK_FLAG] = "1";
    process.env.CLERK_SECRET_KEY = OFFLINE_SWARM_CLERK_PLACEHOLDER_SECRET;
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_Zm9v";
    process.env.CLERK_JWT_KEY = PEM;
    const proxy = await loadProxy();
    expect(optionsFor(req)).toEqual({ jwtKey: PEM });
    expect(await proxy(req)).toHaveProperty("status", 200);
  });

  it("fails closed with 503 and never reaches Clerk when the flag is set but a condition fails", async () => {
    process.env[OFFLINE_SWARM_CLERK_FLAG] = "1";
    process.env.CLERK_SECRET_KEY = "sk_test_a_real_looking_key";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_live_Zm9v";
    process.env.CLERK_JWT_KEY = PEM;
    const proxy = await loadProxy();
    const response = await proxy(req);
    expect(response.status).toBe(503);
    expect(clerkInvocations).toHaveLength(0);
    const body = await response.text();
    expect(body).not.toContain(PEM);
    expect(body).not.toContain("sk_test_a_real_looking_key");
    expect(optionsFor(req) ?? {}).toEqual({});
  });
});
