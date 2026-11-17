export const EXPLORER_SPEC = "playwright/scenarios/jev-explorer.spec.ts";
export const ROLE_AUDIT_SPEC = "playwright/tests/audit-role-access.spec.ts";
// The longest protected chain is 230 minutes with no runner queue delays.
export const HOSTED_REPLAY_WAIT_MINUTES = 240;
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
  return isTrustedReplayBinding(record) || isTrustedRoleReplayBinding(record);
}

// Only these fields of a trusted authenticated suite receipt are replay claims.
export const TRUSTED_REPLAY_BINDINGS = Object.freeze({
  browserReplay: { id: "g8-owned-cash-delivery-screen", definition: "sales.spec.ts" },
  financedReplay: { id: "g8-owned-financed-delivery-screen", definition: "financed-deal-economics.spec.ts" },
  supplierArabicReplay: { id: "supplier-p7-browser-ar", definition: "supplier-identity.spec.ts" },
  supplierEnglishReplay: { id: "supplier-p7-browser-en", definition: "supplier-identity.spec.ts" },
});

export function isTrustedReplayBinding(record) {
  const file = record?.impl?.file;
  return file === EXPLORER_SPEC || Object.values(TRUSTED_REPLAY_BINDINGS).some(binding =>
    binding.id === record?.id && file === `playwright/tests/${binding.definition}`);
}
