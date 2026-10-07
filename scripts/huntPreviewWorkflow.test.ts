/**
 * SCRUM-768 — the hunt-preview workflow's safety properties, pinned.
 *
 * The workflow is the one place a human dispatches preview writes by hand, so
 * the properties that keep it away from production and out of the public log
 * are asserted on the file itself rather than left to review.
 */
import { readFileSync } from "node:fs";
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
});
