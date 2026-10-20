import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * SCRUM-795 / SCRUM-800: structural pins for the dedicated GL-replay lane. The credential-boundary fingerprint
 * pins the whole file; these say WHY the properties that matter hold, so an edit that keeps the fingerprint
 * honest still cannot quietly drop one of them.
 */
const FILE = ".github/workflows/trusted-main-replay-e2e.yml";
const text = readFileSync(path.join(process.cwd(), FILE), "utf8");
type Step = { name?: string; run?: string; if?: string; uses?: string; env?: Record<string, string> };
const workflow = parse(text) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, { if?: string; steps: Step[] }>;
};
const job = workflow.jobs.replay;
const steps = job.steps;
const indexOf = (needle: string) => {
  const hits = steps.flatMap((s, i) => ((s.run ?? "").includes(needle) ? [i] : []));
  expect(hits, needle).toHaveLength(1);
  return hits[0];
};

describe("replay lane workflow", () => {
  it("runs only on main: push to main and dispatch, a ref guard, and no pull-request-family trigger", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push).toEqual({ branches: ["main"] });
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(text).not.toMatch(/pull_request|workflow_run/);
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("requires the replay and declares the org dedicated, on the one Playwright step", () => {
    const run = steps.filter((s) => (s.run ?? "").includes("playwright test"));
    expect(run).toHaveLength(1);
    expect(run[0].run).toContain("playwright/tests/accounting.spec.ts");
    expect(run[0].env?.E2E_REPLAY_REQUIRED).toBe("1");
    expect(run[0].env?.E2E_REPLAY_DEDICATED_ORG).toBe("1");
    expect(run[0].env?.E2E_REPLAY_RUN_NONCE).toBe("${{ env.E2E_REPLAY_RUN_NONCE }}");
    expect(run[0].env?.E2E_REPLAY_RUN_ID).toBe("${{ env.E2E_REPLAY_RUN_ID }}");
  });

  it("sets the three run variables on the preview, by name, before the seed and the spec", () => {
    const bind = indexOf("E2E_REPLAY_RUN_NONCE");
    const seed = steps.findIndex((s) => (s.run ?? "").trim() === "node scripts/e2ePreviewBootstrap.mjs");
    expect(seed).toBeGreaterThan(-1);
    const playwright = indexOf("playwright test");
    const create = indexOf("--preview-create");
    const pin = indexOf("previewDeploymentLifecycle.mjs pin");
    expect(pin).toBe(create + 1);
    expect(bind).toBeGreaterThan(pin);
    expect(bind).toBeLessThan(seed);
    expect(seed).toBeLessThan(playwright);
    const run = steps[bind].run ?? "";
    for (const name of ["E2E_REPLAY_RUN_NONCE", "E2E_REPLAY_RUN_ID", "E2E_REPLAY_RUN_EXPIRES_AT"]) {
      expect(run, name).toMatch(new RegExp(`convex env set --force --preview-name "\\$CONVEX_PREVIEW_NAME" ${name}`));
    }
    // Every env set addresses the preview; none addresses prod or an arbitrary deployment.
    expect(run).not.toMatch(/--prod|--deployment|--url|--admin-key/);
    // Preview-only, replay-lane-only guards run before any set.
    expect(run.indexOf("e2e-main-replay-lane-*")).toBeGreaterThan(-1);
    expect(run.indexOf("e2e-main-replay-lane-*")).toBeLessThan(run.indexOf("convex env set"));
    expect(run.indexOf("preview:*")).toBeGreaterThan(-1);
    expect(run.indexOf("preview:*")).toBeLessThan(run.indexOf("convex env set"));
    expect(run).toContain('if [ -n "${CONVEX_DEPLOYMENT:-}" ]; then');
    expect(run.indexOf('if [ -n "${CONVEX_DEPLOYMENT:-}" ]')).toBeLessThan(run.indexOf("convex env set"));
    expect(steps[bind].env?.CONVEX_DEPLOY_KEY).toBe("${{ secrets.CONVEX_PREVIEW_DEPLOY_KEY }}");
    expect(run).toMatch(/set -euo pipefail/);
  });

  it("expires the nonce within six hours", () => {
    const run = steps[indexOf("E2E_REPLAY_RUN_EXPIRES_AT")].run ?? "";
    const seconds = Number(/date \+%s\) \+ (\d+)\)/.exec(run)?.[1]);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(6 * 60 * 60);
  });

  it("masks the nonce and never echoes it", () => {
    const run = steps[indexOf("E2E_REPLAY_RUN_NONCE")].run ?? "";
    expect(run).toContain("openssl rand -hex 16");
    expect(run.indexOf("::add-mask::$NONCE")).toBeGreaterThan(run.indexOf("openssl rand"));
    // The only places the value appears: the mask, a stdin pipe into the CLI, and the GITHUB_ENV file.
    const uses = run.split("\n").filter((line) => line.includes("$NONCE"));
    expect(uses.map((l) => l.trim())).toEqual([
      'echo "::add-mask::$NONCE"',
      "printf '%s' \"$NONCE\" | pnpm exec convex env set --force --preview-name \"$CONVEX_PREVIEW_NAME\" E2E_REPLAY_RUN_NONCE >/dev/null",
      'echo "E2E_REPLAY_RUN_NONCE=$NONCE"',
    ]);
    // The stdin pipe sits inside a function that the retry wrapper calls, so EVERY attempt re-pipes the value.
    expect(run).toMatch(/set_nonce\(\) \{\n\s+printf '%s' "\$NONCE" \| pnpm exec convex env set/);
    expect(run).toContain("retry_convex set_nonce");
    expect(run).not.toMatch(/\|\s*retry_convex/);
    // No step anywhere prints the variable or enables shell tracing.
    for (const s of steps) {
      expect(s.run ?? "", s.name).not.toMatch(/set -[a-z]*x|set -o xtrace/);
    }
    expect(text).not.toMatch(/ACTIONS_STEP_DEBUG/);
  });

  it("lets no step except the bind step and the Playwright step name the nonce, and none dumps the environment", () => {
    const bind = indexOf("E2E_REPLAY_RUN_NONCE");
    steps.forEach((s, i) => {
      const body = JSON.stringify(s);
      const mentions = /E2E_REPLAY_RUN_NONCE|\$NONCE|\$\{NONCE/.test(body);
      const isPlaywright = (s.run ?? "").includes("playwright test");
      if (i !== bind && !isPlaywright) expect(mentions, s.name).toBe(false);
      // A bare `env`, `printenv`, `set` (no flags), `export -p` or `declare -p` dumps every variable, masked or not.
      expect(s.run ?? "", s.name).not.toMatch(/(^|[;&|]\s*|\n\s*)(env|printenv|set|export -p|declare -p|compgen -v)\s*(\||;|$|\n)/);
    });
  });

  it("keeps the cleanup: pin right after create, delete last under always()", () => {
    const del = steps.at(-1)!;
    expect(del.run).toContain("previewDeploymentLifecycle.mjs delete");
    expect(del.if).toBe("always() && env.CONVEX_PREVIEW_CREATED_AT != ''");
  });
});
