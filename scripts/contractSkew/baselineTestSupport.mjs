/**
 * Test-only helpers: build, read and snapshot a sharded baseline directory (see baselineShards.mjs). Every
 * contract-skew test that used to write a one-file `baseline.json` now writes a directory through here, so
 * the fixtures exercise the same loader and writer as production.
 */
import fs from "node:fs";
import path from "node:path";
import { compareCodeUnits } from "./compareCodeUnits.mjs";
import { buildShardFiles, loadShardedBaseline, readShardFiles } from "./baselineShards.mjs";

/**
 * Replace `directory` with the shards for `entries` (an empty list becomes the explicit empty marker).
 * @param {string} directory
 * @param {Array<Record<string, any>>} entries
 * @returns {string} `directory`
 */
export function writeBaselineDirectory(directory, entries) {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, text] of buildShardFiles(entries, new Map(), { allowEmpty: true })) {
    fs.writeFileSync(path.join(directory, name), text);
  }
  return directory;
}

/**
 * The entries of a baseline directory, through the production loader.
 * @param {string} directory
 * @returns {Array<Record<string, any>>}
 */
export function readBaselineEntries(directory) {
  const loaded = loadShardedBaseline(directory);
  if (!loaded.ok) throw new Error(`fixture baseline does not load: ${loaded.problem}`);
  return loaded.entries;
}

/**
 * Every shard's name and text as one string, so a test can assert a directory is byte-identical.
 * @param {string} directory
 * @returns {string}
 */
export function snapshotBaseline(directory) {
  const read = readShardFiles(directory);
  if (!read.ok) throw new Error(read.problem);
  return [...read.files].sort(([a], [b]) => compareCodeUnits(a, b)).map(([name, text]) => `${name}\n${text}`).join("\n----\n");
}
