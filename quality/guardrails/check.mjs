#!/usr/bin/env node
// SCRUM-426 — blocking file-size + import-boundary guardrails.
//
// TRUST MODEL. The allowance (thresholds, exemptions, generated/migration lists,
// size ceilings, grandfathered imports) is read from the TARGET branch with
// `git`, never from the PR tree, so a PR cannot raise its own allowance:
//   pull_request : origin/$GITHUB_BASE_REF
//   push         : the pre-push SHA (github.event.before via GUARDRAILS_PUSH_BEFORE);
//                  a missing/zero SHA or a non-fast-forward push fails closed
// On bootstrap (target has no guardrail files) the PR's config is checked
// against the pinned owner policy (rules.mjs BOOTSTRAP_POLICY) and may exclude
// only files that already exist on the target. Prettier options always come
// from the target.
//   local        : origin/main, or --base <ref>
// The PR tree's config/baseline are the NEXT target: they are checked for
// completeness against disk and may only tighten. Residual risk: a PR can edit
// this checker or the workflow step itself; that is visible in review only.
//
// Usage: node quality/guardrails/check.mjs [--base <ref>] [--write-baseline [--source <ref>]]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BASELINE_PATH,
  CONFIG_PATH,
  JUSTIFIED_LISTS,
  buildBaseline,
  canonicalJson,
  classify,
  compareCodeUnits,
  enforcementScope,
  evaluate,
  importViolations,
  measureLines,
  normalizeRepoPath,
  parseBaseline,
  parseConfig,
  sortViolations,
} from "./rules.mjs";

const PRETTIER_RC = ".prettierrc";

function git(cwd, args, input) {
  const result = spawnSync("git", args, {
    cwd,
    input,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function gitText(cwd, args) {
  const result = git(cwd, args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8").trim()}`);
  }
  return result.stdout.toString("utf8");
}

/**
 * Which ref holds the trusted allowance. Never falls back to the PR tree.
 * @param {Record<string, string | undefined>} env
 * @param {string | undefined} explicit
 */
export function resolveBaseRef(env, explicit) {
  if (explicit) return explicit;
  if (env.GITHUB_BASE_REF) return `origin/${env.GITHUB_BASE_REF}`;
  if (env.GITHUB_EVENT_NAME === "push") {
    // The target before THIS push — not HEAD^, which a multi-commit push controls.
    const before = env.GUARDRAILS_PUSH_BEFORE ?? "";
    if (!/^[0-9a-f]{40}$/u.test(before) || /^0+$/u.test(before)) {
      throw new Error("A push run needs the pre-push SHA in GUARDRAILS_PUSH_BEFORE (github.event.before).");
    }
    return before;
  }
  return "origin/main";
}

function resolveCommit(cwd, ref) {
  const result = git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (result.status !== 0) {
    throw new Error(
      `Trusted base "${ref}" does not resolve. In CI the checkout needs the target ` +
        "branch history (fetch-depth: 0). Refusing to fall back to the PR tree.",
    );
  }
  return result.stdout.toString("utf8").trim();
}

/** File text at a commit, or null when the path does not exist there. */
function readAtCommit(cwd, commit, repoPath) {
  const exists = git(cwd, ["cat-file", "-e", `${commit}:${repoPath}`]);
  if (exists.status !== 0) return null;
  return gitText(cwd, ["show", `${commit}:${repoPath}`]);
}

/** Tracked + untracked-not-ignored files that exist on disk (the PR tree). */
function diskInventory(cwd) {
  const raw = gitText(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const paths = new Set();
  for (const entry of raw.split("\0")) {
    if (entry && existsSync(path.join(cwd, entry))) paths.add(normalizeRepoPath(entry));
  }
  return [...paths].sort(compareCodeUnits);
}

/** {path -> blob sha} for every blob in a commit's tree. */
function treeBlobs(cwd, commit) {
  const raw = gitText(cwd, ["ls-tree", "-r", "-z", commit]);
  const blobs = new Map();
  for (const entry of raw.split("\0")) {
    const match = /^\d+ blob ([0-9a-f]{40})\t(.+)$/u.exec(entry);
    if (match) blobs.set(normalizeRepoPath(match[2]), match[1]);
  }
  return blobs;
}

/** Read many blobs in one `git cat-file --batch` process. */
function readBlobs(cwd, shas) {
  const unique = [...new Set(shas)];
  const out = new Map();
  if (unique.length === 0) return out;
  const result = git(cwd, ["cat-file", "--batch"], `${unique.join("\n")}\n`);
  if (result.status !== 0) throw new Error("git cat-file --batch failed");
  const buffer = result.stdout;
  let offset = 0;
  for (const sha of unique) {
    const headerEnd = buffer.indexOf(10, offset);
    const header = buffer.subarray(offset, headerEnd).toString("utf8").split(" ");
    const size = Number(header[2]);
    if (header[0] !== sha || !Number.isInteger(size)) throw new Error(`bad cat-file header for ${sha}`);
    out.set(sha, buffer.subarray(headerEnd + 1, headerEnd + 1 + size).toString("utf8"));
    offset = headerEnd + 1 + size + 1;
  }
  return out;
}

function prettierOptionsFrom(text, label) {
  if (text === null) return {};
  const options = JSON.parse(text);
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error(`${label}: .prettierrc must be a JSON object.`);
  }
  return options;
}

/**
 * Measure a set of files: formatted line counts for every file that is
 * production under ANY of the given configs, and import violations.
 * `lineCache` (path + content hash -> result) lets a run that measures two
 * nearly identical trees (bootstrap) format each unchanged file once; it is
 * only shared between calls that use the same Prettier options.
 */
async function measure({ files, readText, configs, prettierOptions, lineCache = new Map() }) {
  const prettier = (await import("prettier")).default;
  const counts = new Map();
  const unformatted = [];
  const violations = [];
  const primary = configs[0];
  const wanted = files.filter((p) => configs.some((c) => classify(p, c) === "production"));
  const BATCH = 16;
  for (let i = 0; i < wanted.length; i += BATCH) {
    const chunk = wanted.slice(i, i + BATCH);
    const results = await Promise.all(
      chunk.map(async (filePath) => {
        const text = readText(filePath);
        const key = createHash("sha256").update(filePath).update("\0").update(text.replaceAll("\r\n", "\n")).digest("hex");
        let measured = lineCache.get(key);
        if (!measured) {
          measured = await measureLines(filePath, text, prettierOptions, prettier);
          lineCache.set(key, measured);
        }
        return { filePath, text, measured };
      }),
    );
    for (const { filePath, text, measured } of results) {
      counts.set(filePath, measured.lines);
      if (!measured.formatted) unformatted.push(filePath);
      violations.push(...importViolations(filePath, text, primary));
    }
  }
  return { inventory: files, counts, violations: sortViolations(violations), unformatted };
}

async function measureCommit(cwd, commit, config, prettierOptions, lineCache) {
  const blobs = treeBlobs(cwd, commit);
  const files = [...blobs.keys()].sort(compareCodeUnits);
  const needed = files.filter((p) => classify(p, config) === "production");
  const texts = readBlobs(cwd, needed.map((p) => blobs.get(p)));
  return measure({
    files,
    readText: (p) => texts.get(blobs.get(p)),
    configs: [config],
    prettierOptions,
    lineCache,
  });
}

/**
 * Which of `paths` have text identical to the target's: files the PR brings into
 * scope (the only ones that may be adopted with a new ceiling) and, on
 * bootstrap, the excluded files (which the first PR may not edit).
 */
function unchangedFromTarget(cwd, paths, targetBlobs, readDisk) {
  const candidates = [...new Set(paths)].filter((p) => targetBlobs.has(p));
  const texts = readBlobs(cwd, candidates.map((p) => targetBlobs.get(p)));
  const normalize = (text) => text.replaceAll("\r\n", "\n");
  return new Set(candidates.filter((p) => normalize(texts.get(targetBlobs.get(p))) === normalize(readDisk(p))));
}

function loadPair(configText, baselineText, label) {
  return {
    config: parseConfig(configText, `${label} ${CONFIG_PATH}`),
    baseline: parseBaseline(baselineText, `${label} ${BASELINE_PATH}`),
  };
}

/**
 * Bootstrap (the target branch has no guardrail files yet — only the PR that
 * introduces them): the proposed baseline is trusted only if it is EXACTLY the
 * recomputation of its sourceCommit, and that commit is an ancestor of the base.
 */
async function verifyBootstrap(cwd, baseCommit, proposed, prettierOptions, lineCache, errors) {
  const source = proposed.baseline.sourceCommit;
  const ancestor = git(cwd, ["merge-base", "--is-ancestor", source, baseCommit]);
  if (ancestor.status !== 0) {
    errors.push(`BOOTSTRAP baseline sourceCommit ${source} is not an ancestor of the target base`);
    return;
  }
  const measured = await measureCommit(cwd, source, proposed.config, prettierOptions, lineCache);
  const expected = buildBaseline(source, proposed.config, measured, null);
  if (canonicalJson(expected) !== canonicalJson(proposed.baseline)) {
    errors.push(
      `BOOTSTRAP baseline does not equal the recomputation at ${source}; ` +
        "regenerate with --write-baseline --source <that commit>",
    );
  }
}

/**
 * @param {{ cwd: string, env?: Record<string, string | undefined>, base?: string,
 *   log?: (message: string) => void,
 *   bootstrapPolicy?: { maxLines: number, productionRoots: string[], extensions: string[],
 *     nonDoors: string[] } }} options
 */
export async function runGuardrails({ cwd, env = process.env, base, log = () => {}, bootstrapPolicy }) {
  const baseRef = resolveBaseRef(env, base);
  const baseCommit = resolveCommit(cwd, baseRef);
  if (!base && env.GITHUB_EVENT_NAME === "push" &&
    git(cwd, ["merge-base", "--is-ancestor", baseCommit, "HEAD"]).status !== 0) {
    throw new Error(`Pre-push SHA ${baseCommit} is not an ancestor of HEAD (non-fast-forward push); refusing.`);
  }
  const tConfig = readAtCommit(cwd, baseCommit, CONFIG_PATH);
  const tBaseline = readAtCommit(cwd, baseCommit, BASELINE_PATH);
  if ((tConfig === null) !== (tBaseline === null)) {
    throw new Error(`Target ${baseRef} has only one of ${CONFIG_PATH} / ${BASELINE_PATH}.`);
  }
  const readDisk = (p) => readFileSync(path.join(cwd, p), "utf8");
  for (const required of [CONFIG_PATH, BASELINE_PATH]) {
    if (!existsSync(path.join(cwd, required))) {
      return { baseRef, baseCommit, bootstrap: false, errors: [`MISSING ${required} in the PR tree`], notices: [] };
    }
  }
  const proposed = loadPair(readDisk(CONFIG_PATH), readDisk(BASELINE_PATH), "PR-tree");
  const bootstrap = tConfig === null;
  const trusted = bootstrap ? proposed : loadPair(tConfig, tBaseline, `target(${baseRef})`);
  // Formatting options are part of the allowance: always the target's, bootstrap included.
  const prettierOptions = prettierOptionsFrom(readAtCommit(cwd, baseCommit, PRETTIER_RC), baseRef);
  log(`guardrails: trusted base ${baseRef} (${baseCommit.slice(0, 12)})${bootstrap ? " — BOOTSTRAP" : ""}`);

  const inventory = diskInventory(cwd);
  const lineCache = new Map();
  const measured = await measure({
    files: inventory,
    readText: readDisk,
    configs: [trusted.config, proposed.config, enforcementScope(trusted.config, proposed.config)],
    prettierOptions,
    lineCache,
  });
  const targetBlobs = treeBlobs(cwd, baseCommit);
  measured.targetInventory = new Set(targetBlobs.keys());
  const onDisk = new Set(inventory);
  const newlyScoped = [...measured.counts.keys()].filter((p) => classify(p, trusted.config) !== "production");
  const excluded = bootstrap
    ? JUSTIFIED_LISTS.flatMap((name) => proposed.config[name].map((entry) => entry.path)).filter((p) => onDisk.has(p))
    : [];
  measured.unchangedFromTarget = unchangedFromTarget(cwd, [...newlyScoped, ...excluded], targetBlobs, readDisk);
  const { errors, notices } = evaluate({ trusted, proposed, measured, bootstrap, bootstrapPolicy });
  for (const file of measured.unformatted) notices.push(`UNFORMATTABLE ${file}: counted unformatted`);
  if (bootstrap) {
    notices.push("BOOTSTRAP: target has no guardrail files; PR-tree baseline verified by recomputation");
    await verifyBootstrap(cwd, baseCommit, proposed, prettierOptions, lineCache, errors);
  }
  return { baseRef, baseCommit, bootstrap, errors, notices, measured };
}

export async function writeBaseline(cwd, sourceRef, baseRef) {
  const sourceCommit = resolveCommit(cwd, sourceRef);
  const config = parseConfig(readFileSync(path.join(cwd, CONFIG_PATH), "utf8"), CONFIG_PATH);
  const baseCommit = resolveCommit(cwd, baseRef);
  const tBaseline = readAtCommit(cwd, baseCommit, BASELINE_PATH);
  const trusted = tBaseline === null ? null : parseBaseline(tBaseline, `target ${BASELINE_PATH}`);
  const prettierOptions = prettierOptionsFrom(readAtCommit(cwd, sourceCommit, PRETTIER_RC), sourceRef);
  const measured = await measureCommit(cwd, sourceCommit, config, prettierOptions);
  const baseline = buildBaseline(sourceCommit, config, measured, trusted);
  writeFileSync(path.join(cwd, BASELINE_PATH), canonicalJson(baseline));
  return baseline;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const cwd = gitText(process.cwd(), ["rev-parse", "--show-toplevel"]).trim();
  const base = argValue(args, "--base");
  if (args.includes("--write-baseline")) {
    const baseline = await writeBaseline(cwd, argValue(args, "--source") ?? "HEAD", resolveBaseRef(process.env, base));
    console.log(
      `wrote ${BASELINE_PATH}: ${Object.keys(baseline.sizeCeilings).length} size ceilings, ` +
        `${baseline.importGrandfather.length} grandfathered imports @ ${baseline.sourceCommit}`,
    );
    return;
  }
  const result = await runGuardrails({ cwd, base, log: (m) => console.log(m) });
  for (const notice of result.notices) console.log(`note: ${notice}`);
  for (const error of result.errors) console.error(`FAIL: ${error}`);
  if (result.measured) {
    console.log(`guardrails: ${result.measured.counts.size} production files measured, ` +
      `${result.measured.violations.length} import-boundary violations (all must be grandfathered)`);
  }
  if (result.errors.length > 0) {
    console.error(`guardrails: ${result.errors.length} blocking failure(s).`);
    process.exitCode = 1;
  } else {
    console.log("guardrails: pass");
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`guardrails: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
}
