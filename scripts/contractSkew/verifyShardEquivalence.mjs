#!/usr/bin/env node
/**
 * SCRUM-873 equivalence proof. Reads nothing but the two things it compares and writes nothing.
 *
 *   node scripts/contractSkew/verifyShardEquivalence.mjs --legacy-rev <rev> [--baseline <dir>]
 *
 * It proves, in this order:
 *   1. the single needs-evidence-baseline.json at <rev> (read from git, so the working tree cannot influence it)
 *      is exactly {version: 1, entries: [...]} and nothing is dropped by the split;
 *   2. the shard directory loads through the production loader (no stray file, no duplicate, no wrong shard);
 *   3. the two entry sets are equal key for key and value for value (canonical JSON of every entry, `renewal` prose
 *      included), with the same count and no duplicate identity on either side;
 *   4. regenerating the shards from the old entries reproduces every file on disk byte for byte, so the committed
 *      shards are the writer's output and not a hand edit;
 *   5. every entry sits in the shard that encodes its own client file.
 *
 * Exit 0 equivalent; 10 not equivalent; 3 unavailable (usage, git, unreadable input). Never a silent pass.
 */
import { parseArgs } from "node:util";
import { assertSafeRevision, resolveCommit, resolveGit, runGitText } from "./gitExecutable.mjs";
import { resolveInside } from "./baselineFile.mjs";
import { BASELINE_DIRECTORY, LEGACY_BASELINE_FILE, buildShardFiles, canonicalJson, entrySetDifferences, identityOf, shardNameFor } from "./baselineShards.mjs";
import { loadBaseline } from "./baseline.mjs";
import { entriesOfLegacyText } from "./shardBaseline.mjs";
import { isRunDirectly } from "./runDirectly.mjs";

const EXIT_NOT_EQUIVALENT = 10;
const EXIT_UNAVAILABLE = 3;
const DEFAULT_IO = Object.freeze({ log: console.log, error: console.error });

/**
 * @param {string[]} argv
 * @param {{ log: (line: string) => void, error: (line: string) => void }} [io]
 * @param {string} [root]
 * @returns {number}
 */
export function main(argv, io = DEFAULT_IO, root = process.cwd()) {
  try {
    const { values } = parseArgs({ args: argv, options: {
      "legacy-rev": { type: "string" }, baseline: { type: "string", default: BASELINE_DIRECTORY },
    } });
    if (values["legacy-rev"] === undefined) throw new Error("Required: --legacy-rev <rev> (the commit that still holds the single file)");
    const git = resolveGit();
    if (!git) throw new Error("git could not be located (set CONTRACT_SKEW_GIT to an absolute path)");
    const commit = resolveCommit(git, assertSafeRevision(values["legacy-rev"], "legacy revision"), root);
    const legacyText = runGitText(git, ["show", `${commit}:${LEGACY_BASELINE_FILE}`], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
    const legacy = entriesOfLegacyText(legacyText);
    const directory = resolveInside(root, values.baseline, "baseline");
    return compare(legacy, directory, `${LEGACY_BASELINE_FILE} at ${commit.slice(0, 9)}`, io, values.baseline);
  } catch (error) {
    io.error(`Shard equivalence UNAVAILABLE; nothing was proven: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_UNAVAILABLE;
  }
}

/**
 * @param {Array<Record<string, any>>} legacy
 * @param {string} directory
 * @param {string} origin
 * @param {{ log: (line: string) => void, error: (line: string) => void }} io
 * @param {string} label  the directory as the caller named it (printed instead of the absolute path)
 */
function compare(legacy, directory, origin, io, label) {
  const loaded = loadBaseline(directory);
  if (!loaded.ok) {
    io.error(`NOT EQUIVALENT: the shard directory does not load: ${loaded.problem}`);
    return EXIT_NOT_EQUIVALENT;
  }
  const difference = entrySetDifferences(legacy, loaded.entries);
  const onDisk = loaded.files;
  const regenerated = buildShardFiles(legacy, onDisk);
  const regenerationDiffers = [
    ...[...regenerated].filter(([name, text]) => onDisk.get(name) !== text).map(([name]) => name),
    ...[...onDisk.keys()].filter((name) => !regenerated.has(name)),
  ];
  const misplaced = loaded.entries.filter((entry) => !onDisk.has(shardNameFor(entry.file))).map((entry) => identityOf(entry).replaceAll("\u0001", " "));
  const surfaces = (/** @type {Array<Record<string, any>>} */ entries) => canonicalJson(Object.fromEntries(
    [...new Set(entries.map((e) => e.surface))].sort().map((s) => [s, entries.filter((e) => e.surface === s).length])));

  io.log(`legacy ${origin}: ${legacy.length} entries ${surfaces(legacy)}`);
  io.log(`shards ${label}:${loaded.entries.length} entries in ${onDisk.size} shards ${surfaces(loaded.entries)}`);
  io.log(`entry sets: ${difference.equal ? "EQUAL" : "DIFFERENT"} (only in legacy ${difference.onlyBefore.length}, only in shards ${difference.onlyAfter.length}, value differences ${difference.different.length}, duplicates ${difference.duplicates.length})`);
  io.log(`byte-stable regeneration: ${regenerationDiffers.length === 0 ? "every shard reproduced exactly" : `${regenerationDiffers.length} shard(s) differ: ${regenerationDiffers.slice(0, 5).join(", ")}`}`);
  io.log(`entries in the wrong shard: ${misplaced.length}`);

  if (!difference.equal || regenerationDiffers.length || misplaced.length) {
    io.error(`NOT EQUIVALENT: ${JSON.stringify({ ...difference, regenerationDiffers, misplaced }).slice(0, 2000)}`);
    return EXIT_NOT_EQUIVALENT;
  }
  io.log(`EQUIVALENT: ${legacy.length} entries, key for key and value for value.`);
  return 0;
}

if (isRunDirectly(import.meta.url)) process.exitCode = main(process.argv.slice(2));
