/**
 * SCRUM-768 — the hunt-preview workflow's safety properties, pinned.
 *
 * The workflow is the one place a human dispatches preview writes by hand, so
 * the properties that keep it away from production and out of the public log
 * are asserted on the file itself rather than left to review.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HUNT_SEAT_ROLES } from "./e2ePreviewBootstrap.mjs";

const FILE = path.join(process.cwd(), ".github", "workflows", "hunt-preview.yml");
const RAW = readFileSync(FILE, "utf8");
const WF = parse(RAW) as {
  on: { workflow_dispatch: { inputs: Record<string, { options?: string[] }> } };
  permissions: Record<string, string>;
  env: Record<string, string>;
  jobs: Record<string, { if: string; steps: { name?: string; run?: string; env?: Record<string, string> }[] }>;
};
const JOB = WF.jobs["hunt-preview"]!;

describe("hunt-preview workflow (SCRUM-768)", () => {
  it("is dispatch-only and runs only from main", () => {
    expect(Object.keys(WF.on)).toEqual(["workflow_dispatch"]);
    expect(JOB.if).toBe("github.ref == 'refs/heads/main'");
  });

  it("holds read-only repository permissions", () => {
    expect(WF.permissions).toEqual({ contents: "read" });
  });

  it("uses the preview deploy key and no other Convex credential", () => {
    const secrets = new Set(RAW.match(/secrets\.[A-Z0-9_]+/g) ?? []);
    const convexSecrets = [...secrets].filter((s) => s.includes("CONVEX"));
    expect(convexSecrets).toEqual(["secrets.CONVEX_PREVIEW_DEPLOY_KEY"]);
  });

  it("creates only with --preview-create under the fixed hunt identifier", () => {
    expect(WF.env.CONVEX_PREVIEW_NAME).toBe("scrum-760-hunt");
    const deploys = JOB.steps.filter((s) => s.run?.includes("convex deploy"));
    expect(deploys).toHaveLength(1);
    expect(deploys[0]!.run).toContain('--preview-create "$CONVEX_PREVIEW_NAME"');
  });

  it("never interpolates an expression into a shell script", () => {
    for (const step of JOB.steps) {
      expect(step.run ?? "", step.name).not.toContain("${{");
    }
  });

  // The SCRUM-377 run-scoped contract exempts this file; this is what replaces it.
  it("pins directly after create, whatever create's outcome", () => {
    const steps = JOB.steps as { name?: string; run?: string; if?: string; env?: Record<string, string> }[];
    const creates = steps.findIndex((s) => s.run?.includes("--preview-create"));
    const pins = steps.flatMap((s, i) => (s.run?.includes("previewDeploymentLifecycle.mjs pin") ? [i] : []));
    expect(pins).toEqual([creates + 1]);
    const pin = steps[creates + 1]!;
    expect(pin.if).toBe("always() && env.CONVEX_PREVIEW_URL != ''");
    expect(pin.env?.CONVEX_PREVIEW_DEPLOY_KEY).toBe("${{ secrets.CONVEX_PREVIEW_DEPLOY_KEY }}");
    expect(steps[creates]!.run).toContain(`echo "CONVEX_PREVIEW_URL=$NEXT_PUBLIC_CONVEX_URL" >> "$GITHUB_ENV"`);
  });

  it("has exactly one delete, strict, dispatch-only", () => {
    const deletes = JOB.steps.filter((s) => s.run?.includes("previewDeploymentLifecycle.mjs delete"));
    expect(deletes.map((s) => s.run)).toEqual(["node scripts/previewDeploymentLifecycle.mjs delete --strict"]);
    expect((deletes[0] as { if?: string }).if).toBe("inputs.action == 'delete'");
  });

  it("offers exactly the roles the bootstrap accepts", () => {
    expect(WF.on.workflow_dispatch.inputs.role!.options).toEqual(HUNT_SEAT_ROLES);
  });

  it("pins strictly, so a missing 12 h expiry fails the create", () => {
    const pins = JOB.steps.filter((s) => s.run?.includes("previewDeploymentLifecycle.mjs pin"));
    expect(pins.map((s) => s.run)).toEqual(["node scripts/previewDeploymentLifecycle.mjs pin --strict"]);
  });

  // The seed widens MANAGER for the scripted suite; the hunt must start on the
  // product template, before the preview is reported ready.
  it("resets the approver to the MANAGER template right after the seed, before the report", () => {
    const steps = JOB.steps as { name?: string; run?: string; if?: string }[];
    const seed = steps.findIndex((s) => s.run === "node scripts/e2ePreviewBootstrap.mjs");
    const reset = steps[seed + 1]!;
    expect(reset.run).toBe("node scripts/e2ePreviewBootstrap.mjs --set-role approver MANAGER");
    expect(reset.if).toBe("inputs.action == 'create'");
    const report = steps.findIndex((s) => s.name === "Report the hunt preview");
    expect(report).toBeGreaterThan(seed + 1);
  });

  describe("input validation (run under bash)", () => {
    const validate = JOB.steps.find((s) => s.name === "Validate inputs")!.run!;
    const dir = mkdtempSync(path.join(tmpdir(), "hunt-validate-"));
    // On Windows `bash` on PATH is often the WSL launcher, which does not forward
    // the environment, so every input would read empty and every case "pass".
    const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
    const BASH = process.platform === "win32" && existsSync(GIT_BASH) ? GIT_BASH : "bash";

    it("runs in a real bash that receives the step's environment", () => {
      const r = spawnSync(BASH, ["-c", 'printf "%s|%s" "$BASH_VERSION" "$CANARY"'], {
        env: { PATH: process.env.PATH ?? "", CANARY: "seen" } as unknown as NodeJS.ProcessEnv,
        encoding: "utf8",
      });
      if (r.error) throw r.error;
      expect(r.stdout).toMatch(/^\d+\.\d+.*\|seen$/);
    });

    function run(vars: Record<string, string>) {
      const githubEnv = path.join(dir, "env-" + Math.random().toString(36).slice(2));
      writeFileSync(githubEnv, "");
      const r = spawnSync(BASH, ["-c", validate], {
        env: { PATH: process.env.PATH ?? "", GITHUB_ENV: githubEnv, ...vars } as unknown as NodeJS.ProcessEnv,
        encoding: "utf8",
      });
      if (r.error) throw r.error; // cannot run = FAIL, never skip
      return { status: r.status, written: readFileSync(githubEnv, "utf8") };
    }

    it("accepts a create-printed name and writes only its URL", () => {
      const r = run({ ACTION: "set-role", DEPLOYMENT: "happy-otter-123", CREATED_AT: "" });
      expect(r.status).toBe(0);
      expect(r.written).toBe("HUNT_CONVEX_URL=https://happy-otter-123.convex.cloud\n");
    });

    it.each([
      ["a newline smuggling a second GITHUB_ENV line", "happy-otter-1\nNODE_OPTIONS=--require=/tmp/x"],
      ["production", "kindly-hound-172"],
      ["a URL", "https://happy-otter-1.convex.cloud"],
      ["an empty value", ""],
    ])("refuses %s and writes nothing", (_label, deployment) => {
      const r = run({ ACTION: "delete", DEPLOYMENT: deployment, CREATED_AT: "1700000000000" });
      expect(r.status).not.toBe(0);
      expect(r.written).toBe("");
    });

    it("refuses a created_at carrying a newline", () => {
      const r = run({ ACTION: "delete", DEPLOYMENT: "happy-otter-123", CREATED_AT: "1700000000000\nX=y" });
      expect(r.status).not.toBe(0);
    });
  });
});
