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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
const ALLOCATION_QUERY = "deposits:quoteAllocation";

/** `deposits.quoteAllocation`'s summary: nothing committed, nothing paid out unless a case says so. */
function allocationSummary(overrides: Record<string, unknown> = {}) {
  return {
    currency: "JOD",
    scale: 3,
    isMultiVehicle: false,
    heldTotalMinor: 500_000,
    totalReceivedMinor: 500_000,
    allocatedMinor: 0,
    appliedMinor: 0,
    reversingMinor: 0,
    releasedAwaitingDecisionMinor: 0,
    refundedMinor: 0,
    forfeitedMinor: 0,
    otherFinalizedMinor: 0,
    resolvedOutMinor: 0,
    unallocatedMinor: 500_000,
    availableForAllocationMinor: 500_000,
    vehicles: [],
    vehiclesWithoutAllocation: [],
    ...overrides,
  };
}

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
    quoteId: "quote_1",
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

  test("a finalized deal sends the finance company's NET receivable, not the customer's principal", async () => {
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "CLOSED", stages: closedStages }));
    // finalizeDeal froze what the company actually owes after a 3,000 applied
    // deposit and a 1,375 deduction: 15,625 JOD. `confirmDisbursement`
    // compares the caller's figure to THIS and refuses the 20,000 principal.
    queryResults.set(
      GET_QUERY,
      application({
        status: "CLOSED",
        quote: { totalFinancedAmount: 20000, downPayment: 500, vehiclePrice: 22000 },
        financedSaleNetReceivableMinor: 15_625_000,
      })
    );
    renderCockpit();

    fireEvent.click(within(focusRow()).getByRole("button", { name: "ConfirmDisbursement" }));
    // The figure the operator confirms is the one that will be sent — spelled
    // in the DEAL's pinned currency, which is what the frozen net is built in.
    expect(screen.getByRole("dialog").textContent).toContain("15,625");
    fireEvent.click(screen.getByRole("button", { name: "ConfirmReceipt" }));

    await waitFor(() => expect(mutationCalls.get("applications:confirmDisbursement")).toHaveLength(1));
    expect(mutationCalls.get("applications:confirmDisbursement")![0]).toMatchObject({
      disbursedAmountMinor: 15_625_000,
    });
  });

  /**
   * SN3-1 after convergence (SCRUM-241 merged at main `4dd8a0ad8`). The
   * receipt settles the finance-company receivable in the RECEIVABLE'S own
   * denomination — the org's current currency is not consulted again
   * (`convex/sn31CurrencyMismatchRepro.test.ts`, "MERGED INVARIANT — AFTER
   * finalization"). So a closed deal pinned to another currency is no longer
   * withheld: the exact frozen net is sent, spelled in its own currency, and
   * nothing is converted. This case was the pre-convergence "withheld"
   * assertion and failed first against the re-evaluated gate.
   */
  test("a closed deal pinned to another currency: the receipt is USABLE and sends the exact frozen net, spelled in its own currency", async () => {
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "CLOSED", stages: closedStages }));
    // Economics pinned to USD (scale 2) on a JOD (scale 3) org. The frozen net
    // is 15,625.00 USD = 1,562,500 minor. Dividing by the ORG factor would have
    // shown 1,562.5 and labelled it in dinars.
    queryResults.set(
      GET_QUERY,
      application({
        status: "CLOSED",
        economicsCurrency: "USD",
        quote: { totalFinancedAmount: 20000, downPayment: 500, vehiclePrice: 22000 },
        financedSaleNetReceivableMinor: 1_562_500,
      })
    );
    renderCockpit();

    const row = focusRow();
    expect(within(row).queryByText("DisbursementCurrencyUnsupported")).toBeNull();
    expect(within(row).queryByText("DisbursementUnavailable")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "ConfirmDisbursement" }));
    expect(screen.getByRole("dialog").textContent).toContain("15,625 USD");
    expect(screen.getByRole("dialog").textContent).not.toContain("1,562");
    fireEvent.click(screen.getByRole("button", { name: "ConfirmReceipt" }));
    await waitFor(() => expect(mutationCalls.get("applications:confirmDisbursement")).toHaveLength(1));
    expect(mutationCalls.get("applications:confirmDisbursement")![0]).toMatchObject({
      orgId: ORG,
      applicationId: APP,
      disbursedAmountMinor: 1_562_500,
    });
  });

  test("a deal whose recorded currency AutoFlow does not recognise is withheld with its own reason, never read as the org currency", () => {
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "CLOSED", stages: closedStages }));
    queryResults.set(
      GET_QUERY,
      application({ status: "CLOSED", economicsCurrency: "JD", financedSaleNetReceivableMinor: 15_625_000 })
    );
    renderCockpit();
    expect(within(focusRow()).queryByRole("button")).toBeNull();
    expect(within(focusRow()).getByText("DisbursementCurrencyUnsupported")).toBeTruthy();
  });

  test("CONTROL — an absent pin is the org currency by construction and is NOT withheld", async () => {
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "CLOSED", stages: closedStages }));
    queryResults.set(
      GET_QUERY,
      application({ status: "CLOSED", economicsCurrency: undefined, financedSaleNetReceivableMinor: 15_625_000 })
    );
    renderCockpit();
    fireEvent.click(within(focusRow()).getByRole("button", { name: "ConfirmDisbursement" }));
    fireEvent.click(screen.getByRole("button", { name: "ConfirmReceipt" }));
    await waitFor(() => expect(mutationCalls.get("applications:confirmDisbursement")).toHaveLength(1));
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

  beforeEach(() => {
    queryResults.set(ALLOCATION_QUERY, allocationSummary());
  });

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
    // The GENERATION-AWARE identity (SCRUM-313): `deposits.release` pays out
    // whatever is FREE on the row, so two genuine payouts of one deposit are
    // byte-identical requests and only the server's `releaseCount` can tell a
    // retry from a second real payout. The intent names deposit, decision,
    // method and the generation observed when the operator decided.
    expect(call.idempotencyKey).toMatch(/^release-deposit:dep_1:REFUNDED:CASH:gen0:[0-9a-f-]{36}$/);
  });

  test("an unknown result keeps the SAME release identity for the retry; a confirmed payout that advanced the generation mints a NEW one", async () => {
    permissions.add(PERMISSIONS.APPROVE_REQUESTS);
    queryResults.set(COCKPIT_QUERY, cockpit(rejected));
    queryResults.set(
      GET_QUERY,
      application({
        status: "REJECTED",
        deposits: [{ _id: "dep_1", amount: 500, status: "HELD", method: "CASH", releaseCount: 2 }],
      })
    );
    stubs.mutationFailures.set("deposits:release", "network lost");
    renderCockpit();

    fireEvent.click(within(screen.getByTestId("deal-deposit-dep_1")).getByRole("button", { name: "Refund" }));
    fireEvent.click(screen.getByRole("button", { name: "ConfirmRefund" }));
    await waitFor(() => expect(mutationCalls.get("deposits:release")).toHaveLength(1));
    // Retry the same decision after the lost response.
    fireEvent.click(screen.getByRole("button", { name: "ConfirmRefund" }));
    await waitFor(() => expect(mutationCalls.get("deposits:release")).toHaveLength(2));
    const [first, second] = mutationCalls.get("deposits:release") as Array<{ idempotencyKey: string }>;
    expect(first.idempotencyKey).toMatch(/^release-deposit:dep_1:REFUNDED:CASH:gen2:/);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);

    // The payout confirmed and the server bumped the generation: the next
    // genuine release of the same row with the same decision is a NEW command.
    queryResults.set(
      GET_QUERY,
      application({
        status: "REJECTED",
        deposits: [{ _id: "dep_1", amount: 500, status: "HELD", method: "CASH", releaseCount: 3 }],
      })
    );
    cleanup();
    renderCockpit();
    fireEvent.click(within(screen.getByTestId("deal-deposit-dep_1")).getByRole("button", { name: "Refund" }));
    fireEvent.click(screen.getByRole("button", { name: "ConfirmRefund" }));
    await waitFor(() => expect(mutationCalls.get("deposits:release")).toHaveLength(3));
    const third = (mutationCalls.get("deposits:release") as Array<{ idempotencyKey: string }>)[2];
    expect(third.idempotencyKey).toMatch(/^release-deposit:dep_1:REFUNDED:CASH:gen3:/);
    expect(third.idempotencyKey).not.toBe(first.idempotencyKey);
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

  test("a deposit partly paid out, or with money committed elsewhere on the quote, is listed but NOT resolvable here", () => {
    permissions.add(PERMISSIONS.APPROVE_REQUESTS);
    queryResults.set(COCKPIT_QUERY, cockpit(rejected));
    // 2,000 of a 5,000 deposit already paid out: the face value is not what
    // the server would release, so the irreversible confirmation must not
    // offer the face value.
    queryResults.set(
      GET_QUERY,
      application({
        status: "REJECTED",
        deposits: [{ _id: "dep_1", amount: 5000, status: "HELD", releasedAmountMinor: 2_000_000 }],
      })
    );
    renderCockpit();
    const row = screen.getByTestId("deal-deposit-dep_1");
    expect(within(row).queryByRole("button")).toBeNull();
    expect(screen.getByText("DepositResolveElsewhere")).toBeTruthy();
    cleanup();

    // Same for money still assigned to a car on the quote, as the server's
    // own allocation summary reports it.
    queryResults.set(COCKPIT_QUERY, cockpit(rejected));
    queryResults.set(
      GET_QUERY,
      application({ status: "REJECTED", deposits: [{ _id: "dep_1", amount: 5000, status: "HELD" }] })
    );
    queryResults.set(ALLOCATION_QUERY, allocationSummary({ allocatedMinor: 3_000_000 }));
    renderCockpit();
    expect(within(screen.getByTestId("deal-deposit-dep_1")).queryByRole("button")).toBeNull();
    expect(screen.getByText("DepositResolveElsewhere")).toBeTruthy();
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

describe("the close is withheld where the server would refuse the drifted pin — SN3-1 after SCRUM-241", () => {
  const settlementStages = [
    { key: "HANDOVER", state: "COMPLETE", authority: "DEALER" },
    { key: "SETTLEMENT", state: "BLOCKED", blocker: "AwaitingSettlement", authority: "DEALER" },
  ];
  function closeable() {
    permissions.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
    permissions.add(PERMISSIONS.REGISTER_VEHICLE_HANDOVER);
    permissions.add(PERMISSIONS.REGISTER_EXPECTED_PAYMENT);
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ status: "APPROVED", expectedPaymentRegistered: true, stages: settlementStages })
    );
  }

  test("CONTROL — same currency: the close is offered", () => {
    closeable();
    queryResults.set(GET_QUERY, application({ status: "APPROVED", economicsCurrency: "JOD" }));
    renderCockpit();
    expect(within(focusRow()).getByRole("button", { name: "FinalizeDealAction" })).toBeTruthy();
  });

  test("a deal with a named finance company pinned to another currency: the close is withheld and the reason names the boundary", () => {
    closeable();
    queryResults.set(GET_QUERY, application({ status: "APPROVED", economicsCurrency: "USD" }));
    renderCockpit();
    expect(within(focusRow()).queryByRole("button")).toBeNull();
    expect(within(focusRow()).getByText("FinalizeCurrencyMismatch")).toBeTruthy();
    expect(within(focusRow()).queryByText("FinalizeNeedsPermission")).toBeNull();
  });

  test("the prerequisite is named before the permission: a caller who cannot close anyway still sees the currency boundary", () => {
    permissions.add(PERMISSIONS.REGISTER_VEHICLE_HANDOVER);
    permissions.add(PERMISSIONS.REGISTER_EXPECTED_PAYMENT);
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({ status: "APPROVED", expectedPaymentRegistered: true, stages: settlementStages })
    );
    queryResults.set(GET_QUERY, application({ status: "APPROVED", economicsCurrency: "USD" }));
    renderCockpit();
    expect(within(focusRow()).getByText("FinalizeCurrencyMismatch")).toBeTruthy();
  });

  test("a deal with NO named finance company is gated too: finalizeDeal refuses every drifted pin, financier or not", () => {
    closeable();
    queryResults.set(
      GET_QUERY,
      application({ status: "APPROVED", economicsCurrency: "USD", companyId: undefined, hasExternalFinancier: false })
    );
    renderCockpit();
    expect(within(focusRow()).queryByRole("button")).toBeNull();
    expect(within(focusRow()).getByText("FinalizeCurrencyMismatch")).toBeTruthy();
    // The recorded currency beside the org's, each an LTR isolate.
    const detail = within(focusRow()).getByTestId("settlement-denomination-detail");
    expect(detail.textContent).toContain("RecordedEconomicsCurrency: USD");
    expect(detail.textContent).toContain("OrganisationCurrencyLabel: JOD");
  });
});

describe("the route control sits on the step that is waiting for it", () => {
  test("while the application facts are still loading, the step keeps its blocker and names no refusal it cannot yet back with a control", () => {
    permissions.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
    permissions.add(PERMISSIONS.REGISTER_VEHICLE_HANDOVER);
    permissions.add(PERMISSIONS.REGISTER_EXPECTED_PAYMENT);
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({
        status: "APPROVED",
        expectedPaymentRegistered: true,
        supplierSettlementRouteRequired: true,
        stages: [
          { key: "HANDOVER", state: "COMPLETE", authority: "DEALER" },
          { key: "SETTLEMENT", state: "BLOCKED", blocker: "AwaitingSettlement", authority: "DEALER" },
        ],
      })
    );
    // `applications:get` deliberately NOT stubbed: still loading.
    renderCockpit();
    expect(within(focusRow()).getByText("BlockerAwaitingSettlement")).toBeTruthy();
    expect(within(focusRow()).queryByText("FinalizeNeedsSettlementRoute")).toBeNull();
    expect(within(focusRow()).queryByRole("button")).toBeNull();
  });

  test("when the close is refused for want of the route, the control renders inside the focus row and not beside the vehicle", () => {
    permissions.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
    permissions.add(PERMISSIONS.REGISTER_VEHICLE_HANDOVER);
    permissions.add(PERMISSIONS.REGISTER_EXPECTED_PAYMENT);
    queryResults.set(
      COCKPIT_QUERY,
      cockpit({
        status: "APPROVED",
        expectedPaymentRegistered: true,
        supplierSettlementRouteRequired: true,
        stages: [
          { key: "HANDOVER", state: "COMPLETE", authority: "DEALER" },
          { key: "SETTLEMENT", state: "BLOCKED", blocker: "AwaitingSettlement", authority: "DEALER" },
        ],
      })
    );
    queryResults.set(
      GET_QUERY,
      application({ status: "APPROVED", vehicle: { sourceType: "SOURCED", sourcedFromName: "أبو خالد" }, canSettleDirectToSupplier: true })
    );
    renderCockpit();

    const controls = screen.getAllByTestId("deal-settlement-route");
    expect(controls).toHaveLength(1);
    expect(focusRow().contains(controls[0])).toBe(true);
    expect(within(focusRow()).getByText("FinalizeNeedsSettlementRoute")).toBeTruthy();
  });
});

/**
 * P4 information parity (c19345/c19384): the customer's financing plan the
 * Review dialog used to be the only place to read is on the Deal, read-only,
 * and separate from the dealer economics. Every figure is the quote's own;
 * nothing is derived, and an absent one is "not recorded", not a zero.
 */
describe("the customer's financing plan is readable on the Deal, separately from the dealer economics", () => {
  test("renders the quote's price, down payment, financed amount, term and instalment in the deal's currency", () => {
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "APPROVED" }));
    queryResults.set(
      GET_QUERY,
      application({
        status: "APPROVED",
        quote: {
          vehiclePrice: 17000,
          downPayment: 2000,
          totalFinancedAmount: 15000,
          termMonths: 48,
          monthlyInstallment: 362.5,
        },
        customer: { firstName: "Test", lastName: "Customer", phone: "0790000000", nationalId: "1000000009" },
      })
    );
    renderCockpit();
    const panel = screen.getByTestId("deal-financing-plan");
    expect(panel.textContent).toContain("FinancingPlanHeading");
    expect(panel.textContent).toContain("17,000 Jordanian Dinar");
    expect(panel.textContent).toContain("2,000 Jordanian Dinar");
    expect(panel.textContent).toContain("15,000 Jordanian Dinar");
    expect(panel.textContent).toContain("48 MonthsUnit");
    expect(panel.textContent).toContain("362.5 Jordanian Dinar");
    // Not a money-panel figure: the dealer's approved purchase amount is not here.
    expect(panel.textContent).not.toContain("16,500");
  });

  test("a figure the quote does not carry is marked not recorded — never a zero", () => {
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "APPROVED" }));
    queryResults.set(
      GET_QUERY,
      application({
        status: "APPROVED",
        quote: { vehiclePrice: 17000, downPayment: 2000, termMonths: 48 },
      })
    );
    renderCockpit();
    const panel = screen.getByTestId("deal-financing-plan");
    expect(panel.textContent).toContain("FactUnavailable");
    expect(panel.textContent).not.toMatch(/\b0 JD/);
  });

  test("the national ID is masked to its last four by default and disclosed only on request; absent when not recorded", () => {
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "APPROVED" }));
    queryResults.set(
      GET_QUERY,
      application({
        status: "APPROVED",
        customer: { firstName: "Test", lastName: "Customer", phone: "0790000000", nationalId: "1000000009" },
      })
    );
    renderCockpit();
    const id = screen.getByTestId("deal-financing-plan-national-id");
    expect(id.textContent).toBe("••••••0009");
    fireEvent.click(screen.getByRole("button", { name: "ShowNationalId" }));
    expect(id.textContent).toBe("1000000009");
    fireEvent.click(screen.getByRole("button", { name: "HideNationalId" }));
    expect(id.textContent).toBe("••••••0009");

    cleanup();
    queryResults.set(
      GET_QUERY,
      application({ status: "APPROVED", customer: { firstName: "Test", lastName: "Customer", phone: "0790000000" } })
    );
    renderCockpit();
    expect(screen.queryByTestId("deal-financing-plan-national-id")).toBeNull();
    expect(screen.getByTestId("deal-financing-plan").textContent).not.toContain("NationalIdLabel");
  });
});

/**
 * رسوم ومصاريف تسليم السيارة (c19384): ADD / EDIT / REMOVE on the Deal go to
 * the three canonical `financeDealCosts` commands with exactly the payloads
 * the backend test (`convex/handoverCostsOnDeal.test.ts`) proves against the
 * real mutations. Cancel writes nothing; a caller without the create
 * permission gets the record read-only.
 */
describe("handover costs — financeDealCosts.{recordDealFee, recordActualFeeAmount, voidDealFee} from the Deal", () => {
  const COSTS_QUERY = "financeDealCosts:listDealCosts";
  function costsPayload(lines: Array<Record<string, unknown>> = []) {
    return {
      fees: lines,
      summary: {
        lineCount: lines.length,
        estimatedTotalMinor: 150_000,
        actualTotalMinor: 0,
        dealerBorneActualMinor: 0,
        linesAwaitingActual: lines.length,
        linesAwaitingReconciliation: 0,
        fullyReconciled: false,
      },
      custody: [],
    };
  }
  const transferLine = {
    _id: "fee_1",
    feeType: "OWNERSHIP_TRANSFER",
    description: "Licensing department",
    estimatedAmountMinor: 150_000,
    paidBy: "DEALER",
    paidTo: "GOVERNMENT",
    status: "ESTIMATED_ONLY",
  };
  function readableDeal() {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    queryResults.set(COCKPIT_QUERY, cockpit({ status: "APPROVED" }));
    queryResults.set(GET_QUERY, application({ status: "APPROVED" }));
  }

  test("ADD sends the handover line as dealer-borne with an explicit treatment and a RETAINED identity that survives an unknown result", async () => {
    readableDeal();
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    queryResults.set(COSTS_QUERY, costsPayload());
    stubs.mutationFailures.set("financeDealCosts:recordDealFee", "network lost");
    renderCockpit();

    fireEvent.click(screen.getByRole("button", { name: "AddHandoverCost" }));
    fireEvent.change(screen.getByLabelText("CostTypeLabel"), { target: { value: "LICENSING" } });
    fireEvent.change(screen.getByLabelText("CostDescriptionLabel"), { target: { value: "Plates" } });
    fireEvent.change(screen.getByLabelText(/CostAmountLabel/), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "SaveHandoverCost" }));
    await waitFor(() => expect(mutationCalls.get("financeDealCosts:recordDealFee")).toHaveLength(1));
    // The refusal is shown in the form, and the form is still there for a retry.
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "SaveHandoverCost" }));
    await waitFor(() => expect(mutationCalls.get("financeDealCosts:recordDealFee")).toHaveLength(2));

    const [first, second] = mutationCalls.get("financeDealCosts:recordDealFee") as Array<Record<string, unknown>>;
    expect(first).toMatchObject({
      orgId: ORG,
      applicationId: APP,
      feeType: "LICENSING",
      description: "Plates",
      // JOD, scale 3: 150 → 150,000 minor. An ESTIMATE, so no actual.
      estimatedAmountMinor: 150_000,
      actualAmountMinor: undefined,
      paidBy: "DEALER",
      paidTo: "GOVERNMENT",
      accountingTreatment: "SELLING_EXPENSE",
      source: "MANUAL",
    });
    expect(first.idempotencyKey).toMatch(/^record-deal-fee:app_2048:[0-9a-f-]{36}:[0-9a-f-]{36}$/);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  test("cancelling the add form writes nothing", () => {
    readableDeal();
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    queryResults.set(COSTS_QUERY, costsPayload());
    renderCockpit();
    fireEvent.click(screen.getByRole("button", { name: "AddHandoverCost" }));
    fireEvent.change(screen.getByLabelText(/CostAmountLabel/), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("deal-handover-cost-add")).toBeNull();
    expect(mutationCalls.get("financeDealCosts:recordDealFee")).toBeUndefined();
  });

  test("EDIT records the actual on the existing line (estimate preserved beside it), REMOVE voids it with a reason", async () => {
    readableDeal();
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    queryResults.set(COSTS_QUERY, costsPayload([transferLine]));
    renderCockpit();

    const line = screen.getByTestId("deal-handover-cost-fee_1");
    expect(line.textContent).toContain("CostStatusEstimated");
    fireEvent.click(within(line).getByRole("button", { name: "RecordActualCost" }));
    expect(screen.getByTestId("deal-handover-cost-edit-fee_1").textContent).toContain("CostEstimatePreservedNote");
    fireEvent.change(screen.getByLabelText(/^CostActual/), { target: { value: "165.5" } });
    fireEvent.change(screen.getByLabelText("CostPaidOnLabel"), { target: { value: "2026-09-10" } });
    fireEvent.change(screen.getByLabelText("ReceiptReferenceLabel"), { target: { value: "LIC-0910" } });
    fireEvent.click(screen.getByRole("button", { name: "SaveActualCost" }));
    await waitFor(() => expect(mutationCalls.get("financeDealCosts:recordActualFeeAmount")).toHaveLength(1));
    expect(mutationCalls.get("financeDealCosts:recordActualFeeAmount")![0]).toEqual({
      orgId: ORG,
      feeId: "fee_1",
      actualAmountMinor: 165_500,
      paidAt: Date.UTC(2026, 8, 10),
      receiptReference: "LIC-0910",
    });
    // No add, no second line: the edit is on the existing record.
    expect(mutationCalls.get("financeDealCosts:recordDealFee")).toBeUndefined();

    fireEvent.click(within(screen.getByTestId("deal-handover-cost-fee_1")).getByRole("button", { name: "RemoveHandoverCost" }));
    expect((screen.getByRole("button", { name: "ConfirmRemoveCost" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mutationCalls.get("financeDealCosts:voidDealFee")).toBeUndefined();
    fireEvent.change(screen.getByLabelText("VoidReasonLabel"), { target: { value: "Not needed for this buyer" } });
    fireEvent.click(screen.getByRole("button", { name: "ConfirmRemoveCost" }));
    await waitFor(() => expect(mutationCalls.get("financeDealCosts:voidDealFee")).toHaveLength(1));
    expect(mutationCalls.get("financeDealCosts:voidDealFee")![0]).toEqual({
      orgId: ORG,
      feeId: "fee_1",
      reason: "Not needed for this buyer",
    });
  });

  test("without create:finance_application the section is read-only; a non-handover line never gets controls", () => {
    readableDeal();
    queryResults.set(
      COSTS_QUERY,
      costsPayload([transferLine, { ...transferLine, _id: "fee_2", feeType: "FINANCE_COMPANY_FEE" }])
    );
    renderCockpit();
    const section = screen.getByTestId("deal-handover-costs");
    expect(within(section).queryByRole("button")).toBeNull();
    expect(section.textContent).toContain("FeeTypeOwnershipTransfer");
    expect(section.textContent).toContain("FeeTypeFinanceCompany");

    cleanup();
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    renderCockpit();
    expect(within(screen.getByTestId("deal-handover-cost-fee_1")).getByRole("button", { name: "RecordActualCost" })).toBeTruthy();
    expect(within(screen.getByTestId("deal-handover-cost-fee_2")).queryByRole("button")).toBeNull();
  });

  test("totals are the server's, estimated and actual apart; a line without an amount reads as not recorded, never zero", () => {
    readableDeal();
    queryResults.set(COSTS_QUERY, costsPayload([{ ...transferLine, estimatedAmountMinor: undefined, status: "UNQUANTIFIED" }]));
    renderCockpit();
    const totals = screen.getByTestId("deal-handover-costs-totals");
    expect(totals.textContent).toContain("CostsExpectedTotal");
    expect(totals.textContent).toContain("CostsActualTotal");
    const line = screen.getByTestId("deal-handover-cost-fee_1");
    expect(line.textContent).toContain("CostStatusUnquantified");
    expect(line.textContent).toContain("FactUnavailable");
  });
});
