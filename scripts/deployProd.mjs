#!/usr/bin/env node
/**
 * The supported way to deploy this project to production Convex.
 *
 * `pnpm deploy:prod`. The dev counterpart is `pnpm dev:push`, named so neither
 * can be mistaken for the other at a glance.
 *
 * ## The one idea
 *
 * **The deploy reads an isolated extract of one approved commit, never your
 * working directory.** A brand-new temporary directory is created per run, the
 * approved commit's tracked content is extracted into it, its own locked
 * dependencies are installed there, and the Convex CLI that pushes is the one
 * inside that directory. Your worktree is never a bundle input.
 *
 * That is a change of trust model, not an extra check. The previous version
 * validated git state (clean tree, tracked files under `convex/`) and then let
 * the CLI bundle from the same mutable directory — and two independent reviews
 * each defeated it: Convex bundles relative imports out of `convex/`, an
 * untracked `lib/x.tsx` shadows a reviewed `lib/x.ts` because esbuild resolves
 * `.tsx` first, and a file created after the final check still shipped. See the
 * header of `deployGuard.ts` for the full account.
 *
 * ## What this adds over `npx convex deploy`
 *
 *   1. One exact commit, decided once, never re-derived from a moving ref.
 *   2. An isolated checkout, so nothing on your disk can reach production.
 *   3. A frozen dependency install from the approved commit's own lockfile.
 *   4. An allowlist of forwardable arguments. `-y` suppresses the production
 *      confirmation and is undocumented; a denylist missed `-vy`.
 *   5. A confirmation naming BOTH the deployment and the commit, read out of
 *      the CLI's own canonical announcement rather than pattern-matched from
 *      arbitrary output.
 *
 * ⚠️ Advisory, not binding: `npx convex deploy` still exists and this cannot
 * stop anyone reaching for it. Making production unreachable from a workstation
 * is a CI-mediated deploy against a protected environment — a separate change.
 *
 * There is no `--force`. Every check has a cheap honest resolution, and an
 * override on a guard like this is reached for by habit — which is what caused
 * the incident.
 */

// ── Node floor, checked BEFORE anything else is imported.
//
// This file imports `deployGuard.ts` — TypeScript — which only works where Node
// strips types (22.18+, or 23.6+). A static import is hoisted above every line
// of this file, including any try/catch, so on an older Node the operator got a
// raw ERR_UNKNOWN_FILE_EXTENSION stack trace instead of a sentence. `engines`
// does not prevent that: there is no `.npmrc`, so pnpm's `engine-strict` is
// off and the field is advisory. An operator who cannot tell a version problem
// from a broken tool reaches for the raw CLI, which is the failure this whole
// wrapper exists to prevent. Hence: dynamic import, after an explicit check.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(
    `\nRefusing to deploy: Node ${process.versions.node} cannot run this guard.\n` +
      `  It needs Node >=22.18 (<23), where TypeScript type stripping is enabled by default.\n` +
      `  Switch Node versions and try again — do NOT fall back to 'npx convex deploy'.\n`
  );
  process.exit(1);
}

const { execFileSync, spawnSync } = await import("node:child_process");
const { existsSync, readdirSync, readFileSync } = await import("node:fs");
const { createInterface } = await import("node:readline/promises");
const path = (await import("node:path")).default;
// `convexCliPath` is deliberately NOT imported here: the guard resolves the CLI
// against the isolated checkout itself, so the shell never gets to name a
// binary. That is the point — a path chosen out here could be a different one.
const { BUNDLED_EXTENSIONS, resolveSelectors, runGuardedDeploy } = await import(
  "./deployGuard.ts"
);
const { createIsolatedCheckout, removeIsolatedCheckout } = await import("./isolatedCheckout.ts");

const argv = process.argv.slice(2);
const allowBehind = argv.includes("--allow-behind");
const rollbackIndex = argv.indexOf("--rollback-to");
const rollbackTo = rollbackIndex === -1 ? null : argv[rollbackIndex + 1];
const forwardedArgs = argv.filter(
  (a, i) => a !== "--allow-behind" && a !== "--rollback-to" && i !== rollbackIndex + 1
);

/**
 * `git`, resolved to an absolute path once.
 *
 * Every precondition in this guard is answered by git: which files are tracked,
 * whether the tree is clean, whether the commit is on main. Resolving the
 * binary through `PATH` on each call means an earlier-`PATH` `git` shim can
 * falsify all of them at once and the guard reports all-clear. The Convex CLI
 * was already hardened this way (absolute path, `process.execPath`); `git` was
 * not, and it is the larger surface. SonarCloud flags the same thing as S4036.
 */
function resolveGit() {
  const finder = process.platform === "win32" ? "where" : "which";
  const found = spawnSync(finder, ["git"], { encoding: "utf8" });
  if (found.status !== 0) {
    console.error("\nRefusing to deploy: could not locate a git executable.\n");
    process.exit(1);
  }
  const first = found.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
  if (!first || !existsSync(first)) {
    console.error("\nRefusing to deploy: git was reported at a path that does not exist.\n");
    process.exit(1);
  }
  return first;
}

const GIT = resolveGit();

function git(args, cwd = repoRoot) {
  return execFileSync(GIT, args, { encoding: "utf8", cwd }).trim();
}

const repoRoot = execFileSync(GIT, ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

/**
 * Tracked paths with modifications, via `-z`.
 *
 * `--porcelain=v1` quotes paths containing spaces or non-ASCII
 * (`"conv\303\251x/x.ts"`), which no amount of slicing decodes correctly. `-z`
 * emits them raw, NUL-separated, and never quotes.
 */
function trackedChanges() {
  const raw = execFileSync(GIT, ["status", "--porcelain=v1", "-z"], {
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
    // A rename emits the destination, then the source as its own field. The
    // marker can be in either column — a worktree-side rename is " R", which
    // `startsWith` missed, leaving the source path to be read as an entry and
    // its first two characters mistaken for a status.
    if (status.includes("R") || status.includes("C")) i += 1;
    changed.push(file);
  }
  return changed;
}

/** Every deployable file under `convex/` that git has, read with `-z`. */
function trackedBundleFiles() {
  return execFileSync(GIT, ["ls-files", "-z", "convex/"], {
    encoding: "utf8",
    cwd: repoRoot,
  })
    .split("\0")
    .filter(Boolean);
}

/**
 * Deployable files sitting under `convex/` in the CALLER's directory.
 *
 * ⚠️ Read the check this feeds (`bundle-is-tracked`) for what it now means.
 * This is no longer a safety boundary — the deploy does not read this directory
 * at all — it is an expectation check: an uncommitted file here will NOT ship,
 * and silently not shipping work the operator is looking at is its own kind of
 * surprise.
 *
 * It is deliberately NOT described as "everything Convex would bundle". That
 * claim was false, and its falseness was the defect: the real bundle follows
 * relative imports out of this directory.
 */
function bundleFilesOnDisk() {
  const convexDir = path.join(repoRoot, "convex");
  if (!existsSync(convexDir)) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (BUNDLED_EXTENSIONS.includes(path.extname(entry.name))) {
        found.push(path.relative(repoRoot, full).replaceAll("\\", "/"));
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
 */
function resolveDeployEnv() {
  const files = [];
  for (const file of [".env.local", ".env"]) {
    const full = path.join(repoRoot, file);
    if (existsSync(full)) files.push({ name: file, text: readFileSync(full, "utf8") });
  }
  return resolveSelectors(process.env, files);
}

/**
 * The exact commit this run will deploy, decided once.
 *
 * Normal release: `origin/main`'s tip. Rollback: an explicitly named commit,
 * which still has to be an ancestor of `origin/main` (the precondition checks
 * that) — a rollback goes back to something that WAS reviewed, not sideways to
 * something that never was.
 *
 * Resolved to a full 40-character SHA immediately. Every later step consumes
 * this string, so no moving ref is ever consulted again.
 */
function approvedCommit() {
  if (rollbackTo) {
    try {
      return git(["rev-parse", "--verify", `${rollbackTo}^{commit}`]);
    } catch {
      console.error(`\nRefusing to deploy: '${rollbackTo}' is not a commit in this repository.\n`);
      process.exit(1);
    }
  }
  return git(["rev-parse", "origin/main"]);
}

function isAncestor(sha, of) {
  return (
    spawnSync(GIT, ["merge-base", "--is-ancestor", sha, of], {
      stdio: "ignore",
      cwd: repoRoot,
    }).status === 0
  );
}

function collectSnapshot() {
  // Every staleness judgement below is worthless against a stale remote ref,
  // and "is this merged?" is exactly such a judgement.
  execFileSync(GIT, ["fetch", "origin", "--quiet"], { stdio: "inherit", cwd: repoRoot });

  const headSha = git(["rev-parse", "HEAD"]);
  const originMainSha = git(["rev-parse", "origin/main"]);
  const approvedSha = approvedCommit();

  return {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    headSha,
    originMainSha,
    approvedSha,
    headIsAncestorOfOriginMain: isAncestor(headSha, "origin/main"),
    approvedIsAncestorOfOriginMain: isAncestor(approvedSha, "origin/main"),
    trackedChanges: trackedChanges(),
    bundleFilesOnDisk: bundleFilesOnDisk(),
    trackedBundleFiles: trackedBundleFiles(),
    forwardedArgs,
    env: resolveDeployEnv(),
  };
}


/**
 * Install the approved commit's own dependency set, inside the checkout.
 *
 * `--frozen-lockfile` so the resolution is the one that was reviewed, and
 * `--ignore-scripts` so no package's lifecycle script runs arbitrary code
 * between preparation and deployment.
 */
function installDependencies(dir) {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const r = spawnSync(pnpm, ["install", "--frozen-lockfile", "--ignore-scripts"], {
    cwd: dir,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return {
    status: r.status ?? 1,
    output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}`,
  };
}

const io = {
  collectSnapshot,
  prepareIsolatedCheckout: (sha) => createIsolatedCheckout({ git: GIT, repoRoot, sha }),
  installDependencies,
  cliExists: (cliPath) => existsSync(cliPath),
  cleanupCheckout: (dir) => {
    // Never mask the deploy's own outcome with a cleanup failure.
    const result = removeIsolatedCheckout(dir);
    if (!result.removed) {
      console.error(`(could not remove the temporary checkout ${dir}: ${result.error})`);
    }
  },
  runDryRun: (cliPath, cwd, args, frozenEnv) => {
    const r = spawnSync(process.execPath, [cliPath, ...args], {
      encoding: "utf8",
      cwd,
      // Colour off, for this process only: the announcement is matched
      // textually, and a forced colour level turns "[Production]" into an
      // ANSI-wrapped string the canonical parser no longer recognises — which
      // now means a refusal rather than a silent mis-read, but a refusal at the
      // worst moment is still worth not causing.
      env: { ...process.env, ...frozenEnv, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    return {
      status: r.status,
      output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
      errorMessage: r.error?.message,
    };
  },
  runDeploy: (cliPath, cwd, args, frozenEnv) =>
    spawnSync(process.execPath, [cliPath, ...args], {
      stdio: "inherit",
      cwd,
      env: { ...process.env, ...frozenEnv },
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
  process.exit(await runGuardedDeploy(io, { allowBehind: allowBehind || Boolean(rollbackTo) }));
} catch (error) {
  // Graceful rather than a raw stack trace: a git failure is a refusal, not a
  // broken tool, and the repo's own error rule asks for this.
  console.error(`
Refusing to deploy — could not establish repository state:
  ${error.message}
`);
  process.exit(1);
}
