import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "vitest";
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

test("correlates a request ID when Convex prefixes the attestation error line", () => {
  assert.deepEqual(
    failedAttestationRequestIds("Preview attestation failed: [CONVEX M(e2eBootstrap:assertE2EBootstrap)] [Request ID: 42e39a239aecaeb1] Server Error"),
    ["42e39a239aecaeb1"],
  );
  assert.deepEqual(
    failedAttestationRequestIds("Preview attestation failed: Error\n[Request ID: 42e39a239aecaeb1] Server Error"),
    [],
  );
});

test("classifies a matching resource-limit completion without leaking its raw error", () => {
  const raw = JSON.stringify({
    kind: "Completion", identifier: "e2eBootstrap:assertE2EBootstrap", requestId: "42e39a239aecaeb1",
    error: "ConvexError: too many bytes for private-customer@example.test",
  });
  assert.deepEqual(summarizeAttestationLogs(raw, ["42e39a239aecaeb1"]), [
    "request=42e39a239aecaeb1 class=ConvexError category=resource-limit location=unavailable",
  ]);
});

test("names the QA approver permission mismatch without exposing the role or grants", () => {
  const raw = JSON.stringify({
    kind: "Completion", identifier: "e2eBootstrap:assertE2EBootstrap", requestId: "42e39a239aecaeb1",
    error: 'ConvexError: E2E_BOOTSTRAP: E2E_APPROVER_USER holds role "private-customer@example.test", which is missing view:finance, manage:finance. The approval E2E path cannot be driven without it.',
  });
  const summary = summarizeAttestationLogs(raw, ["42e39a239aecaeb1"]);
  assert.deepEqual(summary, [
    "request=42e39a239aecaeb1 class=ConvexError category=qa-approver-permissions location=unavailable",
  ]);
  assert.doesNotMatch(summary.join(" "), /private-customer|view:finance|manage:finance/);
});

test("refuses a non-preview key before invoking the log command", () => {
  let invoked = false;
  const result = diagnosePreviewAttestation(
    { NODE_ENV: "test", CONVEX_PREVIEW_NAME: "e2e-main-deal-scenarios-43153c7937", CONVEX_DEPLOY_KEY: "prod:unsafe" },
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
      NODE_ENV: "test" as const,
      CONVEX_PREVIEW_NAME: "e2e-main-deal-scenarios-43153c7937",
      CONVEX_DEPLOY_KEY: "preview:test:key|synthetic",
      CONVEX_PREVIEW_URL: "https://tame-mouse-328.convex.cloud",
      CONVEX_PREVIEW_CREATED_AT: "1234567",
      RUNNER_TEMP: dir,
    };
    const result = diagnosePreviewAttestation(env, (_command, args) => {
      if (!Array.isArray(args)) throw new Error("Expected CLI arguments.");
      assert.deepEqual(args.slice(1, 4), ["logs", "--preview-name", env.CONVEX_PREVIEW_NAME]);
      return { status: 1, stdout: "", stderr: "private-customer@example.test secret-value" };
    });
    assert.match(result, /diagnostic unavailable/);
    assert.doesNotMatch(result, /private-customer|secret-value/);
    const failedWithOutput = diagnosePreviewAttestation(env, () => ({
      status: 1,
      stdout: JSON.stringify({
        kind: "Completion", identifier: "e2eBootstrap:assertE2EBootstrap", requestId: "42e39a239aecaeb1",
        error: 'ConvexError: E2E_BOOTSTRAP: E2E_APPROVER_USER holds role "MANAGER", which is missing manage:finance. The approval E2E path cannot be driven without it.',
      }),
      stderr: "failed to finish reading logs",
    }));
    assert.match(failedWithOutput, /diagnostic unavailable/);
    assert.doesNotMatch(failedWithOutput, /qa-approver-permissions/);
    const timedOut = diagnosePreviewAttestation(env, () => ({ status: null, stdout: "", error: { code: "ETIMEDOUT" } }));
    assert.match(timedOut, /diagnostic unavailable/);
  } finally {
    if (resolve(dir).startsWith(resolve(tmpdir()) + sep)) rmSync(dir, { recursive: true, force: true });
  }
});

test("a matching completion from the verified preview is reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "attestation-test-"));
  try {
    writeFileSync(join(dir, "deal-scenarios-output.log"), "Preview attestation failed: ConvexError [Request ID: 42e39a239aecaeb1] Server Error");
    const env = {
      NODE_ENV: "test" as const,
      CONVEX_PREVIEW_NAME: "e2e-main-deal-scenarios-43153c7937",
      CONVEX_DEPLOY_KEY: "preview:test:key|synthetic",
      CONVEX_PREVIEW_URL: "https://tame-mouse-328.convex.cloud",
      CONVEX_PREVIEW_CREATED_AT: "1234567",
      RUNNER_TEMP: dir,
    };
    const result = diagnosePreviewAttestation(env, () => ({
      status: 0,
      stdout: JSON.stringify({
        kind: "Completion", identifier: "e2eBootstrap:assertE2EBootstrap", requestId: "42e39a239aecaeb1",
        error: "TypeError: private-customer@example.test fetch failed",
      }),
    }));
    assert.match(result, /request=42e39a239aecaeb1 class=TypeError category=network location=unavailable/);
    assert.doesNotMatch(result, /private-customer/);
  } finally {
    if (resolve(dir).startsWith(resolve(tmpdir()) + sep)) rmSync(dir, { recursive: true, force: true });
  }
});

test("missing scenario output cannot claim the backend was healthy", () => {
  const dir = mkdtempSync(join(tmpdir(), "attestation-test-"));
  try {
    const result = diagnosePreviewAttestation({
      NODE_ENV: "test",
      CONVEX_PREVIEW_NAME: "e2e-main-deal-scenarios-43153c7937",
      CONVEX_DEPLOY_KEY: "preview:test:key|synthetic",
      CONVEX_PREVIEW_URL: "https://tame-mouse-328.convex.cloud",
      CONVEX_PREVIEW_CREATED_AT: "1234567",
      RUNNER_TEMP: dir,
    }, () => { throw new Error("should not run"); });
    assert.match(result, /scenario output was not captured/);
  } finally {
    if (resolve(dir).startsWith(resolve(tmpdir()) + sep)) rmSync(dir, { recursive: true, force: true });
  }
});
