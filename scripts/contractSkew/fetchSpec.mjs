/**
 * Obtain the function spec of a Convex deployment, and prove WHICH deployment.
 *
 * ⚠️ The dangerous failure here is not "no spec". It is a spec from the wrong
 * deployment. A preview key makes every Convex command address a preview
 * deployment, which would answer every question confidently about a backend no
 * user is served by — the same shape as the 2026-08-07 targeting error, and the
 * reason `deploy-production.yml` deliberately does not name its secrets
 * `CONVEX_DEPLOY_KEY`. So the deployment URL is asserted against the expected
 * one, and a mismatch is a hard failure rather than a warning.
 *
 * ⚠️ Missing credentials produce UNAVAILABLE, never PASS. An unexecuted check
 * that reports success is worse than no check.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Strip anything credential-shaped before it reaches a log.
 *
 * ⚠️ This is not paranoia about a hypothetical sink. The scheduled job runs in
 * GitHub Actions on a PUBLIC repository, so everything it prints is published —
 * the same property `deploy-production.yml` documents about `convex deploy`
 * output. And the Convex CLI does echo credential-derived material back in
 * errors: a malformed configuration produced
 * `.../api/deployment/%20auto/team_and_project`, echoing the deployment portion
 * it had parsed. A deploy key is `prod:<deployment>|<secret>`, so the same class
 * of message can carry the secret half.
 *
 * Two passes, because neither alone is enough: exact values of credentials we
 * know we passed (precise, catches any shape), and the structural key pattern
 * (catches a credential we did not supply, such as one read from a config file).
 */
export function redact(text) {
  let out = String(text ?? "");
  // Every secret-shaped value this process was HANDED, by exact match.
  //
  // Widened from three named variables to any KEY/TOKEN/SECRET/PASSWORD in
  // the environment: the cross-family reviewer pointed out that a Convex or
  // Node error can carry a credential this list never mentioned, and the
  // earlier version only knew about three. Exact-value matching cannot
  // over-redact, which matters here — an earlier pattern-based attempt ate
  // literal-union signatures and destroyed the diagnostic.
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length <= 8) continue;
    if (!/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name)) continue;
    out = out.split(value).join("[REDACTED]");
  }
  // ⚠️ Anchored on the actual Convex key prefixes rather than "anything with a
  // pipe in it". The looser pattern also ate literal-union signatures — a
  // validator rendered as `OPENING_STOCK|SOMETHINGLONGENOUGH` matched it — which
  // would have silently destroyed the diagnostic this tool exists to produce.
  // An over-eager redactor is its own kind of unreadable log.
  out = out.replace(/\b(prod|dev|preview|project):[A-Za-z0-9_-]+\|[A-Za-z0-9+/=_-]{12,}/g, "[REDACTED]");
  // `Bearer <token>` is an unambiguous shape and appears in HTTP error
  // echoes. Anchored on the keyword so it cannot swallow ordinary text.
  return out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]");
}

/**
 * Read a spec file from a BOUNDED location.
 *
 * ⚠️ Every path that reaches the filesystem goes through here — the live spec,
 * a rendered current spec, and a release candidate alike. An earlier revision
 * bounded only the first of those, so adding `--current` quietly reopened the
 * same door two more times. One reader means one place where the rule lives,
 * and no way to add a third caller that forgets it.
 *
 * ⚠️ Bounded rather than arbitrary: this runs unattended and is invoked by
 * agents as well as people, and a spec path is legitimately either inside the
 * workspace or a downloaded artifact in the temp directory.
 *
 * ⚠️ realpath, not resolve. `path.resolve` collapses `..` but does NOT follow
 * symlinks, so a link sitting inside the workspace and pointing anywhere on the
 * filesystem would pass a purely lexical check. Both sides are canonicalized so
 * the comparison is between real locations.
 */
export function readSpecFile(specFile) {
  let canonical;
  try {
    canonical = fs.realpathSync(path.resolve(specFile));
  } catch {
    throw new Error(`No readable spec file at ${specFile}`);
  }
  const allowed = [process.cwd(), os.tmpdir()].flatMap((dir) => {
    try {
      return [fs.realpathSync(path.resolve(dir))];
    } catch {
      return [];
    }
  });
  const inside = (dir) => canonical === dir || canonical.startsWith(dir + path.sep);
  if (!allowed.some(inside)) {
    throw new Error(
      `Refusing to read a spec from outside the workspace or temp directory: ${canonical}`
    );
  }
  return JSON.parse(fs.readFileSync(canonical, "utf8"));
}

/** Ladder rungs, most-preferred first. Each names WHY it is where it is. */
export const RUNGS = [
  {
    name: "REPO_READ_KEY",
    env: "CONVEX_PROD_READ_KEY",
    unattended: true,
    note: "repository secret, read-only scope — the only rung a scheduled run can reach",
  },
  {
    name: "ENV_OPERATOR_KEY",
    env: "CONVEX_PROD_OPERATOR_KEY",
    unattended: false,
    note: "environment secret on `production`; reaching it requires a human approval per run",
  },
];

// ⚠️ On Windows `pnpm` is a `.cmd` shim. execFileSync cannot resolve it at all
// without a shell (`ENOENT`), and since the CVE-2024-27980 fix Node refuses to
// spawn `.cmd` without one even when found (`EINVAL`). CI is Linux, so this
// would only ever have broken for a human reproducing a scheduled result
// locally — precisely when a control most needs to work. The arguments are
// internal constants and the credential travels in `env`, never in argv, so
// enabling the shell adds no injection surface.
const IS_WINDOWS = process.platform === "win32";
const PNPM = IS_WINDOWS ? "pnpm.cmd" : "pnpm";

function runConvex(args, env) {
  return execFileSync(PNPM, ["exec", "convex", ...args], {
    shell: IS_WINDOWS,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * @param {{ specFile?: string, expectedDeployment?: string, allowWorkstation?: boolean }} options
 * @returns {{ ok: true, spec: object, url: string, rung: string }
 *          | { ok: false, unavailable: true, reason: string, tried: string[] }}
 */
export function fetchDeployedSpec(options = {}) {
  const { specFile, expectedDeployment, allowWorkstation = false } = options;
  const tried = [];

  // An explicitly supplied spec file is not a credential rung — it is evidence
  // handed in by the caller, and it is still identity-checked below.
  if (specFile) {
    return finish(readSpecFile(specFile), "SUPPLIED_FILE", expectedDeployment);
  }

  for (const rung of RUNGS) {
    const key = process.env[rung.env];
    if (!key) {
      tried.push(`${rung.name}: absent (${rung.note})`);
      continue;
    }
    try {
      // No `--prod`: the deploy key itself selects the deployment. Passing both
      // invites a disagreement between them that neither side reports.
      const out = runConvex(["function-spec"], { CONVEX_DEPLOY_KEY: key });
      return finish(JSON.parse(out), rung.name, expectedDeployment);
    } catch (error) {
      tried.push(`${rung.name}: failed — ${firstLine(error)}`);
    }
  }

  // The workstation account token can read production, but it is also the
  // credential that can DEPLOY production. It is never a CI rung; it exists so
  // a human can reproduce a scheduled result locally.
  if (allowWorkstation) {
    try {
      // ⚠️ `--prod` selects the production deployment OF A CONFIGURED PROJECT.
      // Without `CONVEX_DEPLOYMENT` (normally from `.env.local`) the CLI has no
      // project to resolve and fails with "No CONVEX_DEPLOYMENT set" — which is
      // a configuration gap, not an authorization one, and the two must not be
      // reported as the same thing.
      const out = runConvex(["function-spec", "--prod"], {});
      return finish(JSON.parse(out), "WORKSTATION_ACCOUNT", expectedDeployment);
    } catch (error) {
      tried.push(`WORKSTATION_ACCOUNT: failed — ${firstLine(error)}`);
    }
  } else {
    tried.push("WORKSTATION_ACCOUNT: not attempted (requires --allow-workstation)");
  }

  return {
    ok: false,
    unavailable: true,
    reason: "no credential could read the production function spec",
    tried,
  };
}

// ⚠️ The Convex CLI prints Node and npm warnings to stderr before anything
// real. Reporting the first stderr line verbatim made a failed fetch read
// "ExperimentalWarning: localStorage is not available", while the actual cause
// ("Couldn't parse deployment name") sat two lines below it. A control whose
// failure message names the wrong thing costs more time than one that says
// nothing at all.
const NOISE = /ExperimentalWarning|trace-warnings|npm warn|Unknown project config|^\(node:\d+\)/;

function firstLine(error) {
  for (const stream of [error?.stderr, error?.stdout, error?.message]) {
    const line = String(stream ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !NOISE.test(l));
    if (line) return redact(line);
  }
  return "unknown error";
}

function finish(spec, rung, expectedDeployment) {
  const url = typeof spec?.url === "string" ? spec.url : "";
  if (expectedDeployment) {
    // `https://kindly-hound-172.convex.cloud` must contain the expected name.
    const host = url.replace(/^https?:\/\//, "").split(".")[0];
    if (host !== expectedDeployment) {
      throw new Error(
        `Spec is from deployment "${host}" but "${expectedDeployment}" was expected. ` +
          `Refusing to report on a deployment nobody is served by.`
      );
    }
  }
  return { ok: true, spec, url, rung };
}
