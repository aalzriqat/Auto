import type { DisbursementConfirmationDialog } from "../DisbursementConfirmationDialog";
import type { ForwardCorrectionKind } from "../ForwardCorrectionDialog";
import type {
  ForwardConfirmOutcome,
  ForwardPaymentValues,
} from "../RecordForwardToFinanceCompanyDialog";
import type { ExpectedPaymentMethod } from "../RegisterExpectedPaymentDialog";
import type { CancelApplicationValues } from "./CancelApplicationDialog";
import type { CreditDecision } from "./CreditDecisionDialog";
import type { CustomerFinanceCompanyPayment } from "./CustomerFinanceCompanyPaymentCard";
import type { DealClosingChecklist } from "./DealClosingReadinessPanel";
import type { DealCustodyWiring } from "./DealCustodyPanel";
import type {
  DealDocument,
  DealDocumentHistoryItem,
} from "./DealDocumentsPanel";
import type { FinancedDealOverviewData } from "./DealFinancialOverview";
import type { DealCommissionsSlot } from "./DealMoneyPanel";
import type { DealCockpitData } from "./DealStagePresentation";
import type { StageDeepLink } from "./dealStepView";
import type { WorkflowAction } from "./DealWorkflowAction";
import type { FinanceDecisionFacts } from "./FinanceCompanyDecisionCard";
import type { FinancingPlanFacts } from "./FinancingPlanPanel";
import type {
  DirectPaymentBankOptions,
  HandoverCostsPanel,
} from "./HandoverCostsPanel";
import type { AppraisalProviderType } from "./RecordAppraisalDialog";
import type {
  ApprovalSubmission,
  DeliveredApprovalCorrection,
} from "./RecordApprovedPurchaseDialog";
import type {
  RecordedFeedback,
  RecordedTrackOptions,
} from "./recordedFeedback";
import type { QuotationCalculation } from "./RecordSubmittedQuotationDialog";
import type { SupplierConcessionBasis } from "./ResolveGapDialog";
import type {
  DirectRouteRefusal,
  SupplierSettlementRoute,
} from "./SettlementRouteControl";
import type {
  DealDeposit,
  DepositResolution,
} from "./StoppedDealDepositsPanel";
import type { UnwindFinishValues, UnwindStatusView } from "./UnwindDealDialog";
import type { PaymentMethod } from "@/components/payments/PaymentMethodSelect";
import type { Id } from "@/convex/_generated/dataModel";
import type { PendingPayout } from "@/hooks/usePendingDepositPayouts";
import type { ComponentProps, ReactNode } from "react";

/**
 * Who actually performed the appraisal on record, as the SERVER recorded it.
 * `null` means no active appraisal, or one recorded as a dealer estimate —
 * neither of the two parties a badge can truthfully name.
 */
export type ActiveAppraisalProvider = "FINANCE_COMPANY" | "INDEPENDENT" | null;

/**
 * The money summary card, extracted so `DealCockpitView` clears the cognitive
 * complexity gate. Presentation only: every figure and every classification
 * arrives already derived from `applications.dealCockpit`, and nothing here
 * computes money. The headline cannot be rendered without its qualifier,
 * because amount and classification travel in one object.
 */
/**
 * Everything the decision card and its two dialogs need, assembled by the
 * container.
 *
 * Passed in rather than queried here for the same reason the deal is: this view
 * has to render against server-shaped fixtures, and the permission and evidence
 * combinations — no appraisal, own deal, redacted amount, closed application —
 * are exactly what the tests have to vary.
 */
export type FinanceDecisionWiring = {
  facts: FinanceDecisionFacts;
  /** The application's OWN pinned currency, which need not be the org's. */
  currency: string | null;
  canRecordQuotation: boolean;
  canRecordApproval: boolean;
  /** May this caller establish the deal's own LTV — approval AND finance visibility. */
  canEstablishLtvPercent: boolean;
  canRecordAppraisal: boolean;
  isOwnDeal: boolean;
  /**
   * The server's judgement that the recorded amount is unlike every figure on
   * file — the same rule `approveDealerPurchaseAmount` refuses on. Consumed by
   * the handover confirmation; never recomputed on this side.
   */
  approvedAmountIsFarFromEvidence?: boolean;
  /** What the calculator has to say, including "not yet arrived". */
  calculation: QuotationCalculation;
  appraisal: { id: string; amountMinor: number } | null;
  onRecordQuotation: (values: {
    submittedQuotationMinor: number;
    source: "SYSTEM_CALCULATED" | "MANUAL_ENTRY" | "CALCULATED_WITH_OVERRIDE";
    overrideReason?: string;
    /** The rate for THIS deal, when its own frozen rules carry none. */
    ltvPercent?: number;
    expectedEconomicsStamp?: string;
  }) => Promise<void>;
  onRecordApproved: (
    values: ApprovalSubmission,
    expectedEconomicsStamp?: string,
  ) => Promise<void>;
  deliveredApprovalCorrection?: DeliveredApprovalCorrection | null;
  /** The server requires a reason to withdraw the recorded approval. */
  onReopenApproved: (values: {
    reason: string;
    economicsStamp?: string;
  }) => Promise<string | void>;
  /** SCRUM-373 D2: present only when the server would accept the correction. */
  firstPaymentCorrection?: {
    quoteDownPaymentMinor: number;
    economicsStamp: string;
  } | null;
  onApplyQuoteFirstPayment?: (values: {
    reason: string;
    economicsStamp: string;
  }) => Promise<void>;
  firstPaymentEvidence?: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
  };
  /** SCRUM-766: confirmed payments toward the agreed appraisal shortfall. */
  customerPayment?: {
    agreedMinor: number;
    confirmedMinor: number;
    awaitingMinor: number;
    payments: ReadonlyArray<CustomerFinanceCompanyPayment> | undefined;
    canRecord: boolean;
    closed: boolean;
    onConfirm: (values: {
      amountMinor: number;
      paidAt: number;
      reference: string;
    }) => Promise<boolean>;
    onVoid: (values: { paymentId: string; reason: string }) => Promise<boolean>;
  } | null;
  onRecordAppraisal: (values: {
    appraisalAmountMinor: number;
    providerType: AppraisalProviderType;
    providerName?: string;
    appraisedAt: number;
    reappraisalReason?: string;
    expectedEconomicsStamp?: string;
  }) => Promise<void>;
};

export type DealCockpitViewProps = Readonly<{
  /** Renders the employee commissions row on the money card; absent in a plain view. */
  renderCommissions?: DealCommissionsSlot;
  stageCorrection?: Readonly<{
    stageKey: string;
    labelKey: string;
    onOpen: () => void;
  }>;
  orgId?: Id<"organizations">;
  /** `undefined` while loading, `null` when the deal is not readable. */
  deal: DealCockpitData | null | undefined;
  /**
   * Which step is being LOOKED at, mirrored to `?stage=` by the route
   * (SCRUM-417 UX4, O3). Absent, the choice is kept in this view. Either way it
   * is view selection only: it never changes the live stage or any command.
   */
  stageDeepLink?: StageDeepLink;
  /**
   * SCRUM-417 UX5 (S7): the container's hold-until-reflected feedback. Absent
   * (a plain view, a test), a step's success is announced at once, as before.
   */
  recordedFeedback?: {
    /** The step that was just recorded and is now on screen; `null` when there is none. */
    recorded: RecordedFeedback | null;
    track: <T>(
      run: () => Promise<T>,
      fallbackKey: string,
      options?: RecordedTrackOptions,
    ) => Promise<T>;
    onDismiss: () => void;
  };
  /** Deposit requests still waiting on this deal (SCRUM-444). Financed only. */
  depositRequests?: {
    orgId: Id<"organizations">;
    requests: ReadonlyArray<{
      _id: Id<"depositRequests">;
      amount: number;
      currency: string;
    }>;
  };
  /** Where the header's back link goes — the deals list. Absent, no link. */
  backHref?: string;
  /** The credit-decision dialog's own state. Financed only. */
  creditDecision?: {
    deciding: boolean;
    submitting: boolean;
    error: string | null;
    canApprove: boolean;
    canReject: boolean;
    isOwnDeal: boolean;
    /** The server refuses the approval until the documents are complete. */
    documentsIncomplete?: boolean;
    onOpenChange: (open: boolean) => void;
    onSubmit: (decision: CreditDecision) => void | Promise<void>;
  };
  /** Present only for a caller the server would let cancel this deal. */
  cancel?: {
    isClosed: boolean;
    confirming: boolean;
    submitting: boolean;
    error: string | null;
    onOpenChange: (open: boolean) => void;
    onSubmit: (values: CancelApplicationValues) => void | Promise<void>;
  };
  /**
   * SCRUM-435: shown where the cancel action would be when this caller may open
   * a deal's cancellation in principle but a finalized v2 deal is cancelled by a
   * manager. Names who acts instead of leaving the deal without an answer.
   * `FORWARD`: the caller holds every cancel authority, so the payment to the
   * finance company is what blocks it (SCRUM-413 D-37) - never blame permissions.
   */
  cancelHint?: "MANAGER" | "FORWARD";
  /**
   * SCRUM-693 / SCRUM-691: the paid-deal reversal. `offered` is the server's answer (a live
   * unwind, or a paid deal whose start the server would accept). Otherwise `hint` carries the
   * server's refusal so a paid deal is never left without an explanation.
   */
  unwind?: {
    status: UnwindStatusView;
    offered: boolean;
    hint?: { code: string; message: string };
    open: boolean;
    submitting: boolean;
    error: string | null;
    formatMinor: (minor: number) => string;
    notBefore?: number;
    onOpenChange: (open: boolean) => void;
    onStart: (reason: string) => void | Promise<void>;
    onForwardReturn: (values: {
      returnedAt: number;
      reference: string;
    }) => void | Promise<void>;
    onFinish: (values: UnwindFinishValues) => void | Promise<void>;
    onAbandon: (reason: string) => void | Promise<void>;
  };
  /**
   * SCRUM-435: void or report-returned for the payment on the books. Present only
   * for a caller the server would let do it, and only while a payment is on the
   * books - so a manager is never told to report a return with nowhere to do it.
   */
  forwardCorrection?: {
    /** Before the finance company's transfer is confirmed a payment can be voided. */
    canVoid: boolean;
    open: ForwardCorrectionKind | null;
    submitting: boolean;
    onOpen: (kind: ForwardCorrectionKind) => void;
    onClose: () => void;
    onConfirm: (reason: string) => void | Promise<void>;
  };
  /**
   * SCRUM-239: the bank returned the finance company's cheque after it cleared.
   * Present only when the server says this caller may (`disbursementReturn.mayReturn`)
   * AND the transfer is confirmed AND a cleared cheque is linked.
   */
  chequeReturn?: {
    open: boolean;
    submitting: boolean;
    onOpen: () => void;
    onClose: () => void;
    onConfirm: (reason: string) => void | Promise<void>;
  };
  /** Present only while the route may still be chosen (consigned, not closed, finalize permission). */
  settlementRoute?: {
    route: SupplierSettlementRoute | undefined;
    canSettleDirectToSupplier: boolean;
    directRouteRefusal: DirectRouteRefusal;
    supplierName: string | undefined;
    onChoose: (route: SupplierSettlementRoute) => void | Promise<void>;
  };
  /**
   * The document checklist with its controls. `items` is undefined while
   * loading or when the caller may not read `documents.getForApplication`,
   * in which case the panel shows the cockpit payload's read-only checklist.
   */
  documents?: {
    items: ReadonlyArray<DealDocument> | undefined;
    /** Files kept for requirements that no longer apply — view only (round 3, S417-R3-1). */
    history?: ReadonlyArray<DealDocumentHistoryItem>;
    canUpload: boolean;
    canVerify: boolean;
    /** The rule ids whose upload is in flight — see `DealDocumentsPanel`. */
    uploadingRuleIds: ReadonlySet<string>;
    onUpload: (doc: DealDocument, file: File) => void | Promise<void>;
    onVerify: (documentId: string) => void | Promise<void>;
  };
  /** The deal's deposits, present only on a stopped deal that has any. */
  deposits?: {
    items: ReadonlyArray<DealDeposit>;
    canResolve: boolean;
    /** Server-derived: nothing on the quote is applied, assigned, awaiting a decision or paid out. */
    faceValueIsReleasable: boolean;
    resolvingId: string | null;
    onResolve: (
      depositId: string,
      resolution: DepositResolution,
      refundMethod: PaymentMethod | undefined,
      observedReleaseCount: number,
      bankAccountId?: Id<"bankAccounts">,
    ) => Promise<void>;
    /** SCRUM-469 F1: earlier unconfirmed payouts blocking a different decision, by deposit id. */
    unconfirmed: Readonly<Record<string, PendingPayout>>;
    onDismissUnconfirmed: (depositId: string) => void;
  };
  /** The two disbursement confirmations' own state. Financed only. */
  disbursement?: {
    financeCompany: {
      confirming: boolean;
      submitting: boolean;
      amountLabel: string;
      /** SCRUM-54: present while the receipt must name its bank (not CASH). */
      bank?: ComponentProps<typeof DisbursementConfirmationDialog>["bank"];
      onOpenChange: (open: boolean) => void;
      onConfirm: () => void | Promise<void>;
    };
    /** SCRUM-435: the payment to the finance company that precedes the transfer. */
    forward?: {
      confirming: boolean;
      submitting: boolean;
      dueMinor: number;
      totalLabel: string;
      depositLabel: string;
      contributionLabel: string;
      bankOptions: DirectPaymentBankOptions;
      onOpenChange: (open: boolean) => void;
      onConfirm: (
        values: ForwardPaymentValues,
      ) => ForwardConfirmOutcome | Promise<ForwardConfirmOutcome>;
    };
    supplier: {
      confirming: boolean;
      submitting: boolean;
      supplierName: string | undefined;
      amountLabel: string;
      defaultAmountMajor: number | undefined;
      onOpenChange: (open: boolean) => void;
      onConfirm: (advice: {
        amountMajor: number;
        reference?: string;
        disbursedAt?: number;
      }) => void | Promise<void>;
    };
  };
  /**
   * Who actually performed the appraisal on record, as the SERVER recorded it.
   *
   * `APPRAISAL` is a MIRROR stage, and the rail would otherwise render every
   * MIRROR stage as the finance company's — wrong whenever an INDEPENDENT
   * appraiser did the work. `null` is rendered as an explicit "not recorded"
   * rather than defaulted to either side, because guessing here is the defect.
   * Financed deals only; the cash rail has no appraisal stage at all.
   */
  activeAppraisalProvider?: ActiveAppraisalProvider;
  /**
   * A rejected or cancelled deal still holding a HELD customer deposit that
   * nobody has refunded or forfeited — real cash in a liability with no owner.
   * The applications LIST has always surfaced this as `DEPOSIT_PENDING`; the
   * deal screen used to read as a plain "Rejected" beside it. Financed only.
   */
  depositAwaitingResolution?: boolean;
  /**
   * Absent on a cash deal, and while the economics query is still loading or
   * was skipped for want of `view:finance_applications`.
   */
  financeDecision?: FinanceDecisionWiring;
  /**
   * True while the wiring above can still ARRIVE: permissions, the application
   * or the economics query have not answered yet. The container computes it from
   * those queries' real states. It is deliberately NOT derived from the stage:
   * a caller who is never given a panel (no `view:finance_applications`, so the
   * economics and closing queries are skipped for good) must not be told to wait
   * for it. Pending keeps the record closed so it never flashes open and snaps
   * shut when the step's panel lands; once it is false, a step with no panel
   * of its own opens the record.
   */
  workbenchPending?: boolean;
  /**
   * The customer's financing plan as the quote recorded it — financed deals
   * only, and only once `applications.get` has arrived. Read-only; separate
   * from the dealer economics in the money panel by design.
   */
  financingPlan?: {
    facts: FinancingPlanFacts;
    formatMajor: (major: number, currency: string) => string;
  };
  /**
   * The handover-cost section with its four commands wired — financed deals
   * only. When present it REPLACES the read-only expenses card: same lines,
   * same canonical record, plus the controls.
   */
  handoverCosts?: Omit<ComponentProps<typeof HandoverCostsPanel>, "t">;
  /**
   * The deal's automatic closing readiness (SCRUM-407), which replaced the
   * manual "classify deal accounting" step: every check is re-derived by the
   * server and re-run by finalization. `readiness` is undefined while loading
   * and when the read failed; `serviceUnavailable` says which.
   * `legalInvoice` is present for the disbursement tier only — the invoice is
   * still recorded by hand while the v1 posting plan reads it (SCRUM-411).
   */
  noCostCloseout?: ReactNode;
  closingChecklist?: DealClosingChecklist;
  /**
   * The server's financial overview and vehicle cost basis — financed deals
   * only. `data` is undefined while loading; each half is null when the
   * server withheld it for this caller.
   */
  financialOverview?: {
    data: FinancedDealOverviewData | null | undefined;
    loading: boolean;
  };
  /** The employee cash-custody section with its commands wired — financed deals only. */
  custody?: DealCustodyWiring;
  /** Spells a minor amount IN THE GIVEN currency, for the custody section. */
  custodyMoney?: (minor: number, currency: string) => string;
  /**
   * The action belonging to the stage the rail currently names.
   *
   * One at a time, keyed to a stage, because the workflow tail is strictly
   * ordered on the server: handover requires an APPROVED application, expected
   * payment requires the handover, and each refuses a second attempt. Offering
   * the whole tail at once would put three buttons on screen of which two are
   * guaranteed refusals.
   *
   * `unavailableReasonKey` is the other half and is not optional in spirit:
   * when this caller cannot take the step the rail is naming, the screen says
   * so. A named step with neither a button nor a reason is the dead end this
   * issue exists to remove.
   */
  workflowAction?: WorkflowAction;
  /** The handover confirmation's own state — absent on a deal that cannot reach it. */
  handover?: {
    confirming: boolean;
    submitting: boolean;
    onOpenChange: (open: boolean) => void;
    /** Rejects on refusal; the error belongs to the dialog's attempt. */
    onSubmit: (values: {
      notes?: string;
      economicsStamp: string | undefined;
    }) => Promise<void>;
  };
  /** Settling the shortfall left when the company approved below the quotation (SCRUM-83). */
  gapResolution?: {
    resolving: boolean;
    submitting: boolean;
    onOpenChange: (open: boolean) => void;
    /** Context figures from the economics row; null when withheld from this caller. */
    submittedQuotationMinor: number | null;
    approvedPurchaseAmountMinor: number | null;
    /** Null unless the supplier may concede part of the shortfall (SOURCED vehicle). */
    supplierBasis: SupplierConcessionBasis | null;
    /** Rejects on refusal, so the dialog can name the figure that did not add up. */
    onSubmit: (values: {
      customerGapShareMinor: number;
      dealerGapShareMinor: number;
      customerGapCashToDealerMinor: number;
      customerGapInstallmentToDealerMinor: number;
      customerGapToFinanceCompanyMinor: number;
      supplierGapShareMinor?: number;
      observedSupplierEntitlementMinor?: number;
      observedSupplierName?: string;
      observedSupplierId?: Id<"suppliers">;
      notes: string;
      economicsStamp: string | undefined;
    }) => Promise<void>;
  };
  /** The expected-payment form's own state. */
  expectedPayment?: {
    registering: boolean;
    submitting: boolean;
    error: string | null;
    onOpenChange: (open: boolean) => void;
    onSubmit: (values: {
      method: ExpectedPaymentMethod;
      expectedDate: number;
      chequeDetails?: { bank: string; chequeNumber: string };
      faceAmount?: string;
    }) => void | Promise<void>;
  };
  /** The finalization confirmation's own state. */
  finalize?: {
    confirming: boolean;
    submitting: boolean;
    error: string | null;
    onOpenChange: (open: boolean) => void;
    onSubmit: () => void | Promise<void>;
    profitApproval?: { notice: ReactNode; blocked: boolean };
    /** Why the close may not be submitted right now (S414-R3-1), or null. */
    readinessHold?: string | null;
  };
  /**
   * Whether this caller may amend a recorded settlement advice (MANAGE_FINANCE).
   *
   * Passed in rather than read from a hook here, for the same reason the rest
   * of this component takes its data as a prop: the view has to be renderable
   * against fixtures, and the permission state is exactly the thing the tests
   * need to vary. Defaults to `false` so a caller that forgets it hides the
   * action rather than offering one the server will refuse.
   */
  canCorrectAdvice?: boolean;
  /** REGISTER_EXPECTED_PAYMENT — see `FcChequePanel.canRegisterPayment`. */
  canRegisterPayment?: boolean;
  /** SCRUM-447: the finance-company cheque actions (MANAGE_FINANCE gates them via `canCorrectAdvice`). */
  fcCheque?: {
    onAttest: (faceAmount: string, note: string) => Promise<void>;
    onCorrect: (reason: string) => Promise<void>;
  };
  /**
   * Whether this caller may record a supplier receipt (MANAGE_FINANCE — the
   * permission `supplierReceivables.recordReceipt` requires). The route and
   * the supplier's position say whether there is a claim to settle; only this
   * says whether THIS operator may settle it. Same contract as
   * `canCorrectAdvice`: passed in, never read from a hook in presentation, and
   * defaulting to `false` so a container that forgets it hides the action
   * rather than offering one the server will refuse.
   */
  canSettleSupplier?: boolean;
  /**
   * Where accounting records a supplier balance this screen does not settle
   * (SCRUM-417 UX1, S4). Passed only when the caller can act there
   * (MANAGE_FINANCE to record, VIEW_FINANCE to open the page); absent, the
   * step names accounting as who acts, without a link.
   */
  supplierSettlementHref?: string;
  /**
   * Whether this caller can act on the outstanding documents — the container's
   * `documentsStepUnavailableReason` verdict (SCRUM-417 UX1, S3), never
   * re-derived here. Gates the passive "Go to documents" link. Defaults to
   * true so a view rendered without it keeps its link.
   */
  documentsActionable?: boolean;
  onCorrectSettlementAdvice?: (correction: {
    amountMajor: number;
    reference?: string;
    /** The operator emptied a reference that was on file — not the same as omitting it. */
    clearReference?: boolean;
    disbursedAt?: number;
    reason: string;
  }) => Promise<void>;
  onRecordSupplierReceipt: (
    receivableId: Id<"vehicleSupplierReceivables">,
    receipt: {
      amount: number;
      receiptMethod?: PaymentMethod;
      bankAccountId?: Id<"bankAccounts">;
      receiptReference?: string;
      receivedAt?: number;
      /**
       * SCRUM-57: REQUIRED. `supplierReceivables.recordReceipt` is an economic
       * command and refuses to run without a command identity, so the contract
       * that feeds it must not describe the identity as optional — the producer
       * below already mints one per receipt and holds it across retries.
       */
      idempotencyKey: string;
    },
  ) => Promise<void>;
}>;
