#!/usr/bin/env node
/**
 * Decides which Convex backend this production run addresses and publishes it
 * as the step output `target` (`cloud` or `self-hosted`), or refuses.
 *
 * The one input is the non-secret environment variable CONVEX_PROD_TARGET:
 * unset/empty or `cloud` keeps today's Convex Cloud path, `self-hosted` selects
 * the self-hosted one, and ANY other value stops the run before anything is
 * deployed. The cloud steps are conditioned on `target != 'self-hosted'`, so a
 * missing output can only ever fall to the path that has its own mixed-config
 * refusal (`assertReleaseCredentials.mjs`), never to a deploy with no check.
 *
 * Reads no secret. Prints the target and nothing else.
 */
import { appendFileSync } from "node:fs";
import process from "node:process";
import { parseReleaseTarget } from "./releaseTarget.ts";

const decision = parseReleaseTarget(process.env.CONVEX_PROD_TARGET);
const output = process.env.GITHUB_OUTPUT;

// `process.exitCode`, not `process.exit()`: an immediate exit can race Node's
// own pending warning on Windows and abort with a native assertion.
if (!decision.ok) {
  console.error(`\n✖ ${decision.reason}\n`);
  process.exitCode = 1;
} else if (!output) {
  console.error("\n✖ GITHUB_OUTPUT is not available, so the selected target cannot be published to later steps.\n");
  process.exitCode = 1;
} else {
  appendFileSync(output, `target=${decision.target}\n`);
  console.log(`✔ Production deploy target: ${decision.target}`);
}
