/**
 * SCRUM-1025 (B4): the nightly FULL run must not add a second set of
 * release-required check runs to main's tip, must not share a cancelling
 * concurrency group with the push run, and must still run everything and tell
 * somebody when it is red (and say when it recovers).
 * scripts/releaseChecks.mjs and scripts/releaseGuard.ts (resolveObservation)
 * refuse a tip where one required producer+name pair has two results.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

type Workflow = {
  on: Record<string, unknown>;
  concurrency?: { group: string; "cancel-in-progress"?: boolean };
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    { uses?: string; needs?: string | string[]; if?: string; permissions?: Record<string, string>; steps?: { run?: string; env?: Record<string, string> }[] }
  >;
};
const load = (name: string) =>
  parseYaml(fs.readFileSync(path.resolve(__dirname, "..", "..", ".github", "workflows", name), "utf8")) as Workflow;
const tests = load("test.yml");
const nightly = load("nightly-tests.yml");

describe("nightly full run", () => {
  test("Tests itself has no schedule or manual trigger, so main's tip never gets a second suite of required checks", () => {
    expect(Object.keys(tests.on).sort()).toEqual(["pull_request", "push", "workflow_call"]);
    expect(tests.jobs["notify-nightly"]).toBeUndefined();
  });

  test("the nightly is its own workflow that calls Tests unchanged, on a schedule and by hand", () => {
    expect(Object.keys(nightly.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect((nightly.on.schedule as { cron: string }[]).length).toBe(1);
    expect(nightly.jobs.full.uses).toBe("./.github/workflows/test.yml");
    expect(nightly.jobs.full.permissions).toEqual({ contents: "read", actions: "read" });
  });

  test("the concurrency groups cannot cancel each other across events or workflows", () => {
    const testsGroup = tests.concurrency?.group ?? "";
    expect(testsGroup).toContain("github.event_name");
    expect(tests.concurrency?.["cancel-in-progress"]).toBe(true);
    expect(nightly.concurrency?.group).toBe("nightly-tests");
    expect(nightly.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(testsGroup.startsWith("nightly")).toBe(false);
  });

  test("a red or cancelled night opens or updates one issue; a green night comments on and closes it", () => {
    const report = nightly.jobs.report;
    expect(report.needs).toBe("full");
    expect(report.if).toContain("always()");
    expect(report.permissions).toEqual({ issues: "write" });
    const run = report.steps?.[0].run ?? "";
    for (const command of ["gh issue create", "gh issue comment", "gh issue close"]) expect(run).toContain(command);
    expect(run).toContain('"$FULL_RESULT" = "success"');
    expect(report.steps?.[0].env?.FULL_RESULT).toBe("${{ needs.full.result }}");
  });

  test("untrusted values reach the report script through env only", () => {
    const run = nightly.jobs.report.steps?.[0].run ?? "";
    expect(run).not.toContain("${{");
  });
});
