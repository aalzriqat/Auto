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

  it("does not retain obsolete PR-specific privileged bootstrap workflows", () => {
    expect(readdirSync(workflowsDir)).not.toContain("sonar-bootstrap-325.yml");
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

  it("keeps expensive Tests runs single-flight per PR or ref", () => {
    const tests = readFileSync(path.join(workflowsDir, "test.yml"), "utf8");
    expect(tests).toContain(
      "group: tests-${{ github.event.pull_request.number || github.ref }}",
    );
    expect(tests).toContain("cancel-in-progress: true");
  });

  it("keeps direct PR security and accounting lanes free of privileged runtime credentials", () => {
    const security = readFileSync(path.join(workflowsDir, "security.yml"), "utf8");
    expect(security).toContain("ci-security-placeholder.convex.cloud");
    expect(security).not.toContain("CLERK_SECRET_KEY");
    expect(security).not.toContain("NEXT_PUBLIC_CONVEX_URL: ${{ secrets.");
    expect(
      security.match(
        /curl --silent --fail http:\/\/localhost:3000\/api\/health/g,
      )?.length,
    ).toBe(2);
    expect(security).not.toMatch(
      /curl --silent --fail http:\/\/localhost:3000\s/,
    );

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
    expect(source).toContain("refs/pull/${PR_NUMBER}/head:refs/autoflow/sonar-pr-head");
    expect(source).toContain("refs/pull/${PR_NUMBER}/merge:refs/autoflow/sonar-pr-merge");
    expect(source).toContain("FIRST_PARENT");
    expect(source).toContain("TRIGGER_STARTED_AT");
    expect(source).toContain("MERGE_COMMIT_EPOCH");
    expect(source).toContain("mismatched coverage provenance");
    expect(source).toContain("refs/pull/${PR_NUMBER}/merge:refs/autoflow/sonar-final-merge");
    expect(source).toContain("still-current exact merge");
    expect(source).toContain("+refs/pull/${PR_NUMBER}/merge:refs/autoflow/sonar-report-merge");
    expect(source).toContain('if [ "$current_merge" != "$TESTED_SHA" ]; then');
    expect(source.indexOf("sonar-report-merge")).toBeGreaterThan(source.indexOf("sonar-pr-report-payload.json"));
    expect(source.indexOf("sonar-report-merge")).toBeLessThan(source.indexOf("-X PATCH"));
    expect(source).toContain("tested-merge-sha.txt");
    expect(source).toContain('if [ "$coverage_merge" != "$TESTED_SHA" ]; then');
    expect(source).toContain('git merge-base --is-ancestor "$FIRST_PARENT" refs/autoflow/sonar-main');
    expect(source).toContain('if [ "$live_base_ref" != "main" ]; then');
    const tests = readFileSync(path.join(workflowsDir, "test.yml"), "utf8");
    expect(tests).toContain('printf \'%s\\n\' "$GITHUB_SHA" > coverage/tested-merge-sha.txt');
    expect(source).not.toContain("github.event.workflow_run.pull_requests[0].base.sha");
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
    expect(source).toContain("refs/pull/${PR_NUMBER}/head:refs/autoflow/accounting-pr-head");
    expect(source).toContain("refs/pull/${PR_NUMBER}/merge:refs/autoflow/accounting-pr-merge");
    expect(source).toContain('git merge-base --is-ancestor "$FIRST_PARENT" refs/autoflow/accounting-main');
    expect(source).toContain('if [ "$live_base_ref" != "main" ]; then');
    expect(source).toContain("FIRST_PARENT");
    expect(source).not.toContain("github.event.workflow_run.pull_requests[0].base.sha");
    expect(source.match(/statuses\/\$TESTED_SHA/g)?.length).toBe(2);
  });

  it("keeps Jev workflow_run analysis on immutable trusted code and the live PR base", () => {
    const source = readFileSync(path.join(workflowsDir, "jev-shadow-impact.yml"), "utf8");
    expect(source).toContain("ref: ${{ github.workflow_sha }}");
    expect(source).toContain("refs/pull/${PR_NUMBER}/head:refs/autoflow/jev-pr-head");
    expect(source).toContain("refs/pull/${PR_NUMBER}/merge:refs/autoflow/jev-pr-merge");
    expect(source).toContain('git merge-base --is-ancestor "$FIRST_PARENT" refs/autoflow/jev-main');
    expect(source).toContain('if [ "$live_base_ref" != "main" ]; then');
    expect(source).toContain("steps.pr-context.outputs.base_sha");
    expect(source).not.toContain("github.event.workflow_run.pull_requests[0].base.sha");
  });
});
