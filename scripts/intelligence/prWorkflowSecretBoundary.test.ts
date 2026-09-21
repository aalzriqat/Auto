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
      if (workflow.path === ".github/workflows/sonar-bootstrap-325.yml") {
        continue;
      }
      expect(
        workflow.source,
        workflow.path + " must be secretless because same-repository PR code controls this workflow revision.",
      ).not.toMatch(/\$\{\{\s*secrets\./);
    }
  });

  it("allows only the one-time PR 325 Sonar bootstrap secret on the pinned scanner action", () => {
    const source = readFileSync(
      path.join(workflowsDir, "sonar-bootstrap-325.yml"),
      "utf8",
    );
    const parsed = parseYaml(source) as {
      on?: Record<string, unknown>;
      jobs?: Record<
        string,
        {
          if?: string;
          permissions?: Record<string, string>;
          steps?: Array<{
            name?: string;
            uses?: string;
            run?: string;
            env?: Record<string, string>;
            with?: Record<string, unknown>;
          }>;
        }
      >;
    };

    expect(parsed.on).toHaveProperty("pull_request");
    const job = parsed.jobs?.["sonar-bootstrap-325"];
    expect(job).toBeDefined();
    expect(job?.if).toContain("github.event.pull_request.number == 325");
    expect(job?.if).toContain(
      "github.event.pull_request.head.ref == 'agent/scrum-350-browser-swarm'",
    );
    expect(job?.if).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(job?.permissions).toEqual({ contents: "read" });

    const steps = job?.steps ?? [];
    const scanner = steps.find(
      (step) => step.name === "SonarCloud bootstrap scan for PR 325 only",
    );
    expect(scanner?.uses).toBe(
      "SonarSource/sonarqube-scan-action@22918119ff8e1ca75a623e15c8296b6ea4fbe28f",
    );
    expect(scanner?.env).toEqual({
      SONAR_TOKEN: "${{ secrets.SONAR_TOKEN }}",
    });

    for (const step of steps) {
      if (step === scanner) continue;
      expect(JSON.stringify(step)).not.toMatch(/\$\{\{\s*secrets\./);
      expect(step.run ?? "").not.toContain("SONAR_TOKEN");
    }

    expect(source.match(/\$\{\{\s*secrets\./g)?.length).toBe(1);
    expect(source).toContain("pnpm install --frozen-lockfile --ignore-scripts");
    expect(source).toContain("git ls-files -s");
    expect(source).toContain("'$1 == \"120000\" { found=1 }");
    expect(source).not.toContain("find . -path './.git'");
    expect(source).toContain("git show \"$BASE_SHA:sonar-project.properties\"");
    expect(source).toContain("-Dsonar.pullrequest.key=325");
    expect(source).toContain(
      "-Dsonar.scm.revision=${{ github.event.pull_request.head.sha }}",
    );
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
