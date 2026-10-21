import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  OFFLINE_SWARM_CLERK_FLAG,
  OFFLINE_SWARM_CLERK_PLACEHOLDER_SECRET,
} from "../../lib/offlineSwarmClerk";
import { EGRESS_EVIDENCE_PATH } from "./browserEgressProofVerify.mjs";

type WorkflowStep = {
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  run?: string;
  shell?: string;
  "working-directory"?: string;
};

type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  outputs?: Record<string, unknown>;
  steps?: WorkflowStep[];
};

type Workflow = {
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
  };
  on?: {
    workflow_run?: {
      workflows?: string[];
      types?: string[];
    };
  };
  permissions?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
};

const workflowPath = path.resolve(
  process.cwd(),
  ".github/workflows/browser-attack-swarm.yml",
);
const workflow = parseYaml(readFileSync(workflowPath, "utf8")) as Workflow;
const playwrightWorkflowSource = readFileSync(
  path.resolve(process.cwd(), ".github/workflows/playwright.yml"),
  "utf8",
);
const playwrightWorkflow = parseYaml(playwrightWorkflowSource) as Workflow;
const trustedMainE2EWorkflowSource = readFileSync(
  path.resolve(process.cwd(), ".github/workflows/trusted-main-e2e.yml"),
  "utf8",
);
const trustedMainE2EWorkflow = parseYaml(trustedMainE2EWorkflowSource) as Workflow;

function job(name: string): WorkflowJob {
  const value = workflow.jobs?.[name];
  if (!value) throw new Error("Missing workflow job " + name);
  return value;
}

function step(jobName: string, stepName: string): WorkflowStep {
  const value = job(jobName).steps?.find((entry) => entry.name === stepName);
  if (!value) throw new Error("Missing workflow step " + jobName + " :: " + stepName);
  return value;
}

function playwrightStep(stepName: string): WorkflowStep {
  const value = playwrightWorkflow.jobs?.playwright?.steps?.find(
    (entry) => entry.name === stepName,
  );
  if (!value) throw new Error("Missing Playwright workflow step :: " + stepName);
  return value;
}

type GroupValue = string | number | boolean | null;

/**
 * Evaluates a `${{ }}` expression (a concurrency group template, or an `if`
 * with the delimiters omitted) against a flat context, for the subset the
 * workflows use: paths, literals, `==`, `!=`, `&&`, `||`, parentheses and
 * format(). `&&`/`||` return an operand, and null, '', 0 and false are falsy,
 * as in GitHub expressions. Paths missing from the context are null. Anything
 * outside that subset throws rather than being skipped.
 *
 * Limitation: GitHub compares strings case-insensitively and coerces mixed
 * types; `==` here compares the exact text, so a case-only difference between
 * two strings would be judged unequal where GitHub judges them equal.
 */
function evaluateGroup(template: string, context: Record<string, GroupValue>): string {
  const expand = template.includes("${{") ? template : "${{" + template + "}}";
  return expand.replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, source: string) => {
    const tokens: string[] = [];
    const lexer =
      /\s*('(?:[^']|'')*'|\|\||&&|==|!=|[(),]|[A-Za-z_][\w.]*(?:\[\d+\](?:\.\w+)*)*|\d+)/y;
    for (let position = 0; position < source.length; position = lexer.lastIndex) {
      lexer.lastIndex = position;
      const match = lexer.exec(source);
      if (!match) {
        const rest = source.slice(position).trim();
        if (rest === "") break;
        throw new Error("Unrecognized expression text: " + rest);
      }
      tokens.push(match[1]);
    }
    let at = 0;
    const truthy = (value: GroupValue) => value !== null && value !== "" && value !== 0 && value !== false;
    const text = (value: GroupValue) => (value === null ? "" : String(value));
    const primary = (): GroupValue => {
      const token = tokens[at++];
      if (token === "(") {
        const inner = or();
        at++;
        return inner;
      }
      if (token.startsWith("'")) return token.slice(1, -1).replace(/''/g, "'");
      if (/^\d+$/.test(token)) return Number(token);
      if (token === "null") return null;
      if (token === "true" || token === "false") return token === "true";
      if (token === "format" && tokens[at] === "(") {
        at++;
        const args: GroupValue[] = [or()];
        while (tokens[at] === ",") {
          at++;
          args.push(or());
        }
        at++;
        return text(args[0]).replace(/\{(\d+)\}/g, (_m, index: string) => text(args[Number(index) + 1] ?? null));
      }
      return token in context ? context[token] : null;
    };
    const equality = (): GroupValue => {
      const left = primary();
      if (tokens[at] === "==" || tokens[at] === "!=") {
        const negate = tokens[at++] === "!=";
        const right = primary();
        return (text(left) === text(right)) !== negate;
      }
      return left;
    };
    const and = (): GroupValue => {
      let value = equality();
      while (tokens[at] === "&&") {
        at++;
        const right = equality();
        value = truthy(value) ? right : value;
      }
      return value;
    };
    const or = (): GroupValue => {
      let value = and();
      while (tokens[at] === "||") {
        at++;
        const right = and();
        value = truthy(value) ? value : right;
      }
      return value;
    };
    const result = or();
    if (at !== tokens.length) throw new Error("Unsupported expression: " + source);
    return text(result);
  });
}

/** A swarm workflow_run event for a qualifying run, with any field overridden. */
function swarmContext(runId: number, overrides: Record<string, GroupValue> = {}): Record<string, GroupValue> {
  return {
    "github.event.workflow_run.event": "pull_request",
    "github.event.workflow_run.conclusion": "success",
    "github.event.workflow_run.head_repository.full_name": "o/r",
    "github.repository": "o/r",
    "github.event.workflow_run.pull_requests[0].number": 510,
    "github.run_id": runId,
    ...overrides,
  };
}

/** Every combination of the event fields the swarm group and `if` read. */
function swarmEventContexts(runId: number): Record<string, GroupValue>[] {
  const contexts: Record<string, GroupValue>[] = [];
  for (const event of ["pull_request", "push", "schedule", null]) {
    for (const conclusion of ["success", "cancelled", "skipped", "failure", null]) {
      for (const headRepository of ["o/r", "fork/r", null]) {
        for (const number of [510, null]) {
          contexts.push(
            swarmContext(runId, {
              "github.event.workflow_run.event": event,
              "github.event.workflow_run.conclusion": conclusion,
              "github.event.workflow_run.head_repository.full_name": headRepository,
              "github.event.workflow_run.pull_requests[0].number": number,
            }),
          );
        }
      }
    }
  }
  return contexts;
}

const CANDIDATE_FORBIDDEN_ENV = [
  "CLERK_SECRET_KEY",
  "CONVEX_DEPLOY_KEY",
  "E2E_LOGIN_USER",
  "E2E_LOGIN_PASSWORD",
  "E2E_LOGIN_VERIFICATION_CODE",
  "E2E_APPROVER_USER",
  "E2E_APPROVER_PASSWORD",
  "GITHUB_TOKEN",
] as const;

describe("SCRUM-350 trusted browser swarm workflow authority", () => {
  it("refuses unexecutable mandatory missions before the preview, the build or E2E is paid for (SCRUM-826)", () => {
    const steps = job("prepare").steps ?? [];
    const names = steps.map((entry) => entry.name);
    const gateName =
      "Refuse mandatory missions without executable handlers before provisioning";
    const gate = step("prepare", gateName);

    expect(gate.run).toContain("pnpm browser-swarm:coverage-gate");
    expect(gate["working-directory"]).toBe("trusted");
    expect(gate.if).toBeUndefined();
    expect(gate.env).toMatchObject({
      BASE_SHA: "${{ steps.provenance.outputs.base_sha }}",
      HEAD_SHA: "${{ github.event.workflow_run.pull_requests[0].head.sha }}",
    });

    const gateIndex = names.indexOf(gateName);
    expect(gateIndex).toBeGreaterThan(
      names.indexOf("Derive mandatory impact from trusted main"),
    );
    for (const later of [
      "Download triggering E2E preview descriptor",
      "Recreate disposable Convex preview from trusted main",
      "Generate bounded Jev browser exploration once",
      "Assemble trusted run and fail closed on unsupported impact",
    ]) {
      expect(names.indexOf(later)).toBeGreaterThan(gateIndex);
    }

    expect(String(step("prepare", "Publish trusted plan evidence").with?.path)).toContain(
      "trusted/artifacts/browser-swarm-coverage.json",
    );
  });

  it("keeps the PR preflight completely free of reusable secret references", () => {
    expect(playwrightWorkflowSource).not.toContain("secrets.");
    expect(playwrightWorkflowSource).not.toContain("CLERK_SECRET_KEY");
    expect(playwrightWorkflowSource).not.toContain("CONVEX_DEPLOY_KEY");
    expect(playwrightWorkflowSource).not.toContain("E2E_LOGIN_PASSWORD");
    expect(playwrightWorkflowSource).not.toContain("E2E_APPROVER_PASSWORD");

    const checkout = playwrightWorkflow.jobs?.playwright?.steps?.find(
      (entry) => String(entry.uses ?? "").startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("keeps credential-backed main E2E off pull_request entirely", () => {
    expect(trustedMainE2EWorkflowSource).toContain("secrets.");
    expect(trustedMainE2EWorkflow.on?.workflow_run).toBeUndefined();
    expect(trustedMainE2EWorkflowSource).not.toMatch(/^\s*pull_request:/m);
    expect(trustedMainE2EWorkflow.jobs?.playwright?.if).toBe(
      "github.ref == 'refs/heads/main'",
    );
  });

  it("sets backend variables on the main E2E preview only after its cleanup pin is recorded", () => {
    const steps = trustedMainE2EWorkflow.jobs?.playwright?.steps ?? [];
    const setter = steps.find((entry) => String(entry.run ?? "").includes("convex env set"));
    expect(setter, "a step that sets the preview's backend variables").toBeDefined();
    // The pin step only warns on failure, so a failed pin must stop the setter
    // here: otherwise the preview is changed while the always() delete step,
    // which needs CONVEX_PREVIEW_CREATED_AT, would skip its cleanup.
    expect(setter?.env).toHaveProperty("CONVEX_PREVIEW_CREATED_AT");
    const run = String(setter?.run ?? "");
    const guard = run.indexOf('if [ -z "${CONVEX_PREVIEW_CREATED_AT:-}" ]');
    expect(guard, "a CONVEX_PREVIEW_CREATED_AT guard in the setter").toBeGreaterThanOrEqual(0);
    // The guard comes before the admin-key claim too, so a failed pin touches the control plane not at all.
    const claim = run.indexOf("resolveConvexPreviewCredentials");
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(claim);
    expect(guard).toBeLessThan(run.indexOf("convex env set"));
    expect(run.slice(guard, run.indexOf("convex env set"))).toContain("exit 1");
    const pinIndex = steps.findIndex((entry) => String(entry.run ?? "").includes("previewDeploymentLifecycle.mjs pin"));
    expect(pinIndex).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf(setter!)).toBeGreaterThan(pinIndex);
  });

  it("runs only as a successful Playwright workflow_run follow-up", () => {
    expect(workflow.on?.workflow_run?.workflows).toEqual([
      "E2E Tests (Playwright)",
    ]);
    expect(workflow.on?.workflow_run?.types).toEqual(["completed"]);

    const prepareIf = String(job("prepare").if ?? "");
    expect(prepareIf).toContain(
      "github.event.workflow_run.event == 'pull_request'",
    );
    expect(prepareIf).toContain(
      "github.event.workflow_run.conclusion == 'success'",
    );
    expect(prepareIf).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );

    const attackIf = String(job("attack-worker").if ?? "");
    expect(attackIf).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
  });

  it("SCRUM-777: a swarm run can never land in the Playwright run's concurrency group", () => {
    expect(playwrightWorkflow.concurrency).toEqual({
      group: "playwright-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": true,
    });
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe(true);

    const playwrightGroup = String(playwrightWorkflow.concurrency?.group);
    const swarmGroup = String(workflow.concurrency?.group);
    const staticPrefix = (group: string) => group.slice(0, group.indexOf("${{"));
    expect(staticPrefix(swarmGroup).length).toBeGreaterThan(0);
    expect(staticPrefix(swarmGroup).startsWith(staticPrefix(playwrightGroup))).toBe(false);
    expect(staticPrefix(playwrightGroup).startsWith(staticPrefix(swarmGroup))).toBe(false);

    // Evaluated, not only compared by prefix: no swarm run, whatever its event,
    // computes a group a Playwright PR run (or its ref fallback) can compute.
    const playwrightGroups = [
      { "github.event.pull_request.number": 510, "github.ref": "refs/pull/510/merge" },
      { "github.event.pull_request.number": null, "github.ref": "refs/heads/work" },
    ].map((context) => evaluateGroup(playwrightGroup, context));
    for (const context of swarmEventContexts(77)) {
      expect(playwrightGroups).not.toContain(evaluateGroup(swarmGroup, context));
    }
  });

  it("SCRUM-777: exactly the runs that can provision share the per-PR group; every other run is alone, so a skipped run cancels nothing", () => {
    const swarmGroup = String(workflow.concurrency?.group);
    const prepareIf = String(job("prepare").if ?? "");

    let provisioning = 0;
    for (const context of swarmEventContexts(77)) {
      const group = evaluateGroup(swarmGroup, context);
      if (evaluateGroup(prepareIf, context) === "true") {
        provisioning += 1;
        expect(group, JSON.stringify(context)).toMatch(/^browser-attack-swarm-pr-\d+$/);
      } else {
        expect(group, JSON.stringify(context)).toBe("browser-attack-swarm-run-77");
      }
    }
    // Guards the drift check against passing because no context qualified.
    expect(provisioning).toBeGreaterThan(0);

    // Two swarms for one PR serialize, so a newer one replaces an older one
    // before it recreates the shared named preview; another PR is independent.
    const groupOf = (runId: number, number: number) =>
      evaluateGroup(
        swarmGroup,
        swarmContext(runId, { "github.event.workflow_run.pull_requests[0].number": number }),
      );
    expect(groupOf(1, 510)).toBe(groupOf(2, 510));
    expect(groupOf(1, 510)).not.toBe(groupOf(2, 511));
  });

  it("SCRUM-777: re-verifies the PR head against the tested head before every step that writes to the preview or attacks", () => {
    const fromPlan = {
      GITHUB_TOKEN: "${{ github.token }}",
      PR_NUMBER: "${{ needs.prepare.outputs.pr_number }}",
      EXPECTED_HEAD_SHA: "${{ needs.prepare.outputs.head_sha }}",
      EXPECTED_TESTED_SHA: "${{ needs.prepare.outputs.tested_sha }}",
    };
    for (const [jobName, stepName, before, env] of [
      [
        "prepare",
        "Refuse a superseded PR head before creating the disposable preview",
        "Recreate disposable Convex preview from trusted main",
        {
          GITHUB_TOKEN: "${{ github.token }}",
          PR_NUMBER: "${{ github.event.workflow_run.pull_requests[0].number }}",
          EXPECTED_HEAD_SHA: "${{ github.event.workflow_run.pull_requests[0].head.sha }}",
          EXPECTED_TESTED_SHA: "${{ steps.provenance.outputs.tested_sha }}",
        },
      ],
      [
        "trusted-e2e",
        "Refuse a superseded PR head before touching the disposable preview",
        "Scrub disposable preview environment before candidate execution",
        fromPlan,
      ],
      [
        "attack-worker",
        "Refuse a superseded PR head before attacking",
        "Execute trusted browser missions",
        fromPlan,
      ],
    ] as const) {
      const names = (job(jobName).steps ?? []).map((entry) => entry.name);
      const check = step(jobName, stepName);
      expect(check.if, jobName).toBeUndefined();
      expect(check["working-directory"], jobName).toBe("trusted");
      expect(check.run, jobName).toContain("node scripts/intelligence/browserSwarmHeadFreshness.mjs");
      expect(check.env, jobName).toEqual(env);
      expect(names.indexOf(stepName), jobName).toBeGreaterThan(-1);
      expect(names.indexOf(stepName), jobName).toBeLessThan(names.indexOf(before));
      // The check reads trusted refs only; it runs after the trusted checkout.
      expect(names.indexOf(stepName), jobName).toBeGreaterThan(
        names.findIndex((name) => String(name).startsWith("Checkout trusted")),
      );
    }

    // prepare's check closes the gap after its one-time provenance fetch: it is
    // the step immediately before the first preview write, with nothing between.
    const prepareNames = (job("prepare").steps ?? []).map((entry) => entry.name);
    const prepareCheck = prepareNames.indexOf(
      "Refuse a superseded PR head before creating the disposable preview",
    );
    expect(prepareNames.indexOf("Recreate disposable Convex preview from trusted main")).toBe(
      prepareCheck + 1,
    );
    expect(prepareCheck).toBeGreaterThan(
      prepareNames.indexOf("Fetch and verify exact PR head and tested merge commit as data only"),
    );
  });

  it("SCRUM-777: the expression evaluator refuses text outside the subset it models", () => {
    expect(() => evaluateGroup("${{ github.run_id ?? 1 }}", {})).toThrow(/Unrecognized/);
    expect(() => evaluateGroup("${{ !github.run_id }}", {})).toThrow(/Unrecognized/);
    expect(evaluateGroup("x-${{ github.a == null || 'b' }}", {})).toBe("x-true");
  });

  it("pins the trusted control plane and executes the exact PR merge commit that produced the preview", () => {
    const trusted = step(
      "prepare",
      "Checkout trusted control plane from immutable workflow revision",
    );
    expect(trusted.uses).toMatch(/^actions\/checkout@/);
    expect(trusted.with?.ref).toBe("${{ github.workflow_sha }}");

    const workerTrusted = step(
      "attack-worker",
      "Checkout trusted browser controller from immutable workflow revision",
    );
    expect(workerTrusted.if).toBe(
      "${{ github.event.workflow_run.head_repository.full_name == github.repository }}",
    );
    expect(workerTrusted.with?.ref).toBe("${{ github.workflow_sha }}");
    expect(workerTrusted.with?.["persist-credentials"]).toBe(false);

    const buildCandidate = step(
      "candidate-build",
      "Checkout exact tested PR merge for the one candidate build",
    );
    expect(buildCandidate.with?.ref).toBe(
      "${{ needs.prepare.outputs.tested_sha }}",
    );
    expect(buildCandidate.with?.["persist-credentials"]).toBe(false);

    expect(
      (job("attack-worker").steps ?? []).some(
        (entry) =>
          entry.name === "Checkout exact tested PR merge as application code",
      ),
    ).toBe(false);

    const fetchAndVerify = step(
      "prepare",
      "Fetch and verify exact PR head and tested merge commit as data only",
    );
    const fetchEnv = fetchAndVerify.env ?? {};
    const fetchRun = String(fetchAndVerify.run ?? "");
    expect(fetchEnv).not.toHaveProperty("EXPECTED_TESTED_SHA");
    expect(fetchRun).toContain("refs/pull/${PR_NUMBER}/merge:refs/autoflow/pr-merge");
    expect(fetchRun).toContain('git merge-base --is-ancestor "$FIRST_PARENT" refs/autoflow/swarm-main');
    expect(fetchRun).toContain('if [ "$live_base_ref" != "main" ]; then');
    expect(fetchRun).toContain("FETCHED_MERGE");
    expect(fetchRun).toContain("FIRST_PARENT");
    expect(fetchRun).toContain("SECOND_PARENT");
    expect(fetchEnv).not.toHaveProperty("EXPECTED_BASE_SHA");
    expect(fetchRun).toContain("EXPECTED_HEAD_SHA");
    expect(fetchRun).toContain("FIRST_PARENT");
    expect(fetchRun).toContain('echo "base_sha=$FIRST_PARENT" >> "$GITHUB_OUTPUT"');
    expect(fetchRun).toContain('echo "TESTED_SHA=$FETCHED_MERGE" >> "$GITHUB_ENV"');

    const plan = step(
      "prepare",
      "Assemble trusted run and fail closed on unsupported impact",
    );
    expect(plan.env).toHaveProperty("TESTED_SHA", "${{ env.TESTED_SHA }}");
  });

  it("reasserts same-repository trust at every privileged downstream job boundary", () => {
    for (const jobName of ["candidate-build", "verdict"]) {
      const condition = String(job(jobName).if ?? "");
      expect(condition).toContain(
        "github.event.workflow_run.event == 'pull_request'",
      );
      expect(condition).toContain(
        "github.event.workflow_run.head_repository.full_name == github.repository",
      );
      expect(condition).toContain(
        "github.event.workflow_run.pull_requests[0].number != null",
      );
    }
  });

  it("builds candidate frontend once with no reusable credentials and reuses only the verified artifact", () => {
    const build = step(
      "candidate-build",
      "Build exact tested candidate once in isolated container",
    );
    const buildEnv = build.env ?? {};
    for (const key of CANDIDATE_FORBIDDEN_ENV) {
      expect(buildEnv).not.toHaveProperty(key);
    }
    expect(buildEnv).toHaveProperty(
      "NEXT_PUBLIC_APP_URL",
      "http://127.0.0.1:3000",
    );
    expect(buildEnv).toHaveProperty(
      "VERCEL_GIT_COMMIT_SHA",
      "${{ needs.prepare.outputs.tested_sha }}",
    );
    expect(buildEnv).toHaveProperty("AUTOFLOW_SWARM_STANDALONE", "1");
    expect(String(build.run ?? "")).toContain("pnpm build");
    expect(String(build.run ?? "")).toContain("--cap-drop ALL");
    expect(String(build.run ?? "")).not.toContain("actions/cache");

    for (const jobName of ["trusted-e2e", "attack-worker"]) {
      const start = step(
        jobName,
        "Start verified exact-SHA candidate frontend artifact",
      );
      const env = start.env ?? {};
      for (const key of CANDIDATE_FORBIDDEN_ENV) {
        expect(env, jobName + " runtime must not receive " + key).not.toHaveProperty(
          key,
        );
      }
      const run = String(start.run ?? "");
      expect(run).toContain(
        "$RUNNER_TEMP/browser-swarm-candidate-build/runtime:/app:ro",
      );
      expect(run).toContain("node server.js");
      expect(run).not.toContain("pnpm install");
      expect(run).not.toContain("pnpm build");
    }

    const source = readFileSync(workflowPath, "utf8");
    expect(
      source.match(/Build exact tested candidate once in isolated container/g) ?? [],
    ).toHaveLength(1);
    expect(source).not.toContain("Build exact candidate frontend in isolated container");
  });

  it("refuses to scrub the swarm preview unless its cleanup pin was recorded", () => {
    const scrub = step(
      "trusted-e2e",
      "Scrub disposable preview environment before candidate execution",
    );
    // The pin step only warns when it fails, and preview-cleanup runs only for a
    // recorded cleanup_preview_created_at. Without it, changing the preview would
    // leave one nothing retires.
    expect(scrub.env?.CONVEX_PREVIEW_CREATED_AT).toBe(
      "${{ needs.prepare.outputs.cleanup_preview_created_at }}",
    );
    const run = String(scrub.run ?? "");
    const guard = run.indexOf('if [ -z "${CONVEX_PREVIEW_CREATED_AT:-}" ]');
    expect(guard, "a CONVEX_PREVIEW_CREATED_AT guard in the scrub step").toBeGreaterThanOrEqual(0);
    expect(run.slice(guard, run.indexOf("fi", guard))).toContain("exit 1");
    const claim = run.indexOf("resolveConvexPreviewCredentials");
    const firstChange = run.indexOf("convex env remove");
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(firstChange).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(claim);
    expect(guard).toBeLessThan(firstChange);

    // The guard is only as good as its source: the output must come from the pin
    // step, and that step must be the one that publishes `preview_created_at`.
    const pinStep = (job("prepare").steps ?? []).find(
      (entry) => entry.name === "Pin the disposable preview for cleanup",
    );
    expect(pinStep?.id).toBe("pin");
    expect(String(pinStep?.run ?? "")).toContain("previewDeploymentLifecycle.mjs pin");
    expect(job("prepare").outputs?.cleanup_preview_created_at).toBe(
      "${{ steps.pin.outputs.preview_created_at }}",
    );
    expect(readFileSync(path.resolve(process.cwd(), "scripts/previewDeploymentLifecycle.mjs"), "utf8")).toContain(
      '[env.GITHUB_OUTPUT, "preview_created_at"]',
    );
  });

  it("scrubs the disposable preview to an explicit non-sensitive environment allowlist before candidate backend execution", () => {
    const trustedSteps = job("trusted-e2e").steps ?? [];
    const scrubIndex = trustedSteps.findIndex(
      (entry) =>
        entry.name ===
        "Scrub disposable preview environment before candidate execution",
    );
    const deployIndex = trustedSteps.findIndex(
      (entry) =>
        entry.name === "Deploy staged candidate backend with trusted Convex CLI",
    );
    expect(scrubIndex).toBeGreaterThanOrEqual(0);
    expect(deployIndex).toBeGreaterThan(scrubIndex);

    const scrub = step(
      "trusted-e2e",
      "Scrub disposable preview environment before candidate execution",
    );
    const run = String(scrub.run ?? "");
    expect(scrub.env).toHaveProperty("CONVEX_PREVIEW_DEPLOY_KEY");
    expect(run).toContain("resolveConvexPreviewCredentials");
    expect(run).toContain("convex env list --names-only");
    expect(run).toContain("convex env remove");
    expect(run).toContain(
      "1x0000000000000000000000000000000AA",
    );
    for (const allowed of [
      "AUTOFLOW_DEPLOYMENT_CLASS",
      "CLERK_DEV_JWT_ISSUER_DOMAIN",
      "CLERK_JWT_ISSUER_DOMAIN",
      "NEXT_PUBLIC_APP_URL",
      "TURNSTILE_SECRET_KEY",
    ]) {
      expect(run).toContain(allowed);
    }
    expect(run).toContain(
      "Disposable preview environment does not match the trusted allowlist.",
    );
    expect(run).toContain('--url "$NEXT_PUBLIC_CONVEX_URL"');
    expect(run).toContain('--admin-key "$ADMIN_KEY"');
  });

  it("deploys the candidate backend only as staged data through the trusted Convex CLI (SCRUM-350)", () => {
    // The claim key is project-wide (run 36114902831), so it never reaches a
    // candidate-controlled install or CLI. Mounts, flags and ordering across
    // every workflow are pinned in convexCredentialBoundary.test.ts.
    const stage = step("trusted-e2e", "Stage exact candidate backend as data");
    expect(JSON.stringify(stage.env ?? {})).not.toContain("secrets.");
    const deploy = step(
      "trusted-e2e",
      "Deploy staged candidate backend with trusted Convex CLI",
    );
    const deployRun = String(deploy.run ?? "");
    expect(deploy.env).toHaveProperty("CONVEX_PREVIEW_DEPLOY_KEY");
    expect(deployRun).toContain("resolveConvexPreviewCredentials");
    expect(deployRun).toContain('"$RUNNER_TEMP/candidate-backend:/app:ro"');
    expect(deployRun).not.toContain("$GITHUB_WORKSPACE/candidate");
    expect(deployRun).not.toMatch(/\bpnpm\b/);
    expect(deployRun).toContain("--typecheck disable");
    expect(deployRun).not.toContain("--env CONVEX_PREVIEW_DEPLOY_KEY");
    expect(deployRun).not.toContain("--env CLERK_SECRET_KEY");
    expect(deployRun).toContain("--cap-drop ALL");
    expect(deployRun).toContain("--security-opt no-new-privileges");
  });

  it("keeps the one candidate build isolated and never gives workers candidate source or a mutable candidate cache", () => {
    const build = step(
      "candidate-build",
      "Build exact tested candidate once in isolated container",
    );
    const buildRun = String(build.run ?? "");
    expect(buildRun).toContain("docker run");
    expect(buildRun).toContain(
      "node:22.21.1-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5",
    );
    // SCRUM-376 F1: the build container is the only writer of its mount, and
    // actions/checkout later runs git on the checkout at job cleanup. The
    // writable mount must therefore be a copy WITHOUT .git, never the checkout.
    expect(buildRun).toContain("$RUNNER_TEMP/candidate-build-src:/app");
    expect(buildRun).not.toContain("$GITHUB_WORKSPACE/candidate");
    expect(buildRun).toContain("--cap-drop ALL");
    expect(buildRun).toContain("--security-opt no-new-privileges");
    // SCRUM-376: --cap-drop ALL removes CAP_DAC_OVERRIDE, so a root container
    // cannot write the runner-owned (uid 1001, 755) bind mount and pnpm dies
    // with EACCES on /app/_tmp_* (exit 243). The build must run as the owner
    // of the mount, and corepack must not write shims into /usr/local/bin.
    // Position and comments matter: a --user after the image name is a
    // container argument, and a comment is not a flag. Inspect only the
    // uncommented docker options that precede the image.
    const dockerOptions = buildRun
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n")
      .replace(/\\\n/g, " ")
      .split(/\s+node:22\./);
    // The image token must exist, or the position guard silently covers nothing.
    expect(dockerOptions.length).toBe(2);
    // docker takes the LAST user flag, so the short form counts too.
    const userFlags = dockerOptions[0].match(/(?:^|\s)(?:--user|-u)(?:=|\s+)("[^"]*"|\S+)/g) ?? [];
    expect(userFlags.map((flag) => flag.trim())).toEqual(['--user "$(id -u):$(id -g)"']);
    const copy = step(
      "candidate-build",
      "Copy candidate source without git metadata for the writable build",
    );
    expect(String(copy.run ?? "")).toContain("rsync -a --exclude=/.git");
    // Opus L2: the copy must share no inode with the checkout, the only mount
    // is the copy, and the copy happens before the build that writes to it.
    expect(String(copy.run ?? "")).not.toMatch(/--link-dest|--hard-links|--copy-links|--inplace|\s-[a-zA-Z]*[HL]/);
    expect(dockerOptions[0].match(/--volume\s+("[^"]*"|\S+)|(?:^|\s)-v\s+("[^"]*"|\S+)/g)?.map((v) => v.replace(/^\s*(--volume|-v)\s+/, ""))).toEqual([
      '"$RUNNER_TEMP/candidate-build-src:/app"',
    ]);
    const buildSteps = workflow.jobs?.["candidate-build"]?.steps ?? [];
    expect(buildSteps.indexOf(copy)).toBeGreaterThanOrEqual(0);
    expect(buildSteps.indexOf(copy)).toBeLessThan(buildSteps.indexOf(build));
    const artifact = step(
      "candidate-build",
      "Stage and hash exact-SHA candidate runtime artifact",
    );
    expect(artifact.env?.CANDIDATE_ROOT).toBe("${{ runner.temp }}/candidate-build-src");
    expect(buildRun).toContain('corepack enable --install-directory "$HOME/bin"');
    expect(buildRun).not.toMatch(/corepack enable\s*(&&|;|\n)/);
    expect(buildRun).not.toContain("/var/run/docker.sock");
    expect(buildRun).not.toContain("$GITHUB_WORKSPACE/trusted");

    const workflowSource = readFileSync(workflowPath, "utf8");
    expect(workflowSource).not.toContain("actions/cache@");
    expect(
      (job("attack-worker").steps ?? []).some((entry) =>
        String(entry.run ?? "").includes("$GITHUB_WORKSPACE/candidate:/app"),
      ),
    ).toBe(false);
  });

  it("publishes one same-run SHA-bound build artifact and every consumer independently verifies it", () => {
    const upload = step(
      "candidate-build",
      "Upload immutable exact-SHA candidate build",
    );
    expect(upload.with?.name).toBe(
      "trusted-candidate-build-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(upload.with?.["include-hidden-files"]).toBe(true);
    expect(upload.with?.["retention-days"]).toBe(1);

    for (const jobName of ["trusted-e2e", "attack-worker"]) {
      const download = step(jobName, "Download immutable exact-SHA candidate build");
      expect(download.uses).toBe(
        "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
      );
      expect(download.with?.["artifact-ids"]).toBe(
        "${{ needs.candidate-build.outputs.artifact_id }}",
      );
      expect(download.with?.path).toBe(
        "${{ runner.temp }}/browser-swarm-candidate-build",
      );

      const verify = step(
        jobName,
        "Independently verify exact-SHA candidate build",
      );
      expect(String(verify.run ?? "")).toContain(
        "browserSwarmBuildArtifact.mjs verify",
      );
      expect(verify.env).toMatchObject({
        TESTED_SHA: "${{ needs.prepare.outputs.tested_sha }}",
        PR_NUMBER: "${{ needs.prepare.outputs.pr_number }}",
        BROWSER_SWARM_RUN_ID:
          "gh-${{ github.run_id }}-${{ github.run_attempt }}",
        CONTROLLER_SHA: "${{ github.workflow_sha }}",
        CONVEX_PREVIEW_NAME: "${{ needs.prepare.outputs.preview_name }}",
        NEXT_PUBLIC_CONVEX_URL:
          "${{ needs.prepare.outputs.convex_cloud_url }}",
      });
    }
  });

  it("spends the paid Jev call only after the disposable preview exists, just before its one consumer (SCRUM-376)", () => {
    // Every failed run between 2026-09-18 and 09-25 paid for a TypeSafe
    // request and then died recreating the preview (Convex deployment quota).
    const names = (job("prepare").steps ?? []).map((entry) => entry.name);
    const jevIndex = names.indexOf("Generate bounded Jev browser exploration once");
    const recreateIndex = names.indexOf("Recreate disposable Convex preview from trusted main");
    const resolveIndex = names.indexOf("Resolve named Convex preview from trusted control plane");
    const assembleIndex = names.indexOf("Assemble trusted run and fail closed on unsupported impact");
    expect(recreateIndex).toBeGreaterThanOrEqual(0);
    expect(resolveIndex).toBeGreaterThan(recreateIndex);
    expect(jevIndex).toBeGreaterThan(resolveIndex);
    expect(assembleIndex).toBe(jevIndex + 1);
  });

  it("calls Jev once in the trusted prepare job and gives workers only sanitized additive suggestions", () => {
    const jev = step(
      "prepare",
      "Generate bounded Jev browser exploration once",
    );
    expect(jev.run).toBe("pnpm browser-swarm:jev-exploration");
    expect(jev.env).toHaveProperty(
      "TYPESAFE_API_KEY",
      "${{ secrets.TYPESAFE_API_KEY }}",
    );
    expect(jev.env).toHaveProperty(
      "TESTED_SHA",
      "${{ steps.provenance.outputs.tested_sha }}",
    );

    const execute = step("attack-worker", "Execute trusted browser missions");
    expect(execute.env).toHaveProperty(
      "BROWSER_SWARM_JEV_SUGGESTIONS_JSON",
      "${{ needs.prepare.outputs.jev_suggestions_json }}",
    );
    expect(execute.env).not.toHaveProperty("TYPESAFE_API_KEY");

    expect(job("candidate-build").needs).toBe("prepare");
    expect(job("attack-worker").needs).toEqual([
      "prepare",
      "candidate-build",
      "trusted-e2e",
    ]);
  });

  it("revalidates the named preview before each worker and exact PR merge again before a success verdict", () => {
    const preview = step(
      "attack-worker",
      "Assert seeded preview from trusted control plane",
    );
    const previewRun = String(preview.run ?? "");
    expect(previewRun).toContain("resolveConvexPreviewAuthority");
    expect(previewRun).toContain(
      "Named preview was recreated underneath this swarm",
    );

    const fresh = step(
      "verdict",
      "Revalidate tested PR merge is still current",
    );
    const freshRun = String(fresh.run ?? "");
    expect(freshRun).toContain("refs/pull/${PR_NUMBER}/head");
    expect(freshRun).toContain("refs/pull/${PR_NUMBER}/merge");
    expect(freshRun).toContain("EXPECTED_HEAD_SHA");
    expect(freshRun).toContain("EXPECTED_TESTED_SHA");

    const verdict = step(
      "verdict",
      "Publish authoritative trusted swarm verdict",
    );
    expect(verdict.env).toHaveProperty(
      "FRESH_CURRENT",
      "${{ steps.freshness.outputs.fresh }}",
    );
    expect(String(verdict.run ?? "")).toContain(
      '[ "$FRESH_CURRENT" = "true" ]',
    );
  });

  it("treats the triggering workflow artifact as untrusted data, never as an extractable filesystem", () => {
    const run = String(
      step("prepare", "Download triggering E2E preview descriptor").run ?? "",
    );

    expect(run).toContain("artifact.size_in_bytes > 16384");
    expect(run).toContain("unzip -Z1");
    expect(run).toContain("unzip -p");
    expect(run).toContain("e2e-preview-descriptor.json");
    expect(run).not.toContain("unzip -q");
    expect(run).not.toMatch(/unzip\s+[^\n]*\s-d\s/);
  });

  it("keeps candidate handoff identity-only and resolves Convex URL from the trusted control plane", () => {
    const descriptor = playwrightStep("Write sanitized preview descriptor");
    expect(descriptor.env).not.toHaveProperty("NEXT_PUBLIC_CONVEX_URL");
    expect(descriptor.env).not.toHaveProperty("CONVEX_DEPLOY_KEY");

    const recreate = step(
      "prepare",
      "Recreate disposable Convex preview from trusted main",
    );
    expect(recreate.env).toHaveProperty("CONVEX_DEPLOY_KEY");
    expect(String(recreate.run ?? "")).toContain("--preview-create");

    const authority = step(
      "prepare",
      "Resolve named Convex preview from trusted control plane",
    );
    expect(authority.run).toContain("convexPreviewAuthority.mjs");
    expect(authority.env).toHaveProperty("CONVEX_PREVIEW_DEPLOY_KEY");
    expect(authority.env).toHaveProperty("PR_NUMBER");

    const publish = step("prepare", "Publish trusted plan evidence");
    expect(String(publish.with?.path ?? "")).toContain(
      "browser-swarm-convex-authority.json",
    );

    const plan = step(
      "prepare",
      "Assemble trusted run and fail closed on unsupported impact",
    );
    expect(plan.env).not.toHaveProperty("NEXT_PUBLIC_CONVEX_URL");
  });

  it("authenticates only on trusted main and never retypes passwords into candidate code", () => {
    const auth = step(
      "attack-worker",
      "Authenticate E2E seats on trusted main frontend",
    );
    const authEnv = auth.env ?? {};
    expect(auth.run).toContain("auth.setup.ts");
    expect(authEnv).toHaveProperty("CLERK_SECRET_KEY");
    expect(authEnv).toHaveProperty("E2E_LOGIN_PASSWORD");
    expect(authEnv).toHaveProperty("E2E_APPROVER_PASSWORD");
    expect(authEnv).toHaveProperty(
      "PLAYWRIGHT_BASE_URL",
      "http://localhost:3000",
    );

    const attest = step(
      "attack-worker",
      "Assert seeded preview from trusted control plane",
    );
    expect(attest.env).toHaveProperty("CONVEX_DEPLOY_KEY");
    expect(attest.env).toHaveProperty("CLERK_SECRET_KEY");
    expect(String(attest.run ?? "")).toContain("--assert-only");
    expect(String(attest.run ?? "")).toContain(
      "BROWSER_SWARM_PREVIEW_ATTESTED=1",
    );

    const execute = step("attack-worker", "Execute trusted browser missions");
    const env = execute.env ?? {};
    expect(execute.run).toContain("--no-deps");
    expect(env).not.toHaveProperty("CONVEX_DEPLOY_KEY");
    expect(env).not.toHaveProperty("CLERK_SECRET_KEY");
    expect(env).not.toHaveProperty("E2E_LOGIN_USER");
    expect(env).not.toHaveProperty("E2E_APPROVER_USER");
    expect(env).toHaveProperty(
      "PLAYWRIGHT_BASE_URL",
      "http://localhost:3000",
    );
    expect(env).toHaveProperty(
      "BROWSER_SWARM_PREVIEW_ATTESTED",
      "${{ env.BROWSER_SWARM_PREVIEW_ATTESTED }}",
    );
    expect(env).toHaveProperty("BROWSER_SWARM_TRUSTED_EXTERNAL_SERVER", "1");
    expect(env).toHaveProperty("PLAYWRIGHT_SKIP_WEBSERVER", "1");
  });

  it("preserves exact candidate auth middleware and gives it only public JWT verification material", () => {
    const resolver = step(
      "attack-worker",
      "Resolve test-only Clerk public JWT verification key",
    );
    const resolverEnv = resolver.env ?? {};
    const resolverRun = String(resolver.run ?? "");
    expect(resolverEnv).toHaveProperty("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
    expect(resolverEnv).not.toHaveProperty("CLERK_SECRET_KEY");
    expect(resolverRun).toContain("pk_test_*");
    expect(resolverRun).not.toContain("sk_test_*");
    expect(resolverRun).toContain("clerkPublicJwtKey.mjs");
    expect(resolverRun).toContain("CLERK_JWT_KEY");

    const allWorkerRun = (job("attack-worker").steps ?? [])
      .map((entry) => String(entry.run ?? ""))
      .join("\n");
    expect(allWorkerRun).not.toContain("candidate/proxy.ts");
    expect(allWorkerRun).not.toContain("candidate/middleware.ts");
    expect(allWorkerRun).not.toContain("candidate/src/proxy.ts");
    expect(allWorkerRun).not.toContain("candidate/src/middleware.ts");

    for (const stepName of [
      "Start verified exact-SHA candidate frontend artifact",
    ]) {
      const candidateStep = step("attack-worker", stepName);
      expect(candidateStep.env ?? {}).not.toHaveProperty("CLERK_SECRET_KEY");
      expect(String(candidateStep.run ?? "")).toContain("--env CLERK_JWT_KEY");
    }
  });

  it("runs the complete Playwright regression suite from trusted main against the exact candidate", () => {
    const run = step(
      "trusted-e2e",
      "Run full trusted E2E suite against exact candidate",
    );
    expect(run.run).toContain("playwright test --project=chromium --no-deps");
    expect(run.env).toHaveProperty("PLAYWRIGHT_SKIP_WEBSERVER", "1");
    expect(run.env).toHaveProperty(
      "NEXT_PUBLIC_CONVEX_URL",
      "${{ needs.prepare.outputs.convex_cloud_url }}",
    );
    expect(run.env).not.toHaveProperty("CLERK_SECRET_KEY");
    expect(run.env).not.toHaveProperty("CONVEX_DEPLOY_KEY");
    expect(run.env).not.toHaveProperty("E2E_LOGIN_PASSWORD");
  });

  it("runs candidate runtime on an internal Docker network and cleans that network up", () => {
    for (const [jobName, stopName] of [
      ["trusted-e2e", "Stop isolated trusted E2E candidate frontend"],
      ["attack-worker", "Stop isolated candidate frontend"],
    ] as const) {
      const startRun = String(
        step(jobName, "Start verified exact-SHA candidate frontend artifact").run ?? "",
      );
      expect(startRun).toContain("docker network create --internal");
      expect(startRun).toContain('--network "$CANDIDATE_NETWORK"');
      expect(startRun).not.toContain("--publish");
      expect(startRun).toContain("--cap-drop ALL");
      expect(startRun).toContain("--security-opt no-new-privileges");
      expect(startRun).toContain('CANDIDATE_DOCKER_IP="$CANDIDATE_IP"');
      expect(startRun).toContain("trusted/scripts/intelligence/browserSwarmLoopbackRelay.mjs");
      expect(startRun).toContain('CANDIDATE_RELAY_PID=$!');

      // The relay target is the candidate's address on ITS OWN named network
      // (a multi-network container would otherwise concatenate addresses).
      const ipLine =
        'CANDIDATE_IP="$(docker inspect --format "{{(index .NetworkSettings.Networks \\"$CANDIDATE_NETWORK\\").IPAddress}}" "$CANDIDATE_CONTAINER")"';
      const dockerRunAt = startRun.indexOf("docker run ");
      const ipAt = startRun.indexOf(ipLine);
      const relayAt = startRun.indexOf("trusted/scripts/intelligence/browserSwarmLoopbackRelay.mjs");
      expect(startRun.split(ipLine).length, jobName).toBe(2);
      expect(dockerRunAt, jobName).toBeGreaterThan(-1);
      expect(ipAt, jobName).toBeGreaterThan(dockerRunAt);
      expect(ipAt, jobName).toBeLessThan(relayAt);
      expect(startRun, jobName).not.toContain("{{range .NetworkSettings.Networks}}");

      // Fail closed if anything already holds port 3000 on v4 or v6 loopback,
      // before the relay is launched (an impostor would otherwise answer
      // /api/health while the relay dies of EADDRINUSE).
      const v4Probe = startRun.indexOf("/dev/tcp/127.0.0.1/3000");
      const v6Probe = startRun.indexOf("/dev/tcp/::1/3000");
      const ssProbe = startRun.indexOf("ss -Hltn 'sport = :3000'");
      for (const probe of [v4Probe, v6Probe, ssProbe]) {
        expect(probe, jobName).toBeGreaterThan(-1);
        expect(probe, jobName).toBeLessThan(relayAt);
      }
      expect(startRun.slice(v4Probe, relayAt), jobName).toContain("exit 1");

      // The relay announces readiness itself; no curl may run before the
      // workflow has seen that line, and relay liveness is checked before curl.
      const readyAt = startRun.indexOf("relay-listening 127.0.0.1:3000");
      const firstCurl = startRun.indexOf("curl ");
      const liveAt = startRun.indexOf('kill -0 "$CANDIDATE_RELAY_PID"');
      expect(readyAt, jobName).toBeGreaterThan(relayAt);
      expect(readyAt, jobName).toBeLessThan(firstCurl);
      expect(liveAt, jobName).toBeGreaterThan(relayAt);
      expect(liveAt, jobName).toBeLessThan(firstCurl);
      // The only health probe is the readiness-gated one.
      const gatedProbe =
        '[ "$RELAY_READY" = "1" ] && curl --fail --silent --show-error http://127.0.0.1:3000/api/health';
      const gatedAt = startRun.indexOf(gatedProbe);
      expect(gatedAt, jobName).toBeGreaterThan(-1);
      expect(startRun.indexOf("/api/health"), jobName).toBeGreaterThan(-1);
      expect(startRun.slice(0, gatedAt), jobName).not.toMatch(/curl[^\n]*\/api\/health/);
      expect(startRun.split(gatedProbe).length, jobName).toBe(2);
      expect(startRun, jobName).toContain("seq 1 60");
      expect(startRun, jobName).toContain("sleep 2");

      const stopRun = String(step(jobName, stopName).run ?? "");
      expect(stopRun).toContain('kill "$CANDIDATE_RELAY_PID"');
      expect(stopRun).toContain('docker network rm "$CANDIDATE_NETWORK"');
    }
  });

  it("keeps a failed candidate runtime observable instead of destroying its logs (SCRUM-376)", () => {
    // `docker run --rm` deleted a crashed candidate along with its stderr, so
    // two different boot failures were diagnosed blind. The container must
    // survive its own death, and the step must print exit state plus logs.
    for (const jobName of ["trusted-e2e", "attack-worker"] as const) {
      const run = String(
        step(jobName, "Start verified exact-SHA candidate frontend artifact")
          .run ?? "",
      );
      // Join backslash continuations so a flag on any line of the command counts.
      const joined = run.replace(/\\\r?\n\s*/g, " ");
      const dockerRun = joined.split("\n").find((line) => /docker run /.test(line));
      expect(dockerRun, jobName).toBeDefined();
      expect(dockerRun, jobName).not.toMatch(/(^|\s)--rm(\s|$)/);
      // A stopped candidate must stop the wait loop immediately.
      expect(run, jobName).toContain("{{.State.Running}}");
      // Diagnostics: exit state, then the LAST bytes of the log (the boot error
      // is at the end), fenced so candidate text cannot be read as runner commands.
      const stop = run.indexOf('echo "::stop-commands::$LOG_FENCE"');
      const inspect = run.indexOf("docker inspect --format 'state=");
      const logs = run.search(/docker logs --tail \d+ "\$CANDIDATE_CONTAINER" 2>&1 \| tail -c \d+/);
      const resume = run.indexOf('echo "::$LOG_FENCE::"');
      expect(run, jobName).toContain("od -An -N16 -tx1 /dev/urandom");
      expect(stop, jobName).toBeGreaterThan(-1);
      expect(stop, jobName).toBeLessThan(inspect);
      expect(inspect, jobName).toBeLessThan(logs);
      expect(logs, jobName).toBeLessThan(resume);
      expect(run, jobName).not.toMatch(/head -c/);
      const stopRun = (workflow.jobs?.[jobName]?.steps ?? [])
        .map((entry) => String(entry.run ?? ""))
        .join("\n");
      expect(stopRun, jobName).toContain('docker rm --force "$CANDIDATE_CONTAINER"');
    }
  });

  it("grants privileged workflow permissions only to the trusted jobs that need them", () => {
    expect(workflow.permissions).toEqual({
      contents: "read",
    });
    expect(job("prepare").permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "read",
      statuses: "write",
    });
    expect(job("candidate-build").permissions).toEqual({
      contents: "read",
    });
    expect(job("trusted-e2e").permissions).toEqual({
      contents: "read",
    });
    expect(job("attack-worker").permissions).toEqual({
      contents: "read",
    });
    expect(job("verdict").permissions).toEqual({
      contents: "read",
      statuses: "write",
    });

    const pending = step(
      "prepare",
      "Mark trusted browser swarm pending on tested merge",
    );
    expect(pending.env).toHaveProperty("GITHUB_TOKEN", "${{ github.token }}");
    expect(String(pending.run ?? "")).toContain(
      "autoflow/trusted-browser-swarm",
    );
    expect(String(pending.run ?? "")).toContain("pending");
    expect(String(pending.run ?? "")).toContain(
      'Content-Type: application/json',
    );

    const verdict = step(
      "verdict",
      "Publish authoritative trusted swarm verdict",
    );
    const verdictRun = String(verdict.run ?? "");
    expect(verdict.env).toHaveProperty("GITHUB_TOKEN", "${{ github.token }}");
    expect(verdict.env).toHaveProperty(
      "TESTED_SHA",
      "${{ needs.prepare.outputs.tested_sha }}",
    );
    expect(verdict.env).toHaveProperty(
      "PREPARE_RESULT",
      "${{ needs.prepare.result }}",
    );
    expect(verdict.env).toHaveProperty(
      "TRUSTED_E2E_RESULT",
      "${{ needs.trusted-e2e.result }}",
    );
    expect(verdict.env).toHaveProperty(
      "ATTACK_RESULT",
      "${{ needs.attack-worker.result }}",
    );
    expect(verdict.env).toHaveProperty(
      "FRESH_CURRENT",
      "${{ steps.freshness.outputs.fresh }}",
    );
    expect(verdictRun).toContain('STATE=failure');
    expect(verdictRun).toContain('[ "$PREPARE_RESULT" = "success" ]');
    expect(verdictRun).toContain('[ "$TRUSTED_E2E_RESULT" = "success" ]');
    expect(verdictRun).toContain('[ "$SHOULD_RUN" = "false" ]');
    expect(verdictRun).toContain(
      '[ "$SHOULD_RUN" = "true" ] && [ "$ATTACK_RESULT" = "success" ]',
    );
    expect(verdictRun).toContain("autoflow/trusted-browser-swarm");
    expect(verdictRun).toContain("Content-Type: application/json");
    expect(verdictRun).toContain('if [ "$STATE" != "success" ]');
  });

  describe("SCRUM-350 G4 offline Clerk candidate", () => {
    const starts = [
      ["trusted-e2e", "Start verified exact-SHA candidate frontend artifact"],
      ["attack-worker", "Start verified exact-SHA candidate frontend artifact"],
    ] as const;

    it.each(starts)(
      "%s starts the candidate with the offline flag and ONLY the public placeholder secret",
      (jobName, stepName) => {
        const candidateStep = step(jobName, stepName);
        const run = String(candidateStep.run ?? "");
        const dockerRun = run.slice(run.indexOf("docker run"), run.indexOf("node server.js"));

        expect(dockerRun).toContain(`--env ${OFFLINE_SWARM_CLERK_FLAG}=1`);
        expect(dockerRun).toContain(
          `--env CLERK_SECRET_KEY=${OFFLINE_SWARM_CLERK_PLACEHOLDER_SECRET}`,
        );
        expect(dockerRun).toContain("--env CLERK_JWT_KEY");

        // The real secret can reach the candidate neither by reference nor by
        // pass-through; the only CLERK_SECRET_KEY it ever sees is the constant.
        expect(run).not.toContain("secrets.CLERK_SECRET_KEY");
        expect(candidateStep.env ?? {}).not.toHaveProperty("CLERK_SECRET_KEY");
        for (const match of run.matchAll(/CLERK_SECRET_KEY\S*/g)) {
          expect(match[0]).toBe(
            `CLERK_SECRET_KEY=${OFFLINE_SWARM_CLERK_PLACEHOLDER_SECRET}`,
          );
        }
        expect(dockerRun).not.toMatch(/--env CLERK_SECRET_KEY(?!=sk_test_autoflow_offline_swarm_placeholder_nonfunctional)/);
      },
    );

    it("keeps the workflow placeholder byte-identical to the one proxy.ts requires", () => {
      expect(OFFLINE_SWARM_CLERK_PLACEHOLDER_SECRET).toBe(
        "sk_test_autoflow_offline_swarm_placeholder_nonfunctional",
      );
    });

    it.each(starts)(
      "%s refuses a candidate whose Clerk-proxied pages answer 5xx while /api/health is green",
      (jobName, stepName) => {
        const run = String(step(jobName, stepName).run ?? "");
        expect(run).toContain("http://127.0.0.1:3000/sign-in");
        expect(run).toContain('-lt 500');
      },
    );
  });

  describe("SCRUM-784 browser egress containment", () => {
    const jobs = [
      ["trusted-e2e", "Run full trusted E2E suite against exact candidate"],
      ["attack-worker", "Execute trusted browser missions"],
    ] as const;

    // G4-02: GitHub's default `bash -e` has no pipefail, so
    // `node proof | tee file` exits 0 when the proof fails. A failed or
    // unavailable proof must stop the job before any authenticated test runs.
    const PROOF_STEP = "Prove browser egress containment before authenticated traffic";

    it.each(jobs)("%s proof step fails closed on a failing or unavailable proof", (jobName) => {
      const proof = step(jobName, PROOF_STEP);
      const run = String(proof.run ?? "");
      expect(run).toMatch(/^\s*set -euo pipefail$/m);
      const lines = run.split("\n").map((line) => line.trim());
      const proofAt = lines.findIndex((line) => line.includes("browserEgressProof.mjs"));
      const verifyAt = lines.findIndex((line) => line.includes("browserEgressProofVerify.mjs"));
      expect(proofAt).toBeGreaterThan(-1);
      // The written evidence is independently checked (ok:true, no collector
      // traffic, allowed origin 200, service worker blocked, denial evidenced).
      expect(verifyAt).toBeGreaterThan(proofAt);
      // SC-1: the verifier accepts only this exact argument, resolved against
      // the step's cwd, so any respelling or cwd change fails every real run.
      expect(lines[verifyAt]).toBe(
        `node scripts/intelligence/browserEgressProofVerify.mjs ${EGRESS_EVIDENCE_PATH}`,
      );
      expect(proof["working-directory"]).toBe("trusted");
      // The proof reads the proxy's fixed-vocabulary denial log.
      expect(proof.env).toHaveProperty(
        "BROWSER_EGRESS_PROXY_LOG",
        "${{ runner.temp }}/browser-egress-proxy.log",
      );
      expect(String(proof.shell ?? "")).not.toMatch(/^(sh|pwsh|powershell|cmd|python)/);
    });

    // G4R2-01: the ORDER of the proxy's per-request lines is a channel the
    // candidate controls (it picks the reason class per denied request), so the
    // raw log must stay on the runner. It is written under RUNNER_TEMP, read by
    // the startup step and the proof, and never printed or uploaded afterwards.
    const RAW_LOG = "browser-egress-proxy.log";
    const EGRESS_JOBS = ["trusted-e2e", "attack-worker"] as const;

    it.each(EGRESS_JOBS)("%s keeps the raw proxy log private to the runner", (jobName) => {
      const steps = job(jobName).steps ?? [];
      const start = steps.findIndex((entry) => entry.name === "Start trusted browser egress proxy");
      const proof = steps.findIndex((entry) => entry.name === PROOF_STEP);

      // The redirect target is under RUNNER_TEMP, not the workspace.
      const startRun = String(steps[start]?.run ?? "");
      expect(startRun).toMatch(/browserEgressContainment\.mjs > "\$RUNNER_TEMP\/browser-egress-proxy\.log" 2>&1 &/);
      expect(startRun).not.toContain("egress-evidence/" + RAW_LOG);

      // Nothing after the proof step mentions the raw log at all, so the
      // stop/cleanup step cannot print it and no later step can read it.
      for (const later of steps.slice(proof + 1)) {
        expect(JSON.stringify(later), `${later.name} references the raw proxy log`).not.toContain(RAW_LOG);
      }

      // No upload from an egress job can carry the log or anything in RUNNER_TEMP.
      const uploads = steps.filter((entry) => String(entry.uses ?? "").startsWith("actions/upload-artifact@"));
      expect(uploads.length).toBeGreaterThan(0);
      for (const upload of uploads) {
        const uploadPath = String(upload.with?.path ?? "");
        expect(uploadPath).not.toMatch(/runner\.temp|RUNNER_TEMP|egress-proxy|\.log\b/i);
        // Every uploaded path is inside the trusted checkout, never an escape
        // such as `${{ github.workspace }}/../_temp/` that names no temp dir.
        for (const line of uploadPath.split("\n").map((l) => l.trim()).filter(Boolean)) {
          expect(line, `${upload.name} uploads ${line}`).toMatch(/^trusted\/(?!.*\.\.)/);
        }
      }
    });

    it("only the startup step and the proof step reference the raw log anywhere in the workflow", () => {
      for (const jobName of EGRESS_JOBS) {
        const referencing = (job(jobName).steps ?? [])
          .filter((entry) => JSON.stringify(entry).includes(RAW_LOG))
          .map((entry) => entry.name);
        expect(referencing).toEqual(["Start trusted browser egress proxy", PROOF_STEP]);
      }
    });

    it("no pipeline in the workflow can mask a failing left-hand command", () => {
      for (const [name, entry] of Object.entries(workflow.jobs ?? {})) {
        for (const stepEntry of entry.steps ?? []) {
          const run = String(stepEntry.run ?? "");
          if (!/\|\s*tee\b/.test(run)) continue;
          const failsClosed =
            /^\s*set -[a-z]*o pipefail\b/m.test(run) || /^bash\b/.test(String(stepEntry.shell ?? ""));
          expect(failsClosed, `${name}: ${stepEntry.name} pipes to tee without pipefail`).toBe(true);
        }
      }
    });

    it.each(jobs)(
      "%s starts and proves the egress proxy before any authenticated candidate browser",
      (jobName, testStepName) => {
        const names = (job(jobName).steps ?? []).map((entry) => entry.name);
        const start = names.indexOf("Start trusted browser egress proxy");
        const proof = names.indexOf("Prove browser egress containment before authenticated traffic");
        const candidate = names.indexOf("Start verified exact-SHA candidate frontend artifact");
        const tests = names.indexOf(testStepName);
        expect(candidate).toBeGreaterThan(-1);
        expect(start).toBeGreaterThan(candidate);
        expect(proof).toBeGreaterThan(start);
        expect(tests).toBeGreaterThan(proof);

        const proxyStep = step(jobName, "Start trusted browser egress proxy");
        const proxyRun = String(proxyStep.run ?? "");
        expect(proxyRun).toContain("browserEgressContainment.mjs");
        expect(proxyRun).toContain("egress-proxy-listening 127.0.0.1:3129");
        expect(proxyRun).toContain("BROWSER_EGRESS_PROXY_SERVER=http://127.0.0.1:3129");
        expect(proxyRun).toContain("BROWSER_EGRESS_REQUIRED=1");
        // Fail closed: the step errors if the proxy dies or never listens.
        expect(proxyRun).toContain("exit 1");
        // The proxy is trusted-main code and holds no secret.
        expect(proxyStep.env ?? {}).not.toHaveProperty("CLERK_SECRET_KEY");
        expect(proxyStep.env ?? {}).not.toHaveProperty("CONVEX_DEPLOY_KEY");

        const proofRun = String(
          step(jobName, "Prove browser egress containment before authenticated traffic").run ?? "",
        );
        expect(proofRun).toContain("browserEgressProof.mjs");
        expect(step(jobName, testStepName).env).toHaveProperty("BROWSER_EGRESS_REQUIRED", "1");
      },
    );

    it.each([
      ["trusted-e2e", "Stop isolated trusted E2E candidate frontend"],
      ["attack-worker", "Stop isolated candidate frontend"],
    ] as const)("%s stops the proxy and uploads its denial log", (jobName, stopName) => {
      expect(String(step(jobName, stopName).run ?? "")).toContain("BROWSER_EGRESS_PROXY_PID");
      const upload = (job(jobName).steps ?? []).find((entry) =>
        String(entry.uses ?? "").startsWith("actions/upload-artifact@"),
      );
      expect(String(upload?.with?.path ?? "")).toContain("trusted/egress-evidence/");
    });
  });
  // SCRUM-826 review F1: playwright.config.ts sets `retries: CI ? 1 : 0` and the
  // swarm worker runs with CI=true. Playwright exits 0 when a retry passes
  // (failOnFlakyTests defaults to false), so a worker whose first attempt
  // confirmed a breach or hit a harness error would still turn the worker job,
  // and autoflow/trusted-browser-swarm, green - and re-run mutating missions
  // against the shared preview, overwriting attempt 1's evidence. Swarm
  // missions are timing-dependent by design (races), so the retry-pass path is
  // reachable. A breach or harness error in ANY attempt must fail the worker.
  describe("a trusted swarm worker never retries (SCRUM-826 F1)", () => {
    // Guards must be live code: a commented-out guard still contains the text.
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const hasRetryPin = (source: string): boolean =>
      /test\.describe\.configure\(\{\s*retries:\s*0\s*\}\)/.test(
        stripComments(source),
      );
    const hasRetryGuard = (source: string): boolean =>
      /if\s*\(\s*testInfo\.retry\s*>\s*0\s*\)\s*\{?\s*throw new Error\(/.test(
        stripComments(source),
      );
    const swarmSpecSource = readFileSync(
      path.resolve(process.cwd(), "playwright/tests/browser-swarm.spec.ts"),
      "utf8",
    );

    it("pins the swarm describe to zero retries independent of the global CI retry policy", () => {
      expect(hasRetryPin(swarmSpecSource)).toBe(true);
    });

    it("throws if the swarm test body ever runs as a retry", () => {
      expect(hasRetryGuard(swarmSpecSource)).toBe(true);
    });

    it("negative control: commented-out guards do not satisfy the contract", () => {
      const pin = "test.describe.configure({ retries: 0 });";
      const guard = 'if (testInfo.retry > 0) { throw new Error("x"); }';
      expect(hasRetryPin(pin)).toBe(true);
      expect(hasRetryGuard(guard)).toBe(true);
      expect(hasRetryPin("// " + pin)).toBe(false);
      expect(hasRetryPin("/* " + pin + " */")).toBe(false);
      expect(hasRetryGuard("// " + guard)).toBe(false);
      expect(hasRetryGuard("/*\n" + guard + "\n*/")).toBe(false);
    });
  });

  // SCRUM-350 G4 (PR #581, run 38529903614): the swarm preview has a chart of
  // accounts and no accounting period, so every posting stayed QUEUED and ACC-2
  // returned HARNESS_ERROR. The period is opened before the full trusted E2E and
  // verified again after it, before any attack worker, never by a worker and
  // never by the bootstrap.
  describe("swarm accounting period setup (SCRUM-350 G4)", () => {
    const SETUP = "Open the swarm accounting period and drain its pending outbox";
    const FULL_SUITE = "Run full trusted E2E suite against exact candidate";
    const STOP = "Stop isolated trusted E2E candidate frontend";
    const SPEC = "playwright/tests/browser-swarm-accounting-period.spec.ts";
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const specSource = stripComments(
      readFileSync(path.resolve(process.cwd(), SPEC), "utf8"),
    );

    it("runs inside trusted-e2e after the full suite and before the candidate is stopped", () => {
      const names = (job("trusted-e2e").steps ?? []).map((entry) => entry.name);
      expect(names.indexOf(FULL_SUITE)).toBeGreaterThan(-1);
      expect(names.indexOf(STOP)).toBeGreaterThan(-1);
      expect(names.indexOf(SETUP)).toBeGreaterThan(names.indexOf(FULL_SUITE));
      expect(names.indexOf(SETUP)).toBeLessThan(names.indexOf(STOP));
    });

    it("cannot be skipped or soft-failed, so a failed setup fails trusted-e2e and blocks every worker", () => {
      const setup = step("trusted-e2e", SETUP);
      expect(setup.if).toBeUndefined();
      expect(setup).not.toHaveProperty("continue-on-error");
      expect(String(job("attack-worker").needs)).toContain("trusted-e2e");
      expect(String(job("attack-worker").if)).toContain(
        "needs.trusted-e2e.result == 'success'",
      );
    });

    it("runs only the setup spec against the already-running candidate with the egress proxy required", () => {
      const setup = step("trusted-e2e", SETUP);
      const run = String(setup.run ?? "").replace(/\s+/g, " ");
      expect(run).toContain(`playwright test ${SPEC} --project=chromium --no-deps`);
      expect(setup["working-directory"]).toBe("trusted");
      expect(setup.env).toMatchObject({
        BROWSER_SWARM_PERIOD_SETUP: "1",
        BROWSER_EGRESS_REQUIRED: "1",
        PLAYWRIGHT_SKIP_WEBSERVER: "1",
        NEXT_PUBLIC_CONVEX_URL: "${{ needs.prepare.outputs.convex_cloud_url }}",
      });
      for (const forbidden of CANDIDATE_FORBIDDEN_ENV) {
        expect(setup.env, forbidden).not.toHaveProperty(forbidden);
      }
    });

    it("writes its own report and results so the full suite's evidence is not erased, and uploads both", () => {
      const setup = step("trusted-e2e", SETUP);
      expect(String(setup.run ?? "").replace(/\s+/g, " ")).toContain(
        "--output=test-results-swarm-period",
      );
      expect(setup.env).toHaveProperty("PLAYWRIGHT_HTML_REPORT", "playwright-report-swarm-period");
      const upload = (job("trusted-e2e").steps ?? []).find(
        (entry) => entry.name === "Upload trusted E2E report",
      );
      const uploaded = String(upload?.with?.path ?? "");
      expect(uploaded).toContain("trusted/playwright-report-swarm-period/");
      expect(uploaded).toContain("trusted/test-results-swarm-period/");
      expect(upload?.if).toBe("always()");
    });

    // SCRUM-411: finance PR #585 run 38693332010 ran main's financed-deal spec
    // against the candidate; 33/34 passed but the deal could not close because
    // HANDOVER_PERIOD_OPEN was "Needs action". The period must already be open
    // when the full suite starts, and is still re-verified after it.
    describe("period established before the full suite (SCRUM-411)", () => {
      const PRE = "Establish the open accounting period before the full trusted E2E suite";
      const EGRESS_PROOF = "Prove browser egress containment before authenticated traffic";
      const names = (job("trusted-e2e").steps ?? []).map((entry) => entry.name);
      const outputOf = (run: unknown): string | undefined =>
        /--output=(\S+)/.exec(String(run ?? ""))?.[1];

      it("runs after egress proof and before the full suite, unskippable", () => {
        const proof = names.indexOf(EGRESS_PROOF);
        expect(proof).toBeGreaterThan(-1);
        expect(names.indexOf(PRE)).toBeGreaterThan(proof);
        expect(names.indexOf(PRE)).toBeLessThan(names.indexOf(FULL_SUITE));
        const pre = step("trusted-e2e", PRE);
        expect(pre.if).toBeUndefined();
        expect(pre).not.toHaveProperty("continue-on-error");
      });

      it("uses the same setup spec and env but its own report and results, and uploads both", () => {
        const pre = step("trusted-e2e", PRE);
        const post = step("trusted-e2e", SETUP);
        const run = String(pre.run ?? "").replace(/\s+/g, " ");
        expect(run).toContain(`playwright test ${SPEC} --project=chromium --no-deps`);
        expect(outputOf(pre.run)).toBe("test-results-swarm-period-pre");
        expect(outputOf(post.run)).toBe("test-results-swarm-period");
        expect(outputOf(pre.run)).not.toBe(outputOf(post.run));
        expect(pre["working-directory"]).toBe("trusted");
        expect(pre.env).toMatchObject({
          BROWSER_SWARM_PERIOD_SETUP: "1",
          BROWSER_EGRESS_REQUIRED: "1",
          PLAYWRIGHT_SKIP_WEBSERVER: "1",
          NEXT_PUBLIC_CONVEX_URL: "${{ needs.prepare.outputs.convex_cloud_url }}",
          PLAYWRIGHT_HTML_REPORT: "playwright-report-swarm-period-pre",
        });
        for (const forbidden of CANDIDATE_FORBIDDEN_ENV) {
          expect(pre.env, forbidden).not.toHaveProperty(forbidden);
        }
        const upload = (job("trusted-e2e").steps ?? []).find(
          (entry) => entry.name === "Upload trusted E2E report",
        );
        const uploaded = String(upload?.with?.path ?? "");
        expect(uploaded).toContain("trusted/playwright-report-swarm-period-pre/");
        expect(uploaded).toContain("trusted/test-results-swarm-period-pre/");
      });
    });

    it("is never run by an attack worker or the ordinary PR E2E workflow", () => {
      for (const entry of job("attack-worker").steps ?? []) {
        const text = JSON.stringify(entry);
        expect(text, String(entry.name)).not.toContain("browser-swarm-accounting-period");
        expect(text, String(entry.name)).not.toContain("BROWSER_SWARM_PERIOD_SETUP");
      }
      expect(playwrightWorkflowSource).not.toContain("BROWSER_SWARM_PERIOD_SETUP");
    });

    it("registers its test only on the workflow's opt-in, never retries, and judges through the module", () => {
      expect(specSource).toMatch(
        /if\s*\(\s*process\.env\[SWARM_PERIOD_SETUP_FLAG\]\s*===\s*"1"\s*\)/,
      );
      expect(specSource).toMatch(/test\.describe\.configure\(\{\s*retries:\s*0\s*\}\)/);
      expect(specSource).toMatch(
        /if\s*\(\s*testInfo\.retry\s*>\s*0\s*\)\s*\{?\s*throw new Error\(/,
      );
      expect(specSource).toContain("assertSwarmPeriodSetupEnvironment(process.env)");
      expect(specSource).toContain("ensureSwarmAccountingPeriod(client, orgId)");
    });

    it("is part of the test:browser-swarm gate that CI runs", () => {
      const scripts = (
        JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
          scripts: Record<string, string>;
        }
      ).scripts;
      expect(scripts["test:browser-swarm"]).toContain(
        "scripts/intelligence/browserSwarmAccountingPeriod.test.ts",
      );
    });
  });
});
