/**
 * SCRUM-1026 PR B: the workflow text and the real entrypoints for the
 * self-hosted release target. Each refusal is paired with a control in which
 * only the condition under test differs. The workflow cannot be run here; what
 * these pin is its parsed structure and the shell of the deploy step.
 */
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { classifyMarkerRead, decideZeroState, type ZeroStateInput } from "./zeroState.ts";

const REPO_ROOT = path.resolve(__dirname, "..");
const WORKFLOW_PATH = ".github/workflows/deploy-production.yml";
const workflowText = readFileSync(path.join(REPO_ROOT, WORKFLOW_PATH), "utf8");

type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; env?: Record<string, string> };
type Job = { "runs-on"?: string; environment?: string; permissions?: Record<string, string>; steps: Step[] };
const workflow = parseYaml(workflowText) as { permissions: Record<string, string>; jobs: Record<string, Job> };
const deploy = workflow.jobs.deploy;
const step = (name: string): Step => {
  const found = deploy.steps.filter((s) => s.name === name);
  expect(found, `exactly one step named ${name}`).toHaveLength(1);
  return found[0];
};
const indexOfStep = (name: string) => deploy.steps.findIndex((s) => s.name === name);

const CLOUD = {
  credentials: "Refuse credentials that do not address the expected deployment",
  deploy: "Deploy Convex backend",
  zero: "Verify zero-state (fresh launch checkpoint)",
  rollout: "Roll out Social Inbox conversations and verify",
};
const SELF = {
  credentials: "Refuse self-hosted credentials and backend that do not address the expected instance",
  deploy: "Deploy Convex backend (self-hosted)",
  zero: "Verify zero-state (fresh launch checkpoint, self-hosted)",
  rollout: "Roll out Social Inbox conversations and verify (self-hosted)",
};
const TARGET = "Select the deploy target";
const CLOUD_ONLY_NAMES = ["CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT", "CONVEX_PREVIEW_DEPLOY_KEY"];
const SELF_KEY_EXPR = "${{ secrets.CONVEX_PROD_SELF_HOSTED_ADMIN_KEY }}";
const SELF_URL_EXPR = "${{ vars.CONVEX_PROD_SELF_HOSTED_URL }}";

describe("workflow: both targets, same gates, same order", () => {
  test("the gates before the target are untouched and the target is selected after CI and before any credential gate", () => {
    const order = [
      "Independently re-verify main's tip immediately before deploying",
      "Re-verify CI at that commit, now that it has been approved",
      TARGET,
      CLOUD.credentials,
      SELF.credentials,
      CLOUD.deploy,
      SELF.deploy,
      CLOUD.zero,
      SELF.zero,
      CLOUD.rollout,
      SELF.rollout,
    ].map(indexOfStep);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // No gate carries a target condition.
    for (const name of [
      "Check out the authorised commit exactly",
      "Assert the checkout is that commit",
      "Install dependencies",
      "Independently re-verify main's tip immediately before deploying",
      "Re-verify CI at that commit, now that it has been approved",
    ]) {
      expect(deploy.steps[indexOfStep(name)]?.if, name).toBeUndefined();
    }
    expect(deploy.environment).toBe("production");
    expect(workflow.jobs.authorize.environment).toBeUndefined();
  });

  test("the target step passes only the non-secret target variable and runs the one script", () => {
    const s = step(TARGET);
    expect(s.id).toBe("target");
    expect(s.env).toEqual({ CONVEX_PROD_TARGET: "${{ vars.CONVEX_PROD_TARGET }}" });
    expect(s.run).toBe("node scripts/resolveReleaseTarget.mjs");
  });

  test("every cloud step runs unless the target is exactly self-hosted; every self-hosted step runs only then", () => {
    for (const name of Object.values(CLOUD)) {
      const condition = step(name).if ?? "";
      expect(condition, name).toContain("steps.target.outputs.target != 'self-hosted'");
    }
    for (const name of Object.values(SELF)) {
      expect(step(name).if ?? "", name).toContain("steps.target.outputs.target == 'self-hosted'");
    }
    // The zero-state checkpoint keeps its own opt-in on both sides.
    expect(step(CLOUD.zero).if).toContain("inputs.zero_state == 'fresh-launch'");
    expect(step(SELF.zero).if).toContain("inputs.zero_state == 'fresh-launch'");
  });

  test("CLOUD PIN: the cloud steps issue the same commands with the same variables as before this change", () => {
    expect(step(CLOUD.deploy).env).toEqual({
      CONVEX_DEPLOY_KEY: "${{ secrets.CONVEX_PROD_DEPLOY_KEY }}",
      GH_TOKEN: "${{ github.token }}",
      EXPECTED_SHA: "${{ needs.authorize.outputs.sha }}",
      REPO: "${{ github.repository }}",
    });
    expect(step(CLOUD.deploy).run).toMatch(/\npnpm exec convex deploy\n$/);
    expect(step(CLOUD.zero).env).toEqual({
      CONVEX_DEPLOY_KEY: "${{ secrets.CONVEX_FRESH_OBSERVER_KEY }}",
      CONVEX_PROD_DEPLOYMENT: "${{ vars.CONVEX_PROD_DEPLOYMENT }}",
      RELEASE_SHA: "${{ needs.authorize.outputs.sha }}",
    });
    expect(step(CLOUD.zero).run).toBe("node scripts/verifyZeroState.mjs --phase post-deploy");
    expect(step(CLOUD.rollout).env).toEqual({
      CONVEX_DEPLOY_KEY: "${{ secrets.CONVEX_PROD_OPERATOR_KEY }}",
      CONVEX_PROD_DEPLOYMENT: "${{ vars.CONVEX_PROD_DEPLOYMENT }}",
      RELEASE_SHA: "${{ needs.authorize.outputs.sha }}",
      ROLLOUT_TIMEOUT_MINUTES: "45",
    });
    expect(step(CLOUD.rollout).run).toBe("node scripts/rolloutRelease.mjs");
    const credentials = step(CLOUD.credentials);
    expect(credentials.run).toBe("node scripts/assertReleaseCredentials.mjs");
    expect(credentials.env).toMatchObject({
      CONVEX_PROD_DEPLOYMENT: "${{ vars.CONVEX_PROD_DEPLOYMENT }}",
      CONVEX_PROD_DEPLOY_KEY: "${{ secrets.CONVEX_PROD_DEPLOY_KEY }}",
      CONVEX_PROD_OPERATOR_KEY: "${{ secrets.CONVEX_PROD_OPERATOR_KEY }}",
    });
  });

  test("cloud steps never receive the self-hosted key; the cloud gate gets only a boolean", () => {
    for (const name of Object.values(CLOUD)) {
      expect(JSON.stringify(step(name).env ?? {}), name).not.toContain("CONVEX_PROD_SELF_HOSTED_ADMIN_KEY }}");
      expect(JSON.stringify(step(name).env ?? {}), name).not.toContain("CONVEX_SELF_HOSTED");
    }
    expect(step(CLOUD.credentials).env?.CONVEX_PROD_SELF_HOSTED_ADMIN_KEY_PRESENT).toBe(
      "${{ secrets.CONVEX_PROD_SELF_HOSTED_ADMIN_KEY != '' }}"
    );
    expect(step(CLOUD.credentials).env?.CONVEX_PROD_TARGET).toBe("${{ vars.CONVEX_PROD_TARGET }}");
  });

  test("self-hosted steps hold no Convex Cloud credential, and the key and URL come from one place", () => {
    for (const name of Object.values(SELF)) {
      const env = step(name).env ?? {};
      for (const cloud of CLOUD_ONLY_NAMES) expect(Object.keys(env), name).not.toContain(cloud);
      const text = JSON.stringify(env);
      expect(text, name).not.toMatch(/CONVEX_PROD_DEPLOY_KEY|CONVEX_PROD_OPERATOR_KEY|CONVEX_FRESH_OBSERVER_KEY|CONVEX_PREVIEW_DEPLOY_KEY/);
    }
    for (const name of [SELF.deploy, SELF.zero, SELF.rollout]) {
      const env = step(name).env ?? {};
      expect(env.CONVEX_SELF_HOSTED_URL, name).toBe(SELF_URL_EXPR);
      expect(env.CONVEX_SELF_HOSTED_ADMIN_KEY, name).toBe(SELF_KEY_EXPR);
    }
    const gate = step(SELF.credentials).env ?? {};
    expect(gate.CONVEX_PROD_SELF_HOSTED_URL).toBe(SELF_URL_EXPR);
    expect(gate.CONVEX_PROD_SELF_HOSTED_ADMIN_KEY).toBe(SELF_KEY_EXPR);
    expect(gate.CONVEX_PROD_DEPLOYMENT).toBe("${{ vars.CONVEX_PROD_DEPLOYMENT }}");
  });

  test("the self-hosted deploy re-checks main's tip on the line before the same CLI command", () => {
    const cloud = step(CLOUD.deploy).run ?? "";
    const self = step(SELF.deploy).run ?? "";
    expect(self).toBe(cloud);
    expect(self).not.toMatch(/--yes|\s-y\b|--cmd|npx/);
  });

  test("no untrusted expression is interpolated into any run block; no new action; no self-hosted runner", () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(job["runs-on"]).toBe("ubuntu-latest");
      for (const s of job.steps) {
        expect(s.run ?? "", s.name).not.toContain("${{");
        if (s.uses) expect(s.uses, s.name).toMatch(/@[0-9a-f]{40}( |$)/);
      }
    }
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(deploy.permissions).toEqual({ actions: "read", checks: "read", contents: "read", statuses: "read" });
    const actions = deploy.steps.filter((s) => s.uses).map((s) => (s.uses ?? "").split("@")[0]);
    expect(actions).toEqual(["actions/checkout", "pnpm/action-setup", "actions/setup-node"]);
  });
});

/** Runs the self-hosted deploy step's real shell with `gh` and `pnpm` stubbed. */
function runSelfHostedDeployStep(options: { tip: string; expected: string }) {
  const run = step(SELF.deploy).run ?? "";
  const dir = mkdtempSync(path.join(tmpdir(), "autoflow-selfhosted-deploy-"));
  writeFileSync(
    path.join(dir, "step.sh"),
    [
      `export REPO="aalzriqat/Auto"`,
      `export EXPECTED_SHA="${options.expected}"`,
      `gh() { printf '%s\\n' "${options.tip}"; }`,
      `pnpm() { echo "$*" > deployed; }`,
      run,
    ].join("\n")
  );
  const result = spawnSync("bash", ["step.sh"], { cwd: dir, encoding: "utf8", shell: false, timeout: 30_000 });
  return { status: result.status, deployed: existsSync(path.join(dir, "deployed")), output: `${result.stdout}${result.stderr}` };
}

describe("self-hosted deploy step shell", () => {
  const SHA = "a".repeat(40);
  test("control: an unmoved tip deploys with the plain command", () => {
    const r = runSelfHostedDeployStep({ tip: SHA, expected: SHA });
    expect(r.status, r.output).toBe(0);
    expect(r.deployed).toBe(true);
  });
  test("a moved tip refuses and never deploys", () => {
    const r = runSelfHostedDeployStep({ tip: "b".repeat(40), expected: SHA });
    expect(r.status).not.toBe(0);
    expect(r.deployed).toBe(false);
  });
});

// ─── Real entrypoints ───────────────────────────────────────────────────────

const SCRATCH = mkdtempSync(path.join(tmpdir(), "autoflow-target-"));
const TOKEN = "0123456789abcdef0123456789abcdef";
const INSTANCE = "autoflow-prod";
const KEY = `${INSTANCE}|${TOKEN}`;

function run(script: string, overrides: Record<string, string>, args: string[] = []) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^CONVEX_|^RELEASE_|^GITHUB_(OUTPUT|STEP_SUMMARY|REF|REPOSITORY|TOKEN)$|^ROLLOUT_/.test(key)) delete env[key];
  }
  return spawnSync(process.execPath, [path.join("scripts", script), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
    timeout: 60_000,
    env: { ...env, ...overrides },
  });
}
const out = (r: ReturnType<typeof run>) => `${r.stdout}${r.stderr}`;

describe("resolveReleaseTarget.mjs", () => {
  const resolve = (value: string | undefined, withOutput = true) => {
    const file = path.join(SCRATCH, `output-${Math.random().toString(36).slice(2)}`);
    writeFileSync(file, "");
    const r = run("resolveReleaseTarget.mjs", {
      ...(value === undefined ? {} : { CONVEX_PROD_TARGET: value }),
      ...(withOutput ? { GITHUB_OUTPUT: file } : {}),
    });
    return { r, written: readFileSync(file, "utf8") };
  };
  test.each([[undefined, "cloud"], ["", "cloud"], ["cloud", "cloud"], ["self-hosted", "self-hosted"]])("%j -> target=%s", (value, expected) => {
    const { r, written } = resolve(value);
    expect(r.status, out(r)).toBe(0);
    expect(written).toBe(`target=${expected}\n`);
  });
  test.each(["Self-Hosted", "selfhosted", "prod", " "])("%j refuses and publishes nothing", (value) => {
    const { r, written } = resolve(value);
    expect(r.status).toBe(1);
    expect(written).toBe("");
  });
  test("refuses when the output cannot be published", () => {
    expect(resolve("cloud", false).r.status).toBe(1);
  });
});

describe("assertReleaseCredentials.mjs, both targets", () => {
  const selfHosted = (over: Record<string, string> = {}) => ({
    CONVEX_PROD_TARGET: "self-hosted",
    CONVEX_PROD_DEPLOYMENT: INSTANCE,
    // `.invalid` never resolves (RFC 2606), so a request cannot leave the machine successfully.
    CONVEX_PROD_SELF_HOSTED_URL: "https://backend.example.invalid",
    CONVEX_PROD_SELF_HOSTED_ADMIN_KEY: KEY,
    ...over,
  });
  test("control: a correct self-hosted configuration reaches the network and fails there, for the network reason", () => {
    const r = run("assertReleaseCredentials.mjs", selfHosted());
    expect(r.status).toBe(1);
    expect(out(r)).toMatch(/did not answer \/instance_name/);
  });
  test.each([
    ["a convex.cloud URL", { CONVEX_PROD_SELF_HOSTED_URL: "https://some-name-123.convex.cloud" }, /Convex Cloud host/],
    ["an http URL", { CONVEX_PROD_SELF_HOSTED_URL: "http://backend.example.invalid" }, /https/],
    ["an IP URL", { CONVEX_PROD_SELF_HOSTED_URL: "https://203.0.113.9" }, /DNS name/],
    ["a key for another instance", { CONVEX_PROD_SELF_HOSTED_ADMIN_KEY: `other-prod|${TOKEN}` }, /different instance name/],
    ["a cloud-shaped key", { CONVEX_PROD_SELF_HOSTED_ADMIN_KEY: `prod:${INSTANCE}|${TOKEN}` }, /shape/],
    ["no expected name", { CONVEX_PROD_DEPLOYMENT: "" }, /CONVEX_PROD_DEPLOYMENT is not set/],
    ["a cloud key left in the step", { CONVEX_DEPLOY_KEY: `prod:${INSTANCE}|${TOKEN}` }, /CONVEX_DEPLOY_KEY is present/],
    ["a cloud deployment left in the step", { CONVEX_DEPLOYMENT: "prod:x" }, /CONVEX_DEPLOYMENT is present/],
    ["an unknown target", { CONVEX_PROD_TARGET: "self_hosted" }, /must be unset/],
  ])("self-hosted refuses %s before any network call", (_label, over, pattern) => {
    const r = run("assertReleaseCredentials.mjs", selfHosted(over));
    expect(r.status).toBe(1);
    expect(out(r)).toMatch(pattern);
    expect(out(r)).not.toMatch(/did not answer/);
    expect(out(r)).not.toContain(TOKEN);
  });

  const cloud = (over: Record<string, string> = {}) => ({
    CONVEX_PROD_DEPLOYMENT: "kindly-hound-172",
    CONVEX_PROD_DEPLOY_KEY: "prod:kindly-hound-172|deploysecret",
    CONVEX_PROD_OPERATOR_KEY: "prod:kindly-hound-172|opsecret",
    ...over,
  });
  test.each<Record<string, string>>([{}, { CONVEX_PROD_TARGET: "cloud" }, { CONVEX_PROD_SELF_HOSTED_ADMIN_KEY_PRESENT: "false" }])("control: cloud passes with %j", (over) => {
    const r = run("assertReleaseCredentials.mjs", cloud(over));
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toMatch(/kindly-hound-172/);
  });
  test.each([
    ["a self-hosted URL", { CONVEX_PROD_SELF_HOSTED_URL: "https://backend.example.com" }],
    ["a self-hosted key", { CONVEX_PROD_SELF_HOSTED_ADMIN_KEY: KEY }],
    ["a self-hosted key flag", { CONVEX_PROD_SELF_HOSTED_ADMIN_KEY_PRESENT: "true" }],
    ["an unknown target", { CONVEX_PROD_TARGET: "clod" }],
  ])("cloud refuses a mixed configuration: %s", (_label, over) => {
    const r = run("assertReleaseCredentials.mjs", cloud(over));
    expect(r.status).toBe(1);
    expect(out(r)).toMatch(/Mixed configuration|must be unset/);
    expect(out(r)).not.toMatch(/deploysecret|opsecret/);
    expect(out(r)).not.toContain(TOKEN);
  });
});

describe("rolloutRelease.mjs and verifyZeroState.mjs refuse a bad self-hosted configuration before any CLI call", () => {
  const base = {
    CONVEX_PROD_TARGET: "self-hosted",
    CONVEX_PROD_DEPLOYMENT: INSTANCE,
    CONVEX_SELF_HOSTED_URL: "https://backend.example.invalid",
    CONVEX_SELF_HOSTED_ADMIN_KEY: KEY,
  };
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    ["a cloud key in the step", { CONVEX_DEPLOY_KEY: `prod:${INSTANCE}|${TOKEN}` }, /CONVEX_DEPLOY_KEY is present/],
    ["a convex.cloud URL", { CONVEX_SELF_HOSTED_URL: "https://some-name-123.convex.cloud" }, /Convex Cloud host/],
    ["a key for another instance", { CONVEX_SELF_HOSTED_ADMIN_KEY: `other-prod|${TOKEN}` }, /different instance name/],
    ["no key", { CONVEX_SELF_HOSTED_ADMIN_KEY: "" }, /no self-hosted admin key/],
    ["an unknown target", { CONVEX_PROD_TARGET: "self_hosted" }, /must be unset/],
  ];
  test.each(cases)("rollout refuses %s", (_label, over, pattern) => {
    const r = run("rolloutRelease.mjs", { ...base, ...over });
    expect(r.status).toBe(1);
    expect(out(r)).toMatch(pattern);
    expect(out(r)).not.toMatch(/Reading the current materialisation state/);
    expect(out(r)).not.toContain(TOKEN);
  });
  test.each(cases)("zero-state refuses %s", (_label, over, pattern) => {
    const r = run("verifyZeroState.mjs", { ...base, ...over }, ["--phase", "post-deploy"]);
    expect(r.status).toBe(1);
    expect(out(r)).toMatch(pattern);
    expect(out(r)).not.toMatch(/Zero-state verification:/);
    expect(out(r)).not.toContain(TOKEN);
  });
  test("rollout on the cloud target refuses a self-hosted variable (mixed)", () => {
    const r = run("rolloutRelease.mjs", {
      CONVEX_PROD_DEPLOYMENT: "kindly-hound-172",
      CONVEX_DEPLOY_KEY: "prod:kindly-hound-172|opsecret",
      CONVEX_SELF_HOSTED_URL: "https://backend.example.com",
    });
    expect(r.status).toBe(1);
    expect(out(r)).toMatch(/Mixed configuration/);
    expect(out(r)).not.toMatch(/opsecret/);
  });
});

// ─── The zero-state decision must not pass vacuously on this target ─────────

const SCHEMA = ["organizations"];
function healthy(over: Partial<ZeroStateInput> = {}): ZeroStateInput {
  return {
    phase: "post-deploy",
    expectedDeployment: INSTANCE,
    credentialDeployment: INSTANCE,
    reportedUrl: "https://backend.example.com",
    reportedInstanceName: INSTANCE,
    selfHostedOrigin: "https://backend.example.com",
    functionCount: 10,
    marker: { state: "VERIFIED_ABSENT", deployment: INSTANCE, deploymentKind: "prod" },
    schemaTables: SCHEMA,
    listedTables: SCHEMA,
    components: [],
    reads: [{ component: null, table: "organizations", outcome: "EMPTY" }],
    storage: "EMPTY",
    scheduledFunctions: "EMPTY",
    ...over,
  };
}

describe("zero-state decision, self-hosted", () => {
  test("control: every identity read-back agrees -> ZERO", () => {
    const report = decideZeroState(healthy());
    expect(report.reasons).toEqual([]);
    expect(report.verdict).toBe("ZERO");
  });
  test("the instance name unanswered is a FAIL, not a pass on the credential alone", () => {
    const report = decideZeroState(healthy({ reportedInstanceName: null }));
    expect(report.verdict).toBe("FAIL");
    expect(report.reasons.join(" ")).toMatch(/did not answer \/instance_name/);
  });
  test("a different instance name fails", () => {
    expect(decideZeroState(healthy({ reportedInstanceName: "someone-else" })).verdict).toBe("FAIL");
  });
  test("function metadata from another URL, a missing URL, or a convex.cloud URL fails", () => {
    for (const reportedUrl of ["https://other.example.com", null, "https://abc-def-123.convex.cloud"]) {
      expect(decideZeroState(healthy({ reportedUrl })).verdict, String(reportedUrl)).toBe("FAIL");
    }
  });
  test("a key for another instance fails", () => {
    expect(decideZeroState(healthy({ credentialDeployment: "other" })).verdict).toBe("FAIL");
  });
  test("a non-empty table still fails on this target", () => {
    expect(decideZeroState(healthy({ reads: [{ component: null, table: "organizations", outcome: "NONEMPTY" }] })).verdict).toBe("FAIL");
  });
  test("the cloud target is unchanged: a self-hosted-looking URL still fails without the origin", () => {
    expect(decideZeroState(healthy({ selfHostedOrigin: undefined })).verdict).toBe("FAIL");
  });
});

// ─── `env get` against a self-hosted backend prints no deployment suffix ────
describe("marker read, self-hosted", () => {
  const BARE = '✖ Environment variable "AUTOFLOW_DEPLOYMENT_CLASS" not found\n';
  const SUFFIXED = '✖ Environment variable "AUTOFLOW_DEPLOYMENT_CLASS" not found (on prod deployment some-instance)\n';
  test("control: the suffixed cloud sentence is still VERIFIED_ABSENT with no instance given", () => {
    expect(classifyMarkerRead("", SUFFIXED, 0).state).toBe("VERIFIED_ABSENT");
  });
  test("the bare sentence is accepted only when a self-hosted instance is given", () => {
    expect(classifyMarkerRead("", BARE, 0, "AUTOFLOW_DEPLOYMENT_CLASS", INSTANCE)).toEqual({
      state: "VERIFIED_ABSENT",
      deploymentKind: "prod",
      deployment: INSTANCE,
    });
  });
  test("the cloud target never accepts the bare sentence", () => {
    expect(classifyMarkerRead("", BARE, 0).state).toBe("UNREADABLE");
  });
  test("another variable's bare sentence is not an absence", () => {
    expect(classifyMarkerRead("", BARE.replace("AUTOFLOW_DEPLOYMENT_CLASS", "OTHER"), 0, "AUTOFLOW_DEPLOYMENT_CLASS", INSTANCE).state).toBe("UNREADABLE");
  });
  test("a non-zero exit, silence, or trailing text is not an absence", () => {
    expect(classifyMarkerRead("", BARE, 1, "AUTOFLOW_DEPLOYMENT_CLASS", INSTANCE).state).toBe("UNREADABLE");
    expect(classifyMarkerRead("", "", 0, "AUTOFLOW_DEPLOYMENT_CLASS", INSTANCE).state).toBe("UNREADABLE");
    expect(classifyMarkerRead("", BARE + "✖ more\n", 0, "AUTOFLOW_DEPLOYMENT_CLASS", INSTANCE).state).toBe("UNREADABLE");
  });
  test("a present marker still fails", () => {
    expect(classifyMarkerRead("preview\n", "", 0, "AUTOFLOW_DEPLOYMENT_CLASS", INSTANCE).state).toBe("PRESENT");
  });
});
