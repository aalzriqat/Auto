#!/usr/bin/env node
/**
 * The supported way to deploy this project to production Convex.
 *
 * Advisory, not binding: `npx convex deploy` still exists and this cannot stop
 * anyone reaching for it. Making production unreachable from a workstation is a
 * separate change (CI-mediated deploy against a protected environment); until
 * then, saying otherwise here would overstate what this buys.
 *
 * `pnpm deploy:prod`. The dev counterpart is `pnpm dev:push`, named so neither
 * can be mistaken for the other at a glance.
 *
 * Convex's own "is this production?" prompt is **conditional** — verified with
 * `--dry-run`: it appears when `CONVEX_DEPLOYMENT` names a *dev* deployment,
 * and does not appear when it names prod, nor when `CONVEX_DEPLOY_KEY` is set.
 * So the confirmation is owned here instead: the target is read back out of the
 * CLI's own dry run, and the operator types that deployment's name before
 * anything is spawned.
 *
 * What this adds over `npx convex deploy`:
 *
 *   1. An allowlist of forwardable arguments. `-y` suppresses the production
 *      confirmation and is undocumented; a denylist missed `-vy`.
 *   2. Every deployable file under `convex/` must be tracked by git. That
 *      directory is bundled from disk, and `.gitignore` does not stop it — an
 *      ignored `fix_*.js` there ships while `git status` says nothing.
 *   3. A clean tree and a commit contained in origin/main.
 *   4. The target, resolved and named before anything is written, then
 *      re-validated immediately before the real push.
 *
 * There is no `--force`. Every check has a cheap honest resolution, and an
 * override on a guard like this is reached for by habit — which is what caused
 * the incident.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { BUNDLED_EXTENSIONS, runGuardedDeploy } from "./deployGuard.ts";

const argv = process.argv.slice(2);
const allowBehind = argv.includes("--allow-behind");
const forwardedArgs = argv.filter((a) => a !== "--allow-behind");

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

/**
 * The Convex CLI is launched as `node node_modules/convex/bin/main.js`, not via
 * npx.
 *
 * `shell: true` was how the first version reached `npx` on Windows, and it
 * concatenates arguments into a cmd.exe string rather than escaping them —
 * which split `--cmd "pnpm build"` on its space and let an argument chain a
 * second, unguarded command with `&`. Dropping the shell then hit the opposite
 * wall: Node refuses to spawn a `.cmd` without one (EINVAL, the CVE-2024-27980
 * hardening), so `npx.cmd` could not launch at all.
 *
 * Running the entry point with `process.execPath` escapes both. Arguments stay
 * argv, and the binary is the one this repo installed rather than whatever npx
 * resolves — which also means the guard cannot be pointed at a different CLI.
 */
const CONVEX_CLI = path.join(repoRoot, "node_modules", "convex", "bin", "main.js");
if (!existsSync(CONVEX_CLI)) {
  console.error(`Convex CLI not found at ${CONVEX_CLI}. Run pnpm install first.`);
  process.exit(1);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", cwd: repoRoot }).trim();
}

/**
 * Tracked paths with modifications, via `-z`.
 *
 * `--porcelain=v1` quotes paths containing spaces or non-ASCII
 * (`"conv\303\251x/x.ts"`), which no amount of slicing decodes correctly. `-z`
 * emits them raw, NUL-separated, and never quotes.
 */
function trackedChanges() {
  const raw = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  const fields = raw.split("\0").filter(Boolean);
  const changed = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status.startsWith("??")) continue; // untracked is the bundle check's job
    // A rename emits the destination, then the source as its own field.
    if (status.startsWith("R") || status.startsWith("C")) i += 1;
    changed.push(file);
  }
  return changed;
}

/** Every deployable file Convex would bundle, walked from disk. */
function bundleFilesOnDisk() {
  const convexDir = path.join(repoRoot, "convex");
  if (!existsSync(convexDir)) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // `_generated` is committed; skipping it would be wrong, so it is walked
        // like everything else. Only genuinely non-deployable dirs are skipped.
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (BUNDLED_EXTENSIONS.includes(path.extname(entry.name))) {
        found.push(path.relative(repoRoot, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(convexDir);
  return found;
}

/**
 * Deployment configuration the way the CLI resolves it.
 *
 * The CLI loads `.env.local` then `.env` before choosing a target, so reading
 * `process.env` alone can report "nothing is set" while a deploy key is in
 * force — and a deploy key is the case where Convex asks nothing.
 * `dotenv.config` does not override an already-set variable, so process env wins.
 */
function resolveDeployEnv() {
  const out = {
    CONVEX_DEPLOYMENT: process.env.CONVEX_DEPLOYMENT,
    CONVEX_DEPLOY_KEY: process.env.CONVEX_DEPLOY_KEY,
    source: process.env.CONVEX_DEPLOYMENT || process.env.CONVEX_DEPLOY_KEY ? "process env" : undefined,
  };
  for (const file of [".env.local", ".env"]) {
    const full = path.join(repoRoot, file);
    if (!existsSync(full)) continue;
    for (const line of readFileSync(full, "utf8").split("\n")) {
      const m = line.match(/^\s*(CONVEX_DEPLOYMENT|CONVEX_DEPLOY_KEY)\s*=\s*(.*)$/);
      if (!m) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "");
      if (!out[m[1]]) {
        out[m[1]] = value;
        out.source = file;
      }
    }
  }
  return out;
}

function collectSnapshot() {
  // Every staleness judgement below is worthless against a stale remote ref,
  // and "is this merged?" is exactly such a judgement. A failure here throws
  // and exits non-zero rather than proceeding on old data.
  execFileSync("git", ["fetch", "origin", "--quiet"], { stdio: "inherit", cwd: repoRoot });

  const headSha = git(["rev-parse", "HEAD"]);
  const originMainSha = git(["rev-parse", "origin/main"]);
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", headSha, "origin/main"], {
    stdio: "ignore",
    cwd: repoRoot,
  });

  return {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    headSha,
    originMainSha,
    headIsAncestorOfOriginMain: ancestor.status === 0,
    trackedChanges: trackedChanges(),
    bundleFilesOnDisk: bundleFilesOnDisk(),
    trackedBundleFiles: git(["ls-files", "convex/"]).split("\n").filter(Boolean),
    forwardedArgs,
    env: resolveDeployEnv(),
  };
}

const io = {
  collectSnapshot,
  runDryRun: (args) => {
    const r = spawnSync(process.execPath, [CONVEX_CLI, ...args], {
      encoding: "utf8",
      cwd: repoRoot,
      // Colour off: the production label is matched textually, and a forced
      // colour level turns "[Production]" into an ANSI-wrapped string that no
      // longer matches — losing the PRODUCTION warning with no other symptom.
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    return {
      status: r.status,
      output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
      errorMessage: r.error?.message,
    };
  },
  runDeploy: (args) =>
    spawnSync(process.execPath, [CONVEX_CLI, ...args], {
      stdio: "inherit",
      cwd: repoRoot,
    }).status ?? 1,
  prompt: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  isTTY: Boolean(process.stdin.isTTY),
  log: (m) => console.log(m),
  error: (m) => console.error(m),
};

try {
  process.exit(await runGuardedDeploy(io, { allowBehind }));
} catch (error) {
  // Graceful rather than a raw stack trace: a git failure is a refusal, not a
  // broken tool, and the repo's own error rule asks for this.
  console.error(`
Refusing to deploy — could not establish repository state:
  ${error.message}
`);
  process.exit(1);
}
