// @vitest-environment node
import { readFileSync } from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Step = {
  uses?: string;
  name?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  if?: string;
};
type Job = {
  needs?: string[];
  if?: string;
  permissions?: Record<string, string>;
  steps: Step[];
  concurrency?: { group: string };
};
type Workflow = {
  on: Record<string, { types?: string[]; paths?: unknown }>;
  jobs: Record<string, Job>;
};
const read = (name: string) =>
  parse(readFileSync(`.github/workflows/${name}.yml`, "utf8")) as Workflow;

describe("SCRUM-757 workflow security and coverage wiring", () => {
  it("archives exact backend bytes even when candidate attributes request omission or substitution", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "autoflow-g5-archive-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: directory,
        stdio: "pipe",
        timeout: 10000,
      });
    const shell =
      process.platform === "win32"
        ? "C:/Program Files/Git/bin/bash.exe"
        : "/bin/bash";
    try {
      git("init", "--quiet");
      mkdirSync(path.join(directory, "convex"));
      writeFileSync(
        path.join(directory, ".gitattributes"),
        "convex/omitted.ts export-ignore\nconvex/substituted.ts export-subst\n",
      );
      writeFileSync(
        path.join(directory, "convex/omitted.ts"),
        "exact backend bytes\n",
      );
      writeFileSync(
        path.join(directory, "convex/substituted.ts"),
        "$Format:%H$\n",
      );
      git(
        "add",
        ".gitattributes",
        "convex/omitted.ts",
        "convex/substituted.ts",
      );
      git(
        "-c",
        "user.name=Gate fixture",
        "-c",
        "user.email=gate@example.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      );
      const command = read("browser-attack-swarm").jobs[
        "candidate-source"
      ].steps.find(
        (step) =>
          step.name === "Archive candidate source as data without executing it",
      )?.run;
      expect(command).toBeTypeOf("string");
      const archived = spawnSync(shell, ["-c", String(command)], {
        cwd: directory,
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, RUNNER_TEMP: directory.replaceAll("\\", "/") },
      });
      expect(archived.status, archived.stderr).toBe(0);
      for (const [file, expected] of [
        ["omitted.ts", "exact backend bytes\n"],
        ["substituted.ts", "$Format:%H$\n"],
      ]) {
        const extracted = spawnSync(
          shell,
          ["-c", `tar -xOf candidate-source.tar convex/${file}`],
          { cwd: directory, encoding: "utf8", timeout: 10000 },
        );
        expect(extracted.status, extracted.stderr).toBe(0);
        expect(extracted.stdout).toBe(expected);
      }
    } finally {
      if (
        path.dirname(directory) !== path.resolve(tmpdir()) ||
        !path.basename(directory).startsWith("autoflow-g5-archive-")
      )
        throw new Error("Unsafe archive fixture cleanup path");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never checks out candidate source in jobs that hold reusable credentials", () => {
    const workflow = read("browser-attack-swarm");
    for (const name of ["trusted-e2e", "opening-prepare"]) {
      const job = workflow.jobs[name];
      expect(
        job.steps
          .filter((step) => step.uses?.startsWith("actions/checkout@"))
          .map((step) => step.with?.ref),
      ).toEqual(["${{ github.workflow_sha }}"]);
      expect(job.needs).toContain("candidate-source");
    }
    expect(JSON.stringify(workflow.jobs["candidate-source"])).not.toContain(
      "secrets.",
    );
  });

  it("reports every PR shape without paths filters, including absent preflight and forks", () => {
    const listener = read("authenticated-pr-e2e");
    expect(listener.on.pull_request_target.types).toEqual(
      expect.arrayContaining(["opened", "synchronize", "reopened"]),
    );
    expect(listener.on.pull_request_target.paths).toBeUndefined();
    // An edit of title or body changes nothing the gate judges; a queued
    // finish must not be cancelled by a pending admission in the shared group.
    expect(listener.on.pull_request_target.types).not.toContain("edited");
    expect(listener.jobs.admission.if).toBeUndefined();
    expect(
      listener.jobs.admission.steps.find((step) =>
        step.uses?.startsWith("actions/checkout@"),
      )?.with?.ref,
    ).toBeUndefined();
    const workflow = read("browser-attack-swarm");
    const finish = workflow.jobs["e2e-gate-finish"];
    expect(finish.if).toBe(
      "always() && github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(finish.needs).toContain("trusted-e2e");
    expect(finish.steps.at(-1)?.env?.E2E_RESULT).toBe(
      "${{ needs.trusted-e2e.result }}",
    );
    expect(finish.steps.at(-1)?.if).toBe("always()");
    expect(JSON.stringify(finish)).not.toContain("secrets.");
    // Only the two publishers hold `checks: write`. Jobs that run or feed
    // candidate code hold at most `checks: read` (see the arming test below).
    expect(
      Object.entries(workflow.jobs)
        .filter(([, job]) => job.permissions?.checks === "write")
        .map(([name]) => name)
        .sort(),
    ).toEqual(["e2e-gate-begin", "e2e-gate-finish"]);  });

  it("never works beside a standing success after a job-level rerun that skips e2e-gate-begin", () => {
    // GitHub re-runs the selected job and its dependents, never its ancestors:
    // https://docs.github.com/en/rest/actions/workflow-runs#re-run-a-job-from-a-workflow-run
    const jobs = read("browser-attack-swarm").jobs;
    expect(jobs.prepare.needs).toContain("e2e-gate-begin");
    const firstWork = (name: string, marker: string) => {
      const steps = jobs[name].steps;
      const index = steps.findIndex((step) => step.run?.includes(marker));
      expect(index, name).toBeGreaterThan(-1);
      expect(
        steps
          .slice(0, index)
          .every(
            (step) =>
              step.uses?.startsWith("actions/checkout@") ||
              step.uses?.startsWith("actions/setup-node@"),
          ),
        name,
      ).toBe(true);
      expect(Object.keys(steps[index].env ?? {}), name).toEqual([
        "GITHUB_TOKEN",
      ]);
      expect(JSON.stringify(steps[index]), name).not.toContain("secrets.");
    };
    for (const name of [
      "prepare",
      "candidate-source",
      "candidate-build",
      "trusted-e2e",
    ]) {
      // Least privilege: read-only, so a branch cannot use it to write a check.
      expect(jobs[name].permissions?.checks, name).toBe("read");
      firstWork(name, "trustedPrE2eGateCli.mjs armed");
    }
    // The publisher resets (writes failure) before anything else, so a rerun of
    // finish alone cannot leave the previous success standing.
    firstWork("e2e-gate-finish", "trustedPrE2eGateCli.mjs reset");
  });
  it("serialises publishers per head without the unbounded pull_requests[0] and without a pending-job cancel risk", () => {
    const jobs = read("browser-attack-swarm").jobs;
    const admission = read("authenticated-pr-e2e").jobs.admission;
    expect(jobs["e2e-gate-begin"].concurrency?.group).toBe(
      "g5-publish-${{ github.event.workflow_run.head_sha }}",
    );
    expect(jobs["e2e-gate-finish"].concurrency?.group).toBe(
      jobs["e2e-gate-begin"].concurrency?.group,
    );
    expect(admission.concurrency?.group).toBe(
      "g5-publish-${{ github.event.pull_request.head.sha }}",
    );
  });
  it("guards every workflow_run checkout job with the same-repository condition (Sonar S7631)", () => {
    const jobs = read("browser-attack-swarm").jobs;
    for (const name of ["e2e-gate-begin", "candidate-source", "e2e-gate-finish"])
      expect(jobs[name].if?.replace(/\s+/g, " "), name).toContain(
        "github.event.workflow_run.head_repository.full_name == github.repository",
      );
  });

  it("keeps full assertions and preserves discovery and execution separately from period setup", () => {
    const steps = read("browser-attack-swarm").jobs["trusted-e2e"].steps;
    const discovery = steps.find(
      (step) => step.name === "Discover the full applicable trusted suite",
    );
    const execution = steps.find(
      (step) =>
        step.name === "Run full trusted E2E suite against exact candidate",
    );
    expect(execution?.run).toBe(
      "pnpm exec playwright test --project=chromium --no-deps",
    );
    expect(discovery?.env).toEqual({
      ...execution?.env,
      PLAYWRIGHT_JSON_OUTPUT_FILE: "g5/discovery.json",
    });
    expect(execution?.env?.PLAYWRIGHT_JSON_OUTPUT_FILE).toBe("g5/results.json");
    expect(
      steps.find(
        (step) => step.name === "Verify counted authenticated execution",
      )?.run,
    ).toContain("trustedPrE2eGateCli.mjs evidence");
  });
});
