import assert from "node:assert/strict";
import { test } from "node:test";
import { probePreviewAttestation } from "./previewAttestationProbe.mjs";

const ID = "0123456789abcdef";
const env = { RUNNER_TEMP: "/synthetic-runner-temp" };
const invoke = async (_env, { run }) => run(
  ["exec", "convex", "run", "e2eBootstrap:assertE2EBootstrap", "{}", "--preview-name", "e2e-synthetic"],
  "e2eBootstrap:assertE2EBootstrap",
);

test("expected live refusal reports only the request-correlated redacted category", async () => {
  let written = "";
  const message = await probePreviewAttestation(env, {
    assertPreview: invoke,
    spawn: () => ({ status: 1, stdout: `[Request ID: ${ID}] Server Error`, stderr: "sensitive raw backend detail" }),
    write: (_path, contents) => { written = contents; },
    diagnose: () => `Attestation backend failures: request=${ID} class=ConvexError category=qa-approver-permissions location=convex/e2eBootstrap.ts:1:1`,
  });
  assert.match(message, /category=qa-approver-permissions/);
  assert.match(written, new RegExp(ID));
  assert.doesNotMatch(message + written, /sensitive raw backend detail/);
});

test("a successful attestation fails the controlled probe", async () => {
  await assert.rejects(probePreviewAttestation(env, {
    assertPreview: invoke,
    spawn: () => ({ status: 0, stdout: "ok" }),
  }), /unexpectedly accepted/);
});

test("a refusal without a backend request ID fails closed", async () => {
  await assert.rejects(probePreviewAttestation(env, {
    assertPreview: invoke,
    spawn: () => ({ status: 1, stderr: "sensitive raw backend detail" }),
  }), /no backend request ID/);
});

test("a backend reason other than the expected fixed category fails closed", async () => {
  await assert.rejects(probePreviewAttestation(env, {
    assertPreview: invoke,
    spawn: () => ({ status: 1, stderr: `[Request ID: ${ID}] Server Error` }),
    write: () => {},
    diagnose: () => `Attestation backend failures: request=${ID} class=ConvexError category=unclassified location=unavailable`,
  }), /matching redacted backend reason was unavailable/);
});

test("missing invocation cannot count as an expected refusal", async () => {
  await assert.rejects(probePreviewAttestation(env, {
    assertPreview: async () => { throw new Error("Clerk failed before assertion"); },
  }), /attestation was not invoked/);
});
