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
  const runsBySuite = new Map<number, Record<string, unknown>>();
  let writer: Record<string, unknown> = {};
  if (forged) {
    runsBySuite.set(555, {
      id: 9,
      path: ".github/workflows/forge.yml",
      event: "push",
      head_branch: "feature",
    });
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
    if (route.endsWith("/actions/runs")) {
      const run = runsBySuite.get(Number(url.searchParams.get("check_suite_id")));
      payload = {
        workflow_runs: run
          ? [
              {
                ...run,
                check_suite_id: Number(url.searchParams.get("check_suite_id")),
                repository: { full_name: "aalzriqat/Auto" },
              },
            ]
          : [],
      };
    } else if (route.endsWith("/check-runs") && init?.method === "GET")
      payload = { check_runs: records };
    else if (route.endsWith("/check-runs") && init?.method === "POST") {
      const check = {
        id: 99 + records.length,
        app: { slug: "github-actions" },
        check_suite: { id: 7000 + records.length },
        ...JSON.parse(String(init.body)),
      };
      runsBySuite.set(check.check_suite.id, writer);
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
  const swarmWriter = {
    id: 123,
    path: ".github/workflows/browser-attack-swarm.yml",
    event: "workflow_run",
    head_branch: "main",
  };
  const admissionWriter = {
    id: 123,
    path: ".github/workflows/authenticated-pr-e2e.yml",
    event: "pull_request_target",
    head_branch: "feature",
  };
  try {
    let verdict: { conclusion: string; reason: string } | undefined;
    writer = mode === "initialize" ? admissionWriter : swarmWriter;
    if (mode === "finish" || mode === "reset")
      await runGate("begin", env, fakeFetch);
    verdict = await runGate(mode, env, fakeFetch);
    return {
      records,
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
  it.each([
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
        files: ["docs/gate.md"],
        mode,
        forged: true,
      });
      expect(records.map((record) => record.conclusion)).not.toContain(
        "success",
      );
      expect(records).toHaveLength(1);
      expect(verdict?.conclusion).toBe("failure");
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