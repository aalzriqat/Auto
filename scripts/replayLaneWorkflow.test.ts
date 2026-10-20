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
type Step = {
  name?: string;
  run?: string;
  if?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  "continue-on-error"?: unknown;
};
const workflow = parse(text) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, { if?: string; steps: Step[] }>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
};
const job = workflow.jobs.replay as { if?: string; steps: Step[]; "timeout-minutes"?: number };
const trustedMain = parse(readFileSync(path.join(process.cwd(), ".github/workflows/trusted-main-e2e.yml"), "utf8")) as {
  concurrency: { group: string };
};
const steps = job.steps;
const indexOf = (needle: string) => {
  const hits = steps.flatMap((s, i) => ((s.run ?? "").includes(needle) ? [i] : []));
  expect(hits, needle).toHaveLength(1);
  return hits[0];
};

const bindIndex = () => {
  const hits = steps.flatMap((s, i) => (s.name === "Bind the replay run to this preview" ? [i] : []));
  expect(hits).toHaveLength(1);
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
    const bind = bindIndex();
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

  it("derives the run id once, and the value on Convex and the value for Playwright are that one value", () => {
    const nameStep = steps.findIndex((s) => (s.run ?? "").includes("--print-name"));
    const nameRun = steps[nameStep].run ?? "";
    // The only definition: id and attempt, charset- and length-checked against the server's contract.
    expect(nameRun).toContain('RUN_ID="${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"');
    expect(nameRun).toContain('*[!A-Za-z0-9_-]*) echo "::error::The replay run id is malformed."; exit 1 ;;');
    expect(nameRun).toContain('echo "::error::The replay run id is too long."; exit 1');
    expect(nameRun).toContain('"${#RUN_ID}" -gt 64');
    expect(nameRun).toContain('echo "E2E_REPLAY_RUN_ID=$RUN_ID" >> "$GITHUB_ENV"');
    // No other step assigns it, and none derives it from the raw run id again.
    steps.forEach((s, i) => {
      if (i === nameStep) return;
      expect(s.run ?? "", s.name).not.toMatch(/E2E_REPLAY_RUN_ID=|RUN_ID="/);
      expect(s.run ?? "", s.name).not.toMatch(/"\$GITHUB_RUN_ID"|\$\{GITHUB_RUN_ID\}/);
    });
    // Convex gets exactly the variable the name step wrote; Playwright gets the same one.
    const bind = steps[bindIndex()].run ?? "";
    expect(bind).toContain('E2E_REPLAY_RUN_ID "$E2E_REPLAY_RUN_ID"');
    expect(bind).toContain('retry_convex verify_var E2E_REPLAY_RUN_ID "$E2E_REPLAY_RUN_ID"');
    expect(bind).not.toMatch(/GITHUB_RUN_ID|GITHUB_RUN_ATTEMPT/);
    const playwright = steps.find((s) => (s.run ?? "").includes("playwright test"))!;
    expect(playwright.env?.E2E_REPLAY_RUN_ID).toBe("${{ env.E2E_REPLAY_RUN_ID }}");
    // And nothing in the workflow hands Playwright a different run id expression.
    expect(text.match(/E2E_REPLAY_RUN_ID: /g)).toHaveLength(1);
  });

  it("validates the nonce and run id against the server's contract and reads all three values back from the preview", () => {
    const run = steps[bindIndex()].run ?? "";
    expect(run).toContain('case "$NONCE" in\n  *[!0-9a-f]*)');
    expect(run).toContain('"${#NONCE}" -ne 32');
    expect(run).toContain('case "$E2E_REPLAY_RUN_ID" in');
    for (const name of ["E2E_REPLAY_RUN_NONCE", "E2E_REPLAY_RUN_ID", "E2E_REPLAY_RUN_EXPIRES_AT"]) {
      expect(run, name).toMatch(new RegExp(`retry_convex verify_var ${name} `));
    }
    expect(run).toContain('convex env get --preview-name "$CONVEX_PREVIEW_NAME" "$1" 2>/dev/null');
    // The read-backs come after every set and before the nonce reaches GITHUB_ENV.
    expect(run.lastIndexOf("convex env set")).toBeLessThan(run.indexOf("retry_convex verify_var"));
    expect(run.lastIndexOf("retry_convex verify_var")).toBeLessThan(run.indexOf('>> "$GITHUB_ENV"'));
  });

  it("expires the nonce within one hour (the server accepts at most two hours ahead, and clock drift must not refuse it)", () => {
    const run = steps[bindIndex()].run ?? "";
    const seconds = Number(/date \+%s\) \+ (\d+)\)/.exec(run)?.[1]);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(60 * 60);
  });

  it("masks the nonce and never echoes it", () => {
    const run = steps[bindIndex()].run ?? "";
    expect(run).toContain("openssl rand -hex 16");
    // The mask is the very next line after the value exists, before any validation or use.
    const lines = run.split("\n").map((l) => l.trim());
    const gen = lines.findIndex((l) => l.startsWith('NONCE="$(openssl rand -hex 16)"'));
    expect(gen).toBeGreaterThan(-1);
    expect(lines[gen + 1]).toBe('echo "::add-mask::$NONCE"');
    // The only places the value appears: the mask, a stdin pipe into the CLI, and the GITHUB_ENV file.
    const uses = run.split("\n").filter((line) => line.includes("$NONCE"));
    expect(uses.map((l) => l.trim())).toEqual([
      'echo "::add-mask::$NONCE"',
      'case "$NONCE" in',
      "printf '%s' \"$NONCE\" | pnpm exec convex env set --force --preview-name \"$CONVEX_PREVIEW_NAME\" E2E_REPLAY_RUN_NONCE >/dev/null",
      'retry_convex verify_var E2E_REPLAY_RUN_NONCE "$NONCE"',
      'echo "E2E_REPLAY_RUN_NONCE=$NONCE" >> "$GITHUB_ENV"',
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
    const bind = bindIndex();
    steps.forEach((s, i) => {
      const body = JSON.stringify(s);
      // The VALUE: $NONCE, ${NONCE, $E2E_REPLAY_RUN_NONCE, ${E2E_REPLAY_RUN_NONCE or env.E2E_REPLAY_RUN_NONCE. The
      // bare variable NAME (the invalidation loop removes it) is not the value.
      const mentions = /\$\{?NONCE|\$\{?E2E_REPLAY_RUN_NONCE|env\.E2E_REPLAY_RUN_NONCE|E2E_REPLAY_RUN_NONCE=/.test(body);
      const isPlaywright = (s.run ?? "").includes("playwright test");
      if (i !== bind && !isPlaywright) expect(mentions, s.name).toBe(false);
      // A bare `env`, `printenv`, `set` (no flags), `export -p` or `declare -p` dumps every variable, masked or not.
      expect(s.run ?? "", s.name).not.toMatch(/(^|[;&|]\s*|\n\s*)(env|printenv|set|export -p|declare -p|compgen -v)\s*(\||;|$|\n)/);
    });
  });

  it("names the preview before create, from this run, and every step uses that one name", () => {
    const nameStep = steps.findIndex((s) => (s.run ?? "").includes("--print-name"));
    const create = indexOf("--preview-create");
    expect(nameStep).toBeGreaterThan(-1);
    expect(nameStep).toBeLessThan(create);
    expect(steps[nameStep].run).toContain('--print-name "$GITHUB_REF/replay-lane/$RUN_ID"');
    expect(steps[create].run).toContain('--preview-create "$CONVEX_PREVIEW_NAME"');
    // No step may take the name from an output of create or pin.
    expect(text).not.toMatch(/steps\.[\w-]+\.outputs\.preview_name|needs\.[\w-]+\.outputs/);
  });

  it("pins strictly with a short backstop, and deletes strictly under always(), followed only by the summary upload", () => {
    const pinStep = steps[indexOf("previewDeploymentLifecycle.mjs pin")];
    expect(pinStep.run?.trim()).toBe("node scripts/previewDeploymentLifecycle.mjs pin --strict");
    expect(pinStep.if).toBe("always() && env.CONVEX_PREVIEW_URL != ''");
    const ttl = Number(pinStep.env?.CONVEX_PREVIEW_PIN_TTL_MS);
    expect(ttl).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(2 * 60 * 60 * 1000);
    const delIndex = indexOf("previewDeploymentLifecycle.mjs delete");
    const del = steps[delIndex];
    // Only the always() upload of the counts-only summary may follow the delete.
    const after = steps.slice(delIndex + 1);
    expect(after.map((x) => x.name)).toEqual(["Upload the replay lane summary"]);
    expect(after[0].uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}/);
    expect(after[0].if).toBe("always()");
    expect(del.run?.trim()).toBe("node scripts/previewDeploymentLifecycle.mjs delete --strict");
    expect(del.if).toBe("always() && env.CONVEX_PREVIEW_CREATED_AT != ''");
    expect(del.env?.CONVEX_PREVIEW_DEPLOY_KEY).toBe("${{ secrets.CONVEX_PREVIEW_DEPLOY_KEY }}");
    expect(steps.filter((s) => (s.run ?? "").includes("previewDeploymentLifecycle.mjs delete"))).toHaveLength(1);
  });

  it("removes the three run variables from the preview, by name, always, before the delete", () => {
    const inv = steps.findIndex((s) => s.name === "Invalidate the replay attestation");
    expect(inv).toBeGreaterThan(-1);
    const del = indexOf("previewDeploymentLifecycle.mjs delete");
    expect(inv).toBeLessThan(del);
    // Nothing between the invalidation and the delete could make the delete wait on something that may not run.
    expect(del - inv).toBe(1);
    const step = steps[inv];
    expect(step.if).toBe("always() && env.CONVEX_PREVIEW_URL != ''");
    expect(step.env?.CONVEX_DEPLOY_KEY).toBe("${{ secrets.CONVEX_PREVIEW_DEPLOY_KEY }}");
    const run = step.run ?? "";
    expect(run).toContain("for VAR in E2E_REPLAY_RUN_NONCE E2E_REPLAY_RUN_ID E2E_REPLAY_RUN_EXPIRES_AT; do");
    expect(run).toContain('pnpm exec convex env remove --preview-name "$CONVEX_PREVIEW_NAME" "$VAR" >/dev/null 2>&1');
    expect(run).not.toMatch(/--prod|--deployment|--url|--admin-key/);
    // Same preview-only guards as the bind step, before any removal.
    for (const guard of ["e2e-main-replay-lane-*", "preview:*", 'if [ -n "${CONVEX_DEPLOYMENT:-}" ]']) {
      expect(run.indexOf(guard), guard).toBeGreaterThan(-1);
      expect(run.indexOf(guard), guard).toBeLessThan(run.indexOf("convex env remove"));
    }
    // Cleanup comes after the proof step and ahead of the upload.
    expect(inv).toBeGreaterThan(steps.findIndex((x) => x.name === "Assert the replay ran"));
    // A removal that fails is a warning, never an abort of the loop or of the step that precedes the delete.
    expect(run).toContain("::warning::");
    expect(run).not.toMatch(/set -[a-z]*e/);
    // It never prints a value: only the variable name, and no output of the CLI.
    expect(run).not.toMatch(/\$NONCE|E2E_REPLAY_RUN_NONCE\}|env\.E2E_REPLAY/);
  });

  describe("anti-skip wiring (a skipped or unproven replay must fail the job)", () => {
    const playwrightIndex = () => steps.findIndex((x) => (x.run ?? "").includes("playwright test"));
    const assertIndex = () => steps.findIndex((x) => (x.run ?? "").includes("assertReplayLaneRan.mjs"));

    it("runs the assert step always(), after Playwright, reading the file Playwright writes", () => {
      const pw = playwrightIndex();
      const as = assertIndex();
      expect(pw).toBeGreaterThan(-1);
      expect(as).toBeGreaterThan(pw);
      expect(steps[as].if).toBe("always()");
      const reportFile = steps[pw].env?.PLAYWRIGHT_JSON_OUTPUT_NAME;
      expect(reportFile).toMatch(/^[\w.-]+\.json$/);
      const words = (steps[as].run ?? "").trim().split(/\s+/);
      expect(words.slice(0, 2)).toEqual(["node", "scripts/assertReplayLaneRan.mjs"]);
      expect(words[2]).toBe(reportFile);
      expect(steps.filter((x) => (x.run ?? "").includes("assertReplayLaneRan.mjs"))).toHaveLength(1);
    });

    it("runs Playwright with no retries, the chromium project and a json reporter", () => {
      const cmd = (steps[playwrightIndex()].run ?? "").replace(/\s+/g, " ").trim();
      expect(cmd).toContain("playwright test playwright/tests/accounting.spec.ts");
      expect(cmd).toMatch(/--retries=0(\s|$)/);
      expect(cmd).toMatch(/--project=chromium(\s|$)/);
      expect(cmd).toMatch(/--reporter=[\w,]*json[\w,]*(\s|$)/);
    });

    it("lets none of Playwright, Assert, Bind, Pin or Delete continue on error", () => {
      for (const name of [
        "Run the accounting replay spec",
        "Assert the replay ran",
        "Bind the replay run to this preview",
        "Pin the disposable preview for cleanup",
        "Delete the disposable preview",
      ]) {
        const step = steps.find((x) => x.name === name);
        expect(step, name).toBeDefined();
        expect(step!["continue-on-error"], name).toBeUndefined();
      }
      expect(text).not.toMatch(/continue-on-error/);
    });

    it("uploads only the counts-only summary the assert step writes, never test output", () => {
      const upload = steps.find((x) => x.name === "Upload the replay lane summary")!;
      const written = (steps[assertIndex()].run ?? "").trim().split(/\s+/)[3];
      expect(written).toBe("replay-lane-summary.md");
      expect(upload.with?.path).toBe(written);
      expect(String(upload.with?.path)).not.toMatch(/test-results|playwright-report|\*|\//);
      expect(steps.filter((x) => (x.uses ?? "").includes("upload-artifact"))).toHaveLength(1);
    });

    it("has its own concurrency group, distinct from the trusted-main lane, and a bounded timeout", () => {
      const group = workflow.concurrency?.group;
      expect(group).toMatch(/^trusted-main-replay-playwright-/);
      expect(group).not.toBe(trustedMain.concurrency.group);
      expect(group!.startsWith(trustedMain.concurrency.group.replace(/\$\{\{.*$/, ""))).toBe(false);
      expect(job["timeout-minutes"]).toBeGreaterThan(0);
      expect(job["timeout-minutes"]).toBeLessThanOrEqual(60);
    });

    it("gates the bind step on the earlier steps succeeding: no always(), after pin", () => {
      const bind = steps[bindIndex()];
      expect(bind.if).toBeUndefined();
      expect(bindIndex()).toBeGreaterThan(indexOf("previewDeploymentLifecycle.mjs pin"));
      // Nothing between create and bind may restore the always() path to it.
      const create = indexOf("--preview-create");
      for (const step of steps.slice(create + 2, bindIndex())) expect(step.if ?? "", step.name).not.toMatch(/always\(\)/);
    });

    it("verify_var really compares: its last command is the equality test of the value read against the expected one", () => {
      const run = steps[bindIndex()].run ?? "";
      const body = /verify_var\(\) \{\n([\s\S]*?)\n\}/.exec(run)?.[1] ?? "";
      const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
      expect(lines).toEqual([
        "local got",
        'got="$(pnpm exec convex env get --preview-name "$CONVEX_PREVIEW_NAME" "$1" 2>/dev/null)" || return 1',
        '[ "$got" = "$2" ]',
      ]);
    });
  });
});
