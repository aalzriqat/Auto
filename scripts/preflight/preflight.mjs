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
 *   typecheck          pnpm typecheck:convex / pnpm typecheck / pnpm typecheck:contract-skew, as the diff requires
 *   tests              vitest run <changed test files> --maxWorkers=1 (only with --tests)
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkApiDts } from "./apiDtsCheck.mjs";
import { resolveGit } from "../contractSkew/gitExecutable.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The reviewed revision CI passes to the baseline evidence check (.github/workflows/test.yml). */
const BASELINE_REVIEWED = "c82890bd";
const LINT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
/** eslint.config.mjs globalIgnores, plus node_modules. */
const LINT_IGNORED = [/^convex\/_generated\//, /^scratch\//, /^marketing\/render-cover\.js$/, /^apps\//, /^packages\//, /(^|\/)node_modules\//];
/** Directories the root tsconfig excludes (tsconfig.json "exclude"). */
const ROOT_TSC_EXCLUDED = [/^node_modules\//, /^apps\//, /^packages\//, /^convex\//, /^dealer-worker\//, /^test-utils\//, /(^|\/)node_modules\//];
const ESLINT_CHUNK = 120;
const TAIL_LINES = 30;

/**
 * @typedef {{ status: string, path: string }} Change
 * @typedef {{ id: string, title: string, status: "PASS" | "FAIL" | "NOT APPLICABLE", detail: string, fix: string[], ms: number }} CheckResult
 * @typedef {{ id: string, command: string, args: string[], cwd?: string }} RunSpec
 * @typedef {{ status: number | null, stdout?: string, stderr?: string, error?: Error }} RunOutcome
 * @typedef {{
 *   git: (args: string[]) => string,
 *   run: (spec: RunSpec) => RunOutcome,
 *   exists: (p: string) => boolean,
 *   checkApiDts: (o: { root: string }) => { ok: boolean, problems: Array<{ message: string, fix: string }>, expectedCount?: number },
 *   now: () => number,
 * }} Deps
 */

/**
 * @param {Change[]} changes
 * @returns {{ paths: string[], convexSide: boolean, rootSide: boolean, contractSkewSide: boolean, lintable: string[], testFiles: string[] }}
 */
export function classifyChanges(changes) {
  const live = changes.filter((c) => c.status !== "D");
  const ext = (p) => path.posix.extname(p).toLowerCase();
  const isTs = (p) => TS_EXTENSIONS.has(ext(p));
  return {
    paths: changes.map((c) => c.path),
    convexSide: changes.some((c) => c.path.startsWith("convex/") || c.path.startsWith("test-utils/")),
    rootSide: changes.some((c) => (isTs(c.path) || /(^|\/)tsconfig[^/]*\.json$/.test(c.path)) && !ROOT_TSC_EXCLUDED.some((re) => re.test(c.path))),
    contractSkewSide: changes.some((c) => c.path.startsWith("scripts/contractSkew/") && (isTs(c.path) || ext(c.path) === ".mjs" || c.path.endsWith("tsconfig.json"))),
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

/** @param {RunOutcome} o */
function combinedTail(o) {
  const text = `${o.stdout ?? ""}${o.stderr ? `\n${o.stderr}` : ""}`.replace(/\r/g, "").trim();
  const lines = text.split("\n");
  return lines.length > TAIL_LINES ? [`... (${lines.length - TAIL_LINES} earlier lines omitted)`, ...lines.slice(-TAIL_LINES)].join("\n") : text;
}

/**
 * Run one command; map every outcome to PASS/FAIL. A spawn error or a missing exit status is "cannot run", a FAIL.
 * @param {Deps} deps @param {RunSpec} spec
 * @returns {{ ok: boolean, cannotRun: boolean, status: number | null, text: string }}
 */
function execute(deps, spec) {
  const outcome = deps.run(spec);
  if (outcome.error || outcome.status === null || outcome.status === undefined) {
    return { ok: false, cannotRun: true, status: null, text: `cannot run \`${spec.command} ${spec.args.join(" ")}\`: ${outcome.error?.message ?? "no exit status (killed by a signal?)"}` };
  }
  return { ok: outcome.status === 0, cannotRun: false, status: outcome.status, text: combinedTail(outcome) };
}

/** @param {Deps} deps @param {string} root @param {string[]} rels */
function missingFiles(deps, root, rels) {
  return rels.filter((rel) => !deps.exists(path.join(root, ...rel.split("/"))));
}

/**
 * @param {Deps} deps @param {string} root @param {string} id @param {string} title @param {string[]} requiredFiles
 * @param {RunSpec[]} specs @param {(r: { status: number | null, text: string }) => string[]} fixFor
 * @returns {Omit<CheckResult, "ms">}
 */
function commandCheck(deps, root, id, title, requiredFiles, specs, fixFor) {
  const missing = missingFiles(deps, root, requiredFiles);
  if (missing.length) {
    return { id, title, status: "FAIL", detail: `cannot run: ${missing.join(", ")} not found (run pnpm install, or check out the repository files)`, fix: ["pnpm install --frozen-lockfile"] };
  }
  let lastLine = "";
  for (const spec of specs) {
    const r = execute(deps, spec);
    if (r.ok) lastLine = r.text.split("\n").filter(Boolean).pop()?.trim().slice(0, 110) ?? "";
    if (!r.ok) return { id, title, status: "FAIL", detail: r.text, fix: r.cannotRun ? [`make \`${spec.command}\` runnable, then re-run pnpm preflight`] : fixFor(r) };
  }
  return { id, title, status: "PASS", detail: lastLine, fix: [] };
}

/**
 * @param {{ root: string, options?: { tests?: boolean, base?: string }, deps: Deps, log?: (line: string) => void }} input
 * @returns {Promise<{ results: CheckResult[], mergeBase: string, base: string, behind: number, changed: number, totalMs: number }>}
 */
export async function runPreflight({ root, options = {}, deps, log = () => {} }) {
  const base = options.base ?? "origin/main";
  const startedAt = deps.now();
  const mergeBase = deps.git(["merge-base", "HEAD", base]).trim();
  const tracked = parseNameStatus(deps.git(["diff", "--name-status", "-z", "--no-renames", mergeBase]));
  const untracked = deps.git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).map((p) => ({ status: "A", path: p }));
  const seen = new Set(tracked.map((c) => c.path));
  const changes = [...tracked, ...untracked.filter((c) => !seen.has(c.path))];
  const cls = classifyChanges(changes);
  let behind = 0;
  try {
    behind = Number.parseInt(deps.git(["rev-list", "--count", `HEAD..${base}`]).trim(), 10) || 0;
  } catch {
    behind = 0;
  }
  log(`preflight: base ${base} (merge-base ${mergeBase.slice(0, 9)}), ${changes.length} changed file(s)${behind ? `, ${behind} commit(s) behind ${base}` : ""}`);
  if (behind) log(`  note: this branch is behind ${base}; run \`git fetch origin && git rebase ${base}\` so the checks see current main.`);

  const node = process.execPath;
  /** @type {Array<{ id: string, title: string, run: () => Omit<CheckResult, "ms"> }>} */
  const checks = [
    {
      id: "api-dts",
      title: "convex/_generated/api.d.ts matches the generator",
      run: () => {
        if (!cls.convexSide) return { id: "api-dts", title: "", status: "NOT APPLICABLE", detail: "no convex/ or test-utils/ file changed", fix: [] };
        let r;
        try {
          r = deps.checkApiDts({ root });
        } catch (error) {
          return { id: "api-dts", title: "", status: "FAIL", detail: `cannot run: ${error instanceof Error ? error.message : String(error)}`, fix: ["pnpm install --frozen-lockfile, then re-run; if the generated file is damaged: git restore convex/_generated/api.d.ts"] };
        }
        if (r.ok) return { id: "api-dts", title: "", status: "PASS", detail: `import and fullApi blocks hold the ${r.expectedCount ?? "?"} registerable modules in generator order`, fix: [] };
        const shown = r.problems.slice(0, 12);
        return {
          id: "api-dts", title: "", status: "FAIL",
          detail: `${r.problems.length} problem(s):\n${shown.map((p) => `  - ${p.message}`).join("\n")}${r.problems.length > shown.length ? `\n  ... ${r.problems.length - shown.length} more` : ""}`,
          fix: [...shown.map((p) => p.fix), "or regenerate it the way CI does (anonymous local backend, `convex dev --once`; see the convex-backend job in .github/workflows/test.yml)"],
        };
      },
    },
    {
      id: "guardrails",
      title: "quality guardrails (trusted target baseline)",
      run: () => commandCheck(deps, root, "guardrails", "", ["quality/guardrails/check.mjs"],
        [{ id: "guardrails", command: node, args: ["quality/guardrails/check.mjs", "--base", base], cwd: root }],
        () => [`node quality/guardrails/check.mjs --base ${base}`, "fix what it lists (size, import-boundary or ratchet), then re-run"]),
    },
    {
      id: "baseline-evidence",
      title: "contract-skew baseline renewal evidence",
      run: () => commandCheck(deps, root, "baseline-evidence", "", ["scripts/contractSkew/renewBaselineReviewed.mjs"],
        [{ id: "baseline-evidence", command: node, args: ["scripts/contractSkew/renewBaselineReviewed.mjs", "--reviewed", BASELINE_REVIEWED, "--check-evidence", "--pr-base", mergeBase], cwd: root }],
        (r) => r.status === 10
          ? [
            "a baseline entry names a file that changed since its review: revert that edit, or re-review the entry and renew it:",
            `node scripts/contractSkew/renewBaselineReviewed.mjs --reviewed ${BASELINE_REVIEWED} --expires <YYYY-MM-DD> --renewal "<why it is still correct>" --blob-evidence --write`,
            "commit everything first (the check reads HEAD blobs and refuses uncommitted files); see scripts/contractSkew/SCRUM-866-MAIN-DRIFT.md",
          ]
          : [
            `node scripts/contractSkew/renewBaselineReviewed.mjs --reviewed ${BASELINE_REVIEWED} --check-evidence --pr-base ${mergeBase}`,
            "the check itself stopped before judging: read the message above (uncommitted file named, shallow history, or a revision that is not an ancestor of HEAD)",
          ]),
    },
    {
      id: "eslint",
      title: "eslint on changed files",
      run: () => {
        if (cls.lintable.length === 0) return { id: "eslint", title: "", status: "NOT APPLICABLE", detail: "no changed lintable file (.js/.jsx/.mjs/.cjs/.ts/.tsx/.mts/.cts outside the lint ignores)", fix: [] };
        const bin = "node_modules/eslint/bin/eslint.js";
        const specs = [];
        for (let i = 0; i < cls.lintable.length; i += ESLINT_CHUNK) {
          specs.push({ id: "eslint", command: node, args: [bin, "--no-warn-ignored", ...cls.lintable.slice(i, i + ESLINT_CHUNK)], cwd: root });
        }
        const r = commandCheck(deps, root, "eslint", "", [bin], specs, () => [`node ${bin} --no-warn-ignored ${cls.lintable.slice(0, 6).join(" ")}${cls.lintable.length > 6 ? " ..." : ""}`, "fix the errors it lists (add `--fix` for the auto-fixable ones)"]);
        return r.status === "PASS" ? { ...r, detail: `${cls.lintable.length} file(s) clean` } : r;
      },
    },
    {
      id: "typecheck",
      title: "typecheck",
      run: () => {
        /** @type {Array<{ id: string, script: string }>} */
        const wanted = [];
        if (cls.convexSide) wanted.push({ id: "typecheck-convex", script: "typecheck:convex" });
        if (cls.rootSide) wanted.push({ id: "typecheck-root", script: "typecheck" });
        if (cls.contractSkewSide) wanted.push({ id: "typecheck-contract-skew", script: "typecheck:contract-skew" });
        if (wanted.length === 0) return { id: "typecheck", title: "", status: "NOT APPLICABLE", detail: "no convex/, test-utils/, root TypeScript or contract-skew file changed", fix: [] };
        const failures = [];
        for (const w of wanted) {
          const r = commandCheck(deps, root, "typecheck", "", ["package.json"], [{ id: w.id, command: "pnpm", args: ["run", w.script], cwd: root }], () => [`pnpm ${w.script}`, "fix the type errors it lists"]);
          if (r.status === "FAIL") failures.push({ w, r });
        }
        const ran = wanted.map((w) => (w.id === "typecheck-root" ? "pnpm typecheck (root)" : `pnpm ${w.script}`)).join(", ");
        if (failures.length === 0) return { id: "typecheck", title: "", status: "PASS", detail: `ran ${ran}`, fix: [] };
        return {
          id: "typecheck", title: "", status: "FAIL",
          detail: failures.map((f) => `${f.w.script}:\n${f.r.detail}`).join("\n"),
          fix: failures.flatMap((f) => f.r.fix),
        };
      },
    },
    {
      id: "tests",
      title: "vitest on changed test files",
      run: () => {
        if (!options.tests) return { id: "tests", title: "", status: "NOT APPLICABLE", detail: "pass --tests to run vitest on changed *.test.ts files", fix: [] };
        if (cls.testFiles.length === 0) return { id: "tests", title: "", status: "NOT APPLICABLE", detail: "no changed *.test.ts / *.test.tsx file", fix: [] };
        const bin = "node_modules/vitest/vitest.mjs";
        const args = [bin, "run", "--maxWorkers=1", ...cls.testFiles];
        const r = commandCheck(deps, root, "tests", "", [bin], [{ id: "tests", command: node, args, cwd: root }], () => [`node ${args.join(" ")}`, "fix the failing assertions it lists"]);
        return r.status === "PASS" ? { ...r, detail: `${cls.testFiles.length} test file(s) passed` } : r;
      },
    },
  ];

  /** @type {CheckResult[]} */
  const results = [];
  for (const check of checks) {
    const t0 = deps.now();
    let partial;
    try {
      partial = check.run();
    } catch (error) {
      partial = { id: check.id, title: "", status: /** @type {const} */ ("FAIL"), detail: `cannot run: ${error instanceof Error ? error.message : String(error)}`, fix: ["re-run with the underlying command to see the error"] };
    }
    /** @type {CheckResult} */
    const result = { ...partial, title: check.title, ms: deps.now() - t0 };
    results.push(result);
    log(formatLine(result));
  }
  const totalMs = deps.now() - startedAt;
  const failed = results.filter((r) => r.status === "FAIL");
  for (const r of failed) {
    log(`\n--- ${r.id} FAILED ---`);
    if (r.detail) log(r.detail);
    if (r.fix.length) log(`fix:\n${r.fix.map((f) => `  ${f}`).join("\n")}`);
  }
  log(`\ntotal ${(totalMs / 1000).toFixed(1)}s: ${results.filter((r) => r.status === "PASS").length} passed, ${failed.length} failed, ${results.filter((r) => r.status === "NOT APPLICABLE").length} not applicable`);
  log(failed.length ? `preflight FAILED (${failed.map((r) => r.id).join(", ")})` : "preflight passed");
  return { results, mergeBase, base, behind, changed: changes.length, totalMs };
}

/** @param {CheckResult} r */
function formatLine(r) {
  const first = r.detail.split("\n")[0];
  const summary = r.status === "FAIL" ? "see the details below" : first;
  return `${r.status.padEnd(14)}  ${r.id.padEnd(18)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${summary}`;
}

/** @returns {Deps} */
function realDeps(root) {
  const git = resolveGit() ?? "git";
  return {
    git: (args) => execFileSync(git, ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }),
    run: (spec) => {
      const options = { cwd: spec.cwd ?? root, encoding: /** @type {const} */ ("utf8"), maxBuffer: 512 * 1024 * 1024, windowsHide: true, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } };
      if (spec.command !== "pnpm") return spawnSync(spec.command, spec.args, options);
      // Under `pnpm preflight`, npm_execpath is pnpm itself: run it with this node, no shell involved.
      const execpath = process.env.npm_execpath;
      if (execpath && /pnpm/i.test(path.basename(execpath))) return spawnSync(process.execPath, [execpath, ...spec.args], options);
      // Direct `node scripts/preflight/preflight.mjs`: pnpm is a .cmd shim on Windows, which needs a shell. Args are fixed strings.
      return process.platform === "win32" ? spawnSync(`pnpm ${spec.args.join(" ")}`, { ...options, shell: true }) : spawnSync("pnpm", spec.args, options);
    },
    exists: (p) => fs.existsSync(p),
    checkApiDts,
    now: () => Date.now(),
  };
}

const USAGE = "usage: pnpm preflight [--tests] [--base <ref>]";

/** @param {string[]} argv @returns {Promise<number>} the process exit code */
export async function main(argv, root = REPO_ROOT) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { tests: { type: "boolean" }, base: { type: "string" }, help: { type: "boolean" } }, strict: true }));
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const { results } = await runPreflight({ root, options: { tests: Boolean(values.tests), base: values.base }, deps: realDeps(root), log: (l) => console.log(l) });
    return exitCodeOf(results);
  } catch (error) {
    // Could not even work out what changed (no git, no origin/main): that is a failed preflight, not a pass.
    console.error(`preflight FAILED: cannot determine the change set: ${error instanceof Error ? error.message : String(error)}\nfix: git fetch origin   (and run from inside the repository)`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
