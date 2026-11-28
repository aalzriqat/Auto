#!/usr/bin/env node
/**
 * Runs INSIDE the self-hosted `convex deploy` step, before the CLI, and refuses
 * unless the step's own environment can only address the self-hosted backend.
 *
 * Why the step must check itself: the Convex CLI (1.42.1) reads a deploy key
 * (`CONVEX_DEPLOY_KEY`, else `CONVEX_DEPLOYMENT_TOKEN`) FIRST and returns
 * before it looks at `CONVEX_SELF_HOSTED_URL` / `CONVEX_SELF_HOSTED_ADMIN_KEY`;
 * it refuses only `CONVEX_DEPLOYMENT` set together with that pair. A cloud key
 * reaching this step would therefore deploy to Convex Cloud with no message.
 * The workflow's structure test and hash pin keep such a key out of the step's
 * `env:`; this is the runtime refusal for everything else (job or workflow
 * level `env:`, a runner variable), using the same `assertSelfHostedCliEnv`
 * that the credential gate, the zero-state check and the rollout run.
 *
 * It also checks the one URL spelling the CLI will receive. The CLI is handed
 * the RAW variable, so it must be canonical (see `parseSelfHostedUrl`).
 *
 * Reads no secret and prints no value: only the variable NAME or the rule.
 */
import process from "node:process";
import { assertSelfHostedCliEnv, parseSelfHostedUrl } from "./releaseTarget.ts";

function fail(reason) {
  console.error(`\n✖ ${reason}\n`);
  process.exitCode = 1;
}

const cli = assertSelfHostedCliEnv(process.env);
if (!cli.ok) {
  fail(cli.reason);
} else {
  const url = parseSelfHostedUrl(process.env.CONVEX_SELF_HOSTED_URL);
  if (!url.ok) fail(url.reason);
  else console.log(`✔ Self-hosted deploy step: no cloud-pointing variable, and the CLI will be pointed at ${url.host}.`);
}
