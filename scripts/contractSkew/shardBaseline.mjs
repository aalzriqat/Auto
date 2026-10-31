#!/usr/bin/env node
/**
 * Explicit author tool (SCRUM-873); never imported or invoked by the production monitor.
 *
 *   --split                  one-time: turn the single needs-evidence-baseline.json into the shard directory.
 *       [--source <file>]        the single file in the working tree (default: the old location)
 *       [--source-rev <rev>]     read the single file from git instead
 *       [--remove-source]        with --write: delete the working-tree single file once the shards are proven equal
 *   --from-branch <ref>      migrate an open pull request: apply the baseline edits that branch made to the single file
 *                            (relative to its merge base with --base) onto the shard directory in the working tree.
 *       [--base <ref>]           default origin/main
 *
 * Both default to a dry run; `--write` applies. Every mode needs `--baseline <dir>` to default to the repository's.
 *
 * HOW A BRANCH IS MIGRATED. Entries are matched by identity (surface, file, callSiteId, functionId, contractPath, kind).
 * For each identity, with B = the merge base, T = the branch tip, O = the shard directory now:
 *   T equals B                     the branch did not touch it;
 *   O equals T                     already applied (idempotent);
 *   O equals B                     apply the branch's addition, removal or edit;
 *   otherwise                      CONFLICT: main and the branch both changed it, a person decides. Nothing is written.
 * A relocation (the call moved, so the identity changed) is a removal plus an addition, and so is applied.
 * The branch is named by the commit BEFORE main was merged into it: once main (which deleted the single file) is
 * merged, the branch's own edits are no longer visible at its tip.
 *
 * Exit 0 done; 10 conflicts or an unequal split; 3 unavailable (usage, git, unreadable input).
 */
import fs from "node:fs";
import { parseArgs } from "node:util";
import { assertSafeRevision, resolveCommit, resolveGit, runGitText } from "./gitExecutable.mjs";
import { parseCanonicalBaseline, resolveInside } from "./baselineFile.mjs";
import { baselineAtRevision } from "./baselineRevision.mjs";
import {
  BASELINE_DIRECTORY, LEGACY_BASELINE_FILE, buildShardFiles, canonicalJson, entrySetDifferences, identityOf, loadShardedBaseline,
  parseShardSet, writeShardedBaseline,
} from "./baselineShards.mjs";
import { isRunDirectly } from "./runDirectly.mjs";

const EXIT_CONFLICT = 10;
const EXIT_UNAVAILABLE = 3;
const DEFAULT_IO = Object.freeze({ log: console.log, error: console.error });

/**
 * The entries of a single-file baseline text, refusing anything the split would silently drop.
 * @param {string} text
 * @returns {Array<Record<string, any>>}
 */
export function entriesOfLegacyText(text) {
  const document = parseCanonicalBaseline(text);
  const extra = Object.keys(document).filter((key) => key !== "version" && key !== "entries");
  if (document.version !== 1 || !Array.isArray(document.entries) || extra.length) {
    throw new Error(`the single baseline file must be {version: 1, entries: [...]} and nothing else (found ${Object.keys(document).join(", ")}); refusing to drop fields`);
  }
  return document.entries;
}

/**
 * Three-way merge of entry sets by identity. See the header.
 * @param {Array<Record<string, any>>} base
 * @param {Array<Record<string, any>>} theirs
 * @param {Array<Record<string, any>>} ours
 */
export function mergeEntryChanges(base, theirs, ours) {
  const index = (/** @type {Array<Record<string, any>>} */ entries, /** @type {string} */ role) => {
    /** @type {Map<string, Record<string, any>>} */
    const map = new Map();
    for (const entry of entries) {
      const key = identityOf(entry);
      if (map.has(key)) throw new Error(`duplicate baseline identity in the ${role} set: ${key.replaceAll("\u0001", " ")}`);
      map.set(key, entry);
    }
    return map;
  };
  const b = index(base, "merge base");
  const t = index(theirs, "branch");
  const o = index(ours, "current");
  const same = (/** @type {Record<string, any> | undefined} */ x, /** @type {Record<string, any> | undefined} */ y) =>
    (x === undefined && y === undefined) || (x !== undefined && y !== undefined && canonicalJson(x) === canonicalJson(y));
  const result = new Map(o);
  const counts = { added: 0, removed: 0, changed: 0, alreadyApplied: 0 };
  /** @type {string[]} */
  const conflicts = [];
  for (const key of new Set([...b.keys(), ...t.keys()])) {
    const [base1, their, our] = [b.get(key), t.get(key), o.get(key)];
    if (same(base1, their)) continue;
    if (same(our, their)) counts.alreadyApplied++;
    else if (same(our, base1)) {
      if (their === undefined) {
        result.delete(key);
        counts.removed++;
      } else {
        result.set(key, their);
        if (base1 === undefined) counts.added++;
        else counts.changed++;
      }
    } else conflicts.push(key.replaceAll("\u0001", " "));
  }
  return { entries: [...result.values()], ...counts, conflicts };
}

/**
 * @param {string[]} argv
 * @param {{ log: (line: string) => void, error: (line: string) => void }} [io]
 * @param {string} [root]  the repository root; every path stays inside it
 * @returns {number} the process exit code
 */
export function main(argv, io = DEFAULT_IO, root = process.cwd()) {
  try {
    const { values } = parseArgs({ args: argv, options: {
      split: { type: "boolean" }, "from-branch": { type: "string" }, base: { type: "string", default: "origin/main" },
      baseline: { type: "string", default: BASELINE_DIRECTORY }, source: { type: "string", default: LEGACY_BASELINE_FILE },
      "source-rev": { type: "string" }, "remove-source": { type: "boolean" }, write: { type: "boolean" },
    } });
    if (Boolean(values.split) === (values["from-branch"] !== undefined)) throw new Error("Required: exactly one of --split or --from-branch <ref>");
    if (values["remove-source"] && !(values.split && values.write)) throw new Error("--remove-source needs --split --write");
    const directory = resolveInside(root, values.baseline, "baseline");
    return values.split ? split(values, directory, root, io) : fromBranch(values, directory, root, io);
  } catch (error) {
    io.error(`Baseline sharding UNAVAILABLE; nothing was written: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_UNAVAILABLE;
  }
}

/** @param {any} values @param {string} directory @param {string} root @param {{ log: (line: string) => void, error: (line: string) => void }} io */
function split(values, directory, root, io) {
  /** @type {string} */
  let text;
  let origin;
  if (values["source-rev"] !== undefined) {
    const git = resolveGit();
    if (!git) throw new Error("git could not be located (set CONTRACT_SKEW_GIT to an absolute path)");
    const revision = assertSafeRevision(values["source-rev"], "source revision");
    text = runGitText(git, ["show", `${resolveCommit(git, revision, root)}:${LEGACY_BASELINE_FILE}`], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
    origin = `${LEGACY_BASELINE_FILE} at ${revision}`;
  } else {
    const source = resolveInside(root, values.source, "source");
    text = fs.readFileSync(source, "utf8");
    origin = values.source;
  }
  const entries = entriesOfLegacyText(text);
  const files = buildShardFiles(entries);
  const parsed = parseShardSet(files);
  if (!parsed.ok) throw new Error(parsed.problem);
  const difference = entrySetDifferences(entries, parsed.entries);
  if (!difference.equal) {
    io.error(`The shards do not reproduce ${origin}; nothing was written. Differences: ${JSON.stringify(difference)}`);
    return EXIT_CONFLICT;
  }
  if (fs.existsSync(directory) && fs.readdirSync(directory).length > 0) {
    throw new Error(`${values.baseline} already holds files; it is already sharded (use --from-branch to migrate a branch)`);
  }
  io.log(`${origin}: ${entries.length} entries -> ${files.size} shards, key-for-key and value-for-value equal. ${values.write ? "Writing." : "Dry run; pass --write to apply."}`);
  if (values.write) {
    writeShardedBaseline(directory, entries, { before: new Map(), root });
    const reloaded = loadShardedBaseline(directory);
    if (!reloaded.ok || !entrySetDifferences(entries, reloaded.entries).equal) throw new Error("the written shards do not reload to the same entries; inspect the directory");
    if (values["remove-source"]) {
      fs.rmSync(resolveInside(root, values.source, "source"));
      io.log(`removed ${values.source}`);
    }
  }
  return 0;
}

/** @param {any} values @param {string} directory @param {string} root @param {{ log: (line: string) => void, error: (line: string) => void }} io */
function fromBranch(values, directory, root, io) {
  const git = resolveGit();
  if (!git) throw new Error("git could not be located (set CONTRACT_SKEW_GIT to an absolute path)");
  const branch = resolveCommit(git, assertSafeRevision(values["from-branch"], "branch"), root);
  const base = resolveCommit(git, assertSafeRevision(values.base, "base"), root);
  const mergeBase = runGitText(git, ["merge-base", branch, base], { cwd: root }).trim();
  const [before, after] = [baselineAtRevision(git, root, mergeBase), baselineAtRevision(git, root, branch)];
  if (before.layout !== "legacy" || after.layout !== "legacy") {
    throw new Error(`the branch ${values["from-branch"]} and its merge base with ${values.base} are not both in the single-file layout (${before.layout}, ${after.layout}); name the branch tip from BEFORE main was merged into it`);
  }
  const changes = entrySetDifferences(before.entries, after.entries);
  if (changes.equal) {
    io.log(`${values["from-branch"]} does not edit any baseline entry relative to ${mergeBase.slice(0, 9)}; nothing to migrate.`);
    return 0;
  }
  const loaded = loadShardedBaseline(directory);
  if (!loaded.ok) throw new Error(loaded.problem);
  const merged = mergeEntryChanges(before.entries, after.entries, loaded.entries);
  io.log(`${values["from-branch"]} vs ${mergeBase.slice(0, 9)}: ${merged.added} added, ${merged.removed} removed, ${merged.changed} edited, ${merged.alreadyApplied} already applied, ${merged.conflicts.length} conflicting.`);
  for (const conflict of merged.conflicts) io.error(`CONFLICT (main and the branch both changed it; a person decides): ${conflict}`);
  if (merged.conflicts.length) return EXIT_CONFLICT;
  if (values.write) {
    const result = writeShardedBaseline(directory, merged.entries, { before: loaded.files, root });
    io.log(`wrote ${result.written.length} shard(s), removed ${result.removed.length}, left ${result.unchanged} untouched.`);
  } else {
    io.log("Dry run; pass --write to apply.");
  }
  return 0;
}

if (isRunDirectly(import.meta.url)) process.exitCode = main(process.argv.slice(2));
