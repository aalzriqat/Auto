/**
 * SCRUM-892 owner ruling c24441: the pull-request AND the release rehearsal
 * (repository_dispatch `autoflow-release-accounting-rehearsal`) run on the
 * runner-local self-hosted Convex backend. No cloud preview is created.
 *
 * These tests pin that in trusted-accounting-rehearsal.yml:
 * - the release refusals are byte-identical to origin/main at 0cc1f805 (before
 *   this change): the dispatch preflight, the provenance step (requested SHA =
 *   live main = workflow SHA = event SHA), the release verdict job and its name;
 * - both events run one local lifecycle, with the mark/verify tripwire around
 *   the cases and an unconditional stop;
 * - no step creates, pins or deletes a cloud preview or reads a cloud Convex
 *   credential.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

type Step = { id?: string; name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string> };
type Job = { name?: string; if?: string; env?: unknown; outputs?: unknown; permissions?: unknown; steps?: Step[] };
const source = readFileSync(".github/workflows/trusted-accounting-rehearsal.yml", "utf8");
const workflow = parse(source) as { on: Record<string, unknown>; concurrency: unknown; jobs: Record<string, Job> };
const rehearsal = workflow.jobs.rehearsal ?? {};
const steps = rehearsal.steps ?? [];
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Both events: a dispatch always runs, a pull request only when backend inputs changed.
const RUN_IF =
  "steps.provenance.outputs.stale == 'false' && (github.event_name == 'repository_dispatch' || steps.backend_inputs.outputs.run_rehearsal == 'true')";
const localStart = steps.findIndex((step) => step.name === "Start the local Convex backend");
const localSteps = steps.slice(Math.max(localStart, 0)).filter((step) => step.if === RUN_IF || step.if === "always()");

describe("the release refusals are unchanged", () => {
  // Each hash is the same projection of origin/main 0cc1f805's copy of this workflow.
  test("the dispatch preflight that decides the release check name", () => {
    expect(sha256(workflow.jobs.dispatch_preflight)).toBe("3eacea806bcf2f60df5a4ce733c2b17fc5fa7dfe6c585f71d8569c955a72607d");
  });

  test("the provenance step: requested SHA = live main = workflow SHA = event SHA", () => {
    expect(sha256(steps.find((step) => step.id === "provenance"))).toBe(
      "489c9d6e396c17989f63865a61ae961cbb758c27e2bc1a5ccd6abe3a151ac246",
    );
  });

  test("the release verdict job, apart from its step's display name", () => {
    const job = workflow.jobs.release_verdict ?? {};
    expect(sha256({ ...job, steps: (job.steps ?? []).map(({ name: _name, ...rest }) => rest) })).toBe(
      "8a65a7b63e85c3d9f911b81a3672d7660f904f9730d84515400ea7e4d871f2ff",
    );
  });

  test("the rehearsal job's trigger, environment, outputs and permissions, and the concurrency group", () => {
    const { name, if: jobIf, env, outputs, permissions } = rehearsal;
    expect(sha256({ name, if: jobIf, env, outputs, permissions })).toBe(
      "6c28728a0670ad0440b117aae2e1298ef3234822b59a54486510f11a52b5ef23",
    );
    expect(sha256(workflow.concurrency)).toBe("9b8ab89a641f707f48cb6c524f8aa41d8e19d68e940c72695233668916e184ae");
  });

  test("the producer-bound check names and the release trigger", () => {
    expect(workflow.on).toHaveProperty("repository_dispatch", { types: ["autoflow-release-accounting-rehearsal"] });
    expect(rehearsal.name).toBe("trusted-accounting-rehearsal");
    expect(workflow.jobs.verdict?.name).toBe("trusted-accounting-rehearsal-verdict");
    expect(workflow.jobs.release_verdict?.name).toBe(
      "${{ (github.event_name == 'repository_dispatch' && needs.dispatch_preflight.outputs.exact_sha == 'true') && 'trusted-accounting-release-verdict' || 'trusted-accounting-release-not-dispatched' }}",
    );
  });
});

describe("both events run the same local lifecycle", () => {
  test("its steps run for the release and for a changed pull request, in order, with the tripwire around the cases", () => {
    expect(localSteps.map((step) => step.name)).toEqual([
      "Start the local Convex backend",
      "Set and verify the local backend environment allowlist before candidate execution",
      "Stage exact candidate backend as data",
      "Audit staged backend inputs without credentials",
      "Deploy staged candidate backend with trusted Convex CLI",
      "Mint the disposable-preview marker with the trusted CLI",
      "Seed synthetic QA dealership on the local backend from trusted main",
      "Run local accounting rehearsal from trusted main",
      "Verify the local backend was not changed during the run",
      "Refuse incomplete or wrong-target local evidence",
      "Stop the local Convex backend",
    ]);
  });

  // PR #760 Seat 1: the tripwire could be switched off without a red test,
  // by `continue-on-error` on verify or by a verify `if` that never fires.
  // `mark` cannot be unconditional here, because a pull request that changes
  // no backend input starts no backend; it carries the exact run condition.
  test("mark and verify run under exactly the run condition, found by their commands", () => {
    const byRun = (command: string) => steps.filter((step) => step.run === command);
    const mark = byRun("node scripts/localConvexBackend.mjs mark");
    const verify = byRun("node scripts/localConvexBackend.mjs verify");
    expect(mark).toHaveLength(1);
    expect(verify).toHaveLength(1);
    expect(mark[0]?.if).toBe(RUN_IF);
    expect(verify[0]?.if).toBe(RUN_IF);
  });

  test("no local step before the stop, and not the job, may continue on error", () => {
    expect(rehearsal).not.toHaveProperty("continue-on-error");
    const guarded = steps.slice(localStart, -1);
    expect(guarded.map((step) => step.run)).toContain("node scripts/localConvexBackend.mjs verify");
    for (const step of guarded) expect(step, String(step.name)).not.toHaveProperty("continue-on-error");
  });

  // PR #760 Seat 2: the class is "a key that turns a red tripwire green". It is
  // closed by mechanism: every workflow, job and step key must be on an
  // allowlist (.strict()), so a new key fails here before anyone reasons about
  // it. The table names each known key and the assertion that covers it.
  //
  // | key that can turn red into green            | covered by                                   |
  // |---------------------------------------------|----------------------------------------------|
  // | step `continue-on-error`                    | strict step schema; mark/verify pinned whole |
  // | job `continue-on-error`                     | strict job schema                            |
  // | step `shell` (e.g. `bash ... ; exit 0`)     | strict step schema; mark/verify pinned whole |
  // | job `defaults.run.shell`                    | strict job schema                            |
  // | workflow `defaults.run.shell`               | strict workflow schema                       |
  // | verify `if` that never fires                | mark/verify pinned whole; lifecycle order    |
  // | verify `run` that swallows the exit code    | mark/verify pinned whole                     |
  // | verify `working-directory` outside trusted/ | mark/verify pinned whole                     |
  // | `timeout-minutes` (cancel, not success)     | not red-to-green: a timeout fails the job    |
  test("the workflow, every job and every step use only allowlisted keys", () => {
    const stepSchema = z
      .object({
        id: z.string(), name: z.string(), if: z.string(), uses: z.string(), with: z.record(z.string(), z.unknown()),
        run: z.string(), env: z.record(z.string(), z.unknown()), "working-directory": z.string(),
      })
      .partial()
      .strict();
    const jobSchema = z
      .object({
        name: z.string(), needs: z.unknown(), if: z.string(), "runs-on": z.string(), "timeout-minutes": z.number(),
        permissions: z.record(z.string(), z.string()), outputs: z.record(z.string(), z.string()),
        env: z.record(z.string(), z.unknown()), steps: z.array(stepSchema),
      })
      .partial()
      .strict();
    const workflowSchema = z
      .object({
        name: z.string(), on: z.record(z.string(), z.unknown()), permissions: z.record(z.string(), z.string()),
        concurrency: z.unknown(), jobs: z.record(z.string(), jobSchema),
      })
      .strict();
    const result = workflowSchema.safeParse(parse(source));
    expect(result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)).toEqual([]);
  });

  test("mark and verify are pinned whole: no shell, no continue-on-error, exact if, run and directory", () => {
    const tripwire = {
      if: RUN_IF,
      "working-directory": "trusted",
      env: {
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "${{ secrets.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY }}",
        NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3000",
      },
    };
    expect(steps.find((step) => step.run === "node scripts/localConvexBackend.mjs mark")).toEqual({
      name: "Mint the disposable-preview marker with the trusted CLI",
      run: "node scripts/localConvexBackend.mjs mark",
      ...tripwire,
    });
    expect(steps.find((step) => step.run === "node scripts/localConvexBackend.mjs verify")).toEqual({
      name: "Verify the local backend was not changed during the run",
      run: "node scripts/localConvexBackend.mjs verify",
      ...tripwire,
    });
  });

  test("the stop step runs whatever happened, and is the job's final step", () => {
    expect(steps.at(-1)?.name).toBe("Stop the local Convex backend");
    expect(steps.at(-1)?.if).toBe("always()");
  });

  test("no step after the shared setup is limited to one event", () => {
    const setupEnd = steps.findIndex((step) => step.name === "Install trusted rehearsal dependencies");
    expect(setupEnd).toBeGreaterThan(0);
    const allowed = new Set([RUN_IF, "always() && steps.provenance.outputs.stale == 'false'", "always()"]);
    for (const step of steps.slice(setupEnd + 1)) expect(allowed, String(step.name)).toContain(step.if);
  });

  test("the evidence is validated as local, against the URL the start step exported", () => {
    const check = localSteps.find((step) => step.name === "Refuse incomplete or wrong-target local evidence");
    expect(check?.run).toBe("node scripts/validateAccountingReleaseEvidence.mjs rehearsal-evidence.json");
    expect(check?.env).toEqual({
      EXPECTED_DEPLOYMENT_TYPE: "local",
      EXPECTED_TESTED_SHA: "${{ steps.provenance.outputs.tested_sha }}",
      EXPECTED_PREVIEW_URL: "${{ env.NEXT_PUBLIC_CONVEX_URL }}",
    });
  });

  test("the cases get the local target and no cloud Convex credential", () => {
    const run = localSteps.find((step) => step.name === "Run local accounting rehearsal from trusted main");
    expect(Object.keys(run?.env ?? {}).sort()).toEqual([
      "CLERK_SECRET_KEY", "CONVEX_SELF_HOSTED_ADMIN_KEY", "CONVEX_SELF_HOSTED_URL",
      "E2E_APPROVER_USER", "E2E_LOGIN_USER", "NEXT_PUBLIC_CONVEX_URL",
    ]);
  });
});

describe("no cloud preview remains", () => {
  test.each([
    "--preview-create",
    "previewDeploymentLifecycle",
    "CONVEX_PREVIEW_DEPLOY_KEY",
    "CONVEX_DEPLOY_KEY",
    "CONVEX_PREVIEW_NAME",
    "CONVEX_PREVIEW_URL",
    "CONVEX_PREVIEW_CREATED_AT",
    "convexPreviewAuthority",
  ])("the workflow never names %s", (needle) => {
    expect(source).not.toContain(needle);
  });
});
