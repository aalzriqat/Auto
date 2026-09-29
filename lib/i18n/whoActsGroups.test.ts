/**
 * SCRUM-417 UX PR 2 (S5) -- "who acts" names the permission group.
 *
 * Every note that tells a caller someone ELSE must act says which group that
 * is: Sales, Manager or Accountant. The group is not opinion: it is the set of
 * default role templates that actually hold the permission(s) the gate checks,
 * read from `DEFAULT_ROLE_TEMPLATES`, so a note cannot point a caller at a role
 * that could not do the thing (which would just be a new dead end). Owner
 * ruling: only managers and accountants move money.
 *
 * The permission column mirrors the client gate that selects each note in
 * `DealCockpit.tsx`; each entry is an ANY-OF list of ALL-OF sets.
 */
import { describe, expect, test } from "vitest";
import { salesAr, salesEn } from "./domains/sales";
import { DEFAULT_ROLE_TEMPLATES, PERMISSIONS, type Permission } from "@/convex/utils/permissions";

type Group = "Sales" | "Manager" | "Accountant";

const P = PERMISSIONS;

/** The default role template -> the group an operator would call it. */
const GROUP_OF_ROLE: Record<string, Group | undefined> = {
  SALES: "Sales",
  MANAGER: "Manager",
  ACCOUNTANT: "Accountant",
  SENIOR_ACCOUNTANT: "Accountant",
};

const holdersOf = (anyOf: Permission[][]): Group[] => {
  const groups = new Set<Group>();
  for (const role of DEFAULT_ROLE_TEMPLATES) {
    const group = GROUP_OF_ROLE[role.name];
    if (!group) continue;
    if (anyOf.some((allOf) => allOf.every((p) => role.permissions.includes(p)))) groups.add(group);
  }
  return [...groups];
};

const CLOSE_OR_CONFIRM: Permission[][] = [[P.CONFIRM_FINANCE_DISBURSEMENT]];
const DECIDE: Permission[][] = [[P.APPROVE_FINANCE_APPLICATION]];

const NOTES: Record<string, Permission[][]> = {
  DisbursementNeedsPermission: CLOSE_OR_CONFIRM,
  FinalizeNeedsPermission: CLOSE_OR_CONFIRM,
  ReconciliationNeedsPermission: CLOSE_OR_CONFIRM,
  HandoverNeedsPermission: [[P.REGISTER_VEHICLE_HANDOVER]],
  ExpectedPaymentNeedsPermission: [[P.REGISTER_EXPECTED_PAYMENT]],
  CreditDecisionNeedsPermission: [[P.REVIEW_FINANCE_APPLICATION], [P.APPROVE_FINANCE_APPLICATION]],
  CreditDecisionApproveNeedsPermission: DECIDE,
  CreditDecisionRejectNeedsPermission: [[P.REVIEW_FINANCE_APPLICATION]],
  CreditDecisionOwnDeal: DECIDE,
  HandoverBlockedNeedsApproval: DECIDE,
  GapResolutionNeedsPermission: DECIDE,
  DepositManagerNeedsApprover: [[P.APPROVE_REQUESTS, P.VIEW_VEHICLES]],
  SupplierPayablesNeedFinanceRole: [[P.MANAGE_FINANCE, P.VIEW_FINANCE]],
  SupplierSettlementNeedsPermission: [[P.MANAGE_FINANCE]],
  DocumentsNeedUploader: [[P.CREATE_FINANCE_APPLICATION], [P.VERIFY_FINANCE_DOCUMENTS]],
  DocumentsAwaitVerifier: [[P.VERIFY_FINANCE_DOCUMENTS]],
  CashSaleCompletionNeedsPermission: [[P.CREATE_SALES, P.EDIT_SALES]],
  SalesPageNeedsAccess: [[P.CREATE_SALES, P.EDIT_SALES, P.VIEW_SALES]],
};

const EN_WORD: Record<Group, RegExp> = {
  Sales: /\bSales\b/,
  Manager: /\bManagers?\b/,
  Accountant: /\bAccountants?\b/,
};
const AR_WORD: Record<Group, RegExp> = {
  Sales: /المبيعات/,
  Manager: /مدير/,
  Accountant: /محاسب/,
};
/** "the Sales page" is a place, not a group. */
const withoutPlaces = (text: string) => text.replace(/Sales page/g, "").replace(/صفحة المبيعات/g, "");

const GROUPS: Group[] = ["Sales", "Manager", "Accountant"];
const en = salesEn as Record<string, string>;
const ar = salesAr as Record<string, string>;

describe("S5 -- every who-acts note names the group that can act, from the real role defaults", () => {
  test.each(Object.entries(NOTES))("%s", (key, anyOf) => {
    const holders = holdersOf(anyOf);
    expect(holders.length, `${key}: no default role holds these permissions`).toBeGreaterThan(0);

    for (const [locale, text, words] of [
      ["EN", withoutPlaces(en[key] ?? ""), EN_WORD],
      ["AR", withoutPlaces(ar[key] ?? ""), AR_WORD],
    ] as const) {
      expect(text, `${key} (${locale}) is missing`).not.toBe("");
      for (const group of GROUPS) {
        const named = words[group].test(text);
        expect(
          named,
          holders.includes(group)
            ? `${key} (${locale}) must name ${group}, a default role that can act`
            : `${key} (${locale}) names ${group}, which by default cannot act (a dead end)`
        ).toBe(holders.includes(group));
      }
    }
  });

  test("owner ruling: only managers and accountants move money", () => {
    for (const key of [
      "DisbursementNeedsPermission",
      "FinalizeNeedsPermission",
      "SupplierPayablesNeedFinanceRole",
      "SupplierSettlementNeedsPermission",
    ]) {
      expect(EN_WORD.Sales.test(en[key] ?? ""), `${key} sends money work to Sales`).toBe(false);
    }
  });

  test("the copy fixes from the PR1 review: Arabic agreement, and the awkward English", () => {
    // حصة (share) is feminine: "مستحقة عليه", not "مستحق عليه".
    expect(ar.SupplierPayableRecordedOnPayables).toContain("مستحقة عليه");
    expect(ar.SupplierPayableRecordedOnPayables).not.toContain("فحصة المورد مستحق عليه");
    expect(en.SupplierPayablesNeedFinanceRole).not.toContain("Only a user who manages finance");
  });
});
