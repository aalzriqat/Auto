#!/usr/bin/env node
// A trusted workflow validates its own real-backend result before publishing
// a release verdict. The candidate checkout never runs this file.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { REQUIRED_REHEARSAL_CASE_IDS } from "./accountingRehearsalCases.mjs";

const fullSha = /^[0-9a-f]{40}$/;

export function validateAccountingReleaseEvidence(evidence, expected) {
  const errors = [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return ["Cloud rehearsal evidence is missing or malformed."];
  }
  if (!fullSha.test(expected.testedSha ?? "") || evidence.testedSha !== expected.testedSha) {
    errors.push("Evidence does not name the exact tested SHA.");
  }
  if (evidence.deploymentType !== "preview" ||
      evidence.previewName !== expected.previewName ||
      evidence.convexUrl !== expected.previewUrl ||
      !/^https:\/\/[^/]+\.convex\.cloud$/.test(evidence.convexUrl ?? "")) {
    errors.push("Evidence does not match the created disposable preview.");
  }
  if (evidence.targetVerification !== "assertE2EBootstrap agreed: preview marker present, cloud URL matches" ||
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
    });
    if (errors.length > 0) throw new Error(errors.join(" "));
    console.log(`Verified ${evidence.cases.length} executed cloud scenarios at the exact release SHA.`);
  } catch (error) {
    console.error(`Trusted accounting release evidence refused: ${error.message}`);
    process.exitCode = 1;
  }
}
