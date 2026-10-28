#!/usr/bin/env node
/**
 * Fails when a baseline entry no longer names a live client call. An EMPTY baseline is refused (exit 3):
 * "0 entries matched" is vacuously true and also what a truncated or wrongly pointed file looks like, so a
 * silent pass could hide it. Retiring all debt is a reviewed decision and is stated on the command line
 * with `--allow-empty`; that flag never excuses a non-empty baseline that has drifted.
 */
import { parseArgs } from "node:util";
import { DEFAULT_BASELINE, EXIT_IDENTITY_DRIFT, EXIT_UNAVAILABLE, readIdentityBaseline, inspectBaselineIdentities, describeStranded } from "./baselineIdentity.mjs";
import { resolveInside } from "./baselineFile.mjs";
import { isRunDirectly } from "./runDirectly.mjs";

/**
 * @typedef {{ log: (line: string) => void, error: (line: string) => void }} CliIo
 * @param {string[]} argv
 * @param {CliIo} [io]  output sinks; the repository root is the working directory (the TypeScript programs resolve against it)
 * @returns {number} the process exit code
 */
export function main(argv, io = { log: console.log, error: console.error }) {
  try {
    const { values } = parseArgs({ args: argv, options: { baseline: { type: "string", default: DEFAULT_BASELINE }, "allow-empty": { type: "boolean" } } });
    const baseline = resolveInside(process.cwd(), values.baseline, "baseline");
    const entries = readIdentityBaseline(baseline);
    if (entries.length === 0 && !values["allow-empty"]) {
      throw new Error(`${values.baseline} has no baseline entries; an empty baseline is not a pass (pass --allow-empty only when retiring all reviewed debt)`);
    }
    const stranded = inspectBaselineIdentities(entries);
    for (const finding of stranded) io.error(`STRANDED: ${describeStranded(finding)}`);
    if (stranded.length) {
      io.error("Call identity drift. Preview repairs with node scripts/contractSkew/relocateBaseline.mjs --base <base-sha>; review changed calls manually.");
      return EXIT_IDENTITY_DRIFT;
    }
    if (entries.length === 0) {
      io.log("Call identity check: empty baseline allowed by --allow-empty; nothing to match.");
    } else {
      io.log(`Call identity check: ${entries.length} baseline entries matched (surface, file, callSiteId, functionId). Backend finding identity was not checked.`);
    }
    return 0;
  } catch (error) {
    io.error(`Call identity check UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_UNAVAILABLE;
  }
}

if (isRunDirectly(import.meta.url)) process.exitCode = main(process.argv.slice(2));
