/**
 * The Review dialog's actions, taken from the Deal screen — on the SAME
 * mutations, under the SAME permission gates.
 *
 * SCRUM-215: the Finance Applications → Review dialog is transitional and is
 * removed once every action it owns is reachable inside the Deal. These are
 * CONTAINER tests: they prove that the cockpit calls `applications.updateStatus`,
 * `applications.cancelApplication`, `applications.setSupplierSettlementRoute`,
 * `applications.confirmDisbursement`, `applications.confirmSupplierDisbursement`,
 * `deposits.release` and `documents.updateDocumentStatus` — the exact function
 * names the dialog wires — with the args the server expects, and that each
 * action is withheld (with a stated reason) from a caller the server would
 * refuse. No `unifiedDeal.*` second path exists; the structural test in
 * `scripts/` proves that at the file level, this proves it at the call level.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  permissions: new Set<string>(),
  mutationCalls: new Map<string, unknown[]>(),
  mutationFailures: new Map<string, string>(),
  membershipUserId: "user_manager",
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
    useQuery: (reference: never, args: unknown) =>
      args === "skip" ? undefined : stubs.queryResults.get(getFunctionName(reference)),
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      return async (args: unknown) => {
        const calls = stubs.mutationCalls.get(name) ?? [];
        calls.push(args);
        stubs.mutationCalls.set(name, calls);
        const failure = stubs.mutationFailures.get(name);
        if (failure !== undefined) {
          stubs.mutationFailures.delete(name);
          throw new Error(failure);
        }
        return null;
      };
    },
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

const { queryResults, permissions, mutationCalls } = stubs;

const ORG = "org1" as Id<"organizations">;
const APP = "app_2048" as Id<"financeApplications">;

const COCKPIT_QUERY = "dealWorkspace:financedDealCockpit";
const GET_QUERY = "applications:get";
const DOCUMENTS_QUERY = "documents:getForApplication";

/** The cockpit payload, minimal. */
function cockpit(overrides: Record<string, unknown> = {}) {
  return {
    dealKind: "FINANCED",
    dealRef: APP,
    applicationId: APP,
    saleId: null,
    canonicalSaleId: null,
    status: "UNDER_REVIEW",
    createdAt: Date.UTC(2026, 6, 28),
    updatedAt: Date.UTC(2026, 7, 9),
    customer: { id: "c1", name: "سامر الخطيب", phone: "0790112233" },
    vehicle: {
      id: "v1",
      label: "Volkswagen e-Golf 2020",
      vin: "WVWZZZAUZLW901234",
      consigned: false,
      supplierName: "",
    },
    salespersonName: "ليث العمري",
    financeCompanyName: "شركة التمويل الوطني",
    settlementAdviceRequiresReconciliation: false,
    settlementAdviceDiscrepancy: null,
    expectedPaymentRegistered: false,
    supplierSettlementRouteRequired: false,
    stages: [
      { key: "APPLICATION", state: "COMPLETE", authority: "DEALER" },
      { key: "CREDIT_DECISION", state: "BLOCKED", blocker: "AwaitingCreditDecision", authority: "MIRROR" },
      { key: "APPRAISAL", state: "PENDING", authority: "MIRROR" },
    ],
    documents: [],
    timeline: [],
    money: null,
    activeAppraisalProvider: null,
    pendingDepositResolution: false,
    ...overrides,
  };
}

/** `applications.get`'s payload, the facts the moved actions read. */
function application(overrides: Record<string, unknown> = {}) {
  return {
    _id: APP,
    status: "UNDER_REVIEW",
    salespersonId: "user_sales",
    companyId: "company_1",
    economicsCurrency: "JOD",
    quote: { totalFinancedAmount: 15000, downPayment: 500, vehiclePrice: 17000 },
    vehicle: { sourceType: "OWNED", sourcedFromName: undefined },
    deposits: [],
    hasExternalFinancier: true,
    canSettleDirectToSupplier: false,
    directRouteRefusal: null,
    supplierSettlementRoute: undefined,
    disbursedAt: undefined,
    supplierDisbursementStatus: undefined,
    approvedDealerPurchaseAmountMinor: 16_500_000,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  queryResults.clear();
  permissions.clear();
  mutationCalls.clear();
  stubs.membershipUserId = "user_manager";
});

function renderCockpit() {
  return render(<DealCockpit orgId={ORG} applicationId={APP} />);
}

const focusRow = () => screen.getByTestId("deal-next-step");

describe("credit decision — applications.updateStatus, from the CREDIT_DECISION stage", () => {
  test("PENDING_DOCS: 'mark under review' is the one recommended action and calls updateStatus(UNDER_REVIEW)", async () => {
    permissions.add(PERMISSIONS.REVIEW_FINANCE_APPLICATION);
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "PENDING_DOCS" }));
    queryResults.set(GET_QUERY, application({ status: "PENDING_DOCS" }));
    renderCockpit();

    fireEvent.click(within(focusRow()).getByRole("button", { name: "MarkUnderReview" }));

    await waitFor(() => expect(mutationCalls.get("applications:updateStatus")).toHaveLength(1));
    expect(mutationCalls.get("applications:updateStatus")![0]).toEqual({
      orgId: ORG,
      applicationId: APP,
      status: "UNDER_REVIEW",
    });
  });

  test("UNDER_REVIEW: recording the finance company's approval calls updateStatus(APPROVED)", async () => {
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    queryResults.set(COCKPIT_QUERY, cockpit());
    queryResults.set(GET_QUERY, application());
    renderCockpit();

    fireEvent.click(within(focusRow()).getByRole("button", { name: "RecordCreditDecisionAction" }));
    fireEvent.click(screen.getByTestId("credit-decision-APPROVED"));
    fireEvent.click(screen.getByRole("button", { name: "RecordCreditDecisionConfirm" }));

    await waitFor(() => expect(mutationCalls.get("applications:updateStatus")).toHaveLength(1));
    expect(mutationCalls.get("applications:updateStatus")![0]).toEqual({
      orgId: ORG,
      applicationId: APP,
      status: "APPROVED",
    });
  });

  test("UNDER_REVIEW: recording a rejection calls updateStatus(REJECTED) under the review permission", async () => {
    permissions.add(PERMISSIONS.REVIEW_FINANCE_APPLICATION);
    queryResults.set(COCKPIT_QUERY, cockpit());
    queryResults.set(GET_QUERY, application());
    renderCockpit();

    fireEvent.click(within(focusRow()).getByRole("button", { name: "RecordCreditDecisionAction" }));
    // The approval option is VISIBLE and refused with its reason — this caller
    // holds review but not approve — rather than missing.
    const approve = screen.getByTestId("credit-decision-APPROVED") as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.textContent).toContain("CreditDecisionApproveNeedsPermission");
    fireEvent.click(screen.getByTestId("credit-decision-REJECTED"));
    fireEvent.click(screen.getByRole("button", { name: "RecordCreditDecisionConfirm" }));

    await waitFor(() => expect(mutationCalls.get("applications:updateStatus")).toHaveLength(1));
    expect(mutationCalls.get("applications:updateStatus")![0]).toMatchObject({ status: "REJECTED" });
  });

  test("the application's own salesperson cannot record its approval, and is told why", () => {
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    stubs.membershipUserId = "user_sales";
    queryResults.set(COCKPIT_QUERY, cockpit());
    queryResults.set(GET_QUERY, application({ salespersonId: "user_sales" }));
    renderCockpit();

    fireEvent.click(within(focusRow()).getByRole("button", { name: "RecordCreditDecisionAction" }));
    const approve = screen.getByTestId("credit-decision-APPROVED") as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.textContent).toContain("CreditDecisionOwnDeal");
  });

  test("a caller with neither permission gets a reason, not a button, and no mutation", () => {
    queryResults.set(COCKPIT_QUERY, cockpit());
    queryResults.set(GET_QUERY, application());
    renderCockpit();

    expect(within(focusRow()).queryByRole("button")).toBeNull();
    expect(within(focusRow()).getByText("CreditDecisionNeedsPermission")).toBeTruthy();
    expect(mutationCalls.size).toBe(0);
  });
});

describe("cancel — applications.cancelApplication, from the header", () => {
  test("cancelling sends the reason and ONE retained idempotency key", async () => {
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    queryResults.set(COCKPIT_QUERY, cockpit());
    queryResults.set(GET_QUERY, application());
    renderCockpit();

    fireEvent.click(screen.getByTestId("deal-cancel-application"));
    fireEvent.change(screen.getByLabelText("CancellationReasonLabel"), {
      target: { value: "Wrong vehicle" },
    });
    fireEvent.click(screen.getByRole("button", { name: "CancelApplication" }));

    await waitFor(() => expect(mutationCalls.get("applications:cancelApplication")).toHaveLength(1));
    const call = mutationCalls.get("applications:cancelApplication")![0] as Record<string, unknown>;
    expect(call).toMatchObject({ orgId: ORG, applicationId: APP, reason: "Wrong vehicle" });
    expect(String(call.idempotencyKey)).toMatch(/^cancel-application:/);
  });

  test("APPROVED needs the approve permission on top of create — mirrors the server's tiers", () => {
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "APPROVED" }));
    queryResults.set(GET_QUERY, application({ status: "APPROVED" }));
    renderCockpit();
    expect(screen.queryByTestId("deal-cancel-application")).toBeNull();
  });

  test("CLOSED needs the finalize permission, and the dialog carries the reversal warning", () => {
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    permissions.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "CLOSED" }));
    queryResults.set(GET_QUERY, application({ status: "CLOSED" }));
    renderCockpit();
    fireEvent.click(screen.getByTestId("deal-cancel-application"));
    expect(screen.getByText("CancelClosedApplicationWarning")).toBeTruthy();
  });
});

describe("settlement route — applications.setSupplierSettlementRoute, beside the vehicle", () => {
  test("a consigned deal offers the route to a caller who can close, and records the choice", async () => {
    permissions.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "APPROVED" }));
    queryResults.set(
      GET_QUERY,
      application({
        status: "APPROVED",
        vehicle: { sourceType: "SOURCED", sourcedFromName: "أبو خالد" },
        canSettleDirectToSupplier: true,
      })
    );
    renderCockpit();

    const control = screen.getByTestId("deal-settlement-route");
    fireEvent.click(within(control).getByRole("radio", { name: /RouteDirectToSupplier/ }));

    await waitFor(() =>
      expect(mutationCalls.get("applications:setSupplierSettlementRoute")).toHaveLength(1)
    );
    expect(mutationCalls.get("applications:setSupplierSettlementRoute")![0]).toEqual({
      orgId: ORG,
      applicationId: APP,
      route: "DIRECT_TO_SUPPLIER",
    });
  });

  test("the direct route is shown disabled with the server's reason while a deposit is held", () => {
    permissions.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "APPROVED" }));
    queryResults.set(
      GET_QUERY,
      application({
        status: "APPROVED",
        vehicle: { sourceType: "SOURCED", sourcedFromName: "أبو خالد" },
        canSettleDirectToSupplier: false,
        directRouteRefusal: "HeldDeposit",
      })
    );
    renderCockpit();
    const direct = within(screen.getByTestId("deal-settlement-route")).getByRole("radio", {
      name: /RouteDirectToSupplier/,
    }) as HTMLButtonElement;
    expect(direct.disabled).toBe(true);
    expect(direct.textContent).toContain("RouteDirectUnavailableHeldDeposit");
  });

  test("no route control without the finalize permission, on an owned car, or on a closed deal", () => {
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "APPROVED" }));
    queryResults.set(
      GET_QUERY,
      application({ status: "APPROVED", vehicle: { sourceType: "SOURCED", sourcedFromName: "x" } })
    );
    renderCockpit();
    expect(screen.queryByTestId("deal-settlement-route")).toBeNull();
    cleanup();

    permissions.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
    queryResults.set(GET_QUERY, application({ status: "APPROVED" }));
    renderCockpit();
    expect(screen.queryByTestId("deal-settlement-route")).toBeNull();
    cleanup();

    queryResults.set(COCKPIT_QUERY, cockpit({ status: "CLOSED" }));
    queryResults.set(
      GET_QUERY,
      application({ status: "CLOSED", vehicle: { sourceType: "SOURCED", sourcedFromName: "x" } })
    );
    renderCockpit();
    expect(screen.queryByTestId("deal-settlement-route")).toBeNull();
  });
});

describe("disbursement — the two confirmations, from the DISBURSEMENT stage", () => {
  const closedStages = [
    { key: "APPROVED_PURCHASE", state: "COMPLETE", authority: "MIRROR" },
    { key: "DISBURSEMENT", state: "BLOCKED", blocker: "AwaitingDisbursement", authority: "MIRROR" },
    { key: "HANDOVER", state: "COMPLETE", authority: "DEALER" },
    { key: "SETTLEMENT", state: "PENDING", authority: "DEALER" },
  ];

  test("through the dealership: confirming the receipt calls confirmDisbursement with the expected minor amount and a key", async () => {
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "CLOSED", stages: closedStages }));
    queryResults.set(GET_QUERY, application({ status: "CLOSED" }));
    renderCockpit();

    fireEvent.click(within(focusRow()).getByRole("button", { name: "ConfirmDisbursement" }));
    fireEvent.click(screen.getByRole("button", { name: "ConfirmReceipt" }));

    await waitFor(() => expect(mutationCalls.get("applications:confirmDisbursement")).toHaveLength(1));
    const call = mutationCalls.get("applications:confirmDisbursement")![0] as Record<string, unknown>;
    // 15,000 JOD at scale 3 — the org-scale figure the Review dialog sent.
    expect(call).toMatchObject({ orgId: ORG, applicationId: APP, disbursedAmountMinor: 15_000_000 });
    expect(String(call.idempotencyKey)).toMatch(/^confirm-disbursement:/);
  });

  test("direct to the supplier: the advice is recorded through confirmSupplierDisbursement, scaled by the deal's currency", async () => {
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "CLOSED", stages: closedStages }));
    queryResults.set(
      GET_QUERY,
      application({
        status: "CLOSED",
        vehicle: { sourceType: "SOURCED", sourcedFromName: "أبو خالد" },
        supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
        canSettleDirectToSupplier: true,
      })
    );
    renderCockpit();

    fireEvent.click(within(focusRow()).getByRole("button", { name: "ConfirmSupplierDisbursement" }));
    // Prefilled from the approved purchase amount (16,500 JOD); confirm as-is.
    fireEvent.click(screen.getByRole("button", { name: "ConfirmRecorded" }));

    await waitFor(() =>
      expect(mutationCalls.get("applications:confirmSupplierDisbursement")).toHaveLength(1)
    );
    const call = mutationCalls.get("applications:confirmSupplierDisbursement")![0] as Record<string, unknown>;
    expect(call).toMatchObject({ orgId: ORG, applicationId: APP, disbursedAmountMinor: 16_500_000 });
    expect(String(call.idempotencyKey)).toMatch(/^confirm-supplier-disbursement:/);
    // The dealership receipt is NOT offered on the direct route — it would invent cash.
    expect(mutationCalls.get("applications:confirmDisbursement")).toBeUndefined();
  });

  test("without the permission the step names the person, not a button", () => {
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "CLOSED", stages: closedStages }));
    queryResults.set(GET_QUERY, application({ status: "CLOSED" }));
    renderCockpit();
    expect(within(focusRow()).queryByRole("button")).toBeNull();
    expect(within(focusRow()).getByText("DisbursementNeedsPermission")).toBeTruthy();
  });

  test("with the permission but nothing expected, the step names the fact", () => {
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "CLOSED", stages: closedStages }));
    queryResults.set(GET_QUERY, application({ status: "CLOSED", disbursedAt: Date.UTC(2026, 8, 1) }));
    renderCockpit();
    expect(within(focusRow()).queryByRole("button")).toBeNull();
    expect(within(focusRow()).getByText("DisbursementUnavailable")).toBeTruthy();
  });
});

describe("held deposit on a stopped deal — deposits.release", () => {
  const rejected = {
    status: "REJECTED",
    stages: [
      { key: "APPLICATION", state: "COMPLETE", authority: "DEALER" },
      { key: "CREDIT_DECISION", state: "STOPPED", authority: "MIRROR" },
    ],
    pendingDepositResolution: true,
  };

  test("refunding sends the resolution, the method the cash leaves by, and a retained key", async () => {
    permissions.add(PERMISSIONS.APPROVE_REQUESTS);
    queryResults.set(COCKPIT_QUERY, cockpit(rejected));
    queryResults.set(
      GET_QUERY,
      application({
        status: "REJECTED",
        deposits: [{ _id: "dep_1", amount: 500, status: "HELD", method: "CASH" }],
      })
    );
    renderCockpit();

    expect(screen.getByTestId("deal-deposit-awaiting-resolution")).toBeTruthy();
    fireEvent.click(within(screen.getByTestId("deal-deposit-dep_1")).getByRole("button", { name: "Refund" }));
    fireEvent.click(screen.getByRole("button", { name: "ConfirmRefund" }));

    await waitFor(() => expect(mutationCalls.get("deposits:release")).toHaveLength(1));
    const call = mutationCalls.get("deposits:release")![0] as Record<string, unknown>;
    expect(call).toMatchObject({
      orgId: ORG,
      depositId: "dep_1",
      resolution: "REFUNDED",
      refundMethod: "CASH",
    });
    expect(String(call.idempotencyKey)).toMatch(/^release-deposit:/);
  });

  test("forfeiting carries no refund method", async () => {
    permissions.add(PERMISSIONS.APPROVE_REQUESTS);
    queryResults.set(COCKPIT_QUERY, cockpit(rejected));
    queryResults.set(
      GET_QUERY,
      application({ status: "REJECTED", deposits: [{ _id: "dep_1", amount: 500, status: "HELD" }] })
    );
    renderCockpit();

    fireEvent.click(within(screen.getByTestId("deal-deposit-dep_1")).getByRole("button", { name: "Forfeit" }));
    fireEvent.click(screen.getByRole("button", { name: "ConfirmForfeit" }));

    await waitFor(() => expect(mutationCalls.get("deposits:release")).toHaveLength(1));
    expect(mutationCalls.get("deposits:release")![0]).toMatchObject({
      resolution: "FORFEITED",
      refundMethod: undefined,
    });
  });

  test("without approve:requests the deposit is listed but cannot be resolved here", () => {
    queryResults.set(COCKPIT_QUERY, cockpit(rejected));
    queryResults.set(
      GET_QUERY,
      application({ status: "REJECTED", deposits: [{ _id: "dep_1", amount: 500, status: "HELD" }] })
    );
    renderCockpit();
    const row = screen.getByTestId("deal-deposit-dep_1");
    expect(row.textContent).toContain("DepositStatusHeld");
    expect(within(row).queryByRole("button")).toBeNull();
  });

  test("deposits are not listed on a live deal", () => {
    permissions.add(PERMISSIONS.APPROVE_REQUESTS);
    queryResults.set(COCKPIT_QUERY, cockpit());
    queryResults.set(
      GET_QUERY,
      application({ deposits: [{ _id: "dep_1", amount: 500, status: "HELD" }] })
    );
    renderCockpit();
    expect(screen.queryByTestId("deal-deposits")).toBeNull();
  });
});

describe("documents — documents.updateDocumentStatus / upload, from the checklist", () => {
  test("verifying calls updateDocumentStatus(VERIFIED) on the row's own id", async () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.VERIFY_FINANCE_DOCUMENTS);
    queryResults.set(COCKPIT_QUERY, cockpit());
    queryResults.set(GET_QUERY, application());
    queryResults.set(DOCUMENTS_QUERY, [
      { _id: "doc_1", ruleName: "National ID", status: "UPLOADED", fileUrl: "https://files/x.pdf" },
      { _id: "doc_2", ruleName: "Salary slip", status: "MISSING", fileUrl: null },
    ]);
    renderCockpit();

    fireEvent.click(within(screen.getByTestId("deal-document-doc_1")).getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(mutationCalls.get("documents:updateDocumentStatus")).toHaveLength(1));
    expect(mutationCalls.get("documents:updateDocumentStatus")![0]).toEqual({
      orgId: ORG,
      documentId: "doc_1",
      status: "VERIFIED",
    });
    // A missing document offers an upload, not a verify.
    const missing = screen.getByTestId("deal-document-doc_2");
    expect(within(missing).queryByRole("button", { name: "Verify" })).toBeNull();
    expect(within(missing).getByText("Upload")).toBeTruthy();
  });

  test("a caller who may not read the document rows sees the read-only checklist and no controls", () => {
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ documents: [{ ruleId: "r1", name: "National ID", required: true, status: "MISSING" }] })
    );
    queryResults.set(GET_QUERY, application());
    queryResults.set(DOCUMENTS_QUERY, [
      { _id: "doc_1", ruleName: "National ID", status: "MISSING", fileUrl: null },
    ]);
    renderCockpit();
    const panel = screen.getByTestId("deal-documents");
    expect(panel.textContent).toContain("National ID");
    expect(within(panel).queryByRole("button")).toBeNull();
    expect(screen.queryByText("Upload")).toBeNull();
  });
});
