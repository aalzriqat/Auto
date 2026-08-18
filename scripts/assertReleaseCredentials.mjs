#!/usr/bin/env node
/**
 * Refuses, before anything is deployed, unless both production credentials
 * address the one deployment this repository expects.
 *
 * ⚠️ "Is it a production key" is not the question. A valid production key for
 * the WRONG project deploys, verifies and reports success there exactly as
 * confidently as it would for the right one — and the 2026-08-07 incident was a
 * targeting error, not an authorisation one. So the deployment is named in a
 * non-secret variable and both keys are required to address it.
 *
 * Neither key is ever printed. Only classifications and deployment names reach
 * the log, which matters because this repository is public.
 */
import process from "node:process";
import { requireBoundProductionKeys } from "./releaseGuard.ts";

const result = requireBoundProductionKeys({
  deployKey: process.env.CONVEX_PROD_DEPLOY_KEY,
  operatorKey: process.env.CONVEX_PROD_OPERATOR_KEY,
  expectedDeployment: process.env.CONVEX_PROD_DEPLOYMENT,
});

if (!result.ok) {
  console.error(`\n✖ ${result.reason}\n`);
  process.exit(1);
}

console.log(`✔ Both credentials address the expected production deployment: ${result.deployment}`);
