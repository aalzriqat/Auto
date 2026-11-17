// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SCREEN_AUDIT_ROUTES } from "../../playwright/fixtures/screenAuditRoutes";
import { ROLE_AUDIT_ROLES, ROLE_CASE_PROJECTS } from "../intelligence/trustedBrowserReplayPolicy.mjs";
import { bindTrustedRoleReplays } from "./trustedRoleAuditReceipt.mjs";

const title = "protected role routes render actual authority across audited pages";
const expected = {
  runId: 123, attempt: 2, prNumber: 825, baseSha: "a".repeat(40), headSha: "b".repeat(40),
  testedSha: "c".repeat(40), controllerSha: "d".repeat(40),
};
const record = {
  id: "role-routes-mount-after-authority", status: "active", domain: "screen", level: "browser", fingerprint: "e".repeat(64),
  impl: { file: "playwright/tests/audit-role-access.spec.ts", testName: title },
};
const repository = "aalzriqat/Auto";

function fixtures() {
  return ROLE_AUDIT_ROLES.map(role => ({
    schemaVersion: 1, sha: expected.testedSha, role, execution: "SUCCEEDED", complete: true,
    isolationVerified: true, isolationScope: "ORGANIZATION_AND_CUSTOMER_RELATIONS_ONLY",
    cellsComplete: true, expectedCells: 140, observedCells: 140,
    cells: SCREEN_AUDIT_ROUTES.flatMap(route => ["en", "ar"].flatMap(locale =>
      ["desktop", "phone"].map(viewport => ({ route, locale, viewport, destinationMatched: true, access: "ALLOWED_ROUTE" })))),
    roleRegressionsExpected: 7, roleRegressionsObserved: 7, roleRegressionsVerified: true,
    roleRegressionsMeasurement: "PASS", roleRegressionsUnlistedCount: 0,
    roleRegressionCases: [...ROLE_CASE_PROJECTS].map(([title, project]) => ({ title, project, status: "passed" })),
    runContext: { runId: "123", attempt: "2", prNumber: "825", baseSha: expected.baseSha, headSha: expected.headSha,
      testedSha: expected.testedSha, controllerSha: expected.controllerSha,
      workflowRef: `${repository}/.github/workflows/browser-attack-swarm.yml@refs/heads/main` },
  }));
}

const bind = (summaries: ReturnType<typeof fixtures>, selected = [record]) =>
  bindTrustedRoleReplays({ summaries, expected, repository, selected, trusted: [record] });

describe("candidate role census", () => {
  it("joins the exact binding after all six roles pass every case and cell", () => {
    expect(bind(fixtures())).toEqual([{ id: record.id, code: "PASS", evidence: "role-audit" }]);
    expect(bind(fixtures(), [{ ...record, fingerprint: "f".repeat(64) }])).toEqual([]);
  });

  const mismatches: [string, (roles: ReturnType<typeof fixtures>) => void][] = [
    ["a missing role", roles => { roles.pop(); }],
    ["a duplicate role", roles => { roles[1] = roles[0]; }],
    ["main-only evidence", roles => { roles[0].runContext.workflowRef = `${repository}/.github/workflows/pilot-role-audit.yml@refs/heads/main`; }],
    ["stale producer attempt", roles => { roles[0].runContext.attempt = "1"; }],
    ["different tested backend", roles => { roles[0].sha = "d".repeat(40); }],
    ["an absent isolation proof", roles => { roles[0].isolationVerified = false; }],
    ["two copies of one cell", roles => { roles[0].cells[1] = roles[0].cells[0]; }],
    ["a missing case", roles => { roles[0].roleRegressionCases.pop(); }],
    ["a case that did not pass on first attempt", roles => { roles[0].roleRegressionCases[0].status = "flaky"; }],
  ];
  it.each(mismatches)("refuses %s", (_label, edit) => {
    const summaries = fixtures();
    edit(summaries);
    expect(bind(summaries)).toEqual([]);
  });
});
