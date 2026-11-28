/**
 * SCRUM-1026 PR B: the release-target entrypoints, executed IN PROCESS.
 *
 * `releaseTargetEntrypoints.test.ts` starts the same scripts as child processes
 * and proves the real process boundary (exit status, stdout, a real shell). V8
 * coverage from a spawned child is not recorded, so Sonar sees none of those
 * lines. This suite imports each `.mjs` in the test process and replaces only
 * the process boundaries (`process.exit`, `process.exitCode`, argv, env,
 * `fetch`, `node:child_process`), the pattern `verifyZeroState.test.ts` uses.
 * No classifier or decision function is mocked, so every assertion below is
 * about what the real script decides and what it lets through.
 *
 * `process.exit` is replaced by a throw so a refused path really stops.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── the process boundaries ──────────────────────────────────────────────────
type CliAnswer = { stdout?: string; stderr?: string; status?: number | null };
const spawned: string[][] = [];
let cliAnswer: (args: string[]) => CliAnswer = () => ({ stdout: "", status: 1 });

vi.mock("node:child_process", () => {
  // The rollout runs `node <repo CLI path> <command…> <selector…>`; the CLI path is stripped.
  const spawnSync = (_file: string, rawArgs: string[]) => {
    const args = rawArgs.slice(1);
    spawned.push(args);
    const a = cliAnswer(args);
    return { stdout: a.stdout ?? "", stderr: a.stderr ?? "", status: a.status ?? 0 };
  };
  return { spawnSync, default: { spawnSync } };
});

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

// Fixtures, not credentials: made-up, low-entropy admin-key tokens built at runtime.
const TOKEN = "fixture-token-".concat("x".repeat(24));
const INSTANCE = "autoflow-prod";
const KEY = `${INSTANCE}|${TOKEN}`;
const ORIGIN = "https://convex.example.com";
const CLOUD_NAME = "kindly-hound-172";
const SCRIPTS = {
  resolve: () => import("./resolveReleaseTarget.mjs"),
  deployEnv: () => import("./assertSelfHostedDeployEnv.mjs"),
  credentials: () => import("./assertReleaseCredentials.mjs"),
  rollout: () => import("./rolloutRelease.mjs"),
};

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_EXIT = process.exit;
let logs: string[];
let errors: string[];
let scratch: string;

type Result = { exitCode: number | undefined; stdout: string; stderr: string };

async function run(script: keyof typeof SCRIPTS, env: Record<string, string | undefined>): Promise<Result> {
  spawned.length = 0;
  logs.length = 0;
  errors.length = 0;
  for (const key of Object.keys(process.env)) {
    if (/^CONVEX_|^RELEASE_|^ROLLOUT_|^GITHUB_(OUTPUT|STEP_SUMMARY)$/.test(key)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  process.exitCode = undefined;
  vi.resetModules();
  let exitCode: number | undefined;
  try {
    await SCRIPTS[script]();
    exitCode = typeof process.exitCode === "number" ? process.exitCode : undefined;
  } catch (e) {
    if (e instanceof ExitSignal) exitCode = e.code;
    else throw e;
  } finally {
    process.exitCode = undefined;
  }
  return { exitCode, stdout: logs.join("\n"), stderr: errors.join("\n") };
}

beforeEach(() => {
  logs = [];
  errors = [];
  cliAnswer = () => ({ stdout: "", status: 1 });
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "release-target-inproc-"));
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never;
});

afterEach(() => {
  process.exit = ORIGINAL_EXIT;
  process.argv = ORIGINAL_ARGV;
  process.exitCode = undefined;
  for (const key of Object.keys(process.env)) if (!(key in ORIGINAL_ENV)) delete process.env[key];
  Object.assign(process.env, ORIGINAL_ENV);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(scratch, { recursive: true, force: true });
});

const nothingLeaked = (r: Result) => expect(r.stdout + r.stderr).not.toContain(TOKEN);

// ─── resolveReleaseTarget.mjs ───────────────────────────────────────────────
describe("resolveReleaseTarget.mjs (in process)", () => {
  const resolve = (value: string | undefined, withOutput = true) => {
    const file = path.join(scratch, "output");
    fs.writeFileSync(file, "");
    return run("resolve", { CONVEX_PROD_TARGET: value, GITHUB_OUTPUT: withOutput ? file : undefined }).then((r) => ({
      r,
      written: fs.readFileSync(file, "utf8"),
    }));
  };
  test.each([[undefined, "cloud"], ["", "cloud"], ["cloud", "cloud"], ["self-hosted", "self-hosted"]])(
    "%j publishes target=%s and exits cleanly",
    async (value, expected) => {
      const { r, written } = await resolve(value);
      expect(r.exitCode).toBeUndefined();
      expect(written).toBe(`target=${expected}\n`);
      expect(r.stdout).toContain(`Production deploy target: ${expected}`);
    }
  );
  test.each(["Self-Hosted", "selfhosted", " "])("%j refuses with the rule and publishes nothing", async (value) => {
    const { r, written } = await resolve(value);
    expect(r.exitCode).toBe(1);
    expect(written).toBe("");
    expect(r.stderr).toMatch(/must be unset, `cloud` or `self-hosted`/);
  });
  test("a valid target still refuses when the output cannot be published", async () => {
    const { r, written } = await resolve("self-hosted", false);
    expect(r.exitCode).toBe(1);
    expect(written).toBe("");
    expect(r.stderr).toMatch(/GITHUB_OUTPUT is not available/);
  });
});

// ─── assertSelfHostedDeployEnv.mjs ──────────────────────────────────────────
describe("assertSelfHostedDeployEnv.mjs (in process)", () => {
  const stepEnv = { CONVEX_SELF_HOSTED_URL: "https://convex.autoflowdealer.com", CONVEX_SELF_HOSTED_ADMIN_KEY: KEY };
  test("control: the canonical URL and no cloud-pointing variable passes and names only the host", async () => {
    const r = await run("deployEnv", stepEnv);
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain("convex.autoflowdealer.com");
    nothingLeaked(r);
  });
  test.each(["CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT_TOKEN", "CONVEX_DEPLOYMENT", "CONVEX_PREVIEW_DEPLOY_KEY"])(
    "%s present refuses, by name only",
    async (name) => {
      const r = await run("deployEnv", { ...stepEnv, [name]: `prod:${INSTANCE}|${TOKEN}` });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(`${name} is present in a self-hosted step`);
      expect(r.stdout).not.toMatch(/Self-hosted deploy step:/);
      nothingLeaked(r);
    }
  );
  test.each([
    ["an explicit default port", "https://convex.autoflowdealer.com:443", /drop :443/],
    ["a non-canonical spelling", "https://Convex.AutoflowDealer.com", /exactly as https:\/\/convex\.autoflowdealer\.com/],
    ["no URL", undefined, /bare https origin/],
  ])("the URL the CLI would receive is checked: %s", async (_label, url, pattern) => {
    const r = await run("deployEnv", { ...stepEnv, CONVEX_SELF_HOSTED_URL: url });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(pattern);
  });
});

// ─── assertReleaseCredentials.mjs ───────────────────────────────────────────
describe("assertReleaseCredentials.mjs (in process)", () => {
  const selfHosted = (over: Record<string, string | undefined> = {}) => ({
    CONVEX_PROD_TARGET: "self-hosted",
    CONVEX_PROD_DEPLOYMENT: INSTANCE,
    CONVEX_PROD_SELF_HOSTED_URL: ORIGIN,
    CONVEX_PROD_SELF_HOSTED_ADMIN_KEY: KEY,
    ...over,
  });
  const fetched: string[] = [];
  const backendSays = (body: string, status = 200) => {
    fetched.length = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      fetched.push(`${url}|${init?.redirect}|${init?.headers === undefined ? "no-headers" : "headers"}`);
      return new Response(body, { status });
    });
  };

  test("self-hosted control: matching key and backend pass, asked WITHOUT credentials and never following redirects", async () => {
    backendSays(`${INSTANCE}\n`);
    const r = await run("credentials", selfHosted());
    expect(r.exitCode).toBeUndefined();
    expect(fetched).toEqual([`${ORIGIN}/instance_name|manual|no-headers`]);
    expect(r.stdout).toContain(`${INSTANCE}`);
    expect(r.stdout).toMatch(/targeting check, not authentication/);
    nothingLeaked(r);
  });
  test("self-hosted: a backend that reports another instance name refuses", async () => {
    backendSays("someone-else\n");
    const r = await run("credentials", selfHosted());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/different instance name than CONVEX_PROD_DEPLOYMENT/);
    nothingLeaked(r);
  });
  test.each([
    ["a cloud key left in the step", { CONVEX_DEPLOY_KEY: `prod:${INSTANCE}|${TOKEN}` }, /CONVEX_DEPLOY_KEY is present/],
    ["a key for another instance", { CONVEX_PROD_SELF_HOSTED_ADMIN_KEY: `other-prod|${TOKEN}` }, /different instance name/],
    ["a convex.cloud URL", { CONVEX_PROD_SELF_HOSTED_URL: "https://some-name-123.convex.cloud" }, /Convex Cloud host/],
    ["an unknown target", { CONVEX_PROD_TARGET: "self_hosted" }, /must be unset/],
  ])("self-hosted refuses %s before any network call", async (_label, over, pattern) => {
    backendSays(`${INSTANCE}\n`);
    const r = await run("credentials", selfHosted(over));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(pattern);
    expect(fetched).toEqual([]);
    nothingLeaked(r);
  });

  const cloud = (over: Record<string, string | undefined> = {}) => ({
    CONVEX_PROD_DEPLOYMENT: CLOUD_NAME,
    CONVEX_PROD_DEPLOY_KEY: `prod:${CLOUD_NAME}|deploysecret`,
    CONVEX_PROD_OPERATOR_KEY: `prod:${CLOUD_NAME}|opsecret`,
    ...over,
  });
  test("cloud control: both keys addressing the expected deployment pass; no secret is printed", async () => {
    const r = await run("credentials", cloud());
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain(CLOUD_NAME);
    expect(r.stdout + r.stderr).not.toMatch(/deploysecret|opsecret/);
  });
  test("cloud: a key for another deployment still refuses (the unchanged gate)", async () => {
    const r = await run("credentials", cloud({ CONVEX_PROD_OPERATOR_KEY: "prod:other-deployment-1|opsecret" }));
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).not.toMatch(/deploysecret|opsecret/);
  });
  test.each([
    ["a self-hosted URL", { CONVEX_PROD_SELF_HOSTED_URL: ORIGIN }],
    ["a self-hosted key", { CONVEX_PROD_SELF_HOSTED_ADMIN_KEY: KEY }],
    ["an unknown target", { CONVEX_PROD_TARGET: "clod" }],
  ])("cloud refuses a mixed configuration: %s", async (_label, over) => {
    const r = await run("credentials", cloud(over));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Mixed configuration|must be unset/);
    expect(r.stdout + r.stderr).not.toMatch(/deploysecret|opsecret/);
    nothingLeaked(r);
  });
});

// ─── rolloutRelease.mjs ─────────────────────────────────────────────────────
describe("rolloutRelease.mjs, target handling (in process)", () => {
  const selfHosted = (over: Record<string, string | undefined> = {}) => ({
    CONVEX_PROD_TARGET: "self-hosted",
    CONVEX_PROD_DEPLOYMENT: INSTANCE,
    CONVEX_SELF_HOSTED_URL: ORIGIN,
    CONVEX_SELF_HOSTED_ADMIN_KEY: KEY,
    RELEASE_SHA: "a".repeat(40),
    ...over,
  });
  const cloudEnv = (over: Record<string, string | undefined> = {}) => ({
    CONVEX_PROD_DEPLOYMENT: CLOUD_NAME,
    CONVEX_DEPLOY_KEY: `prod:${CLOUD_NAME}|opsecret`,
    RELEASE_SHA: "a".repeat(40),
    ...over,
  });

  test.each([
    ["a cloud key in the step", { CONVEX_DEPLOY_KEY: `prod:${INSTANCE}|${TOKEN}` }, /CONVEX_DEPLOY_KEY is present/],
    ["a cloud deployment token in the step", { CONVEX_DEPLOYMENT_TOKEN: `prod:${INSTANCE}|${TOKEN}` }, /CONVEX_DEPLOYMENT_TOKEN is present/],
    ["a convex.cloud URL", { CONVEX_SELF_HOSTED_URL: "https://some-name-123.convex.cloud" }, /Convex Cloud host/],
    ["an explicit default port", { CONVEX_SELF_HOSTED_URL: `${ORIGIN}:443` }, /drop :443/],
    ["a key for another instance", { CONVEX_SELF_HOSTED_ADMIN_KEY: `other-prod|${TOKEN}` }, /different instance name/],
    ["no key", { CONVEX_SELF_HOSTED_ADMIN_KEY: undefined }, /no self-hosted admin key/],
    ["an unknown target", { CONVEX_PROD_TARGET: "self_hosted" }, /must be unset/],
  ])("refuses %s before the CLI is ever started", async (_label, over, pattern) => {
    const r = await run("rollout", selfHosted(over));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(pattern);
    expect(spawned).toEqual([]);
    expect(r.stdout).not.toMatch(/Reading the current materialisation state/);
    nothingLeaked(r);
  });
  test("the cloud target refuses a self-hosted variable (mixed) before the CLI is started", async () => {
    const r = await run("rollout", cloudEnv({ CONVEX_SELF_HOSTED_URL: ORIGIN }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/Mixed configuration/);
    expect(spawned).toEqual([]);
    expect(r.stdout + r.stderr).not.toContain("opsecret");
  });
  test("the cloud target still refuses a key for another deployment", async () => {
    const r = await run("rollout", cloudEnv({ CONVEX_DEPLOY_KEY: "prod:other-deployment-1|opsecret" }));
    expect(r.exitCode).toBe(1);
    expect(spawned).toEqual([]);
    expect(r.stdout + r.stderr).not.toContain("opsecret");
  });

  const report = (deploymentUrl: string) => (args: string[]): CliAnswer =>
    args[1] === "adminSystem:materializationReportForRelease"
      ? { stdout: JSON.stringify({ page: [], isDone: true, continueCursor: "", deploymentUrl }), status: 0 }
      : { stdout: "", status: 1 };

  test("self-hosted: the CLI is selected by URL and key alone (no --prod), and a matching backend URL lets the run proceed", async () => {
    cliAnswer = report(ORIGIN);
    const r = await run("rollout", selfHosted());
    // The report was accepted (identity matched), so the next phase was attempted; it fails because the stub answers nothing else.
    expect(spawned.map((a) => a[1])).toEqual(["adminSystem:materializationReportForRelease", "accountingOutbox:recoverPeriodHeldSupplierVat"]);
    expect(spawned.every((a) => !a.includes("--prod") && a.at(-1) === "disable")).toBe(true);
    expect(r.exitCode).toBe(1);
    nothingLeaked(r);
  });
  test("self-hosted: a function runtime that reports another URL stops the run at the first report", async () => {
    cliAnswer = report("https://other.example.com");
    const r = await run("rollout", selfHosted());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/different URL than the one configured/);
    expect(spawned.length).toBe(1);
  });
  test("self-hosted: a non-string reported URL stops the run (never a TypeError)", async () => {
    cliAnswer = (args) =>
      args[1] === "adminSystem:materializationReportForRelease"
        ? { stdout: JSON.stringify({ page: [], isDone: true, continueCursor: "", deploymentUrl: 42 }), status: 0 }
        : { stdout: "", status: 1 };
    const r = await run("rollout", selfHosted());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/did not report its own URL/);
    expect(spawned.length).toBe(1);
  });
  test("cloud: the unchanged path still passes --prod and checks the *.convex.cloud identity", async () => {
    cliAnswer = report(`https://${CLOUD_NAME}.convex.cloud`);
    const r = await run("rollout", cloudEnv());
    expect(spawned.map((a) => a[1])).toEqual(["adminSystem:materializationReportForRelease", "accountingOutbox:recoverPeriodHeldSupplierVat"]);
    expect(spawned.every((a) => a.includes("--prod"))).toBe(true);
    expect(r.exitCode).toBe(1);
    cliAnswer = report("https://some-other-1.convex.cloud");
    const wrong = await run("rollout", cloudEnv());
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr).toMatch(/expects/);
    expect(spawned.length).toBe(1);
  });
});
