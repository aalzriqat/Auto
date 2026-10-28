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
  mode = "initialize",
  preflight = "success",
  result = "success",
  incomplete = false,
  moved = false,
  noPrArray = false,
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
            pull_requests: noPrArray ? [] : [pr],
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
  const fakeFetch: typeof fetch = async (input, init) => {
    const route = new URL(String(input)).pathname;
    let payload: unknown;
    if (route.endsWith("/check-runs") && init?.method === "GET")
      payload = { check_runs: records };
    else if (route.endsWith("/check-runs") && init?.method === "POST") {
      const check = {
        id: 99,
        app: { slug: "github-actions" },
        ...JSON.parse(String(init.body)),
      };
      records.push(check);
      payload = check;
    } else if (route.endsWith("/check-runs/99")) {
      Object.assign(records[0], JSON.parse(String(init?.body)));
      payload = records[0];
    } else if (route.endsWith("/files"))
      payload = files.map((filename) => ({ filename }));
    else if (route.endsWith("/merge"))
      payload = { object: { sha: moved ? "d".repeat(40) : testedSha } };
    else if (route.includes("/commits/")) payload = [pr];
    else if (route.endsWith("/pulls/42")) payload = pr;
    else throw new Error("Unexpected API route");
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    if (mode === "finish") await runGate("begin", env, fakeFetch);
    await runGate(mode, env, fakeFetch);
    return { records, summary: readFileSync(env.GITHUB_STEP_SUMMARY, "utf8") };
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
  it("finds docs-only fork identity when workflow_run has no pull_requests array", async () => {
    const { records } = await scenario({
      fork: true,
      mode: "finish",
      noPrArray: true,
    });
    expect(records[0]).toMatchObject({
      head_sha: headSha,
      conclusion: "success",
    });
  });
});
