import { SCREEN_AUDIT_ROUTES } from "../../playwright/fixtures/screenAuditRoutes.ts";
import { ROLE_AUDIT_ROLES, ROLE_CASE_PROJECTS, isTrustedRoleReplayBinding } from "../intelligence/trustedBrowserReplayPolicy.mjs";

const CELL_KEYS = new Set(SCREEN_AUDIT_ROUTES.flatMap(route => ["en", "ar"].flatMap(locale =>
  ["desktop", "phone"].map(viewport => `${route}:${locale}:${viewport}`))));

function completeCells(summary) {
  if (summary.cellsComplete !== true || summary.isolationVerified !== true ||
      summary.isolationScope !== "ORGANIZATION_AND_CUSTOMER_RELATIONS_ONLY" ||
      summary.expectedCells !== CELL_KEYS.size || summary.observedCells !== CELL_KEYS.size ||
      !Array.isArray(summary.cells) || summary.cells.length !== CELL_KEYS.size) return false;
  const seen = new Set();
  for (const cell of summary.cells) {
    const key = `${cell?.route}:${cell?.locale}:${cell?.viewport}`;
    if (!CELL_KEYS.has(key) || seen.has(key) || cell.destinationMatched !== true ||
        !["ALLOWED_ROUTE", "DENIED_ROUTE"].includes(cell.access)) return false;
    seen.add(key);
  }
  return true;
}

function passedAllCases(summary) {
  if (summary.roleRegressionsVerified !== true || summary.roleRegressionsMeasurement !== "PASS" ||
      summary.roleRegressionsExpected !== ROLE_CASE_PROJECTS.size || summary.roleRegressionsObserved !== ROLE_CASE_PROJECTS.size ||
      summary.roleRegressionsUnlistedCount !== 0 || !Array.isArray(summary.roleRegressionCases) ||
      summary.roleRegressionCases.length !== ROLE_CASE_PROJECTS.size) return false;
  const seen = new Set();
  for (const entry of summary.roleRegressionCases) {
    if (!entry || !ROLE_CASE_PROJECTS.has(entry.title) || ROLE_CASE_PROJECTS.get(entry.title) !== entry.project ||
        entry.status !== "passed" || seen.has(entry.title)) return false;
    seen.add(entry.title);
  }
  return true;
}

function exactRoleSummary(summary, expected, repository) {
  if (summary?.schemaVersion !== 1 || !ROLE_AUDIT_ROLES.includes(summary.role) ||
      summary.sha !== expected.testedSha || summary.execution !== "SUCCEEDED" || summary.complete !== true) return false;
  const context = summary.runContext;
  return context?.workflowRef === `${repository}/.github/workflows/browser-attack-swarm.yml@refs/heads/main` &&
    context.runId === String(expected.runId) && context.attempt === String(expected.attempt) &&
    context.prNumber === String(expected.prNumber) && context.baseSha === expected.baseSha &&
    context.headSha === expected.headSha && context.testedSha === expected.testedSha &&
    context.controllerSha === expected.controllerSha && completeCells(summary) && passedAllCases(summary);
}

/** The caller verifies each archive and its successful protected job before supplying summaries. */
export function bindTrustedRoleReplays({ summaries, expected, repository, selected, trusted }) {
  const roles = new Set();
  if (!Array.isArray(summaries) || summaries.length !== ROLE_AUDIT_ROLES.length) return [];
  for (const summary of summaries) {
    if (!exactRoleSummary(summary, expected, repository) || roles.has(summary.role)) return [];
    roles.add(summary.role);
  }
  return selected.filter(record => isTrustedRoleReplayBinding(record) &&
    record.status === "active" && record.domain === "screen" && record.level === "browser" &&
    typeof record.fingerprint === "string" && /^[a-f0-9]{64}$/.test(record.fingerprint) &&
    selected.filter(other => other.id === record.id).length === 1 &&
    trusted.filter(other => other.id === record.id).length === 1 && trusted.some(other =>
      other.id === record.id && other.status === "active" && other.domain === "screen" && other.level === "browser" &&
      other.fingerprint === record.fingerprint && other.impl?.file === record.impl.file && other.impl?.testName === record.impl.testName))
    .map(({ id }) => ({ id, code: "PASS", evidence: "role-audit" }));
}
