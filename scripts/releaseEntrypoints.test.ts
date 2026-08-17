/**
 * Proves the two release scripts actually START.
 *
 * Every other test in this directory imports `releaseGuard.ts` through vitest's
 * own esbuild transform — a completely different execution path from
 * `node scripts/rolloutRelease.mjs`, which is how the workflow really runs
 * them. Those scripts are plain `.mjs` importing a `.ts` module with no build
 * step and no flags, which works only because Node strips types natively. If
 * that ever stops being true — a Node version bump, a runner change, a
 * `"type"` field edit — every logic test here would still pass and the deploy
 * would fail on its first real invocation.
 *
 * This repository has already paid for that exact lesson once: a backfill
 * cleared 2,115 tests, full CI and thirteen review rounds, then failed on its
 * first production call, because `convex-test` does not enforce a limit the
 * real runtime does. Testing the logic says nothing about whether the
 * entrypoint runs.
 *
 * So these spawn the real files as real subprocesses under the real
 * interpreter, and assert a clean, intentional refusal. In CI that interpreter
 * is the pinned Node the deploy workflow uses, which is the version the answer
 * actually depends on.
 */
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const readRepoFile = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), "utf8");

/**
 * Lifts a workflow step's `run: |` block out of the YAML, verbatim.
 *
 * Textual, deliberately: the point is to execute exactly the lines GitHub will
 * execute, not a re-typed approximation of them.
 */
function extractRunBlock(workflow: string, stepName: string): string {
  const lines = workflow.split(/\r?\n/);
  const stepAt = lines.findIndex((l) => l.includes(`- name: ${stepName}`));
  expect(stepAt, `step not found: ${stepName}`).toBeGreaterThan(-1);

  const runAt = lines.findIndex((l, i) => i > stepAt && /^\s*run: \|\s*$/.test(l));
  expect(runAt, `step has no multi-line run block: ${stepName}`).toBeGreaterThan(-1);

  const indent = (lines[runAt].match(/^\s*/) ?? [""])[0].length;
  const body: string[] = [];
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== "" && (line.match(/^\s*/) ?? [""])[0].length <= indent) break;
    body.push(line.slice(indent + 2));
  }
  return body.join("\n");
}

/**
 * Runs the deploy step's real shell with `gh` and `pnpm` stubbed out.
 *
 * ⚠️ This exists because asserting on the YAML's TEXT proved nothing. The
 * earlier version of this test checked that the tip comparison appeared before
 * the CLI call and that nothing dangerous sat between them — which is still
 * true if the comparison is inverted from `!=` to `=`, or if `exit 1` is
 * deleted. Both mutations leave a workflow that deploys a stale commit, and
 * both passed.
 *
 * The stubs are shell FUNCTIONS rather than files on `PATH`, so this needs no
 * executable-bit or path-translation handling and behaves the same on Windows
 * and on the Ubuntu runner.
 */
function runDeployStep(options: { tip: string; expected: string; ghStatus?: number }) {
  const body = extractRunBlock(readRepoFile(".github/workflows/deploy-production.yml"), "Deploy Convex backend");
  const dir = mkdtempSync(path.join(tmpdir(), "autoflow-deploy-step-"));
  const marker = path.join(dir, "deployed");
  const scriptPath = path.join(dir, "step.sh");

  writeFileSync(
    scriptPath,
    [
      `gh() { if [ "$FAKE_GH_STATUS" != "0" ]; then return "$FAKE_GH_STATUS"; fi; printf '%s\\n' "$FAKE_TIP"; }`,
      `pnpm() { echo "$*" > "$MARKER"; }`,
      body,
    ].join("\n")
  );

  const result = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
    env: {
      ...process.env,
      FAKE_TIP: options.tip,
      FAKE_GH_STATUS: String(options.ghStatus ?? 0),
      MARKER: marker,
      EXPECTED_SHA: options.expected,
      REPO: "aalzriqat/Auto",
    },
  });

  return {
    status: result.status,
    deployed: existsSync(marker),
    deployedWith: existsSync(marker) ? readFileSync(marker, "utf8").trim() : null,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * Deliberately hostile, minimal environment: no GitHub context, no Convex
 * credential, and — importantly — no `GITHUB_STEP_SUMMARY`/`GITHUB_OUTPUT`, so
 * a script that tries to append to them writes nowhere instead of into a real
 * file on this machine.
 */
function runScript(script: string, overrides: Record<string, string> = {}) {
  // Built by subtraction rather than from scratch: the child still needs a
  // usable PATH and platform variables, but every input these scripts read must
  // come from this test and not from whatever CI happens to have exported.
  // Without the deletions, a run inside GitHub Actions would inherit a real
  // GITHUB_REF and quietly test something else.
  const env = { ...process.env };
  for (const key of [
    "GITHUB_REF",
    "GITHUB_REPOSITORY",
    "GITHUB_TOKEN",
    "GITHUB_OUTPUT",
    "GITHUB_STEP_SUMMARY",
    "CONVEX_DEPLOY_KEY",
    "CONVEX_DEPLOYMENT",
    "RELEASE_INPUT_SHA",
    "RELEASE_INPUT_CONFIRM",
    "CONVEX_PROD_DEPLOYMENT",
    "CONVEX_PROD_DEPLOY_KEY",
    "CONVEX_PROD_OPERATOR_KEY",
    "RELEASE_SHA",
  ]) {
    delete env[key];
  }

  return spawnSync(process.execPath, [path.join("scripts", script)], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
    timeout: 60_000,
    env: { ...env, ...overrides },
  });
}

describe("the release scripts run under the interpreter that will run them", () => {
  test("checkReleaseAuthority.mjs starts, imports its .ts module, and refuses", () => {
    // No GITHUB_REF at all, so it must refuse at the very first gate. Reaching
    // that refusal proves the `./releaseGuard.ts` import resolved and executed.
    const result = runScript("checkReleaseAuthority.mjs");

    expect(result.error, `spawn error: ${result.error?.message}`).toBeUndefined();
    expect(result.status, `stderr:\n${result.stderr}`).toBe(1);
    expect(result.stderr).toMatch(/REFUSED/);
    expect(result.stderr).toMatch(/must be run from main/i);
    // A module-resolution failure would look completely different, and this is
    // the failure mode worth naming explicitly.
    expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Unknown file extension/);
  });

  test("checkReleaseAuthority.mjs refuses an abbreviated SHA end to end", () => {
    // Exercises the pure decision layer through the real entrypoint rather than
    // through an import, so a broken wiring between the two cannot hide.
    const result = runScript("checkReleaseAuthority.mjs", {
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: "aalzriqat/Auto",
      RELEASE_INPUT_SHA: "a1b2c3d",
      RELEASE_INPUT_CONFIRM: "DEPLOY TO PRODUCTION",
    });

    expect(result.status, `stderr:\n${result.stderr}`).toBe(1);
    expect(result.stderr).toMatch(/full 40-character/i);
  });

  test("rolloutRelease.mjs starts and refuses before touching any deployment", () => {
    // No CONVEX_DEPLOY_KEY, so it must refuse at the credential gate — before
    // spawning the Convex CLI, which is what keeps this test offline and fast.
    const result = runScript("rolloutRelease.mjs");

    expect(result.error, `spawn error: ${result.error?.message}`).toBeUndefined();
    expect(result.status, `stderr:\n${result.stderr}`).toBe(1);
    expect(result.stderr).toMatch(/CONVEX_PROD_DEPLOYMENT is not set/i);
    expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Unknown file extension/);
  });

  test("assertReleaseCredentials.mjs refuses a prod key for the WRONG deployment", () => {
    // The pre-deploy gate, exercised through its real entrypoint. A valid
    // production key for another project would otherwise deploy, verify and
    // report success there.
    const result = runScript("assertReleaseCredentials.mjs", {
      CONVEX_PROD_DEPLOYMENT: "kindly-hound-172",
      CONVEX_PROD_DEPLOY_KEY: "prod:someone-elses-999|deploysecret",
      CONVEX_PROD_OPERATOR_KEY: "prod:kindly-hound-172|opsecret",
    });

    expect(result.error, `spawn error: ${result.error?.message}`).toBeUndefined();
    expect(result.status, `stderr:\n${result.stderr}`).toBe(1);
    expect(result.stderr).toMatch(/expects/i);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).not.toMatch(/deploysecret|opsecret/);
  });

  test("assertReleaseCredentials.mjs accepts two keys bound to the expected deployment", () => {
    const result = runScript("assertReleaseCredentials.mjs", {
      CONVEX_PROD_DEPLOYMENT: "kindly-hound-172",
      CONVEX_PROD_DEPLOY_KEY: "prod:kindly-hound-172|deploysecret",
      CONVEX_PROD_OPERATOR_KEY: "prod:kindly-hound-172|opsecret",
    });

    expect(result.status, `stderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/kindly-hound-172/);
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/deploysecret|opsecret/);
  });

  test("assertReleaseChecks.mjs starts, and refuses a SHA it cannot trust", () => {
    // The post-approval re-check. It runs from the CANDIDATE commit's checkout
    // and reaches the network, so what is proven here is that it starts, that
    // its two imports resolve — including the new `.mjs → .mjs → .ts` hop — and
    // that it refuses rather than proceeding when handed something that is not
    // a commit.
    const result = runScript("assertReleaseChecks.mjs", { RELEASE_SHA: "main" });

    expect(result.error, `spawn error: ${result.error?.message}`).toBeUndefined();
    expect(result.status, `stderr:\n${result.stderr}`).toBe(1);
    expect(result.stderr).toMatch(/not a full commit SHA/i);
    expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Unknown file extension/);
  });

  test("rolloutRelease.mjs refuses a preview key without ever printing it", () => {
    const result = runScript("rolloutRelease.mjs", {
      CONVEX_PROD_DEPLOYMENT: "kindly-hound-172",
      CONVEX_DEPLOY_KEY: "preview:some-team:some-project|thesecretpart",
    });

    expect(result.status, `stderr:\n${result.stderr}`).toBe(1);
    expect(result.stderr).toMatch(/PREVIEW deploy key/);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).not.toMatch(/thesecretpart/);
  });
});

/**
 * Two guarantees this repository states but could not previously prove, because
 * the code that carries them is not reachable from a unit test: a helper that
 * only runs when a real Convex CLI fails, and a step order that lives in YAML.
 *
 * The claim audit's rule was: prove a claim's reach or delete the claim. These
 * are the proofs.
 */
describe("guarantees that live outside the reach of a normal unit test", () => {
  test("the rollout script has NO path from CLI output to a public message", () => {
    // ⚠️ REGRESSION. `convex()` used to interpolate `result.stderr` into the
    // reason that `fail()` writes to the job log and the run summary — both
    // public — which reopened SCRUM-119 from two functions away.
    //
    // The failure text now comes from `describeConvexFailure`, which takes no
    // output at all. What that helper cannot do is stop a future edit from
    // reaching around it, so the call site is pinned here: this script must
    // never read the CLI's captured streams outside the JSON parser.
    const source = readRepoFile("scripts/rolloutRelease.mjs");

    expect(source).not.toMatch(/result\.stderr/);
    expect(source.match(/result\.stdout/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/parseConvexRunJson\(result\.stdout \?\? ""\)/);
    expect(source).toMatch(/describeConvexFailure\(args\[0\], result\.status\)/);
  });

  test("the deploy workflow re-verifies AFTER approval and before the deploy", () => {
    // ⚠️ Ordering is load-bearing and invisible to every other test here.
    //
    // `assertReleaseChecks.mjs` runs from the CANDIDATE commit's checkout, which
    // is only sound because the tip re-check immediately before it has just
    // proven the candidate IS main's tip. Reordering those two would have the
    // candidate commit supply the logic that judges it.
    //
    // And both must precede the credential gate and the deploy, or the whole
    // point — verify while there is still nothing to steal — is lost.
    const workflow = readRepoFile(".github/workflows/deploy-production.yml");
    const at = (needle: string) => {
      const index = workflow.indexOf(needle);
      expect(index, `missing from the workflow: ${needle}`).toBeGreaterThan(-1);
      return index;
    };

    const tipRecheck = at('tip="$(gh api "repos/${REPO}/commits/main" --jq .sha)"');
    const ciRecheck = at("node scripts/assertReleaseChecks.mjs");
    const credentials = at("node scripts/assertReleaseCredentials.mjs");
    const deploy = at("pnpm exec convex deploy");

    expect(tipRecheck).toBeLessThan(ciRecheck);
    expect(ciRecheck).toBeLessThan(credentials);
    expect(credentials).toBeLessThan(deploy);

    // ⚠️ And the tip is checked ONCE MORE inside the deploy step itself, with
    // nothing but the comparison between it and the CLI call.
    //
    // The ordering above is necessary but not sufficient: approval is
    // asynchronous, so between the first tip check and the deploy sit the CI
    // re-verification and the credential gate. A merge landing in that gap
    // ships a commit that is no longer main's tip while the summary says it is.
    // This cannot close the window — a merge can land after any check — but it
    // shrinks it from several steps to one command.
    const deployStep = workflow.slice(workflow.indexOf("Deploy Convex backend"));
    const finalTipCheck = deployStep.indexOf('tip="$(gh api');
    const cliCall = deployStep.indexOf("pnpm exec convex deploy");

    expect(finalTipCheck, "the deploy step must re-check main's tip itself").toBeGreaterThan(-1);
    expect(finalTipCheck).toBeLessThan(cliCall);

    const between = deployStep.slice(finalTipCheck, cliCall);
    expect(between).toMatch(/EXPECTED_SHA/);
    // Nothing that could take time, fetch code, or run a function may sit in
    // the gap this step exists to keep small.
    expect(between).not.toMatch(/\bnode |pnpm install|convex run|actions\//);

    // The DEPLOY job needs these to read either check surface; without them the
    // re-check fails closed on an HTTP 403 and nobody would know why.
    //
    // ⚠️ Scoped to that job on purpose. Asserting these appear "in the file"
    // passed while the permission sat only on `authorize` — mutation testing
    // caught it, which is the same lesson as the check-name collision one file
    // over: matching a string is not the same as matching the thing it names.
    const deployJob = workflow.slice(workflow.indexOf("\n  deploy:"));
    expect(deployJob).toMatch(/checks: read/);
    expect(deployJob).toMatch(/statuses: read/);
  });

  test("the deploy step's own shell REFUSES when main has moved, and deploys when it has not", () => {
    // ⚠️ REGRESSION, and the third test of mine to assert less than it looked
    // like it did. Its predecessor checked that the tip comparison appeared
    // before the CLI call with nothing dangerous in between — which stays true
    // when `!=` is flipped to `=`, or when `exit 1` is removed. Both leave a
    // workflow that ships a stale commit; both passed.
    //
    // So this executes the step's real shell instead of reading it.
    const SHA = "a".repeat(40);

    const unchanged = runDeployStep({ tip: SHA, expected: SHA });
    expect(unchanged.status, unchanged.output).toBe(0);
    expect(unchanged.deployed).toBe(true);
    expect(unchanged.deployedWith).toBe("exec convex deploy");

    // main advanced while the run waited for approval
    const moved = runDeployStep({ tip: "b".repeat(40), expected: SHA });
    expect(moved.status).not.toBe(0);
    expect(moved.deployed, "a stale commit must never reach convex deploy").toBe(false);
    expect(moved.output).toMatch(/main advanced/);

    // `gh` itself failing — rate limit, 5xx — must not authorise anything.
    //
    // ⚠️ What actually stops it is the COMPARISON, not `set -euo pipefail`. A
    // failed `gh api` writes nothing to stdout, so `tip` is empty, and an empty
    // tip never equals a 40-character SHA. Mutation testing proved this:
    // deleting `set -euo pipefail` from the step leaves every case here
    // passing, because the comparison already fails closed on an empty or
    // garbage tip. The line stays as defence for a future edit that adds a
    // command to this step, but no test proves it and this comment will not
    // claim one does.
    const apiDown = runDeployStep({ tip: SHA, expected: SHA, ghStatus: 1 });
    expect(apiDown.status).not.toBe(0);
    expect(apiDown.deployed, "an unreachable GitHub API must not authorise a deploy").toBe(false);
  });

  test("the deploy invocation stays on the narrow path, and publishes no log file", () => {
    // `-y` is what suppressed the confirmation on 2026-08-07 and is undocumented
    // in `--help`; `--cmd` runs an arbitrary command inside the deploy; `npx` is
    // free to fetch a different CLI version than the lockfile pinned.
    //
    // ⚠️ `tee deploy.log` is gone too. An earlier revision wrote it and then
    // added a step announcing the file was not uploaded as an artifact — which
    // reduced nothing, because `tee` had already streamed the same bytes to the
    // equally public job log. Removing the claim was the honest fix.
    const workflow = readRepoFile(".github/workflows/deploy-production.yml");

    // Comments are stripped first, and deliberately: this file's own header
    // explains the history by quoting `npx convex deploy`, so asserting against
    // the raw text would fail on the documentation rather than the commands.
    const commands = workflow
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");

    expect(commands.slice(commands.indexOf("Deploy Convex backend"))).toMatch(
      /^\s*pnpm exec convex deploy\s*$/m
    );
    expect(commands).not.toMatch(/tee deploy\.log/);
    expect(commands).not.toMatch(/npx convex/);
    expect(commands).not.toMatch(/convex deploy.*(--cmd|\s-y\b|--yes)/);
  });
});
