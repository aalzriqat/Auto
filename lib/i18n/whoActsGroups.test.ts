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

type Group = "Sales" | "Manager" | "Accountant" | "Owner";

const P = PERMISSIONS;

/** The default role template -> the group an operator would call it. */
const GROUP_OF_ROLE: Record<string, Group | undefined> = {
  SALES: "Sales",
  MANAGER: "Manager",
  ACCOUNTANT: "Accountant",
  SENIOR_ACCOUNTANT: "Accountant",
};

/**
 * The default roles that hold the permissions. The dealership OWNER passes every
 * `requireTenantAuth` (`isSystemOwnerRole` bypass, convex/utils/tenancy.ts:214),
 * so the owner is named only when NO other default role can act: that is what
 * "owner only" means, and it is how a note stops sending a caller to a role that
 * would just be refused.
 */
const holdersOf = (anyOf: Permission[][]): Group[] => {
  const groups = new Set<Group>();
  for (const role of DEFAULT_ROLE_TEMPLATES) {
    const group = GROUP_OF_ROLE[role.name];
    if (!group) continue;
    if (anyOf.some((allOf) => allOf.every((p) => role.permissions.includes(p)))) groups.add(group);
  }
  return groups.size === 0 ? ["Owner"] : [...groups];
};

const CONFIRM: Permission[][] = [[P.CONFIRM_FINANCE_DISBURSEMENT]];
const APPROVE: Permission[][] = [[P.APPROVE_FINANCE_APPLICATION]];

/**
 * note key -> the SERVER check of the mutation that note stands in front of
 * (NOT the client selector in DealCockpit.tsx: a note that follows the client
 * gate can point at a role the server then refuses, which is a new dead end).
 * Each entry is an ANY-OF list of ALL-OF sets, with the file:line it mirrors.
 */
const NOTES: Record<string, { server: string; anyOf: Permission[][] }> = {
  DisbursementNeedsPermission: { server: "convex/applications.ts:4372 confirmDisbursement", anyOf: CONFIRM },
  FinalizeNeedsPermission: { server: "convex/applications.ts:3914 finalizeDeal", anyOf: CONFIRM },
  ReconciliationNeedsPermission: {
    server: "convex/financingEconomics.ts:3200 resolveFinancingReconciliation",
    anyOf: CONFIRM,
  },
  HandoverNeedsPermission: {
    server: "convex/applications.ts:3444 registerVehicleHandover",
    anyOf: [[P.REGISTER_VEHICLE_HANDOVER]],
  },
  ExpectedPaymentNeedsPermission: {
    server: "convex/applications.ts:3531 registerExpectedPayment",
    anyOf: [[P.REGISTER_EXPECTED_PAYMENT]],
  },
  CreditDecisionNeedsPermission: {
    server: "convex/applications.ts:2833 (REVIEW: UNDER_REVIEW/REJECTED) or :2895 (APPROVE) updateStatus",
    anyOf: [[P.REVIEW_FINANCE_APPLICATION], [P.APPROVE_FINANCE_APPLICATION]],
  },
  CreditDecisionApproveNeedsPermission: { server: "convex/applications.ts:2895 updateStatus APPROVED", anyOf: APPROVE },
  CreditDecisionRejectNeedsPermission: {
    server: "convex/applications.ts:2833 updateStatus REJECTED",
    anyOf: [[P.REVIEW_FINANCE_APPLICATION]],
  },
  CreditDecisionOwnDeal: {
    server: "convex/applications.ts:2895-2897 updateStatus APPROVED, refuses the salesperson",
    anyOf: APPROVE,
  },
  HandoverBlockedNeedsApproval: { server: "convex/applications.ts:2895 updateStatus APPROVED", anyOf: APPROVE },
  // ALL-OF, not any-of: a default MANAGER lacks VIEW_FINANCE, so only the owner can act.
  GapResolutionNeedsPermission: {
    server: "convex/financingEconomics.ts:2938-2941 resolveAppraisalGap (APPROVE_FINANCE_APPLICATION and VIEW_FINANCE)",
    anyOf: [[P.APPROVE_FINANCE_APPLICATION, P.VIEW_FINANCE]],
  },
  GapResolutionSelfDeal: {
    server: "convex/financingEconomics.ts:2938-2941 resolveAppraisalGap (same guard, plus separation of duties)",
    anyOf: [[P.APPROVE_FINANCE_APPLICATION, P.VIEW_FINANCE]],
  },
  DepositManagerNeedsApprover: {
    server: "convex/deposits.ts:185 release, :261 voidDeposit",
    anyOf: [[P.APPROVE_REQUESTS]],
  },
  SupplierPayablesNeedFinanceRole: {
    server: "convex/sourcingPayables.ts:224 markPaid",
    anyOf: [[P.MANAGE_FINANCE]],
  },
  SupplierSettlementNeedsPermission: {
    server: "convex/supplierReceivables.ts:282 recordReceipt",
    anyOf: [[P.MANAGE_FINANCE]],
  },
  DocumentsNeedUploader: {
    server: "convex/documents.ts:312/370/408 upload (CREATE_FINANCE_APPLICATION or VERIFY_FINANCE_DOCUMENTS)",
    anyOf: [[P.CREATE_FINANCE_APPLICATION], [P.VERIFY_FINANCE_DOCUMENTS]],
  },
  DocumentsAwaitVerifier: {
    server: "convex/documents.ts:473 updateDocumentStatus",
    anyOf: [[P.VERIFY_FINANCE_DOCUMENTS]],
  },
  CashSaleCompletionNeedsPermission: { server: "convex/sales.ts:576 completeDraft", anyOf: [[P.CREATE_SALES]] },
  SalesPageNeedsAccess: { server: "convex/sales.ts:576 completeDraft", anyOf: [[P.CREATE_SALES]] },
};

const EN_WORD: Record<Group, RegExp> = {
  Sales: /\bSales\b/i,
  Manager: /\bManagers?\b/i,
  Accountant: /\bAccountants?\b/i,
  Owner: /\bowner\b/i,
};
const AR_WORD: Record<Group, RegExp> = {
  Sales: /المبيعات/,
  Manager: /مدير/,
  Accountant: /محاسب/,
  Owner: /مالك/,
};
/** "the Sales page" is a place, not a group. */
const withoutPlaces = (text: string) => text.replace(/Sales page/gi, "").replace(/صفحة المبيعات/g, "");

const GROUPS: Group[] = ["Sales", "Manager", "Accountant", "Owner"];
const en = salesEn as Record<string, string>;
const ar = salesAr as Record<string, string>;
describe("S5 -- every who-acts note names the group that can act, from the real role defaults", () => {
  test.each(Object.entries(NOTES))("%s", (key, { anyOf }) => {
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

describe("UX2-F1 -- the server guard, not the client selector, decides who a note names", () => {
  test("gap resolution is owner-only under the default roles (MANAGER lacks VIEW_FINANCE, ACCOUNTANT lacks APPROVE)", () => {
    expect(holdersOf(NOTES.GapResolutionNeedsPermission.anyOf)).toEqual(["Owner"]);
    expect(holdersOf(NOTES.GapResolutionSelfDeal.anyOf)).toEqual(["Owner"]);
  });

  test("the gap notes name the dealership owner, not a manager", () => {
    expect(en.GapResolutionNeedsPermission).toBe("The dealership owner records who covers the difference.");
    expect(ar.GapResolutionNeedsPermission).toBe("يسجّل مالك المعرض الجهة التي تتحمّل الفرق.");
    for (const text of [en.GapResolutionSelfDeal, ar.GapResolutionSelfDeal]) {
      expect(text).not.toMatch(/manager|مدير/i);
    }
    expect(en.GapResolutionSelfDeal).toContain("dealership owner");
    expect(ar.GapResolutionSelfDeal).toContain("مالك المعرض");
  });
});

describe("UX2-L1 -- Arabic puts the subject right after the verb", () => {
  const EXPECTED_AR: Record<string, string> = {
    SupplierPayablesNeedFinanceRole: "يتولى المحاسب دفع مستحقات الموردين.",
    SupplierSettlementNeedsPermission: "يسجّل المحاسب تسوية المورد.",
    CreditDecisionApproveNeedsPermission: "يسجّل المدير موافقة شركة التمويل.",
    CreditDecisionRejectNeedsPermission: "يسجّل المدير رفض شركة التمويل.",
    CreditDecisionNeedsPermission: "يسجّل المدير قرار شركة التمويل.",
    DisbursementNeedsPermission: "يؤكد المدير أو المحاسب صرف شركة التمويل.",
    FinalizeNeedsPermission: "يغلق المدير أو المحاسب الصفقة.",
    DepositManagerNeedsApprover: "يعالج المدير العربون. اطلب منه معالجته.",
    SalesPageNeedsAccess: "يُتمّ المدير هذا البيع من صفحة المبيعات.",
    DocumentsNeedUploader: "يرفع موظف المبيعات أو المدير مستندات التمويل.",
    DocumentsAwaitVerifier: "تم الرفع. يتحقق المدير من مستندات التمويل.",
    ReconciliationNeedsPermission: "يراجع المدير أو المحاسب ملاحظة التسوية على هذه الصفقة.",
    HandoverNeedsPermission: "يسجّل موظف المبيعات أو المدير تسليم المركبة.",
    ExpectedPaymentNeedsPermission: "يسجّل موظف المبيعات أو المدير الدفعة المتوقعة.",
  };
  test.each(Object.entries(EXPECTED_AR))("%s", (key, expected) => {
    expect(ar[key]).toBe(expected);
  });
});

describe("UX2-F2b -- a Settlement node waiting on the finance company says so", () => {
  test("the note exists in both languages", () => {
    expect(en.BlockerSettlementAfterFinancePayment).toBe("Completes after the finance company pays");
    expect(ar.BlockerSettlementAfterFinancePayment).toBe("تكتمل بعد صرف شركة التمويل");
  });
});
