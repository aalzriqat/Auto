import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { main, prune } from "./pruneConvexPreviews.mjs";

const TOKEN = "prj-unit-test-token-bytes";
const PROJECT_ID = 4242;
const HOUR = 60 * 60 * 1000;
const NOW = 1_790_000_000_000;

type Call = { method: string; url: string; auth?: string };
type Dep = Record<string, unknown>;

function dep(name: string, overrides: Dep = {}): Dep {
  return {
    id: 1,
    name,
    kind: "cloud",
    deploymentType: "preview",
    isDefault: false,
    projectId: PROJECT_ID,
    previewIdentifier: "e2e-pr-1-" + name,
    createTime: NOW - 10 * HOUR,
    expiresAt: null,
    ...overrides,
  };
}

type ApiOptions = {
  tokenDetails?: Dep;
  /** What the list endpoint returns (defaults to `current` values). */
  listed?: Dep[];
  /** What GET /deployments/{name} returns; null means 404. Defaults to listed. */
  reread?: Record<string, Dep | null>;
  deleteStatus?: Record<string, number>;
};

function api(deps: Dep[], options: ApiOptions = {}) {
  const calls: Call[] = [];
  const base = "https://api.convex.dev/v1";
  const fetchImpl = async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const method = String(init.method ?? "GET");
    calls.push({ method, url, auth: headers.authorization });
    const rel = url.slice(base.length);
    if (rel === "/token_details") {
      return new Response(
        JSON.stringify(options.tokenDetails ?? { type: "projectToken", projectId: PROJECT_ID }),
        { status: 200 },
      );
    }
    if (rel.startsWith("/projects/")) {
      return new Response(JSON.stringify(options.listed ?? deps), { status: 200 });
    }
    const m = /^\/deployments\/([^/]+)(\/delete)?$/.exec(rel);
    if (m && method === "GET") {
      const current =
        options.reread && m[1] in options.reread
          ? options.reread[m[1]]
          : (options.listed ?? deps).find((d) => d.name === m[1]) ?? null;
      return current
        ? new Response(JSON.stringify(current), { status: 200 })
        : new Response("not found", { status: 404 });
    }
    if (m && m[2] && method === "POST") {
      return new Response("", { status: options.deleteStatus?.[m[1]] ?? 200 });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    CONVEX_PREVIEW_PRUNE_TOKEN: TOKEN,
    ...overrides,
  } as unknown as NodeJS.ProcessEnv;
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");
const deleted = (calls: Call[]) =>
  posts(calls).map((c) => c.url.replace("https://api.convex.dev/v1/deployments/", "").replace("/delete", ""));

async function run(deps: Dep[], opts: ApiOptions = {}, e: NodeJS.ProcessEnv = env()) {
  const { calls, fetchImpl } = api(deps, opts);
  const out: string[] = [];
  const result = await prune({ env: e, fetchImpl, now: () => NOW, write: (l: string) => out.push(l) });
  return { calls, out, result };
}

const CONFIRM = { PRUNE_CONFIRM: "PRUNE" };

describe("SCRUM-548 prune leaked Convex previews", () => {
  it("dry run plans aged previews and makes zero POSTs", async () => {
    const { calls, result, out } = await run([dep("aaa-bbb-1"), dep("ccc-ddd-2")]);
    expect(posts(calls)).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.rows.map((r: { action: string }) => r.action)).toEqual(["would delete", "would delete"]);
    expect(out.join("\n")).toContain("aaa-bbb-1");
  });

  it("any PRUNE_CONFIRM other than exactly PRUNE is a dry run", async () => {
    for (const confirm of ["prune", "PRUNE ", "yes", ""]) {
      const { calls } = await run([dep("aaa-bbb-1")], {}, env({ PRUNE_CONFIRM: confirm }));
      expect(posts(calls)).toEqual([]);
    }
  });

  it("PRUNE deletes only aged, eligible previews, oldest first", async () => {
    const { calls, result } = await run(
      [
        dep("young-one-1", { createTime: NOW - 2 * HOUR }),
        dep("aaa-bbb-2", { createTime: NOW - 4 * HOUR }),
        dep("ccc-ddd-3", { createTime: NOW - 30 * HOUR }),
        dep("exact-edge-4", { createTime: NOW - 3 * HOUR }),
      ],
      {},
      env(CONFIRM),
    );
    expect(deleted(calls)).toEqual(["ccc-ddd-3", "aaa-bbb-2", "exact-edge-4"]);
    expect(result.exitCode).toBe(0);
    expect(result.rows.find((r: { name: string }) => r.name === "young-one-1")?.action).toMatch(/too young/);
  });

  it.each([
    ["protected production name", dep("kindly-hound-172")],
    ["isDefault true", dep("aaa-bbb-1", { isDefault: true })],
    ["prod type", dep("aaa-bbb-1", { deploymentType: "prod" })],
    ["dev type", dep("aaa-bbb-1", { deploymentType: "dev" })],
    ["custom type", dep("aaa-bbb-1", { deploymentType: "custom" })],
    ["local kind", dep("aaa-bbb-1", { kind: "local" })],
    ["missing kind", dep("aaa-bbb-1", { kind: undefined })],
    ["other project", dep("aaa-bbb-1", { projectId: PROJECT_ID + 1 })],
    ["malformed name", dep("Not_A-Deployment")],
    ["name with no digits", dep("aaa-bbb")],
    ["too young", dep("aaa-bbb-1", { createTime: NOW - 1 * HOUR })],
    ["future createTime", dep("aaa-bbb-1", { createTime: NOW + HOUR })],
    ["missing createTime", dep("aaa-bbb-1", { createTime: undefined })],
    ["zero createTime", dep("aaa-bbb-1", { createTime: 0 })],
    ["fractional createTime", dep("aaa-bbb-1", { createTime: 1.5 })],
  ])("never POSTs a refused entry: %s", async (_label, entry) => {
    const { calls, result } = await run([entry], {}, env(CONFIRM));
    expect(posts(calls)).toEqual([]);
    expect(calls.filter((c) => c.url.includes("/deployments/"))).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("refuses a team token: nothing listed, nothing deleted", async () => {
    const { calls, result } = await run(
      [dep("aaa-bbb-1")],
      { tokenDetails: { type: "teamToken", teamId: 7, projectId: PROJECT_ID } },
      env(CONFIRM),
    );
    expect(calls.map((c) => c.url)).toEqual(["https://api.convex.dev/v1/token_details"]);
    expect(result.exitCode).not.toBe(0);
  });

  it("refuses a project token without a projectId", async () => {
    const { calls, result } = await run([dep("aaa-bbb-1")], { tokenDetails: { type: "projectToken" } }, env(CONFIRM));
    expect(calls).toHaveLength(1);
    expect(result.exitCode).not.toBe(0);
  });

  it.each(["tok\r", "tok\n", "to ken", " tok", "", undefined])(
    "refuses a malformed token %j before any fetch",
    async (token) => {
      const { calls, result } = await run([dep("aaa-bbb-1")], {}, env({ ...CONFIRM, CONVEX_PREVIEW_PRUNE_TOKEN: token }));
      expect(calls).toEqual([]);
      expect(result.exitCode).not.toBe(0);
    },
  );

  it.each<[string, Dep | null, RegExp]>([
    ["changed createTime", dep("aaa-bbb-1", { createTime: NOW - 4 * HOUR }), /createTime changed/],
    ["404 (already gone)", null, /already gone/],
    ["now prod", dep("aaa-bbb-1", { deploymentType: "prod" }), /^skipped/],
    ["now default", dep("aaa-bbb-1", { isDefault: true }), /^skipped/],
    ["now local", dep("aaa-bbb-1", { kind: "local" }), /^skipped/],
    ["other project", dep("aaa-bbb-1", { projectId: 1 }), /^skipped/],
    ["different name", dep("zzz-yyy-9"), /name mismatch/],
  ])("re-read: %s is skipped, never deleted", async (_label, current, action) => {
    const { calls, result } = await run([dep("aaa-bbb-1")], { reread: { "aaa-bbb-1": current } }, env(CONFIRM));
    expect(posts(calls)).toEqual([]);
    expect(result.rows[0].action).toMatch(action);
    expect(result.exitCode).toBe(0);
  });

  it("re-read HTTP failure is skipped, never deleted", async () => {
    const { calls, fetchImpl } = api([dep("aaa-bbb-1")]);
    const flaky = (async (url: string, init: RequestInit) =>
      /\/deployments\/aaa-bbb-1$/.test(url) ? new Response("", { status: 500 }) : fetchImpl(url, init)) as unknown as typeof fetch;
    const result = await prune({ env: env(CONFIRM), fetchImpl: flaky, now: () => NOW, write: () => {} });
    expect(posts(calls)).toEqual([]);
    expect(result.rows[0].action).toMatch(/HTTP 500/);
  });

  it.each(["0", "0.5", "abc", "-3", "1e2", "NaN", "Infinity"])(
    "refuses PRUNE_MIN_AGE_HOURS=%s before any fetch",
    async (v) => {
      const { calls, result } = await run([dep("aaa-bbb-1")], {}, env({ ...CONFIRM, PRUNE_MIN_AGE_HOURS: v }));
      expect(calls).toEqual([]);
      expect(result.exitCode).not.toBe(0);
    },
  );

  it("honours PRUNE_MIN_AGE_HOURS and defaults to 3 when blank", async () => {
    const deps = [dep("aaa-bbb-1", { createTime: NOW - 5 * HOUR })];
    expect(deleted((await run(deps, {}, env({ ...CONFIRM, PRUNE_MIN_AGE_HOURS: "6" }))).calls)).toEqual([]);
    expect(deleted((await run(deps, {}, env({ ...CONFIRM, PRUNE_MIN_AGE_HOURS: "" }))).calls)).toEqual(["aaa-bbb-1"]);
  });

  it("caps deletions per run and reports the rest as deferred", async () => {
    const deps = [1, 2, 3, 4].map((i) => dep("aaa-bbb-" + i, { createTime: NOW - (10 + i) * HOUR }));
    const { calls, result } = await run(deps, {}, env({ ...CONFIRM, PRUNE_MAX_DELETIONS: "2" }));
    expect(deleted(calls)).toEqual(["aaa-bbb-4", "aaa-bbb-3"]);
    expect(result.rows.filter((r: { action: string }) => /cap/.test(r.action))).toHaveLength(2);
  });

  it.each(["0", "101", "abc", "1.5", "-1"])("refuses PRUNE_MAX_DELETIONS=%s", async (v) => {
    const { calls, result } = await run([dep("aaa-bbb-1")], {}, env({ ...CONFIRM, PRUNE_MAX_DELETIONS: v }));
    expect(calls).toEqual([]);
    expect(result.exitCode).not.toBe(0);
  });

  it("a failed delete exits non-zero but the remaining previews are still processed", async () => {
    const deps = [dep("aaa-bbb-1", { createTime: NOW - 20 * HOUR }), dep("ccc-ddd-2", { createTime: NOW - 10 * HOUR })];
    const { calls, result, out } = await run(deps, { deleteStatus: { "aaa-bbb-1": 500 } }, env(CONFIRM));
    expect(deleted(calls)).toEqual(["aaa-bbb-1", "ccc-ddd-2"]);
    expect(result.exitCode).not.toBe(0);
    expect(out.join("\n")).toContain("delete failed (HTTP 500)");
  });

  it("a 404 on delete is treated as already gone, not a failure", async () => {
    const { result } = await run([dep("aaa-bbb-1")], { deleteStatus: { "aaa-bbb-1": 404 } }, env(CONFIRM));
    expect(result.exitCode).toBe(0);
    expect(result.rows[0].action).toMatch(/already gone/);
  });

  it("lists with the preview/non-default filter for the token's project", async () => {
    const { calls } = await run([]);
    expect(calls[1]?.url).toBe(
      "https://api.convex.dev/v1/projects/" + PROJECT_ID + "/list_deployments?deploymentType=preview&isDefault=false",
    );
    expect(calls.every((c) => c.auth === "Bearer " + TOKEN)).toBe(true);
  });

  it("a non-array list response fails closed", async () => {
    const { fetchImpl } = api([]);
    const bad = (async (url: string, init: RequestInit) =>
      url.includes("/projects/") ? new Response("{}", { status: 200 }) : fetchImpl(url, init)) as unknown as typeof fetch;
    const result = await prune({ env: env(CONFIRM), fetchImpl: bad, now: () => NOW, write: () => {} });
    expect(result.exitCode).not.toBe(0);
  });

  it("never writes the token to stdout, the step summary, or error output", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "prune-"));
    const summary = path.join(dir, "summary.md");
    const out: string[] = [];
    const { fetchImpl } = api([dep("aaa-bbb-1", { previewIdentifier: "x|y\nz" })], { deleteStatus: { "aaa-bbb-1": 500 } });
    await prune({
      env: env({ ...CONFIRM, GITHUB_STEP_SUMMARY: summary }),
      fetchImpl,
      now: () => NOW,
      write: (l: string) => out.push(l),
    });
    const throwing = (async () => {
      throw new Error("boom " + TOKEN);
    }) as unknown as typeof fetch;
    await prune({ env: env(CONFIRM), fetchImpl: throwing, now: () => NOW, write: (l: string) => out.push(l) });
    const all = out.join("\n") + readFileSync(summary, "utf8");
    expect(all).not.toContain(TOKEN);
    expect(readFileSync(summary, "utf8")).toContain("aaa-bbb-1");
    // Untrusted previewIdentifier cannot break the markdown table.
    expect(readFileSync(summary, "utf8")).not.toContain("x|y");
  });

  it("client refusals surface their own message, not the generic failure", async () => {
    const oversize = (async () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 })) as unknown as typeof fetch;
    const broken = (async () => {
      throw new Error("boom " + TOKEN);
    }) as unknown as typeof fetch;
    for (const [fetchImpl, message] of [
      [oversize, "exceeds the size limit"],
      [broken, "request failed"],
    ] as const) {
      const out: string[] = [];
      const result = await prune({ env: env(), fetchImpl, now: () => NOW, write: (l: string) => out.push(l) });
      expect(result.exitCode).toBe(1);
      expect(out.join("\n")).toContain(message);
      expect(out.join("\n")).not.toContain("Unexpected failure");
    }
  });

  it("main returns the exit code", async () => {
    const { fetchImpl } = api([dep("aaa-bbb-1")]);
    expect(await main({ env: env(), fetchImpl, now: () => NOW, write: () => {} })).toBe(0);
    expect(await main({ env: env({ CONVEX_PREVIEW_PRUNE_TOKEN: "" }), fetchImpl, now: () => NOW, write: () => {} })).toBe(1);
  });
});

describe("SCRUM-548 prune workflow", () => {
  const file = path.join(process.cwd(), ".github", "workflows", "prune-convex-previews.yml");
  const text = readFileSync(file, "utf8");
  type Step = { uses?: string; run?: string; env?: Record<string, string> };
  type Wf = {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    concurrency: Record<string, unknown>;
    jobs: Record<string, { if?: string; permissions?: unknown; "timeout-minutes"?: number; steps: Step[] }>;
  };
  const wf = parse(text) as Wf;
  const job = Object.values(wf.jobs)[0];

  it("is workflow_dispatch only", () => {
    expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys((wf.on.workflow_dispatch as { inputs: object }).inputs).sort()).toEqual(["confirm", "min_age_hours"]);
  });

  it("has a single job with contents: read as the only permission", () => {
    expect(Object.keys(wf.jobs)).toHaveLength(1);
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(job.permissions ?? wf.permissions).toEqual({ contents: "read" });
  });

  it("only runs on main, single-flight, with a timeout", () => {
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(wf.concurrency["cancel-in-progress"]).toBe(false);
    expect(wf.concurrency.group).toBeTruthy();
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(15);
  });

  it("pins every action by SHA", () => {
    for (const s of job.steps.filter((x) => x.uses)) expect(s.uses).toMatch(/@[0-9a-f]{40}\b/);
  });

  it("passes inputs and the secret through env, never interpolated into run", () => {
    for (const s of job.steps.filter((x) => x.run)) expect(s.run).not.toMatch(/\$\{\{/);
    const step = job.steps.find((s) => s.run?.includes("scripts/pruneConvexPreviews.mjs"));
    expect(step?.env).toMatchObject({
      CONVEX_PREVIEW_PRUNE_TOKEN: "${{ secrets.CONVEX_PREVIEW_PRUNE_TOKEN }}",
      PRUNE_CONFIRM: "${{ inputs.confirm }}",
      PRUNE_MIN_AGE_HOURS: "${{ inputs.min_age_hours }}",
    });
    expect(text.match(/\$\{\{\s*inputs\./g)).toHaveLength(2);
    expect(text.match(/\$\{\{\s*secrets\./g)).toHaveLength(1);
  });
});
