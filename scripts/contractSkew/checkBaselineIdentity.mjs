#!/usr/bin/env node
import { parseArgs } from "node:util";
import { DEFAULT_BASELINE, EXIT_IDENTITY_DRIFT, EXIT_UNAVAILABLE, readIdentityBaseline, inspectBaselineIdentities, describeStranded } from "./baselineIdentity.mjs";

try {
  const { values } = parseArgs({ options: { baseline: { type: "string", default: DEFAULT_BASELINE } } });
  const entries = readIdentityBaseline(values.baseline);
  const stranded = inspectBaselineIdentities(entries);
  for (const finding of stranded) console.error(`STRANDED: ${describeStranded(finding)}`);
  if (stranded.length) {
    console.error("Call identity drift. Preview repairs with node scripts/contractSkew/relocateBaseline.mjs --base <base-sha>; review changed calls manually.");
    process.exitCode = EXIT_IDENTITY_DRIFT;
  } else {
    console.log(`Call identity check: ${entries.length} baseline entries matched (surface, file, callSiteId, functionId). Backend finding identity was not checked.`);
  }
} catch (error) {
  console.error(`Call identity check UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = EXIT_UNAVAILABLE;
}
