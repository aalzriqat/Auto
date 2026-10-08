import { strict as assert } from "node:assert";
import { test } from "node:test";
import { diagnosePreviewAttestation, summarizeAttestationLogs } from "./previewAttestationDiagnostic.mjs";

test("reports only the attestation error class and public source location", () => {
  const raw = [
    JSON.stringify({ kind: "Completion", identifier: "other:query", requestId: "deadbeef", error: "TypeError: secret" }),
    JSON.stringify({
      kind: "Completion", identifier: "e2eBootstrap:assertE2EBootstrap", requestId: "42e39a239aecaeb1",
      error: "TypeError: private-customer@example.test secret-value\n at convex/e2eBootstrap.ts:1111:22",
    }),
  ].join("\n");
  assert.deepEqual(summarizeAttestationLogs(raw), [
    "request=42e39a239aecaeb1 class=TypeError category=unclassified location=convex/e2eBootstrap.ts:1111:22",
  ]);
});

test("refuses a non-preview key before invoking the log command", () => {
  let invoked = false;
  const result = diagnosePreviewAttestation(
    { CONVEX_PREVIEW_NAME: "e2e-main-deal-scenarios-43153c7937", CONVEX_DEPLOY_KEY: "prod:unsafe" },
    () => { invoked = true; throw new Error("should not run"); },
  );
  assert.equal(invoked, false);
  assert.match(result, /targeting was not verified/);
});

test("a failed log command reports unavailable without printing its raw error", () => {
  const result = diagnosePreviewAttestation(
    { CONVEX_PREVIEW_NAME: "e2e-main-deal-scenarios-43153c7937", CONVEX_DEPLOY_KEY: "preview:test:key|synthetic" },
    () => ({ status: 1, stdout: "", stderr: "private-customer@example.test secret-value" }),
  );
  assert.match(result, /diagnostic unavailable/);
  assert.doesNotMatch(result, /private-customer|secret-value/);
});
