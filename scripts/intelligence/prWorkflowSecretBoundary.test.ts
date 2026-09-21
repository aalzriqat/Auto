import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

type Workflow = {
  on?: Record<string, unknown> | string | string[];
};

const workflowsDir = path.resolve(process.cwd(), ".github/workflows");

function directPullRequestWorkflows(): Array<{ path: string; source: string }> {
  return readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => {
      const workflowPath = path.join(workflowsDir, name);
      return {
        path: ".github/workflows/" + name,
        source: readFileSync(workflowPath, "utf8"),
      };
    })
    .filter(({ source }) => {
      const parsed = parseYaml(source) as Workflow;
      return (
        parsed.on !== null &&
        typeof parsed.on === "object" &&
        !Array.isArray(parsed.on) &&
        Object.prototype.hasOwnProperty.call(parsed.on, "pull_request")
      );
    });
}

describe("pull-request workflow secret boundary", () => {
  it("forbids repository secret references from every direct pull_request workflow", () => {
    const direct = directPullRequestWorkflows();
    expect(direct.length).toBeGreaterThan(0);

    for (const workflow of direct) {
      expect(
        workflow.source,
        workflow.path + " must be secretless because same-repository PR code controls this workflow revision.",
      ).not.toMatch(/\$\{\{\s*secrets\./);
    }
  });

  it("keeps privileged PR follow-up workflows on workflow_run rather than pull_request", () => {
    for (const name of [
      "browser-attack-swarm.yml",
      "sonar-pr-report.yml",
      "trusted-accounting-rehearsal.yml",
    ]) {
      const source = readFileSync(path.join(workflowsDir, name), "utf8");
      const parsed = parseYaml(source) as Workflow;
      expect(parsed.on).toMatchObject({ workflow_run: expect.any(Object) });
      expect(parsed.on).not.toHaveProperty("pull_request");
    }
  });

  it("keeps direct PR security and accounting lanes free of privileged runtime credentials", () => {
    const security = readFileSync(path.join(workflowsDir, "security.yml"), "utf8");
    expect(security).toContain("ci-security-placeholder.convex.cloud");
    expect(security).not.toContain("CLERK_SECRET_KEY");
    expect(security).not.toContain("NEXT_PUBLIC_CONVEX_URL: ${{ secrets.");

    const accounting = readFileSync(
      path.join(workflowsDir, "accounting-rehearsal.yml"),
      "utf8",
    );
    expect(accounting).toContain("Validate accounting rehearsal harness without credentials");
    expect(accounting).not.toContain("CONVEX_PREVIEW_DEPLOY_KEY");
    expect(accounting).not.toContain("CLERK_SECRET_KEY");

    const tests = readFileSync(path.join(workflowsDir, "test.yml"), "utf8");
    expect(tests).not.toContain("SONAR_TOKEN");
  });

  it("runs Sonar PR analysis from immutable trusted code and treats candidate inputs as data only", () => {
    const source = readFileSync(path.join(workflowsDir, "sonar-pr-report.yml"), "utf8");
    expect(source).toContain("ref: ${{ github.workflow_sha }}");
    expect(source).toContain("ref: ${{ steps.provenance.outputs.tested_sha }}");
    expect(source).toContain("path: ${{ runner.temp }}/sonar-coverage");
    expect(source).toContain("projectBaseDir: candidate");
    expect(source).toContain("autoflow/trusted-sonar-pr");
    expect(source.match(/statuses\/\$TESTED_SHA/g)?.length).toBe(2);
    expect(source).not.toContain("working-directory: candidate");
    expect(source).not.toMatch(/candidate[^\n]*pnpm\s+(?:install|run|exec)/);
  });

  it("gives candidate accounting backend only the disposable preview credential", () => {
    const source = readFileSync(
      path.join(workflowsDir, "trusted-accounting-rehearsal.yml"),
      "utf8",
    );
    expect(source).toContain("ref: ${{ github.workflow_sha }}");
    expect(source).toContain("ref: ${{ steps.provenance.outputs.tested_sha }}");
    expect(source).toContain("--env CONVEX_PREVIEW_ADMIN_KEY=\"$ADMIN_KEY\"");
    expect(source).not.toContain("--env CONVEX_PREVIEW_DEPLOY_KEY");
    expect(source).not.toContain("--env CLERK_SECRET_KEY");
    expect(source).toContain("$GITHUB_WORKSPACE/candidate:/app");
    expect(source).not.toContain("$GITHUB_WORKSPACE/trusted:/");
    expect(source).toContain("Disposable rehearsal preview environment does not match the trusted allowlist.");
    expect(source).toContain("autoflow/trusted-accounting-rehearsal");
    expect(source.match(/statuses\/\$TESTED_SHA/g)?.length).toBe(2);
  });
});
