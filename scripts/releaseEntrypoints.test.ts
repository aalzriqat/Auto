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
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");

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
