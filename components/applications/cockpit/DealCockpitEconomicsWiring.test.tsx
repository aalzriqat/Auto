/**
 * The CONTAINER's economics wiring — the half no view-level test can see.
 *
 * `FinanceCompanyDecision.test.tsx` renders `DealCockpitView` against a
 * hand-built `financeDecision` fixture, so it proves what the card does with an
 * answer and nothing about how that answer is assembled. An adversarial review
 * found a defect living exactly there: the calculator query was mounted only
 * while no quotation existed, so RE-recording one forced `MANUAL_ENTRY`
 * whatever the operator typed — mislabelling the provenance of an external
 * document and writing a spurious "source changed" row into the audit table.
 *
 * These tests exercise `DealCockpit` itself, with the Convex hooks mocked per
 * query, and assert on the arguments the container passes — including whether a
 * query is mounted at all.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Id } from "../../../convex/_generated/dataModel";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

vi.mock("@/hooks/useCurrency", () => ({
  useCurrency: () => ({
    code: "JOD",
    symbol: "JD",
    displayLabel: "Jordanian Dinar",
    format: (n: number) => `JD ${n}`,
    scale: 3,
  }),
}));

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  /** Every `useQuery` call this render made: name → the args it was given. */
  queryArgs: new Map<string, unknown>(),
  permissions: new Set<string>(),
  membershipUserId: "user_sales",
}));

vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({
    hasPermission: (permission: string) => stubs.permissions.has(permission),
    isLoading: false,
    membership: { userId: stubs.membershipUserId },
  }),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (reference: never, args: unknown) => {
      const name = getFunctionName(reference);
      stubs.queryArgs.set(name, args);
      return stubs.queryResults.get(name);
    },
    useMutation: () => vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { DealCockpit } from "./DealCockpit";
import { PERMISSIONS } from "@/convex/utils/permissions";

const { queryResults, queryArgs, permissions } = stubs;

const ORG = "org1" as Id<"organizations">;
const APP = "app_2048" as Id<"financeApplications">;
const JOD = 1_000;

const SUGGESTION_QUERY = "financingEconomics:suggestQuotationForApplication";
const ECONOMICS_QUERY = "financingEconomics:getEconomics";
const COCKPIT_QUERY = "applications:dealCockpit";

/** `applications.dealCockpit`'s payload, trimmed to what the container reads. */
function cockpit(approvedPurchaseComplete: boolean) {
  return {
    dealKind: "FINANCED",
    dealRef: APP,
    applicationId: APP,
    saleId: null,
    canonicalSaleId: null,
    status: "APPROVED",
    createdAt: Date.UTC(2026, 6, 28),
    updatedAt: Date.UTC(2026, 7, 9),
    customer: null,
    vehicle: null,
    salespersonName: "",
    financeCompanyName: "",
    settlementAdviceRequiresReconciliation: false,
    settlementAdviceDiscrepancy: null,
    stages: [
      {
        key: "APPROVED_PURCHASE",
        state: approvedPurchaseComplete ? "COMPLETE" : "BLOCKED",
        ...(approvedPurchaseComplete ? {} : { blocker: "NoApprovedPurchaseAmount" }),
      },
    ],
    documents: [],
    timeline: [],
    money: null,
  };
}

/** `financingEconomics.getEconomics`'s payload, likewise trimmed. */
function economics(application: Record<string, unknown>) {
  return {
    application: {
      _id: APP,
      status: "APPROVED",
      salespersonId: "user_sales",
      economicsCurrency: "JOD",
      companyRuleSnapshot: { defaultLtvPercent: 90 },
      ...application,
    },
    appraisals: [],
    overrides: [],
  };
}

afterEach(() => {
  cleanup();
  queryResults.clear();
  queryArgs.clear();
  permissions.clear();
  stubs.membershipUserId = "user_sales";
});

function renderCockpit() {
  return render(<DealCockpit orgId={ORG} applicationId={APP} />);
}

describe("the quotation calculator", () => {
  test("is still consulted when an already-recorded quotation is re-recorded", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    queryResults.set(COCKPIT_QUERY, cockpit(false));
    queryResults.set(
      ECONOMICS_QUERY,
      economics({ submittedQuotationMinor: 12_500 * JOD, appliedLtvPercent: 90 })
    );
    queryResults.set(SUGGESTION_QUERY, {
      available: true,
      submittedQuotationMinor: 12_500 * JOD,
    });

    renderCockpit();

    // Skipping it here forced MANUAL_ENTRY on every re-record — a false claim
    // about where the figure came from, and a spurious source-changed row in
    // the override table.
    expect(queryArgs.get(SUGGESTION_QUERY)).toEqual({ orgId: ORG, applicationId: APP });
  });

  test("is not consulted once the approval is on the record", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    // COMPLETE on the rail — the server's answer from the unredacted row.
    queryResults.set(COCKPIT_QUERY, cockpit(true));
    queryResults.set(
      ECONOMICS_QUERY,
      // Redacted for this caller, exactly as `view:finance`-less roles see it.
      economics({ submittedQuotationMinor: 12_500 * JOD, appliedLtvPercent: 90 })
    );

    renderCockpit();

    // The server refuses to move a quotation an approval was based on, so there
    // is nothing to suggest and no reason to pay for the query. Reading the
    // AMOUNT instead of the rail would have mounted it here, because redaction
    // leaves that field blank on a deal that is already approved.
    expect(queryArgs.get(SUGGESTION_QUERY)).toBe("skip");
  });

  test("is not consulted for a caller who cannot record a quotation", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    queryResults.set(COCKPIT_QUERY, cockpit(false));
    queryResults.set(ECONOMICS_QUERY, economics({}));

    renderCockpit();

    expect(queryArgs.get(SUGGESTION_QUERY)).toBe("skip");
  });
});

describe("the economics read", () => {
  test("is skipped entirely without view:finance_applications", () => {
    queryResults.set(COCKPIT_QUERY, cockpit(false));

    renderCockpit();

    // `getEconomics` THROWS for an application it will not serve, and an
    // uncaught throw from `useQuery` during render loses the whole screen — so
    // a custom role holding only `view:sales` must never reach it.
    expect(queryArgs.get(ECONOMICS_QUERY)).toBe("skip");
    expect(screen.queryByText("FinanceDecisionHeading")).toBeNull();
  });
});

describe("the facts the card is given", () => {
  test("name the missing purchase LTV, and who may set it, when the deal's own snapshot has none", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    queryResults.set(COCKPIT_QUERY, cockpit(false));
    queryResults.set(
      ECONOMICS_QUERY,
      economics({ companyRuleSnapshot: { ruleVersion: 1 }, appliedLtvPercent: undefined })
    );

    renderCockpit();

    // A salesperson holds CREATE but not APPROVE, and the server refuses the
    // rate from them. Telling them to "record the rate with the quotation"
    // would be an instruction they cannot carry out, so they are told who can.
    expect(screen.getByText("DealPurchaseLtvNeedsApprover")).toBeTruthy();
    expect(screen.queryByText("FinanceCompanyLtvMissing")).toBeNull();
  });

  test("tell an approver to record the rate rather than to go and find one", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    queryResults.set(COCKPIT_QUERY, cockpit(false));
    queryResults.set(
      ECONOMICS_QUERY,
      economics({ companyRuleSnapshot: { ruleVersion: 1 }, appliedLtvPercent: undefined })
    );

    renderCockpit();

    expect(screen.getByText("FinanceCompanyLtvMissing")).toBeTruthy();
    expect(screen.queryByText("DealPurchaseLtvNeedsApprover")).toBeNull();
  });

  test("do not claim a missing LTV for a legacy deal with no snapshot at all", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    queryResults.set(COCKPIT_QUERY, cockpit(false));
    queryResults.set(
      ECONOMICS_QUERY,
      economics({ companyRuleSnapshot: undefined, appliedLtvPercent: undefined })
    );

    renderCockpit();

    // The server falls back to the live company row for those, so "no snapshot"
    // must not block an action that would have worked.
    expect(screen.queryByText("FinanceCompanyLtvMissing")).toBeNull();
  });

  test("mark the viewer as the deal's own salesperson from the membership, not the name", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    stubs.membershipUserId = "user_sales";
    queryResults.set(COCKPIT_QUERY, cockpit(false));
    queryResults.set(
      ECONOMICS_QUERY,
      economics({ submittedQuotationMinor: 12_500 * JOD, salespersonId: "user_sales" })
    );

    renderCockpit();

    expect(screen.getByText("ApprovedPurchaseNotOwnDeal")).toBeTruthy();
  });

  test("and let a different approver record it", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    stubs.membershipUserId = "user_manager";
    queryResults.set(COCKPIT_QUERY, cockpit(false));
    queryResults.set(
      ECONOMICS_QUERY,
      economics({ submittedQuotationMinor: 12_500 * JOD, salespersonId: "user_sales" })
    );

    renderCockpit();

    expect(screen.queryByText("ApprovedPurchaseNotOwnDeal")).toBeNull();
    expect(screen.getByRole("button", { name: "RecordApprovedPurchaseAction" })).toBeTruthy();
  });
});
