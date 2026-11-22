// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const read = (name: string) => parse(readFileSync(`.github/workflows/${name}`, "utf8"));
const jobsWithSteps = z.array(z.object({ steps: z.array(z.object({
  uses: z.string().optional(), with: z.record(z.string(), z.unknown()).optional(),
}).passthrough()) }).passthrough());

it("releases the PR runner without polling once its base supports completion events", () => {
  const workflow = read("scenario-runner.yml");
  const admission = workflow.jobs["verify-browser-replays"];
  const detect = admission.steps.find((step: { id?: string }) => step.id === "available");
  const fixture = mkdtempSync(path.join(tmpdir(), "scenario-admission-"));
  try {
    mkdirSync(path.join(fixture, "scripts/regression"), { recursive: true });
    for (const file of ["scenarioCompletionCli.mjs", "verifyHostedBrowserReplays.mjs", "prScenarioEvidenceCli.mjs"]) {
      writeFileSync(path.join(fixture, "scripts/regression", file), "");
    }
    const output = path.join(fixture, "output");
    const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
    execFileSync(bash, ["-e", "-c", detect.run], {
      cwd: fixture,
      env: { NODE_ENV: "test", GITHUB_OUTPUT: output },
    });
    const emitted = readFileSync(output, "utf8").trim().split("\n");
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
  const workflow = read("scenario-completion.yml");
  expect(workflow.on.workflow_run.workflows).toEqual(["PR scenario runner", "Trusted Browser Attack Swarm"]);
  expect(workflow.on.workflow_run.types).toEqual(["requested", "in_progress", "completed"]);
  expect(workflow.on.pull_request_target.types).toEqual(["opened", "reopened", "synchronize", "ready_for_review", "converted_to_draft"]);
  expect(workflow.permissions).toEqual({});
  expect(workflow.jobs.resolve.permissions).toEqual({ contents: "read", actions: "read", checks: "read", "pull-requests": "read" });
  const verify = workflow.jobs.verify;
  expect(verify["timeout-minutes"]).toBeLessThanOrEqual(10);
  expect(verify.concurrency).toEqual({ group: "pr-scenario-verdict-${{ matrix.prNumber }}", "cancel-in-progress": false });
  expect(verify.permissions).toEqual({ contents: "read", actions: "read", checks: "write", "pull-requests": "read" });
  for (const job of jobsWithSteps.parse(Object.values(workflow.jobs))) {
    const checkout = job.steps.find(step => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with).toMatchObject({ ref: "${{ github.workflow_sha }}", "persist-credentials": false });
    expect(JSON.stringify(job)).not.toMatch(/secrets\.|actions\/cache|"cache"\s*:/);
  }
});

it("preserves the protected producer's reset before it admits candidate execution", () => {
  const workflow = read("browser-attack-swarm.yml");
  expect(workflow.jobs.prepare.needs).toBe("e2e-gate-begin");
  expect(workflow.jobs["e2e-gate-begin"].steps.some((step: { run?: string }) =>
    step.run === "node scripts/intelligence/trustedPrE2eGateCli.mjs begin")).toBe(true);
  const steps = workflow.jobs.prepare.steps;
  const armed = steps.findIndex((step: { run?: string }) => step.run === "node scripts/intelligence/trustedPrE2eGateCli.mjs armed");
  const candidate = steps.findIndex((step: { id?: string }) => step.id === "provenance");
  expect(armed).toBeGreaterThanOrEqual(0);
  expect(candidate).toBeGreaterThan(armed);
});
