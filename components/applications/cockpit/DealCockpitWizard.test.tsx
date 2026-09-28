/**
 * SCRUM-417 — the deal as a wizard: every live stage shows exactly one next
 * step (one primary action that opens the right dialog), or one precise reason
 * naming what or who is blocking.
 *
 * CONTAINER tests, like `DealCockpitWorkflowTail.test.tsx`: the choosing of the
 * step — which stage, which blocker, which permission — happens in
 * `buildWorkflowAction` and the view's target resolution, and a view-level
 * fixture of `workflowAction` would prove neither.
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
    formatCompact: (n: number) => String(n),
    scale: 3,
  }),
}));

vi.mock("@/components/accounting/AccountingTabShared", () => ({
  scaleForCurrency: () => 3,
}));

const stubs = vi.hoisted(() => ({
  queryResults: new Map<string, unknown>(),
  /** The args each query was last mounted with, "skip" included. */
  queryArgs: new Map<string, unknown>(),
  permissions: new Set<string>(),
  membershipUserId: "user_manager",
  mutationCalls: new Map<string, unknown[]>(),
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
    useMutation: (reference: never) => {
      const name = getFunctionName(reference);
      return async (args: unknown) => {
        const calls = stubs.mutationCalls.get(name) ?? [];
        calls.push(args);
        stubs.mutationCalls.set(name, calls);
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

// The sale's own completion dialog (W3). Stubbed to a marker naming the sale
// it was opened for: the dialog's internals belong to the Sales page and are
// tested there; what THIS suite proves is that the cash step opens it, for
// this sale, and never as a blank new-sale form.
vi.mock("@/components/sales/SaleDialog", () => ({
  SaleDialog: ({ open, sale }: { open: boolean; sale?: { _id: string } | null }) =>
    open ? <div data-testid="sale-dialog">{sale?._id ?? "NEW-SALE"}</div> : null,
}));

import { DealCockpit, SaleDealCockpit } from "./DealCockpit";
import { PERMISSIONS } from "@/convex/utils/permissions";

const { queryResults, queryArgs, permissions, mutationCalls } = stubs;

const ORG = "org1" as Id<"organizations">;
const APP = "app_2048" as Id<"financeApplications">;
const SALE = "sale_7731" as Id<"sales">;
const JOD = 1_000;

const COCKPIT_QUERY = "dealWorkspace:financedDealCockpit";
const ECONOMICS_QUERY = "financingEconomics:getEconomics";
const APP_QUERY = "applications:get";

type Stage = { key: string; state: string; blocker?: string; authority?: string };

function cockpit(status: string, stages: Stage[], overrides: Record<string, unknown> = {}) {
  return {
    dealKind: "FINANCED",
    dealRef: APP,
    applicationId: APP,
    saleId: null,
    canonicalSaleId: null,
    status,
    createdAt: Date.UTC(2026, 6, 28),
    updatedAt: Date.UTC(2026, 7, 9),
    customer: null,
    vehicle: null,
    salespersonName: "",
    financeCompanyName: "",
    settlementAdviceRequiresReconciliation: false,
    settlementAdviceDiscrepancy: null,
    expectedPaymentRegistered: false,
    supplierSettlementRouteRequired: false,
    stages,
    documents: [],
    timeline: [],
    money: null,
    ...overrides,
  };
}

function economics(application: Record<string, unknown>, appraisals: unknown[] = []) {
  return {
    application: {
      _id: APP,
      status: "UNDER_REVIEW",
      salespersonId: "user_sales",
      economicsCurrency: "JOD",
      ...application,
    },
    appraisals,
    overrides: [],
    requiresLtvPercent: false,
  };
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    _id: APP,
    quoteId: "quote_1",
    status: "APPROVED",
    salespersonId: "user_sales",
    companyId: "company_1",
    economicsCurrency: "JOD",
    quote: { totalFinancedAmount: 15000 },
    vehicle: { sourceType: "OWNED" },
    deposits: [],
    hasExternalFinancier: true,
    canSettleDirectToSupplier: false,
    directRouteRefusal: null,
    ...overrides,
  };
}

function renderCockpit() {
  if (!queryResults.has(APP_QUERY)) queryResults.set(APP_QUERY, application());
  return render(<DealCockpit orgId={ORG} applicationId={APP} />);
}

const step = () => screen.getByTestId("deal-next-step");
const stepButton = () => within(step()).queryByTestId("deal-next-step-action");

afterEach(() => {
  cleanup();
  queryResults.clear();
  queryArgs.clear();
  permissions.clear();
  mutationCalls.clear();
  stubs.membershipUserId = "user_manager";
});

describe("G1 — a DRAFT application is submitted from its own step", () => {
  const draft = () =>
    cockpit("DRAFT", [
      { key: "APPLICATION", state: "CURRENT", authority: "DEALER" },
      { key: "CREDIT_DECISION", state: "PENDING", authority: "MIRROR" },
    ]);

  test("offers the one legal transition and sends DRAFT → PENDING_DOCS", async () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    queryResults.set(COCKPIT_QUERY, draft());
    queryResults.set(APP_QUERY, application({ status: "DRAFT" }));
    renderCockpit();

    expect(stepButton()?.textContent).toBe("SubmitApplicationAction");
    fireEvent.click(stepButton()!);
    await waitFor(() =>
      expect(mutationCalls.get("applications:updateStatus")).toEqual([
        { orgId: ORG, applicationId: APP, status: "PENDING_DOCS" },
      ])
    );
  });

  test("a caller the server would refuse is told why, with no button", () => {
    queryResults.set(COCKPIT_QUERY, draft());
    renderCockpit();
    expect(stepButton()).toBeNull();
    expect(step().textContent).toContain("SubmitApplicationNeedsPermission");
  });
});

describe("G6 — credit approval waits on the documents the server requires", () => {
  const underReview = (deliveryComplete: boolean) =>
    cockpit(
      "UNDER_REVIEW",
      [
        { key: "APPLICATION", state: "COMPLETE", authority: "DEALER" },
        { key: "CREDIT_DECISION", state: "BLOCKED", blocker: "AwaitingCreditDecision", authority: "MIRROR" },
        { key: "DELIVERY_ACTIONS", state: deliveryComplete ? "COMPLETE" : "PENDING", authority: "DEALER" },
      ],
      {
        documents: [{ ruleId: "r1", name: "هوية العميل", required: true, status: deliveryComplete ? "VERIFIED" : "MISSING" }],
      }
    );

  test("documents incomplete: the step goes to the documents, and the rejection stays one click away", () => {
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    permissions.add(PERMISSIONS.REVIEW_FINANCE_APPLICATION);
    // This caller can also upload the missing document, so the documents step
    // is one they can take. Without it the step is withheld with a reason
    // (W1) — see the status × capability matrix below.
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    queryResults.set(COCKPIT_QUERY, underReview(false));
    renderCockpit();

    expect(stepButton()?.textContent).toBe("CompleteDocumentsFirstAction");
    expect(within(step()).getByTestId("deal-next-step-note").textContent).toBe("CreditApprovalNeedsDocuments");
    // The secondary still opens the SAME credit dialog — with the approval
    // withheld and the reason the server would give.
    fireEvent.click(within(step()).getByTestId("deal-next-step-secondary"));
    const approve = screen.getByTestId("credit-decision-APPROVED");
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(approve.textContent).toContain("CreditApprovalNeedsDocuments");
    expect((screen.getByTestId("credit-decision-REJECTED") as HTMLButtonElement).disabled).toBe(false);
  });

  test("documents complete: the credit decision dialog is the step, as before", () => {
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    queryResults.set(COCKPIT_QUERY, underReview(true));
    renderCockpit();
    expect(stepButton()?.textContent).toBe("RecordCreditDecisionAction");
  });
});

describe("G3 — the finance company's decision, one step at a time, through the card's dialogs", () => {
  const appraisalStage = () =>
    cockpit("UNDER_REVIEW", [
      { key: "CREDIT_DECISION", state: "COMPLETE", authority: "MIRROR" },
      { key: "APPRAISAL", state: "BLOCKED", blocker: "AwaitingAppraisal", authority: "MIRROR" },
      { key: "APPROVED_PURCHASE", state: "PENDING", authority: "MIRROR" },
    ]);
  const approvedStage = () =>
    cockpit("APPROVED", [
      { key: "APPRAISAL", state: "COMPLETE", authority: "MIRROR" },
      { key: "APPROVED_PURCHASE", state: "BLOCKED", blocker: "NoApprovedPurchaseAmount", authority: "MIRROR" },
    ]);

  test("no quotation yet: record it first, opening the quotation dialog", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    queryResults.set(COCKPIT_QUERY, appraisalStage());
    queryResults.set(ECONOMICS_QUERY, economics({}));
    renderCockpit();

    expect(stepButton()?.textContent).toBe("RecordQuotationAction");
    fireEvent.click(stepButton()!);
    expect(screen.getByRole("dialog").textContent).toContain("RecordQuotationTitle");
  });

  test("quotation recorded, no appraisal: record the appraisal", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.REVIEW_FINANCE_APPLICATION);
    queryResults.set(COCKPIT_QUERY, appraisalStage());
    queryResults.set(ECONOMICS_QUERY, economics({ submittedQuotationMinor: 12_500 * JOD }));
    renderCockpit();

    expect(stepButton()?.textContent).toBe("RecordAppraisalAction");
    fireEvent.click(stepButton()!);
    expect(screen.getByRole("dialog").textContent).toContain("RecordAppraisalTitle");
  });

  test("a caller without the appraisal permission gets the card's own reason", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    queryResults.set(COCKPIT_QUERY, appraisalStage());
    queryResults.set(ECONOMICS_QUERY, economics({ submittedQuotationMinor: 12_500 * JOD }));
    renderCockpit();

    expect(stepButton()).toBeNull();
    expect(step().textContent).toContain("AppraisalNeedsReviewer");
  });

  test("no approved amount: record it, opening the approval dialog", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    queryResults.set(COCKPIT_QUERY, approvedStage());
    queryResults.set(ECONOMICS_QUERY, economics({ status: "APPROVED", submittedQuotationMinor: 12_500 * JOD }));
    renderCockpit();

    expect(stepButton()?.textContent).toBe("RecordApprovedPurchaseAction");
    fireEvent.click(stepButton()!);
    expect(screen.getByRole("dialog").textContent).toContain("RecordApprovedPurchaseTitle");
  });

  test("the deal's own salesperson is refused, as the server refuses them", () => {
    permissions.add(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    stubs.membershipUserId = "user_sales";
    queryResults.set(COCKPIT_QUERY, approvedStage());
    queryResults.set(ECONOMICS_QUERY, economics({ status: "APPROVED", submittedQuotationMinor: 12_500 * JOD }));
    renderCockpit();

    expect(stepButton()).toBeNull();
    expect(step().textContent).toContain("ApprovedPurchaseNotOwnDeal");
  });

  test("a caller who cannot read the economics is told who records them", () => {
    queryResults.set(COCKPIT_QUERY, approvedStage());
    renderCockpit();
    expect(stepButton()).toBeNull();
    expect(step().textContent).toContain("FinanceDecisionNeedsAccess");
  });
});

describe("G4 — a failed gap negotiation is not a dead end", () => {
  test("offers the gap resolution, the one writer that settles it", () => {
    permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
    queryResults.set(
      COCKPIT_QUERY,
      cockpit(
        "APPROVED",
        [{ key: "APPROVED_PURCHASE", state: "BLOCKED", blocker: "GapNegotiationFailed", authority: "DEALER" }],
        {
          money: {
            currency: "JOD",
            settlesDirectToSupplier: false,
            routeKnown: true,
            profit: { available: false, reason: "NO_APPROVED_PURCHASE" },
            expenses: { lines: [], actualTotalMinor: 0, awaitingActuals: 0 },
            parties: [],
            appraisalGapMinor: 500 * JOD,
          },
        }
      )
    );
    renderCockpit();
    expect(stepButton()?.textContent).toBe("ResolveGapAction");
  });

  test("a caller without the approval permission is told who records it", () => {
    queryResults.set(
      COCKPIT_QUERY,
      cockpit("APPROVED", [
        { key: "APPROVED_PURCHASE", state: "BLOCKED", blocker: "GapNegotiationFailed", authority: "DEALER" },
      ])
    );
    renderCockpit();
    expect(stepButton()).toBeNull();
    expect(step().textContent).toContain("GapResolutionNeedsPermission");
  });
});

describe("G5 — the documents step is an action that opens and focuses the checklist", () => {
  const delivery = () =>
    cockpit(
      "APPROVED",
      [{ key: "DELIVERY_ACTIONS", state: "BLOCKED", blocker: "DocumentsIncomplete", authority: "DEALER" }],
      { documents: [{ ruleId: "r1", name: "هوية العميل", required: true, status: "MISSING" }] }
    );

  test("the primary action switches to the Documents tab and focuses it", async () => {
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    queryResults.set(COCKPIT_QUERY, delivery());
    renderCockpit();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "DealTabActivity" }), { button: 0 });
    expect(stepButton()?.textContent).toBe("CompleteDocumentsAction");
    // One way there, not two: the passive link under the list is withdrawn.
    expect(within(step()).queryByTestId("deal-go-to-documents")).toBeNull();
    fireEvent.click(stepButton()!);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "DealTabDocuments" }));
  });

  test("a caller who can neither upload nor verify is told who does", () => {
    queryResults.set(COCKPIT_QUERY, delivery());
    renderCockpit();
    expect(stepButton()).toBeNull();
    expect(step().textContent).toContain("DocumentsNeedUploader");
  });
});

/**
 * W1 (Sol) = S417-2 (Codex): the documents step is a working step only for a
 * caller who can ADVANCE an outstanding required document under the server's
 * own gates — `generateUploadUrl` / `saveDocumentFile` take create OR verify
 * (for a MISSING or REJECTED document), `updateDocumentStatus` takes verify
 * (the only thing that moves an UPLOADED one). Everyone else is told why.
 *
 * Swept over every document status × every capability, on BOTH stages that
 * offer the step: the credit decision (G6) and the delivery actions (G5).
 */
describe("W1 — the documents step matches what this caller can do to the outstanding documents", () => {
  const ROLES = {
    "create only": [PERMISSIONS.CREATE_FINANCE_APPLICATION],
    "verify only": [PERMISSIONS.VERIFY_FINANCE_DOCUMENTS],
    both: [PERMISSIONS.CREATE_FINANCE_APPLICATION, PERMISSIONS.VERIFY_FINANCE_DOCUMENTS],
    neither: [] as string[],
  } as const;
  type Role = keyof typeof ROLES;
  const STATUSES = ["MISSING", "UPLOADED", "REJECTED", "VERIFIED", "WAIVED"] as const;
  type Status = (typeof STATUSES)[number];

  /** undefined = the step is a working button; a string = the reason shown instead. */
  function expected(status: Status, role: Role): string | undefined {
    if (role === "neither") return "DocumentsNeedUploader";
    if (status === "UPLOADED" && role === "create only") return "DocumentsAwaitVerifier";
    return undefined;
  }

  function stagesFor(stage: "CREDIT" | "DELIVERY", status: Status) {
    const done = status === "VERIFIED" || status === "WAIVED";
    const documents = [{ ruleId: "r1", name: "هوية العميل", required: true, status }];
    if (stage === "CREDIT") {
      return cockpit(
        "UNDER_REVIEW",
        [
          { key: "APPLICATION", state: "COMPLETE", authority: "DEALER" },
          { key: "CREDIT_DECISION", state: "BLOCKED", blocker: "AwaitingCreditDecision", authority: "MIRROR" },
          { key: "DELIVERY_ACTIONS", state: done ? "COMPLETE" : "PENDING", authority: "DEALER" },
        ],
        { documents }
      );
    }
    return cockpit(
      "APPROVED",
      done
        ? [
            { key: "DELIVERY_ACTIONS", state: "COMPLETE", authority: "DEALER" },
            { key: "HANDOVER", state: "CURRENT", authority: "DEALER" },
          ]
        : [{ key: "DELIVERY_ACTIONS", state: "BLOCKED", blocker: "DocumentsIncomplete", authority: "DEALER" }],
      { documents }
    );
  }

  const cases = (["CREDIT", "DELIVERY"] as const).flatMap((stage) =>
    STATUSES.flatMap((status) => (Object.keys(ROLES) as Role[]).map((role) => [stage, status, role] as const))
  );

  test.each(cases)("%s stage · document %s · caller %s", (stage, status, role) => {
    // The credit stage's caller always holds the credit permissions, so the
    // stage's own branch applies; the documents authority is what varies.
    if (stage === "CREDIT") {
      permissions.add(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
      permissions.add(PERMISSIONS.REVIEW_FINANCE_APPLICATION);
    }
    for (const permission of ROLES[role]) permissions.add(permission);
    queryResults.set(COCKPIT_QUERY, stagesFor(stage, status));
    renderCockpit();
    const text = step().textContent ?? "";
    const documentsKey = stage === "CREDIT" ? "CompleteDocumentsFirstAction" : "CompleteDocumentsAction";

    if (status === "VERIFIED" || status === "WAIVED") {
      // Nothing outstanding: the step has moved on past the documents.
      expect(stepButton()?.textContent).not.toBe(documentsKey);
      expect(text).not.toContain("DocumentsNeedUploader");
      expect(text).not.toContain("DocumentsAwaitVerifier");
      return;
    }

    const reason = expected(status, role);
    if (reason === undefined) {
      expect(stepButton()?.textContent).toBe(documentsKey);
    } else {
      expect(stepButton()).toBeNull();
      expect(text).toContain(reason);
    }
    if (stage === "CREDIT") {
      // Whatever happens to the documents step, a rejection needs no
      // documents and stays one quiet click away (G6).
      expect(within(step()).getByTestId("deal-next-step-secondary").textContent).toBe(
        "RecordCreditDecisionAction"
      );
    }
  });

  test("mixed: an uploaded document and a missing one — a create-only caller can still upload the missing one", () => {
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    queryResults.set(
      COCKPIT_QUERY,
      cockpit(
        "APPROVED",
        [{ key: "DELIVERY_ACTIONS", state: "BLOCKED", blocker: "DocumentsIncomplete", authority: "DEALER" }],
        {
          documents: [
            { ruleId: "r1", name: "هوية العميل", required: true, status: "UPLOADED" },
            { ruleId: "r2", name: "كشف الراتب", required: true, status: "MISSING" },
          ],
        }
      )
    );
    renderCockpit();
    expect(stepButton()?.textContent).toBe("CompleteDocumentsAction");
  });

  test("an optional document does not make the step look actionable", () => {
    permissions.add(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    queryResults.set(
      COCKPIT_QUERY,
      cockpit(
        "APPROVED",
        [{ key: "DELIVERY_ACTIONS", state: "BLOCKED", blocker: "DocumentsIncomplete", authority: "DEALER" }],
        {
          documents: [
            { ruleId: "r1", name: "هوية العميل", required: true, status: "UPLOADED" },
            { ruleId: "r2", name: "صورة إضافية", required: false, status: "MISSING" },
          ],
        }
      )
    );
    renderCockpit();
    expect(stepButton()).toBeNull();
    expect(step().textContent).toContain("DocumentsAwaitVerifier");
  });
});

describe("G7 — the settlement step resolves the reconciliation flag, then names every refusal", () => {
  const settlement = () =>
    cockpit(
      "APPROVED",
      [
        { key: "HANDOVER", state: "COMPLETE", authority: "DEALER" },
        { key: "SETTLEMENT", state: "BLOCKED", blocker: "AwaitingSettlement", authority: "DEALER" },
      ],
      { expectedPaymentRegistered: true }
    );

  test("flagged: the step is the review, and the dialog sends the note the mutation requires", async () => {
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    queryResults.set(COCKPIT_QUERY, settlement());
    queryResults.set(
      APP_QUERY,
      application({ needsFinancingReconciliation: true, financingReconciliationReason: "LTV basis not recorded" })
    );
    renderCockpit();

    expect(stepButton()?.textContent).toBe("ResolveReconciliationAction");
    fireEvent.click(stepButton()!);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("LTV basis not recorded");
    const confirm = within(dialog).getByTestId("resolve-reconciliation-confirm") as HTMLButtonElement;
    // The note is required: the server refuses an empty one.
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "  Checked the approval letter  " } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(mutationCalls.get("financingEconomics:resolveFinancingReconciliation")).toEqual([
        { orgId: ORG, applicationId: APP, note: "Checked the approval letter" },
      ])
    );
  });

  test("flagged, caller without the closing permission: told who reviews it", () => {
    queryResults.set(COCKPIT_QUERY, settlement());
    queryResults.set(APP_QUERY, application({ needsFinancingReconciliation: true }));
    renderCockpit();
    expect(stepButton()).toBeNull();
    expect(step().textContent).toContain("ReconciliationNeedsPermission");
  });

  // Sonnet SCRUM417 round 1: no coverage for a flagged deal whose settlement
  // route is ALSO still required. The review comes first — it takes the
  // closer's own permission and changes no amount — and the route is named
  // after it, by the close.
  test("flagged AND the settlement route still required: the review is the step", () => {
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    permissions.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
    queryResults.set(COCKPIT_QUERY, { ...settlement(), supplierSettlementRouteRequired: true });
    queryResults.set(APP_QUERY, application({ needsFinancingReconciliation: true }));
    renderCockpit();
    expect(stepButton()?.textContent).toBe("ResolveReconciliationAction");
    expect(step().textContent).not.toContain("FinalizeNeedsSettlementRoute");
  });

  test("not flagged: the close is the step, unchanged", () => {
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    queryResults.set(COCKPIT_QUERY, settlement());
    renderCockpit();
    expect(stepButton()?.textContent).toBe("FinalizeDealAction");
  });

  test("a held deposit on the direct route is named before the close is offered", () => {
    permissions.add(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
    permissions.add(PERMISSIONS.FINALIZE_FINANCED_DEAL);
    queryResults.set(COCKPIT_QUERY, settlement());
    queryResults.set(
      APP_QUERY,
      application({
        supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
        vehicle: { sourceType: "SOURCED" },
        deposits: [{ _id: "d1", amount: 500, status: "HELD", method: "CASH" }],
      })
    );
    renderCockpit();
    expect(stepButton()).toBeNull();
    expect(step().textContent).toContain("FinalizeNeedsHeldDepositResolved");
  });
});

describe("G8 — the cash rail names its step too", () => {
  const SUPPLIER = {
    party: "SUPPLIER",
    name: "شركة عمّان للاستيراد",
    position: "OWED_TO_DEALERSHIP",
    amountMinor: 3_000 * JOD,
    currency: "JOD",
    reference: undefined,
    receivableId: "recv_1",
  };
  function cash(saleStatus: "PENDING" | "COMPLETED") {
    return {
      dealKind: "CASH",
      financingApplicationId: null,
      dealRef: SALE,
      saleId: SALE,
      applicationId: null,
      status: saleStatus,
      createdAt: Date.UTC(2026, 7, 1),
      updatedAt: undefined,
      customer: null,
      vehicle: null,
      salespersonName: "",
      financeCompanyName: "",
      settlementAdviceRequiresReconciliation: false,
      settlementAdviceDiscrepancy: null,
      stages:
        saleStatus === "PENDING"
          ? [
              { key: "SALE_AGREED", state: "COMPLETE", authority: "DEALER" },
              { key: "HANDOVER", state: "CURRENT", authority: "DEALER" },
              { key: "SETTLEMENT", state: "PENDING", authority: "DEALER" },
            ]
          : [
              { key: "SALE_AGREED", state: "COMPLETE", authority: "DEALER" },
              { key: "HANDOVER", state: "COMPLETE", authority: "DEALER" },
              { key: "SETTLEMENT", state: "BLOCKED", blocker: "AwaitingSettlement", authority: "DEALER" },
            ],
      documents: [],
      timeline: [],
      money: {
        currency: "JOD",
        settlesDirectToSupplier: true,
        routeKnown: true,
        profit: {
          available: true,
          basis: "ACCOUNTING_RESULT",
          amountMinor: 3_000 * JOD,
          currency: "JOD",
          reconcilesToLedger: true,
          lines: [],
        },
        expenses: { lines: [], actualTotalMinor: 0, awaitingActuals: 0 },
        parties: [SUPPLIER],
        supplierReceipt: { actionable: true },
        appraisalGapMinor: undefined,
      },
    };
  }

  test("SETTLEMENT: the supplier settlement, opening the money panel's own dialog", () => {
    permissions.add(PERMISSIONS.MANAGE_FINANCE);
    queryResults.set("sales:dealCockpit", cash("COMPLETED"));
    render(<SaleDealCockpit orgId={ORG} saleId={SALE} />);

    expect(stepButton()?.textContent).toBe("SettleSupplierAction");
    fireEvent.click(stepButton()!);
    expect(screen.getByText("SettleSupplierTitle")).toBeTruthy();
  });

  test("SETTLEMENT without MANAGE_FINANCE: told who records it", () => {
    queryResults.set("sales:dealCockpit", cash("COMPLETED"));
    render(<SaleDealCockpit orgId={ORG} saleId={SALE} />);
    expect(stepButton()).toBeNull();
    expect(step().textContent).toContain("SupplierSettlementNeedsPermission");
  });

  /**
   * W3: HANDOVER on a cash deal is the draft sale awaiting completion. The step
   * OPENS the sale's own dialog — the one the Sales page opens, which saves
   * through `sales.update` (edit:sales) and then completes through
   * `sales.completeDraft` (create:sales) with its idempotency key and deposit
   * decision — so it is offered to a caller holding both, and to nobody else.
   * (This replaces a test that asserted the step had NO button: that
   * expectation encoded the dead end.)
   */
  const SALE_RECORD = { _id: SALE, orgId: ORG, status: "PENDING", saleDate: Date.UTC(2026, 7, 1) };

  test("HANDOVER on a draft sale: an authorized caller opens the sale's own dialog, for THIS sale", () => {
    permissions.add(PERMISSIONS.CREATE_SALES);
    permissions.add(PERMISSIONS.EDIT_SALES);
    queryResults.set("sales:dealCockpit", cash("PENDING"));
    queryResults.set("sales:get", SALE_RECORD);
    render(<SaleDealCockpit orgId={ORG} saleId={SALE} />);

    expect(queryArgs.get("sales:get")).toEqual({ orgId: ORG, saleId: SALE });
    expect(stepButton()?.textContent).toBe("CompleteCashSaleAction");
    // Above it: the draft IS what is outstanding — never "nothing is outstanding".
    expect(step().textContent).toContain("StageCashSaleIsDraft");
    expect(step().textContent).not.toContain("StageReadyToProceed");
    expect(screen.queryByTestId("sale-dialog")).toBeNull();
    fireEvent.click(stepButton()!);
    expect(screen.getByTestId("sale-dialog").textContent).toBe(SALE);
  });

  test("HANDOVER while the sale record is still loading: no button that could open a NEW sale", () => {
    permissions.add(PERMISSIONS.CREATE_SALES);
    permissions.add(PERMISSIONS.EDIT_SALES);
    queryResults.set("sales:dealCockpit", cash("PENDING"));
    render(<SaleDealCockpit orgId={ORG} saleId={SALE} />);
    expect(stepButton()).toBeNull();
    expect(screen.queryByTestId("sale-dialog")).toBeNull();
  });

  test.each([
    ["neither", [] as string[]],
    ["create:sales only", [PERMISSIONS.CREATE_SALES]],
    ["edit:sales only", [PERMISSIONS.EDIT_SALES]],
  ])("HANDOVER on a draft sale, caller with %s: told who completes it, no button", (_label, held) => {
    for (const permission of held) permissions.add(permission);
    queryResults.set("sales:dealCockpit", cash("PENDING"));
    queryResults.set("sales:get", SALE_RECORD);
    render(<SaleDealCockpit orgId={ORG} saleId={SALE} />);
    expect(stepButton()).toBeNull();
    expect(step().textContent).toContain("CashSaleCompletionNeedsPermission");
    // The sale record is not read for a caller who cannot use it.
    expect(queryArgs.get("sales:get")).toBe("skip");
    // Never "nothing is outstanding" above a refusal naming what is.
    expect(step().textContent).not.toContain("StageReadyToProceed");
  });
});
