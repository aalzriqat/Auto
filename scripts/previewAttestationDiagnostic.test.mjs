import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { diagnosePreviewAttestation, failedAttestationRequestIds, summarizeAttestationLogs } from "./previewAttestationDiagnostic.mjs";

test("reports only the attestation error class and public source location", () => {
  const raw = [
    JSON.stringify({ kind: "Completion", identifier: "other:query", requestId: "deadbeef", error: "TypeError: secret" }),
    JSON.stringify({
      kind: "Completion", identifier: "e2eBootstrap:assertE2EBootstrap", requestId: "42e39a239aecaeb1",
      error: "TypeError: private-customer@example.test secret-value\n at convex/e2eBootstrap.ts:1111:22",
    }),
  ].join("\n");
  assert.deepEqual(summarizeAttestationLogs(raw, ["42e39a239aecaeb1"]), [
    "request=42e39a239aecaeb1 class=TypeError category=unclassified location=convex/e2eBootstrap.ts:1111:22",
  ]);
  assert.deepEqual(summarizeAttestationLogs(raw, ["deadbeef"]), []);
  assert.deepEqual(failedAttestationRequestIds("Preview attestation failed: ConvexError: [Request ID: 42e39a239aecaeb1] Server Error"), ["42e39a239aecaeb1"]);
  assert.deepEqual(failedAttestationRequestIds("Preview attestation failed: ConvexError [Request ID: 42e39a239aecaeb1] Server Error"), ["42e39a239aecaeb1"]);
});

test("rejects tenant-shaped source text in a backend error", () => {
  const raw = JSON.stringify({
    kind: "Completion", identifier: "e2eBootstrap:assertE2EBootstrap", requestId: "42e39a239aecaeb1",
    error: "Error: convex/tenant42.ts:1:1 private-customer@example.test",
  });
  assert.deepEqual(summarizeAttestationLogs(raw, ["42e39a239aecaeb1"]), [
    "request=42e39a239aecaeb1 class=Error category=unclassified location=unavailable",
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
  const dir = mkdtempSync(join(tmpdir(), "attestation-test-"));
  try {
    writeFileSync(join(dir, "deal-scenarios-output.log"), "Preview attestation failed: ConvexError: [Request ID: 42e39a239aecaeb1] Server Error");
    const env = {
      CONVEX_PREVIEW_NAME: "e2e-main-deal-scenarios-43153c7937",
      CONVEX_DEPLOY_KEY: "preview:test:key|synthetic",
      CONVEX_PREVIEW_URL: "https://tame-mouse-328.convex.cloud",
      CONVEX_PREVIEW_CREATED_AT: "1234567",
      RUNNER_TEMP: dir,
    };
    const result = diagnosePreviewAttestation(env, (_command, args) => {
      assert.deepEqual(args.slice(1, 4), ["logs", "--preview-name", env.CONVEX_PREVIEW_NAME]);
      return { status: 1, stdout: "", stderr: "private-customer@example.test secret-value" };
    });
    assert.match(result, /diagnostic unavailable/);
    assert.doesNotMatch(result, /private-customer|secret-value/);
    const timedOut = diagnosePreviewAttestation(env, () => ({ status: null, stdout: "", error: { code: "ETIMEDOUT" } }));
    assert.match(timedOut, /no matching completion/);
  } finally {
    if (resolve(dir).startsWith(resolve(tmpdir()) + sep)) rmSync(dir, { recursive: true, force: true });
  }
});
