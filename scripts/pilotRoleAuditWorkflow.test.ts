import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { DEFAULT_ROLE_TEMPLATES } from "../convex/utils/permissions";
import { auditDestination } from "../playwright/fixtures/screenAuditRoutes";
import { SWARM_LOCAL_CONVEX_AUTHORITY, SWARM_LOCAL_CONVEX_ORIGIN } from "./intelligence/swarmConvexOrigin.mjs";
import { LOCAL_CONVEX_DEPLOYMENT, convexDeploymentOf, servedDeployments } from "../playwright/scenarios/formExplorer/attestedPreview";
import roleConfig from "../playwright.role-audit.config";
import visualConfig from "../playwright.visual.config";

test.each([
  ["OWNER", "dashboard"], ["MANAGER", "dashboard"], ["SALES", "sales"],
  ["RECEPTION", "leads"], ["ACCOUNTANT", "accounting"], ["SENIOR_ACCOUNTANT", "accounting"],
] as const)("dashboard audit models the actual %s landing destination", (role, destination) => {
  expect(auditDestination("dashboard", role)).toBe(destination);
  expect(auditDestination("applications", role)).toBe("deals");
  expect(auditDestination("customers", role)).toBe("customers");
});

const source = readFileSync(path.resolve(".github/workflows/pilot-role-audit.yml"), "utf8");
const stepSchema = z.object({ name: z.string().optional(), run: z.string().optional(),
  with: z.object({ path: z.string().optional() }).passthrough().optional(),
  if: z.string().optional(),
  env: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).optional() });
const jobSchema = z.object({ if: z.string(), steps: z.array(stepSchema) });
// SCRUM-892 (Seat 1 F1, Seat 2 round 2): the role audit's own schemas are strict
// allowlists. Any key the test does not list (continue-on-error, shell, defaults,
// needs, timeout-minutes on a step, working-directory, id, ...) fails the parse,
// so a new way to turn a red step or job green cannot pass unnoticed.
const roleStepSchema = z.object({ name: z.string().optional(), uses: z.string().optional(),
  run: z.string().optional(), with: z.object({}).passthrough().optional(), if: z.string().optional(),
  env: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).optional() }).strict();
const roleJobSchema = z.object({
  strategy: z.object({
    matrix: z.object({ role: z.array(z.string()) }).strict(), "max-parallel": z.number(), "fail-fast": z.boolean(),
  }).strict(),
  if: z.string(), "runs-on": z.literal("ubuntu-latest"), "timeout-minutes": z.literal(120),
  steps: z.array(roleStepSchema),
}).strict();
const workflow = z.object({
  name: z.string(), on: z.record(z.string(), z.unknown()), permissions: z.object({ contents: z.string() }).strict(),
  concurrency: z.object({ group: z.string(), "cancel-in-progress": z.boolean() }).strict(),
  jobs: z.object({ roles: roleJobSchema }).strict(),
}).strict().parse(parse(source));
function stepNamed(steps: z.infer<typeof stepSchema>[], name: string) {
  const step = steps.find((item) => item.name === name);
  if (!step) throw new Error(`Missing required workflow step: ${name}`);
  return step;
}

describe("SCRUM-616 role audit trust and coverage contract", () => {
  test("PR and trusted-main paint the role screens and require their separate exact inventory", () => {
    const project = visualConfig.projects?.find(item => item.name === "role-page-controls");
    expect(project?.testDir).toBe("./playwright/tests");
    expect(String(project?.testMatch)).toBe(String(/role-access\.visual\.spec\.ts/));
    expect(project?.use?.storageState).toEqual({ cookies: [], origins: [] });
    const manifest = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
    expect(manifest.scripts["test:visual:deal-cockpit"]).toContain("-c playwright.visual.config.ts");
    expect(manifest.scripts["test:visual:deal-cockpit"]).not.toContain("--project");
    for (const name of ["playwright.yml", "trusted-main-e2e.yml"]) {
      const text = readFileSync(path.resolve(".github/workflows", name), "utf8");
      expect(text).toMatch(/^\s+pnpm run test:visual:deal-cockpit\s*$/m);
      const candidate = z.object({ jobs: z.object({ playwright: z.object({ steps: z.array(stepSchema) }) }) }).parse(parse(text));
      const steps = candidate.jobs.playwright.steps;
      const gateIndex = steps.findIndex((step) => step.name?.startsWith("Deal cockpit visual gate"));
      expect(gateIndex).toBeGreaterThanOrEqual(0);
      const gate = steps[gateIndex];
      const commands = (gate.run ?? "").split(/\r?\n/).map((line) => line.trim());
      expect(commands).toContain("pnpm run test:visual:deal-cockpit");
      expect(commands).toContain("node scripts/assertRoleAccessVisualFrames.mjs test-results/deal-cockpit-visual");
      expect(commands).toContain("node scripts/assertDealCockpitVisualFrames.mjs test-results/deal-cockpit-visual");
      expect(JSON.stringify(gate.env ?? {})).not.toContain("secrets.");
      const previewIndex = steps.findIndex((step) => /preview/i.test(step.name ?? ""));
      expect(previewIndex).toBeGreaterThan(gateIndex);
      const deployIndex = steps.findIndex((step) => step.run?.includes("convex deploy"));
      if (deployIndex !== -1) expect(deployIndex).toBeGreaterThan(gateIndex);
    }
  });
  test("bound role regressions run before the matrix can isolate its audited seat", () => {
    const project = roleConfig.projects?.find(item => item.name === "role-regressions");
    expect(project?.testDir).toBe("./playwright/tests");
    expect(project?.testMatch).toBe("audit-role-access.spec.ts");
    expect(project?.testIgnore).toEqual([]);
    expect(project?.dependencies).toEqual(["setup"]);
    expect(project?.use?.storageState).toBe("playwright/.auth/approver.json");
    const matrix = roleConfig.projects?.find(item => item.name === "chromium");
    expect(matrix?.dependencies).toContain("role-regressions");
    expect(roleConfig.workers).toBe(1);
    expect(roleConfig.retries).toBe(0);
  });
  test.each([
    ["PR static browser gate", visualConfig, ["audit-navigation-dismissal.spec.ts", "bill-of-sale-capture.spec.ts"]],
    ["role audit", roleConfig, "audit-navigation-dismissal.spec.ts"],
  ] as const)("anonymous controls retain their exact scope in the %s", (_name, config, testMatch) => {
    const project = config.projects?.find(item => item.name === "audit-controls");
    expect(project?.testDir).toBe("./playwright/tests");
    expect(project?.testMatch).toEqual(testMatch);
    expect(project?.dependencies ?? []).toEqual([]);
    expect(project?.use?.storageState).toEqual({ cookies: [], origins: [] });
    expect(project?.use?.trace).toBe("off");
    expect(project?.use?.video).toBe("off");
    expect(project?.use?.screenshot).toBe("off");
  });
  test("publishes only explicit post-login evidence and never records auth traces or video", () => {
    const upload = stepNamed(workflow.jobs.roles.steps, "Upload encrypted role audit evidence");
    expect(upload.with?.path?.trim().split(/\r?\n/).map((line) => line.trim())).toEqual([
      "${{ runner.temp }}/pilot-role-audit-public/role-evidence.tar.gpg",
      "${{ runner.temp }}/pilot-role-audit-public/results.json",
    ]);
    for (const project of roleConfig.projects ?? []) {
      expect(project.use?.trace ?? roleConfig.use?.trace).toBe("off");
      expect(project.use?.video ?? roleConfig.use?.video).toBe("off");
      expect(project.use?.screenshot ?? roleConfig.use?.screenshot).toBe("off");
    }
  });
  test("executes only trusted main code and runs every product role with one worker", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    const job = workflow.jobs.roles;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.strategy.matrix.role.toSorted()).toEqual(DEFAULT_ROLE_TEMPLATES.map((role) => role.name).sort());
    // SCRUM-892: every role has its own local backend, so all six run in parallel.
    expect(job.strategy["max-parallel"]).toBe(6);
    expect(job.strategy["fail-fast"]).toBe(false);
    const browserStep = stepNamed(job.steps, "Run the attested role, locale and viewport matrix");
    expect(browserStep.run).toBe("node scripts/pilotRoleAuditEvidence.mjs");
    expect(browserStep.env?.HUNT_AUDIT_ROLE).toBe("${{ matrix.role }}");
    expect(readFileSync(path.resolve("playwright.role-audit.config.ts"), "utf8")).toContain("workers: 1");
  });

  test("SCRUM-892: no cloud Preview, preview credential or --preview-create remains; every run is local and parallel", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    // No dispatch input: there is no cloud mode to select.
    expect(workflow.on.workflow_dispatch ?? null).toBeNull();
    expect(workflow.jobs.roles.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflow.concurrency.group).toBe("pilot-role-audit-${{ github.ref }}");
    expect(source).not.toMatch(/--preview-create|--preview-run|previewDeploymentLifecycle/);
    expect(source).not.toMatch(/CONVEX_PREVIEW_DEPLOY_KEY|CONVEX_DEPLOY_KEY|CONVEX_DEPLOYMENT\b|CONVEX_PREVIEW_NAME|CONVEX_PREVIEW_URL|CONVEX_PREVIEW_CREATED_AT/);
    expect(source).not.toContain("AUDIT_BACKEND");
    const steps = workflow.jobs.roles.steps;
    expect(steps.some((step) => /convex deploy/.test(step.run ?? "") && /preview/i.test(step.run ?? ""))).toBe(false);
    const matrix = stepNamed(steps, "Run the attested role, locale and viewport matrix");
    expect(matrix.env?.AUTOFLOW_LOCAL_CONVEX_CI).toBe("1");
  });

  test("SCRUM-892: local mode starts, marks, verifies and stops a per-job backend with no cloud credential", () => {
    const steps = workflow.jobs.roles.steps;
    const localNames = ["Start the local Convex backend",
      "Set and verify the local backend environment allowlist",
      "Deploy main to the local Convex backend",
      "Mint the disposable-preview marker and record the tripwire baseline",
      "Seed the QA dealership on the local backend",
      "Set exact product role templates on the local backend",
      "Run the attested role, locale and viewport matrix",
      "Verify the local backend was not changed during the run",
      "Stop the local Convex backend",
      "Upload encrypted role audit evidence"];
    // stepNamed throws on a missing step; strictly ascending indices pin the order.
    const indices = localNames.map((name) => steps.indexOf(stepNamed(steps, name)));
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
    expect(new Set(indices).size).toBe(localNames.length);
    for (const step of localNames.slice(0, 8).map((name) => stepNamed(steps, name))) {
      expect(JSON.stringify(step.env ?? {})).not.toMatch(/CONVEX_(PREVIEW_)?DEPLOY_KEY|CONVEX_PREVIEW/);
      expect(step.run ?? "").not.toMatch(/--preview-|previewDeploymentLifecycle/);
    }
    expect(stepNamed(steps, "Start the local Convex backend").run).toBe("node scripts/localConvexBackend.mjs start");
    expect(stepNamed(steps, "Mint the disposable-preview marker and record the tripwire baseline").run)
      .toBe("node scripts/localConvexBackend.mjs mark");
    const verify = stepNamed(steps, "Verify the local backend was not changed during the run");
    expect(verify.run).toBe("node scripts/localConvexBackend.mjs verify");
    // The tripwire must be able to fail the job and must run whenever `mark` ran.
    // Exact text: a weakened condition (e.g. `== 'never'`) would silently skip it.
    expect(verify.if).toBe("always() && env.AUTOFLOW_LOCAL_CONVEX_CODE_FINGERPRINT != ''");
    expect(stepNamed(steps, "Mint the disposable-preview marker and record the tripwire baseline").if).toBeUndefined();
    const tripwireSpan = steps.slice(
      steps.indexOf(stepNamed(steps, "Mint the disposable-preview marker and record the tripwire baseline")),
      steps.indexOf(verify) + 1,
    );
    expect(tripwireSpan.length).toBeGreaterThan(1);
    // Exactly always(), as the shared credential-boundary test requires.
    const stop = stepNamed(steps, "Stop the local Convex backend");
    expect(stop.if).toBe("always()");
    expect(stop.run).toBe("node scripts/localConvexBackend.mjs stop");
    expect(stepNamed(steps, "Run the attested role, locale and viewport matrix").run).toBe("node scripts/pilotRoleAuditEvidence.mjs");
  });

  // Every GitHub Actions key that can turn a failing step or job green, or skip the
  // tripwire, and the assertion that covers it. The strict schemas above reject any
  // key not listed; this table walks the raw YAML so a key nested anywhere is found.
  const GREENING_KEYS: ReadonlyArray<readonly [string, string]> = [
    ["continue-on-error", "step or job: a failing step/job reports success"],
    ["shell", "step or defaults.run: `bash -c '...; exit 0'` swallows the exit code"],
    ["defaults", "workflow or job: defaults.run.shell reaches every run step"],
    ["needs", "job: a publishing job could ignore the audit job's result"],
    ["container", "job: runs steps somewhere other than the runner the tripwire reads"],
    ["services", "job: side containers on the runner"],
    ["environment", "job: environment secrets and approvals"],
    ["working-directory", "step: runs the same script from another tree"],
  ];
  const EXPECTED_IF: Readonly<Record<string, string | undefined>> = {
    "Verify the local backend was not changed during the run": "always() && env.AUTOFLOW_LOCAL_CONVEX_CODE_FINGERPRINT != ''",
    "Stop the local Convex backend": "always()",
    "Upload encrypted role audit evidence": "always()",
  };
  function keysAnywhere(value: unknown, found: string[] = []): string[] {
    if (Array.isArray(value)) value.forEach((item) => keysAnywhere(item, found));
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) { found.push(key); keysAnywhere(child, found); }
    }
    return found;
  }

  test("SCRUM-892: no key that turns a failing step or job green, or skips the tripwire, exists anywhere", () => {
    const present = new Set(keysAnywhere(parse(source)));
    for (const [key, why] of GREENING_KEYS) expect(present.has(key), `${key}: ${why}`).toBe(false);
    // One job, so no publishing job can depend on or ignore it; and no job-level
    // continue-on-error, defaults or timeout change (the strict schema pins the rest).
    expect(Object.keys(workflow.jobs)).toEqual(["roles"]);
    expect(workflow.jobs.roles["timeout-minutes"]).toBe(120);
    // Step `if`: exactly the three always() steps, and none on any other step.
    for (const step of workflow.jobs.roles.steps) {
      expect(step.if, step.name ?? step.uses).toBe(step.name ? EXPECTED_IF[step.name] : undefined);
    }
    // Step run commands in the tripwire span are the exact trusted commands (no `shell` key
    // can reach them, and no wrapper can be added to the command itself).
    for (const [name, command] of [
      ["Mint the disposable-preview marker and record the tripwire baseline", "mark"],
      ["Verify the local backend was not changed during the run", "verify"],
    ] as const) expect(stepNamed(workflow.jobs.roles.steps, name).run).toBe(`node scripts/localConvexBackend.mjs ${command}`);
  });

  test("SCRUM-892: the browser helpers name only the exact local backend, nothing else on loopback", () => {
    expect(convexDeploymentOf("http://127.0.0.1:3210")).toBe(LOCAL_CONVEX_DEPLOYMENT);
    expect(convexDeploymentOf("ws://127.0.0.1:3210/api/1.0/sync")).toBe(LOCAL_CONVEX_DEPLOYMENT);
    expect(convexDeploymentOf("https://happy-cat-123.convex.cloud")).toBe("happy-cat-123");
    for (const refused of ["http://127.0.0.1:3000", "http://localhost:3210", "http://127.0.0.2:3210",
      "https://127.0.0.1:3210", "http://user@127.0.0.1:3210", "http://127.0.0.1:3210.evil.example", undefined]) {
      expect(convexDeploymentOf(refused)).toBeUndefined();
    }
    expect(servedDeployments(["ws://127.0.0.1:3210/api/1.0/sync", "ws://127.0.0.1:3000/_next/webpack-hmr",
      "wss://x-1.convex.cloud/api/1.0/sync"])).toEqual([LOCAL_CONVEX_DEPLOYMENT, "x-1"]);
    // The origin is spelled out in this helper, so pin it to the shared constant
    // (the same way the swarm's own copies are pinned in swarmConvexOrigin.test.ts).
    expect(convexDeploymentOf(SWARM_LOCAL_CONVEX_ORIGIN)).toBe(LOCAL_CONVEX_DEPLOYMENT);
    expect(new URL(SWARM_LOCAL_CONVEX_ORIGIN).host).toBe(SWARM_LOCAL_CONVEX_AUTHORITY);
  });

  test("the real-backend scenario library opts into the existing fail-closed cross-screen oracle", () => {
    const scenarios = z.object({ jobs: z.object({ scenarios: jobSchema }) }).parse(
      parse(readFileSync(path.resolve(".github/workflows/deal-scenarios-e2e.yml"), "utf8")),
    );
    const run = stepNamed(scenarios.jobs.scenarios.steps, "Run the scenario matrix and screen audit");
    expect(run.env?.CROSS_SCREEN_ORACLE).toBe("1");
    expect(run.run).toContain("-c playwright.scenarios.config.ts");
  });
});
