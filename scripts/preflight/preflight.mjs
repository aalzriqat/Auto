/**
 * `pnpm preflight`: the mechanical pre-push checks, in one command (SCRUM-1007).
 *
 * Run it before `git push`. It runs the same entry points CI runs, cheapest first, keeps going after a failure so
 * every problem is listed in one run, prints one line per check and exits non-zero if any check FAILS. A check that
 * cannot run (missing tool, script error, spawn failure) is a FAIL, never a skip: a skipped gate is how a red CI run
 * gets discovered ten minutes later.
 *
 *   pnpm preflight                 all applicable checks
 *   pnpm preflight --tests         also vitest on changed *.test.ts files (--maxWorkers=1)
 *   pnpm preflight --base <ref>    compare against <ref> instead of origin/main
 *
 * It does not fetch. `git fetch origin` first if you want the comparison against the current main.
 *
 * Checks (id: what it reuses):
 *   api-dts            ./apiDtsCheck.mjs (offline emulation of the Convex generator; CI runs the real one)
 *   guardrails         node quality/guardrails/check.mjs --base <base>             (CI: "Guardrails")
 *   baseline-evidence  node scripts/contractSkew/renewBaselineReviewed.mjs ...     (CI: "renewal evidence coverage")
 *   eslint             eslint on changed lintable files only                        (CI: `pnpm lint`, whole repo)
 *   sonar-lint         eslint --config eslint.preflight.config.mjs: the SonarCloud rule classes that failed our gate (SCRUM-1011).
 *                      Errors (Sonar BUG/VULNERABILITY classes) FAIL; warnings (code smells) are printed and counted.
 *                      ESLint is not Sonar: a pass here does not prove the Sonar gate passes (README, "Preflight").
 *   execution-pins     vitest run scripts/intelligence/supplierNavigationDoors.test.ts when a pinned execution input changed (CI: unit slices)
 *   picomatch-backport node scripts/security/verifyPicomatchBackport.mjs when a manifest, lockfile or backport changed (CI: dependency-audit)
 *   inventories        vitest run the registration-inventory tests (tenant write guard, pilot doors, economic command census)
 *                      when convex/ or one of those tests changed (CI: unit slices)
 *   typecheck          pnpm typecheck:convex, pnpm typecheck and pnpm typecheck:contract-skew, always (CI runs them unconditionally);
 *   tests              vitest run ./<changed test files> --maxWorkers=1 (only with --tests)
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkApiDts } from "./apiDtsCheck.mjs";
import { assertSafeRevision, resolveGit } from "../contractSkew/gitExecutable.mjs";
import { picomatchBackportStep } from "./securitySteps.mjs";
import { inventoriesStep, sonarLintStep } from "./sonarSteps.mjs";
import { PNPM_FIX, commandCheck, notApplicable } from "./stepKit.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The reviewed revision CI passes to the baseline evidence check (.github/workflows/test.yml). */
const BASELINE_REVIEWED = "c82890bd";
const LINT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
/** Under docs/, a file with one of these extensions is code or data a typecheck can read, so it is not "docs". */
const DOCS_CODE_EXTENSIONS = new Set([...LINT_EXTENSIONS, ".json"]);
/** eslint.config.mjs globalIgnores, plus node_modules. */
const LINT_IGNORED = [/^convex\/_generated\//, /^scratch\//, /^marketing\/render-cover\.js$/, /^apps\//, /^packages\//, /(^|\/)node_modules\//];
/** The supplier-navigation closure census pins a sha256 of package.json, lockfiles, tsconfigs and patches. */
const PINS_SOURCE = "test-utils/supplierNavigationAudit/sourceClosureCases.ts";
const PINS_CENSUS_DIR = "test-utils/supplierNavigationAudit/";
const PINS_SUITE = "scripts/intelligence/supplierNavigationDoors.test.ts";
const ESLINT_CHUNK = 120;
const MAX_PRINTED_WARNINGS = 30;

/**
 * @typedef {{ status: string, path: string }} Change
 * @typedef {{ id: string, title: string, status: "PASS" | "FAIL" | "NOT APPLICABLE", detail: string, fix: string[], ms: number }} CheckResult
 * @typedef {Omit<CheckResult, "ms" | "title"> & { title?: string, warnings?: string[] }} Partial
 * @typedef {{ id: string, command: string, args: string[], cwd?: string }} RunSpec
 * @typedef {{ status: number | null, stdout?: string, stderr?: string, error?: Error }} RunOutcome
 * @typedef {{
 *   git: (args: string[]) => string,
 *   run: (spec: RunSpec) => RunOutcome,
 *   exists: (p: string) => boolean,
 *   readText: (p: string) => string,
 *   readDir: (p: string) => string[],
 *   checkApiDts: (o: { root: string }) => { ok: boolean, problems: Array<{ message: string, fix: string }>, expectedCount?: number },
 *   now: () => number,
 * }} Deps
 * @typedef {{ paths: string[], convexSide: boolean, docsOnly: boolean, lintable: string[], testFiles: string[] }} Classification
 * @typedef {{ deps: Deps, root: string, base: string, mergeBase: string, cls: Classification, options: { tests?: boolean }, node: string }} Ctx
 */

/**
 * A path is documentation only when it is a Markdown file, or lives under docs/ and is not code or JSON.
 * @param {string} p
 */
export function isDocsPath(p) {
  if (/\.md$/i.test(p)) return true;
  return p.startsWith("docs/") && !DOCS_CODE_EXTENSIONS.has(path.posix.extname(p).toLowerCase());
}

/**
 * @param {Change[]} changes
 * @returns {Classification}
 */
export function classifyChanges(changes) {
  const live = changes.filter((c) => c.status !== "D");
  const ext = (p) => path.posix.extname(p).toLowerCase();
  return {
    paths: changes.map((c) => c.path),
    convexSide: changes.some((c) => c.path.startsWith("convex/") || c.path.startsWith("test-utils/")),
    // An empty change set is not docs-only: nothing proves a typecheck is unneeded, and `every` on [] is vacuously true.
    docsOnly: changes.length > 0 && changes.every((c) => isDocsPath(c.path)),
    lintable: live.map((c) => c.path).filter((p) => LINT_EXTENSIONS.has(ext(p)) && !LINT_IGNORED.some((re) => re.test(p))),
    testFiles: live.map((c) => c.path).filter((p) => /\.test\.(ts|tsx)$/.test(p) && !/^(apps|packages)\//.test(p) && !/(^|\/)node_modules\//.test(p)),
  };
}

/** @param {CheckResult[]} results */
export function exitCodeOf(results) {
  return results.some((r) => r.status === "FAIL") ? 1 : 0;
}

/** @param {string} nulSeparated @returns {Change[]} */
function parseNameStatus(nulSeparated) {
  const parts = nulSeparated.split("\0").filter((p) => p.length > 0);
  /** @type {Change[]} */
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i][0], path: parts[i + 1] });
  return out;
}

/** @param {Ctx} ctx @returns {Partial} */
function apiDtsStep({ deps, root, cls }) {
  const id = "api-dts";
  if (!cls.convexSide) return notApplicable(id, "no convex/ or test-utils/ file changed");
  let r;
  try {
    r = deps.checkApiDts({ root });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { id, status: "FAIL", detail: `cannot run: ${why}`, fix: ["pnpm install --frozen-lockfile, then re-run; if the generated file is damaged: git restore convex/_generated/api.d.ts"] };
  }
  if (r.ok) return { id, status: "PASS", detail: `import and fullApi blocks hold the ${r.expectedCount ?? "?"} registerable modules in generator order`, fix: [] };
  const shown = r.problems.slice(0, 12);
  const more = r.problems.length - shown.length;
  const lines = shown.map((p) => `  - ${p.message}`);
  if (more > 0) lines.push(`  ... ${more} more`);
  return {
    id, status: "FAIL",
    detail: `${r.problems.length} problem(s):\n${lines.join("\n")}`,
    fix: [...shown.map((p) => p.fix), "or regenerate it the way CI does (anonymous local backend, `convex dev --once`; see the convex-backend job in .github/workflows/test.yml)"],
  };
}

/** @param {Ctx} ctx @returns {Partial} */
function guardrailsStep({ deps, root, base, node }) {
  const spec = { id: "guardrails", command: node, args: ["quality/guardrails/check.mjs", "--base", base], cwd: root };
  return commandCheck(deps, root, "guardrails", "", ["quality/guardrails/check.mjs"], [spec],
    () => [`node quality/guardrails/check.mjs --base ${base}`, "fix what it lists (size, import-boundary or ratchet), then re-run"]);
}

/** @param {Ctx} ctx @returns {Partial} */
function baselineStep({ deps, root, mergeBase, node }) {
  const script = "scripts/contractSkew/renewBaselineReviewed.mjs";
  const spec = { id: "baseline-evidence", command: node, args: [script, "--reviewed", BASELINE_REVIEWED, "--check-evidence", "--pr-base", mergeBase], cwd: root };
  const stale = [
    "a baseline entry names a file that changed since its review: revert that edit, or re-review the entry and renew it:",
    `node ${script} --reviewed ${BASELINE_REVIEWED} --expires <YYYY-MM-DD> --renewal "<why it is still correct>" --blob-evidence --write`,
    "commit everything first (the check reads HEAD blobs and refuses uncommitted files); see scripts/contractSkew/SCRUM-866-MAIN-DRIFT.md",
  ];
  const stopped = [
    `node ${script} --reviewed ${BASELINE_REVIEWED} --check-evidence --pr-base ${mergeBase}`,
    "the check itself stopped before judging: read the message above (uncommitted file named, shallow history, or a revision that is not an ancestor of HEAD)",
  ];
  return commandCheck(deps, root, "baseline-evidence", "", [script], [spec], (r) => (r.status === 10 ? stale : stopped));
}

/** @param {Ctx} ctx @returns {Partial} */
function eslintStep({ deps, root, cls, node }) {
  const id = "eslint";
  if (cls.lintable.length === 0) return notApplicable(id, "no changed lintable file (.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts outside the lint ignores)");
  const bin = "node_modules/eslint/bin/eslint.js";
  const specs = [];
  for (let i = 0; i < cls.lintable.length; i += ESLINT_CHUNK) {
    specs.push({ id, command: node, args: [bin, "--no-warn-ignored", "--", ...cls.lintable.slice(i, i + ESLINT_CHUNK)], cwd: root });
  }
  const sample = cls.lintable.slice(0, 6).join(" ");
  const ellipsis = cls.lintable.length > 6 ? " ..." : "";
  const r = commandCheck(deps, root, id, "", [bin], specs, () => [`node ${bin} --no-warn-ignored -- ${sample}${ellipsis}`, "fix the errors it lists (add `--fix` for the auto-fixable ones)"]);
  return r.status === "PASS" ? { ...r, detail: `${cls.lintable.length} file(s) clean` } : r;
}

/**
 * The files the census pins, read from the census itself so a pin added there is covered without editing this script.
 * Anything it cannot parse throws (the caller reports a FAIL).
 * @param {string} source
 * @returns {string[]}
 */
function parsePinnedFiles(source) {
  const opening = /EXECUTION_INPUTS[^=]*=\s*\[/.exec(source);
  if (!opening) throw new Error(`no EXECUTION_INPUTS table in ${PINS_SOURCE}`);
  const rest = source.slice(opening.index + opening[0].length);
  const end = rest.search(/\r?\n\];/);
  if (end === -1) throw new Error(`the end of the EXECUTION_INPUTS table in ${PINS_SOURCE} was not found`);
  const table = rest.slice(0, end);
  // Quoted or unquoted `file` key; every `{` is one entry, and an entry without a parsable file fails closed.
  const pinned = [...table.matchAll(/["']?\bfile["']?\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  const entries = (table.match(/\{/g) ?? []).length;
  if (pinned.length === 0) throw new Error(`EXECUTION_INPUTS in ${PINS_SOURCE} lists no files`);
  if (pinned.length !== entries) throw new Error(`EXECUTION_INPUTS in ${PINS_SOURCE} has ${entries} entries but ${pinned.length} parsable files`);
  return pinned;
}

/** @param {Ctx} ctx @returns {Partial} */
function pinsStep({ deps, root, cls, node }) {
  const id = "execution-pins";
  const pinned = parsePinnedFiles(deps.readText(path.join(root, ...PINS_SOURCE.split("/"))));
  const hit = cls.paths.filter((p) => pinned.includes(p) || p.startsWith(PINS_CENSUS_DIR) || p === PINS_SUITE);
  if (hit.length === 0) return notApplicable(id, `no pinned execution input (${pinned.join(", ")}) or census file changed`);
  const args = ["node_modules/vitest/vitest.mjs", "run", "--maxWorkers=1", PINS_SUITE];
  const changed = hit.slice(0, 4).join(", ");
  const r = commandCheck(deps, root, id, "", [args[0]], [{ id, command: node, args, cwd: root }], () => [
    `node ${args.join(" ")}`,
    `a pinned input changed (${changed}): renew its sha256 in EXECUTION_INPUTS in ${PINS_SOURCE} (LF-normalised sha256 of the committed file),`,
    `then the pins for ${PINS_SOURCE} itself in test-utils/supplierNavigationAudit/closurePins.ts (the changed statement hash and textHash); do not weaken the check`,
  ]);
  return r.status === "PASS" ? { ...r, detail: `census suite passed (changed: ${hit.slice(0, 3).join(", ")})` } : r;
}

const TYPECHECKS = [
  { id: "typecheck-convex", script: "typecheck:convex", label: "pnpm typecheck:convex" },
  { id: "typecheck-root", script: "typecheck", label: "pnpm typecheck (root)" },
  { id: "typecheck-contract-skew", script: "typecheck:contract-skew", label: "pnpm typecheck:contract-skew" },
];

/**
 * Not selected by path: root tsconfig has resolveJsonModule/allowJs and imports reach convex/, test-utils/ and packages/, so any
 * file can change a typecheck result. CI runs all three unconditionally; so does this, except for a docs-only diff.
 * @param {Ctx} ctx @returns {Partial}
 */
function typecheckStep({ deps, root, cls }) {
  const id = "typecheck";
  if (cls.paths.length === 0) return notApplicable(id, "nothing changed against the base");
  if (cls.docsOnly) return notApplicable(id, "docs-only diff (every changed path is *.md, or under docs/ and not code or JSON)");
  const failures = [];
  for (const t of TYPECHECKS) {
    const spec = { id: t.id, command: "pnpm", args: ["run", t.script], cwd: root };
    const r = commandCheck(deps, root, id, "", ["package.json"], [spec], () => [`pnpm ${t.script}`, "fix the type errors it lists"]);
    if (r.status === "FAIL") failures.push({ script: t.script, r });
  }
  if (failures.length === 0) return { id, status: "PASS", detail: `ran ${TYPECHECKS.map((t) => t.label).join(", ")}`, fix: [] };
  return {
    id, status: "FAIL",
    detail: failures.map((f) => `${f.script}:\n${f.r.detail}`).join("\n"),
    fix: [...new Set(failures.flatMap((f) => f.r.fix))],
  };
}

/** @param {Ctx} ctx @returns {Partial} */
function testsStep({ deps, root, cls, options, node }) {
  const id = "tests";
  if (!options.tests) return notApplicable(id, "pass --tests to run vitest on changed *.test.ts files");
  if (cls.testFiles.length === 0) return notApplicable(id, "no changed *.test.ts / *.test.tsx file");
  const bin = "node_modules/vitest/vitest.mjs";
  // No `--` here: vitest (cac) puts everything after it outside the file filters and would run the whole suite.
  // A `./` prefix keeps a path that begins with `-` from being read as an option.
  const args = [bin, "run", "--maxWorkers=1", ...cls.testFiles.map((p) => `./${p}`)];
  const r = commandCheck(deps, root, id, "", [bin], [{ id, command: node, args, cwd: root }], () => [`node ${args.join(" ")}`, "fix the failing assertions it lists"]);
  return r.status === "PASS" ? { ...r, detail: `${cls.testFiles.length} test file(s) passed` } : r;
}

const STEPS = [
  { id: "api-dts", title: "convex/_generated/api.d.ts matches the generator", run: apiDtsStep },
  { id: "guardrails", title: "quality guardrails (trusted target baseline)", run: guardrailsStep },
  { id: "baseline-evidence", title: "contract-skew baseline renewal evidence", run: baselineStep },
  { id: "eslint", title: "eslint on changed files", run: eslintStep },
  { id: "sonar-lint", title: "Sonar rule classes (eslint-plugin-sonarjs) on changed files", run: sonarLintStep },
  { id: "execution-pins", title: "supplier-navigation execution-input pins", run: pinsStep },
  { id: "picomatch-backport", title: "picomatch backport audit (CI dependency-audit)", run: picomatchBackportStep },
  { id: "inventories", title: "registration inventories (tenant guard, pilot doors, economic census)", run: inventoriesStep },
  { id: "typecheck", title: "typecheck", run: typecheckStep },
  { id: "tests", title: "vitest on changed test files", run: testsStep },
];

/** @param {Deps} deps @param {string} base @param {(line: string) => void} log */
function readChanges(deps, base) {
  const mergeBase = deps.git(["merge-base", "HEAD", base]).trim();
  const tracked = parseNameStatus(deps.git(["diff", "--name-status", "-z", "--no-renames", mergeBase]));
  const untracked = deps.git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).map((p) => ({ status: "A", path: p }));
  const seen = new Set(tracked.map((c) => c.path));
  return { mergeBase, changes: [...tracked, ...untracked.filter((c) => !seen.has(c.path))] };
}

/** @param {Deps} deps @param {string} base */
function commitsBehind(deps, base) {
  try {
    return Number.parseInt(deps.git(["rev-list", "--count", `HEAD..${base}`]).trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/** @param {Deps} deps @param {(line: string) => void} log */
function warnIfDirty(deps, log) {
  try {
    const dirty = deps.git(["status", "--porcelain"]).split(/\r?\n/).filter((l) => l.trim() && !isKnownHookState(deps, l));
    if (dirty.length) log(`  warning: ${dirty.length} uncommitted change(s) in the working tree. This run reads the working tree; CI reads the pushed commit (and the baseline check reads HEAD). Commit first, then run preflight.`);
  } catch {
    // status is advisory; the checks do not depend on it
  }
}

/** @param {{ id: string, title: string, run: (ctx: Ctx) => Partial }} step @param {Ctx} ctx @returns {CheckResult} */
function runStep(step, ctx) {
  const t0 = ctx.deps.now();
  let partial;
  try {
    partial = step.run(ctx);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    partial = { id: step.id, status: /** @type {const} */ ("FAIL"), detail: `cannot run: ${why}`, fix: ["re-run with the underlying command to see the error"] };
  }
  return { ...partial, id: step.id, title: step.title, ms: ctx.deps.now() - t0 };
}

/**
 * @param {{ root: string, options?: { tests?: boolean, base?: string }, deps: Deps, log?: (line: string) => void }} input
 * @returns {Promise<{ results: CheckResult[], mergeBase: string, base: string, behind: number, changed: number, totalMs: number }>}
 */
export async function runPreflight({ root, options = {}, deps, log = () => {} }) {
  const base = options.base ?? "origin/main";
  const startedAt = deps.now();
  const { mergeBase, changes } = readChanges(deps, base);
  const cls = classifyChanges(changes);
  const behind = commitsBehind(deps, base);
  const behindNote = behind ? `, ${behind} commit(s) behind ${base}` : "";
  log(`preflight: base ${base} (merge-base ${mergeBase.slice(0, 9)}), ${changes.length} changed file(s)${behindNote}`);
  if (behind) log(`  note: this branch is behind ${base}; run \`git fetch origin && git rebase ${base}\` so the checks see current main.`);
  warnIfDirty(deps, log);

  /** @type {Ctx} */
  const ctx = { deps, root, base, mergeBase, cls, options, node: process.execPath };
  /** @type {CheckResult[]} */
  const results = [];
  for (const step of STEPS) {
    const result = runStep(step, ctx);
    results.push(result);
    log(formatLine(result));
    logWarnings(result, log);
  }
  const totalMs = deps.now() - startedAt;
  const failed = results.filter((r) => r.status === "FAIL");
  for (const r of failed) {
    log(`\n--- ${r.id} FAILED ---`);
    if (r.detail) log(r.detail);
    if (r.fix.length) log(["fix:", ...r.fix.map((f) => "  " + f)].join("\n"));
  }
  const count = (status) => results.filter((r) => r.status === status).length;
  log(`\ntotal ${(totalMs / 1000).toFixed(1)}s: ${count("PASS")} passed, ${failed.length} failed, ${count("NOT APPLICABLE")} not applicable`);
  log(failed.length ? `preflight FAILED (${failed.map((r) => r.id).join(", ")})` : "preflight passed");
  return { results, mergeBase, base, behind, changed: changes.length, totalMs };
}

/** The only .gitignore edit the agent hook makes here: exactly these three added lines (blank, comment, `/graft/`) and nothing else. */
const HOOK_GITIGNORE_ADDITIONS = ["", "# graft's local graph cache — regenerable, not committed (run `graft build`).", "/graft/"];

/**
 * A porcelain line is ignorable only when it is the exact known hook state: an untracked `.ignore`, or a modified `.gitignore`
 * whose whole diff is the hook's three added lines. Any other `.gitignore` edit is a real change and is reported.
 * @param {Deps} deps @param {string} line
 */
function isKnownHookState(deps, line) {
  const file = line.slice(3);
  if (line.startsWith("??") && file === ".ignore") return true;
  if (file !== ".gitignore" || !line.startsWith(" M")) return false;
  const body = deps.git(["diff", "--", ".gitignore"]).split(/\r?\n/).filter((l) => /^[+-]/.test(l) && !/^(\+\+\+ |--- )/.test(l));
  return body.length === HOOK_GITIGNORE_ADDITIONS.length && body.every((l, i) => l === `+${HOOK_GITIGNORE_ADDITIONS[i]}`);
}

/** Warnings never fail a step but are always printed (capped). @param {CheckResult & { warnings?: string[] }} r @param {(line: string) => void} log */
function logWarnings(r, log) {
  const all = r.warnings ?? [];
  for (const w of all.slice(0, MAX_PRINTED_WARNINGS)) log(`    warning: ${w}`);
  if (all.length > MAX_PRINTED_WARNINGS) log(`    ... ${all.length - MAX_PRINTED_WARNINGS} more warning(s)`);
}

/** @param {CheckResult} r */
function formatLine(r) {
  const first = r.detail.split("\n")[0];
  const summary = r.status === "FAIL" ? "see the details below" : first;
  return `${r.status.padEnd(14)}  ${r.id.padEnd(18)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${summary}`;
}

/**
 * pnpm is run only as `node <pnpm's own JS entry>`: under `pnpm preflight`, npm_execpath is that entry. No shell, no PATH lookup.
 * @param {Record<string, string | undefined>} env
 */
function pnpmEntry(env) {
  const entry = env.npm_execpath;
  return entry && /^pnpm[^/\\]*\.[cm]?js$/i.test(path.basename(entry)) ? entry : undefined;
}

/**
 * @param {{ root: string, env?: Record<string, string | undefined>, execPath?: string, spawn?: (cmd: string, args: string[], opts: any) => RunOutcome }} input
 * @returns {(spec: RunSpec) => RunOutcome}
 */
export function makeRun({ root, env = process.env, execPath = process.execPath, spawn = spawnSync }) {
  return (spec) => {
    const options = { cwd: spec.cwd ?? root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, windowsHide: true, env: { ...env, FORCE_COLOR: "0", NO_COLOR: "1" } };
    if (spec.command !== "pnpm") return spawn(spec.command, spec.args, options);
    const entry = pnpmEntry(env);
    if (!entry) return { status: null, error: new Error(`pnpm has no runnable JS entry here (npm_execpath is unset or not pnpm); ${PNPM_FIX}`) };
    return spawn(execPath, [entry, ...spec.args], options);
  };
}

/**
 * git is resolved by the repository's own resolver (standard install paths, CONTRACT_SKEW_GIT); when it finds none this
 * fails closed rather than falling back to whatever `git` a PATH lookup would return.
 * Every git call runs without GIT_DIFF_OPTS and GIT_EXTERNAL_DIFF, which change what `git diff` prints (GIT_DIFF_OPTS takes
 * precedence over -U): https://git-scm.com/docs/git-diff, "ENVIRONMENT"/"GIT_DIFF_OPTS", "GIT_EXTERNAL_DIFF".
 * @param {{ root: string, resolve?: () => string | undefined, env?: NodeJS.ProcessEnv, exec?: (git: string, args: string[], env: NodeJS.ProcessEnv) => string }} input
 * @returns {(args: string[]) => string}
 */
export function makeGit({
  root,
  resolve = () => resolveGit(),
  env = process.env,
  exec = (git, args, childEnv) => execFileSync(git, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: childEnv }),
}) {
  const git = resolve();
  if (!git) throw new Error("cannot find git in its standard install locations (set CONTRACT_SKEW_GIT to its absolute path)");
  const { GIT_DIFF_OPTS: _opts, GIT_EXTERNAL_DIFF: _external, ...childEnv } = env;
  return (args) => exec(git, ["-C", root, ...args], childEnv);
}

/** @returns {Deps} */
function realDeps(root) {
  return {
    git: makeGit({ root }),
    run: makeRun({ root }),
    exists: (p) => fs.existsSync(p),
    readText: (p) => fs.readFileSync(p, "utf8"),
    readDir: (p) => fs.readdirSync(p),
    checkApiDts,
    now: () => Date.now(),
  };
}

const USAGE = "usage: pnpm preflight [--tests] [--base <ref>]";

/**
 * @param {string[]} argv @param {string} [root] @param {Deps} [deps] injected in tests; the real tools otherwise
 * @returns {Promise<number>} the process exit code
 */
export async function main(argv, root = REPO_ROOT, deps = undefined) {
  let values;
  let base;
  try {
    ({ values } = parseArgs({ args: argv, options: { tests: { type: "boolean" }, base: { type: "string" }, help: { type: "boolean" } }, strict: true }));
    // --base reaches git and a child process as an argument: only a plain revision name is accepted (never a leading "-").
    if (values.base !== undefined) base = assertSafeRevision(values.base, "--base");
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const { results } = await runPreflight({ root, options: { tests: Boolean(values.tests), base }, deps: deps ?? realDeps(root), log: (l) => console.log(l) });
    return exitCodeOf(results);
  } catch (error) {
    // Could not even work out what changed (no git, no origin/main): that is a failed preflight, not a pass.
    console.error(`preflight FAILED: cannot determine the change set: ${error instanceof Error ? error.message : String(error)}\nfix: git fetch origin   (and run from inside the repository)`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
