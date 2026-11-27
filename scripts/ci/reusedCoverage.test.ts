/**
 * SCRUM-1025: the docs-only path re-uses the base commit's coverage report. It
 * must find a REAL, unexpired, successful push run on exactly the base commit,
 * and re-stamp it only when the lcov is real; anything else degrades to full.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { findBaseCoverageRun, type GhResponse } from "./selectUnitTests.mjs";
import { restamp, runCli } from "./restampReusedCoverage.mjs";

const BASE = "a".repeat(40);
const MERGE = "b".repeat(40);
const run = (over: Record<string, unknown> = {}) => ({ id: 77, head_sha: BASE, head_branch: "main", conclusion: "success", ...over });
const artifact = (over: Record<string, unknown> = {}) => ({ name: "coverage-report", expired: false, ...over });

function fakeGh(runs: unknown[], artifacts: unknown[]) {
  return ([url]: string[]): GhResponse => (url.includes("/artifacts") ? ({ artifacts } as GhResponse) : ({ workflow_runs: runs } as GhResponse));
}

describe("findBaseCoverageRun", () => {
  const repo = "o/r";

  test("returns the run id of a successful main push run with a live coverage-report", async () => {
    expect(await findBaseCoverageRun({ repo, sha: BASE, gh: fakeGh([run()], [artifact()]) })).toBe("77");
  });

  test.each([
    ["no run", [], [artifact()]],
    ["a run for another sha", [run({ head_sha: "c".repeat(40) })], [artifact()]],
    ["a run on another branch", [run({ head_branch: "feature" })], [artifact()]],
    ["a failed run", [run({ conclusion: "failure" })], [artifact()]],
    ["an expired artifact", [run()], [artifact({ expired: true })]],
    ["no artifact", [run()], []],
    ["an artifact with another name", [run()], [artifact({ name: "coverage-blobs-1" })]],
  ])("refuses %s", async (_label, runs, artifacts) => {
    expect(await findBaseCoverageRun({ repo, sha: BASE, gh: fakeGh(runs, artifacts) })).toBeNull();
  });

  test("refuses a malformed sha or repository without calling the API", async () => {
    const gh = () => {
      throw new Error("must not be called");
    };
    expect(await findBaseCoverageRun({ repo, sha: "main", gh })).toBeNull();
    expect(await findBaseCoverageRun({ repo: "no slash", sha: BASE, gh })).toBeNull();
  });

  test("the request asks for push runs on that exact sha", async () => {
    const urls: string[] = [];
    await findBaseCoverageRun({ repo, sha: BASE, gh: ([u]) => (urls.push(u), { workflow_runs: [] }) });
    expect(urls[0]).toContain(`head_sha=${BASE}`);
    expect(urls[0]).toContain("event=push");
    expect(urls[0]).toContain("status=success");
  });

  test("a later run is tried when the first has no live artifact", async () => {
    const gh = ([url]: string[]): GhResponse => {
      if (!url.includes("/artifacts")) return { workflow_runs: [run({ id: 1 }), run({ id: 2 })] } as GhResponse;
      return { artifacts: url.includes("/runs/1/") ? [] : [artifact()] } as GhResponse;
    };
    expect(await findBaseCoverageRun({ repo: "o/r", sha: BASE, gh })).toBe("2");
  });

  test("a failing lookup propagates, so the caller can fall back to the full suite", async () => {
    const gh = () => {
      throw new Error("api down");
    };
    await expect(findBaseCoverageRun({ repo: "o/r", sha: BASE, gh })).rejects.toThrow("api down");
  });
});

describe("restamp", () => {
  const env = { GITHUB_SHA: MERGE, GITHUB_RUN_ID: "9", GITHUB_REPOSITORY: "o/r", GITHUB_EVENT_NAME: "pull_request" };
  const withDir = (lcov: string | null) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restamp-"));
    if (lcov !== null) fs.writeFileSync(path.join(dir, "lcov.info"), lcov);
    return dir;
  };

  test("stamps this merge and records where the report came from", () => {
    const dir = withDir("SF:lib/a.ts\nDA:1,1\nend_of_record\n");
    restamp({ dir, baseSha: BASE, baseRunId: "77", env });
    expect(fs.readFileSync(path.join(dir, "tested-merge-sha.txt"), "utf8").trim()).toBe(MERGE);
    const provenance = JSON.parse(fs.readFileSync(path.join(dir, "coverage-provenance.json"), "utf8"));
    expect(provenance).toMatchObject({ sha: MERGE, reusedFromSha: BASE, reusedFromRunId: "77", sfRecords: 1, daRecords: 1 });
    expect(provenance.lcovSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each([
    ["a missing lcov.info", null],
    ["an empty lcov.info", ""],
    ["an lcov.info without source records", "TN:\n"],
  ])("refuses %s", (_label, lcov) => {
    expect(() => restamp({ dir: withDir(lcov), baseSha: BASE, baseRunId: "77", env })).toThrow(/lcov/);
  });

  test("refuses malformed identities", () => {
    const dir = withDir("SF:lib/a.ts\n");
    expect(() => restamp({ dir, baseSha: "main", baseRunId: "77", env })).toThrow(/base sha/);
    expect(() => restamp({ dir, baseSha: BASE, baseRunId: "x", env })).toThrow(/run id/);
    expect(() => restamp({ dir, baseSha: BASE, baseRunId: "77", env: { ...env, GITHUB_SHA: "abc" } })).toThrow(/GITHUB_SHA/);
  });
});

describe("runCli", () => {
  const env = { GITHUB_SHA: MERGE };
  const sink = () => {
    const lines: string[] = [];
    return { lines, out: { log: (l: string) => lines.push(`log:${l}`), error: (l: string) => lines.push(`error:${l}`) } };
  };

  test("exit 0 and a stamped directory for a real report", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restamp-cli-"));
    fs.writeFileSync(path.join(dir, "lcov.info"), "SF:lib/a.ts\nDA:1,1\nend_of_record\n");
    const { lines, out } = sink();
    expect(runCli([dir, BASE, "77"], env, out)).toBe(0);
    expect(lines[0]).toContain(`re-stamped for ${MERGE}`);
    expect(fs.readFileSync(path.join(dir, "tested-merge-sha.txt"), "utf8").trim()).toBe(MERGE);
  });

  test("exit 1 with an ::error:: annotation, and nothing stamped, when the report is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restamp-cli-"));
    const { lines, out } = sink();
    expect(runCli([dir, BASE, "77"], env, out)).toBe(1);
    expect(lines).toEqual(["error:::error::re-used coverage has no lcov.info content"]);
    expect(fs.existsSync(path.join(dir, "tested-merge-sha.txt"))).toBe(false);
  });

  test("exit 1 for missing arguments", () => {
    expect(runCli([], env, sink().out)).toBe(1);
  });
});