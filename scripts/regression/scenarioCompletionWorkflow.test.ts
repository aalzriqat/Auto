// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const job = z.object({
  steps: z.array(z.object({
    id: z.string().optional(),
    run: z.string().optional(),
    uses: z.string().optional(),
    with: z.record(z.string(), z.unknown()).optional(),
  }).passthrough()),
  needs: z.union([z.string(), z.array(z.string())]).optional(),
  permissions: z.record(z.string(), z.string()).optional(),
}).passthrough();
const runnerShape = z.object({ jobs: z.object({
  "verify-browser-replays": job.extend({ outputs: z.record(z.string(), z.string()) }),
  "local-scenarios": job,
  scenarios: job.extend({ name: z.string() }),
}) });
const completionShape = z.object({
  on: z.object({
    workflow_run: z.object({ workflows: z.array(z.string()), types: z.array(z.string()) }),
    pull_request_target: z.object({ types: z.array(z.string()) }),
  }),
  permissions: z.record(z.string(), z.string()),
  jobs: z.object({
    resolve: job,
    verify: job.extend({
      "timeout-minutes": z.number(),
      concurrency: z.record(z.string(), z.union([z.string(), z.boolean()])),
    }),
  }).catchall(job),
});
const browserShape = z.object({ jobs: z.object({ prepare: job, "e2e-gate-begin": job }) });

function read<T>(name: string, shape: z.ZodType<T>): T {
  return shape.parse(parse(readFileSync(`.github/workflows/${name}`, "utf8")));
}

it("releases the PR runner without polling once its base supports completion events", () => {
  const workflow = read("scenario-runner.yml", runnerShape);
  const admission = workflow.jobs["verify-browser-replays"];
  const detect = admission.steps.find(step => step.id === "available");
  if (!detect?.run) throw new Error("The scenario availability step has no command");
  const fixture = mkdtempSync(path.join(tmpdir(), "scenario-admission-"));
  try {
    mkdirSync(path.join(fixture, "scripts/regression"), { recursive: true });
    for (const file of ["scenarioCompletionCli.mjs", "verifyHostedBrowserReplays.mjs", "prScenarioEvidenceCli.mjs"]) {
      writeFileSync(path.join(fixture, "scripts/regression", file), "");
    }
    const output = path.join(fixture, "output");
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
    const flags = (run: string) => {
      writeFileSync(output, "");
      execFileSync(bash, ["-e", "-c", run], {
        cwd: fixture,
        env: { NODE_ENV: "test", GITHUB_OUTPUT: output },
      });
      return readFileSync(output, "utf8").trim().split("\n");
    };
    expect(flags(detect.run)).toEqual(["available=true", "aggregation_available=true"]);
    writeFileSync(path.join(fixture, "scripts/regression/scenarioCompletionCheckUrl.mjs"), "");
    const emitted = flags(detect.run);
    // An absent `available=true` makes every old polling/install step ineligible.
    expect(emitted).toContain("event_driven=true");
    expect(emitted).not.toContain("available=true");
    expect(emitted).not.toContain("aggregation_available=true");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
  expect(admission.outputs.event_driven).toBe("${{ steps.available.outputs.event_driven }}");
  expect(workflow.jobs.scenarios.name).toContain("local-scenario-evidence");
  expect(workflow.jobs.scenarios.name).toContain("pr-scenario-runner");
  expect(workflow.jobs.scenarios.steps[0].run).toContain('"$EVENT_DRIVEN" == true');
  expect(workflow.jobs["local-scenarios"].needs).toBeUndefined();
});

it("wakes the trusted collector on either producer and serializes publication per PR", () => {
  const workflow = read("scenario-completion.yml", completionShape);
  expect(workflow.on.workflow_run.workflows).toEqual(["PR scenario runner", "Trusted Browser Attack Swarm"]);
  expect(workflow.on.workflow_run.types).toEqual(["requested", "in_progress", "completed"]);
  expect(workflow.on.pull_request_target.types).toEqual(["opened", "reopened", "synchronize", "ready_for_review", "converted_to_draft"]);
  expect(workflow.permissions).toEqual({});
  expect(workflow.jobs.resolve.permissions).toEqual({ contents: "read", actions: "read", checks: "read", "pull-requests": "read" });
  const verify = workflow.jobs.verify;
  expect(verify["timeout-minutes"]).toBeLessThanOrEqual(10);
  expect(verify.concurrency).toEqual({ group: "pr-scenario-verdict-${{ matrix.prNumber }}", "cancel-in-progress": false });
  expect(verify.permissions).toEqual({ contents: "read", actions: "read", checks: "write", "pull-requests": "read" });
  for (const configuredJob of Object.values(workflow.jobs)) {
    const checkout = configuredJob.steps[0];
    expect(checkout?.uses).toMatch(/^actions\/checkout@[a-f0-9]{40}$/u);
    expect(checkout?.with).toMatchObject({ "persist-credentials": false });
    expect(checkout?.with).not.toHaveProperty("ref");
    expect(checkout?.with).not.toHaveProperty("repository");
    const provenance = configuredJob.steps[1]?.run;
    expect(provenance).toContain('"$GITHUB_REF" == refs/heads/main');
    expect(provenance).toContain('"$(git rev-parse HEAD)" == "$GITHUB_WORKFLOW_SHA"');
    expect(JSON.stringify(configuredJob)).not.toMatch(/secrets\.|actions\/cache|"cache"\s*:/);
  }
});

it("preserves the protected producer's reset before it admits candidate execution", () => {
  const workflow = read("browser-attack-swarm.yml", browserShape);
  expect(workflow.jobs.prepare.needs).toBe("e2e-gate-begin");
  expect(workflow.jobs["e2e-gate-begin"].steps.some(step =>
    step.run === "node scripts/intelligence/trustedPrE2eGateCli.mjs begin")).toBe(true);
  const steps = workflow.jobs.prepare.steps;
  const armed = steps.findIndex(step => step.run === "node scripts/intelligence/trustedPrE2eGateCli.mjs armed");
  const candidate = steps.findIndex(step => step.id === "provenance");
  expect(armed).toBeGreaterThanOrEqual(0);
  expect(candidate).toBeGreaterThan(armed);
});
