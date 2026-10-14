/**
 * SCRUM-771 — deal-scenarios-e2e runs the Jev form explorer on every run
 * (SCRUM-760 owner rulings 2–3: every hunter at full capability, nightly runs
 * the full library). Before this, no path ever set JEV_FORM_EXPLORER, so the
 * explorer was skipped on every run while the job reported green.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const RAW = readFileSync(path.join(process.cwd(), ".github", "workflows", "deal-scenarios-e2e.yml"), "utf8");
type Step = { name?: string; run?: string; if?: string; env?: Record<string, string> };
const WF = parse(RAW) as {
  on: { schedule: unknown[]; workflow_dispatch: { inputs: Record<string, { type: string; default: unknown }> } };
  jobs: { scenarios: { if: string; steps: Step[] } };
};
const STEPS = WF.jobs.scenarios.steps;
const SPEC = readFileSync(path.join(process.cwd(), "playwright", "scenarios", "jev-form-explorer.spec.ts"), "utf8");

const EXPLORER_ENV = "${{ (github.event_name == 'schedule' || inputs.form_explorer) && '1' || '0' }}";

describe("deal-scenarios-e2e runs the form explorer (SCRUM-771)", () => {
  const playwright = STEPS.filter((s) => s.run?.includes("playwright test"));

  it("the spec is opted in by exactly JEV_FORM_EXPLORER=1", () => {
    expect(SPEC).toContain('test.skip(process.env.JEV_FORM_EXPLORER !== "1"');
  });

  it("sets JEV_FORM_EXPLORER on the one Playwright step: always on schedule, from the input on dispatch", () => {
    expect(playwright).toHaveLength(1);
    expect(playwright[0]!.run).toBe(
      'set -o pipefail\npnpm exec playwright test -c playwright.scenarios.config.ts 2>&1 | tee "$RUNNER_TEMP/deal-scenarios-output.log"\n'
    );
    expect(playwright[0]!.env?.JEV_FORM_EXPLORER).toBe(EXPLORER_ENV);
    // Nothing may turn the step off or let its failure pass.
    expect(playwright[0]!.if).toBeUndefined();
    expect((playwright[0] as Record<string, unknown>)["continue-on-error"]).toBeUndefined();
  });

  it("leaves room for the library plus one 30-minute explorer attempt", () => {
    const job = WF.jobs.scenarios as unknown as { "timeout-minutes": number; "continue-on-error"?: unknown };
    expect(job["timeout-minutes"]).toBeGreaterThanOrEqual(10 + 45 + 30);
    // N5: a job-level continue-on-error would also turn a failed explorer green.
    expect(job["continue-on-error"]).toBeUndefined();
  });

  it("the scheduled path is still scheduled and needs no input", () => {
    expect(WF.on.schedule).toEqual([{ cron: "0 1 * * *" }]);
  });

  it("the dispatch input is a boolean that defaults to ON", () => {
    expect(WF.on.workflow_dispatch.inputs).toEqual({
      form_explorer: expect.objectContaining({ type: "boolean", default: true, required: false }),
    });
  });

  // The explorer writes; it may only ever write to this run's disposable preview.
  it("writes only to a run-created preview that is always deleted", () => {
    expect(WF.jobs.scenarios.if).toBe("github.ref == 'refs/heads/main'");
    const order = (pred: (s: Step) => boolean) => STEPS.findIndex(pred);
    const create = order((s) => !!s.run?.includes('--preview-create "$CONVEX_PREVIEW_NAME"'));
    const run = order((s) => s === playwright[0]);
    const del = order((s) => s.run === "node scripts/previewDeploymentLifecycle.mjs delete");
    expect(create).toBeGreaterThan(-1);
    expect(create).toBeLessThan(run);
    expect(del).toBeGreaterThan(run);
    expect(STEPS[del]!.if).toBe("always() && env.CONVEX_PREVIEW_CREATED_AT != ''");
    expect(playwright[0]!.env?.CONVEX_DEPLOY_KEY).toBe("${{ secrets.CONVEX_PREVIEW_DEPLOY_KEY }}");
  });
});
