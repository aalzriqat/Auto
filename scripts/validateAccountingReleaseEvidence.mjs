#!/usr/bin/env node
// A trusted workflow validates its own real-backend result before publishing
// a release verdict. The candidate checkout never runs this file.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { REQUIRED_REHEARSAL_CASE_IDS } from "./accountingRehearsalCases.mjs";
import { SWARM_LOCAL_CONVEX_ORIGIN } from "./intelligence/swarmConvexOrigin.mjs";

const fullSha = /^[0-9a-f]{40}$/;
// The runner-local backend's only URL, from the dependency-free leaf module.
// localConvexBackend.mjs has top-level await and this file must stay loadable
// through require(); a test pins it equal to that module's LOCAL_CONVEX_URL.
export const LOCAL_BACKEND_URL = SWARM_LOCAL_CONVEX_ORIGIN;

// SCRUM-892 (owner ruling c24441): the pull-request and the release rehearsal
// both certify on the runner-local backend, and no other event may. Anything
// but an explicit "local" is the cloud check.
function deploymentIdentityErrors(evidence, expected, local) {
  const errors = [];
  if (local && expected.eventName !== "workflow_run" && expected.eventName !== "repository_dispatch") {
    errors.push("Local backend evidence is accepted only from the trusted rehearsal's pull-request or release event.");
  }
  if (expected.deploymentType !== undefined && expected.deploymentType !== "preview" && !local) {
    errors.push("Unknown expected deployment type.");
  }
  if (local) {
    if (evidence.deploymentType !== "local" ||
        evidence.previewName !== null ||
        evidence.convexUrl !== expected.previewUrl ||
        evidence.convexUrl !== LOCAL_BACKEND_URL) {
      errors.push("Evidence does not match this job's local backend.");
    }
  } else if (evidence.deploymentType !== "preview" ||
      evidence.previewName !== expected.previewName ||
      evidence.convexUrl !== expected.previewUrl ||
      !/^https:\/\/[^/]+\.convex\.cloud$/.test(evidence.convexUrl ?? "")) {
    errors.push("Evidence does not match the created disposable preview.");
  }
  return errors;
}

export function validateAccountingReleaseEvidence(evidence, expected) {
  const errors = [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return ["Cloud rehearsal evidence is missing or malformed."];
  }
  if (!fullSha.test(expected.testedSha ?? "") || evidence.testedSha !== expected.testedSha) {
    errors.push("Evidence does not name the exact tested SHA.");
  }
  const local = expected.deploymentType === "local";
  errors.push(...deploymentIdentityErrors(evidence, expected, local));
  const attestation = local
    ? "assertE2EBootstrap agreed: preview marker present, local backend URL matches"
    : "assertE2EBootstrap agreed: preview marker present, cloud URL matches";
  if (evidence.targetVerification !== attestation ||
      String(evidence.workflowRunId ?? "") !== expected.runId ||
      String(evidence.workflowRunAttempt ?? "") !== expected.runAttempt) {
    errors.push("Trusted preview identity or workflow run attestation is absent.");
  }
  const cases = evidence.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    errors.push("No cloud scenarios executed.");
    return errors;
  }
  const ids = new Set();
  for (const item of cases) {
    if (!item || typeof item.id !== "string" || !/^[A-Z][A-Z0-9-]{0,31}$/.test(item.id) || ids.has(item.id)) {
      errors.push("Cloud scenario ID is missing, malformed or duplicated.");
      break;
    }
    ids.add(item.id);
    if (item.status !== "PASS") {
      errors.push("At least one required cloud scenario failed or did not execute.");
      break;
    }
  }
  const required = expected.caseIds ?? REQUIRED_REHEARSAL_CASE_IDS;
  if (ids.size !== required.length || required.some((id) => !ids.has(id))) {
    errors.push("The required cloud scenario set is incomplete or contains an unexpected case.");
  }
  const summary = evidence.summary;
  if (!summary || summary.total !== cases.length || summary.passed !== cases.length ||
      summary.failed !== 0 || summary.unproven !== 0 || summary.complete !== true ||
      !Array.isArray(summary.failedIds) || summary.failedIds.length !== 0 ||
      !Array.isArray(summary.unprovenIds) || summary.unprovenIds.length !== 0) {
    errors.push("Cloud scenario summary is incomplete or contradicts the case records.");
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file] = process.argv.slice(2);
  try {
    const evidence = JSON.parse(readFileSync(file, "utf8"));
    const errors = validateAccountingReleaseEvidence(evidence, {
      testedSha: process.env.EXPECTED_TESTED_SHA,
      previewName: process.env.EXPECTED_PREVIEW_NAME,
      previewUrl: process.env.EXPECTED_PREVIEW_URL,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      deploymentType: process.env.EXPECTED_DEPLOYMENT_TYPE,
      eventName: process.env.GITHUB_EVENT_NAME,
    });
    if (errors.length > 0) throw new Error(errors.join(" "));
    console.log(process.env.EXPECTED_DEPLOYMENT_TYPE === "local"
      ? `Verified ${evidence.cases.length} executed local-backend scenarios at the exact tested SHA.`
      : `Verified ${evidence.cases.length} executed cloud scenarios at the exact release SHA.`);
  } catch (error) {
    console.error(`Trusted accounting release evidence refused: ${error.message}`);
    process.exitCode = 1;
  }
}
