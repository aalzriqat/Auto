import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIRECTORY, "../..");

function workflowSource() {
  return fs.readFileSync(
    path.join(REPOSITORY_ROOT, ".github/workflows/test.yml"),
    "utf8",
  );
}

function jobBlock(source, jobName) {
  const escapedName = jobName.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^  ${escapedName}:\\r?\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\r?$|(?![\\s\\S]))`,
    "mu",
  ).exec(source);
  assert.ok(match, `workflow job ${jobName} must exist`);
  return match[0];
}

function namedStep(job, stepName) {
  const escapedName = stepName.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^    - name: ${escapedName}\\r?\\n([\\s\\S]*?)(?=^    - |(?![\\s\\S]))`,
    "mu",
  ).exec(job);
  assert.ok(match, `workflow step ${stepName} must exist`);
  return match[0];
}

function assertGuardrailWorkflow(source) {
  const lintJob = jobBlock(source, "lint");
  const typeCheckJob = jobBlock(source, "type-check");
  const lintStep = namedStep(lintJob, "Lint");
  const regressionStep = namedStep(lintJob, "Guardrail regression suite");
  const liveStep = namedStep(
    lintJob,
    "Maintainability, architecture, and AutoFlow safety guardrails",
  );
  const wiringStep = namedStep(
    typeCheckJob,
    "Verify guardrail workflow wiring",
  );

  for (const job of [lintJob, typeCheckJob]) {
    assert.doesNotMatch(job, /^    (?:if|needs|continue-on-error):/mu);
  }
  assert.match(lintJob, /fetch-depth:\s*0/u);
  assert.match(lintJob, /persist-credentials:\s*false/u);
  assert.match(lintStep, /run:\s*pnpm lint\s*$/mu);
  assert.match(regressionStep, /run:\s*pnpm quality:guardrails:test\s*$/mu);
  assert.match(liveStep, /run:\s*pnpm quality:guardrails\s*$/mu);
  assert.match(
    wiringStep,
    /run:\s*node --test quality\/tests\/ci-workflow\.test\.mjs\s*$/mu,
  );
  assert.ok(lintJob.indexOf(lintStep) < lintJob.indexOf(regressionStep));
  assert.ok(lintJob.indexOf(regressionStep) < lintJob.indexOf(liveStep));

  for (const step of [regressionStep, liveStep, wiringStep]) {
    assert.doesNotMatch(step, /(?:continue-on-error|if:|\|\||&&|\|\s*true)/u);
  }
}

test("the required lint job runs every guardrail with complete history", () => {
  assertGuardrailWorkflow(workflowSource());
});

test("protected guardrail jobs reject job-level skip and dependency controls", () => {
  const source = workflowSource();
  const controls = [
    "if: false",
    "needs: skipped-job",
    "continue-on-error: true",
  ];
  for (const jobName of ["lint", "type-check"]) {
    for (const control of controls) {
      const mutated = source.replace(
        new RegExp(`^  ${jobName}:\\r?$`, "mu"),
        (jobHeader) => `${jobHeader}\n    ${control}`,
      );
      assert.notEqual(mutated, source, `expected to mutate ${jobName}`);
      assert.throws(
        () => assertGuardrailWorkflow(mutated),
        undefined,
        `${jobName} must reject ${control}`,
      );
    }
  }
});

test("local aggregate scripts are the exact commands wired into CI", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"),
  );
  const regressionCommand = packageJson.scripts["quality:guardrails:test"];
  assert.equal(
    packageJson.scripts["quality:guardrails"],
    "node quality/run-all.mjs",
  );
  assert.match(regressionCommand, /^node --test /u);

  const referencedTests = [
    ...regressionCommand.matchAll(/quality\/tests\/[^\s]+\.test\.mjs/gu),
  ]
    .map((match) => match[0])
    .sort();
  const repositoryTests = fs
    .readdirSync(TEST_DIRECTORY)
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `quality/tests/${name}`)
    .sort();
  assert.deepEqual(
    referencedTests,
    repositoryTests,
    "quality:guardrails:test must execute every guardrail regression file",
  );
});

test("generated Convex freshness includes untracked outputs", () => {
  const source = workflowSource();
  const backendJob = jobBlock(source, "convex-backend");
  const freshnessStep = namedStep(
    backendJob,
    "Verify generated Convex files are committed",
  );
  assert.match(
    freshnessStep,
    /git status --porcelain=v1 --untracked-files=all/u,
  );
  assert.match(freshnessStep, /exit 1/u);
  assert.doesNotMatch(freshnessStep, /git diff --exit-code/u);
});
