// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runGate } from "./trustedPrE2eGateCli.mjs";

const controllerSha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const headSha = "a".repeat(40),
  testedSha = "b".repeat(40);

async function scenario({
  files = ["docs/gate.md"],
  fork = false,
  mode = "initialize" as "initialize" | "begin" | "reset" | "armed" | "finish",
  preflight = "success",
  result = "success",
  incomplete = false,
  moved = false,
  noPrArray = false,
  pullRequests = undefined as ((pr: object) => unknown[]) | undefined,
  wrongLookup = false,
  forged = false,
  freshness = "current",
} = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "autoflow-g5-"));
  const records: Array<Record<string, unknown>> = [];
  const pr = {
    number: 42,
    state: "open",
    changed_files: files.length + Number(incomplete),
    base: { ref: "main", sha: controllerSha },
    head: {
      sha: headSha,
      repo: { full_name: fork ? "other/Auto" : "aalzriqat/Auto" },
    },
  };
  const event =
    mode === "initialize"
      ? { pull_request: pr }
      : {
          workflow_run: {
            id: 1000,
            run_attempt: 1,
            head_sha: headSha,
            conclusion: preflight,
            pull_requests: noPrArray ? [] : (pullRequests ? pullRequests(pr) : [pr]),
          },
        };
  writeFileSync(path.join(directory, "event.json"), JSON.stringify(event));
  writeFileSync(path.join(directory, "summary.md"), "");
  writeFileSync(
    path.join(directory, "evidence.json"),
    JSON.stringify({
      headSha,
      testedSha,
      controllerSha,
      passed: 57,
      total: 57,
      skipped: 0,
      flaky: 0,
      executedDefinitions: ["expenses.spec.ts"],
    }),
  );
  const env = {
    GITHUB_WORKFLOW_SHA: controllerSha,
    GITHUB_REPOSITORY: "aalzriqat/Auto",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_TOKEN: "test-token",
    GITHUB_EVENT_PATH: path.join(directory, "event.json"),
    GITHUB_STEP_SUMMARY: path.join(directory, "summary.md"),
    TESTED_SHA: testedSha,
    EVIDENCE_PATH: path.join(directory, "evidence.json"),
    E2E_RESULT: result,
  };
  const publications: Array<Record<string, unknown>> = [];
  if (forged) {
    records.push({
      id: 99,
      name: "authenticated-pr-e2e",
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
      external_id: "g5:42:99999999:1",
      app: { slug: "github-actions" },
      check_suite: { id: 555 },
    });
  }
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const route = url.pathname;
    let payload: unknown;
    if (init?.method !== "GET" && init?.body)
      publications.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    if (route.endsWith("/actions/runs/123")) {
      if (freshness === "unreadable") throw new Error("unavailable");
      payload = {
        id: 123, run_attempt: freshness === "new-attempt" ? 2 : 1,
        status: freshness === "cancelled" ? "completed" : "in_progress",
        path: freshness === "wrong-workflow" ? ".github/workflows/forge.yml"
          : mode === "initialize" ? ".github/workflows/authenticated-pr-e2e.yml"
          : ".github/workflows/browser-attack-swarm.yml",
        event: mode === "initialize" ? "pull_request_target" : "workflow_run",
        head_branch: "main", repository: { full_name: "aalzriqat/Auto" },
      };
    } else if (route.endsWith("/actions/runs/1000")) {
      payload = {
        id: 1000, workflow_id: 77, run_attempt: freshness === "new-source-attempt" ? 2 : 1,
        event: "pull_request", head_sha: headSha,
        path: ".github/workflows/playwright.yml",
        head_repository: { full_name: "aalzriqat/Auto" },
        status: "completed", conclusion: "success",
      };
    } else if (route.endsWith("/actions/workflows/77/runs")) {
      const page = Number(url.searchParams.get("page"));
      const runs = freshness === "new-source-run" ? [{ id: 1001 }]
        : freshness === "empty-inventory" ? []
        : freshness === "missing-source" ? [{ id: 999 }]
        : freshness === "malformed-inventory" ? undefined
        : freshness === "later-page-new-source" && page === 1
          ? Array.from({ length: 100 }, (_, index) => ({ id: 1000 - index }))
        : freshness === "later-page-new-source" ? [{ id: 1001 }]
        : [{ id: 1000 }];
      payload = {
        workflow_runs: freshness === "duplicate-inventory" ? [{ id: 1000 }, { id: 1000 }] : runs,
        total_count: freshness === "oversized-inventory" ? 1001
          : freshness === "missing-total" ? undefined
          : freshness === "count-mismatch" || freshness === "duplicate-inventory" ? 2
          : freshness === "later-page-new-source" ? 101
          : runs?.length,
      };
    } else if (route.endsWith("/check-runs") && init?.method === "GET")
      payload = { check_runs: records };
    else if (route.endsWith("/check-runs") && init?.method === "POST") {
      const check = {
        id: 99 + records.length,
        app: { slug: "github-actions" },
        check_suite: { id: 110584846427 },
        ...JSON.parse(String(init.body)),
      };
      // API-created checks are attached to an app suite (observed CodeQL),
      // not to the token-holding writer workflow's suite.
      records.push(check);
      payload = check;
    } else if (/\/check-runs\/\d+$/.test(route)) {
      const record = records.find((entry) => route.endsWith(`/check-runs/${entry.id}`));
      Object.assign(record ?? {}, JSON.parse(String(init?.body)));
      payload = record;
    } else if (route.endsWith("/files"))
      payload = files.map((filename) => ({ filename }));
    else if (route.endsWith("/merge"))
      payload = { object: { sha: moved ? "d".repeat(40) : testedSha } };
    else if (route.includes("/commits/"))
      payload = [wrongLookup ? { ...pr, base: { ...pr.base, ref: "release" } } : pr];
    else if (route.endsWith("/pulls/42")) payload = pr;
    else throw new Error("Unexpected API route");
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    if (mode === "finish" || mode === "reset")
      await runGate("begin", env, fakeFetch);
    const verdict: { conclusion: string; reason: string } | undefined =
      await runGate(mode, env, fakeFetch);
    return {
      records,
      publications,
      verdict,
      summary: readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"),
    };
  } finally {
    if (
      path.dirname(directory) !== path.resolve(tmpdir()) ||
      !path.basename(directory).startsWith("autoflow-g5-")
    )
      throw new Error("Unsafe test cleanup path");
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("SCRUM-757 native judge with GitHub API boundary fixtures", () => {
  it.each([false, true])(
    "publishes explicit docs-only success, fork=%s",
    async (fork) => {
      const { records, summary } = await scenario({ fork });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        name: "authenticated-pr-e2e",
        head_sha: headSha,
        conclusion: "success",
      });
      expect(summary).toContain("documentation Markdown only");
      expect(summary).toContain("Main test definitions");
    },
  );
  it.each<NonNullable<Parameters<typeof scenario>[0]>>([
    { files: ["app/page.tsx"], fork: true },
    { files: ["app/page.tsx"] },
    { incomplete: true },
    { files: ["app/page.tsx"], mode: "finish", preflight: "failure" },
    { files: ["app/page.tsx"], mode: "finish", result: "skipped" },
    { files: ["app/page.tsx"], mode: "finish", moved: true },
  ])(
    "publishes failure when execution or scope cannot be certified: %j",
    async (options) => {
      const { records } = await scenario(options);
      expect(records).toHaveLength(1);
      expect(records[0].conclusion).toBe("failure");
    },
  );
  it("binds the successful consumer result and full counts to the PR head", async () => {
    const { records, summary } = await scenario({
      files: ["app/page.tsx", "playwright/tests/new.spec.ts"],
      mode: "finish",
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      head_sha: headSha,
      conclusion: "success",
    });
    expect(summary).toContain("57/57");
    expect(summary).toContain(testedSha);
    expect(summary).toContain("playwright/tests/new.spec.ts");
  });
  it("resolves a same-repository PR through the commit lookup when workflow_run.pull_requests is empty", async () => {
    const { records } = await scenario({ mode: "finish", noPrArray: true });
    expect(records[0]).toMatchObject({
      head_sha: headSha,
      conclusion: "success",
    });
  });

  it("takes the pull_requests entry that targets main at the reported head, never the first entry", async () => {
    const wrongBase = {
      number: 41,
      base: { ref: "release", sha: controllerSha },
      head: { sha: headSha },
    };
    const wrongHead = {
      number: 40,
      base: { ref: "main", sha: controllerSha },
      head: { sha: "c".repeat(40) },
    };
    const { records, summary } = await scenario({
      mode: "finish",
      pullRequests: (pr) => [wrongBase, wrongHead, pr],
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ head_sha: headSha });
    expect(records[0].external_id).toContain("g5:42:");
    expect(summary).toContain(headSha);
  });

  it("refuses to publish for a PR identity it cannot pin to main and the reported head", async () => {
    await expect(
      scenario({
        mode: "finish",
        noPrArray: true,
        // The commit lookup is the last resort and finds a PR into another base.
        wrongLookup: true,
      }),
    ).rejects.toThrow("Exact triggering PR identity unavailable.");
  });

  it.each(["initialize", "begin", "reset", "finish"] as const)(
    "turns a forged success under the gate name into failure in %s mode instead of leaving it",
    async (mode) => {
      const { records, verdict } = await scenario({
        files: ["app/page.tsx"],
        result: "failure",
        mode,
        forged: true,
      });
      expect(records.map((record) => record.conclusion)).not.toContain(
        "success",
      );
      expect(records).toHaveLength(1);
      if (mode === "initialize" || mode === "finish")
        expect(verdict?.conclusion).toBe("failure");
      else expect(verdict).toBeUndefined();
    },
  );

  // Replaces marker-based ordering regressions with authoritative Actions data:
  // late success from an older source run, source attempt or consumer attempt.
  it.each(["new-source-run", "new-source-attempt", "new-attempt", "cancelled", "wrong-workflow", "unreadable",
    "empty-inventory", "missing-source", "malformed-inventory", "later-page-new-source",
    "oversized-inventory", "missing-total", "count-mismatch", "duplicate-inventory"])(
    "revokes a standing success and refuses a stale consumer: %s", async (freshness) => {
      const { records, verdict, publications } = await scenario({
        mode: "finish", files: ["app/page.tsx"], forged: true, freshness,
      });
      expect(verdict?.conclusion).toBe("failure");
      expect(records).toHaveLength(1);
      expect(records[0].conclusion).toBe("failure");
      expect(publications.some((body) => body.conclusion === "success")).toBe(false);
    },
  );

  it("refuses to arm a job while a success stands and allows it once the gate is red", async () => {
    const standing = await scenario({ mode: "armed", forged: true });
    expect(standing.verdict?.conclusion).toBe("failure");
    expect(standing.verdict?.reason).toContain("Re-run all jobs");
    const red = await scenario({ mode: "armed" });
    expect(red.verdict).toBeUndefined();
    expect(red.records).toHaveLength(0);
  });

  it("resets an existing record to failure without scope I/O", async () => {
    const { records, verdict } = await scenario({
      files: ["docs/gate.md"],
      mode: "reset",
    });
    expect(verdict).toBeUndefined();
    expect(records).toHaveLength(1);
    expect(records[0].conclusion).toBe("failure");
  });
  it("starts git by a fixed absolute path, never a bare name resolved through PATH (Sonar S4036)", () => {
    const source = readFileSync(
      new URL("./trustedPrE2eGateCli.mjs", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/execFileSync\(\s*"git"/);
    expect(source).toContain("resolveGit");
  });
});
