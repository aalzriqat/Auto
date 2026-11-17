// @vitest-environment node
import { expect, it } from "vitest";
import { buildBrowserReplayManifest, readBrowserReplayManifest } from "./trustedBrowserManifest.mjs";

const candidate = {
  repositoryId: 1, prNumber: 825, workflowRunId: 2, workflowAttempt: 1,
  baseSha: "a".repeat(40), headSha: "b".repeat(40), testedSha: "c".repeat(40),
};
const supplier = {
  id: "supplier-p7-browser-ar", status: "active", domain: "screen", level: "browser",
  fingerprint: "1".repeat(64), impl: { file: "playwright/tests/supplier-identity.spec.ts", testName: "supplier in Arabic" },
};

it("handoff binds a current candidate to the exact trusted definition, without accepting role records", () => {
  const role = { ...supplier, id: "role-routes-mount-after-authority", impl: { file: "playwright/tests/audit-role-access.spec.ts",
    testName: "protected role routes render actual authority across audited pages" } };
  const records = [supplier, role];
  const manifest = buildBrowserReplayManifest(candidate, records, records.map(({ id }) => ({ id, code: "PASS" })));
  const handoff = JSON.stringify(manifest);
  expect(readBrowserReplayManifest(handoff, candidate, records)).toEqual([{ id: supplier.id, code: "PASS" }]);
  const roleManifest = buildBrowserReplayManifest(candidate, records, [{ id: role.id, code: "PASS", evidence: "role-audit" }]);
  expect(readBrowserReplayManifest(JSON.stringify(roleManifest), candidate, records)).toEqual([
    { id: role.id, code: "PASS", evidence: "role-audit" },
  ]);
  expect(readBrowserReplayManifest(handoff, { ...candidate, testedSha: "d".repeat(40) }, records)).toEqual([]);
  expect(readBrowserReplayManifest(handoff, { ...candidate, workflowAttempt: 2 }, records)).toEqual([]);
  expect(readBrowserReplayManifest(handoff, candidate, [{ ...supplier, impl: { ...supplier.impl, testName: "replacement" } }])).toEqual([]);
  expect(readBrowserReplayManifest(JSON.stringify({ ...manifest, records: [...manifest.records, manifest.records[0]] }), candidate, records)).toEqual([]);
});
