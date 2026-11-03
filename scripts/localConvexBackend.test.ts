/**
 * SCRUM-892 — the local Convex backend helper, tested against what it is for:
 * it must never reach a cloud deployment, never print a secret, and never
 * report a backend as ready that is not.
 *
 * Nothing here starts Docker or the Convex CLI: both go through the `exec`
 * seam, so every test runs the real control flow against a recording fake.
 */
import { describe, expect, test, vi } from "vitest";
import {
  ADMIN_KEY_PATTERN,
  COMPONENTS_QUERY,
  COMPONENT_MODULES_QUERY,
  CONTAINER_ENV_VAR,
  ENV_ALLOWLIST,
  FINGERPRINT_ENV_VAR,
  LOCAL_CONVEX_IMAGE,
  LOCAL_CONVEX_URL,
  LocalConvexRefusal,
  TURNSTILE_TEST_SECRET,
  appendGithubEnv,
  assertAdminKey,
  assertContainerName,
  assertEnvMatchesAllowlist,
  assertEnvMatchesPlan,
  codeFingerprint,
  compareCodeUnits,
  assertLocalOnly,
  boundedDiagnostic,
  buildDockerRunArgs,
  buildEnvPlan,
  containerNameFor,
  deployBackend,
  generateInstanceSecret,
  main,
  markBackend,
  parseAdminKey,
  parseEnvNames,
  setBackendEnv,
  stableStringify,
  startBackend,
  stopBackend,
  verifyBackend,
  waitForBackend,
} from "./localConvexBackend.mjs";

/**
 * Fixtures are ASSEMBLED, not written out: a long hex-looking literal on a line
 * naming a key trips gitleaks' generic-api-key rule (see e2ePreviewBootstrap.test.ts).
 */
const ADMIN_KEY = `autoflow-ci|${"a1".repeat(24)}`;
const PUBLISHABLE_KEY = `pk_test_${Buffer.from("unit-test-instance.clerk.accounts.dev$").toString("base64url")}`;
const LIVE_PUBLISHABLE_KEY = `pk_live_${Buffer.from("clerk.example.com$").toString("base64url")}`;
const ISSUER = "https://unit-test-instance.clerk.accounts.dev";
const CONTAINER = "autoflow-local-convex-123-1-deadbeef";

type ExecResult = { status: number | null; stdout: string; stderr: string; error?: Error };
type ExecCall = { command: string; args: string[]; env: Record<string, string | undefined>; capture: boolean };

const ok = (stdout = ""): ExecResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "", status = 1): ExecResult => ({ status, stdout: "", stderr });

/** A recording fake. `respond` sees every call and may override the default success. */
function harness(respond: (call: ExecCall) => ExecResult | undefined = () => undefined) {
  const calls: ExecCall[] = [];
  const logs: string[] = [];
  const appended: string[] = [];
  let clock = 0;
  const deps = {
    exec: vi.fn((command: string, args: string[], options: { env: Record<string, string | undefined>; capture: boolean }) => {
      const call = { command, args, env: options.env, capture: options.capture };
      calls.push(call);
      const custom = respond(call);
      if (custom) return custom;
      if (command === "docker") {
        if (args[0] === "inspect" && args.includes("{{.State.Running}}")) return ok("true\n");
        if (args[0] === "exec") return ok(`${ADMIN_KEY}\n`);
        return ok();
      }
      if (args.includes("list") && args.includes("--names-only")) return ok(`${[...ENV_ALLOWLIST].join("\n")}\n`);
      if (args.includes("list")) return ok(`${PLAN_LINES.join("\n")}\n`);
      return ok();
    }),
    fetchImpl: vi.fn(answering(deployedState())),
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
    now: () => clock,
    randomBytesImpl: (size: number) => Buffer.alloc(size, 0xab),
    log: (message: string) => {
      logs.push(message);
    },
    append: ((_file: string, data: string) => {
      appended.push(data);
    }) as never,
    convexCli: "/repo/node_modules/convex/bin/main.js",
    cliVersion: () => "1.42.1",
  };
  return { deps, calls, logs, appended };
}

/**
 * What `/api/get_config_hashes` answers at the pinned backend: exactly
 * `config`, `moduleHashes`, `udfServerVersion` and `nodeVersion`
 * (crates/local_backend/src/deploy_config.rs:76-81). `hash` varies the code.
 */
function configHashes(hash = "h1") {
  return {
    config: { functions: "convex/", authInfo: [] },
    moduleHashes: [
      { path: "b.js", hash: "hb", environment: "isolate" },
      { path: "a.js", hash, environment: "node" },
    ],
    udfServerVersion: "1.42.1",
    nodeVersion: "22",
  };
}

/**
 * The three admin reads the fingerprint covers, shaped as the pinned system
 * queries return them: `_system/frontend/components:list` and
 * `_system/frontend/modules:listForAllComponents`. `componentPackage` is the
 * source package of the mounted component's module, which the backend renews
 * whenever that module's contents change.
 */
function deployedState({ rootHash = "h1", componentPackage = "pkg-c1" } = {}) {
  return {
    configHashes: configHashes(rootHash),
    components: [
      { id: "root", name: null, path: "", args: {}, state: "active", httpPrefix: null },
      { id: "cmp-rl", name: "rateLimiter", path: "rateLimiter", args: {}, state: "active", httpPrefix: null },
    ],
    componentModules: [
      [null, [["a.js", { functions: [{ name: "f", udfType: "Query", visibility: { kind: "public" } }], sourcePackageId: "pkg-r1" }]]],
      ["cmp-rl", [["lib.js", { functions: [{ name: "limit", udfType: "Mutation", visibility: { kind: "public" } }], sourcePackageId: componentPackage }]]],
    ],
  };
}
type DeployedState = ReturnType<typeof deployedState>;

/** A fetch fake that answers the health probe and the three admin reads from `state`. */
function answering(state: DeployedState) {
  return async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith("/api/get_config_hashes")) {
      return { ok: true, status: 200, json: async () => state.configHashes } as unknown as Response;
    }
    if (href.endsWith("/api/query")) {
      const { path } = JSON.parse(String(init?.body)) as { path: string };
      const value = path === COMPONENTS_QUERY ? state.components : path === COMPONENT_MODULES_QUERY ? state.componentModules : undefined;
      const body = value === undefined ? { status: "error", errorMessage: "no such function" } : { status: "success", value };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }
    return { ok: true } as Response;
  };
}

const CI_ENV = {
  GITHUB_ACTIONS: "true",
  GITHUB_ENV: "/tmp/github_env",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
};

const PLAN_LINES = [
  "AUTOFLOW_DEPLOYMENT_CLASS=preview",
  `CLERK_DEV_JWT_ISSUER_DOMAIN=${ISSUER}`,
  `CLERK_JWT_ISSUER_DOMAIN=${ISSUER}`,
  "NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000",
  `TURNSTILE_SECRET_KEY=${TURNSTILE_TEST_SECRET}`,
];

const READY_ENV = {
  CONVEX_SELF_HOSTED_URL: LOCAL_CONVEX_URL,
  CONVEX_SELF_HOSTED_ADMIN_KEY: ADMIN_KEY,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
  NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
};

describe("pinned facts", () => {
  test("the image is pinned by tag AND digest, and the only target is the loopback API port", () => {
    expect(LOCAL_CONVEX_IMAGE).toMatch(/^ghcr\.io\/convex\/convex-backend:[0-9a-f]{40}@sha256:[0-9a-f]{64}$/);
    expect(LOCAL_CONVEX_URL).toBe("http://127.0.0.1:3210");
  });

  test("the env plan sets exactly the allowlist, with the Turnstile TEST secret", () => {
    const plan = buildEnvPlan({ publishableKey: PUBLISHABLE_KEY, appUrl: "http://127.0.0.1:3000" });
    expect(plan.map(([name]) => name).sort()).toEqual([...ENV_ALLOWLIST].sort());
    const values = Object.fromEntries(plan);
    expect(values.CLERK_JWT_ISSUER_DOMAIN).toBe(ISSUER);
    expect(values.CLERK_DEV_JWT_ISSUER_DOMAIN).toBe(ISSUER);
    expect(values.AUTOFLOW_DEPLOYMENT_CLASS).toBe("preview");
    expect(values.TURNSTILE_SECRET_KEY).toBe(TURNSTILE_TEST_SECRET);
    expect(values.NEXT_PUBLIC_APP_URL).toBe("http://127.0.0.1:3000");
    for (const [, value] of plan) expect(value.startsWith("-")).toBe(false);
  });
});

describe("assertLocalOnly", () => {
  test.each(["CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT", "CONVEX_PREVIEW_DEPLOY_KEY"])("refuses while %s is present", (name) => {
    expect(() => assertLocalOnly({ [name]: "x" })).toThrow(LocalConvexRefusal);
  });

  test("ignores a blank cloud variable but never a populated one", () => {
    expect(() => assertLocalOnly({ CONVEX_DEPLOY_KEY: "  " })).not.toThrow();
  });

  test.each(["http://127.0.0.1:3210/", "http://localhost:3210", "http://127.0.0.1:3211", "https://x.convex.cloud", "http://0.0.0.0:3210"])(
    "refuses the URL %s (exact equality only)",
    (url) => {
      expect(() => assertLocalOnly({ CONVEX_SELF_HOSTED_URL: url })).toThrow(/exactly/);
    },
  );

  test("accepts the exact local URL and an unset one", () => {
    expect(() => assertLocalOnly({ CONVEX_SELF_HOSTED_URL: LOCAL_CONVEX_URL })).not.toThrow();
    expect(() => assertLocalOnly({})).not.toThrow();
  });
});

describe("admin key handling", () => {
  test("parses the last non-empty line and validates its shape", () => {
    expect(parseAdminKey(`\n${ADMIN_KEY}\n\n`)).toBe(ADMIN_KEY);
    expect(ADMIN_KEY_PATTERN.test(ADMIN_KEY)).toBe(true);
  });

  test("refuses output that is not a key and never reproduces it", () => {
    let message = "";
    try {
      parseAdminKey("error: something with spaces and secrets-in-it");
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/expected shape/);
    expect(message).not.toContain("secrets-in-it");
    expect(() => parseAdminKey("")).toThrow(LocalConvexRefusal);
  });

  test("assertAdminKey refuses a missing or malformed key", () => {
    expect(assertAdminKey(ADMIN_KEY)).toBe(ADMIN_KEY);
    expect(() => assertAdminKey(undefined)).toThrow(/start/);
    expect(() => assertAdminKey("no-pipe-here")).toThrow(LocalConvexRefusal);
  });

  test("the instance secret is 32 random bytes as hex", () => {
    expect(generateInstanceSecret((size) => Buffer.alloc(size, 0x0f))).toBe("0f".repeat(32));
  });
});

describe("container naming and docker argv", () => {
  test("names are unique per random part and sanitised", () => {
    const a = containerNameFor({ GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "2" }, "aaaa1111");
    const b = containerNameFor({ GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "2" }, "bbbb2222");
    expect(a).not.toBe(b);
    expect(a).toBe("autoflow-local-convex-42-2-aaaa1111");
    expect(containerNameFor({ GITHUB_RUN_ID: "4 2;rm -rf /" }, "ab")).toMatch(/^autoflow-local-convex-42rmrf-0-ab$/);
    expect(containerNameFor({}, "ab")).toBe("autoflow-local-convex-local-0-ab");
  });

  test("only names this script creates are accepted for removal", () => {
    expect(assertContainerName(CONTAINER)).toBe(CONTAINER);
    for (const bad of ["postgres", "autoflow-local-convex-", "autoflow-local-convex-a b", "autoflow-local-convex-a;rm", "", undefined]) {
      expect(() => assertContainerName(bad as string)).toThrow(LocalConvexRefusal);
    }
  });

  test("binds loopback only, keeps the secret out of argv and adds no privileges", () => {
    const args = buildDockerRunArgs({ containerName: CONTAINER });
    const joined = args.join(" ");
    expect(args).toContain("127.0.0.1:3210:3210");
    expect(args).toContain("127.0.0.1:3211:3211");
    expect(joined).not.toContain("0.0.0.0");
    expect(joined).not.toMatch(/--network|--privileged|--cap-add|--volume|-v /);
    // Round 5: candidate Node actions run in this container as root.
    expect(joined).toContain("--cap-drop ALL");
    expect(joined).toMatch(/--pids-limit \d+/);
    expect(joined).toContain("--security-opt no-new-privileges");
    expect(args.filter((arg) => arg === "--publish")).toHaveLength(2);
    // Value-less: docker reads it from its own environment.
    expect(args).toContain("INSTANCE_SECRET");
    expect(args.some((arg) => arg.startsWith("INSTANCE_SECRET="))).toBe(false);
    expect(args).toContain("INSTANCE_NAME=autoflow-ci");
    expect(args).toContain("CONVEX_CLOUD_ORIGIN=http://127.0.0.1:3210");
    expect(args).toContain("CONVEX_SITE_ORIGIN=http://127.0.0.1:3211");
    expect(args).toContain("DISABLE_BEACON=1");
    expect(args.at(-1)).toBe(LOCAL_CONVEX_IMAGE);
  });

  test("refuses to build a run command for a foreign container name", () => {
    expect(() => buildDockerRunArgs({ containerName: "evil" })).toThrow(LocalConvexRefusal);
  });
});

describe("buildEnvPlan refusals", () => {
  test("refuses a live Clerk publishable key", () => {
    expect(() => buildEnvPlan({ publishableKey: LIVE_PUBLISHABLE_KEY, appUrl: "http://127.0.0.1:3000" })).toThrow(/pk_test/);
  });

  test("refuses a missing publishable key", () => {
    expect(() => buildEnvPlan({ publishableKey: undefined, appUrl: "http://127.0.0.1:3000" })).toThrow(LocalConvexRefusal);
  });

  test.each([undefined, "", "not a url", "ftp://x", "http://user:pw@127.0.0.1:3000"])("refuses the app URL %s", (appUrl) => {
    expect(() => buildEnvPlan({ publishableKey: PUBLISHABLE_KEY, appUrl })).toThrow(LocalConvexRefusal);
  });
});

describe("environment allowlist comparison", () => {
  test("parses names and refuses anything that is not a variable name", () => {
    expect(parseEnvNames("B\nA\n\n")).toEqual(["A", "B"]);
    expect(() => parseEnvNames("lowercase_value")).toThrow(/unexpected/);
    expect(() => parseEnvNames("A=1")).toThrow(/unexpected/);
  });

  test("orders by UTF-16 code unit, never by locale", () => {
    // A locale order puts "a" before "B" and "_" before letters; code units do not.
    expect(["a", "B"].sort(compareCodeUnits)).toEqual(["B", "a"]);
    expect(["a", "B"].sort((x, y) => x.localeCompare(y, "en"))).toEqual(["a", "B"]);
    expect(parseEnvNames("A_B\nAB\nA1")).toEqual(["A1", "AB", "A_B"]);
    expect(compareCodeUnits("A", "A")).toBe(0);
  });

  test("passes only on exact equality", () => {
    expect(() => assertEnvMatchesAllowlist([...ENV_ALLOWLIST].reverse())).not.toThrow();
    expect(() => assertEnvMatchesAllowlist(ENV_ALLOWLIST.slice(1))).toThrow(/Missing: \[AUTOFLOW_DEPLOYMENT_CLASS\]/);
    expect(() => assertEnvMatchesAllowlist([...ENV_ALLOWLIST, "RESEND_API_KEY"])).toThrow(/Unexpected: \[RESEND_API_KEY\]/);
    expect(() => assertEnvMatchesAllowlist([])).toThrow(LocalConvexRefusal);
  });
});

describe("boundedDiagnostic and appendGithubEnv", () => {
  test("redacts secrets, strips control characters and keeps only the tail", () => {
    const text = boundedDiagnostic(`start SECRETVALUE end\u0007\u001b[31m`, ["SECRETVALUE"]);
    expect(text).not.toContain("SECRETVALUE");
    expect(text).toContain("***");
    expect(text).not.toMatch(/[\u0007\u001b]/);
    const long = boundedDiagnostic("x".repeat(10_000), [], 100);
    expect(long.length).toBeLessThanOrEqual(101);
    expect(boundedDiagnostic(null)).toBe("");
  });

  test("writes NAME=value lines and refuses anything that could inject one", () => {
    const append = vi.fn();
    expect(appendGithubEnv("/f", [["A_B", "1"], ["C", "2"]], append)).toBe(true);
    expect(append).toHaveBeenCalledWith("/f", "A_B=1\nC=2\n", "utf8");
    expect(() => appendGithubEnv("/f", [["lower", "1"]], append)).toThrow(LocalConvexRefusal);
    expect(() => appendGithubEnv("/f", [["A", "1\nEVIL=1"]], append)).toThrow(LocalConvexRefusal);
    expect(appendGithubEnv(undefined, [["A", "1"]], append)).toBe(false);
  });
});

describe("waitForBackend", () => {
  test("returns once /version answers, polling the loopback URL only", async () => {
    const h = harness();
    let attempts = 0;
    h.deps.fetchImpl = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("ECONNREFUSED");
      return { ok: true } as Response;
    });
    const result = await waitForBackend({ deps: h.deps, isRunning: () => true });
    expect(result).toEqual({ ok: true });
    expect(h.deps.fetchImpl).toHaveBeenCalledTimes(3);
    const firstCall = (vi.mocked(h.deps.fetchImpl).mock.calls as unknown[][])[0];
    expect(firstCall?.[0]).toBe(`${LOCAL_CONVEX_URL}/version`);
  });

  test("fails closed at the deadline", async () => {
    const h = harness();
    h.deps.fetchImpl = vi.fn(async () => ({ ok: false }) as Response);
    const result = await waitForBackend({ deps: h.deps, isRunning: () => true, timeoutMs: 10_000, intervalMs: 2_000 });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/within 10s/);
  });

  test("fails at once when the container has exited", async () => {
    const h = harness();
    const result = await waitForBackend({ deps: h.deps, isRunning: () => false });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/stopped/);
    expect(h.deps.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("startBackend", () => {
  test("masks the secret before docker sees it, then the key, and exports the job environment", async () => {
    const h = harness();
    await startBackend(CI_ENV, h.deps);

    const secretHex = "ab".repeat(32);
    const maskLines = h.logs.filter((line) => line.startsWith("::add-mask::"));
    expect(maskLines).toEqual([`::add-mask::${secretHex}`, `::add-mask::${ADMIN_KEY}`]);

    // The first logged line is the secret's mask, and it precedes the first docker call.
    expect(h.logs[0]).toBe(`::add-mask::${secretHex}`);
    const runCall = h.calls.find((call) => call.args[0] === "run")!;
    expect(runCall.env.INSTANCE_SECRET).toBe(secretHex);
    expect(runCall.args.join(" ")).not.toContain(secretHex);
    expect(h.calls.findIndex((call) => call.args[0] === "run")).toBeGreaterThan(-1);
    // The key mask comes before the success line and after the exec that produced it.
    expect(h.logs.indexOf(`::add-mask::${ADMIN_KEY}`)).toBeLessThan(h.logs.findIndex((line) => line.includes("is healthy")));

    // The container name is recorded BEFORE `docker run`, then the URL and key.
    expect(h.appended).toHaveLength(2);
    expect(h.appended[0]).toBe(`${CONTAINER_ENV_VAR}=autoflow-local-convex-123-1-abababab\n`);
    expect(h.appended[1]).toBe(
      `CONVEX_SELF_HOSTED_URL=${LOCAL_CONVEX_URL}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${ADMIN_KEY}\nNEXT_PUBLIC_CONVEX_URL=${LOCAL_CONVEX_URL}\n`,
    );
    const everything = h.appended.join("");
    expect(everything).not.toContain(secretHex);
    expect(everything).not.toContain("CONVEX_PREVIEW_URL");
  });

  test("the secret and the key are never printed outside an add-mask line", async () => {
    const h = harness();
    await startBackend(CI_ENV, h.deps);
    for (const line of h.logs.filter((entry) => !entry.startsWith("::add-mask::"))) {
      expect(line).not.toContain("ab".repeat(32));
      expect(line).not.toContain(ADMIN_KEY);
    }
  });

  test("outside CI nothing is masked, because masking would print the value", async () => {
    const h = harness();
    await startBackend({ GITHUB_RUN_ID: "1" }, h.deps);
    expect(h.logs.some((line) => line.startsWith("::add-mask::"))).toBe(false);
  });

  test("refuses before any docker call while a cloud credential is present", async () => {
    const h = harness();
    await expect(startBackend({ ...CI_ENV, CONVEX_DEPLOY_KEY: "prod:x|y" }, h.deps)).rejects.toThrow(/CONVEX_DEPLOY_KEY/);
    expect(h.deps.exec).not.toHaveBeenCalled();
    expect(h.appended).toHaveLength(0);
  });

  test("prints bounded, redacted diagnostics and fails closed when the backend never turns healthy", async () => {
    const secretHex = "ab".repeat(32);
    const h = harness((call) => {
      if (call.args[0] === "logs") return { status: 0, stdout: `boot line ${secretHex} more`, stderr: "" };
      if (call.args[0] === "inspect" && call.args.includes("{{.State.Running}}")) return ok("true\n");
      if (call.args[0] === "inspect") return ok("status=running exit=0 oom=false");
      return undefined;
    });
    h.deps.fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(startBackend(CI_ENV, h.deps)).rejects.toThrow(/did not become healthy/);
    const diagnostic = h.logs.find((line) => line.startsWith("Container state"))!;
    expect(diagnostic).toContain("status=running");
    expect(diagnostic).toContain("boot line");
    expect(diagnostic).not.toContain(secretHex);
    expect(diagnostic.length).toBeLessThan(7_000);
    // No key was derived from a backend that never answered.
    expect(h.calls.some((call) => call.args[0] === "exec")).toBe(false);
    expect(h.appended).toHaveLength(1);
  });

  test("fails when docker run fails, without echoing the secret", async () => {
    const secretHex = "ab".repeat(32);
    const h = harness((call) => (call.args[0] === "run" ? fail(`port in use ${secretHex}`) : undefined));
    let message = "";
    try {
      await startBackend(CI_ENV, h.deps);
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/docker run failed/);
    expect(message).not.toContain(secretHex);
  });

  test("retries a failed image pull and then gives up", async () => {
    const h = harness((call) => (call.args[0] === "pull" ? fail("registry unavailable") : undefined));
    await expect(startBackend(CI_ENV, h.deps)).rejects.toThrow(/after 3 attempts/);
    expect(h.calls.filter((call) => call.args[0] === "pull")).toHaveLength(3);
    expect(h.calls.some((call) => call.args[0] === "run")).toBe(false);
  });

  test("refuses a key of the wrong shape and does not export it", async () => {
    const h = harness((call) => (call.args[0] === "exec" ? ok("Error: not a key\n") : undefined));
    await expect(startBackend(CI_ENV, h.deps)).rejects.toThrow(/expected shape/);
    expect(h.appended.join("")).not.toContain("CONVEX_SELF_HOSTED_ADMIN_KEY");
  });
});

describe("setBackendEnv", () => {
  test("sets the five variables, then verifies the listing, through the repo's own CLI", () => {
    const h = harness();
    setBackendEnv(READY_ENV, h.deps);
    const sets = h.calls.filter((call) => call.args[1] === "env" && call.args[2] === "set");
    expect(sets.map((call) => call.args[3]).sort()).toEqual([...ENV_ALLOWLIST].sort());
    for (const call of h.calls) {
      expect(call.command).toBe(process.execPath);
      expect(call.args[0]).toBe("/repo/node_modules/convex/bin/main.js");
      expect(call.env.CONVEX_SELF_HOSTED_URL).toBe(LOCAL_CONVEX_URL);
      expect(call.env.CONVEX_SELF_HOSTED_ADMIN_KEY).toBe(ADMIN_KEY);
      // The key travels in the environment, never in argv.
      expect(call.args.join(" ")).not.toContain(ADMIN_KEY);
    }
    expect(h.calls.at(-1)!.args.slice(1)).toEqual(["env", "list", "--names-only"]);
  });

  test("fails when the backend holds anything beyond the allowlist, and removes nothing", () => {
    const h = harness((call) => (call.args.includes("list") ? ok(`${[...ENV_ALLOWLIST, "RESEND_API_KEY"].join("\n")}\n`) : undefined));
    expect(() => setBackendEnv(READY_ENV, h.deps)).toThrow(/Unexpected: \[RESEND_API_KEY\]/);
    expect(h.calls.some((call) => call.args.includes("remove"))).toBe(false);
  });

  test("fails when a variable is missing from the listing", () => {
    const h = harness((call) => (call.args.includes("list") ? ok("AUTOFLOW_DEPLOYMENT_CLASS\n") : undefined));
    expect(() => setBackendEnv(READY_ENV, h.deps)).toThrow(/Missing/);
  });

  test("refuses a live Clerk key before changing anything", () => {
    const h = harness();
    expect(() => setBackendEnv({ ...READY_ENV, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: LIVE_PUBLISHABLE_KEY }, h.deps)).toThrow(/pk_test/);
    expect(h.deps.exec).not.toHaveBeenCalled();
  });

  test("refuses beside a cloud credential and without a started backend", () => {
    const h = harness();
    expect(() => setBackendEnv({ ...READY_ENV, CONVEX_DEPLOYMENT: "dev:x" }, h.deps)).toThrow(/CONVEX_DEPLOYMENT/);
    expect(() => setBackendEnv({ ...READY_ENV, CONVEX_SELF_HOSTED_ADMIN_KEY: undefined }, h.deps)).toThrow(/start/);
    expect(h.deps.exec).not.toHaveBeenCalled();
  });

  test("strips cloud variables from the child environment even if they were somehow present upstream", () => {
    const h = harness();
    const env = { ...READY_ENV, CONVEX_DEPLOY_KEY: "" };
    setBackendEnv(env, h.deps);
    for (const call of h.calls) {
      expect(call.env).not.toHaveProperty("CONVEX_DEPLOY_KEY");
      expect(call.env).not.toHaveProperty("CONVEX_DEPLOYMENT");
    }
  });
});

describe("deployBackend", () => {
  test("verifies the environment first, deploys with typecheck on, then mints the marker", () => {
    const h = harness();
    deployBackend(READY_ENV, h.deps);
    const sequence = h.calls.map((call) => call.args.slice(1, 4).join(" "));
    expect(sequence).toEqual([
      "env list --names-only",
      "deploy --typecheck enable",
      "run e2eBootstrap:markPreviewDeployment {}",
    ]);
    expect(h.calls[1]!.args).toContain("--yes");
    expect(h.calls.some((call) => call.args.some((arg) => arg.startsWith("--preview")))).toBe(false);
    for (const call of h.calls) expect(call.env.CONVEX_SELF_HOSTED_URL).toBe(LOCAL_CONVEX_URL);
  });

  test("does not deploy when the environment is not the allowlist", () => {
    const h = harness((call) => (call.args.includes("list") ? ok("") : undefined));
    expect(() => deployBackend(READY_ENV, h.deps)).toThrow(/Missing/);
    expect(h.calls.some((call) => call.args[1] === "deploy")).toBe(false);
  });

  test("does not mint the marker when the deploy fails", () => {
    const h = harness((call) => (call.args[1] === "deploy" ? fail("", 2) : undefined));
    expect(() => deployBackend(READY_ENV, h.deps)).toThrow(/exit code 2/);
    expect(h.calls.some((call) => call.args[1] === "run")).toBe(false);
  });

  test.each(["CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT", "CONVEX_PREVIEW_DEPLOY_KEY"])("refuses beside %s", (name) => {
    const h = harness();
    expect(() => deployBackend({ ...READY_ENV, [name]: "x" }, h.deps)).toThrow(LocalConvexRefusal);
    expect(h.deps.exec).not.toHaveBeenCalled();
  });

  test("refuses a self-hosted URL that is not the loopback backend", () => {
    const h = harness();
    expect(() => deployBackend({ ...READY_ENV, CONVEX_SELF_HOSTED_URL: "https://clever-mockingbird-719.convex.cloud" }, h.deps)).toThrow(
      /exactly/,
    );
    expect(h.deps.exec).not.toHaveBeenCalled();
  });
});

describe("assertEnvMatchesPlan (round 5: values, not only names)", () => {
  const plan = buildEnvPlan({ publishableKey: PUBLISHABLE_KEY, appUrl: "http://127.0.0.1:3000" });

  test("passes on the exact plan in any order", () => {
    expect(() => assertEnvMatchesPlan([...PLAN_LINES].reverse().join("\n"), plan)).not.toThrow();
  });

  test.each([
    ["a rewritten value under an allowed name", PLAN_LINES.map((l) => (l.startsWith("NEXT_PUBLIC_APP_URL=") ? "NEXT_PUBLIC_APP_URL=https://evil.example" : l))],
    ["an added variable", [...PLAN_LINES, "PROBE_ESCALATED=1"]],
    ["a removed variable", PLAN_LINES.slice(1)],
    ["a duplicated line", [...PLAN_LINES, PLAN_LINES[0]!]],
  ])("refuses %s, naming the variable and never its value", (_label, lines) => {
    let message = "";
    try {
      assertEnvMatchesPlan(lines.join("\n"), plan);
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/differs from the trusted plan/);
    expect(message).not.toContain("evil.example");
  });

  test("a name-only check would have passed the rewritten value: the allowlist comparison alone is blind to it", () => {
    expect(() => assertEnvMatchesAllowlist(parseEnvNames(ENV_ALLOWLIST.join("\n")))).not.toThrow();
  });
});

describe("codeFingerprint", () => {
  const withRoot = (configHashes: Record<string, unknown>) => ({ ...deployedState(), configHashes });

  test("is independent of key order and module order, and changes with any root module hash", () => {
    const base = deployedState();
    const reordered = {
      ...base,
      configHashes: { ...base.configHashes, moduleHashes: [...base.configHashes.moduleHashes].reverse() },
      components: [...base.components].reverse(),
      componentModules: [...base.componentModules].reverse(),
    };
    expect(codeFingerprint(reordered)).toBe(codeFingerprint(base));
    expect(codeFingerprint(deployedState({ rootHash: "h2" }))).not.toBe(codeFingerprint(base));
    expect(codeFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes with the config, the Node version or the UDF server version", () => {
    const base = deployedState();
    expect(codeFingerprint(withRoot({ ...base.configHashes, config: { functions: "other/" } }))).not.toBe(codeFingerprint(base));
    expect(codeFingerprint(withRoot({ ...base.configHashes, nodeVersion: "20" }))).not.toBe(codeFingerprint(base));
    expect(codeFingerprint(withRoot({ ...base.configHashes, udfServerVersion: "1.0.0" }))).not.toBe(codeFingerprint(base));
  });

  test("does not read a nodeDependencies field: the pinned endpoint never sends one", () => {
    const base = deployedState();
    const invented = withRoot({ ...base.configHashes, nodeDependencies: [{ name: "x", version: "1" }] });
    expect(codeFingerprint(invented)).toBe(codeFingerprint(base));
  });

  test("changes when a mounted component's module is redeployed, though the root is untouched", () => {
    const base = deployedState();
    expect(codeFingerprint(deployedState({ componentPackage: "pkg-c2" }))).not.toBe(codeFingerprint(base));
    const [root, component] = base.componentModules as [unknown, [string, [string, Record<string, unknown>][]]];
    const [, [[path, module]]] = component;
    const otherFunctions = [root, [component[0], [[path, { ...module, functions: [] }]]]];
    expect(codeFingerprint({ ...base, componentModules: otherFunctions })).not.toBe(codeFingerprint(base));
  });

  test("changes when a component's mount arguments change or a component disappears", () => {
    const base = deployedState();
    const reconfigured = base.components.map((c) => (c.path === "" ? c : { ...c, args: { limit: 1 } }));
    expect(codeFingerprint({ ...base, components: reconfigured })).not.toBe(codeFingerprint(base));
    expect(() => codeFingerprint({ ...base, components: base.components.slice(0, 1) })).toThrow(/component/);
  });

  test("refuses a backend that reports no modules, so an empty backend never matches", () => {
    expect(() => codeFingerprint(withRoot({ moduleHashes: [] }))).toThrow(/no module hashes/);
    expect(() => codeFingerprint(withRoot({}))).toThrow(/no module hashes/);
    expect(() => codeFingerprint(withRoot({ moduleHashes: [{ path: "a.js" }] }))).toThrow(/no module hashes/);
    expect(() => codeFingerprint({})).toThrow(/no module hashes/);
  });

  test("refuses when any mounted component's modules are missing or unversioned", () => {
    const base = deployedState();
    expect(() => codeFingerprint({ ...base, componentModules: base.componentModules.slice(0, 1) })).toThrow(/component/);
    expect(() => codeFingerprint({ ...base, componentModules: undefined })).toThrow(/component/);
    expect(() => codeFingerprint({ ...base, components: undefined })).toThrow(/component/);
    const unversioned = [base.componentModules[0], ["cmp-rl", [["lib.js", { functions: [] }]]]];
    expect(() => codeFingerprint({ ...base, componentModules: unversioned })).toThrow(/component/);
  });

  test("stableStringify sorts keys at every depth", () => {
    expect(stableStringify({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"x":0,"y":1}]},"b":1}');
  });
});

describe("markBackend (SCRUM-892: marker only, for a staged candidate deployed elsewhere)", () => {
  test("verifies every value, records the code fingerprint, mints the marker, and never deploys", async () => {
    const h = harness();
    await markBackend({ ...READY_ENV, GITHUB_ENV: "/tmp/github_env" }, h.deps);
    expect(h.calls.map((call) => call.args.slice(1, 4).join(" "))).toEqual([
      "env list",
      "run e2eBootstrap:markPreviewDeployment {}",
    ]);
    expect(h.calls.some((call) => call.args[1] === "deploy")).toBe(false);
    for (const call of h.calls) expect(call.env.CONVEX_SELF_HOSTED_URL).toBe(LOCAL_CONVEX_URL);
    expect(h.appended).toEqual([`${FINGERPRINT_ENV_VAR}=${codeFingerprint(deployedState())}\n`]);
    const [url, init] = h.deps.fetchImpl.mock.calls.find(([u]) => String(u).endsWith("/api/get_config_hashes"))! as unknown as [string, RequestInit];
    expect(url).toBe(`${LOCAL_CONVEX_URL}/api/get_config_hashes`);
    expect(init.redirect).toBe("error");
  });

  test("reads every mounted component through the backend's own system queries, as admin", async () => {
    const h = harness();
    await markBackend(READY_ENV, h.deps);
    const queries = (h.deps.fetchImpl.mock.calls as unknown as [string, RequestInit][]).filter(([u]) => u.endsWith("/api/query"));
    expect(queries.map(([, init]) => JSON.parse(String(init.body)))).toEqual([
      { path: COMPONENTS_QUERY, format: "convex_encoded_json", args: [{}] },
      { path: COMPONENT_MODULES_QUERY, format: "convex_encoded_json", args: [{}] },
    ]);
    for (const [url, init] of queries) {
      expect(url).toBe(`${LOCAL_CONVEX_URL}/api/query`);
      expect(init.redirect).toBe("error");
      expect((init.headers as Record<string, string>).authorization).toBe(`Convex ${ADMIN_KEY}`);
    }
  });

  test("does not mint the marker when a component read fails, and never echoes the backend's message", async () => {
    const h = harness();
    h.deps.fetchImpl.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) =>
      String(url).endsWith("/api/query")
        ? ({ ok: true, status: 200, json: async () => ({ status: "error", errorMessage: `leak ${ADMIN_KEY}` }) } as unknown as Response)
        : answering(deployedState())(url, init),
    );
    const error = await markBackend(READY_ENV, h.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LocalConvexRefusal);
    expect(String((error as Error).message)).toMatch(new RegExp(COMPONENTS_QUERY));
    expect(String((error as Error).message)).not.toContain(ADMIN_KEY);
    expect(h.calls.some((call) => call.args[1] === "run")).toBe(false);
  });

  test("does not mint the marker when a value differs from the trusted plan", async () => {
    const h = harness((call) =>
      call.args.includes("list") ? ok(PLAN_LINES.map((l) => l.replace("preview", "production")).join("\n")) : undefined,
    );
    await expect(markBackend(READY_ENV, h.deps)).rejects.toThrow(/AUTOFLOW_DEPLOYMENT_CLASS/);
    expect(h.calls.some((call) => call.args[1] === "run")).toBe(false);
    expect(h.appended).toEqual([]);
  });

  test("does not mint the marker when the fingerprint cannot be read", async () => {
    const h = harness();
    h.deps.fetchImpl.mockImplementation(async () => ({ ok: false, status: 401 }) as Response);
    await expect(markBackend(READY_ENV, h.deps)).rejects.toThrow(/HTTP 401/);
    expect(h.calls.some((call) => call.args[1] === "run")).toBe(false);
  });

  test("surfaces a failed marker run", async () => {
    const h = harness((call) => (call.args[1] === "run" ? fail("", 3) : undefined));
    await expect(markBackend(READY_ENV, h.deps)).rejects.toThrow(/exit code 3/);
  });

  test.each(["CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT", "CONVEX_PREVIEW_DEPLOY_KEY"])("refuses beside %s", async (name) => {
    const h = harness();
    await expect(markBackend({ ...READY_ENV, [name]: "x" }, h.deps)).rejects.toThrow(LocalConvexRefusal);
    expect(h.deps.exec).not.toHaveBeenCalled();
  });

  test("refuses a self-hosted URL that is not the loopback backend", async () => {
    const h = harness();
    await expect(markBackend({ ...READY_ENV, CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:3211" }, h.deps)).rejects.toThrow(/exactly/);
    expect(h.deps.exec).not.toHaveBeenCalled();
  });
});

describe("verifyBackend (round 5 tripwire)", () => {
  const MARKED_ENV = { ...READY_ENV, [FINGERPRINT_ENV_VAR]: codeFingerprint(deployedState()) };

  test("passes when the variables equal the plan and the code fingerprint is unchanged", async () => {
    const h = harness();
    await verifyBackend(MARKED_ENV, h.deps);
    expect(h.calls.map((call) => call.args.slice(1, 3).join(" "))).toEqual(["env list"]);
    expect(h.logs.at(-1)).toMatch(/unchanged since it was marked/);
  });

  test("fails when a candidate added a variable with a minted key", async () => {
    const h = harness((call) => (call.args.includes("list") ? ok([...PLAN_LINES, "PROBE_ESCALATED=1"].join("\n")) : undefined));
    await expect(verifyBackend(MARKED_ENV, h.deps)).rejects.toThrow(/PROBE_ESCALATED/);
  });

  test("fails when a candidate rewrote an allowed variable's value", async () => {
    const h = harness((call) =>
      call.args.includes("list")
        ? ok(PLAN_LINES.map((l) => (l.startsWith("CLERK_JWT") ? "CLERK_JWT_ISSUER_DOMAIN=https://evil.example" : l)).join("\n"))
        : undefined,
    );
    await expect(verifyBackend(MARKED_ENV, h.deps)).rejects.toThrow(/CLERK_JWT_ISSUER_DOMAIN/);
  });

  test("fails when the deployed code changed after mark", async () => {
    const h = harness();
    h.deps.fetchImpl.mockImplementation(answering(deployedState({ rootHash: "swapped" })));
    await expect(verifyBackend(MARKED_ENV, h.deps)).rejects.toThrow(/deployed code changed after it was marked/);
  });

  test("fails when only a mounted component was redeployed after mark", async () => {
    const h = harness();
    h.deps.fetchImpl.mockImplementation(answering(deployedState({ componentPackage: "pkg-c2" })));
    await expect(verifyBackend(MARKED_ENV, h.deps)).rejects.toThrow(/deployed code changed after it was marked/);
  });

  test("fails closed without a recorded fingerprint, or when the backend no longer answers", async () => {
    await expect(verifyBackend(READY_ENV, harness().deps)).rejects.toThrow(new RegExp(FINGERPRINT_ENV_VAR));
    await expect(verifyBackend({ ...READY_ENV, [FINGERPRINT_ENV_VAR]: "abc" }, harness().deps)).rejects.toThrow(/missing/);
    const gone = harness();
    gone.deps.fetchImpl.mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(verifyBackend(MARKED_ENV, gone.deps)).rejects.toThrow(/no longer answers/);
    expect(gone.deps.exec).not.toHaveBeenCalled();
  });

  test("refuses beside a cloud credential like every other command", async () => {
    const h = harness();
    await expect(verifyBackend({ ...MARKED_ENV, CONVEX_DEPLOY_KEY: "x" }, h.deps)).rejects.toThrow(LocalConvexRefusal);
    expect(h.deps.exec).not.toHaveBeenCalled();
  });
});
describe("stopBackend", () => {
  test("removes the recorded container with --force", () => {
    const h = harness();
    stopBackend({ [CONTAINER_ENV_VAR]: CONTAINER }, h.deps);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.args).toEqual(["rm", "--force", CONTAINER]);
  });

  test("is idempotent: no recorded container, or one already gone, is fine", () => {
    const none = harness();
    stopBackend({}, none.deps);
    expect(none.deps.exec).not.toHaveBeenCalled();

    const gone = harness(() => fail("Error response from daemon: No such container: x"));
    expect(() => stopBackend({ [CONTAINER_ENV_VAR]: CONTAINER }, gone.deps)).not.toThrow();
  });

  test("surfaces any other docker failure", () => {
    const h = harness(() => fail("permission denied"));
    expect(() => stopBackend({ [CONTAINER_ENV_VAR]: CONTAINER }, h.deps)).toThrow(/docker rm failed/);
  });

  test("never removes a container this script did not name", () => {
    const h = harness();
    expect(() => stopBackend({ [CONTAINER_ENV_VAR]: "production-db" }, h.deps)).toThrow(LocalConvexRefusal);
    expect(h.deps.exec).not.toHaveBeenCalled();
  });

  test("refuses beside a cloud credential like every other command", () => {
    const h = harness();
    expect(() => stopBackend({ [CONTAINER_ENV_VAR]: CONTAINER, CONVEX_DEPLOY_KEY: "x" }, h.deps)).toThrow(LocalConvexRefusal);
  });
});

describe("main", () => {
  test("dispatches the six subcommands and refuses anything else", async () => {
    const h = harness();
    await main(["stop"], {}, h.deps);
    await main(["mark"], READY_ENV, h.deps);
    await main(["verify"], { ...READY_ENV, [FINGERPRINT_ENV_VAR]: codeFingerprint(deployedState()) }, h.deps);
    await expect(main(["deploy-prod"], {}, h.deps)).rejects.toThrow(/Usage/);
    await expect(main([], {}, h.deps)).rejects.toThrow(/Usage/);
  });
});
