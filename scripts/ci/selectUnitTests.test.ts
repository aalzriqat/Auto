/**
 * SCRUM-1025: the selector CLI's decision on a real merge commit, with Vitest's
 * `related` and the GitHub API replaced by fakes.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { decide, ghJson, listRelatedChunked, main, type GhResponse } from "./selectUnitTests.mjs";

const CONFIG = `export default { test: { coverage: { include: ["lib/commission.ts"], thresholds: {} } } };\n`;

function mergeRepo(changes: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "select-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd: root, encoding: "utf8" });
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  git("init", "-q", "-b", "main");
  write("vitest.config.ts", CONFIG);
  write("lib/commission.ts", "export const a = 1;\n");
  write("lib/commission.test.ts", "// test\n");
  write("components/Y.tsx", "export const y = 1;\n");
  write("components/Y.test.tsx", "// test\n");
  write("convex/sales.test.ts", "// test\n");
  write("docs/zz-sample-note.md", "plan\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD").trim();
  git("checkout", "-q", "-b", "pr");
  for (const [file, text] of Object.entries(changes)) write(file, text);
  git("add", ".");
  git("commit", "-q", "-m", "change");
  git("checkout", "-q", "main");
  write("unrelated-main-change.txt", "x\n");
  git("add", ".");
  git("commit", "-q", "-m", "main moves");
  git("merge", "-q", "--no-ff", "-m", "merge", "pr");
  return { root, base: git("rev-parse", "HEAD^1").trim(), stale: base };
}

const gh = (runId = 5) => ([url]: string[]): GhResponse =>
  url.includes("/artifacts")
    ? { artifacts: [{ name: "coverage-report", expired: false }] }
    : { workflow_runs: [{ id: runId, head_sha: "", head_branch: "main", conclusion: "success" }] };

describe("listRelatedChunked", () => {
  const candidates = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts"];

  test("unions the hits of every chunk", () => {
    const hits = listRelatedChunked({
      related: ["x.ts"],
      candidates,
      chunkSize: 2,
      probe: ({ candidates: chunk }: { candidates: string[] }) => chunk.filter((f) => f !== "c.test.ts"),
    });
    expect(hits.sort()).toEqual(["a.test.ts", "b.test.ts", "d.test.ts", "e.test.ts"]);
  });

  test("a chunk whose probe fails is bisected, and a suite that still fails is included (it runs)", () => {
    const calls: string[][] = [];
    const hits = listRelatedChunked({
      related: ["x.ts"],
      candidates,
      chunkSize: 5,
      probe: ({ candidates: chunk }: { candidates: string[] }) => {
        calls.push(chunk);
        if (chunk.includes("d.test.ts")) throw new Error("heap exhausted");
        return [];
      },
    });
    expect(hits).toEqual(["d.test.ts"]);
    expect(calls.some((c) => c.length === 1 && c[0] === "d.test.ts")).toBe(true);
  });

  test("when every probe fails, every candidate is included", () => {
    const hits = listRelatedChunked({
      related: ["x.ts"],
      candidates,
      probe: () => {
        throw new Error("no vitest");
      },
    });
    expect(hits.sort()).toEqual(candidates);
  });
});

describe("decide", () => {
  test("a push is always the full suite", async () => {
    const { root } = mergeRepo({ "lib/commission.ts": "export const a = 2;\n" });
    expect((await decide({ root, event: "push", repo: "o/r" })).mode).toBe("full");
  });

  test("a non-merge HEAD is not understood, so it is full", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "select-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    fs.writeFileSync(path.join(root, "a.txt"), "a");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x"], { cwd: root });
    const result = await decide({ root, event: "pull_request", repo: "o/r" });
    expect(result.mode).toBe("full");
    expect(result.reason).toMatch(/two-parent/);
  });

  test("source change: impacted, asking Vitest about the changed file and the threshold file", async () => {
    const { root } = mergeRepo({ "components/Y.tsx": "export const y = 2;\n" });
    let asked: string[] = [];
    const result = await decide({
      root,
      event: "pull_request",
      repo: "o/r",
      listRelated: (files: string[]) => {
        asked = files;
        return ["components/Y.test.tsx"];
      },
    });
    expect(result.mode).toBe("impacted");
    expect(asked.sort()).toEqual(["components/Y.tsx", "lib/commission.ts"]);
    expect(result.files).toEqual(["components/Y.test.tsx", "convex/sales.test.ts"]);
  });

  test("the diff is against the merge's first parent, not a stale base sha", async () => {
    const { root } = mergeRepo({ "components/Y.tsx": "export const y = 2;\n" });
    const result = await decide({ root, event: "pull_request", repo: "o/r", listRelated: () => ["components/Y.test.tsx"] });
    // unrelated-main-change.txt is on main but not in the PR; it must not force full.
    expect(result.mode).toBe("impacted");
  });

  test("shared infrastructure is full", async () => {
    const { root } = mergeRepo({ "vitest.config.ts": CONFIG + "// edit\n" });
    expect((await decide({ root, event: "pull_request", repo: "o/r" })).mode).toBe("full");
  });

  test("a selection error is full", async () => {
    const { root } = mergeRepo({ "components/Y.tsx": "export const y = 2;\n" });
    const result = await decide({
      root,
      event: "pull_request",
      repo: "o/r",
      listRelated: () => {
        throw new Error("boom");
      },
    });
    expect(result.mode).toBe("full");
  });

  test("docs-only with a reusable base run carries the run id and base sha", async () => {
    const { root, base } = mergeRepo({ "docs/zz-sample-note.md": "plan v2\n" });
    const ghFor = ([url]: string[]): GhResponse => {
      const out = gh(9)([url]);
      if (out.workflow_runs) out.workflow_runs[0].head_sha = base;
      return out;
    };
    const result = await decide({ root, event: "pull_request", repo: "o/r", gh: ghFor });
    expect(result).toMatchObject({ mode: "docs-only", baseRunId: "9", baseSha: base });
  });

  test("docs-only without a reusable base run is full; an API error is full too", async () => {
    const { root } = mergeRepo({ "docs/zz-sample-note.md": "plan v2\n" });
    expect((await decide({ root, event: "pull_request", repo: "o/r", gh: () => ({ workflow_runs: [] }) })).mode).toBe("full");
    const broken = () => {
      throw new Error("api down");
    };
    expect((await decide({ root, event: "pull_request", repo: "o/r", gh: broken })).mode).toBe("full");
  });
});

describe("listRelatedChunked with the real Vitest probe", () => {
  test("names the test that imports the changed file and leaves an unrelated one out", () => {
    const hits = listRelatedChunked({
      related: ["lib/commission.ts"],
      candidates: ["lib/commission.test.ts", "lib/colorUtils.test.ts"],
    });
    expect(hits).toEqual(["lib/commission.test.ts"]);
  }, 150_000);
});

describe("ghJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  test("a GET with the job token and the documented GitHub headers", async () => {
    vi.stubEnv("GH_TOKEN", "tok");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await ghJson(["repos/o/r/actions/runs?x=1"])).toEqual({ workflow_runs: [] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; signal: AbortSignal }];
    expect(url).toBe("https://api.github.com/repos/o/r/actions/runs?x=1");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(init.headers.Accept).toBe("application/vnd.github+json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("a non-2xx answer throws without echoing the query string", async () => {
    vi.stubEnv("GH_TOKEN", "tok");
    vi.stubGlobal("fetch", async () => new Response("no", { status: 403 }));
    await expect(ghJson(["repos/o/r/actions/runs?secret=1"])).rejects.toThrow("GitHub GET repos/o/r/actions/runs answered 403");
  });

  test("no token means no request", async () => {
    vi.stubEnv("GH_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(ghJson(["repos/o/r"])).rejects.toThrow("GH_TOKEN is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("main", () => {
  const readOut = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

  test("a push writes mode=full to the file and to GITHUB_OUTPUT", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "select-main-"));
    const githubOutput = path.join(cwd, "gh-output");
    const decision = await main(["--event", "push", "--out", "sel.json"], { GITHUB_OUTPUT: githubOutput }, cwd);
    expect(decision.mode).toBe("full");
    expect(readOut(path.join(cwd, "sel.json")).mode).toBe("full");
    expect(fs.readFileSync(githubOutput, "utf8")).toMatch(/^mode=full\nreason=event 'push'.*\nbase_run_id=\nbase_sha=\n$/);
  });

  test("an undecidable pull request (not a git checkout) is full, never a skip", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "select-main-"));
    const decision = await main(["--event", "pull_request", "--out", "sel.json"], {}, cwd);
    expect(decision.mode).toBe("full");
    expect(decision.reason).toMatch(/^selection failed: /);
    expect(readOut(path.join(cwd, "sel.json")).mode).toBe("full");
  });

  test("a docs-only pull request whose base run cannot be looked up is full (no token, no API)", async () => {
    vi.stubEnv("GH_TOKEN", "");
    const { root } = mergeRepo({ "docs/zz-sample-note.md": "plan v2\n" });
    const decision = await main(["--event", "pull_request", "--out", "sel.json"], { GITHUB_REPOSITORY: "o/r" }, root);
    vi.unstubAllEnvs();
    expect(decision.mode).toBe("full");
    expect(decision.reason).toMatch(/no reusable base coverage report/);
  });

  test("--out is required", async () => {
    await expect(main(["--event", "push"], {}, os.tmpdir())).rejects.toThrow("--out is required");
  });
});

describe("decide: remaining fail-closed edges", () => {
  test("a selection that names a file outside the census is full", async () => {
    const { root } = mergeRepo({ "components/Y.tsx": "export const y = 2;\n" });
    const result = await decide({ root, event: "pull_request", repo: "o/r", listRelated: () => ["components/Ghost.test.tsx"] });
    expect(result.mode).toBe("full");
    expect(result.reason).toMatch(/not in the test census/);
  });

  test("an empty selection for a code change is full", async () => {
    const { root } = mergeRepo({ "components/Y.tsx": "export const y = 2;\n" });
    const result = await decide({ root, event: "pull_request", repo: "o/r", listRelated: () => [] });
    expect(result.mode).toBe("full");
    expect(result.reason).toMatch(/empty/);
  });

  test("a HEAD that is a plain commit on top of the merge is not understood, so it is full", async () => {
    const { root } = mergeRepo({ "components/Y.tsx": "export const y = 2;\n" });
    execFileSync("git", ["rm", "-q", "components/Y.tsx"], { cwd: root }); // also deletes a source file
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "delete"], { cwd: root });
    // HEAD is now a normal commit on top of the merge: not a two-parent merge.
    expect((await decide({ root, event: "pull_request", repo: "o/r" })).mode).toBe("full");
  });
});