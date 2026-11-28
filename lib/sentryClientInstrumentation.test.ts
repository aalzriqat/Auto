/**
 * SCRUM-1033: the browser Sentry SDK was never initialised in production.
 *
 * Next.js 16 builds with Turbopack by default, and the installed
 * @sentry/nextjs (10.x) only loads the legacy `sentry.client.config.ts` through
 * its webpack integration ("When using Turbopack `sentry.client.config.ts` will
 * no longer work"). The documented client entry is `instrumentation-client.ts`
 * (https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client).
 *
 * Conservative default recorded in SCRUM-1033 until the owner decides otherwise:
 * error reporting only. No Session Replay (the app shows customer names, phones,
 * national IDs and money), no default PII, no tracing.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const CLIENT_FILE = path.join(ROOT, "instrumentation-client.ts");

/** Source with comments removed, so prose about replay cannot trip the checks. */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("client Sentry entry point: structure", () => {
  it("exists at the repo root where Next.js loads it", () => {
    expect(existsSync(CLIENT_FILE)).toBe(true);
  });

  it("initialises exactly once, from the public DSN, and exports the router-transition hook", () => {
    const code = codeOf(CLIENT_FILE);
    expect(code.match(/Sentry\.init\(/g)).toHaveLength(1);
    expect(code).toContain("process.env.NEXT_PUBLIC_SENTRY_DSN");
    expect(code).toMatch(
      /export\s+const\s+onRouterTransitionStart\s*=\s*Sentry\.captureRouterTransitionStart/,
    );
  });

  it("records no sessions and collects no default PII or traces", () => {
    const code = codeOf(CLIENT_FILE);
    expect(code).not.toMatch(/replay/i);
    expect(code).not.toMatch(/sendDefaultPii\s*:\s*true/);
    expect(code).not.toMatch(/tracesSampleRate|tracesSampler|browserTracingIntegration/);
  });

  it("leaves no second client init file behind", () => {
    const clientInitFiles = [ROOT, path.join(ROOT, "src")]
      .filter((dir) => existsSync(dir))
      .flatMap((dir) => readdirSync(dir).map((name) => path.relative(ROOT, path.join(dir, name))))
      .filter((file) => /^(src[\\/])?(sentry\.client\.config|instrumentation-client)\.[cm]?[jt]sx?$/.test(file));
    expect(clientInitFiles).toEqual(["instrumentation-client.ts"]);
  });
});

describe("client Sentry entry point: behaviour", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("@sentry/nextjs");
  });

  async function load(dsn: string | undefined) {
    vi.resetModules();
    const init = vi.fn();
    const captureRouterTransitionStart = vi.fn();
    vi.doMock("@sentry/nextjs", () => ({ init, captureRouterTransitionStart }));
    if (dsn === undefined) vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", "");
    else vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", dsn);
    // Literal method names: the pilot-config census (test-utils/pilotConfigParity)
    // treats a spy whose target it cannot read as a possible pilot door.
    const consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
    ];
    // Variable specifier: a missing file then fails this test, not the whole suite.
    const mod = (await import(/* @vite-ignore */ CLIENT_FILE.replace(/\\/g, "/"))) as {
      onRouterTransitionStart: unknown;
    };
    return { mod, init, captureRouterTransitionStart, consoleSpies };
  }

  it("is a silent no-op when no DSN was baked into the build", async () => {
    const { init, consoleSpies } = await load(undefined);
    expect(init).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("initialises once with the DSN and an error-only configuration", async () => {
    const { mod, init, captureRouterTransitionStart } = await load("https://key@o1.ingest.example.invalid/1");
    expect(init).toHaveBeenCalledTimes(1);
    const options = init.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.dsn).toBe("https://key@o1.ingest.example.invalid/1");
    expect(options.sendDefaultPii).not.toBe(true);
    expect(options.integrations).toBeUndefined();
    expect(options.replaysSessionSampleRate).toBeUndefined();
    expect(options.replaysOnErrorSampleRate).toBeUndefined();
    expect(options.tracesSampleRate).toBeUndefined();
    expect(mod.onRouterTransitionStart).toBe(captureRouterTransitionStart);
  });

  it("registers URL scrubbing so no query string or fragment is sent", async () => {
    const { init } = await load("https://key@o1.ingest.example.invalid/1");
    const options = init.mock.calls[0]?.[0] as {
      beforeSend?: (event: unknown) => { request?: { url?: string; query_string?: string } };
      beforeBreadcrumb?: (crumb: unknown) => { data?: Record<string, string> };
    };
    expect(typeof options.beforeSend).toBe("function");
    expect(typeof options.beforeBreadcrumb).toBe("function");

    const event = options.beforeSend?.({
      request: { url: "https://app.example.com/setup-account?ticket=SECRET", query_string: "ticket=SECRET" },
    });
    expect(JSON.stringify(event)).not.toContain("SECRET");
    expect(event?.request?.url).toBe("https://app.example.com/setup-account");

    const crumb = options.beforeBreadcrumb?.({
      category: "navigation",
      data: { from: "/setup-account?ticket=SECRET", to: "/" },
    });
    expect(JSON.stringify(crumb)).not.toContain("SECRET");
  });
});
