#!/usr/bin/env node
/**
 * Fails when a baseline entry no longer names a live client call. An EMPTY baseline is refused (exit 3):
 * "0 entries matched" is vacuously true and also what a truncated or wrongly pointed file looks like, so a
 * silent pass could hide it. Retiring all debt is a reviewed decision and is stated on the command line
 * with `--allow-empty`; that flag never excuses a non-empty baseline that has drifted.
 */
import { parseArgs } from "node:util";
import { DEFAULT_BASELINE, EXIT_IDENTITY_DRIFT, EXIT_UNAVAILABLE, readIdentityBaseline, inspectBaselineIdentities, describeStranded } from "./baselineIdentity.mjs";

try {
  const { values } = parseArgs({ options: { baseline: { type: "string", default: DEFAULT_BASELINE }, "allow-empty": { type: "boolean" } } });
  const entries = readIdentityBaseline(values.baseline);
  if (entries.length === 0 && !values["allow-empty"]) {
    throw new Error(`${values.baseline} has no baseline entries; an empty baseline is not a pass (pass --allow-empty only when retiring all reviewed debt)`);
  }
  const stranded = inspectBaselineIdentities(entries);
  for (const finding of stranded) console.error(`STRANDED: ${describeStranded(finding)}`);
  if (stranded.length) {
    console.error("Call identity drift. Preview repairs with node scripts/contractSkew/relocateBaseline.mjs --base <base-sha>; review changed calls manually.");
    process.exitCode = EXIT_IDENTITY_DRIFT;
  } else if (entries.length === 0) {
    console.log("Call identity check: empty baseline allowed by --allow-empty; nothing to match.");
  } else {
    console.log(`Call identity check: ${entries.length} baseline entries matched (surface, file, callSiteId, functionId). Backend finding identity was not checked.`);
  }
} catch (error) {
  console.error(`Call identity check UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = EXIT_UNAVAILABLE;
}
