export const EXPLORER_SPEC = "playwright/scenarios/jev-explorer.spec.ts";
export const SOURCED_SPEC = "playwright/scenarios/pilot-sourced.spec.ts";
export const SOURCED_SCENARIO_IDS = Object.freeze([
  "g8-sourced-cash-delivery-screen",
  "g8-sourced-financed-delivery-screen",
  "g8-sourced-direct-financed-delivery-screen",
]);
export const OPENING_PROOF_SPEC = "playwright/opening-proof/opening-onboarding.spec.ts";
export const OPENING_PROOF_CASES = Object.freeze([
  { proofId: "opening-owner-native", scenarioId: "opening-owner-ui-native-post",
    title: "owner opening form posts exact native allocations once" },
  { proofId: "opening-review-native", scenarioId: "opening-preparer-ui-native-review",
    title: "finance opening form drafts for a different reviewer and posts once" },
]);
export const ROLE_AUDIT_SPEC = "playwright/tests/audit-role-access.spec.ts";
// The longest protected chain is 270 minutes with no runner queue delays.
export const HOSTED_REPLAY_WAIT_MINUTES = 280;
export const ROLE_AUDIT_ROLES = Object.freeze(["OWNER", "MANAGER", "SALES", "RECEPTION", "ACCOUNTANT", "SENIOR_ACCOUNTANT"]);
export const ROLE_CASE_PROJECTS = new Map([
  ["protected role routes render actual authority across audited pages", "role-regressions"],
  ["lead screen and create dialog respect actual audited role authority", "role-regressions"],
  ["approval screen renders authorized queue or explicit role refusal", "role-regressions"],
  ["sales quote picker respects audited role and tenant choice authority", "role-regressions"],
  ["pilot Accounting traversal paints every section and nested reader", "pilot-g8-role-hunt"],
  ["pilot Sales opens CASH and configured FINANCED entry panels for each audited role", "pilot-g8-role-hunt"],
  ["pilot Deals opens owned and SOURCED cash and configured financed detail screens", "pilot-g8-role-hunt"],
]);

export function isTrustedRoleReplayBinding(record) {
  return record?.impl?.file === ROLE_AUDIT_SPEC && ROLE_CASE_PROJECTS.has(record.impl.testName);
}

export function isProtectedReplayBinding(record) {
  return isTrustedReplayBinding(record) || isTrustedRoleReplayBinding(record) || isTrustedOpeningReplayBinding(record);
}

export function isTrustedOpeningReplayBinding(record) {
  return record?.impl?.file === OPENING_PROOF_SPEC && OPENING_PROOF_CASES.some(
    ({ scenarioId, title }) => scenarioId === record.id && title === record.impl.testName,
  );
}

// Only these fields of a trusted authenticated suite receipt are replay claims.
export const TRUSTED_REPLAY_BINDINGS = Object.freeze({
  browserReplay: { id: "g8-owned-cash-delivery-screen", definition: "sales.spec.ts" },
  financedReplay: { id: "g8-owned-financed-delivery-screen", definition: "financed-deal-economics.spec.ts" },
  supplierArabicReplay: { id: "supplier-p7-browser-ar", definition: "supplier-identity.spec.ts" },
  supplierEnglishReplay: { id: "supplier-p7-browser-en", definition: "supplier-identity.spec.ts" },
  uncheckedFinanceFeeEnglishDesktop: { id: "unchecked-finance-fee-is-reconciled-from-its-row-en-1280", definition: "deal-cost-reconcile-route.spec.ts" },
  uncheckedFinanceFeeArabicDesktop: { id: "unchecked-finance-fee-is-reconciled-from-its-row-ar-1280", definition: "deal-cost-reconcile-route.spec.ts" },
  uncheckedFinanceFeeEnglishMobile: { id: "unchecked-finance-fee-is-reconciled-from-its-row-en-390", definition: "deal-cost-reconcile-route.spec.ts" },
  uncheckedFinanceFeeArabicMobile: { id: "unchecked-finance-fee-is-reconciled-from-its-row-ar-390", definition: "deal-cost-reconcile-route.spec.ts" },
  disputedAppraisalFeeArabicMobile: { id: "disputed-appraisal-fee-corrected-then-removed-from-its-row-ar-390", definition: "deal-cost-reconcile-route.spec.ts" },
  boundExecutionFeeEnglishDesktop: { id: "bound-execution-fee-is-reconciled-from-its-section-en-1280", definition: "deal-cost-reconcile-route.spec.ts" },
  boundExecutionFeeArabicMobile: { id: "bound-execution-fee-is-reconciled-from-its-section-ar-390", definition: "deal-cost-reconcile-route.spec.ts" },
});

export function isTrustedReplayBinding(record) {
  const file = record?.impl?.file;
  return file === EXPLORER_SPEC || (file === SOURCED_SPEC && SOURCED_SCENARIO_IDS.includes(record.id)) ||
    Object.values(TRUSTED_REPLAY_BINDINGS).some(binding =>
    binding.id === record?.id && file === `playwright/tests/${binding.definition}`);
}
