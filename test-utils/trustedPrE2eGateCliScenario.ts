// Shared GitHub API boundary fixture for the trusted PR gate CLI tests: a
// non-test helper so new scenarios can live in their own file (SOURCE-LINES-MAX).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGate } from "../scripts/intelligence/trustedPrE2eGateCli.mjs";

export const controllerSha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
export const headSha = "a".repeat(40),
  testedSha = "b".repeat(40);

export async function scenario({
  files = ["docs/gate.md"] as readonly string[],
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
  producerPatch = {} as Record<string, unknown>,
  publisherJob = null as unknown,
  envOverride = {} as Record<string, string | undefined>,
  prPatch = {} as Record<string, unknown>,
  artifactPatch = {} as Record<string, unknown>,
  forgedId = 99 as number | string,
  duplicateOnFinish = false,
  listingLag = 0,
  ownReadFails = false,
  calls = [] as string[],
  browserReplay = undefined as unknown,
  financedReplay = undefined as unknown,
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
      ? { pull_request: { ...pr, ...prPatch } }
      : {
          workflow_run: {
            id: 1000,
            run_attempt: 1,
            head_sha: headSha,
            conclusion: preflight,
            pull_requests: noPrArray ? [] : (pullRequests ? pullRequests(pr) : [{ ...pr, ...prPatch }]),
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
      executedDefinitions: [
        "expenses.spec.ts",
        ...(browserReplay ? ["sales.spec.ts"] : []),
        ...(financedReplay ? ["financed-deal-economics.spec.ts"] : []),
      ],
      browserReplay,
      financedReplay,
    }),
  );
  const env = {
    GITHUB_WORKFLOW_SHA: controllerSha,
    GITHUB_REPOSITORY: "aalzriqat/Auto",
    GITHUB_REPOSITORY_ID: "1234",
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_TOKEN: "test-token",
    GITHUB_EVENT_PATH: path.join(directory, "event.json"),
    GITHUB_STEP_SUMMARY: path.join(directory, "summary.md"),
    TESTED_SHA: testedSha,
    EVIDENCE_PATH: path.join(directory, "evidence.json"),
    EVIDENCE_ARTIFACT_ID: "3456",
    E2E_RESULT: result,
    ...envOverride,
  };
  const publications: Array<Record<string, unknown>> = [];
  let lagLeft = 0;
  if (forged) {
    records.push({
      id: forgedId,
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
    calls.push(String(input));
    const url = new URL(String(input));
    const route = url.pathname;
    let payload: unknown;
    if (init?.method !== "GET" && init?.body)
      publications.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    if (route.endsWith("/actions/artifacts/3456")) {
      payload = {
        id: 3456, name: "trusted-g5-evidence-123-1", expired: false,
        workflow_run: {
          id: 123, head_sha: controllerSha, head_branch: "main",
          repository_id: 1234, head_repository_id: 1234,
        },
        ...artifactPatch,
      };
    } else if (route.endsWith("/actions/runs/123")) {
      if (freshness === "unreadable") throw new Error("unavailable");
      payload = {
        id: 123, run_attempt: freshness === "new-attempt" ? 2 : 1,
        status: freshness === "cancelled" ? "completed" : "in_progress",
        path: freshness === "wrong-workflow" ? ".github/workflows/forge.yml"
          : mode === "initialize" ? ".github/workflows/authenticated-pr-e2e.yml"
          : ".github/workflows/browser-attack-swarm.yml",
        event: mode === "initialize" ? "pull_request_target" : "workflow_run",
        head_branch: "main",
        head_sha: freshness === "wrong-controller" ? "f".repeat(40) : controllerSha,
        repository: { full_name: "aalzriqat/Auto" },
        head_repository: { full_name: freshness === "wrong-head-repository" ? "other/Auto" : "aalzriqat/Auto" },
        ...producerPatch,
      };
    } else if (route.endsWith("/actions/jobs/321")) {
      payload = publisherJob;
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
    } else if (route.endsWith("/check-runs") && init?.method === "GET") {
      // GitHub's commit listing lags a fresh POST (SCRUM-990).
      payload = { check_runs: lagLeft > 0 ? (lagLeft--, []) : records };
    } else if (route.endsWith("/check-runs") && init?.method === "POST") {
      lagLeft = listingLag;
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
      // Lookup by id carries no consistency promise either (SCRUM-990 round 2).
      if (ownReadFails && init?.method === "GET") throw new Error("GitHub gate request failed.");
      const record = records.find((entry) => route.endsWith(`/check-runs/${entry.id}`));
      if (init?.body) Object.assign(record ?? {}, JSON.parse(String(init.body)));
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
    if (duplicateOnFinish) records.push({ ...records[0], id: 98 });
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
