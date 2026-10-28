import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isPreviewDeployKey } from "../e2ePreviewBootstrap.mjs";
import { deletePreviewStrict, deploymentNameFromUrl, pinPreview } from "../previewDeploymentLifecycle.mjs";
import { linkReplayDependencies, readBrowserReport } from "./oracleReplay.mjs";
import { fetchClerkTestJwtPem } from "./clerkPublicJwtKey.mjs";
import { buildEgressAllowlist, startEgressProxy } from "./browserEgressContainment.mjs";

const unavailable = reason => ({ state: "unavailable", findings: [], tests: 0, reason });
const BROWSER_FILES = ["cross-screen-oracle.spec.ts", "jev-explorer.spec.ts", "jev-form-explorer.spec.ts"];
const INVARIANTS = ["TEN-1", "AUTH-1", "ECON-1", "ACC-1", "ACC-2", "CONS-1", "LIFE-1", "UI-1"];

function stopChild(child) {
  if (child?.pid) {
    try { process.kill(-child.pid, "SIGTERM"); }
    catch { child.kill("SIGTERM"); }
  }
}

function runBrowserProcess(args, directory, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: directory, env, stdio: "ignore", detached: true });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; stopChild(child); }, 3_600_000);
    child.once("error", () => { clearTimeout(timeout); resolve(null); });
    child.once("close", code => { clearTimeout(timeout); resolve(timedOut ? null : code); });
  });
}

async function stopApplication(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, 5_000);
    child.once("close", () => { clearTimeout(timer); resolve(); });
    stopChild(child);
  });
}

async function waitForApplication(server) {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (server.exitCode !== null) throw new Error("HISTORICAL_APP_EXITED");
    try {
      const response = await fetch("http://127.0.0.1:3000/api/health", { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch { /* The bounded startup window is still open. */ }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error("HISTORICAL_APP_DID_NOT_START");
}

function command({ root, directory, args, env, timeout = 180_000 }) {
  const result = spawnSync(process.execPath, [path.join(root, "node_modules/convex/bin/main.js"), ...args], {
    cwd: directory, env, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
  if (result.status !== 0) throw new Error("PREVIEW_COMMAND_FAILED");
  return result.stdout;
}

function jsonFile(filename) {
  try { return JSON.parse(readFileSync(filename, "utf8")); }
  catch { return undefined; }
}

function findObservation(directory, basename, report) {
  const found = [];
  const visit = folder => {
    if (!existsSync(folder)) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("OBSERVATION_SYMLINK_REFUSED");
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.name === basename) found.push(jsonFile(filename));
    }
  };
  visit(directory);
  const visitAttachments = suites => {
    for (const suite of suites ?? []) {
      visitAttachments(suite.suites);
      for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) for (const result of test.results ?? []) {
        for (const attachment of result.attachments ?? []) if (attachment.name === basename) {
          const filename = attachment.path && path.resolve(attachment.path);
          if (filename && path.relative(directory, filename).startsWith("..")) throw new Error("OBSERVATION_PATH_REFUSED");
          if (filename) found.push(jsonFile(filename));
          else if (attachment.body) found.push(JSON.parse(Buffer.from(attachment.body, "base64").toString("utf8")));
        }
      }
    }
  };
  if (found.length === 0) visitAttachments(report?.suites);
  // Stale, retried or duplicate observations cannot silently replace one another.
  return found.length === 1 ? found[0] : undefined;
}

/** Runs only in the dispatch workflow. No corpus labels or witnesses enter this module. */
async function runBrowserSubject({ directory, root }) {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REF !== "refs/heads/main" ||
      !isPreviewDeployKey(process.env.CONVEX_PREVIEW_DEPLOY_KEY) ||
      !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_")) return unavailable("TRUSTED_MAIN_PREVIEW_DISPATCH_REQUIRED");
  const started = Date.now();
  const previewName = `g6-${process.env.GITHUB_RUN_ID}-${randomBytes(5).toString("hex")}`;
  const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "CI"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { CI: "true", CONVEX_DEPLOY_KEY: process.env.CONVEX_PREVIEW_DEPLOY_KEY, CONVEX_PREVIEW_NAME: previewName });
  const lifecycle = { CONVEX_PREVIEW_DEPLOY_KEY: process.env.CONVEX_PREVIEW_DEPLOY_KEY, CONVEX_PREVIEW_NAME: previewName };
  const cleanupDependencies = linkReplayDependencies(directory, root);
  let verdict = unavailable("PREVIEW_OR_BROWSER_EXECUTION_FAILED");
  let proxy;
  let server;
  try {
    // This flag refuses non-preview keys in the CLI, in addition to our local check.
    command({ root, directory, env, args: ["deploy", "--yes", "--typecheck", "enable", "--preview-create", previewName,
      "--cmd-url-env-var-name", "CREATED_CONVEX_URL", "--cmd",
      'node -e "require(\'node:fs\').writeFileSync(\'created-url.txt\',process.env.CREATED_CONVEX_URL)"',
      "--preview-run", "e2eBootstrap:markPreviewDeployment"], timeout: 300_000 });
    lifecycle.CONVEX_PREVIEW_URL = readFileSync(path.join(directory, "created-url.txt"), "utf8").trim();
    deploymentNameFromUrl(lifecycle.CONVEX_PREVIEW_URL);
    lifecycle.CONVEX_PREVIEW_CREATED_AT = String((await pinPreview({ env: lifecycle })).createdAt);
    const currentNames = command({ root, directory, env, args: ["env", "list", "--names-only", "--preview-name", previewName] })
      .trim().split(/\r?\n/).filter(Boolean);
    const allowed = new Set(["AUTOFLOW_DEPLOYMENT_CLASS", "CLERK_DEV_JWT_ISSUER_DOMAIN", "CLERK_JWT_ISSUER_DOMAIN", "NEXT_PUBLIC_APP_URL", "TURNSTILE_SECRET_KEY"]);
    for (const name of currentNames) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("UNREADABLE_PREVIEW_ENV_NAMES");
      if (!allowed.has(name)) command({ root, directory, env, args: ["env", "remove", name, "--preview-name", previewName] });
    }
    command({ root, directory, env, args: ["env", "set", "TURNSTILE_SECRET_KEY", "1x0000000000000000000000000000000AA", "--force", "--preview-name", previewName] });
    Object.assign(env, { NEXT_PUBLIC_CONVEX_URL: lifecycle.CONVEX_PREVIEW_URL,
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA", NEXT_PUBLIC_APP_URL: "http://localhost:3000" });
    env.CLERK_JWT_KEY = await fetchClerkTestJwtPem({ publishableKey: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY });
    // The seed implementation and inputs are the parent's files, never the fix's regression fixtures.
    if (!existsSync(path.join(directory, "scripts/e2ePreviewBootstrap.mjs"))) throw new Error("NO_PRE_FINDING_BOOTSTRAP");
    const credentials = Object.fromEntries(["CLERK_SECRET_KEY", "E2E_LOGIN_USER", "E2E_LOGIN_PASSWORD", "E2E_LOGIN_VERIFICATION_CODE",
      "E2E_APPROVER_USER", "E2E_APPROVER_PASSWORD"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const bootstrap = spawnSync(process.execPath, ["scripts/e2ePreviewBootstrap.mjs"], {
      cwd: directory, env: { ...env, ...credentials }, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (bootstrap.status !== 0) throw new Error("HISTORICAL_BOOTSTRAP_UNAVAILABLE");
    const attestation = spawnSync(process.execPath, [path.join(root, "scripts/e2ePreviewBootstrap.mjs"), "--assert-only"], {
      cwd: directory, env: { ...env, ...credentials }, timeout: 180_000, stdio: "pipe",
    });
    if (attestation.status !== 0) throw new Error("TRUSTED_PREVIEW_ATTESTATION_FAILED");
    const appEnvironment = { ...env, CONVEX_DEPLOY_KEY: "", PLAYWRIGHT_BASE_URL: "http://127.0.0.1:3000" };
    const build = spawnSync(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "build"], {
      cwd: directory, env: appEnvironment, timeout: 300_000, stdio: "pipe", maxBuffer: 8 * 1024 * 1024,
    });
    if (build.status !== 0) throw new Error("HISTORICAL_APP_BUILD_UNAVAILABLE");
    server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", "3000"], {
      cwd: directory, env: appEnvironment, stdio: "ignore", detached: true,
    });
    server.once("error", () => { /* The bounded readiness check records an unavailable application. */ });
    await waitForApplication(server);
    proxy = await startEgressProxy({ port: 0, allow: buildEgressAllowlist({
      candidateOrigin: "http://127.0.0.1:3000", convexUrl: env.NEXT_PUBLIC_CONVEX_URL,
      clerkPublishableKey: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    }) });
    const output = path.join(directory, "browser-observations");
    mkdirSync(output);
    const config = path.join(directory, "browser.config.ts");
    const results = path.join(output, "results.json");
    writeFileSync(config, `import {defineConfig} from ${JSON.stringify(path.join(root, "node_modules/@playwright/test/index.mjs"))};
import base from ${JSON.stringify(path.join(root, "playwright.scenarios.config.ts"))};
export default defineConfig({...base, retries:0, workers:1, outputDir:${JSON.stringify(output)},
 reporter:[["json",{outputFile:${JSON.stringify(results)}}]],
 webServer:undefined,
 projects:[{...base.projects[0]},
 {...base.projects[1],name:"period",testDir:${JSON.stringify(path.join(root, "playwright/tests"))},testMatch:"**/browser-swarm-accounting-period.spec.ts"},
 {...base.projects[1],dependencies:["period"],testMatch:${JSON.stringify(BROWSER_FILES.map(name => "**/" + name))}},
 {...base.projects[1],name:"swarm",dependencies:["period"],testDir:${JSON.stringify(path.join(root, "scripts/intelligence"))},testMatch:"**/oracleReplaySwarm.spec.ts"}]});`);
    const browserStatus = await runBrowserProcess([path.join(root, "node_modules/@playwright/test/cli.js"), "test", "--config", config, "--workers=1"], directory, {
      ...env, ...credentials, CROSS_SCREEN_ORACLE: "1", JEV_FORM_EXPLORER: "1", JEV_EXPLORER_SEED: "344", JEV_FORM_EXPLORER_SEED: "344",
      PLAYWRIGHT_BASE_URL: "http://127.0.0.1:3000", PLAYWRIGHT_SKIP_WEBSERVER: "1",
      BROWSER_EGRESS_PROXY_SERVER: `http://127.0.0.1:${proxy.port}`, BROWSER_EGRESS_REQUIRED: "1",
      BROWSER_SWARM_ENABLED: "1", BROWSER_SWARM_PREVIEW_ATTESTED: "1", BROWSER_SWARM_PERIOD_SETUP: "1",
      BROWSER_SWARM_TRUSTED_EXTERNAL_SERVER: "1", BROWSER_SWARM_WORKER_COUNT: "1", BROWSER_SWARM_WORKER_ID: "worker-1",
      BROWSER_SWARM_RUN_ID: `gh-${process.env.GITHUB_RUN_ID}-${randomBytes(4).toString("hex")}`,
      BROWSER_SWARM_IMPACTED_INVARIANTS_JSON: JSON.stringify(INVARIANTS.map(id => ({ id, severity: "HIGH" }))),
    });
    const report = jsonFile(results);
    verdict = readBrowserReport(report, {
      cross: findObservation(output, "cross-screen-observations.json", report),
      explorer: findObservation(output, "jev-explorer-findings.json", report),
      forms: findObservation(output, "jev-form-explorer.json", report),
      swarm: findObservation(output, "browser-swarm-execution.json", report),
      manifest: findObservation(output, "browser-swarm-manifest.json", report),
      invocations: findObservation(output, "oracle-invocations.json", report),
    }, browserStatus);
  } catch {
    // Fixed diagnostic only. Neither CLI output nor backend error text reaches public logs.
    verdict = unavailable("PREVIEW_OR_BROWSER_EXECUTION_FAILED");
  } finally {
    await stopApplication(server);
    proxy?.stop();
    try {
      // A failed deploy may already have created a preview. Pin its returned URL before cleanup.
      if (!lifecycle.CONVEX_PREVIEW_URL && existsSync(path.join(directory, "created-url.txt"))) {
        lifecycle.CONVEX_PREVIEW_URL = readFileSync(path.join(directory, "created-url.txt"), "utf8").trim();
        lifecycle.CONVEX_PREVIEW_CREATED_AT = String((await pinPreview({ env: lifecycle })).createdAt);
      }
      if (lifecycle.CONVEX_PREVIEW_URL && !lifecycle.CONVEX_PREVIEW_CREATED_AT) lifecycle.CONVEX_PREVIEW_CREATED_AT = String((await pinPreview({ env: lifecycle })).createdAt);
      if (lifecycle.CONVEX_PREVIEW_CREATED_AT) await deletePreviewStrict({ env: lifecycle });
    } catch { verdict = unavailable("PREVIEW_CLEANUP_FAILED"); }
    cleanupDependencies();
  }
  return { ...verdict, durationMs: Date.now() - started };
}

export async function runBrowserPair({ fixed, bug, root }) {
  return { fixed: await runBrowserSubject({ directory: fixed, root }), bug: await runBrowserSubject({ directory: bug, root }) };
}
