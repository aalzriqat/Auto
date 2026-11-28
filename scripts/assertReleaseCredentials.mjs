#!/usr/bin/env node
/**
 * Refuses, before anything is deployed, unless the production credentials
 * address the one backend this repository expects. Two targets, chosen by the
 * non-secret CONVEX_PROD_TARGET (see releaseTarget.ts):
 *
 * CLOUD (unset or `cloud`) — unchanged: both Convex Cloud keys must address the
 * deployment named in CONVEX_PROD_DEPLOYMENT, and none of the self-hosted
 * configuration may be present (mixed configuration refuses).
 *
 * SELF-HOSTED — the admin key must be `<instance name>|<token>` with the
 * instance name equal to CONVEX_PROD_DEPLOYMENT, the URL must be a bare https
 * DNS origin that is not a Convex Cloud host, no cloud-pointing variable may
 * be present, and the backend at that URL must report the same instance name
 * when asked without credentials (no redirects followed).
 *
 * ⚠️ "Is it a production key" is not the question. A valid production key for
 * the WRONG project deploys, verifies and reports success there exactly as
 * confidently as it would for the right one — and the 2026-08-07 incident was a
 * targeting error, not an authorisation one. So the target is named in a
 * non-secret variable and every credential is required to address it.
 *
 * Nothing secret is ever printed. Only classifications, the URL host and the
 * instance name reach the log, which matters because this repository is public.
 */
import process from "node:process";
import { requireBoundProductionKeys } from "./releaseGuard.ts";
import { assertCloudTargetEnv, parseReleaseTarget, verifySelfHostedRelease } from "./releaseTarget.ts";

function fail(reason) {
  console.error(`\n✖ ${reason}\n`);
  process.exit(1);
}

const target = parseReleaseTarget(process.env.CONVEX_PROD_TARGET);
if (!target.ok) fail(target.reason);

if (target.target === "self-hosted") {
  const release = await verifySelfHostedRelease(process.env);
  if (!release.ok) fail(release.reason);
  console.log(
    `✔ Self-hosted target: the admin key and the backend at ${release.host} both address instance ${release.instance}. ` +
      `The instance name is self-declared by the backend: a targeting check, not authentication.`
  );
} else {
  const mixed = assertCloudTargetEnv(process.env);
  if (!mixed.ok) fail(mixed.reason);

  const result = requireBoundProductionKeys({
    deployKey: process.env.CONVEX_PROD_DEPLOY_KEY,
    operatorKey: process.env.CONVEX_PROD_OPERATOR_KEY,
    expectedDeployment: process.env.CONVEX_PROD_DEPLOYMENT,
  });
  if (!result.ok) fail(result.reason);

  console.log(`✔ Both credentials address the expected production deployment: ${result.deployment}`);
}
