"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { scaleForCurrency } from "@/components/accounting/AccountingTabShared";

function safeScaleForCurrency(currency: string | null | undefined, fallback = 2): number {
  if (!currency) return fallback;
  try {
    return scaleForCurrency(currency);
  } catch {
    return fallback;
  }
}
import {
  DISBURSEMENT_DENOMINATION_REASON,
  FINALIZE_DENOMINATION_REASON,
  disbursementDenominationRefusal,
  finalizeDenominationRefusal,
} from "@/components/applications/settlementDenomination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/sonner";
import { getErrorMessage, getLocalizedErrorMessage, isConvexError } from "@/lib/errors";
import { isValid } from "date-fns";
import { formatLocalized } from "@/lib/dateLocale";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  Clock,
  Lock,
  Minus,
  Ban,
  FileText,
  Check,
  Copy,
  Wallet,
  Receipt,
  ClipboardCheck,
  History,
} from "lucide-react";
import { DealVehicleCard } from "./DealVehicleCard";
import { DealStageRail, DealStagesComplete } from "./DealStageRail";
import { orderStagesForDisplay } from "./dealStageDisplayOrder";
import { panelsForStage, type WorkbenchPanel } from "./dealWorkbenchPanels";
import { DealStageView } from "./DealStageView";
import { StageViewAnnouncer } from "./StageViewAnnouncer";
import { StagePosition } from "./StagePosition";
import {
  approvalReopenedReflected,
  approvedPurchaseReflected,
  creditStatusReflected,
  depositReleaseReflected,
  expectedPaymentReflected,
  financeDisbursementReflected,
  disbursementReturnReflected,
  handoverReflected,
  legalInvoiceReflected,
  nextOutstandingDocument,
  quotationReflected,
  reconciliationReflected,
  supplierDisbursementReflected,
  uploadReflected,
  useRecordedFeedback,
  verifyReflected,
  type RecordedFeedback,
  type RecordedModel,
  type RecordedTrackOptions,
} from "./recordedFeedback";
import { DealStepChecklist } from "./DealStepChecklistList";
import type { ClosingReadinessCheckKey } from "@/lib/closingReadinessReasonCodes";
import { deriveStepChecklist, type ChecklistDestination, type ChecklistItem } from "./dealStepChecklist";
import {
  resolveViewedStage,
  STAGE_PARAM,
  stageNotApplicableReasonKey,
  stageViewMode,
  type StageDeepLink,
} from "./dealStepView";
import { cn } from "@/lib/utils";
import {
  isFinishedStageState,
  isLiveStageState,
  STAGE_ICON,
  STAGE_STATE_KEY,
  type DealCockpitData,
  type DealStageState,
} from "./DealStagePresentation";
import { SupplierSettlementDialog } from "./SupplierSettlementDialog";
import { FcChequePanel } from "./FcChequePanel";
import { SettlementAdviceCorrectionDialog } from "./SettlementAdviceCorrectionDialog";
import {
  FinanceCompanyDecisionCard,
  nextFinanceDecisionStep,
  type FinanceDecisionDialog,
  type FinanceDecisionFacts,
} from "./FinanceCompanyDecisionCard";
import { ResolveReconciliationDialog } from "./ResolveReconciliationDialog";
import { ResolveGapDialog } from "./ResolveGapDialog";
import {
  RecordSubmittedQuotationDialog,
  toQuotationCalculation,
  type QuotationCalculation,
} from "./RecordSubmittedQuotationDialog";
import {
  ReopenApprovedPurchaseDialog,
} from "./ReopenApprovedPurchaseDialog";
import { ApplyQuoteFirstPaymentDialog } from "./ApplyQuoteFirstPaymentDialog";
import { ConfirmHandoverDialog } from "./ConfirmHandoverDialog";
import { ConfirmFinalizeDialog } from "./ConfirmFinalizeDialog";
import {
  RegisterExpectedPaymentDialog,
  type ExpectedPaymentMethod,
} from "../RegisterExpectedPaymentDialog";
import {
  RecordApprovedPurchaseDialog,
  type ApprovalBasis,
} from "./RecordApprovedPurchaseDialog";
import {
  RecordAppraisalDialog,
  type AppraisalProviderType,
} from "./RecordAppraisalDialog";
import { usePermissions } from "@/hooks/use-permissions";
import { DealPendingDepositRequests } from "@/components/deposits/DepositRequests";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { SETTLED_FINANCE_STATUSES } from "@/convex/utils/financeStatuses";
import type { PaymentMethod } from "@/components/payments/PaymentMethodSelect";
// The actions the Finance Applications → Review dialog used to own, moved here
// on the SAME mutations. Each is its own file so the container stays a wiring
// layer and the view stays renderable against fixtures.
import { CreditDecisionDialog, type CreditDecision } from "./CreditDecisionDialog";
import { CancelApplicationDialog, type CancelApplicationValues } from "./CancelApplicationDialog";
import { UnwindDealDialog, type UnwindFinishValues, type UnwindStatusView } from "./UnwindDealDialog";
import {
  SettlementRouteControl,
  type DirectRouteRefusal,
  type SupplierSettlementRoute,
} from "./SettlementRouteControl";
import { DealDocumentsPanel, type DealDocument, type DealDocumentHistoryItem } from "./DealDocumentsPanel";
import { SaleDialog } from "@/components/sales/SaleDialog";
import {
  StoppedDealDepositsPanel,
  type DealDeposit,
  type DepositResolution,
} from "./StoppedDealDepositsPanel";
import { DisbursementConfirmationDialog } from "../DisbursementConfirmationDialog";
import {
  RecordForwardToFinanceCompanyDialog,
  type ForwardPaymentValues,
} from "../RecordForwardToFinanceCompanyDialog";
import { ForwardCorrectionDialog, type ForwardCorrectionKind } from "../ForwardCorrectionDialog";
import { ChequeReturnedByBankDialog } from "../ChequeReturnedByBankDialog";
import { useCommandIdentity } from "@/hooks/useCommandIdentity";
import { usePendingDepositPayouts, type PendingPayout } from "@/hooks/usePendingDepositPayouts";
import { FinancingPlanPanel, type FinancingPlanFacts } from "./FinancingPlanPanel";
import {
  DealFinancialOverview,
  DealerPreparationSection,
  VehicleCostBasisSection,
  type FinancedDealOverviewData,
} from "./DealFinancialOverview";
import { DealCustodyPanel, type DealCustodyActions, type DealCustodyWiring } from "./DealCustodyPanel";
import { CustodyMovementsList } from "./CustodyMovementsList";
import {
  FEE_TYPE_LABEL,
  HandoverCostAttemptError,
  HandoverCostsPanel,
  type ExpectedHandoverRow,
  type ActualHandoverCost,
  type DirectHandoverPayment,
  type HandoverCostsData,
  type HandoverCostSource,
  type NewHandoverCost,
} from "./HandoverCostsPanel";
import { RecordLegalInvoiceDialog, type RecordLegalInvoiceValues } from "./RecordLegalInvoiceDialog";
import { DealClosingReadinessList, closingReasonText, type ClosingReadinessView } from "./DealClosingReadinessList";
import { useClosingReadiness } from "./useClosingReadiness";
import { closingReadinessRefusalOf } from "@/lib/closingReadinessReasonCodes";
import { ProfitApprovalNotice, useProfitApproval } from "@/components/sales/ProfitApprovalNotice";

/**
 * The financed-deal cockpit.
 *
 * Every figure on this screen comes from `applications.dealCockpit` already
 * derived and already classified. Nothing here computes money. That is not a
 * style preference: the headline `صافي ربح المعرض` is a MANAGEMENT figure built
 * on a spread that appears on no invoice, and a screen that could compute it
 * independently is a screen that could disagree with the ledger, or render the
 * number without the qualifier that makes it honest.
 *
 * Arabic RTL is the primary rendering. Logical properties (`ms-`/`me-`,
 * `text-start`) are used throughout rather than left/right, and each mixed
 * Arabic/Latin run — VIN, currency, references, timestamps — is isolated in its
 * own `<bdi>` so bidi reordering cannot scramble one into its neighbour.
 */

/**
 * Whether a stored moment can actually be formatted.
 *
 * `Number.isFinite` is NOT sufficient, which cost two review rounds to learn.
 * JavaScript's `Date` domain is ±8,640,000,000,000,000 ms, so `8640000000000001`,
 * `1e300` and `Number.MAX_VALUE` are all finite yet outside it — and date-fns
 * `format` throws `RangeError: Invalid time value` on every one of them. An
 * uncaught throw during render loses the WHOLE screen, not one row, which is the
 * defect class this cockpit has already been repaired for twice.
 *
 * Those values are reachable rather than theoretical: `z.number()` accepts any
 * finite number and Convex's `v.number()` stores it verbatim, so a corrupt row
 * arrives intact. SCRUM-45 tracks the same class in the posting path, where the
 * consequence is an aborted accounting drain rather than a lost screen.
 *
 * `isValid(new Date(v))` subsumes `undefined`, `NaN`, `±Infinity` and the
 * out-of-range case in one test. The `typeof` narrowing is load-bearing, not
 * decorative: neither `isValid` nor `Number.isFinite` is a type predicate, so
 * without it `format(entry.changedAt)` is a compile error on `number | undefined`.
 */
function isRenderableMoment(value: number | undefined): value is number {
  return typeof value === "number" && isValid(new Date(value));
}

/**
 * A stored moment as display text, or a calm dash when it cannot be one.
 *
 * The header's "last updated" and the essentials' "opened on" went straight to
 * `format()`, so the same `NaN` / `Infinity` / out-of-range row that the
 * timeline was already guarded against would still have lost the whole screen
 * through either of them. One helper for both, so neither can drift back.
 * The dash is language-neutral on purpose: it is the absence of a date, not a
 * status the operator has to act on, and the row it sits in is still readable.
 */
const MOMENT_UNAVAILABLE = "—";

function renderMoment(value: number | undefined, pattern: string, locale?: string): string {
  return isRenderableMoment(value) ? formatLocalized(value, pattern, locale) : MOMENT_UNAVAILABLE;
}

const STAGE_LABEL: Record<string, string> = {
  /** CASH only — the cash rail's anchor stage. */
  SALE_AGREED: "StageSaleAgreed",
  APPLICATION: "StageApplication",
  CREDIT_DECISION: "StageCreditDecision",
  APPRAISAL: "StageAppraisal",
  GAP_RESOLUTION: "StageGapResolution",
  APPROVED_PURCHASE: "StageApprovedPurchase",
  DELIVERY_ACTIONS: "StageDeliveryActions",
  /**
   * The stage the backend already emits and this build is the first to name.
   *
   * Until now the map had no entry, so the rail fell through to `t(rawKey)` —
   * covered only by a transitional dictionary entry under the raw key. This
   * entry is what makes that crutch unnecessary going forward; it is
   * deliberately NOT the signal to delete it — see the note on `DISBURSEMENT`
   * in `lib/i18n/domains/sales.ts`.
   */
  DISBURSEMENT: "StageDisbursement",
  HANDOVER: "StageHandover",
  SETTLEMENT: "StageSettlement",
};

/**
 * Who actually performed the appraisal on record, as the SERVER recorded it.
 * `null` means no active appraisal, or one recorded as a dealer estimate —
 * neither of the two parties a badge can truthfully name.
 */
export type ActiveAppraisalProvider = "FINANCE_COMPANY" | "INDEPENDENT" | null;

/**
 * Whose move a stage is — the single question the rail exists to answer.
 *
 * `authority` already travels on every stage: MIRROR means the finance company
 * acts and AutoFlow only records what they decided, DEALER means the dealership
 * acts. Rendering that verbatim is right for every stage but one.
 *
 * ⚠️ `APPRAISAL` is the exception, and getting it wrong is the defect this
 * function was written for. Its authority is MIRROR because the dealership never
 * values the vehicle itself — but the valuation may have been done by an
 * INDEPENDENT appraiser rather than by the finance company. Reading MIRROR as
 * "finance company" told the operator the deal was waiting on a party that was
 * not involved. The provider is therefore taken from RECORDED SERVER
 * PROVENANCE, never inferred from the stage's authority.
 *
 * An authority the client does not recognise names nobody rather than guessing:
 * a new server value must not silently render as "Dealership".
 */
function stageOwnerLabel(
  stage: Readonly<{ key: string; authority?: string }>,
  activeAppraisalProvider: ActiveAppraisalProvider,
  t: (key: string) => string
): string | undefined {
  if (stage.key === "APPRAISAL") {
    if (activeAppraisalProvider === "FINANCE_COMPANY") return t("AppraisalByFinanceCompany");
    if (activeAppraisalProvider === "INDEPENDENT") return t("AppraisalByIndependent");
    return t("StageOwnerAppraiserNotRecorded");
  }
  if (stage.authority === "MIRROR") return t("StageOwnerFinanceCompany");
  if (stage.authority === "DEALER") return t("StageOwnerDealership");
  return undefined;
}

/**
 * Whether the "this step belongs to the finance company" note is TRUE here.
 *
 * Gated by the same recorded provenance that drives the owner label, because
 * the two surfaces answer the same question and must not answer it from
 * different sources. `APPRAISAL` carries a static `authority: "MIRROR"`, so
 * keying the note on authority alone asserted the finance company owned an
 * appraisal an INDEPENDENT appraiser had performed — one step, two parties,
 * one screen. A `null` provider does not license the note either.
 */
function stageShowsMirrorNote(
  stage: Readonly<{ key: string; authority?: string }>,
  activeAppraisalProvider: ActiveAppraisalProvider
): boolean {
  if (stage.authority !== "MIRROR") return false;
  if (stage.key === "APPRAISAL") return activeAppraisalProvider === "FINANCE_COMPANY";
  return true;
}

const PARTY_LABEL: Record<string, string> = {
  CUSTOMER: "PartyCustomer",
  SUPPLIER: "PartySupplier",
  FINANCIER: "PartyFinancier",
};

const POSITION_LABEL: Record<string, string> = {
  DEALERSHIP_HOLDS: "PositionDealershipHolds",
  DEALERSHIP_OWES: "PositionDealershipOwes",
  OWED_TO_DEALERSHIP: "PositionOwedToDealership",
  SETTLED: "PositionSettled",
  NOT_INVOLVED: "PositionNotInvolved",
  UNKNOWN: "PositionUnknown",
};

/**
 * The workflow enum is not user-facing copy. Rendered raw, the badge said
 * "APPROVED" and the timeline said "PENDING_DOCS" on an otherwise fully Arabic
 * screen — visible the moment it was rendered, and invisible to every test.
 */
const STATUS_LABEL: Record<string, string> = {
  /** CASH only — `sales.status`, a different enum from the application's. */
  PENDING: "SaleStatusPending",
  COMPLETED: "SaleStatusCompleted",
  DRAFT: "Draft",
  PENDING_DOCS: "PendingDocs",
  UNDER_REVIEW: "UnderReview",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

/**
 * The header badge's words. Every application is created PENDING_DOCS, so on a
 * deal the server proved needs no document (DELIVERY_ACTIONS NOT_APPLICABLE) it
 * read "pending documents" for documents that do not exist (SCRUM-629 F-08).
 * Display only: the stored status and its transitions are unchanged.
 */
export function dealStatusBadgeKey(
  status: string,
  stages: ReadonlyArray<Readonly<{ key: string; state: string }>>
): string {
  if (
    status === "PENDING_DOCS" &&
    stages.some((stage) => stage.key === "DELIVERY_ACTIONS" && stage.state === "NOT_APPLICABLE")
  ) {
    return "AppStatusSubmitted";
  }
  return STATUS_LABEL[status] ?? status;
}

/**
 * Whether the DELIVERY_ACTIONS stage still has a required document outstanding.
 * No stage (no payload yet) and a NOT_APPLICABLE stage (no required rule,
 * SCRUM-629 F-07) have none; any other state short of COMPLETE does.
 */
export function documentsOutstanding(deliveryStageState: string | undefined): boolean {
  return (
    deliveryStageState !== undefined &&
    deliveryStageState !== "COMPLETE" &&
    deliveryStageState !== "NOT_APPLICABLE"
  );
}

const PROFIT_LINE_LABEL: Record<string, string> = {
  APPROVED_PURCHASE: "LineApprovedPurchase",
  /** PLANNED — `resolveAppraisalGap`'s allocation, never a receipt. The label says so. */
  CUSTOMER_PLANNED_TO_DEALER: "LineCustomerPlannedToDealer",
  SUPPLIER_SETTLEMENT: "LineSupplierSettlement",
  DEALER_CONTRIBUTION: "LineDealerContribution",
  ACTUAL_EXPENSES: "LineActualExpenses",
  FORECAST_EXPENSES: "LineForecastExpenses",
  PREPARATION_EXPENSES: "LinePreparationExpenses",
  /** CASH only. A different derivation, so deliberately different keys. */
  SALE_PRICE: "LineSalePrice",
  VEHICLE_COST: "LineVehicleCost",
  SUPPLIER_ENTITLEMENT: "LineSupplierEntitlement",
};

/**
 * Keyed by the reason itself rather than tested with a ternary, which had two
 * branches for what is now three reasons and would have labelled a missing
 * dealer contribution as a missing supplier settlement. Typed against the
 * union, so adding a fourth reason fails the build instead of silently
 * inheriting whichever branch happened to be the `else`.
 */
const PROFIT_BLOCKED_REASON: Record<
  "NoApprovedPurchaseAmount"
  | "NoSupplierSettlement"
  | "NoDealerContribution"
  /** STOCK only: the dealership's own car carries no cost basis to measure against. */
  | "NoVehicleCost"
  /** SOURCED only: the dealership's preparation spend on the supplier's car cannot be stated. */
  | "PreparationExpensesUnreadable"
  /** A dealer-borne cost line is in another currency: the cost operand would be partial. */
  | "ExpensesMixedDenomination"
  /** A cost line's amount is not a safe non-negative integer, or the lines overflow: the cost operand is not a figure. */
  | "ExpensesUnreadable"
  /** F-PNTR-1: which recorded cost is the finance company's execution fee is unclear, or the frozen total disagrees with it. */
  | "ExecutionFeeUnclassified"
  | "CorruptInput"
  | "DealCancelled"
  /** CASH only: `dealershipMargin === null`, which is UNKNOWN and never zero. */
  | "UnknownMargin"
  /** CASH only: a draft has posted no journal, so nothing is postable yet. */
  | "SaleNotCompleted"
  /** Financed + DIRECT with no application: the recorded margin cannot be trusted. */
  | "FinancedDirectUnverified",
  string
> = {
  NoApprovedPurchaseAmount: "ProfitNeedsApprovedPurchase",
  NoSupplierSettlement: "ProfitNeedsSupplierSettlement",
  NoDealerContribution: "ProfitNeedsDealerContribution",
  NoVehicleCost: "ProfitNeedsVehicleCost",
  PreparationExpensesUnreadable: "ProfitPreparationUnreadable",
  ExpensesMixedDenomination: "ProfitExpensesMixedDenomination",
  ExpensesUnreadable: "ProfitExpensesUnreadable",
  ExecutionFeeUnclassified: "ProfitExecutionFeeUnclassified",
  CorruptInput: "ProfitInputCorrupt",
  DealCancelled: "ProfitDealCancelled",
  UnknownMargin: "ProfitUnknownMargin",
  SaleNotCompleted: "ProfitSaleNotCompleted",
  FinancedDirectUnverified: "ProfitFinancedDirectUnverified",
};

/** The same labels the legal-invoice dialog offers, so the record reads as it was entered. */
const LEGAL_INVOICE_ISSUED_TO_LABEL: Record<string, string> = {
  FINANCE_COMPANY: "PartyFinancier",
  CUSTOMER: "Customer",
  OTHER: "Other",
};

/**
 * Why the close cannot be taken — and it takes BOTH conditions, because the
 * two interact rather than merely coexisting.
 *
 * `setSupplierSettlementRoute` requires `manage:supplier_settlement`, and the
 * review dialog hides its selector without it. So telling a caller who lacks
 * that permission to "record the route" sends them to a screen with nothing
 * on it — the dead end this issue exists to remove, rebuilt out of two correct
 * sentences.
 *
 * Since SCRUM-407 the close itself is an accountant's act
 * (`confirm:finance_disbursement`), so the two permissions are no longer the
 * same one: the route is judged on who may RECORD it, the close on who may
 * CLOSE, each against the server's own gate.
 *
 * A loaded closing-readiness verdict that is not READY is a prerequisite too:
 * `finalizeDeal` re-runs the same evaluator and would refuse, so the action is
 * withheld and the readiness list above names what is left.
 *
 * A readiness READ that failed withholds it as well (S414-R2-SKEW-1): most
 * often that is a backend deployed before `getClosingReadiness`, and such a
 * backend's `finalizeDeal` predates the redacted refusals — its currency-drift
 * refusal names both currencies to a caller who may close but not read money.
 * The close is offered only once a verdict has LOADED; a read still in flight
 * is handled by the caller, which keeps the step at its blocker meanwhile.
 *
 * A caller who may close but may not READ the readiness has no verdict at all
 * — the query is skipped — so the close is withheld from them too (S414-R3-1,
 * Option A), named last: the route and the close permission are the more
 * useful things to say when they also apply. Every default role holding
 * `confirm:finance_disbursement` holds `view:finance_applications`, so this
 * reaches only custom roles, and tells them which access is missing.
 *
 * Extracted rather than left as a nested ternary so the combinations are
 * enumerable, and testable, one line each.
 */
function finalizeUnavailableReasonKey({
  routeRequired,
  canRecordRoute,
  heldDepositBlocksDirectClose,
  readinessBlocksClose,
  readinessUnreadable,
  canClose,
  canReadReadiness,
}: Readonly<{
  routeRequired: boolean;
  canRecordRoute: boolean;
  /**
   * `finalizeDeal` refuses a DIRECT_TO_SUPPLIER deal whose quote still holds a
   * reservation deposit (SCRUM-417, G7) — the same refusal
   * `setSupplierSettlementRoute` makes, by the other door.
   */
  heldDepositBlocksDirectClose: boolean;
  readinessBlocksClose: boolean;
  readinessUnreadable: boolean;
  canClose: boolean;
  canReadReadiness: boolean;
}>): string | undefined {
  if (routeRequired && !canRecordRoute) return "FinalizeNeedsRouteAndPermission";
  if (routeRequired) return "FinalizeNeedsSettlementRoute";
  if (heldDepositBlocksDirectClose) return "FinalizeNeedsHeldDepositResolved";
  if (readinessUnreadable) return "FinalizeWaitsForReadiness";
  if (readinessBlocksClose) return "FinalizeNeedsClosingReadiness";
  if (!canClose) return "FinalizeNeedsPermission";
  if (!canReadReadiness) return "FinalizeNeedsReadinessAccess";
  return undefined;
}

/**
 * Why an already-open close confirmation may not be submitted — or `undefined`
 * when the cockpit holds a loaded, open READY verdict (S414-R3-1).
 *
 * The dialog outlives the verdict it was opened on: a read that fails, or a
 * verdict that turns BLOCKED, must stop the submit rather than let an older
 * backend's detailed refusal through. Mirrors `finalizeAllowedByReadiness`.
 */
function finalizeReadinessHoldReasonKey({
  canReadReadiness,
  readiness,
  readinessUnreadable,
}: Readonly<{
  canReadReadiness: boolean;
  readiness: { open: boolean; state: string } | undefined;
  readinessUnreadable: boolean;
}>): string | undefined {
  if (!canReadReadiness) return "FinalizeNeedsReadinessAccess";
  if (readinessUnreadable || readiness === undefined || !readiness.open) return "FinalizeWaitsForReadiness";
  if (readiness.state !== "READY") return "FinalizeNeedsClosingReadiness";
  return undefined;
}

/**
 * What a focus-row step opens when the dialog or pane it needs is owned by the
 * VIEW rather than the container (SCRUM-417). The view resolves it to its own
 * handler, so the focus row reuses the exact dialog the card or panel opens —
 * never a second copy of it.
 */
export type WorkflowActionTarget = FinanceDecisionDialog | "DOCUMENTS" | "SETTLE_SUPPLIER";

/** The one next step for the stage the rail names — see `DealCockpitView`. */
export type WorkflowAction = {
  stageKey: string;
  /** i18n key for the button label — never a raw string. */
  actionKey: string;
  /** Absent when `opens` names a view-owned target instead. */
  onStart?: () => void;
  opens?: WorkflowActionTarget;
  /** A sentence under the step saying why THIS is the next step. */
  noteKey?: string;
  /** A quieter alternative on the same step, where one must be preserved. */
  secondary?: { actionKey: string; onStart: () => void };
  /** Set when the step cannot be taken; the button is withheld and this is shown. */
  unavailableReasonKey?: string;
  /** The withheld figure in its own currency, shown under the reason. */
  unavailableDetail?: SettlementDenominationDetail;
  /**
   * Where the blocker is resolved, when that is another EXISTING page (SCRUM-417
   * UX1, S4). Set by the container only for a caller who can act there; the step
   * shows it under the reason.
   */
  unavailableLink?: { href: string; labelKey: string };
  /**
   * Said instead of the link to a caller who cannot act at that destination:
   * names who does (never a dead end, never a link to a refusal).
   */
  unavailableNoteKey?: string;
};

/**
 * The cash rail's one next step per live stage (SCRUM-417, G8) — see
 * `SaleDealCockpit`. A stage absent here offers no step. HANDOVER is not here:
 * it opens the sale's own dialog, which needs this screen's state (W3).
 */
/** The read-only checklist's upload state: nothing is ever in flight there. */
const NO_UPLOADS: ReadonlySet<string> = new Set();

const CASH_STAGE_ACTION: Readonly<Partial<Record<string, WorkflowAction>>> = {
  SETTLEMENT: { stageKey: "SETTLEMENT", actionKey: "SettleSupplierAction", opens: "SETTLE_SUPPLIER" },
};

/**
 * Whether THIS caller can advance the documents step, and if not, why
 * (SCRUM-417 round 1: Sol W1 = Codex S417-2).
 *
 * Keyed on the outstanding REQUIRED documents' own statuses and the server's
 * own gates, never on the step existing:
 *  - MISSING / REJECTED — uploaded (or replaced) through `generateUploadUrl` +
 *    `saveDocumentFile`, which take `create:finance_application` OR
 *    `verify:finance_documents`;
 *  - UPLOADED — moved only by `updateDocumentStatus` (verify or reject), which
 *    takes `verify:finance_documents`.
 *
 * The step is a working button when at least one outstanding document can be
 * advanced by this caller. Otherwise the reason says which: everything is
 * uploaded and waiting for a verifier, or this caller can touch no document
 * at all. `outstanding` empty with the step still open means the rail and the
 * checklist disagree; the capability alone decides, as it did before.
 *
 * Round 2 (Codex S417-R2-1 = Sol R2-1): the controls live on the rows
 * `documents.getForApplication` serves, and that read takes
 * `view:finance_applications` — a separate permission a custom role can omit.
 * Without it the pane is the read-only checklist, so a caller who COULD
 * advance a document is told the read is what is missing (`canRead`), on both
 * stages. The write reasons outrank it: they would stand even with the read.
 */
export function documentsStepUnavailableReason({
  outstanding,
  canUpload,
  canVerify,
  canRead,
  settled,
}: Readonly<{
  outstanding: ReadonlyArray<{ status: string }>;
  canUpload: boolean;
  canVerify: boolean;
  canRead: boolean;
  /** SCRUM-422: CLOSED or CANCELLED — the server refuses every document write. */
  settled: boolean;
}>): string | undefined {
  if (settled) return "DocumentsSettled";
  const canAdvance = (status: string) => (status === "UPLOADED" ? canVerify : canUpload || canVerify);
  const readReason = canRead ? undefined : "DocumentsNeedReadAccess";
  if (outstanding.length === 0) return canUpload || canVerify ? readReason : "DocumentsNeedUploader";
  if (outstanding.some((doc) => canAdvance(doc.status))) return readReason;
  // Nothing this caller can move. Someone who may upload is only stopped when
  // every outstanding document is already uploaded: it waits on a verifier.
  return canUpload ? "DocumentsAwaitVerifier" : "DocumentsNeedUploader";
}

/** The toast for each credit-stage transition this screen can record. */
const CREDIT_STATUS_SUCCESS: Record<"PENDING_DOCS" | "UNDER_REVIEW" | "APPROVED" | "REJECTED", string> = {
  PENDING_DOCS: "AppSubmittedForDocumentsSuccess",
  UNDER_REVIEW: "AppUnderReviewSuccess",
  APPROVED: "AppApprovedSuccess",
  REJECTED: "AppRejectedSuccess",
};

/**
 * Why a DISBURSEMENT confirmation is not offered: the permission case names a
 * person, the not-applicable case names a fact about the deal. Enumerable
 * rather than a nested ternary, so the three outcomes read one per line.
 */
function disbursementUnavailableReason(
  available: boolean,
  hasPermission: boolean,
  notApplicableKey: string
): string | undefined {
  if (available) return undefined;
  if (hasPermission) return notApplicableKey;
  return "DisbursementNeedsPermission";
}

/** The recorded figure or currency, beside the org's current currency. */
export type SettlementDenominationDetail = {
  recordedLabel: string;
  recordedAmount: string;
  orgLabel: string;
  orgCurrency: string;
};

/**
 * "Recorded settlement: 15,625 USD · Organisation currency: JOD", with each
 * money run isolated LTR so an RTL paragraph cannot reorder "15,625 USD" into
 * "USD 15,625".
 */
export function SettlementDenominationLine({
  detail,
}: Readonly<{ detail: SettlementDenominationDetail }>) {
  return (
    <p className="text-sm" data-testid="settlement-denomination-detail">
      {detail.recordedLabel}: <bdi dir="ltr">{detail.recordedAmount}</bdi> · {detail.orgLabel}:{" "}
      <bdi dir="ltr">{detail.orgCurrency}</bdi>
    </p>
  );
}

/** A money run is Latin digits inside Arabic prose; `<bdi>` keeps it whole. */
function Money({ children }: Readonly<{ children: React.ReactNode }>) {
  return <bdi className="tabular-nums">{children}</bdi>;
}

/**
 * The record's full opaque id with a copy control (SCRUM-372). Shown whole so
 * an operator can quote it to support; long ids wrap rather than truncate.
 * A clipboard the browser refuses is not an error worth a toast — the id is
 * still on screen to select by hand.
 */
function CopyableReference({ value, t }: Readonly<{ value: string; t: (key: string) => string }>) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error(error);
    }
  };
  return (
    <>
      <bdi dir="ltr" className="min-w-0 break-all font-mono text-xs">
        {value}
      </bdi>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={copy}
        aria-label={t(copied ? "DealReferenceCopied" : "CopyDealReference")}
        data-testid="deal-reference-copy"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-profit-positive" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? t("DealReferenceCopied") : ""}
      </span>
    </>
  );
}

/**
 * One deal, whichever way it was paid for.
 *
 * A union of the two queries rather than a widened single type, because the two
 * genuinely differ: a financed deal is keyed on an application that may not have
 * a sale yet, and a cash deal is keyed on a sale that has no application at all.
 * `dealKind` is the discriminant.
 *
 * Everything the SPINE renders — the stage rail, the parties, the vehicle,
 * the timeline — is common to both and rendered by the same code below. The one
 * thing that must not be shared is the headline: see `MoneyPanel`.
 */
export type { DealCockpitData } from "./DealStagePresentation";

/**
 * The data half: one query, one mutation, no presentation.
 *
 * Split from the view so the screen can be rendered against server-shaped
 * fixtures — the RTL and bidi behaviour is only checkable on rendered output,
 * and a component welded to `useQuery` can only be checked against whatever
 * happens to be in a deployment.
 */
export function DealCockpit({
  orgId,
  applicationId,
  canonicalizeUrl = true,
  stageDeepLink,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  /** The `?stage=` deep link, owned by the route (SCRUM-417 UX4, O3). View selection only. */
  stageDeepLink?: StageDeepLink;
  /**
   * Whether this instance owns the address bar and may correct it.
   *
   * A deal gets ONE canonical identity, and once a sale exists that identity is
   * the SALE — so the application-keyed URL sends the operator to
   * `/sales/{saleId}/deal` rather than becoming a second permanent home for the
   * same deal.
   *
   * `false` when the sale-keyed route is already showing this deal and has
   * delegated the financed wiring here. Without that, the two routes would
   * canonicalize into each other: the sale URL renders this component, which
   * would redirect to the sale URL, forever. Expressed as ownership rather than
   * as "don't redirect" because the question is which component is responsible
   * for the URL, and only one ever is.
   */
  canonicalizeUrl?: boolean;
}>) {
  /**
   * The financed read model, served by the `dealWorkspace` wrapper rather than
   * by `applications.dealCockpit` directly.
   *
   * The wrapper composes that same authority through `ctx.runQuery` — one query
   * for the client, one read snapshot — and adds the two facts this screen
   * could not previously answer: who actually appraised the vehicle, and
   * whether a stopped deal is still sitting on the customer's money. Nothing
   * about the spine changed, which is why the cash rail below still calls
   * `sales.dealCockpit` and renders through the same view.
   */
  const deal = useQuery(api.dealWorkspace.financedDealCockpit, { orgId, applicationId });
  // The container raises its own toasts, so it needs its own translator — the
  // view's `t` is not in scope here, and an English string in a toast is how a
  // screen that is otherwise fully Arabic starts leaking its source language.
  const { t, locale } = useLanguage();
  const recordReceipt = useMutation(api.supplierReceivables.recordReceipt);
  const amendAdvice = useMutation(api.applications.amendSupplierDisbursementAdvice);
  const recordSubmittedQuotation = useMutation(api.financingEconomics.recordSubmittedQuotation);
  const reopenApproval = useMutation(api.financingEconomics.reopenApproval);
  const applyQuoteFirstPayment = useMutation(api.financingEconomics.applyQuoteFirstPayment);
  const registerVehicleHandover = useMutation(api.applications.registerVehicleHandover);
  const resolveAppraisalGap = useMutation(api.financingEconomics.resolveAppraisalGap);
  const registerExpectedPayment = useMutation(api.applications.registerExpectedPayment);
  const correctExpectedPayment = useMutation(api.applications.correctExpectedPayment);
  const attestChequeFace = useMutation(api.applications.attestChequeFace);
  const finalizeDeal = useMutation(api.applications.finalizeDeal);
  const approveDealerPurchaseAmount = useMutation(
    api.financingEconomics.approveDealerPurchaseAmount
  );
  const recordAppraisal = useMutation(api.financingEconomics.recordAppraisal);
  const resolveFinancingReconciliation = useMutation(
    api.financingEconomics.resolveFinancingReconciliation
  );
  const { hasPermission, isLoading: permissionsLoading, membership, isOwner } = usePermissions();
  const router = useRouter();

  /**
   * The economics read, and why it is a SEPARATE query from the cockpit's.
   *
   * `applications.dealCockpit` gates its whole money block behind `view:finance`,
   * which the default MANAGER template does not hold — and MANAGER is precisely
   * the role holding `approve:finance_application`. Reading these figures out of
   * the money block would therefore have hidden the recorder from the only role
   * allowed to use it. `getEconomics` authorizes on `view:finance_applications`,
   * applies its own redaction, and is the query that already owns these fields,
   * so nothing here becomes a second source of truth for them.
   *
   * Skipped rather than called-and-caught when the caller lacks that permission
   * or the deal is not readable: `getEconomics` THROWS for an application it
   * will not serve, and an uncaught throw from `useQuery` during render loses
   * the whole screen — a caller with `view:sales` on a custom role would have
   * white-screened the cockpit instead of merely not seeing this card.
   */
  const canViewApplications = !permissionsLoading && hasPermission(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
  const economics = useQuery(
    api.financingEconomics.getEconomics,
    canViewApplications && deal ? { orgId, applicationId } : "skip"
  );
  const economicsApp = economics?.application ?? null;

  /**
   * The calculator, mounted wherever the quotation action can actually be
   * offered — which includes RE-recording one that already exists.
   *
   * Not narrowed to "no quotation yet". A re-record with the calculator absent
   * is labelled `MANUAL_ENTRY` whatever the operator types, so skipping the
   * query on the second visit would quietly downgrade the provenance of a
   * figure the solver could have confirmed.
   *
   * Still skipped for a caller who cannot record and for a deal nobody can
   * change: it is a real query with real reads, and running it for every role
   * on every view would be paying for a suggestion nobody was going to see.
   */
  /**
   * Whether the approved amount is on the record — from the STAGE RAIL, which
   * the server derives from the unredacted row.
   *
   * Read here as well as in the card, and for the same reason: the amount field
   * is blank both when nothing was recorded and when this caller may not see
   * it, so testing the field would have mounted the calculator for a
   * salesperson on a deal that is already approved.
   */
  const approvedPurchaseRecorded =
    deal?.stages.find((stage) => stage.key === "APPROVED_PURCHASE")?.state === "COMPLETE";

  const canOfferQuotation =
    economicsApp !== null &&
    economicsApp.status !== "CLOSED" &&
    economicsApp.status !== "CANCELLED" &&
    // Once an approval exists the server refuses to move the figure it was
    // based on, so the action is not offered and the calculator is not needed.
    !approvedPurchaseRecorded &&
    hasPermission(PERMISSIONS.CREATE_FINANCE_APPLICATION);

  /**
   * The company's purchase LTV is KNOWN to be missing — as opposed to merely
   * unknown here.
   *
   * `recordSubmittedQuotation` throws without one, so the action is certain to
   * be refused and the card says which setting to fix instead of offering it.
   * A legacy application carries no rule snapshot at all and the server falls
   * back to the live company row for those, so "no snapshot" must not be read
   * as "no LTV" and block an action that would have worked.
   *
   * This is about the MUTATION. The query no longer throws for it — see
   * `suggestQuotationForApplication`, which now reports an unresolvable rule as
   * an unavailable calculation, because a Convex throw reaching `useQuery`
   * during render loses the whole screen. That is how this was found: rendering
   * against a company created through the settings form, which never asked for
   * the field.
   */
  /**
   * ASKED, not derived (SCRUM-117).
   *
   * This read `companyRuleSnapshot` and `appliedLtvPercent` off the economics
   * row and compared them here. Both are finance-gated now, so a caller without
   * `view:finance` computed "the rate is present" from two blanks and was shown
   * no rate field and no guidance — then the server refused the quotation. The
   * server answers the question it already owns and publishes a boolean that
   * names no rate; the screen stops holding a second opinion.
   */
  const ltvMissing = economics?.requiresLtvPercent === true;
  const suggestion = useQuery(
    api.financingEconomics.suggestQuotationForApplication,
    canOfferQuotation ? { orgId, applicationId } : "skip"
  );

  /**
   * Once the application has become a sale, the sale owns the deal's identity.
   *
   * `canonicalSaleId`, NOT `saleId`. The server validates that the sale is
   * actually readable before offering it as a destination: `finalizedSaleId`
   * survives `sales.softDelete`, and redirecting to a deleted sale would trade a
   * screen that renders for one that reports the sale does not exist — stranding
   * the settlement notifications that deep-link to this application URL. The
   * client cannot see `isDeleted`, so this decision is not the client's to make.
   */
  const finalizedSaleId = canonicalizeUrl ? (deal?.canonicalSaleId ?? null) : null;
  // The step being looked at travels with the redirect: a `?stage=` deep link
  // opened on the application URL must not be dropped on its way to the sale.
  const carriedStage = stageDeepLink?.value ?? null;
  useEffect(() => {
    if (finalizedSaleId) {
      const query = carriedStage ? `?${STAGE_PARAM}=${encodeURIComponent(carriedStage)}` : "";
      router.replace(`/${orgId}/sales/${finalizedSaleId}/deal${query}`);
    }
  }, [finalizedSaleId, orgId, router, carriedStage]);

  // Hidden while the membership is still loading rather than shown optimistically:
  // an action that appears and then vanishes reads as a bug, and the server is
  // the authority either way.
  const canCorrectAdvice = !permissionsLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE);
  // SCRUM-447 B2: registering the payment is a separate permission the server
  // also accepts on a closed, undisbursed deal alongside MANAGE_FINANCE.
  const canRegisterPayment =
    !permissionsLoading && hasPermission(PERMISSIONS.REGISTER_EXPECTED_PAYMENT);
  // `supplierReceivables.recordReceipt` requires the same permission. Fails
  // closed while loading, and is never inferred from a role name or from
  // VIEW_FINANCE — a custom role that can read the money block cannot settle.
  const canSettleSupplier = !permissionsLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE);

  /**
   * ---- The facts and commands the Review dialog used to own ----------------
   *
   * `applications.get` is the query that dialog reads, authorized on the same
   * `view:sales` as the cockpit query, so nothing here widens who may see what.
   * It carries the workflow facts the stage rail does not: the recorded
   * settlement route and whether the direct route is available, the
   * disbursement evidence, the deal's deposits, and the pinned economics
   * currency the disbursement figures are denominated in. `documents.getForApplication`
   * requires `view:finance_applications` and THROWS otherwise, so it is
   * skipped for a caller without it — the same discipline as `getEconomics`.
   *
   * Every mutation below is the one the Review dialog calls. The caller moved;
   * the authority did not. No new economic command exists on this screen.
   */
  const app = useQuery(api.applications.get, { orgId, applicationId });
  const documents = useQuery(
    api.documents.getForApplication,
    canViewApplications && deal ? { orgId, applicationId } : "skip"
  );
  // Round 3 (S417-R3-1): files kept for requirements removed after the upload,
  // view only — the same permission and the same skip as the active list.
  const documentHistory = useQuery(
    api.documents.getHistoryForApplication,
    canViewApplications && deal ? { orgId, applicationId } : "skip"
  );
  // The deal's cost lines, same permission as the document rows; skipped rather
  // than thrown for a caller without it.
  const dealCosts = useQuery(
    api.financeDealCosts.listDealCosts,
    canViewApplications && deal ? { orgId, applicationId } : "skip"
  );
  // SCRUM-417 UX5 (S7). A step's success is held until the read model shows the
  // fact THAT action wrote (each call site names it: `reflectedWhen`), then shown
  // as one persistent "Recorded. Next: ..." line. An action with no observable
  // fact of its own says so at once, as the toast. Declared here -- before the
  // early return below -- because it is a hook, and its handlers are lower down.
  const recordedModel: RecordedModel | null = deal
    ? { deal, documents, application: app, economics: economicsApp, costs: dealCosts }
    : null;
  const {
    recorded: recordedFeedback,
    track: trackRecorded,
    clear: clearRecorded,
  } = useRecordedFeedback(recordedModel, (fallbackKey) => toast.success(t(fallbackKey)), String(applicationId));
  // The custody picker's own read, shaped for the money permission — see
  // `listCustodyCandidates`. Mounted on EXACTLY the predicate that offers the
  // custody commands below (`custodyCommandsOffered`), so the plan and issue
  // dialogs can never render with a picker whose read was skipped
  // (consolidated round, item 5); skipped for everyone else, so the cockpit
  // never mounts a query its caller cannot pass. Custody is a fact of a
  // FINANCE APPLICATION — the record is keyed on one — and this container
  // is the financed cockpit, so `deal` here is always the financed kind.
  const custodyCommandsOffered =
    !permissionsLoading && hasPermission(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT) && deal !== undefined && deal !== null;
  const custodyCandidates = useQuery(
    api.financeDealCosts.listCustodyCandidates,
    custodyCommandsOffered ? { orgId } : "skip"
  );
  /**
   * The financial overview — a sibling read model composed on the server from
   * the cockpit's own money payload plus the vehicle's pre-deal cost basis.
   * Gated by the same permission the cockpit itself takes (view:sales); the
   * server withholds each half by its own permission (view:finance,
   * view:cost_price) and returns null for it, never a zero.
   */
  const overview = useQuery(api.dealOverview.financedDealOverview, deal ? { orgId, applicationId } : "skip");
  const recordDealFee = useMutation(api.financeDealCosts.recordDealFee);
  const recordTemplateFeeActual = useMutation(api.financeDealCosts.recordTemplateFeeActual);
  const recordExecutionFeeActual = useMutation(api.financeDealCosts.recordExecutionFeeActual);
  const bindExecutionFeeLine = useMutation(api.financeDealCosts.bindExecutionFeeLine);
  const unbindExecutionFeeLine = useMutation(api.financeDealCosts.unbindExecutionFeeLine);
  const recordActualFeeAmount = useMutation(api.financeDealCosts.recordActualFeeAmount);
  const recordDirectFeePayment = useMutation(api.financeDealCosts.recordDirectFeePayment);
  const voidDealFee = useMutation(api.financeDealCosts.voidDealFee);
  const reconcileDealFee = useMutation(api.financeDealCosts.reconcileDealFee);
  const recordLegalInvoice = useMutation(api.financeDealCosts.recordLegalInvoice);
  // The deal's automatic closing readiness (SCRUM-407) — the same evaluator
  // `finalizeDeal` re-runs, so the panel previews the server's verdict. Same
  // read permission as the cost record; the server redacts the detail below
  // the finance tier itself. Read without throwing: a backend deployed before
  // this query existed costs the panel its verdict, not the screen its life
  // (SCRUM-414 Codex R2).
  const { readiness: closingReadiness, serviceUnavailable: closingReadinessServiceUnavailable } = useClosingReadiness(
    canViewApplications && deal ? { orgId, applicationId } : "skip"
  );
  /**
   * The ONE readiness condition the close is offered AND submitted under
   * (S414-R2-SKEW-1, S414-R3-1): a successfully loaded, open READY verdict. A
   * skipped, loading, failed, closed, BLOCKED or UNAVAILABLE read withholds it,
   * so an older backend's detailed refusal never reaches a caller without
   * money-read authority through this screen. The server re-checks regardless.
   */
  const finalizeReadinessHoldKey = finalizeReadinessHoldReasonKey({
    canReadReadiness: canViewApplications,
    readiness: closingReadiness,
    readinessUnreadable: closingReadinessServiceUnavailable,
  });
  const finalizeAllowedByReadiness = finalizeReadinessHoldKey === undefined;
  const planCustodyHandler = useMutation(api.financeDealCosts.planCustodyHandler);
  const openDealCustody = useMutation(api.financeDealCosts.openDealCustody);
  const recordCustodyMovement = useMutation(api.financeDealCosts.recordCustodyMovement);
  const setFeeCustody = useMutation(api.financeDealCosts.setFeeCustody);
  const reconcileDealCustody = useMutation(api.financeDealCosts.reconcileDealCustody);
  const reopenDealCustody = useMutation(api.financeDealCosts.reopenDealCustody);
  const updateStatus = useMutation(api.applications.updateStatus);
  const cancelApplication = useMutation(api.applications.cancelApplication);
  const startDealUnwind = useMutation(api.dealUnwind.startDealUnwind);
  const recordDealUnwindForwardReturn = useMutation(api.dealUnwind.recordDealUnwindForwardReturn);
  const finishDealUnwind = useMutation(api.dealUnwind.finishDealUnwind);
  const abandonDealUnwind = useMutation(api.dealUnwind.abandonDealUnwind);
  const confirmDisbursement = useMutation(api.applications.confirmDisbursement);
  const recordFinanceCompanyForward = useMutation(api.financeCompanyForward.recordFinanceCompanyForward);
  const reverseFinanceCompanyForward = useMutation(api.financeCompanyForward.reverseFinanceCompanyForward);
  const reportFinanceCompanyForwardReturned = useMutation(
    api.financeCompanyForward.reportFinanceCompanyForwardReturned
  );
  const confirmSupplierDisbursement = useMutation(api.applications.confirmSupplierDisbursement);
  const returnFinanceDisbursementCheque = useMutation(api.applications.returnFinanceDisbursementCheque);
  const setSupplierSettlementRoute = useMutation(api.applications.setSupplierSettlementRoute);
  const releaseDeposit = useMutation(api.deposits.release);
  const updateDocStatus = useMutation(api.documents.updateDocumentStatus);
  const ensureApplicationDocument = useMutation(api.documents.ensureApplicationDocument);
  const generateUploadUrl = useMutation(api.documents.generateUploadUrl);
  const saveDocumentFile = useMutation(api.documents.saveDocumentFile);
  const orgCurrency = useCurrency();
  const currencyMarker = (cur: string) => {
    if (cur === orgCurrency.code) {
      if (locale === "ar") {
        return orgCurrency.symbol ?? (cur === "JOD" ? "د.أ" : orgCurrency.displayLabel);
      }
      return orgCurrency.displayLabel;
    }
    return cur;
  };

  const canReviewApplication = !permissionsLoading && hasPermission(PERMISSIONS.REVIEW_FINANCE_APPLICATION);
  const canApproveApplication = !permissionsLoading && hasPermission(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
  const canCreateApplication = !permissionsLoading && hasPermission(PERMISSIONS.CREATE_FINANCE_APPLICATION);
  // SCRUM-413: recording the settlement route and cancelling a CLOSED deal are
  // each their own server-side authority (the retired finalize permission no
  // longer gates either); closing the deal itself is a third — see
  // `canCloseDeal` below.
  const canRecordSupplierRoute = !permissionsLoading && hasPermission(PERMISSIONS.MANAGE_SUPPLIER_SETTLEMENT);
  const canCancelClosedDeal = !permissionsLoading && hasPermission(PERMISSIONS.CANCEL_CLOSED_DEAL);
  const canVerifyDocuments = !permissionsLoading && hasPermission(PERMISSIONS.VERIFY_FINANCE_DOCUMENTS);
  const documentsSettled = deal != null && SETTLED_FINANCE_STATUSES.includes(deal.status);
  const canConfirmFinanceDisbursement =
    !permissionsLoading && hasPermission(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
  const canResolveDeposits = !permissionsLoading && hasPermission(PERMISSIONS.APPROVE_REQUESTS);
  // SCRUM-407 owner ruling: finalizing a financed deal is for accountants only.
  // Mirrors `finalizeDeal`, which requires `confirm:finance_disbursement`.
  const canCloseDeal = canConfirmFinanceDisbursement;

  const [recordingLegalInvoice, setRecordingLegalInvoice] = useState(false);
  const [legalInvoiceSubmitting, setLegalInvoiceSubmitting] = useState(false);
  const [legalInvoiceError, setLegalInvoiceError] = useState<string | null>(null);


  const [decidingCredit, setDecidingCredit] = useState(false);
  const [creditSubmitting, setCreditSubmitting] = useState(false);
  const [creditError, setCreditError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const unwindStatus = useQuery(
    api.dealUnwind.unwindStatus,
    app?.status === "CLOSED" ? { orgId, applicationId } : "skip"
  );
  // A closed deal's controls that an active unwind bars stay off until its status has been read.
  const unwindBars = app?.status === "CLOSED" && (unwindStatus === undefined || unwindStatus.status === "ACTIVE");
  const [unwindOpen, setUnwindOpen] = useState(false);
  const [unwindSubmitting, setUnwindSubmitting] = useState(false);
  const [unwindError, setUnwindError] = useState<string | null>(null);
  const unwindKeyRef = useRef<string | null>(null);
  // The server's answer: a live unwind, or a paid deal whose start it would accept. Otherwise the
  // refusal is shown as a hint, so a paid deal is never left without an explanation.
  const unwindOffered =
    unwindStatus != null &&
    app?.status === "CLOSED" &&
    (unwindStatus.status === "ACTIVE" || (!!app.disbursedAt && unwindStatus.eligibility.canStart)) &&
    // A viewer who may do none of it gets no button rather than a dialog of dead controls.
    Object.values(unwindStatus.eligibility).some(Boolean);
  const unwindHint =
    unwindStatus != null && !unwindOffered && app?.status === "CLOSED" && !!app.disbursedAt
      ? unwindStatus.refusals.start
      : undefined;  const runUnwind = async (
    step: string,
    success: string,
    call: (idempotencyKey: string) => Promise<unknown>
  ): Promise<boolean> => {
    setUnwindSubmitting(true);
    setUnwindError(null);
    try {
      unwindKeyRef.current ??= `unwind-${step}:${applicationId}:${crypto.randomUUID()}`;
      await call(unwindKeyRef.current);
      unwindKeyRef.current = null;
      toast.success(t(success));
    } catch (error) {
      // A refusal is final for this attempt; a lost response keeps the key so a retry replays.
      if (isConvexError(error)) unwindKeyRef.current = null;
      const message = getLocalizedErrorMessage(error, t);
      setUnwindError(message);
      toast.error(message);
      return false;
    } finally {
      setUnwindSubmitting(false);
    }
    return true;
  };  const [confirmingDisbursement, setConfirmingDisbursement] = useState(false);
  const [recordingForward, setRecordingForward] = useState(false);
  const [forwardSubmitting, setForwardSubmitting] = useState(false);
  const [forwardCorrection, setForwardCorrection] = useState<ForwardCorrectionKind | null>(null);
  const [forwardCorrectionSubmitting, setForwardCorrectionSubmitting] = useState(false);
  // SCRUM-239: the "cheque returned by bank" dialog. The idempotency key is made
  // once per dialog open (and again only if the reason changes, because the
  // server fingerprints the reason: a replay must be the same command).
  const [chequeReturnOpen, setChequeReturnOpen] = useState(false);
  const [chequeReturnSubmitting, setChequeReturnSubmitting] = useState(false);
  const chequeReturnKeyRef = useRef<{ key: string; reason: string } | null>(null);
  const [confirmingSupplierDisbursement, setConfirmingSupplierDisbursement] = useState(false);
  const [disbursementSubmitting, setDisbursementSubmitting] = useState(false);
  /**
   * The RULES whose upload is in flight (Sol S421-R2-2). Keyed by rule, not by
   * row: a late rule's line is served as `_id: null` and re-served under its
   * new document id the moment `ensureApplicationDocument` commits — while the
   * file is still transferring. A row-keyed busy flag went false at that
   * moment and let a second pick race the first onto the same row. The state
   * paints the control; the ref is the guard, synchronous, so a second pick
   * cannot slip in before a re-render.
   */
  const [uploadingRuleIds, setUploadingRuleIds] = useState<ReadonlySet<string>>(() => new Set());
  const uploadsInFlightRef = useRef(new Set<string>());
  const [resolvingDepositId, setResolvingDepositId] = useState<string | null>(null);
  // One key per attempt, held in a ref so a retry after a lost response is the
  // SAME command rather than a second one, and cleared only once the server
  // has confirmed. Cancelling a CLOSED deal reverses a posted sale; confirming
  // a disbursement posts DR Bank; releasing a deposit pays real cash out.
  // These are the exact keys the Review dialog minted, under the same names.
  const cancelKeyRef = useRef<string | null>(null);
  const confirmDisbursementKeyRef = useRef<string | null>(null);
  // The disbursement version the kept confirm key was minted for. The server
  // binds a key to one version (SCRUM-239); if the observed version moved - a
  // colleague returned the cheque - the kept key is stale and a fresh one is
  // minted instead of being refused.
  const confirmDisbursementKeyVersionRef = useRef(1);
  // SCRUM-239 round 4: the disbursement version observed WHEN the confirm dialog
  // opened. The confirm binds to THIS, never to whatever the screen shows at
  // click time: a dialog opened at v1 must not be able to confirm v2 (the
  // replacement cheque) just because a colleague returned the v1 cheque while it
  // stood open.
  const [confirmObservedVersion, setConfirmObservedVersion] = useState(1);
  // A ref mirror of the state above: an async confirm closes over the render it
  // was clicked in, so a late answer must compare against THIS, not its closure.
  const confirmObservedVersionRef = useRef(1);
  // The version a confirm was SENT under whose outcome this screen does not know
  // (sent, no answer yet or a lost response). It belongs to the confirm KEY, not
  // the version: once any send of a key is lost, only a SUCCESS for that key
  // resolves it. A refusal of a LATER retry of the same key proves nothing about
  // the earlier send, so it must not clear the mark; a refusal of a send with no
  // earlier unknown send can. It decides whether "nothing was confirmed" is
  // still a true thing to say.
  const confirmUnknownOutcomeVersionRef = useRef<number | null>(null);
  const observedDisbursementVersion = app?.disbursementVersion ?? 1;
  // `app` is undefined while loading or reconnecting and null if not found: no
  // version is observed then, and `?? 1` above must not read as "moved to v1".
  const appObserved = app != null;
  const setConfirmingDisbursementObserved = (open: boolean) => {
    if (open) setConfirmObservedVersion(observedDisbursementVersion);
    setConfirmingDisbursement(open);
  };
  useEffect(() => {
    confirmObservedVersionRef.current = confirmObservedVersion;
  }, [confirmObservedVersion]);
  // SCRUM-522 L-C: this state belongs to ONE deal. The cockpit can be re-rendered
  // with another `applicationId` without a remount, and a key kept for deal A (or
  // the record that an outcome-unknown notice for A is still owed) must never be
  // sent for, or shown on, deal B. Declared BEFORE the reconcile effect below so
  // that, in the commit where the id changes, the owed mark is gone before that
  // effect can read it.
  const confirmStateApplicationIdRef = useRef(applicationId);
  const confirmSupplierDisbursementKeyRef = useRef<string | null>(null);
  // Bumped on every deal switch. A confirm captures it when it starts; an answer
  // that settles under a different generation belongs to a deal that is gone and
  // may change NOTHING (no key, no mark, no dialog, no notice, no in-flight flag).
  const confirmGenerationRef = useRef(0);
  useEffect(() => {
    if (confirmStateApplicationIdRef.current === applicationId) return;
    confirmStateApplicationIdRef.current = applicationId;
    confirmGenerationRef.current += 1;
    // B never inherits A's in-flight flag (A's late `finally` is fenced off below).
    setDisbursementSubmitting(false);
    confirmDisbursementKeyRef.current = null;
    confirmDisbursementKeyVersionRef.current = 1;
    confirmUnknownOutcomeVersionRef.current = null;
    confirmObservedVersionRef.current = 1;
    setConfirmObservedVersion(1);
    setConfirmingDisbursement(false);
    // The supplier-advice and cheque-return writers share the same invariant: no
    // key, dialog or flag of deal A survives on deal B.
    confirmSupplierDisbursementKeyRef.current = null;
    setConfirmingSupplierDisbursement(false);
    chequeReturnKeyRef.current = null;
    setChequeReturnOpen(false);
    setChequeReturnSubmitting(false);
  }, [applicationId]);
  // SCRUM-239 round 7: the ONE place a version move is reconciled, whether the
  // dialog is open or closed. `confirmUnknownOutcomeVersionRef` is the record that
  // an outcome-unknown notice is still OWED for the kept key; it is cleared only by
  // a success, a refusal with no earlier unknown send, this operator's own
  // successful return (the outcome is then known), or by the notice being shown
  // here or in the confirm's catch, whichever resolves it first, exactly once.
  // While this operator's own cheque return is in flight a version move may be
  // that very return (which proves the confirm committed), so the reconcile waits
  // for it to settle and re-runs then.
  // In the commit where the deal switches, this closure still holds deal A's
  // `confirmingDisbursement` / `confirmObservedVersion` (the switch effect's resets
  // only land on the NEXT render) and would compare them with B's observed
  // version. The switch effect runs first and has already cleared the refs, so
  // this commit is skipped once per deal; the reset state re-triggers the effect
  // (its deps change) and every later pass sees B's own state.
  const reconciledApplicationIdRef = useRef(applicationId);
  useEffect(() => {
    if (reconciledApplicationIdRef.current !== applicationId) {
      reconciledApplicationIdRef.current = applicationId;
      return;
    }
    if (!appObserved || chequeReturnSubmitting) return;
    const owedUnknown =
      confirmUnknownOutcomeVersionRef.current !== null &&
      confirmUnknownOutcomeVersionRef.current !== observedDisbursementVersion;
    const movedUnderDialog = confirmingDisbursement && observedDisbursementVersion !== confirmObservedVersion;
    if (!owedUnknown && !movedUnderDialog) return;
    // "Nothing was confirmed" is true only if nothing was sent; a sent confirm
    // with a lost response may have committed, and the operator must be told to
    // check receipts and cheque history even if the dialog was already closed.
    confirmDisbursementKeyRef.current = null;
    confirmUnknownOutcomeVersionRef.current = null;
    if (movedUnderDialog) setConfirmingDisbursement(false);
    toast.error(t(owedUnknown ? "DisbursementChangedOutcomeUnknown" : "DisbursementChangedWhileConfirming"));
  }, [appObserved, applicationId, chequeReturnSubmitting, confirmingDisbursement, observedDisbursementVersion, confirmObservedVersion, t]);
  // `deposits.release` gets a GENERATION-AWARE retained identity instead of a
  // plain key ref (SCRUM-313; the full reasoning lives at the release path in
  // `components/vehicles/VehicleDetailsDialog.tsx`). That command pays out
  // whatever is currently FREE on the row, so two genuine payouts of one
  // deposit are byte-identical requests and content alone cannot separate a
  // retry from a second real payout — but the server's `releaseCount`, bumped
  // in the same patch that moves the money, can. Same generation + same
  // decision = same key (a retry is deduped, and the key survives an unknown
  // result); a confirmed payout advances the generation, so the next genuine
  // payout is a new command. Identical in shape to the Review dialog's caller.
  const commandId = useCommandIdentity();
  // SCRUM-469 F1: the identity (resolution + METHOD + key) of a deposit payout
  // that may have committed, kept until confirmed or explicitly dismissed.
  const pendingPayouts = usePendingDepositPayouts(commandId.retire);

  // ---- the same derivations the Review dialog made, from the same payload ----
  // The dealer-side economics are denominated in the application's OWN pinned
  // currency, not the org's current one; the customer's principal is read at
  // the org scale, as the dialog reads it. Absent means the row predates the
  // field, and the org's currency is then the only reading available.
  const orgScale = safeScaleForCurrency(orgCurrency.code, 2);
  const orgFactor = Math.pow(10, orgScale);
  const economicsCurrencyCode = app?.economicsCurrency ?? orgCurrency.code;
  const economicsScale = safeScaleForCurrency(economicsCurrencyCode, 2);
  const economicsFactor = Math.pow(10, economicsScale);
  /**
   * What the finance company actually owes the dealership — the figure
   * `confirmDisbursement` compares against.
   *
   * `finalizeDeal` freezes `financedSaleNetReceivableMinor`: the principal
   * less every deposit the dealership holds and every cost the company
   * withholds. The server checks the caller's amount against THAT first, and
   * only a legacy row that predates the field is checked against the
   * principal. Sending the principal unconditionally — as the Review dialog
   * still does — is a guaranteed refusal on any deal with an applied deposit
   * or a withheld fee, from a dialog that offers no way to type the right
   * number. The same value is displayed and sent, so what the operator
   * confirms is what the server receives. SCRUM-241 owns making this a
   * server-projected authority; until then the frozen snapshot is read here.
   */
  const principalMinor = Math.round((app?.quote?.totalFinancedAmount ?? 0) * orgFactor);
  const frozenNetMinor = app?.financedSaleNetReceivableMinor;
  const expectedDisbursementMinor = frozenNetMinor ?? principalMinor;
  const expectsFinanceCompanyDisbursement = Boolean(app?.companyId && expectedDisbursementMinor > 0);
  const isConsignedDeal = app?.vehicle?.sourceType === "SOURCED";
  const settlesDirectToSupplier =
    isConsignedDeal && app?.supplierSettlementRoute === "DIRECT_TO_SUPPLIER";
  const supplierName = app?.vehicle?.sourcedFromName ?? undefined;
  const formatEconomics = (minor: number) => {
    return `${(minor / economicsFactor).toLocaleString()} ${
      economicsCurrencyCode === orgCurrency.code ? currencyMarker(economicsCurrencyCode) : economicsCurrencyCode
    }`;
  };
  /**
   * The customer's plan, read straight off the quote `applications.get`
   * already serves this caller. Nothing is computed from anything else: a
   * figure the quote does not carry is shown as unavailable. The national
   * identifier is exactly the field the Review dialog shows the same caller,
   * masked here by default.
   */
  const financingPlan: FinancingPlanFacts | undefined =
    app && app.quote
      ? {
          financierName: deal?.financeCompanyName || null,
          currency: economicsCurrencyCode,
          vehiclePrice:
            app.targetSellingAmountMinor !== undefined
              ? app.targetSellingAmountMinor / economicsFactor
              : app.quote.vehiclePrice,
          downPayment:
            app.customerFirstPaymentMinor !== undefined
              ? app.customerFirstPaymentMinor / economicsFactor
              : app.quote.downPayment,
          termMonths: app.quote.termMonths,
          monthlyInstallment: app.quote.monthlyInstallment,
          totalFinancedAmount: app.quote.totalFinancedAmount,
          nationalId: app.customer?.nationalId?.trim() || null,
        }
      : undefined;
  /**
   * رسوم ومصاريف تسليم السيارة — RECORD / ADD / EDIT / REMOVE on the canonical
   * `financeDealCosts` commands (c19384). Two are economic and take a retained
   * identity: `recordTemplateFeeActual` keyed on (deal, template position) and
   * `recordDealFee` keyed on the add form's own intent. EDIT and REMOVE are
   * idempotent by construction (a set and a void) and the server takes no
   * identity for them.
   */
  const handoverCosts =
    app && deal
      ? {
          // Undefined is "loading" until the permission has resolved AND, for a
          // caller who holds it, the query has answered; only a resolved caller
          // WITHOUT the permission is told the rows are not theirs to read.
          loading: permissionsLoading || (canViewApplications && dealCosts === undefined),
          costs: dealCosts
            ? ({
                lines: dealCosts.fees.map((fee) => ({
                  _id: fee._id,
                  feeType: fee.feeType,
                  description: fee.description,
                  estimatedAmountMinor: fee.estimatedAmountMinor,
                  actualAmountMinor: fee.actualAmountMinor,
                  paidBy: fee.paidBy,
                  paidTo: fee.paidTo,
                  currency: fee.currency,
                  status: fee.status,
                  paidAt: fee.paidAt,
                  receiptReference: fee.receiptReference,
                  // SCRUM-443: who paid it and whether it is on the books —
                  // the server's verdict (the closing check's own module),
                  // passed through, never re-derived here.
                  handoverPayment: fee.handoverPayment,
                  directPaymentEligible: fee.directPaymentEligible,
                  directPayment: fee.directPayment
                    ? {
                        method: fee.directPayment.method,
                        amountMinor: fee.directPayment.amountMinor,
                        paidAt: fee.directPayment.paidAt,
                        reference: fee.directPayment.reference,
                      }
                    : undefined,
                })),
                // Null over mixed rows, with the reason beside it — served as
                // such, never turned into a zero or a cast here.
                summary: dealCosts.summary,
                summaryUnavailable: dealCosts.summaryUnavailable,
                // The finance company's frozen policy, derived server-side from
                // the deal's own rule snapshot. Passed through as served: the
                // expected figures, the totals and the comparison are the
                // server's, and nothing is summed or matched here.
                expected: dealCosts.expected
                  ? {
                      source: dealCosts.expected.source,
                      currency: dealCosts.expected.currency,
                      rows: dealCosts.expected.rows.map((row) => ({
                        templateIndex: row.templateIndex,
                        feeType: row.feeType,
                        description: row.description,
                        expectedAmountMinor: row.expectedAmountMinor,
                        expectedAmountReason: row.expectedAmountReason,
                        duplicateIdentity: row.duplicateIdentity,
                        actual: row.actual
                          ? {
                              feeId: row.actual.feeId,
                              actualAmountMinor: row.actual.actualAmountMinor,
                              currency: row.actual.currency,
                              status: row.actual.status,
                            }
                          : null,
                      })),
                      expectedTotalMinor: dealCosts.expected.expectedTotalMinor,
                      expectedTotalReason: dealCosts.expected.expectedTotalReason,
                      actualTotalMinor: dealCosts.expected.actualTotalMinor,
                      differenceMinor: dealCosts.expected.differenceMinor,
                      unplannedLineIds: dealCosts.expected.unplannedLineIds,
                      // The honest "not configured" state — reported, never applied.
                      adoption: dealCosts.expected.adoption,
                    }
                  : null,
                // SCRUM-690: the finance company's execution fee as one
                // position — the server's verdict, passed through.
                executionFee: dealCosts.executionFee
                  ? {
                      expectedMinor: dealCosts.executionFee.expectedMinor,
                      boundFeeId: dealCosts.executionFee.boundFeeId,
                      unrecorded: dealCosts.executionFee.unrecorded,
                      withheld: dealCosts.executionFee.withheld,
                      eligibleFeeIds: dealCosts.executionFee.eligibleFeeIds,
                    }
                  : null,
              } satisfies HandoverCostsData)
            : undefined,
          // The currency a new line is recorded in, as the SERVER resolves it
          // for its own writers (pin, else the org's verified currency, which
          // the first cost fixes — SCRUM-319). Not derived client-side.
          denomination: { code: dealCosts?.currency ?? economicsCurrencyCode },
          scaleOf: (cur: string) => safeScaleForCurrency(cur, 2),
          money: (minor: number, currency: string) =>
            `${(minor / Math.pow(10, safeScaleForCurrency(currency, 2))).toLocaleString()} ${
              currency === orgCurrency.code ? currencyMarker(currency) : currency
            }`,
          // Frozen once the sale is recognized (`economicsFrozen`): the server
          // refuses every posting-bearing edit, so none is offered, and the
          // panel says why at its head.
          canManage: canCreateApplication && !(dealCosts?.economicsFrozen?.frozen ?? app.status === "CLOSED"),
          dealClosed: dealCosts?.economicsFrozen?.frozen ?? app.status === "CLOSED",
          // Where a new handover cost's cash comes from — always an employee's
          // custody (owner ruling 2026-09-28, SCRUM-439). A record counts
          // when it is open, on the ledger and in the deal's currency. It is
          // CHARGED directly only where `recordDealFee` would accept its
          // `custodyId` from this caller: custody authority, a ledger that
          // can take the posting, and a record held by somebody else (the
          // holder never charges their own). The candidate read is what names
          // the operator, so an authorised caller waits for it rather than
          // being handed the unlinked path by a loading flicker.
          costSource: ((): HandoverCostSource => {
            const open = (dealCosts?.custody ?? []).filter(
              (record) => record.status === "OPEN" && !record.legacy && record.currency === dealCosts?.currency
            );
            if (open.length === 0) return { kind: "NONE" };
            if (!custodyCommandsOffered) return { kind: "PENDING" };
            if (custodyCandidates === undefined) return { kind: "LOADING" };
            // The caller, named by the read itself: the member list is capped,
            // so the operator may be past it. A backend that predates
            // `actorId` answers through the list; with neither, the caller is
            // unknown and no record is offered — the server refuses a holder
            // charging their own custody, so a guess would be a dead end.
            const actorId =
              custodyCandidates.actorId ?? custodyCandidates.candidates.find((member) => member.isActor)?.userId;
            const payers = dealCosts?.custodyAccounting?.ready === true && actorId !== undefined
              ? open
                  .filter((record) => record.userId !== actorId)
                  .map((record) => ({ custodyId: record._id, holderName: record.userName || t("CustodyHandlerNone") }))
              : [];
            return payers.length > 0 ? { kind: "CHARGE", payers } : { kind: "PENDING" };
          })(),
          onAdd: async (values: NewHandoverCost) => {
            const feeIntent = `record-deal-fee:${applicationId}:${values.intentId}`;
            try {
              await recordDealFee({
                orgId,
                applicationId,
                // REQUIRED: the currency the form was opened under and the
                // amount counted in. A retry replays this captured value.
                expectedCurrency: values.currency,
                feeType: values.feeType,
                description: values.description,
                // An ADDITIONAL cost: actual only. The UI never authors an
                // expectation — those are the finance company's, from the
                // deal's frozen snapshot (owner correction 2026-09-12 21:05).
                estimatedAmountMinor: undefined,
                actualAmountMinor: values.actualAmountMinor,
                // Always the employee's, out of custody cash (owner ruling
                // 2026-09-28, SCRUM-439); charged to the named record in the
                // same command when this caller may, else it waits under
                // "Charge a cost".
                paidBy: "EMPLOYEE",
                ...(values.custodyId ? { custodyId: values.custodyId } : {}),
                paidTo: values.paidTo,
                accountingTreatment: values.accountingTreatment,
                paidAt: values.paidAt,
                receiptReference: values.receiptReference,
                source: "MANUAL",
                idempotencyKey: commandId.for(feeIntent),
              });
              commandId.retire(feeIntent);
              toast.success(t("HandoverCostSaved"));
            } catch (error) {
              // The server's own refusal is thrown inside the mutation and
              // rolls it back: nothing committed. Anything else is a lost
              // response, and the cost may already exist.
              throw new HandoverCostAttemptError(getErrorMessage(error), isConvexError(error) ? "REFUSED" : "UNKNOWN");
            }
          },
          onAbandonAdd: (intentId: string) => {
            commandId.retire(`record-deal-fee:${applicationId}:${intentId}`);
          },
          /**
           * The ACTUAL for a fee the finance company's policy configures. The
           * caller names WHICH fee by its position in the deal's frozen
           * snapshot and what it saw there; the server copies every other
           * field from that entry and refuses a stale or out-of-range
           * reference.
           *
           * One retained identity per (deal, position), with the SAME outcome
           * discipline as the additional-cost add: a REFUSED attempt is the
           * server's own answer (ConvexError, nothing committed) and releases
           * the identity, so the next submit is a new command; an UNKNOWN
           * attempt (lost response) KEEPS it, so the form's verbatim retry
           * replays the same line and a changed payload is refused as a
           * different intent. The server's one-live-line-per-position rule is
           * what makes this lifecycle safe end to end: after a lost response,
           * replay, cancel-and-record-again, or a second operator can land at
           * most one actual on the row.
           */
          onRecordTemplateActual: async (row: ExpectedHandoverRow, values: ActualHandoverCost) => {
            const intent = `record-template-fee:${applicationId}:${row.templateIndex}`;
            try {
              await recordTemplateFeeActual({
                orgId,
                applicationId,
                templateIndex: row.templateIndex,
                feeType: row.feeType,
                actualAmountMinor: values.actualAmountMinor,
                // REQUIRED: the deal's denomination the amount was counted in.
                expectedCurrency: values.currency,
                paidAt: values.paidAt,
                receiptReference: values.receiptReference,
                idempotencyKey: commandId.for(intent),
              });
              commandId.retire(intent);
              toast.success(t("HandoverCostSaved"));
            } catch (error) {
              const outcome = isConvexError(error) ? "REFUSED" : "UNKNOWN";
              if (outcome === "REFUSED") commandId.retire(intent);
              throw new HandoverCostAttemptError(getErrorMessage(error), outcome);
            }
          },
          onAbandonTemplateActual: (row: ExpectedHandoverRow) => {
            commandId.retire(`record-template-fee:${applicationId}:${row.templateIndex}`);
          },
          /**
           * SCRUM-690: record the execution fee's actual and link it in one
           * command. The same outcome discipline as the template actual; the
           * server keeps at most one linked line per deal, so a replay, or a
           * second attempt after a lost response, lands at most one.
           */
          onRecordExecutionFee: async (values: ActualHandoverCost) => {
            const intent = `record-execution-fee:${applicationId}`;
            try {
              await recordExecutionFeeActual({
                orgId,
                applicationId,
                actualAmountMinor: values.actualAmountMinor,
                expectedCurrency: values.currency,
                // Out of custody cash, like every handover cost the UI records
                // (owner ruling 2026-09-28, SCRUM-439).
                paidBy: "EMPLOYEE",
                paidAt: values.paidAt,
                receiptReference: values.receiptReference,
                idempotencyKey: commandId.for(intent),
              });
              commandId.retire(intent);
              toast.success(t("ExecutionFeeRecorded"));
            } catch (error) {
              const outcome = isConvexError(error) ? "REFUSED" : "UNKNOWN";
              if (outcome === "REFUSED") commandId.retire(intent);
              throw new HandoverCostAttemptError(getErrorMessage(error), outcome);
            }
          },
          onAbandonExecutionFee: () => {
            commandId.retire(`record-execution-fee:${applicationId}`);
          },
          // Linking and unlinking set a marker on one named line: a replay
          // converges, so neither carries an idempotency key.
          onLinkExecutionFee: async (feeId: string) => {
            try {
              await bindExecutionFeeLine({ orgId, feeId: feeId as Id<"financeDealFees"> });
              toast.success(t("ExecutionFeeLinked"));
            } catch (error) {
              throw new Error(getErrorMessage(error));
            }
          },
          onUnlinkExecutionFee: async (feeId: string, reason: string) => {
            try {
              await unbindExecutionFeeLine({ orgId, feeId: feeId as Id<"financeDealFees">, reason });
              toast.success(t("ExecutionFeeUnlinked"));
            } catch (error) {
              throw new Error(getErrorMessage(error));
            }
          },
          // SCRUM-443: the dealership's own payment of a handover cost. Only a
          // caller who may confirm a finance disbursement is offered it (R1);
          // the server refuses anyone else regardless.
          canRecordDirectPayment: canConfirmFinanceDisbursement,
          // The reconcile mutation checks the same permission (confirm:finance_disbursement).
          canReconcile: canConfirmFinanceDisbursement,
          onRecordDirectPayment: async (feeId: string, values: DirectHandoverPayment) => {
            const intent = `record-direct-payment:${applicationId}:${feeId}:${values.intentId}`;
            try {
              await recordDirectFeePayment({
                orgId,
                feeId: feeId as Id<"financeDealFees">,
                method: values.method,
                paidAt: values.paidAt,
                // The amount the operator saw when they chose to pay: the
                // server refuses if the line has changed since (R1).
                expectedAmountMinor: values.expectedAmountMinor,
                reference: values.reference,
                idempotencyKey: commandId.for(intent),
              });
              commandId.retire(intent);
              toast.success(t("DirectPaymentSaved"));
            } catch (error) {
              // The server's own refusal rolled the mutation back: nothing
              // committed, so the identity is released. Anything else is a lost
              // response — the payment may exist, and the form replays it.
              const outcome = isConvexError(error) ? "REFUSED" : "UNKNOWN";
              if (outcome === "REFUSED") commandId.retire(intent);
              throw new HandoverCostAttemptError(getErrorMessage(error), outcome);
            }
          },
          onAbandonDirectPayment: (feeId: string, intentId: string) => {
            commandId.retire(`record-direct-payment:${applicationId}:${feeId}:${intentId}`);
          },
          // The lines the server's own closing check names as waiting on the
          // ledger: passed through, so a recorded-but-queued payment is never
          // shown as paid. Only a blocked check names any.
          // Undefined while readiness is loading or unavailable: nothing then
          // says a recorded payment is on the books.
          handoverCostsCheck: closingReadiness?.checks.find((c) => c.key === "HANDOVER_COSTS_PAID")?.status,
          // The same discipline for a custody-paid line (SCRUM-443 v6): the row
          // says a posting was made; only this check says it is on the books.
          custodyLedgerCheck: closingReadiness?.checks.find((c) => c.key === "CUSTODY_ON_LEDGER")?.status,
          // A stopped (cancelled or rejected) deal: labels follow app.status, so
          // its direct payments read as recorded, never as settled, and none is
          // offered. cancelApplication can leave finalizedSaleId set, so a
          // stopped deal may also be finalized; dealClosed still governs edit
          // notes there. Taken from the app record, not from a separately
          // fetched eligibility flag (SCRUM-443).
          dealStopped: app.status === "CANCELLED" || app.status === "REJECTED" ? app.status : null,
          postingHoldFeeIds: ((): string[] => {
            const check = closingReadiness?.checks.find((c) => c.key === "HANDOVER_COSTS_PAID");
            return check?.status === "BLOCKED" ? (check.feeIds ?? []) : [];
          })(),
          onRecordActual: async (feeId: string, values: ActualHandoverCost) => {
            try {
              await recordActualFeeAmount({
                orgId,
                feeId: feeId as Id<"financeDealFees">,
                // REQUIRED: the LINE's stored currency, which the amount was
                // scaled at — never the org's current one.
                expectedCurrency: values.currency,
                actualAmountMinor: values.actualAmountMinor,
                paidAt: values.paidAt,
                receiptReference: values.receiptReference,
              });
              toast.success(t("HandoverCostSaved"));
            } catch (error) {
              throw new Error(getErrorMessage(error));
            }
          },
          onVoid: async (feeId: string, reason: string) => {
            try {
              await voidDealFee({ orgId, feeId: feeId as Id<"financeDealFees">, reason });
              toast.success(t("HandoverCostRemoved"));
            } catch (error) {
              throw new Error(getErrorMessage(error));
            }
          },
          onReconcile: async (feeId: string, notes: string) => {
            try {
              await reconcileDealFee({
                orgId,
                feeId: feeId as Id<"financeDealFees">,
                notes,
              });
              toast.success(t("HandoverCostReconciled"));
            } catch (error) {
              throw new Error(getErrorMessage(error));
            }
          },
        }
      : undefined;
  const formatPlanMajor = (major: number, currency: string) => {
    const scale = safeScaleForCurrency(currency, 2);
    return `${major.toLocaleString(undefined, {
      maximumFractionDigits: scale,
    })} ${
      currency === orgCurrency.code ? currencyMarker(currency) : currency
    }`;
  };
  /**
   * The frozen net is built in the deal's PINNED currency
   * (`resolveFinancedSalePlan` runs in `app.economicsCurrency ?? org`), so it is
   * spelled at that scale with that label. The legacy principal is a
   * quote-major figure the server scales by the ORG currency, so it keeps the
   * org denomination. Mixing the two — a JOD-scale factor over a USD-pinned
   * integer — is a 10× lie beside a confirm button.
   */
  const expectedDisbursementLabel =
    frozenNetMinor !== undefined
      ? formatEconomics(frozenNetMinor)
      : orgCurrency.format(principalMinor / orgFactor);
  /**
   * The server's currency boundary, mirrored (SCRUM-241, see
   * `settlementDenomination.ts`). The close is refused for EVERY pinned deal
   * whose currency drifted from the org's current one — the sale would post
   * under the wrong label — so it is withheld here with the reason. The
   * receipt on a closed deal is NOT: it settles the receivable in the
   * receivable's own denomination, whatever the org setting says now. Only a
   * deal with a named finance company settling through the dealership has
   * that receipt, and the one refusal left on it is an unrecognised pin.
   */
  const finalizeDenominationBlock = app
    ? finalizeDenominationRefusal(app.economicsCurrency, orgCurrency.code)
    : undefined;
  const disbursementDenominationBlock =
    app?.companyId && !settlesDirectToSupplier
      ? disbursementDenominationRefusal(app.economicsCurrency)
      : undefined;
  /**
   * The recorded currency beside the org's current one. Structured rather
   * than one string: under an RTL base a money run and its code swap order
   * ("USD 15,625") unless each run is its own LTR isolate.
   */
  const finalizeDenominationDetail =
    finalizeDenominationBlock && app
      ? {
          recordedLabel: t("RecordedEconomicsCurrency"),
          recordedAmount: app.economicsCurrency ?? orgCurrency.code,
          orgLabel: t("OrganisationCurrencyLabel"),
          orgCurrency: orgCurrency.code,
        }
      : undefined;
  const disbursementDenominationDetail = disbursementDenominationBlock
    ? {
        recordedLabel: t("RecordedSettlementAmount"),
        recordedAmount: expectedDisbursementLabel,
        orgLabel: t("OrganisationCurrencyLabel"),
        orgCurrency: orgCurrency.code,
      }
    : undefined;
  // The route is a decision about a deal that has not posted yet; once it
  // closes, changing it is a correction and the server refuses it there too.
  // Keyed on MANAGE_SUPPLIER_SETTLEMENT, matching the server.
  const canChooseSettlementRoute =
    app != null &&
    canRecordSupplierRoute &&
    isConsignedDeal &&
    app.status !== "CLOSED" &&
    app.status !== "CANCELLED";
  /**
   * SCRUM-447 N1-A: the cheque states in which `confirmDisbursement` REFUSES
   * (a cleared cheque awaiting accounting review, a live cheque whose face was
   * never recorded, a returned/cancelled one awaiting correction, or no payment
   * registered on a closed deal). The rail withholds the confirmation exactly
   * there and names the cheque panel's own notice, in the panel's order, so it
   * never offers a step the server would refuse. Review comes first, as on the
   * server, where a CLEARED row is named first.
   */
  const chequeDisbursementBlockKey: string | undefined =
    deal?.chequeNeedsAccountingReview === true
      ? "FcAccountingReviewNotice"
      : deal?.chequeFaceUnrecorded === true
        ? "FcChequeFaceUnrecordedNotice"
        : deal?.chequeNeedsCorrection === true
          ? "FcCorrectNeededNotice"
          : deal?.expectedPaymentReRegistrable === true
            ? "FcReRegisterNotice"
            : undefined;
  // On the direct route the company pays the supplier, so there is no
  // dealership receipt to confirm — `confirmDisbursement` would invent cash.
  const canConfirmDisbursement =
    app != null &&
    canConfirmFinanceDisbursement &&
    app.status === "CLOSED" &&
    expectsFinanceCompanyDisbursement &&
    !settlesDirectToSupplier &&
    !app.disbursedAt &&
    !(
      deal?.forward?.applies === true &&
      deal.forward.state !== "SETTLED" &&
      deal.forward.state !== "NOT_DUE"
    ) &&
    disbursementDenominationBlock === undefined &&
    chequeDisbursementBlockKey === undefined;
  // Gated on the SERVER's own answer (`canSettleDirectToSupplier`), not on
  // `companyId`, which is unset on every MANUAL_FINANCE_COMPANY deal.
  const canConfirmSupplierDisbursement =
    app != null &&
    canConfirmFinanceDisbursement &&
    app.status === "CLOSED" &&
    settlesDirectToSupplier &&
    app.canSettleDirectToSupplier &&
    !app.supplierDisbursementStatus;
  // Mirror the backend permission tiers exactly.
  // SCRUM-413: a CLOSED deal is reversed with CANCEL_CLOSED_DEAL alone (no
  // create-application authority); every other status keeps create (+ approve
  // once APPROVED). A CLOSED deal is cancelled only on the server's own answer
  // (`mayCancelFinalized`: the same permission tiers AND the forward gate); no
  // answer yet means no Cancel, never a permission-only guess.
  const canCancel =
    app != null &&
    app.status !== "CANCELLED" &&
    (app.status === "CLOSED"
      ? // A recorded supplier payment bars bare cancellation just as the company's own payment does.
        canCancelClosedDeal && deal?.forward?.mayCancelFinalized === true && !app.disbursedAt && !app.supplierDisbursementStatus
      : canCreateApplication && (app.status === "APPROVED" ? canApproveApplication : true));
  // The caller holds the cancel authority but the server still refuses: with no
  // disbursement authority the missing piece is a manager; with it, only the
  // forward gate is left, which is not a permission.
  const cancelHint: "MANAGER" | "FORWARD" | undefined =
    app?.status === "CLOSED" &&
    deal?.forward?.planV2 === true &&
    deal.forward.mayCancelFinalized !== true &&
    !app.disbursedAt &&
    !app.supplierDisbursementStatus &&
    canCancelClosedDeal
      ? canConfirmFinanceDisbursement
        ? "FORWARD"
        : "MANAGER"
      : undefined;
  const forwardBlocksTransfer =
    deal?.forward?.applies === true && deal.forward.state !== "SETTLED" && deal.forward.state !== "NOT_DUE";
  const applicationDeposits: DealDeposit[] = (app?.deposits ?? []).map((deposit) => ({
    _id: deposit._id,
    amount: deposit.amount,
    status: deposit.status,
    method: deposit.method,
    releasedAmountMinor: deposit.releasedAmountMinor,
    releaseCount: deposit.releaseCount,
  }));
  const showApplicationDeposits =
    app != null &&
    (app.status === "REJECTED" || app.status === "CANCELLED") &&
    applicationDeposits.length > 0;
  /**
   * Whether a deposit's FACE value is what `deposits.release` would actually
   * pay out — the only case in which this screen may put that figure on an
   * irreversible confirmation.
   *
   * The server releases the FREE part of the row: face value less what a live
   * sale has applied, what is still assigned to a car on the deal, what was
   * released for its own decision, and what was already paid out. Those live
   * in holds and applications the deal payload does not carry, so the answer
   * is read from the server's own allocation summary
   * (`deposits.quoteAllocation`) rather than reconstructed here. Any money in
   * any of those buckets, on any deposit of the quote, and the action is
   * withheld with a reason — the deposit manager on the vehicle is the surface
   * that resolves shares and remainders exactly. Conservative on purpose: the
   * cost of withholding is a pointer, the cost of over-offering is an operator
   * authorising 5,000 while 2,000 moves.
   */
  const allocation = useQuery(
    api.deposits.quoteAllocation,
    showApplicationDeposits && app?.quoteId ? { orgId, quoteId: app.quoteId } : "skip"
  );
  const quoteHasCommittedMoney =
    allocation === undefined ||
    allocation === null ||
    allocation.isMultiVehicle ||
    allocation.allocatedMinor > 0 ||
    allocation.appliedMinor > 0 ||
    allocation.reversingMinor > 0 ||
    allocation.releasedAwaitingDecisionMinor > 0 ||
    allocation.refundedMinor > 0 ||
    allocation.forfeitedMinor > 0 ||
    allocation.otherFinalizedMinor > 0;

  const [confirmingHandover, setConfirmingHandover] = useState(false);
  const [handoverSubmitting, setHandoverSubmitting] = useState(false);
  const [resolvingGap, setResolvingGap] = useState(false);
  const [gapSubmitting, setGapSubmitting] = useState(false);
  const [registeringPayment, setRegisteringPayment] = useState(false);
  const [paymentSubmitting, setPaymentSubmitting] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [confirmingFinalize, setConfirmingFinalize] = useState(false);
  const [finalizeSubmitting, setFinalizeSubmitting] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [resolvingReconciliation, setResolvingReconciliation] = useState(false);
  const [reconciliationSubmitting, setReconciliationSubmitting] = useState(false);
  const [reconciliationError, setReconciliationError] = useState<string | null>(null);

  /**
   * The action for the stage the rail is currently naming.
   *
   * ONE action at a time, keyed to a stage, because the tail is strictly ordered
   * on the server and each step refuses a second attempt: handover requires an
   * APPROVED application, the expected payment requires the handover, and
   * `finalizeDeal` requires both. Offering all three at once would put two
   * guaranteed refusals on screen beside the one step that can actually be
   * taken.
   *
   * Each step is gated on its OWN permission — `register:vehicle_handover`,
   * `register:expected_payment`, `confirm:finance_disbursement` are three separate
   * strings on customizable roles, so a caller may hold one and not the next.
   * A single flag over the whole tail would hide a step somebody is entitled to
   * take, and would show one they are not.
   *
   * The last two hang off SETTLEMENT rather than off stages of their own. The
   * rail's stages are the ones `deriveDealStages` emits, and inventing client
   * stages it does not know about would give the screen a second opinion about
   * the deal's shape. SETTLEMENT is where the deal actually sits while these two
   * are outstanding, and it is the stage whose blocker the operator is trying to
   * clear.
   */
  const handoverStage = deal?.stages.find((stage) => stage.key === "HANDOVER");
  const settlementStage = deal?.stages.find((stage) => stage.key === "SETTLEMENT");
  /**
   * Whether the payment fact `finalizeDeal` requires is on file — from the
   * SERVER, never inferred from the rail. No stage completes on the expected
   * payment, so the rail cannot answer this, and guessing from SETTLEMENT's
   * blocker would have offered finalize on a deal that has no payment recorded.
   */
  const expectedPaymentRegistered =
    deal && "expectedPaymentRegistered" in deal ? deal.expectedPaymentRegistered : false;
  /**
   * Whether `finalizeDeal` will refuse for want of a settlement route — the
   * server's own answer, computed from the same inputs the mutation refuses on.
   * Nothing on this side reconstructs it; `money.routeKnown` is a different
   * question and reports this deal as fine.
   */
  const settlementRouteRequired =
    deal && "supplierSettlementRouteRequired" in deal
      ? deal.supplierSettlementRouteRequired
      : false;

  /**
   * The stage the rail is actually naming — the same one the view calls `live`.
   *
   * Read here rather than left implicit, because one branch below has to answer
   * for a stage that has no action at all, and "return the handover entry and
   * let the view filter it out" cannot express that.
   *
   * A NOT_APPLICABLE stage is never this one (SCRUM-446): the server does not
   * choose it as live, so a deal whose finance company pays nobody offers no
   * "confirm payment" action and no `DisbursementUnavailable` sentence to
   * contradict a rail that says the step is not needed. The step's own words
   * live in `DealStageView` (see `stageNotApplicableReasonKey`).
   */
  const liveStage = deal?.stages.find(
    (stage) => stage.state === "CURRENT" || stage.state === "BLOCKED"
  );

  /**
   * Whether a required document is still neither verified nor waived — the
   * SERVER's answer, read off the rail's DELIVERY_ACTIONS stage (derived with
   * the same rule filter `assertRequiredApplicationDocumentsComplete` applies
   * before a credit approval). Never recomputed from the checklist here. A
   * NOT_APPLICABLE stage has no required document, so nothing is outstanding
   * (SCRUM-629 F-07) — reading it as incomplete would lock credit approval.
   */
  const deliveryStage = deal?.stages.find((stage) => stage.key === "DELIVERY_ACTIONS");
  const documentsIncomplete = documentsOutstanding(deliveryStage?.state);
  /**
   * Whether this caller can take the documents step — see
   * `documentsStepUnavailableReason`. Read off the cockpit payload's checklist,
   * which lists a rule with no row yet as MISSING, exactly as the approval
   * gate counts it.
   */
  const documentsStepReason = documentsStepUnavailableReason({
    outstanding: (deal?.documents ?? []).filter(
      (doc) => doc.required && doc.status !== "VERIFIED" && doc.status !== "WAIVED"
    ),
    canUpload: canCreateApplication || canVerifyDocuments,
    canVerify: canVerifyDocuments,
    // The exact predicate the `getForApplication` subscription above is gated on.
    canRead: canViewApplications,
    // A closed deal still derives DELIVERY_ACTIONS from the live rules, so a
    // rule added after closing can re-open the stage (SCRUM-422 R1 follow-up).
    settled: documentsSettled,
  });

  function buildWorkflowAction(): WorkflowAction | undefined {
    if (permissionsLoading || !deal) return undefined;

    /**
     * The stage that used to have no exit (SCRUM-83).
     *
     * A finance company approving BELOW the submitted quotation is the ordinary
     * case; it is the whole reason an appraisal gap exists.
     * `approveDealerPurchaseAmount` writes `PENDING_NEGOTIATION`, which
     * `deriveDealStages` does not count as resolved, and because the rail is
     * strictly sequential the stage hid handover, settlement and every action
     * after it. `resolveAppraisalGap` is the writer that was missing; this is
     * its one entry point. The blocked state itself is NOT softened — it is true
     * until somebody records who covers the shortfall.
     *
     * Three obstacles, told apart rather than merged, lifecycle FIRST because it
     * outranks both: the server refuses anything not APPROVED, anything already
     * handed over and anything closed (handover seals the figures; finalization
     * writes the sale against them), so offering the action there would promise
     * a step guaranteed to fail. One exception, the server's own (SCRUM-116):
     * handover now refuses an unsettled gap, so a gap still open after the
     * vehicle went out came from an approval recorded no earlier than handover
     * — the approval's timestamp says so; an equal timestamp is ambiguous and
     * admitted on purpose — and settling it is exactly what finalization is
     * waiting on. The rail shows this stage again in that case and the action
     * must be there, keyed on the same two timestamps the mutation compares.
     * Then authority — the same permission that set
     * the approved amount, and never the deal's own salesperson (the server
     * refuses both). Then visibility: a caller who HOLDS the authority but whose
     * money is withheld cannot be asked to allocate a figure the screen does not
     * show them, and telling them to find an approver would name a problem they
     * do not have.
     *
     * The gap is read from the MONEY block, not the rail: the rail is
     * deliberately qualitative so it can be shown to a caller who cannot see
     * amounts, and a locally derived gap could disagree with the one the
     * mutation reconciles against.
     */
    // SCRUM-417 (G4): a FAILED negotiation on a live deal is settled through
    // the same writer — `resolveAppraisalGap` refuses only a gap already
    // CUSTOMER_ABSORBS / DEALER_ABSORBS / SPLIT, and the rail hands both
    // blockers to the dealership for exactly this action.
    if (liveStage?.blocker === "GapUnresolved" || liveStage?.blocker === "GapNegotiationFailed") {
      const gapVisible = typeof deal.money?.appraisalGapMinor === "number";
      const handedOverAt = app?.vehicleHandoverAt;
      // `>=`, as the mutation compares: equal timestamps are ambiguous (two
      // writes can share a millisecond) and are deliberately admitted.
      const approvalNotBeforeHandover =
        handedOverAt !== undefined &&
        app?.approvedPurchaseApprovedAt !== undefined &&
        app.approvedPurchaseApprovedAt >= handedOverAt;
      const lifecycleSealed =
        deal.status !== "APPROVED" ||
        ((handoverStage?.state === "COMPLETE" || handedOverAt !== undefined) && !approvalNotBeforeHandover);
      const ownDeal = membership?.userId != null && membership.userId === app?.salespersonId;
      return {
        stageKey: liveStage.key,
        actionKey: "ResolveGapAction",
        onStart: () => {
          setResolvingGap(true);
        },
        unavailableReasonKey: lifecycleSealed
          ? "GapResolutionSealed"
          : !hasPermission(PERMISSIONS.APPROVE_FINANCE_APPLICATION)
            ? "GapResolutionNeedsPermission"
            : ownDeal
              ? "GapResolutionSelfDeal"
              : gapVisible
                ? undefined
                : "GapResolutionNeedsDealFigures",
      };
    }

    /**
     * A DRAFT application (SCRUM-417, G1). The one legal move out of it is
     * `updateStatus` DRAFT → PENDING_DOCS (`VALID_STATUS_TRANSITIONS`), which
     * the server gates on `view:finance_applications` alone — so that is the
     * gate here too, not a stricter one the server does not apply.
     */
    if (liveStage?.key === "APPLICATION" && deal.status === "DRAFT") {
      return {
        stageKey: "APPLICATION",
        actionKey: "SubmitApplicationAction",
        onStart: () => {
          void recordCreditStatus("PENDING_DOCS");
        },
        unavailableReasonKey: canViewApplications ? undefined : "SubmitApplicationNeedsPermission",
      };
    }

    /**
     * The finance company's credit decision — RECORDED here, never made.
     *
     * Two dealership moves on this stage, matching `updateStatus`'s legal
     * transitions exactly: PENDING_DOCS → UNDER_REVIEW says the application is
     * with the finance company; UNDER_REVIEW → APPROVED | REJECTED writes down
     * what they decided. APPROVED needs `approve:finance_application`,
     * UNDER_REVIEW and REJECTED need `review:finance_application`; a caller
     * holding neither is told so rather than shown nothing.
     */
    if (liveStage?.key === "CREDIT_DECISION") {
      if (deal.status === "PENDING_DOCS") {
        return {
          stageKey: "CREDIT_DECISION",
          actionKey: "MarkUnderReview",
          onStart: () => {
            void recordCreditStatus("UNDER_REVIEW");
          },
          unavailableReasonKey: canReviewApplication ? undefined : "CreditDecisionNeedsPermission",
        };
      }
      if (deal.status === "UNDER_REVIEW") {
        const openCreditDialog = {
          actionKey: "RecordCreditDecisionAction",
          onStart: () => {
            setCreditError(null);
            setDecidingCredit(true);
          },
        };
        // SCRUM-417 (G6): the server refuses the APPROVAL while a required
        // document is outstanding, so the next step is the documents — not a
        // dialog whose main option is certain to be refused. A rejection does
        // not need them, so recording it stays one quiet click away — also for
        // an approver who cannot touch the documents themselves (W1), who is
        // told who does instead of being sent to a pane with no control.
        if ((canApproveApplication || canReviewApplication) && documentsIncomplete) {
          return {
            stageKey: "CREDIT_DECISION",
            actionKey: "CompleteDocumentsFirstAction",
            opens: "DOCUMENTS",
            noteKey: "CreditApprovalNeedsDocuments",
            secondary: openCreditDialog,
            unavailableReasonKey: documentsStepReason,
          };
        }
        return {
          stageKey: "CREDIT_DECISION",
          ...openCreditDialog,
          unavailableReasonKey:
            canApproveApplication || canReviewApplication ? undefined : "CreditDecisionNeedsPermission",
        };
      }
      return undefined;
    }

    /**
     * What the finance company told the dealership (SCRUM-417, G3): the
     * quotation, then the appraisal, then the approved amount — one at a time,
     * through the SAME dialogs and the SAME availability predicates the
     * decision card uses (`nextFinanceDecisionStep`).
     */
    if (
      liveStage?.key === "APPRAISAL" ||
      (liveStage?.key === "APPROVED_PURCHASE" && liveStage.blocker === "NoApprovedPurchaseAmount")
    ) {
      if (financeDecision) {
        return {
          stageKey: liveStage.key,
          ...nextFinanceDecisionStep(financeDecision.facts, financeDecision, liveStage.key),
        };
      }
      // The economics read is skipped for a caller without the permission it
      // authorizes on; the card is absent for them too, so say who acts.
      if (!canViewApplications) {
        return {
          stageKey: liveStage.key,
          actionKey: "RecordApprovedPurchaseAction",
          unavailableReasonKey: "FinanceDecisionNeedsAccess",
        };
      }
      return undefined;
    }

    /**
     * The paperwork (SCRUM-417, G5): an ACTION that opens the Documents tab and
     * focuses it, rather than a passive pointer — offered only when this caller
     * can advance an outstanding document (W1): an uploader facing documents
     * that only await verification is told so, not sent to a pane with nothing
     * for them to press.
     */
    if (liveStage?.key === "DELIVERY_ACTIONS") {
      return {
        stageKey: "DELIVERY_ACTIONS",
        actionKey: "CompleteDocumentsAction",
        opens: "DOCUMENTS",
        unavailableReasonKey: documentsStepReason,
      };
    }

    /**
     * The money actually moving — confirmed from the evidence, on the route the
     * deal recorded. Direct route: the finance company paid the SUPPLIER, and
     * the advice is recorded (no journal, no dealership cash). Through the
     * dealership: the receipt is confirmed and posts DR Bank. Two different
     * claims, so two different actions rather than one button meaning two
     * things depending on a field elsewhere.
     *
     * `app` carries the facts these gates need; until it arrives the stage
     * keeps its blocker and offers nothing, which is honest rather than early.
     */
    if (liveStage?.key === "DISBURSEMENT") {
      if (!app) return undefined;
      if (settlesDirectToSupplier) {
        return {
          stageKey: "DISBURSEMENT",
          actionKey: "ConfirmSupplierDisbursement",
          onStart: () => setConfirmingSupplierDisbursement(true),
          unavailableReasonKey: disbursementUnavailableReason(
            canConfirmSupplierDisbursement,
            canConfirmFinanceDisbursement,
            "SupplierDisbursementUnavailable"
          ),
        };
      }
      // A cheque state the server refuses is a fact about the deal, named
      // before permission: the way forward is on the cheque panel above.
      if (chequeDisbursementBlockKey && !app.disbursedAt) {
        return {
          stageKey: "DISBURSEMENT",
          actionKey: "ConfirmDisbursement",
          onStart: () => setConfirmingDisbursementObserved(true),
          unavailableReasonKey: chequeDisbursementBlockKey,
        };
      }
      // SCRUM-435: the finance company sends the FULL approved amount, and the
      // dealership pays back the deposit and its contribution first. Until that
      // is settled on the books the transfer is not offered (the server refuses
      // it too); the step names who acts and, when the caller may, offers the
      // recording instead of a dead end.
      // After the transfer the same step reopens ONLY for a returned payment
      // (the stage stays live then); a deal whose forward is settled is never here.
      if (forwardBlocksTransfer) {
        if (deal?.forward?.state === "DUE") {
          return {
            stageKey: "DISBURSEMENT",
            actionKey: "RecordForwardToFinanceCompany",
            onStart: () => setRecordingForward(true),
            unavailableReasonKey: deal.forward.mayRecord ? undefined : "ForwardNeedsPermission",
          };
        }
        return {
          stageKey: "DISBURSEMENT",
          actionKey: "RecordForwardToFinanceCompany",
          onStart: () => undefined,
          // After the transfer only a reported return lands here: the copy must not
          // talk about confirming a transfer that is already confirmed.
          unavailableReasonKey: deal?.forward?.transferConfirmed ? "ForwardReturnedNotSettledReason" : "ForwardNotSettledReason",
        };
      }
      // The currency boundary is named before permission or applicability:
      // it is a fact about the deal that no caller can act on from here.
      if (disbursementDenominationBlock && !app.disbursedAt) {
        return {
          stageKey: "DISBURSEMENT",
          actionKey: "ConfirmDisbursement",
          onStart: () => setConfirmingDisbursementObserved(true),
          unavailableReasonKey: DISBURSEMENT_DENOMINATION_REASON[disbursementDenominationBlock],
          unavailableDetail: disbursementDenominationDetail,
        };
      }
      return {
        stageKey: "DISBURSEMENT",
        actionKey: "ConfirmDisbursement",
        onStart: () => setConfirmingDisbursementObserved(true),
        unavailableReasonKey: disbursementUnavailableReason(
          canConfirmDisbursement,
          canConfirmFinanceDisbursement,
          "DisbursementUnavailable"
        ),
      };
    }

    // Handover first: the step the rail names on a deal whose economics are
    // recorded, and the one the product could not perform at all.
    if (handoverStage && handoverStage.state !== "COMPLETE") {
      return {
        stageKey: "HANDOVER",
        actionKey: "RegisterHandoverAction",
        onStart: () => {
          setConfirmingHandover(true);
        },
        // The server's own precondition, surfaced instead of discovered as a
        // failed submit: `registerVehicleHandover` requires an APPROVED
        // application. A blocked stage keeps its blocker text, which the block
        // already renders, so only the permission gap is added here.
        //
        // SCRUM-417 UX1 (S2): a BLOCKED handover is the server's own verdict
        // (`HandoverBlocked`) that the vehicle cannot be handed over yet, so no
        // register action is offered at all. The prerequisite is named before
        // the permission, as the close's reason does: telling a caller to ask
        // for a permission that would not help is a dead end too.
        //
        // Only while the application is NOT approved: the rail reads the STORED
        // handover status, which re-appraisal and reopen-approval write as
        // BLOCKED, while the server's `registerVehicleHandover` checks only
        // `status === "APPROVED"`. An APPROVED deal with a stale BLOCKED keeps
        // its door, subject to the permission below.
        unavailableReasonKey:
          handoverStage.blocker === "HandoverBlocked" && deal.status !== "APPROVED"
            ? "HandoverBlockedNeedsApproval"
            : hasPermission(PERMISSIONS.REGISTER_VEHICLE_HANDOVER)
              ? undefined
              : "HandoverNeedsPermission",
      };
    }

    // Everything below is only reachable while the application is still
    // APPROVED, because all three of these mutations refuse anything else.
    //
    // A CLOSED deal's money arriving is the DISBURSEMENT stage above, which
    // now carries its own confirmations; SETTLEMENT below is the dealership's
    // own closing steps while the application is still APPROVED.
    if (!settlementStage || settlementStage.state === "COMPLETE") return undefined;
    if (deal.status !== "APPROVED") return undefined;

    // SCRUM-447 B2: a returned/cancelled cheque leaves the payment REGISTERED
    // (as a cheque) with nothing live behind it. Registering again would be
    // refused; the way forward is Correct, offered by the cheque panel above.
    if ("chequeNeedsCorrection" in deal && deal.chequeNeedsCorrection === true) return undefined;
    // SCRUM-447 F6: a CLEARED cheque with no confirmed disbursement is for
    // accounting to review; the panel above says so and the rail offers nothing.
    if ("chequeNeedsAccountingReview" in deal && deal.chequeNeedsAccountingReview === true) return undefined;

    if (!expectedPaymentRegistered) {
      return {
        stageKey: "SETTLEMENT",
        actionKey: "RegisterExpectedPaymentAction",
        onStart: () => {
          setPaymentError(null);
          setRegisteringPayment(true);
        },
        unavailableReasonKey: hasPermission(PERMISSIONS.REGISTER_EXPECTED_PAYMENT)
          ? undefined
          : "ExpectedPaymentNeedsPermission",
      };
    }

    // The close's refusal reason and the route control it points at are
    // derived from two independent queries (`deal` and `app`). Naming the
    // refusal before `app` has arrived would show "choose it here" with
    // nothing to choose from for a render or two, so the step keeps only its
    // blocker until both facts are on hand.
    if (app === undefined) return undefined;

    /**
     * A deal flagged for financing reconciliation (SCRUM-417, G7) — a figure on
     * it could not be trusted when it was derived. `finalizeDeal` refuses on
     * the flag (SCRUM-420, the FINANCING_RECONCILED closing check), and it is
     * the one review the product records; closing posts journals from those
     * figures — so the review comes first. It takes the same permission as the
     * close (`confirm:finance_disbursement`), so it never strands the closer.
     */
    if (app?.needsFinancingReconciliation === true) {
      return {
        stageKey: "SETTLEMENT",
        actionKey: "ResolveReconciliationAction",
        onStart: () => {
          setReconciliationError(null);
          setResolvingReconciliation(true);
        },
        noteKey: "ReconciliationBeforeClose",
        unavailableReasonKey: canCloseDeal ? undefined : "ReconciliationNeedsPermission",
      };
    }

    // `finalizeDeal` refuses FIRST on a waiting deposit request (SCRUM-444
    // DA-03), so it outranks every other reason. Only a payload that carries the
    // field asserts it; an absent field keeps the behaviour below.
    const hasPendingDepositRequest =
      "pendingDepositRequests" in deal && deal.pendingDepositRequests.length > 0;
    const finalizeReasonKey = hasPendingDepositRequest
      ? "FinalizeNeedsPendingDepositRequestResolved"
      : finalizeDenominationBlock
      ? FINALIZE_DENOMINATION_REASON[finalizeDenominationBlock]
      : finalizeUnavailableReasonKey({
          routeRequired: settlementRouteRequired,
          canRecordRoute: canRecordSupplierRoute,
          heldDepositBlocksDirectClose:
            app?.supplierSettlementRoute === "DIRECT_TO_SUPPLIER" &&
            (app.deposits ?? []).some((deposit) => deposit.status === "HELD"),
          readinessBlocksClose:
            closingReadiness !== undefined && closingReadiness.open && closingReadiness.state !== "READY",
          readinessUnreadable: closingReadinessServiceUnavailable,
          canClose: canCloseDeal,
          canReadReadiness: canViewApplications,
        });
    // The same wait as `app` above, for the readiness verdict (S414-R2-SKEW-1,
    // S414-R3-1): the close is offered only under `finalizeAllowedByReadiness`.
    // With no reason to name — a read still in flight, or a verdict that says
    // the deal is no longer open — the step keeps only its blocker meanwhile;
    // a reason that withholds it anyway (a missing route) is shown instead.
    if (finalizeReasonKey === undefined && !finalizeAllowedByReadiness) return undefined;

    return {
      stageKey: "SETTLEMENT",
      actionKey: "FinalizeDealAction",
      onStart: () => {
        setFinalizeError(null);
        setConfirmingFinalize(true);
      },
      /**
       * Two different reasons the close cannot be taken, and the PREREQUISITE
       * is named before the permission.
       *
       * The route is the one that would otherwise have been discovered as a
       * refusal: on a consigned car with an external financier and no route
       * recorded — the ordinary shape of a consigned financed deal —
       * `finalizeDeal` is certain to reject, and the operator only reaches it
       * after handover has already sealed the approved amount. Telling a caller
       * who cannot close anyway that they lack the permission would be true and
       * useless; the deal is not closeable by anyone yet.
       *
       * Recording the route is still done in the review dialog. Saying so is the
       * issue's own minimum bar — a pointer is not as good as the action, but it
       * is not a dead end — and bringing that control across is filed separately
       * rather than folded into this change.
       */
      unavailableReasonKey: finalizeReasonKey,
      unavailableDetail: finalizeDenominationDetail,
      // SCRUM-417 UX1 (S4): the held deposit is resolved in the vehicle's
      // deposit manager, on the vehicles page. Linked only for a caller who
      // can resolve deposits AND open that page; everyone else is told who acts.
      ...(finalizeReasonKey === "FinalizeNeedsHeldDepositResolved"
        ? canResolveDeposits && hasPermission(PERMISSIONS.VIEW_VEHICLES)
          ? { unavailableLink: { href: `/${orgId}/vehicles`, labelKey: "OpenDepositManagerAction" } }
          : { unavailableNoteKey: "DepositManagerNeedsApprover" }
        : {}),
    };
  }

  /**
   * `updateStatus` for the two dealership moves on the credit stage. Not
   * idempotency-keyed, exactly as in Review: the server refuses an illegal
   * transition, so a repeat is a refusal rather than a second effect.
   */
  async function recordCreditStatus(status: "PENDING_DOCS" | "UNDER_REVIEW" | CreditDecision) {
    setCreditSubmitting(true);
    setCreditError(null);
    try {
      await trackRecorded(() => updateStatus({ orgId, applicationId, status }), CREDIT_STATUS_SUCCESS[status], {
        reflectedWhen: creditStatusReflected(status),
      });
      setDecidingCredit(false);
    } catch (error) {
      // "You cannot approve your own application", an illegal transition —
      // each names what to change. Kept in the dialog so it belongs to the
      // attempt that earned it. Localised so a coded refusal (e.g. VEHICLE_DELETED) reads in the
      // user's language.
      const message = getLocalizedErrorMessage(error, t);
      setCreditError(message);
      toast.error(message);
    } finally {
      setCreditSubmitting(false);
    }
  }

  // One key per correction attempt, so a retry after a lost response is the same
  // amendment rather than a second audited one.
  const correctionKeyRef = useRef<string | null>(null);
  // The same discipline for finalization, and it matters more here: the
  // operation this key protects creates the sale and posts its journals.
  const finalizeKeyRef = useRef<string | null>(null);
  // SCRUM-260: finalizing sells at the quote's price, so that is the price
  // whose minimum-profit approval `completeSale` re-proves. A change to the
  // car's list price or minimum after the quote needs a fresh approval, and
  // this is where the operator can ask for it.
  const finalizeSalePrice = app?.quote?.vehiclePrice ?? 0;
  const finalizeProfitApproval = useProfitApproval({
    orgId,
    vehicleId: app?.vehicleId,
    salePrice: finalizeSalePrice,
    // Only the finalizer acts on it, and the status read needs VIEW_VEHICLES: a
    // viewer without both must not subscribe, or the thrown read takes the
    // whole cockpit down. completeSale still re-proves the rule server-side.
    enabled:
      canCloseDeal &&
      hasPermission(PERMISSIONS.VIEW_VEHICLES) &&
      !!app?.quote &&
      app.quote.mode !== "CASH",
    // SCRUM-659: a CASH deal still cannot close on a deleted car.
    livenessOnly:
      canCloseDeal &&
      hasPermission(PERMISSIONS.VIEW_VEHICLES) &&
      !!app?.quote &&
      app.quote.mode === "CASH",
    loading: permissionsLoading || app === undefined,
  });

  // Below every hook, deliberately. An early return placed above `useRef` changes
  // the hook order between renders — eslint's rules-of-hooks caught exactly that
  // here, and the redirect is a render-time courtesy that can wait three lines.
  if (finalizedSaleId) return <Skeleton className="h-64 w-full" />;

  /**
   * The appraisal an approval may actually be based on.
   *
   * The same filter `approveDealerPurchaseAmount` applies when no appraisal is
   * named explicitly: a SUPERSEDED or REJECTED one has been replaced by the
   * finance company and a DEALER_ESTIMATE is the dealership's own opinion, so
   * offering either would put an option on the screen the server exists to
   * refuse.
   */
  const usableAppraisal =
    economics?.appraisals
      .filter(
        (row) =>
          (row.status === "RECORDED" || row.status === "APPROVED") &&
          row.providerType !== "DEALER_ESTIMATE"
      )
      .sort((a, b) => b.appraisedAt - a.appraisedAt)[0] ?? null;

  const financeDecision =
    deal && economicsApp
      ? {
          facts: {
            // From the STAGE RAIL, which the server derives from the unredacted
            // row — not from the amount below, which is also absent when it was
            // redacted. See `FinanceDecisionFacts`.
            approvedPurchaseRecorded:
              deal.stages.find((stage) => stage.key === "APPROVED_PURCHASE")?.state === "COMPLETE",
            submittedQuotationMinor: economicsApp.submittedQuotationMinor ?? null,
            approvedPurchaseAmountMinor: economicsApp.approvedDealerPurchaseAmountMinor ?? null,
            financeCompanyFundedPortionMinor:
              economicsApp.financeCompanyFundedPortionMinor ?? null,
            unfinancedPortionMinor: economicsApp.unfinancedPortionMinor ?? null,
            dealerContributionMinor: economicsApp.dealerContributionMinor ?? null,
            appliedLtvPercent: economicsApp.appliedLtvPercent ?? null,
            closed: economicsApp.status === "CLOSED" || economicsApp.status === "CANCELLED",
            ltvMissing,
            // From the stage rail, like the approval fact above it: once the
            // vehicle has gone out `recordAppraisal` refuses rather than
            // superseding, so the action is withdrawn instead of promising
            // something the server will decline.
            handedOver:
              deal.stages.find((stage) => stage.key === "HANDOVER")?.state === "COMPLETE",
            // The same live appraisal the approval bases are offered against,
            // so the row and those options can never disagree about whether one
            // exists.
            appraisalAmountMinor: usableAppraisal?.appraisalAmountMinor ?? null,
          } satisfies FinanceDecisionFacts,
          currency: economicsApp.economicsCurrency ?? null,
          canRecordQuotation: hasPermission(PERMISSIONS.CREATE_FINANCE_APPLICATION),
          canRecordApproval: hasPermission(PERMISSIONS.APPROVE_FINANCE_APPLICATION),
          /**
           * Establishing this deal's own LTV is a NARROWER authority than
           * approving it (SCRUM-117, owner-proxy ruling 2026-09-13 15:33).
           *
           * `recordSubmittedQuotation` and `approveDealerPurchaseAmount` both
           * now require BOTH `view:finance` and `approve:finance_application`
           * for an explicit rate, because a role that may WRITE the rate and
           * may SEE the resulting quotation can solve for the operands it may
           * not read. So the two capabilities separate here as well: a default
           * MANAGER still records approvals on an established rate, and is no
           * longer offered a field whose entry the server would refuse.
           *
           * Derived from the same permissions the server checks rather than
           * from `canRecordApproval`, because deriving one capability from
           * another is precisely how the screen and the boundary drift apart.
           */
          canEstablishLtvPercent:
            hasPermission(PERMISSIONS.APPROVE_FINANCE_APPLICATION) &&
            hasPermission(PERMISSIONS.VIEW_FINANCE),
          approvedAmountIsFarFromEvidence: economics?.approvedAmountIsFarFromEvidence ?? false,
          // What `recordAppraisal` itself requires for a finance-company or
          // independent appraisal. The dealer-estimate branch takes a different
          // permission and is not offered here.
          canRecordAppraisal: hasPermission(PERMISSIONS.REVIEW_FINANCE_APPLICATION),
          // The server refuses the application's own salesperson outright. Said
          // here so it reads as a rule rather than as a failure.
          isOwnDeal: membership?.userId === economicsApp.salespersonId,
          // Three states, never two. "Still loading" collapsed into "no
          // calculation exists" would let the dialog label a figure
          // MANUAL_ENTRY — a claim about provenance — during the window before
          // the suggestion arrives.
          calculation: toQuotationCalculation(canOfferQuotation, suggestion),
          appraisal: usableAppraisal
            ? { id: usableAppraisal._id as string, amountMinor: usableAppraisal.appraisalAmountMinor }
            : null,
          onRecordAppraisal: async (values: {
            appraisalAmountMinor: number;
            providerType: AppraisalProviderType;
            providerName?: string;
            appraisedAt: number;
            reappraisalReason?: string;
          }) => {
            await recordAppraisal({ orgId, applicationId, ...values });
          },
          onRecordQuotation: async (values: {
            submittedQuotationMinor: number;
            source: "SYSTEM_CALCULATED" | "MANUAL_ENTRY" | "CALCULATED_WITH_OVERRIDE";
            overrideReason?: string;
            ltvPercent?: number;
          }) => {
            await recordSubmittedQuotation({ orgId, applicationId, ...values });
          },
          onRecordApproved: async (values: {
            approvedAmountMinor: number;
            basis: ApprovalBasis;
            appraisalId?: string;
            notes?: string;
            outlierAcknowledged?: boolean;
          }) => {
            await approveDealerPurchaseAmount({
              orgId,
              applicationId,
              approvedAmountMinor: values.approvedAmountMinor,
              basis: values.basis,
              appraisalId: values.appraisalId as Id<"financeAppraisals"> | undefined,
              notes: values.notes,
              outlierAcknowledged: values.outlierAcknowledged,
            });
          },
          onReopenApproved: async (values: { reason: string }) => {
            await reopenApproval({ orgId, applicationId, reason: values.reason });
          },
          // SCRUM-373 D2: offered only on the server's own verdict.
          firstPaymentCorrection:
            deal.firstPaymentCorrection?.block === null &&
            deal.firstPaymentCorrection.quoteDownPaymentMinor !== null
              ? {
                  quoteDownPaymentMinor: deal.firstPaymentCorrection.quoteDownPaymentMinor,
                  economicsStamp: deal.economicsStamp,
                }
              : null,
          onApplyQuoteFirstPayment: async (values: { reason: string; economicsStamp: string }) => {
            await applyQuoteFirstPayment({
              orgId,
              applicationId,
              economicsStamp: values.economicsStamp,
              reason: values.reason,
            });
          },
        }
      : undefined;

  /**
   * عهدة الموظف — read AND acted on from this screen. The summary comes off
   * the bounded `listDealCosts` read; each record's movement log is a separate
   * paginated query, mounted only when the operator opens it. The commands
   * post through the custody clearing account and are offered only to a
   * caller holding CONFIRM_FINANCE_DISBURSEMENT; the server's readiness
   * verdict travels with the read so a dead button says why.
   *
   * Identity discipline, same as the handover costs: an issuance, a movement
   * and a closure each mint one command identity per dialog ATTEMPT — the
   * dialog's `intentId`, never the figures (R8) — and retire it on success,
   * on the server's own refusal, or when the operator abandons the dialog. A
   * lost response keeps it so the operator's retry replays rather than pays
   * twice; and because the figures are not in the key, a corrected figure on
   * that retry is refused by the server's fingerprint instead of becoming a
   * second payment, while a dialog opened again later for the same figures
   * is a new command rather than a silent replay of the first.
   */
  const custodyMoney = (minor: number, currency: string) =>
    `${(minor / Math.pow(10, safeScaleForCurrency(currency, 2))).toLocaleString()} ${
      currency === orgCurrency.code ? currencyMarker(currency) : currency
    }`;
  // One intent per dialog attempt. The deal, record and kind are named for
  // legibility only; the attempt's `intentId` is what makes it one command.
  const openCustodyIntent = (intentId: string) => `open-custody:${applicationId}:${intentId}`;
  const custodyMoveIntent = (custodyId: string, kind: string, intentId: string) => `custody-move:${custodyId}:${kind}:${intentId}`;
  const custodyCloseIntent = (custodyId: string, intentId: string) => `custody-close:${custodyId}:${intentId}`;
  const custodyCommand = async (intent: string, work: (idempotencyKey: string) => Promise<unknown>) => {
    try {
      await work(commandId.for(intent));
      commandId.retire(intent);
      toast.success(t("CustodySaved"));
    } catch (error) {
      // The server's own refusal rolled back and nothing committed: the next
      // attempt is a new command. Anything else may have landed; keep the key.
      if (isConvexError(error)) commandId.retire(intent);
      throw new Error(getErrorMessage(error));
    }
  };
  const custodyPlain = async (work: () => Promise<unknown>) => {
    try {
      await work();
      toast.success(t("CustodySaved"));
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  };
  const custodyActions: DealCustodyActions | undefined =
    app && custodyCommandsOffered
      ? {
          members: custodyCandidates?.candidates,
          eligibleFees: (dealCosts?.fees ?? [])
            .filter((fee) => fee.custodyEligible && fee.custodyId === undefined && fee.actualAmountMinor !== undefined && fee.actualAmountMinor > 0)
            .map((fee) => ({
              _id: fee._id,
              label: fee.description?.trim() || t(FEE_TYPE_LABEL[fee.feeType] ?? fee.feeType),
              actualAmountMinor: fee.actualAmountMinor as number,
              currency: fee.currency,
            })),
          scaleOf: (cur: string) => safeScaleForCurrency(cur, 3),
          onPlan: (values) =>
            custodyPlain(() =>
              planCustodyHandler({
                orgId,
                applicationId,
                userId: values.userId,
                amountMinor: values.amountMinor,
                note: values.note,
              })
            ),
          onClearPlan: () => custodyPlain(() => planCustodyHandler({ orgId, applicationId })),
          onOpen: (values) =>
            custodyCommand(openCustodyIntent(values.intentId), (idempotencyKey) =>
              openDealCustody({
                orgId,
                applicationId,
                userId: values.userId,
                issuedMinor: values.amountMinor,
                method: values.method,
                reference: values.reference,
                note: values.note,
                occurredAt: values.occurredAt,
                idempotencyKey,
              })
            ),
          onMove: (custodyId, kind, values) =>
            custodyCommand(custodyMoveIntent(custodyId, kind, values.intentId), (idempotencyKey) =>
              recordCustodyMovement({
                orgId,
                custodyId,
                kind,
                amountMinor: values.amountMinor,
                method: values.method,
                reference: values.reference,
                note: values.note,
                occurredAt: values.occurredAt,
                idempotencyKey,
              })
            ),
          onReverse: (custodyId, movement, reason) =>
            custodyCommand(`custody-reverse:${custodyId}:${movement.entryId}`, (idempotencyKey) =>
              recordCustodyMovement({
                orgId,
                custodyId,
                kind: "REVERSAL",
                reversesEntryId: movement.entryId,
                amountMinor: movement.amountMinor,
                note: reason,
                idempotencyKey,
              })
            ),
          onAttach: (custodyId, feeId) =>
            custodyPlain(() =>
              setFeeCustody({ orgId, feeId, custodyId })
            ),
          onClose: (custodyId, values) =>
            // A closure is a command like a movement: it may post a write-off,
            // and a lost response must replay rather than refuse on the
            // closure it already made — so it carries a key the same way.
            custodyCommand(custodyCloseIntent(custodyId, values.intentId), (idempotencyKey) =>
              reconcileDealCustody({
                orgId,
                custodyId,
                notes: values.notes,
                writeOffReason: values.writeOffReason,
                idempotencyKey,
              })
            ),
          onReopen: (custodyId, reason) =>
            custodyPlain(() => reopenDealCustody({ orgId, custodyId, reason })),
          // The dialog was abandoned with its command not having succeeded:
          // its identity is over, so a later genuine command with the same
          // figures can never replay it.
          onAbandonOpen: (intentId) => commandId.retire(openCustodyIntent(intentId)),
          onAbandonMove: (custodyId, kind, intentId) => commandId.retire(custodyMoveIntent(custodyId, kind, intentId)),
          onAbandonClose: (custodyId, intentId) => commandId.retire(custodyCloseIntent(custodyId, intentId)),
        }
      : undefined;
  const custody: DealCustodyWiring | undefined =
    app && deal
      ? {
          loading: permissionsLoading || (canViewApplications && dealCosts === undefined),
          records: dealCosts?.custody,
          truncated: dealCosts?.custodyTruncated ?? false,
          currency: dealCosts?.currency ?? economicsCurrencyCode,
          expectedTotalMinor: dealCosts?.expected?.expectedTotalMinor ?? null,
          accounting: dealCosts?.custodyAccounting,
          plannedCustody: dealCosts?.plannedCustody ?? null,
          plannedCustodyWithheld: dealCosts?.plannedCustodyWithheld ?? false,
          recommended: dealCosts?.recommendedCustody ?? null,
          openPeriodToday: dealCosts?.custodyPostsNow,
          reopenLocked: unwindBars,
          dealStopped:
            // The issuing commands' own predicate, when the read has it;
            // the local status check stays as the fallback while it loads.
            (dealCosts?.acceptsNewCustodyCash?.accepts === false) ||
            (dealCosts?.economicsFrozen?.frozen ?? false) ||
            app.status === "CLOSED" ||
            app.status === "CANCELLED" ||
            app.status === "REJECTED",
          actions: custodyActions,
          renderMovements: (custodyId, onReverse) => {
            const record = dealCosts?.custody.find((row) => row._id === custodyId);
            return (
              <CustodyMovementsList
                orgId={orgId}
                custodyId={custodyId}
                currency={record?.currency ?? dealCosts?.currency ?? economicsCurrencyCode}
                money={custodyMoney}
                formatDate={(ms: number) => renderMoment(ms, "d MMM yyyy", locale)}
                t={t}
                onReverse={onReverse}
              />
            );
          },
        }
      : undefined;

  // Built here, after `financeDecision`, because the decision-card steps read it.
  const workflowAction = buildWorkflowAction();

  return (
    <>
      <DealCockpitView
      deal={deal}
      stageDeepLink={stageDeepLink}
      backHref={`/${orgId}/deals`}
      financeDecision={financeDecision}
      // The step's panel can still arrive only while what it is built from is
      // unanswered. Queries a caller cannot run are skipped (they stay undefined
      // for good), so each is counted only when this caller runs it.
      workbenchPending={permissionsLoading || app === undefined || (canViewApplications && economics === undefined)}
      financingPlan={financingPlan ? { facts: financingPlan, formatMajor: formatPlanMajor } : undefined}
      handoverCosts={handoverCosts}
      financialOverview={deal ? { data: overview ?? undefined, loading: overview === undefined } : undefined}
      custody={custody}
      custodyMoney={custodyMoney}
      workflowAction={workflowAction}
      // Both are financed-only and come straight off the wrapper's payload.
      // `?? null` / `?? false` cover the loading and unreadable cases, where
      // `deal` is `undefined` or `null` and the screen must not assert either.
      activeAppraisalProvider={deal?.activeAppraisalProvider ?? null}
      depositAwaitingResolution={deal?.pendingDepositResolution ?? false}
      depositRequests={
        deal && "pendingDepositRequests" in deal
          ? { orgId, requests: deal.pendingDepositRequests }
          : undefined
      }
      creditDecision={{
        deciding: decidingCredit,
        submitting: creditSubmitting,
        error: creditError,
        canApprove: canApproveApplication,
        canReject: canReviewApplication,
        isOwnDeal: membership?.userId != null && membership.userId === app?.salespersonId,
        documentsIncomplete,
        onOpenChange: setDecidingCredit,
        onSubmit: recordCreditStatus,
      }}
      cancel={
        canCancel
          ? {
              isClosed: app?.status === "CLOSED",
              confirming: cancelling,
              submitting: cancelSubmitting,
              error: cancelError,
              onOpenChange: setCancelling,
              onSubmit: async (values: CancelApplicationValues) => {
                setCancelSubmitting(true);
                setCancelError(null);
                try {
                  cancelKeyRef.current ??= `cancel-application:${crypto.randomUUID()}`;
                  await cancelApplication({
                    orgId,
                    applicationId,
                    reason: values.reason,
                    failureReason: values.failureReason as any,
                    appraisalFeeResponsibility: values.appraisalFeeResponsibility as any,
                    appraisalFeeResponsibilityReason: values.appraisalFeeResponsibilityReason,
                    idempotencyKey: cancelKeyRef.current,
                  });
                  cancelKeyRef.current = null;
                  toast.success(t("AppCancelledSuccess"));
                  setCancelling(false);
                } catch (error) {
                  // "Disbursement funds already confirmed received" is the one
                  // refusal an operator can do nothing about here; it says so.
                  const message = getLocalizedErrorMessage(error, t);
                  setCancelError(message);
                  toast.error(message);
                } finally {
                  setCancelSubmitting(false);
                }
              },
            }
          : undefined
      }
      unwind={
        app?.status === "CLOSED" && unwindStatus
          ? {
                status: unwindStatus as UnwindStatusView,
                offered: unwindOffered,
                hint: unwindHint ? { code: unwindHint.code, message: unwindHint.message } : undefined,
                open: unwindOpen,
                submitting: unwindSubmitting,
                error: unwindError,
                formatMinor: (minor: number) => custodyMoney(minor, economicsCurrencyCode),
                notBefore: app.disbursedAt,
                onOpenChange: (next: boolean) => {
                  setUnwindOpen(next);
                  if (next) setUnwindError(null);
                  // A closed dialog ends its attempt: its key is retired so a later one starts clean.
                  else unwindKeyRef.current = null;
                },
                onStart: async (reason: string) => {
                  await runUnwind("start", "UnwindStartedSuccess", (idempotencyKey) =>
                    startDealUnwind({ orgId, applicationId, reason, idempotencyKey })
                  );
                },
                onForwardReturn: async (values: { returnedAt: number; reference: string }) => {
                  await runUnwind("forward", "UnwindForwardRecordedSuccess", (idempotencyKey) =>
                    recordDealUnwindForwardReturn({
                      orgId,
                      unwindId: unwindStatus.unwindId!,
                      returnedAt: values.returnedAt,
                      reference: values.reference,
                      idempotencyKey,
                    })
                  );
                },
                onFinish: async (values: UnwindFinishValues) => {
                  const done = await runUnwind("finish", "UnwindFinishedSuccess", (idempotencyKey) =>
                    finishDealUnwind({ orgId, unwindId: unwindStatus.unwindId!, ...values, idempotencyKey })
                  );
                  if (done) setUnwindOpen(false);
                },
                onAbandon: async (reason: string) => {
                  const done = await runUnwind("abandon", "UnwindAbandonedSuccess", (idempotencyKey) =>
                    abandonDealUnwind({ orgId, unwindId: unwindStatus.unwindId!, reason, idempotencyKey })
                  );
                  if (done) setUnwindOpen(false);
                },
              }
          : undefined
      }
      forwardCorrection={
        deal?.forward?.planV2 === true &&
        deal.forward.mayRecord === true &&
        deal.forward.onBooksForwardId &&
        // A live unwind owns the forward payment: the server refuses either correction meanwhile.
        !unwindBars
          ? {
              canVoid: deal.forward.transferConfirmed !== true,
              open: forwardCorrection,
              submitting: forwardCorrectionSubmitting,
              onOpen: setForwardCorrection,
              onClose: () => setForwardCorrection(null),
              onConfirm: async (reason: string) => {
                const forwardId = deal.forward?.onBooksForwardId;
                const kind = forwardCorrection;
                if (!forwardId || !kind) return;
                // A VOID dialog opened before the transfer was confirmed must not submit after it.
                if (kind === "VOID" && deal.forward?.transferConfirmed === true) {
                  toast.error(t("ForwardVoidAfterTransfer"));
                  setForwardCorrection(null);
                  return;
                }
                setForwardCorrectionSubmitting(true);
                const intent = `forward-correction:${kind}:${applicationId}:${forwardId}:${reason}`;
                try {
                  if (kind === "VOID") {
                    await reverseFinanceCompanyForward({
                      orgId,
                      applicationId,
                      forwardId,
                      reason,
                      idempotencyKey: commandId.for(intent),
                    });
                  } else {
                    await reportFinanceCompanyForwardReturned({
                      orgId,
                      applicationId,
                      forwardId,
                      reason,
                      idempotencyKey: commandId.for(intent),
                    });
                  }
                  commandId.retire(intent);
                  toast.success(t("ForwardCorrectionSuccess"));
                  setForwardCorrection(null);
                } catch (error) {
                  if (isConvexError(error)) commandId.retire(intent);
                  toast.error(getErrorMessage(error));
                } finally {
                  setForwardCorrectionSubmitting(false);
                }
              },
            }
          : undefined
      }
      chequeReturn={
        deal?.disbursementReturn?.mayReturn === true &&
        deal.disbursementReturn.chequeId &&
        deal.forward?.transferConfirmed === true
          ? {
              open: chequeReturnOpen,
              submitting: chequeReturnSubmitting,
              onOpen: () => {
                chequeReturnKeyRef.current = null;
                setChequeReturnOpen(true);
              },
              onClose: () => {
                chequeReturnKeyRef.current = null;
                setChequeReturnOpen(false);
              },
              onConfirm: async (reason: string) => {
                const chequeId = deal.disbursementReturn?.chequeId;
                if (!chequeId) return;
                // The version being returned: the one this screen observes now.
                // Undefined while `app` is not loaded: no version was observed, so
                // nothing may be cleared on the strength of it (`?? 1` would lie).
                // A LOADED app without the field is version 1.
                const returnedVersion = appObserved ? observedDisbursementVersion : undefined;
                setChequeReturnSubmitting(true);
                const chequeGeneration = confirmGenerationRef.current;
                const chequeSuperseded = () => confirmGenerationRef.current !== chequeGeneration;
                // One key per dialog open: a retry after a lost response is the SAME command.
                if (chequeReturnKeyRef.current?.reason !== reason) {
                  chequeReturnKeyRef.current = { key: `return-fc-cheque:${crypto.randomUUID()}`, reason };
                }
                const { key } = chequeReturnKeyRef.current;
                try {
                  await trackRecorded(
                    () =>
                      returnFinanceDisbursementCheque({
                        orgId,
                        applicationId,
                        chequeId,
                        returnReason: reason,
                        idempotencyKey: key,
                      }),
                    "ChequeReturnedByBankSuccess",
                    // The disbursement is gone from the application AND this cheque is the newest returned one.
                    { reflectedWhen: disbursementReturnReflected(chequeId) }
                  );
                  // A late answer for deal A must not drop B's kept key or owed notice.
                  if (chequeSuperseded()) return;
                  chequeReturnKeyRef.current = null;
                  // The return reopens the deal for the NEXT disbursement version.
                  // A confirm key kept after a lost response belongs to the
                  // disbursement just returned; reusing it would make the server
                  // replay that old result and never record the next one.
                  confirmDisbursementKeyRef.current = null;
                  // Round 7: the outcome of a lost confirm at this version is now
                  // KNOWN. The server returns a cheque only for a confirmed
                  // disbursement: convex/applications.ts returnFinanceDisbursementCheque
                  // refuses FINANCE_RETURN_NOT_DISBURSED unless disbursedAt and
                  // disbursedAmountMinor are set (5356-5358) and FINANCE_RETURN_
                  // CHEQUE_NOT_CLEARED unless the cheque is CLEARED (5361), bound to
                  // that disbursement at the same version and instant (5371-5380).
                  // So no "result not known" notice is owed for that version. Cleared
                  // here, before `chequeReturnSubmitting` resets and lets the
                  // reconcile effect run.
                  if (returnedVersion !== undefined && confirmUnknownOutcomeVersionRef.current === returnedVersion) {
                    confirmUnknownOutcomeVersionRef.current = null;
                  }
                  setChequeReturnOpen(false);
                } catch (error) {
                  if (chequeSuperseded()) return;
                  // The server answered: the next attempt is a new command. A lost response keeps the key.
                  if (isConvexError(error)) chequeReturnKeyRef.current = null;
                  toast.error(getLocalizedErrorMessage(error, t));
                } finally {
                  if (!chequeSuperseded()) setChequeReturnSubmitting(false);
                }
              },
            }
          : undefined
      }
      cancelHint={cancelHint}
      settlementRoute={
        canChooseSettlementRoute && app
          ? {
              route: app.supplierSettlementRoute as SupplierSettlementRoute | undefined,
              canSettleDirectToSupplier: app.canSettleDirectToSupplier,
              directRouteRefusal: app.directRouteRefusal as DirectRouteRefusal,
              supplierName,
              onChoose: async (route) => {
                try {
                  await setSupplierSettlementRoute({ orgId, applicationId, route });
                } catch (error) {
                  // No finance company, or a held deposit that has to be
                  // settled first — both name what to do next.
                  toast.error(getErrorMessage(error));
                }
              },
            }
          : undefined
      }
      documents={{
        items: documents?.map((doc) => ({
          _id: doc._id,
          ruleId: doc.ruleId,
          ruleName: doc.ruleName,
          status: doc.status,
          fileUrl: doc.fileUrl,
        })),
        history: documentHistory?.flatMap((doc) => {
          const uploadedAt = doc.uploadedAt ?? undefined;
          return doc.fileUrl
            ? [
                {
                  _id: doc._id,
                  ruleName: doc.ruleName,
                  status: doc.status,
                  fileUrl: doc.fileUrl,
                  uploadedLabel: isRenderableMoment(uploadedAt) ? formatLocalized(uploadedAt, "d MMM yyyy", locale) : null,
                },
              ]
            : [];
        }),
        // The server accepts an upload from either permission; verifying is
        // the narrower one. Same gates as Review, read from the same server.
        // A CLOSED or CANCELLED deal's documents are settled record (SCRUM-422):
        // the server refuses every write there, so none is offered.
        canUpload: !documentsSettled && (canCreateApplication || canVerifyDocuments),
        canVerify: !documentsSettled && canVerifyDocuments,
        uploadingRuleIds,
        onUpload: async (doc, file) => {
          if (uploadsInFlightRef.current.has(doc.ruleId)) return;
          uploadsInFlightRef.current.add(doc.ruleId);
          setUploadingRuleIds(new Set(uploadsInFlightRef.current));
          // The stored file (`_storage` id) this upload produces: what identifies it
          // on the documents read model, unlike a timestamp two uploads can share.
          let storedFileId: string | undefined;
          try {
            // Tracked from the START, so a row the read model already moved
            // while the file was uploading still counts as reflected (S7).
            await trackRecorded(async () => {
            // A rule added after the application was created has no row yet
            // (SCRUM-421): create it first, under the same authority as the
            // upload. Idempotent, so a retry lands on the same row.
            const documentId =
              doc._id ??
              (await ensureApplicationDocument({
                orgId,
                applicationId,
                ruleId: doc.ruleId as Id<"companyDocumentRules">,
              }));
            // Named, so a deal that settled meanwhile gets no URL and no file
            // is stored for a row the server would refuse (SCRUM-422).
            const postUrl = await generateUploadUrl({
              orgId,
              documentId: documentId as Id<"applicationDocuments">,
              mimeType: file.type,
              sizeInBytes: file.size,
            });
            const result = await fetch(postUrl, {
              method: "POST",
              headers: { "Content-Type": file.type },
              body: file,
            });
            const { storageId } = await result.json();
            storedFileId = typeof storageId === "string" ? storageId : undefined;
            await saveDocumentFile({
              orgId,
              documentId: documentId as Id<"applicationDocuments">,
              fileId: storageId,
            });
            }, "UploadSuccess", {
              isDocumentAction: true,
              documentRuleId: doc.ruleId,
              // This rule's row carries the new file -- not "the list changed":
              // another operator's verify, or the rule list reordering when a
              // row-less rule is materialized, must not release the line.
              reflectedWhen: uploadReflected(doc.ruleId, () => storedFileId),
            });
          } catch (error) {
            toast.error(getErrorMessage(error));
          } finally {
            uploadsInFlightRef.current.delete(doc.ruleId);
            setUploadingRuleIds(new Set(uploadsInFlightRef.current));
          }
        },
        onVerify: async (documentId) => {
          const documentRuleId = documents?.find((doc) => doc._id === documentId)?.ruleId;
          try {
            await trackRecorded(
              () =>
                updateDocStatus({
                  orgId,
                  documentId: documentId as Id<"applicationDocuments">,
                  status: "VERIFIED",
                }),
              "DocVerified",
              {
                isDocumentAction: true,
                documentRuleId: documentRuleId,
                reflectedWhen: verifyReflected(documentRuleId),
              }
            );
          } catch (error) {
            toast.error(getErrorMessage(error));
          }
        },
      }}
      deposits={
        showApplicationDeposits
          ? {
              items: applicationDeposits,
              canResolve: canResolveDeposits,
              // Withheld — with a reason on the panel — whenever face value is
              // not provably the releasable value.
              faceValueIsReleasable: !quoteHasCommittedMoney,
              resolvingId: resolvingDepositId,
              unconfirmed: pendingPayouts.blocked,
              onDismissUnconfirmed: pendingPayouts.dismiss,
              onResolve: async (depositId, resolution, refundMethod, observedReleaseCount) => {
                const method = resolution === "REFUNDED" ? refundMethod : "NONE";
                // A DIFFERENT decision than an unconfirmed earlier attempt is not
                // sent: it would mint a new key and could pay out twice. The panel
                // shows the reconciliation notice instead.
                const gate = pendingPayouts.check(depositId, resolution, String(method));
                if (gate.status === "blocked") return;
                const releaseIntent =
                  gate.recordedIntent ??
                  `release-deposit:${depositId}:${resolution}:${method}:gen${observedReleaseCount}`;
                pendingPayouts.record(depositId, { resolution, method: String(method), intent: releaseIntent });
                setResolvingDepositId(depositId);
                try {
                  await trackRecorded(
                    () =>
                      releaseDeposit({
                        orgId,
                        depositId: depositId as Id<"deposits">,
                        resolution,
                        refundMethod: resolution === "REFUNDED" ? refundMethod : undefined,
                        idempotencyKey: commandId.for(releaseIntent),
                      }),
                    resolution === "REFUNDED" ? "DepositRefundedSuccess" : "DepositForfeitedSuccess",
                    // The deposit's own release counter moved past the one the
                    // dialog observed; nothing else on the deal proves it.
                    { reflectedWhen: depositReleaseReflected(depositId, observedReleaseCount) }
                  );
                  commandId.retire(releaseIntent);
                  pendingPayouts.confirm(depositId);
                } catch (error) {
                  pendingPayouts.settleFailure(depositId, error, releaseIntent);
                  toast.error(getErrorMessage(error));
                  throw error;
                } finally {
                  setResolvingDepositId(null);
                }
              },
            }
          : undefined
      }
      disbursement={
        app
          ? {
              financeCompany: {
                confirming: confirmingDisbursement,
                submitting: disbursementSubmitting,
                amountLabel: expectedDisbursementLabel,
                onOpenChange: setConfirmingDisbursementObserved,
                onConfirm: async () => {
                  if (!expectedDisbursementMinor) return;
                  // The version captured when the dialog OPENED, not the one the
                  // screen shows now (the dialog closes itself if that moves).
                  // Held in the closure so this request's answer, however late,
                  // is judged against ITS version.
                  const observedVersion = confirmObservedVersion;
                  // Round 7 defence: an owed notice for another version is never
                  // dropped by minting a new key. The reconcile effect normally
                  // shows it first; it can only still be owed here while an own
                  // cheque return was in flight and holding the effect back. The
                  // notice tells the operator to review receipts and cheque history
                  // BEFORE confirming again, so this click sends nothing: the mark
                  // and kept key are cleared, and the next click mints a fresh key
                  // at the observed version. (Nothing is stuck by returning here:
                  // `disbursementSubmitting` is only set below.)
                  if (
                    confirmUnknownOutcomeVersionRef.current !== null &&
                    confirmUnknownOutcomeVersionRef.current !== observedVersion
                  ) {
                    confirmUnknownOutcomeVersionRef.current = null;
                    confirmDisbursementKeyRef.current = null;
                    toast.error(t("DisbursementChangedOutcomeUnknown"));
                    return;
                  }
                  // Round 6: an EARLIER send of the kept key at this version whose
                  // answer was lost. Read before this send re-marks the ref. A fresh
                  // key (a version move or a retired stale key) never inherits it: a
                  // version move clears the mark via the effect, and the stale path
                  // below clears it explicitly.
                  const priorUnknown =
                    confirmDisbursementKeyRef.current !== null &&
                    confirmDisbursementKeyVersionRef.current === observedVersion &&
                    confirmUnknownOutcomeVersionRef.current === observedVersion;
                  setDisbursementSubmitting(true);
                  const generation = confirmGenerationRef.current;
                  const superseded = () => confirmGenerationRef.current !== generation;
                  try {
                    if (confirmDisbursementKeyVersionRef.current !== observedVersion) {
                      confirmDisbursementKeyRef.current = null;
                    }
                    confirmDisbursementKeyVersionRef.current = observedVersion;
                    confirmDisbursementKeyRef.current ??= `confirm-disbursement:${crypto.randomUUID()}`;
                    const disbursementKey = confirmDisbursementKeyRef.current;
                    // Sent: until the server answers, the outcome is unknown here.
                    confirmUnknownOutcomeVersionRef.current = observedVersion;
                    await trackRecorded(
                      () =>
                        confirmDisbursement({
                          orgId,
                          applicationId,
                          disbursedAmountMinor: expectedDisbursementMinor,
                          idempotencyKey: disbursementKey,
                          // The version the dialog observed: the server refuses a
                          // confirm whose version it has since moved past. Sent ONLY
                          // above 1: the frontend deploys on merge but the Convex
                          // backend deploys by hand, and Convex rejects an undeclared
                          // argument, so a v1 confirm must look exactly like the old
                          // call. The server already refuses an omitted value at v2+.
                          ...(observedVersion > 1 ? { expectedDisbursementVersion: observedVersion } : {}),
                        }),
                      "DisbursementConfirmedSuccess",
                      { reflectedWhen: financeDisbursementReflected }
                    );
                    // The deal was switched while this was in flight: its answer
                    // belongs to deal A and must not touch deal B's state.
                    if (superseded()) return;
                    // The server answered: the outcome of THIS request is known.
                    if (confirmUnknownOutcomeVersionRef.current === observedVersion) {
                      confirmUnknownOutcomeVersionRef.current = null;
                    }
                    // A late answer to an OLD attempt must not touch a dialog
                    // reopened at a newer version (its key, its open state).
                    if (confirmObservedVersionRef.current === observedVersion) {
                      confirmDisbursementKeyRef.current = null;
                      setConfirmingDisbursement(false);
                    }
                  } catch (error) {
                    if (superseded()) return;
                    // A server answer (a ConvexError) means the request was
                    // refused and nothing committed; anything else is a lost
                    // response whose outcome stays unknown.
                    const answeredByServer = isConvexError(error);
                    // ...but only for a send with no earlier unknown send of this key.
                    if (answeredByServer && !priorUnknown && confirmUnknownOutcomeVersionRef.current === observedVersion) {
                      confirmUnknownOutcomeVersionRef.current = null;
                    }
                    // A stale-version refusal is final for this key: the next click
                    // (after the screen refreshes) mints a fresh one.
                    const refusedCode = answeredByServer
                      ? (error.data as { code?: unknown } | null)?.code
                      : undefined;
                    const isStale = refusedCode === "FINANCE_CONFIRM_STALE_REQUEST";
                    const current = confirmObservedVersionRef.current === observedVersion;
                    if (isStale && current) {
                      confirmDisbursementKeyRef.current = null;
                      // The dialog was prepared against a version that is gone:
                      // reopening it observes the current one.
                      setConfirmingDisbursement(false);
                    }
                    if (isStale && !current) {
                      // A late answer to a superseded attempt: its dialog is gone
                      // and a newer one is open; say nothing about it.
                      return;
                    }
                    if (isStale && priorUnknown) {
                      // An earlier send of this key may have committed, so "nothing
                      // has been changed" would be untrue. The notice is owed only
                      // while the mark still stands: if the version-move effect
                      // already showed it and cleared the mark, say nothing more
                      // (the stale text claims nothing changed). Otherwise show it
                      // now and drop the mark so the effect cannot repeat it.
                      if (confirmUnknownOutcomeVersionRef.current === observedVersion) {
                        confirmUnknownOutcomeVersionRef.current = null;
                        toast.error(t("DisbursementChangedOutcomeUnknown"));
                      }
                      return;
                    }
                    toast.error(getLocalizedErrorMessage(error, t));
                  } finally {
                    if (!superseded()) setDisbursementSubmitting(false);
                  }
                },
              },
              forward:
                deal?.forward?.applies === true && deal.money?.forward
                  ? {
                      confirming: recordingForward,
                      submitting: forwardSubmitting,
                      totalLabel: formatEconomics(deal.money.forward.dueMinor),
                      depositLabel: formatEconomics(deal.money.forward.depositMinor),
                      contributionLabel: formatEconomics(deal.money.forward.contributionMinor),
                      onOpenChange: setRecordingForward,
                      onConfirm: async (values) => {
                        const dueMinor = deal.money?.forward?.dueMinor;
                        if (!dueMinor) return;
                        setForwardSubmitting(true);
                        // One key per attempt: a retry after a lost response is the
                        // SAME command, and a changed input is a new one.
                        const intent = `record-forward:${applicationId}:${dueMinor}:${values.method}:${values.paidAt}:${values.reference ?? ""}`;
                        try {
                          await recordFinanceCompanyForward({
                            orgId,
                            applicationId,
                            method: values.method,
                            paidAt: values.paidAt,
                            expectedAmountMinor: dueMinor,
                            reference: values.reference,
                            idempotencyKey: commandId.for(intent),
                          });
                          commandId.retire(intent);
                          toast.success(t("ForwardRecordedSuccess"));
                          setRecordingForward(false);
                        } catch (error) {
                          if (isConvexError(error)) commandId.retire(intent);
                          toast.error(getErrorMessage(error));
                        } finally {
                          setForwardSubmitting(false);
                        }
                      },
                    }
                  : undefined,
              supplier: {
                confirming: confirmingSupplierDisbursement,
                submitting: disbursementSubmitting,
                supplierName,
                // The approved purchase amount — what the company approved to
                // pay for the CAR — labelled in the currency it is denominated
                // in, or "not recorded" rather than a confident zero.
                amountLabel:
                  app.approvedDealerPurchaseAmountMinor !== undefined
                    ? formatEconomics(app.approvedDealerPurchaseAmountMinor)
                    : t("NotRecorded"),
                defaultAmountMajor:
                  app.approvedDealerPurchaseAmountMinor !== undefined
                    ? app.approvedDealerPurchaseAmountMinor / economicsFactor
                    : undefined,
                onOpenChange: setConfirmingSupplierDisbursement,
                onConfirm: async (advice) => {
                  setDisbursementSubmitting(true);
                  const generation = confirmGenerationRef.current;
                  const superseded = () => confirmGenerationRef.current !== generation;
                  try {
                    confirmSupplierDisbursementKeyRef.current ??= `confirm-supplier-disbursement:${crypto.randomUUID()}`;
                    const supplierDisbursementKey = confirmSupplierDisbursementKeyRef.current;
                    await trackRecorded(
                      () =>
                        confirmSupplierDisbursement({
                          orgId,
                          applicationId,
                          // Scaled by the APPLICATION's pinned economics currency —
                          // this figure lives in that block.
                          disbursedAmountMinor: Math.round(advice.amountMajor * economicsFactor),
                          reference: advice.reference,
                          disbursedAt: advice.disbursedAt,
                          idempotencyKey: supplierDisbursementKey,
                        }),
                      "SupplierDisbursementConfirmedSuccess",
                      { reflectedWhen: supplierDisbursementReflected }
                    );
                    // Answer for a deal that is gone: change nothing on this one.
                    if (superseded()) return;
                    confirmSupplierDisbursementKeyRef.current = null;
                    setConfirmingSupplierDisbursement(false);
                  } catch (error) {
                    if (superseded()) return;
                    toast.error(getErrorMessage(error));
                  } finally {
                    if (!superseded()) setDisbursementSubmitting(false);
                  }
                },
              },
            }
          : undefined
      }
      gapResolution={{
        resolving: resolvingGap,
        submitting: gapSubmitting,
        onOpenChange: setResolvingGap,
        submittedQuotationMinor: economicsApp?.submittedQuotationMinor ?? null,
        approvedPurchaseAmountMinor: economicsApp?.approvedDealerPurchaseAmountMinor ?? null,
        /**
         * RETHROWS, for the reason the handover submit documents: the refusal
         * belongs to the attempt that earned it, and the server's messages
         * name the figure that did not reconcile — the only thing that tells
         * the operator which of five boxes to change.
         */
        onSubmit: async (values) => {
          setGapSubmitting(true);
          try {
            await trackRecorded(
              () =>
                resolveAppraisalGap({
                  orgId,
                  applicationId,
                  // The stamp the DIALOG snapshotted when it opened, passed straight
                  // through. Re-reading it from `deal` here would undo that
                  // snapshot and hand the server a revision the operator never saw.
                  economicsStamp: values.economicsStamp ?? "",
                  customerGapShareMinor: values.customerGapShareMinor,
                  dealerGapShareMinor: values.dealerGapShareMinor,
                  customerGapCashToDealerMinor: values.customerGapCashToDealerMinor,
                  customerGapInstallmentToDealerMinor: values.customerGapInstallmentToDealerMinor,
                  customerGapToFinanceCompanyMinor: values.customerGapToFinanceCompanyMinor,
                  notes: values.notes || undefined,
                }),
              "GapResolved"
            );
            setResolvingGap(false);
          } catch (error) {
            const message = getErrorMessage(error);
            toast.error(message);
            throw new Error(message);
          } finally {
            setGapSubmitting(false);
          }
        },
      }}
      handover={{
        confirming: confirmingHandover,
        submitting: handoverSubmitting,
        onOpenChange: setConfirmingHandover,
        /**
         * RETHROWS. The refusal belongs to the attempt that earned it, and the
         * attempt lives in the dialog — holding it here is what let a stale
         * "the figures changed" message survive into a freshly opened
         * confirmation about a different revision.
         */
        onSubmit: async (values) => {
          setHandoverSubmitting(true);
          try {
            await trackRecorded(
              () =>
                registerVehicleHandover({
                  orgId,
                  applicationId,
                  notes: values.notes,
                  // The stamp the dialog was OPENED against, passed straight
                  // through. Not re-read from `deal` here — that would undo the
                  // snapshot the dialog took and restore the race it closes.
                  economicsStamp: values.economicsStamp,
                }),
              "HandoverRegistered",
              { reflectedWhen: handoverReflected }
            );
            setConfirmingHandover(false);
          } catch (error) {
            // The server's refusals name the thing to change — not APPROVED
            // yet, already handed over. Replacing them with a generic message
            // would turn the one recovery path this state has into a dead end.
            const message = getErrorMessage(error);
            toast.error(message);
            throw new Error(message);
          } finally {
            setHandoverSubmitting(false);
          }
        },
      }}
      expectedPayment={{
        registering: registeringPayment,
        submitting: paymentSubmitting,
        error: paymentError,
        onOpenChange: (open) => {
          // Every way in (rail or cheque panel) opens a fresh form, never one
          // still carrying a previous attempt's refusal.
          if (open) setPaymentError(null);
          setRegisteringPayment(open);
        },
        onSubmit: async (values) => {
          setPaymentSubmitting(true);
          setPaymentError(null);
          try {
            await trackRecorded(
              () => registerExpectedPayment({ orgId, applicationId, ...values }),
              "ExpectedPaymentRegisteredSuccess",
              { reflectedWhen: expectedPaymentReflected }
            );
            setRegisteringPayment(false);
          } catch (error) {
            const message = getErrorMessage(error);
            setPaymentError(message);
            toast.error(message);
          } finally {
            setPaymentSubmitting(false);
          }
        },
      }}
      finalize={{
        confirming: confirmingFinalize,
        submitting: finalizeSubmitting,
        error: finalizeError,
        onOpenChange: setConfirmingFinalize,
        profitApproval: {
          blocked: finalizeProfitApproval.blocked,
          notice: <ProfitApprovalNotice approval={finalizeProfitApproval} />,
        },
        // The dialog outlives the READY verdict it was opened on (S414-R3-1):
        // it names the current reason and its confirm is disabled meanwhile.
        readinessHold: finalizeReadinessHoldKey ? t(finalizeReadinessHoldKey) : null,
        onSubmit: async () => {
          // Same predicate as the offer, checked again at the moment of the
          // write: nothing reaches `finalizeDeal` without a loaded READY verdict.
          if (!finalizeAllowedByReadiness) return;
          setFinalizeSubmitting(true);
          setFinalizeError(null);
          try {
            // ONE key per finalize attempt, minted on the first try and reused
            // by every retry after it. A finalize that runs twice is not a UI
            // glitch — it is a second sale, a second set of journals and a
            // second inventory movement for one car. Cleared only once the
            // server has confirmed, so a lost response retries the SAME
            // operation rather than starting a new one.
            finalizeKeyRef.current ??= `finalize-deal:${crypto.randomUUID()}`;
            const finalizeKey = finalizeKeyRef.current;
            await trackRecorded(
              () =>
                finalizeDeal({
                  orgId,
                  applicationId,
                  idempotencyKey: finalizeKey,
                }),
              "DealFinalizedSuccess"
              // No `reflectedWhen`, on purpose: finalizing navigates to the
              // sale's own deal page and this cockpit unmounts, taking a held
              // line with it. The outcome is said at once, as cancel says it.
            );
            finalizeKeyRef.current = null;
            setConfirmingFinalize(false);
          } catch (error) {
            // Deliberately keeps the key: every refusal here is actionable and
            // names what to change — an unrecorded settlement route, missing
            // economics, an unresolved عربون — so the next attempt is the same
            // finalize with the same key, not a second one. A closing-readiness
            // refusal carries a code + params (SCRUM-414), translated exactly as
            // the readiness panel translates it; anything else keeps its message.
            const refusal = isConvexError(error) ? closingReadinessRefusalOf(error.data) : null;
            const message = refusal
              ? closingReasonText(t, refusal.code, refusal.params, refusal.message).text
              : getLocalizedErrorMessage(error, t);
            setFinalizeError(message);
            toast.error(message);
          } finally {
            setFinalizeSubmitting(false);
          }
        },
      }}
      canCorrectAdvice={canCorrectAdvice}
      canRegisterPayment={canRegisterPayment}
      fcCheque={{
        onAttest: async (faceAmount, note) => {
          const chequeId =
            deal && "unattestedChequeId" in deal ? deal.unattestedChequeId : null;
          // Nothing to write to: refuse loudly so the dialog stays open and shows
          // the error instead of closing as if the face had been recorded.
          if (!chequeId) throw new Error(t("UnexpectedError"));
          await attestChequeFace({ orgId, chequeId, faceAmount, note });
          toast.success(t("FcAttestDone"));
        },
        onCorrect: async (reason) => {
          await correctExpectedPayment({ orgId, applicationId, reason });
          toast.success(t("FcCorrectExpectedPaymentDone"));
        },
      }}
      canSettleSupplier={canSettleSupplier}
      documentsActionable={!permissionsLoading && documentsStepReason === undefined}
      recordedFeedback={{ recorded: recordedFeedback, track: trackRecorded, onDismiss: clearRecorded }}
      onCorrectSettlementAdvice={async (correction) => {
        correctionKeyRef.current ??= `amend-supplier-advice:${crypto.randomUUID()}`;
        await amendAdvice({
          orgId,
          applicationId,
          // Scaled by the currency the SERVER pinned on this discrepancy, which
          // is the application's `economicsCurrency` — not the org's. The whole
          // reason this deal is flagged is a disagreement about an amount, and
          // rescaling it on the way in would manufacture a second one.
          disbursedAmountMinor: Math.round(
            correction.amountMajor *
              Math.pow(
                10,
                scaleForCurrency(
                  deal?.settlementAdviceDiscrepancy?.currency ?? deal?.money?.currency ?? "JOD"
                )
              )
          ),
          reference: correction.reference,
          // Distinct from omitting it. An emptied field used to arrive as
          // `undefined`, identical to "not part of this correction", so the
          // wrong cheque number survived a correction that reported success.
          clearReference: correction.clearReference,
          disbursedAt: correction.disbursedAt,
          reason: correction.reason,
          idempotencyKey: correctionKeyRef.current,
        });
        correctionKeyRef.current = null;
      }}
      onRecordSupplierReceipt={async (receivableId, receipt) => {
        await recordReceipt({
          orgId,
          receivableId,
          amount: receipt.amount,
          receiptMethod: receipt.receiptMethod,
          receiptReference: receipt.receiptReference,
          receivedAt: receipt.receivedAt,
          idempotencyKey: receipt.idempotencyKey,
        });
      }}
      closingChecklist={
        canViewApplications && deal
          ? {
              readiness: closingReadiness,
              serviceUnavailable: closingReadinessServiceUnavailable,
              // The legal invoice is still recorded by hand while the v1
              // posting plan reads it (SCRUM-411 retires that dependency); it
              // is shown and recorded by the disbursement tier only, as before.
              legalInvoice:
                dealCosts && canConfirmFinanceDisbursement
                  ? {
                      amountMinor: dealCosts.legalInvoiceAmountMinor,
                      number: dealCosts.legalInvoiceNumber,
                      date: dealCosts.legalInvoiceDate,
                      issuedTo: dealCosts.legalInvoiceIssuedTo,
                      // SCRUM-691 F-PNTR-5: `recordLegalInvoice` refuses once
                      // the economics are frozen (finalized or CLOSED); the
                      // screen reads the same predicate instead of offering a
                      // button the server will refuse. The recorded invoice
                      // stays visible.
                      onRecord: (dealCosts.economicsFrozen?.frozen ?? app?.status === "CLOSED")
                        ? undefined
                        : () => {
                            setLegalInvoiceError(null);
                            setRecordingLegalInvoice(true);
                          },
                    }
                  : undefined,
            }
          : undefined
      }
    />
      {app?.needsFinancingReconciliation === true && (
        <ResolveReconciliationDialog
          open={resolvingReconciliation}
          submitting={reconciliationSubmitting}
          error={reconciliationError}
          reason={app.financingReconciliationReason ?? null}
          t={t}
          onOpenChange={setResolvingReconciliation}
          onSubmit={async ({ note }) => {
            setReconciliationSubmitting(true);
            setReconciliationError(null);
            try {
              await trackRecorded(
                () => resolveFinancingReconciliation({ orgId, applicationId, note }),
                "ReconciliationResolved",
                { reflectedWhen: reconciliationReflected }
              );
              setResolvingReconciliation(false);
            } catch (error) {
              // "Record what was checked", "not flagged" — each names what to
              // change, so it stays in the form that earned it.
              const message = getErrorMessage(error);
              setReconciliationError(message);
              toast.error(message);
            } finally {
              setReconciliationSubmitting(false);
            }
          }}
        />
      )}
      {recordingLegalInvoice && (
        <RecordLegalInvoiceDialog
          open={recordingLegalInvoice}
          submitting={legalInvoiceSubmitting}
          error={legalInvoiceError}
          scale={scaleForCurrency(dealCosts?.currency ?? orgCurrency.code)}
          currency={dealCosts?.currency ?? orgCurrency.code}
          existing={
            dealCosts?.legalInvoiceAmountMinor !== undefined
              ? {
                  amountMinor: dealCosts.legalInvoiceAmountMinor,
                  number: dealCosts.legalInvoiceNumber,
                  date: dealCosts.legalInvoiceDate,
                  issuedTo: dealCosts.legalInvoiceIssuedTo,
                }
              : undefined
          }
          t={t}
          onOpenChange={setRecordingLegalInvoice}
          onSubmit={async (values) => {
            setLegalInvoiceSubmitting(true);
            setLegalInvoiceError(null);
            try {
              await trackRecorded(
                () =>
                  recordLegalInvoice({
                    orgId,
                    applicationId,
                    legalInvoiceAmountMinor: values.legalInvoiceAmountMinor,
                    legalInvoiceNumber: values.legalInvoiceNumber,
                    legalInvoiceDate: values.legalInvoiceDate,
                    issuedTo: values.issuedTo,
                    issuedToOther: values.issuedToOther,
                  }),
                "LegalInvoiceRecorded",
                {
                  reflectedWhen: legalInvoiceReflected({
                    number: values.legalInvoiceNumber,
                    amountMinor: values.legalInvoiceAmountMinor,
                    date: values.legalInvoiceDate,
                    issuedTo: values.issuedTo,
                  }),
                }
              );
              setRecordingLegalInvoice(false);
            } catch (err) {
              setLegalInvoiceError(getErrorMessage(err));
            } finally {
              setLegalInvoiceSubmitting(false);
            }
          }}
        />
      )}
    </>
  );
}

/**
 * THE canonical deal screen, keyed on the sale — cash or financed.
 *
 * This is the one address a deal has once it exists. It is not a cash-only
 * screen: a sale with a finance application is rendered HERE, by delegating the
 * financed wiring to `DealCockpit` above, so the operator never has to know
 * which kind of deal they are looking at to find it.
 *
 * The delegation is what keeps this honest. The financed deal's money still
 * comes from `applications.dealCockpit` — the shipped, reviewed query that
 * understands approved purchase amounts, supplier settlement routes and the
 * `postable: false` management headline. Teaching `sales.dealCockpit` to
 * compute financed money would have produced a SECOND source of truth for the
 * same figures, which is the one thing SCRUM-26 and SCRUM-30 forbade outright.
 * So: one URL, one view, and each kind's money answered by the query that
 * already knows it.
 *
 * There is no settlement-advice correction on the cash path because there is no
 * finance company to have issued one — the action is ABSENT rather than shown
 * disabled, which is the same rule the rest of this screen follows.
 *
 * The supplier receipt action IS wired, and deliberately. A consigned CASH deal
 * settled DIRECT_TO_SUPPLIER leaves the supplier holding the dealership's margin
 * exactly as a financed one does, and `supplierReceivables.recordReceipt` is
 * keyed on the claim rather than on any financing — so the collection workflow
 * the previous release built works here unchanged.
 */
export function SaleDealCockpit({
  orgId,
  saleId,
  stageDeepLink,
}: Readonly<{ orgId: Id<"organizations">; saleId: Id<"sales">; stageDeepLink?: StageDeepLink }>) {
  const deal = useQuery(api.sales.dealCockpit, { orgId, saleId });
  const recordReceipt = useMutation(api.supplierReceivables.recordReceipt);
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  // The cash path settles a supplier through the SAME mutation, gated by the
  // SAME permission (MANAGE_FINANCE), so it carries the same caller capability
  // — closed while the membership loads, never inferred from a role name.
  const canSettleSupplier = !permissionsLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE);

  /**
   * HANDOVER on a cash deal is the sale still being a draft (SCRUM-417 W3).
   * Completing it is the sale's OWN dialog — the one the Sales page opens —
   * which saves the draft through `sales.update` (edit:sales) and then
   * completes it through `sales.completeDraft` (create:sales) with its
   * idempotency key and deposit decision. So the step is offered to a caller
   * holding both, and opens that dialog for THIS sale; nothing about
   * completion is reimplemented here.
   *
   * The dialog edits a hydrated sale record, which the cockpit payload is not,
   * so `sales.get` (view:sales, the cockpit's own read permission) is loaded —
   * only while the step is live and usable. Until it arrives the step offers
   * no button: the dialog opened with no sale is the NEW-sale form.
   */
  const cashLive = deal?.stages.find((stage) => stage.state === "CURRENT" || stage.state === "BLOCKED");
  const canWriteSale =
    !permissionsLoading && hasPermission(PERMISSIONS.CREATE_SALES) && hasPermission(PERMISSIONS.EDIT_SALES);
  /**
   * Round 2 (Codex S417-R2-2): the dialog also READS, unconditionally, on
   * mount — `customers.list` (view:customers), `vehicles.listAll`
   * (view:vehicles; also what `approvals.profitApprovalStatus` inside it
   * takes) and `memberships.list` (view:users) — and convex/react rethrows a
   * refused query during render. Its other read, `sales.consignedSalePreview`,
   * takes view:sales, which this screen already requires. A caller missing any
   * of the three is told so instead of being handed a form that throws.
   */
  const canReadSaleForm =
    !permissionsLoading &&
    hasPermission(PERMISSIONS.VIEW_CUSTOMERS) &&
    hasPermission(PERMISSIONS.VIEW_VEHICLES) &&
    hasPermission(PERMISSIONS.VIEW_USERS);
  const canCompleteSale = canWriteSale && canReadSaleForm;
  const handoverLive = cashLive?.key === "HANDOVER" && deal?.financingApplicationId == null;
  const saleRecord = useQuery(api.sales.get, handoverLive && canCompleteSale ? { orgId, saleId } : "skip");
  // The dialog completes a DRAFT (`completingDraft` in SaleDialog is
  // `sale.status === "PENDING"`); any other loaded status is not this step.
  const draftSale =
    saleRecord && saleRecord._id === saleId && saleRecord.status === "PENDING" ? saleRecord : undefined;
  /**
   * Round 2 (Codex S417-R2-3), CONTAINED — not fixed — here. A draft linked to
   * a quote completes through the reservation-deposit resolution, which
   * refuses without a stated deposit treatment when the car's share exceeds
   * what the dealership billed. SaleDialog calls `completeDraft` without one
   * and has no control to state it. No server read answers "is a treatment
   * required" (it turns on the bill, which the client must not rebuild), so
   * the step is withheld for a quote-linked draft whose quote has RECEIVED a
   * deposit — `deposits.quoteAllocation.totalReceivedMinor`, the server's own
   * figure, on the view:sales this screen already requires — or whose
   * allocation cannot be read. A draft with no quote carries no deposit
   * resolution at all and is unaffected.
   */
  const quoteAllocation = useQuery(
    api.deposits.quoteAllocation,
    draftSale?.quoteId ? { orgId, quoteId: draftSale.quoteId } : "skip"
  );
  const [completingSale, setCompletingSale] = useState(false);

  /**
   * A financed sale is rendered here, not sent elsewhere.
   *
   * `sales.dealCockpit` deliberately withholds money for a financed sale — there
   * is no second profit for this deal to publish at any permission level — so the
   * financed money must come from `applications.dealCockpit`. Delegating gets
   * that without duplicating it, and without moving the operator off the URL they
   * are on. `canonicalizeUrl={false}` because THIS route is already the canonical
   * one; the delegate must not send it back to itself.
   */
  const financingApplicationId = deal?.financingApplicationId ?? null;
  if (financingApplicationId) {
    return (
      <DealCockpit
        orgId={orgId}
        applicationId={financingApplicationId}
        canonicalizeUrl={false}
        stageDeepLink={stageDeepLink}
      />
    );
  }

  /**
   * The cash rail's one next step (SCRUM-417, G8), from the handlers this
   * screen already has — nothing new is invented for it.
   *
   * HANDOVER on a cash deal is the sale still being a draft: completing it is
   * `sales.completeDraft`, an economic command with its own deposit decision
   * that lives in the sale's own dialog, so the step names where it is done
   * rather than growing a second completion path here. SETTLEMENT is the
   * supplier's claim, settled through the same dialog the money panel opens;
   * the view resolves it against the claim's state and this caller's authority.
   */
  let cashAction: WorkflowAction | undefined;
  if (permissionsLoading || !cashLive) cashAction = undefined;
  else if (cashLive.key === "HANDOVER") {
    // Told apart in the order an operator can act on: the authority to
    // complete at all, then the reads the form needs, then — once THIS draft
    // is loaded — whether its completion needs a deposit decision the form
    // cannot record. Until what decides it has loaded, no button.
    let reason: string | undefined;
    if (!canWriteSale) reason = "CashSaleCompletionNeedsPermission";
    else if (!canReadSaleForm) reason = "CashSaleCompletionNeedsReadAccess";
    else if (draftSale?.quoteId && quoteAllocation !== undefined) {
      if (quoteAllocation === null || quoteAllocation.totalReceivedMinor > 0) {
        reason = "CashSaleCompletionNeedsDepositDecision";
      }
    }
    const decided = draftSale !== undefined && (!draftSale.quoteId || quoteAllocation !== undefined);
    if (reason) {
      cashAction = {
        stageKey: "HANDOVER",
        actionKey: "CompleteCashSaleAction",
        unavailableReasonKey: reason,
        // SCRUM-417 UX1 (S4): the deposit decision is made from the sale's own
        // dialog on the Sales page. Linked only for a caller who can open it;
        // the two permission reasons above already name who acts.
        ...(reason === "CashSaleCompletionNeedsDepositDecision"
          ? hasPermission(PERMISSIONS.VIEW_SALES)
            ? { unavailableLink: { href: `/${orgId}/sales/sales`, labelKey: "OpenSalesPageAction" } }
            : { unavailableNoteKey: "SalesPageNeedsAccess" }
          : {}),
      };
    } else if (decided) {
      cashAction = {
        stageKey: "HANDOVER",
        actionKey: "CompleteCashSaleAction",
        onStart: () => setCompletingSale(true),
      };
    }
  } else cashAction = CASH_STAGE_ACTION[cashLive.key];

  return (
    <>
      <DealCockpitView
        deal={deal}
        stageDeepLink={stageDeepLink}
        backHref={`/${orgId}/deals`}
        workflowAction={cashAction}
        canSettleSupplier={canSettleSupplier}
        supplierSettlementHref={
          // Supplier payables are paid on the sourcing page (`sourcingPayables.markPaid`,
          // MANAGE_FINANCE; its list needs VIEW_FINANCE).
          canSettleSupplier && hasPermission(PERMISSIONS.VIEW_FINANCE) ? `/${orgId}/sourcing` : undefined
        }
        onRecordSupplierReceipt={async (receivableId, receipt) => {
          await recordReceipt({
            orgId,
            receivableId,
            amount: receipt.amount,
            receiptMethod: receipt.receiptMethod,
            receiptReference: receipt.receiptReference,
            receivedAt: receipt.receivedAt,
            idempotencyKey: receipt.idempotencyKey,
          });
        }}
      />
      {/* Mounted only with THIS sale's record in hand: without one the dialog
          is the new-sale form, which must never open from a deal. */}
      {/* Offered only for a loaded DRAFT (`draftSale`); kept mounted on the
          record while open, so the sale turning COMPLETED under its own
          submit does not yank the form away mid-flow. */}
      {completingSale && saleRecord && saleRecord._id === saleId && (
        <SaleDialog open onOpenChange={setCompletingSale} sale={saleRecord} />
      )}
    </>
  );
}

/**
 * The money summary card, extracted so `DealCockpitView` clears the cognitive
 * complexity gate. Presentation only: every figure and every classification
 * arrives already derived from `applications.dealCockpit`, and nothing here
 * computes money. The headline cannot be rendered without its qualifier,
 * because amount and classification travel in one object.
 */
type DealMoney = NonNullable<DealCockpitData["money"]>;

/**
 * One fact of the six-fact summary. `value` is already formatted; `null`
 * renders the unavailable state rather than a zero, because every figure here
 * is either on the server's record or it is not.
 */
function MoneyFact({
  label,
  value,
  unavailableKey = "NotRecorded",
  note,
  action,
  t,
}: Readonly<{
  label: string;
  value: string | null;
  /** What a `null` value means here — "never recorded" by default. */
  unavailableKey?: string;
  note?: React.ReactNode;
  action?: React.ReactNode;
  t: (key: string) => string;
}>) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      {value === null ? (
        <p className="text-sm text-muted-foreground">{t(unavailableKey)}</p>
      ) : (
        <p className="text-base font-semibold leading-snug">
          <Money>{value}</Money>
        </p>
      )}
      {note && <p className="min-w-0 break-words text-xs text-muted-foreground">{note}</p>}
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}

/** A recorded figure as the server projects it, with the denomination it served. */
type ServedEvidence = {
  approvedPurchaseAmountMinor: number | null;
  dealerContributionMinor: number | null;
  currency: { code: string; scale: number } | null;
};

type SummaryFact = {
  labelKey: string;
  value: string | null;
  /** What a null value means — only ever "never recorded" here. */
  unavailableKey: "NotRecorded";
};

/**
 * The non-party facts of the summary, each labelled for exactly what it is.
 * Pure: reads served facts, formats them, and never sums, re-scales, selects
 * between or substitutes them.
 *
 * AVAILABLE profit — ONE tile per line the server served, in the server's
 * order, labelled through `PROFIT_LINE_LABEL`. Nothing is chosen by basis, by
 * `dealKind`, or by what the other lines hold: a SOURCED vehicle's zero
 * VEHICLE_COST and its SUPPLIER_ENTITLEMENT both stand, because deciding that
 * one of them "explains" the margin is an economic classification, and this
 * screen is not the authority on any. An available profit whose `lines` are
 * EMPTY is a headline served without its working, which the caller says as
 * "breakdown unavailable" rather than inventing tiles reading "not recorded".
 *
 * UNAVAILABLE profit — there is no basis and no lines to read, so the fact-set
 * follows the server's own identity of the deal: `applicationId: null` is a
 * sale (cash or applicationless financed) and gets NO tiles at all, because the
 * sale read model serves no price or cost outside the profit and a "not
 * recorded" tile would contradict a row that has one; an application gets the
 * approved-purchase labels, filled ONLY from the two explicitly named
 * `handoverEvidence` fields the server already serves redacted and denominated
 * (a management figure withheld for want of the supplier settlement still has
 * them on record).
 */
function selectSummaryFacts({
  profit,
  applicationId,
  evidence,
  money,
  moneyIn,
}: Readonly<{
  profit: DealMoney["profit"];
  applicationId: string | null;
  evidence: ServedEvidence | undefined;
  money: (minor: number) => string;
  moneyIn: (minor: number, currency: ServedEvidence["currency"]) => string | null;
}>): ReadonlyArray<SummaryFact> {
  if (!profit.available) {
    // A SALE whose profit the server withheld (a draft not yet completed, a
    // cancelled deal, an unreadable margin, a legacy financed-direct row it
    // refuses to vouch for). The read model serves no sale price or vehicle
    // cost OUTSIDE the profit, so there is nothing authoritative to put in a
    // tile — and a tile reading "Sale price: not recorded" over a pending sale
    // that has a price on its row is a false statement, not a cautious one.
    // No facts: the caller states that the breakdown is unavailable, and the
    // headline above already says why.
    if (applicationId === null) return [];
    const served = (minor: number | null | undefined) =>
      minor != null && evidence ? moneyIn(minor, evidence.currency) : null;
    return [
      {
        labelKey: "LineApprovedPurchase",
        value: served(evidence?.approvedPurchaseAmountMinor),
        unavailableKey: "NotRecorded",
      },
      {
        labelKey: "LineDealerContribution",
        value: served(evidence?.dealerContributionMinor),
        unavailableKey: "NotRecorded",
      },
    ];
  }

  // The served sign travels with the figure: a deduction reads as one in the
  // tile exactly as it does in the breakdown, so the tiles never show the
  // magnitude of a cost as if it were an inflow.
  return profit.lines.map((line) => ({
    labelKey: PROFIT_LINE_LABEL[line.key] ?? line.key,
    value: signedMoney(line, money),
    unavailableKey: "NotRecorded",
  }));
}

/** One served line, spelled with the sign the server put on it. */
function signedMoney(
  line: Readonly<{ sign: number; amountMinor: number }>,
  money: (minor: number) => string
): string {
  return `${line.sign < 0 ? "− " : ""}${money(line.amountMinor)}`;
}

/**
 * The headline figure and its qualifier — the ONE branch this screen is not
 * allowed to get wrong.
 *
 * A financed deal's headline is a MANAGEMENT figure built on a spread that
 * appears on no invoice: it is `postable: false` and must never be shown
 * without its qualifier. A cash deal's is an ordinary accounting result that
 * reconciles to the GL, and stamping an "estimated / never postable" badge on
 * it would be just as false in the other direction.
 *
 * Read off `basis` rather than from the presence of a `classification` field,
 * so the distinction is one the type system enforces: `AccountingProfit` has
 * no `classification` to read, and TypeScript refuses the access outside this
 * branch. That is what makes the two impossible to confuse rather than merely
 * unlikely to be.
 */
function ProfitHeadline({
  profit,
  money,
  t,
}: Readonly<{
  profit: DealMoney["profit"];
  money: (minor: number) => string;
  t: (key: string) => string;
}>) {
  const isManagementEstimate = profit.available && profit.basis === "MANAGEMENT_ESTIMATE";
  const isLoss = profit.available && profit.amountMinor < 0;
  const isEstimatedLoss =
    profit.available &&
    profit.amountMinor < 0 &&
    profit.basis === "MANAGEMENT_ESTIMATE" &&
    profit.classification !== "ACTUAL_UNPOSTABLE";
  return (
    <div className="space-y-1">
      <p className="text-sm text-muted-foreground">
        {isLoss
          ? isEstimatedLoss
            ? t("LossEstimated")
            : t("LossActual")
          : t("NetDealershipProfit")}
      </p>
      {profit.available ? (
        <>
          <div className="flex flex-wrap items-baseline gap-3">
            <p
              className={`text-3xl font-semibold ${
                isLoss ? "text-profit-negative font-bold" : profit.amountMinor > 0 ? "text-profit-positive" : ""
              }`}
            >
              <Money>{money(profit.amountMinor)}</Money>
            </p>
            {/* The qualifier is not decoration. It renders from the same
                object as the amount, so there is no code path that shows one
                without the other.
                A cash deal gets NO badge here — not a green one saying
                "postable". The absence of a caveat is the normal case, and
                labelling it would train the eye to skip the badge that
                actually matters. */}
            {profit.basis === "MANAGEMENT_ESTIMATE" && (
              <Badge variant="outline" className="border-amber-500/60 text-amber-700 dark:text-amber-400">
                {profit.classification === "ACTUAL_UNPOSTABLE"
                  ? t("ProfitActualUnpostable")
                  : t("ProfitEstimatedAwaitingSettlement")}
              </Badge>
            )}
          </div>
          {isManagementEstimate && (
            <p className="text-xs text-muted-foreground">{t("ManagementFigureNote")}</p>
          )}
        </>
      ) : (
        <>
          <p className="text-2xl font-semibold text-muted-foreground">{t("ProfitNotCalculable")}</p>
          <p className="text-xs text-muted-foreground">{t(PROFIT_BLOCKED_REASON[profit.reason])}</p>
        </>
      )}
    </div>
  );
}

/** What `DealSummaryFacts` needs beyond the profit — the served evidence and its formatter. */
type SummaryEvidence = Readonly<{
  /** The server's own identity of the deal: `null` is a sale, cash or applicationless financed. */
  applicationId: string | null;
  /**
   * The recorded approved amount and contribution as the SERVER projects them
   * (`handoverEvidence`): already redacted per caller, already denominated.
   * Read only when the profit is unavailable — a management figure withheld
   * for want of the supplier settlement still has these on record. Financed
   * cockpit payloads only; absent elsewhere.
   */
  evidence: ServedEvidence | undefined;
  /** Spells a served figure at the SERVED scale, or withholds it. */
  moneyIn: (minor: number, currency: ServedEvidence["currency"]) => string | null;
}>;

/**
 * The facts of the deal itself. Each figure is served, not derived, and each
 * label names the line it shows — see `selectSummaryFacts` for what is (and is
 * not) done to them, so "approved purchase amount" is never "deal value".
 */
function DealSummaryFacts({
  profit,
  summary,
  money,
  t,
}: Readonly<{
  profit: DealMoney["profit"];
  summary: SummaryEvidence;
  money: (minor: number) => string;
  t: (key: string) => string;
}>) {
  const facts = selectSummaryFacts({ profit, money, ...summary });
  if (facts.length === 0) {
    // A headline served without its working. Said once, here, rather than as
    // tiles claiming figures were never recorded.
    return <p className="text-sm text-muted-foreground">{t("ProfitBreakdownUnavailable")}</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      {facts.map((fact) => (
        <MoneyFact
          key={fact.labelKey}
          label={t(fact.labelKey)}
          value={fact.value}
          unavailableKey={fact.unavailableKey}
          t={t}
        />
      ))}
    </div>
  );
}

const PARTY_FACT_LABEL: Record<string, string> = {
  CUSTOMER: "FactCustomer",
  FINANCIER: "FactFinancier",
  SUPPLIER: "FactSupplier",
};

/**
 * One tile per party the server names, with the supplier's settlement action
 * beside the claim it settles. `onSettleSupplier` is present only when the
 * SERVER would accept the command from this caller. `supplierGuidance` takes
 * the action's place when the server has said WHY it would not — a disputed
 * claim is still owed, and the tile must say what to do about it rather than
 * offer a button whose submit is refused.
 */
function DealPartyFacts({
  parties,
  onSettleSupplier,
  supplierGuidance,
  money,
  t,
}: Readonly<{
  parties: DealMoney["parties"];
  onSettleSupplier: (() => void) | undefined;
  supplierGuidance: string | undefined;
  money: (minor: number) => string;
  t: (key: string) => string;
}>) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2">
      {parties.map((party) => {
        const positioned = party.position !== "NOT_INVOLVED" && party.position !== "UNKNOWN";
        return (
          <MoneyFact
            key={party.party}
            label={t(PARTY_FACT_LABEL[party.party] ?? PARTY_LABEL[party.party] ?? party.party)}
            value={positioned ? money(party.amountMinor) : null}
            note={
              <>
                <span>{t(POSITION_LABEL[party.position] ?? party.position)}</span>
                {party.name && (
                  <>
                    {" · "}
                    <bdi>{party.name}</bdi>
                  </>
                )}
                {party.reference && (
                  <>
                    {" · "}
                    <bdi>{party.reference}</bdi>
                  </>
                )}
              </>
            }
            action={
              party.party === "SUPPLIER" && onSettleSupplier ? (
                <Button size="sm" className="h-9" onClick={onSettleSupplier}>
                  {t("SettleSupplierAction")}
                </Button>
              ) : party.party === "SUPPLIER" && supplierGuidance ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {supplierGuidance}
                </p>
              ) : undefined
            }
            t={t}
          />
        );
      })}
    </div>
  );
}

/**
 * Only where an APPLICATION exists. `فرق تخمين` is the difference between the
 * finance company's appraisal and the price — a cash deal has no appraisal, so
 * "no appraisal gap" would be answering a question nobody asked. The caller
 * decides presence; this only spells the served figure.
 */
function AppraisalGapNote({
  amountMinor,
  money,
  t,
}: Readonly<{
  amountMinor: number | undefined;
  money: (minor: number) => string;
  t: (key: string) => string;
}>) {
  return (
    <p className="text-xs text-muted-foreground">
      {t("AppraisalGapLabel")}: {amountMinor ? <Money>{money(amountMinor)}</Money> : t("NoAppraisalGap")}
    </p>
  );
}

/**
 * The working of the headline figure, collapsed. No disclosure over an empty
 * working: the tiles already say the breakdown is unavailable.
 */
function ProfitBreakdown({
  profit,
  money,
  t,
}: Readonly<{
  profit: DealMoney["profit"];
  money: (minor: number) => string;
  t: (key: string) => string;
}>) {
  if (!profit.available || profit.lines.length === 0) return null;
  return (
    <details className="group">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
        <span>{t("ProfitBreakdownToggle")}</span>
      </summary>
      {/* A working of one figure, kept as a single column — these lines are a
          SUM, and the order they are read in is part of the meaning. EVERY
          served line is listed, zeros included: a zero term is a fact the
          server chose to state, and dropping it would make the working look
          like it hides a term — which an earlier allowlist did, silently, for
          any key it had not heard of. */}
      <dl className="max-w-xl space-y-1.5 pt-2 text-sm">
        {profit.lines.map((line) => (
          <div key={line.key} className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">{t(PROFIT_LINE_LABEL[line.key] ?? line.key)}</dt>
            <dd>
              <Money>{signedMoney(line, money)}</Money>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/**
 * The money card: headline, the served deal facts, the parties and the working,
 * each its own component above. This only composes them in reading order.
 */
function MoneyPanel({
  money,
  profit,
  summary,
  parties,
  overview,
  t,
}: Readonly<{
  money: (minor: number) => string;
  profit: DealMoney["profit"];
  summary: SummaryEvidence;
  /**
   * The server's overview, rendered between the headline and the served
   * lines when present. Financed deals only; a cash deal has no overview and
   * the panel is unchanged without one.
   */
  overview?: {
    data: FinancedDealOverviewData | null | undefined;
    loading: boolean;
    moneyIn: (minor: number, currency: string) => string;
    formatDate: (ms: number) => string;
  };
  /**
   * The party row, or `null` when there is nobody to list — an OWNED cash sale
   * has no third party at all, so the row would be a heading over nothing.
   * `appraisalGap` is `null` on a deal with no application, which has no
   * appraisal to have a gap in.
   */
  parties: Readonly<{
    items: DealMoney["parties"];
    appraisalGap: Readonly<{ amountMinor: number | undefined }> | null;
    onSettleSupplier: (() => void) | undefined;
    supplierGuidance: string | undefined;
  }> | null;
  t: (key: string) => string;
}>) {
  /**
   * ONE profit authority per screen.
   *
   * On a financed deal the overview read model serves the route-aware
   * headline (consignment economics less preparation spend on a SOURCED car;
   * cost-basis economics on the dealership's own STOCK), derived on the
   * server from the same snapshot as every other overview figure. The
   * cockpit's own `money.profit` is the consignment-only derivation, which on
   * a STOCK deal reads "no supplier settlement" — so painting it as the
   * headline beside the overview's figure put two contradictory profits on one
   * card. Here the overview's profit drives the headline, the fact tiles and
   * the breakdown alike, and while the overview is still loading nothing is
   * painted from the legacy figure in its place. A cash deal has no overview
   * and keeps the accounting result the sale cockpit serves.
   */
  const canonicalProfit: DealMoney["profit"] | "LOADING" | "WITHHELD" = overview
    ? overview.loading
      ? "LOADING"
      : (overview.data?.financialSummary?.profit ?? "WITHHELD")
    : profit;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            {t("FinancialSummaryHeading")}
          </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {canonicalProfit === "LOADING" ? (
          <div className="space-y-2" data-testid="deal-financial-overview-loading">
            <p className="text-sm text-muted-foreground">{t("NetDealershipProfit")}</p>
            <Skeleton className="h-9 w-40" />
            <p className="text-xs text-muted-foreground">{t("OverviewLoading")}</p>
          </div>
        ) : canonicalProfit === "WITHHELD" ? (
          // The overview answered without a summary (withheld, or the deal
          // was not readable through it). The legacy consignment figure is
          // NOT a substitute: it is a different derivation and would paint a
          // contradictory headline exactly where the authority is silent.
          <div className="space-y-1" data-testid="deal-financial-overview-withheld">
            <p className="text-sm text-muted-foreground">{t("NetDealershipProfit")}</p>
            <p className="text-2xl font-semibold text-muted-foreground">{t("ProfitNotCalculable")}</p>
            <p className="text-xs text-muted-foreground">{t("ProfitOverviewWithheld")}</p>
          </div>
        ) : (
          <ProfitHeadline profit={canonicalProfit} money={money} t={t} />
        )}
        {overview && !overview.loading && overview.data?.financialSummary && (
          <DealFinancialOverview summary={overview.data.financialSummary} money={overview.moneyIn} t={t} />
        )}
        {/* One fact per served line of the deal itself, then one per party the server names. */}
        {typeof canonicalProfit !== "string" && !overview?.data?.financialSummary && (
          <DealSummaryFacts profit={canonicalProfit} summary={summary} money={money} t={t} />
        )}
        {parties && (
          <div className="space-y-2">
            <h3 className="text-xs font-normal text-muted-foreground">{t("DealPartiesHeading")}</h3>
            <DealPartyFacts
              parties={parties.items}
              onSettleSupplier={parties.onSettleSupplier}
              supplierGuidance={parties.supplierGuidance}
              money={money}
              t={t}
            />
            {parties.appraisalGap && (
              <AppraisalGapNote amountMinor={parties.appraisalGap.amountMinor} money={money} t={t} />
            )}
          </div>
        )}
        {typeof canonicalProfit !== "string" && <ProfitBreakdown profit={canonicalProfit} money={money} t={t} />}
        {overview?.data?.vehicleCostBasis && (
          <VehicleCostBasisSection
            basis={overview.data.vehicleCostBasis}
            money={overview.moneyIn}
            formatDate={overview.formatDate}
            t={t}
          />
        )}
        {overview?.data?.dealerPreparation && (
          <DealerPreparationSection
            preparation={overview.data.dealerPreparation}
            money={overview.moneyIn}
            formatDate={overview.formatDate}
            t={t}
          />
        )}
      </CardContent>
    </Card>
  );
}

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
  }) => Promise<void>;
  onRecordApproved: (values: {
    approvedAmountMinor: number;
    basis: ApprovalBasis;
    appraisalId?: string;
    notes?: string;
    /** The operator answered the departure question — see the dialog. */
    outlierAcknowledged?: boolean;
  }) => Promise<void>;
  /**
   * Takes the recorded amount back off the record so a correct one can replace
   * it. The reason is mandatory server-side and is the only surviving record of
   * the figure being replaced.
   */
  onReopenApproved: (values: { reason: string }) => Promise<void>;
  /** SCRUM-373 D2: present only when the server would accept the correction. */
  firstPaymentCorrection?: { quoteDownPaymentMinor: number; economicsStamp: string } | null;
  onApplyQuoteFirstPayment?: (values: { reason: string; economicsStamp: string }) => Promise<void>;
  onRecordAppraisal: (values: {
    appraisalAmountMinor: number;
    providerType: AppraisalProviderType;
    providerName?: string;
    appraisedAt: number;
    reappraisalReason?: string;
  }) => Promise<void>;
};

export function DealCockpitView({
  deal,
  stageDeepLink,
  backHref,
  financeDecision,
  workbenchPending = false,
  financingPlan,
  handoverCosts,
  financialOverview,
  custody,
  custodyMoney,
  workflowAction,
  gapResolution,
  handover,
  expectedPayment,
  finalize,
  canCorrectAdvice = false,
  canRegisterPayment = false,
  fcCheque,
  canSettleSupplier: callerMaySettleSupplier = false,
  supplierSettlementHref,
  documentsActionable = true,
  recordedFeedback,
  onCorrectSettlementAdvice,
  onRecordSupplierReceipt,
  activeAppraisalProvider = null,
  depositAwaitingResolution = false,
  depositRequests,
  creditDecision,
  cancel,
  cancelHint,
  unwind,
  forwardCorrection,
  chequeReturn,
  settlementRoute,
  documents,
  deposits,
  disbursement,
  closingChecklist,
}: Readonly<{
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
      options?: RecordedTrackOptions
    ) => Promise<T>;
    onDismiss: () => void;
  };
  /** Deposit requests still waiting on this deal (SCRUM-444). Financed only. */
  depositRequests?: {
    orgId: Id<"organizations">;
    requests: ReadonlyArray<{ _id: Id<"depositRequests">; amount: number; currency: string }>;
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
    onForwardReturn: (values: { returnedAt: number; reference: string }) => void | Promise<void>;
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
      observedReleaseCount: number
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
      onOpenChange: (open: boolean) => void;
      onConfirm: () => void | Promise<void>;
    };
    /** SCRUM-435: the payment to the finance company that precedes the transfer. */
    forward?: {
      confirming: boolean;
      submitting: boolean;
      totalLabel: string;
      depositLabel: string;
      contributionLabel: string;
      onOpenChange: (open: boolean) => void;
      onConfirm: (values: ForwardPaymentValues) => void | Promise<void>;
    };
    supplier: {
      confirming: boolean;
      submitting: boolean;
      supplierName: string | undefined;
      amountLabel: string;
      defaultAmountMajor: number | undefined;
      onOpenChange: (open: boolean) => void;
      onConfirm: (advice: { amountMajor: number; reference?: string; disbursedAt?: number }) => void | Promise<void>;
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
  financingPlan?: { facts: FinancingPlanFacts; formatMajor: (major: number, currency: string) => string };
  /**
   * The handover-cost section with its four commands wired — financed deals
   * only. When present it REPLACES the read-only expenses card: same lines,
   * same canonical record, plus the controls.
   */
  handoverCosts?: Omit<React.ComponentProps<typeof HandoverCostsPanel>, "t">;
  /**
   * The deal's automatic closing readiness (SCRUM-407), which replaced the
   * manual "classify deal accounting" step: every check is re-derived by the
   * server and re-run by finalization. `readiness` is undefined while loading
   * and when the read failed; `serviceUnavailable` says which.
   * `legalInvoice` is present for the disbursement tier only — the invoice is
   * still recorded by hand while the v1 posting plan reads it (SCRUM-411).
   */
  closingChecklist?: {
    readiness: ClosingReadinessView | undefined;
    serviceUnavailable?: boolean;
    legalInvoice?: {
      amountMinor?: number;
      number?: string;
      date?: number;
      issuedTo?: string;
      /** Absent once the server freezes the deal's economics (SCRUM-691 F-PNTR-5). */
      onRecord?: () => void;
    };
  };
  /**
   * The server's financial overview and vehicle cost basis — financed deals
   * only. `data` is undefined while loading; each half is null when the
   * server withheld it for this caller.
   */
  financialOverview?: { data: FinancedDealOverviewData | null | undefined; loading: boolean };
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
    /** Rejects on refusal, so the dialog can name the figure that did not add up. */
    onSubmit: (values: {
      customerGapShareMinor: number;
      dealerGapShareMinor: number;
      customerGapCashToDealerMinor: number;
      customerGapInstallmentToDealerMinor: number;
      customerGapToFinanceCompanyMinor: number;
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
    profitApproval?: { notice: React.ReactNode; blocked: boolean };
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
      receiptReference?: string;
      receivedAt?: number;
      /**
       * SCRUM-57: REQUIRED. `supplierReceivables.recordReceipt` is an economic
       * command and refuses to run without a command identity, so the contract
       * that feeds it must not describe the identity as optional — the producer
       * below already mints one per receipt and holds it across retries.
       */
      idempotencyKey: string;
    }
  ) => Promise<void>;
}>) {
  const { t, locale } = useLanguage();
  const currency = useCurrency();

  // S7: with no container feedback (a plain view), a step's success is said at once.
  const trackStep: NonNullable<typeof recordedFeedback>["track"] =
    recordedFeedback?.track ??
    (async <T,>(run: () => Promise<T>, fallbackKey: string) => {
      const value = await run();
      toast.success(t(fallbackKey));
      return value;
    });
  // After a document upload or verify, focus goes to the NEXT outstanding
  // document row -- once per recorded step, and only when one is left.
  const recordedStep = recordedFeedback?.recorded ?? null;
  const focusedForRef = useRef<RecordedFeedback | null>(null);
  const nextDocumentRuleId =
    recordedStep?.isDocumentAction && deal
      ? nextOutstandingDocument(deal.documents, recordedStep.documentRuleId)
      : undefined;
  useEffect(() => {
    if (recordedStep === null || nextDocumentRuleId === undefined) return;
    if (focusedForRef.current === recordedStep) return;
    // Matched by attribute value, not a selector string: a rule id is data.
    const row = Array.from(document.querySelectorAll<HTMLElement>("[data-rule-id]")).find(
      (element) => element.getAttribute("data-rule-id") === nextDocumentRuleId
    );
    if (!row) return;
    focusedForRef.current = recordedStep;
    row.focus();
  }, [recordedStep, nextDocumentRuleId]);

  // O4: whether the phone's folded stage rail is open. Presentation only.
  const [railOpen, setRailOpen] = useState(false);
  const [settlingSupplier, setSettlingSupplier] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [correctingAdvice, setCorrectingAdvice] = useState(false);
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false);
  // CX-6. `recordReceipt` is ADDITIVE — it adds to `amountReceived` — so a lost
  // outcome or a double invocation records a second receipt and posts a second
  // cash/receivable journal. `submitting` is UI state and cannot deduplicate a
  // commit that already landed. One key per attempt, held in a ref so a retry
  // reuses it, and cleared only once the server has confirmed.
  const receiptKeyRef = useRef<string | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [recordingQuotation, setRecordingQuotation] = useState(false);
  const [recordingApproval, setRecordingApproval] = useState(false);
  const [reopeningApproval, setReopeningApproval] = useState(false);
  const [recordingAppraisal, setRecordingAppraisal] = useState(false);
  const [appraisalSubmitting, setAppraisalSubmitting] = useState(false);
  const [appraisalError, setAppraisalError] = useState<string | null>(null);
  // One flag per dialog. A single shared one made an in-flight quotation write
  // render the approval dialog's button as busy too, which reads as the wrong
  // action having been taken.
  const [quotationSubmitting, setQuotationSubmitting] = useState(false);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  // One error per dialog, not one shared: a refusal from the quotation write
  // must not still be sitting in the approval form the next time it opens.
  const [quotationError, setQuotationError] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [reopenSubmitting, setReopenSubmitting] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [applyingFirstPayment, setApplyingFirstPayment] = useState(false);
  const [firstPaymentSubmitting, setFirstPaymentSubmitting] = useState(false);
  const [firstPaymentError, setFirstPaymentError] = useState<string | null>(null);

  // The ONE opener per finance-decision dialog, shared by the decision card and
  // the focus row (SCRUM-417): both clear the dialog's last refusal and open
  // the same dialog, so the two entry points cannot drift apart.
  const openRecordQuotation = () => {
    setQuotationError(null);
    setRecordingQuotation(true);
  };
  const openRecordAppraisal = () => {
    setAppraisalError(null);
    setRecordingAppraisal(true);
  };
  const openRecordApproval = () => {
    setApprovalError(null);
    setRecordingApproval(true);
  };
  const openFinanceDecisionDialog: Record<FinanceDecisionDialog, () => void> = {
    RECORD_QUOTATION: openRecordQuotation,
    RECORD_APPRAISAL: openRecordAppraisal,
    RECORD_APPROVAL: openRecordApproval,
  };

  // The lower documents · activity tabs are controlled so the live step can
  // send the operator to the documents it says are outstanding. The default is
  // unchanged, and a manual switch to Activity still goes through.
  const [lowerTab, setLowerTab] = useState<"documents" | "activity">("documents");
  const lowerTabsRef = useRef<HTMLDivElement>(null);
  const documentsTriggerRef = useRef<HTMLButtonElement>(null);
  const hasDocumentsPane = documents !== undefined || (deal?.documents.length ?? 0) > 0;

  // SCRUM-417 UX3 (O1): the "Deal details" record. `null` = the operator has not
  // chosen, so it follows the default (collapsed while the live step has a panel
  // of its own, open when nothing is promoted); a choice, or a blocker link that
  // needs a panel inside it, overrides.
  const [detailsChoice, setDetailsChoice] = useState<boolean | null>(null);
  // Which step the operator is LOOKING at when no deep link owns that choice.
  const [localViewedKey, setLocalViewedKey] = useState<string | null>(null);
  const requestedStageKey = stageDeepLink ? stageDeepLink.value : localViewedKey;
  const requestStage = stageDeepLink ? stageDeepLink.onChange : setLocalViewedKey;
  const flowRef = useRef<HTMLDivElement>(null);
  // The element the operator last had focus on inside the flow. A keyed sibling
  // that is moved can lose focus in a real browser without a blur the page
  // sees, so it is remembered here to be put back.
  const flowFocusRef = useRef<HTMLElement | null>(null);
  const liveStageKey = deal
    ? (orderStagesForDisplay(deal.stages).find((s) => isLiveStageState(s.state))?.key ?? null)
    : null;
  const seenLiveStageRef = useRef(liveStageKey);
  // A reactive stage change (another user registers the handover) demotes the
  // panel the operator is working in into the collapsed record. A demoted panel
  // that holds an ACTIVE TASK — focus inside it, or a child marking
  // `data-active-task` (an open add-cost form, an unresolved attempt, an open
  // custody dialog) — opens the record instead of vanishing under the operator.
  // A demoted panel with nothing active stays collapsed. Child state is not
  // lifted: the panel says so on its own DOM. Layout effect, so the record is
  // open again before the browser paints or fixes focus up.
  useLayoutEffect(() => {
    if (seenLiveStageRef.current === liveStageKey) return;
    seenLiveStageRef.current = liveStageKey;
    const active = document.activeElement;
    const holdsTask = Array.from(flowRef.current?.querySelectorAll<HTMLElement>('[data-zone="record"]') ?? []).some(
      (wrapper) =>
        wrapper.hidden && (wrapper.querySelector("[data-active-task]") !== null || (active !== null && wrapper.contains(active)))
    );
    if (holdsTask) setDetailsChoice(true);
  }, [liveStageKey]);
  // A step that was being LOOKED at and has since become the live one is no
  // longer "another step": clear the choice, so the address bar does not keep a
  // `?stage=` that would resurface as a stale view when the deal moves on.
  useEffect(() => {
    if (!deal || requestedStageKey === null) return;
    const chosen = resolveViewedStage(requestedStageKey, deal.stages);
    if (chosen && isLiveStageState(chosen.state)) requestStage(null);
  }, [deal, requestedStageKey, requestStage]);
  // Focus follows the task: if the stage change (or the re-open above) left
  // the document without focus, return it to where the operator was.
  useLayoutEffect(() => {
    const focused = flowFocusRef.current;
    if (
      focused?.isConnected &&
      (document.activeElement === null || document.activeElement === document.body) &&
      focused.closest("[hidden]") === null
    ) {
      focused.focus({ preventScroll: true });
    }
  }, [liveStageKey, detailsChoice]);
  // Open the record if `target` lives in it. Called from the click handler,
  // BEFORE the scroll frame: React flushes a discrete event's update at its end,
  // so the panel is on screen (and focusable) when the scroll and focus land.
  // Looked up in the document, never through a ref, so nothing reads a ref while
  // rendering (the closing destinations below are built during render).
  const revealDetailsFor = (target: Element | null) => {
    if (target && target.closest('[data-zone="record"]')) setDetailsChoice(true);
  };
  const goToDocuments = () => {
    setLowerTab("documents");
    revealDetailsFor(document.querySelector('[data-testid="deal-lower-tabs"]'));
    // After the switch has painted, so the scroll lands on the visible pane.
    // The target's `scroll-mt-*` keeps it clear of the sticky header; focus
    // moves to the Documents tab without a second, instant jump.
    requestAnimationFrame(() => {
      const reduceMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      lowerTabsRef.current?.scrollIntoView?.({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      documentsTriggerRef.current?.focus({ preventScroll: true });
    });
  };

  // SCRUM-417 UX1 (S4): a failed closing check opens the panel that resolves
  // it. Same scroll-then-focus contract as `goToDocuments`; the target is a
  // panel this view renders itself, found by id at click time (never at render).
  const goToPanel = (id: string) => {
    revealDetailsFor(document.getElementById(id));
    requestAnimationFrame(() => {
      const target = document.getElementById(id);
      if (!target) return;
      const reduceMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView?.({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      target.focus({ preventScroll: true });
    });
  };
  // Bring a promoted or recorded panel into view by its flow wrapper, opening the
  // Deal-details record first when it lives there. Focus goes to the first
  // control inside it, when it has one; the wrapper itself is never focusable.
  const goToFlowPanel = (panel: WorkbenchPanel) => {
    const find = () =>
      document.getElementById("deal-workbench-" + panel) ?? document.getElementById("deal-record-" + panel);
    revealDetailsFor(find());
    requestAnimationFrame(() => {
      const target = find();
      if (!target) return;
      const reduceMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView?.({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      target
        .querySelector<HTMLElement>('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        ?.focus({ preventScroll: true });
    });
  };
  const costsDestination = handoverCosts
    ? { labelKey: "ClosingCheckGoToCosts", onGo: () => goToPanel("deal-handover-costs-panel") }
    : undefined;
  const custodyDestination =
    custody && custodyMoney
      ? { labelKey: "ClosingCheckGoToCustody", onGo: () => goToPanel("deal-custody-panel") }
      : undefined;
  const legalInvoiceRecord = closingChecklist?.legalInvoice?.onRecord;
  // Only checks with a real home here. REMITTANCE_KNOWN and FIRST_PAYMENT_RECORDED
  // have no panel of their own on this screen and keep their reason text.
  const closingDestinations: Partial<Record<string, { labelKey: string; onGo: () => void }>> = {
    ...(costsDestination
      ? {
          HANDOVER_COSTS_PAID: costsDestination,
          CONFIGURED_FEES_RECORDED: costsDestination,
          COSTS_CLOSABLE: costsDestination,
        }
      : {}),
    ...(custodyDestination
      ? { CUSTODY_ON_LEDGER: custodyDestination, CUSTODY_SETTLED: custodyDestination }
      : {}),
    ...(legalInvoiceRecord
      ? { LEGAL_INVOICE_RECORDED: { labelKey: "RecordLegalInvoice", onGo: legalInvoiceRecord } }
      : {}),
  };

  // A claim to settle AND a caller the server would accept the receipt from.
  // The first four terms are the deal's state; the last is the operator's
  // authority, decided by the container from MANAGE_FINANCE and never here.
  //
  // `supplierReceipt` is the SERVER's own verdict on whether `recordReceipt`
  // would take the command, formed from the claim's status. The position alone
  // was not enough: a DISPUTED claim reads OWED_TO_DEALERSHIP — the money IS
  // still owed — and the screen offered a settlement the mutation refuses on
  // sight. The position stays truthful; the action follows the verdict.
  const supplierRow = deal?.money?.parties.find((p) => p.party === "SUPPLIER");
  const supplierReceipt = deal?.money?.supplierReceipt;
  const supplierClaimSettleable =
    deal?.money?.settlesDirectToSupplier === true &&
    deal.money.routeKnown &&
    supplierRow?.position === "OWED_TO_DEALERSHIP" &&
    supplierReceipt?.actionable === true;
  const canSettleSupplier = callerMaySettleSupplier && supplierClaimSettleable;
  // Named guidance for the one refusal the operator can act on. Every other
  // reason simply withholds the button, as before.
  const supplierGuidance =
    supplierReceipt?.actionable === false && supplierReceipt.reason === "CLAIM_DISPUTED"
      ? t("SupplierClaimDisputedGuidance")
      : undefined;

  // Authority is LIVE, not a snapshot taken when the dialog opened. If the
  // membership finishes loading without MANAGE_FINANCE, is revoked mid-entry,
  // or the deal's state stops allowing a settlement, the open dialog closes
  // itself IN THE SAME RENDER (React's adjust-state-during-render pattern, so
  // no frame ever paints the form under a lost grant, and regaining the grant
  // later does not re-open a form nobody asked for). The dialog is also
  // mounted only while the action is offered, and the submit path re-checks,
  // so a stale form cannot send the command.
  if (!canSettleSupplier && settlingSupplier) setSettlingSupplier(false);

  // Never a hardcoded ÷1000. JOD, KWD, BHD and OMR are three-decimal; most
  // currencies are two. Baking one scale in would be a 100x error everywhere
  // else — the same trap the accounting screens already solved with this helper.
  // CX-3. The scale comes from the currency the SERVER pinned on this deal, not
  // from whatever the org is configured with today. `economicsCurrency` is
  // snapshotted per application, so an in-flight JOD deal on an org that later
  // switches to USD would otherwise be rescaled at the wrong power of ten —
  // 5,000,000 minor units rendering as 50,000 USD instead of 5,000 JOD, and the
  // same wrong factor feeding the receipt dialog.
  /**
   * The denomination the SERVER vouches for, or null.
   *
   * This screen is a money-READING surface. Everything below used to fall from
   * the deal's currency to the org's to a hardcoded default, and then through a
   * scaler that answers 2 for anything it does not recognise — so a legacy row
   * carrying "JD" showed 11,500,000 fils as 115,000. Refusing the handover
   * protects the irreversible step and does nothing for the figure a dealer
   * reads off the page.
   *
   * When it is null there is no honest way to spell these amounts, so they are
   * withheld and the reason is stated. Absent, unsupported and non-canonical
   * all land here, matching exactly what the writers refuse.
   */
  // Only a payload that CARRIES the projection can be judged by it. The cash
  // variant comes from `sales.dealCockpit`, which projects no denomination at
  // all — reading its absence as "unusable" would have hidden the figures on
  // every live cash sale, which is a far worse fault than the one this guards.
  const hasDenominationProjection = deal != null && "denomination" in deal;
  const denomination = hasDenominationProjection ? deal.denomination : null;
  /**
   * Whether economics are actually ON the record.
   *
   * NOT `Boolean(deal.money)`. That object is permission-shaped: `dealCockpit`
   * builds it for any caller holding `view:finance` and returns zeroed party
   * rows for a deal where nothing has ever been recorded. Using it here put the
   * red restatement panel on every freshly created financed deal for the OWNER,
   * telling them to record again something that was never recorded once.
   *
   * The stage rail is the real signal, and the server derives it from the
   * unredacted row — so it is equally true for a caller whose money is withheld.
   */
  const economicsRecorded = !hasDenominationProjection
    ? false
    : "economicsRecorded" in deal
      ? deal.economicsRecorded === true
      : // UNKNOWN, and unknown must not read as "nothing recorded".
        //
        // A response from the previous backend carries `denomination` but not
        // `economicsRecorded`, and on this repository that pairing is the
        // DEFAULT after a merge rather than an exotic rollback: pushing to
        // `main` auto-deploys the frontend, while the Convex functions stay on
        // the old version until someone deploys them by hand. So a new client
        // talks to an old server on every merge, for as long as that gap lasts.
        //
        // Reading the absent field as `false` switched the guard off in exactly
        // that window — a legacy row denominated in something unspellable would
        // have gone back to the guessing scale and rendered 11,500,000 minor
        // units as 115,000. Assuming instead that money MAY be recorded costs a
        // restatement panel on a deal that has none, and only until the backend
        // catches up. One of those errors is a wrong number on a real deal.
        true;
  const denominationUnusable = hasDenominationProjection && denomination === null && economicsRecorded;
  const dealCurrency = denomination?.code ?? deal?.money?.currency ?? currency.code;
  const factor = useMemo(
    () => Math.pow(10, denomination?.scale ?? safeScaleForCurrency(dealCurrency, 2)),
    [denomination, dealCurrency]
  );
  // A SHORT currency marker, and a locale-appropriate one.
  //
  // `currency.format` renders "دينار اردني" in Arabic, which on a screen
  // carrying a dozen amounts wrapped every figure onto two lines on mobile and
  // buried the headline; the approved mockup uses "د.أ". But the symbol is
  // configured per org and is Arabic, so using it unconditionally put "د.أ"
  // next to Latin digits on the English screen — an RTL run beside an LTR one,
  // which is the bidi case this file is careful about everywhere else. Each
  // locale gets the short form that belongs to it.
  // The org's symbol only stands for the org's own currency; on a deal pinned to
  // a different one it would label the amount as something it is not.
  const marker =
    locale === "ar" && dealCurrency === currency.code ? currency.symbol : dealCurrency;
  const money = (minor: number) => `${(minor / factor).toLocaleString()} ${marker}`;

  // The discrepancy's own figures.
  //
  // Scaled by the currency the DISCREPANCY was pinned to, which is not
  // necessarily `dealCurrency`: the money block can be withheld entirely, and
  // this strip still has to render. Falling back to the deal's currency and
  // then the org's mirrors what the server does, so the two never disagree
  // about the scale. A missing figure renders as unknown rather than as zero —
  // "the advice says nothing" and "the advice says nought" are different
  // claims, and only one of them is ever true here.
  // DELIBERATELY still the guessing scaler. See SCRUM-88 before changing it.
  //
  // This strip does render a legacy "JD" row at the wrong scale, and an earlier
  // revision of this PR tried to fix that here by switching to the strict
  // `denominationOf`. That made things worse, not better: this same factor
  // prefills the EDITABLE amount in `SettlementAdviceCorrectionDialog` below,
  // while the submit path converts back with `scaleForCurrency`. Making only
  // the display side strict left the two disagreeing, so an operator opening
  // the dialog to correct a reference and submitting without touching the
  // amount persisted 100x the recorded figure over the advice and its audit
  // row. A display fault became a write corruption.
  //
  // The two sides have to move together — display, prefill, submit and a
  // server-side denomination guard on the amend mutation, which currently takes
  // no currency argument and so cannot check one. That is a change to a shipped
  // financial correction flow, not a hunk in a release-verification pass, and
  // it is tracked separately. Keeping main's behavior here is the smaller risk:
  // wrong on screen, but internally consistent, and it round-trips exactly.
  const discrepancy = deal?.settlementAdviceDiscrepancy ?? null;
  const discrepancyCurrency = discrepancy?.currency ?? dealCurrency;
  const discrepancyFactor = useMemo(
    () => Math.pow(10, safeScaleForCurrency(discrepancyCurrency, 2)),
    [discrepancyCurrency]
  );
  const discrepancyMarker =
    locale === "ar" && discrepancyCurrency === currency.code ? currency.symbol : discrepancyCurrency;
  const discrepancyMoney = (minor: number) =>
    `${(minor / discrepancyFactor).toLocaleString()} ${discrepancyMarker}`;

  // The economics block is denominated in the APPLICATION's pinned currency,
  // which the money block need not even be present to establish — a MANAGER
  // recording an approval has no money block at all, so falling back to the
  // deal's and then the org's mirrors what the server does rather than
  // rescaling a JOD figure at a USD scale.
  const decisionCurrency = financeDecision?.currency ?? dealCurrency;
  const decisionFactor = useMemo(
    () => Math.pow(10, safeScaleForCurrency(decisionCurrency, 2)),
    [decisionCurrency]
  );
  const decisionMarker =
    locale === "ar" && decisionCurrency === currency.code ? currency.symbol : decisionCurrency;
  /**
   * What the handover confirmation shows — from the COCKPIT's own payload, not
   * from `getEconomics`.
   *
   * The cockpit only mounts `getEconomics` for `view:finance_applications`. A
   * role holding `confirm:finance_disbursement` without it is entitled to the
   * approved amount, and the legacy Review screen shows it — but here the
   * confirmation rendered blank while the handover still sealed. Both screens
   * now read the same server-side redaction, so the same caller sees the same
   * deal whichever door they open.
   */
  const handoverEvidence =
    deal && "handoverEvidence" in deal ? deal.handoverEvidence : undefined;
  /**
   * A figure at the denomination the SERVER served with it (`{code, scale}`),
   * for the summary's evidence facts. No guessing scaler: a served figure
   * without a served denomination is withheld, and the marker follows the
   * same locale rule as every other amount on the screen.
   */
  const servedMoney = (minor: number, served: { code: string; scale: number } | null) => {
    if (denominationUnusable || served === null) return null;
    const servedMarker =
      locale === "ar" && served.code === currency.code ? currency.symbol : served.code;
    return `${(minor / Math.pow(10, served.scale)).toLocaleString()} ${servedMarker}`;
  };
  // Withheld outright rather than approximated: a figure the operator cannot
  // tell is wrong is worse than a visible blank beside the restatement notice.
  const decisionMoney = (minor: number) =>
    denominationUnusable
      ? "—"
      : `${(minor / decisionFactor).toLocaleString()} ${decisionMarker}`;
  const adviceRecordedLabel =
    discrepancy?.recordedMinor != null ? discrepancyMoney(discrepancy.recordedMinor) : t("Unknown");
  const adviceApprovedLabel =
    discrepancy?.approvedMinor != null ? discrepancyMoney(discrepancy.approvedMinor) : t("Unknown");
  // Only when BOTH are known. A difference computed against an unknown is not a
  // smaller difference, it is not a difference.
  const adviceDifferenceLabel =
    discrepancy?.recordedMinor != null && discrepancy?.approvedMinor != null
      ? discrepancyMoney(Math.abs(discrepancy.recordedMinor - discrepancy.approvedMinor))
      : null;

  if (deal === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (deal === null) {
    return (
      <Card>
        {/* The query returns null both for a deal that does not exist and for
            one belonging to another org — deliberately indistinguishable, so a
            probe cannot use this screen to discover which ids are real. */}
        <CardContent className="py-10 text-center text-muted-foreground">
          {t("SaleRecordNotFound")}
        </CardContent>
      </Card>
    );
  }

  // The rail's DISPLAY order (S1): payment confirmation last, because it can
  // only be confirmed after handover and close. The same stage objects, keyed
  // re-sequenced; every "which step is this" number below reads this order.
  const stages = orderStagesForDisplay(deal.stages);
  const live = stages.find((s) => isLiveStageState(s.state));
  // A finished deal gets one calm completion line instead of a rail of ticks;
  // the rail itself stays one click away. Every other deal — live, or stopped
  // with nothing left to do — shows the rail as-is, because on a stopped deal
  // WHERE it stopped is the information.
  // A stage the server proved NOT_APPLICABLE is not outstanding work: it counts
  // as finished here, though never as COMPLETE (SCRUM-446).
  const allComplete = stages.length > 0 && stages.every((s) => isFinishedStageState(s.state));
  const liveIndex = live ? stages.findIndex((s) => s.key === live.key) : -1;
  // Settlement is shown ahead of a payment step that is live: every closed
  // financed deal sits there until the finance company pays, so the node says
  // what it is waiting on rather than reading as an unexplained PENDING.
  const paymentIsLive = stages.some((s) => s.key === "DISBURSEMENT" && isLiveStageState(s.state));
  const railStages = stages.map((stage) => ({
    key: stage.key,
    state: stage.state,
    label: t(STAGE_LABEL[stage.key] ?? stage.key),
    // The same provenance-gated resolution the focus panel uses, so a node
    // and the panel can never name different parties for one step.
    // A stage that is not needed has nobody acting on it, so no owner is drawn.
    owner: stage.state === "NOT_APPLICABLE" ? undefined : stageOwnerLabel(stage, activeAppraisalProvider, t),
    // ...and its "blocker" slot carries WHY it is not needed (rail tooltip and
    // accessible name), never a wait.
    blocker:
      stage.state === "NOT_APPLICABLE"
        ? t(stageNotApplicableReasonKey(stage.key))
        : stage.key === "DISBURSEMENT" && stage.state === "PENDING"
          ? t("BlockerDisbursementAfterHandover")
          : stage.key === "SETTLEMENT" && stage.state === "PENDING" && paymentIsLive
            ? t("BlockerSettlementAfterFinancePayment")
            : stage.blocker
              ? t(`Blocker${stage.blocker}`)
              : undefined,
  }));
  // SCRUM-417 UX4 (O2/O3). The sub-steps of any stage, from facts this view
  // already holds -- never a new read. Readiness counts only while it is open
  // and answered: a closed or unreadable verdict names no sub-step it cannot see.
  const stageStates = Object.fromEntries(stages.map((stage) => [stage.key, stage.state]));
  const openReadiness =
    closingChecklist?.readiness && closingChecklist.readiness.open ? closingChecklist.readiness : undefined;
  // An answered list -- even an empty one (UNAVAILABLE with `checks: []`, a
  // currency mismatch) -- is `{}`, never `undefined`: the cost items then stay
  // on the list, not done, instead of vanishing with the verdict.
  const readinessChecks: Partial<Record<ClosingReadinessCheckKey, string>> | undefined = openReadiness
    ? Object.fromEntries(openReadiness.checks.map((check) => [check.key, check.status]))
    : undefined;
  // The identity of THIS cockpit, by `applicationId` (as the title below does),
  // never by `dealKind`: an applicationless FINANCED/LEASE sale is `dealKind:
  // "FINANCED"` and has the sale's steps, not the financed chain.
  const dealPath: "SALE" | "APPLICATION" = deal.applicationId === null ? "SALE" : "APPLICATION";
  // The server reports a closed deal positively: `status === "CLOSED"`.
  const dealClosed = deal.status === "CLOSED";
  // Only the LIVE step has a checklist (`deriveStepChecklist` is null for any
  // other state): the server has no item-level facts for a finished or upcoming one.
  const checklistOf = (stage: (typeof stages)[number]): ChecklistItem[] | null =>
      deriveStepChecklist({
          stageKey: stage.key,
          stageState: stage.state,
          path: dealPath,
          closed: dealClosed,
          blocker: stage.blocker,
          stageStates,
          documents: deal.documents,
          checks: readinessChecks,
          readinessState: openReadiness?.state,
          expectedPaymentRegistered:
            "expectedPaymentRegistered" in deal ? deal.expectedPaymentRegistered : undefined,
          routeRequired:
            "supplierSettlementRouteRequired" in deal ? deal.supplierSettlementRouteRequired : undefined,
          routeRecorded: settlementRoute ? settlementRoute.route !== undefined : undefined,
          // The control THIS stage offers right now, so the current item can
          // never disagree with it.
          liveAction:
            workflowAction && workflowAction.stageKey === stage.key
              ? {
                  actionKey: workflowAction.actionKey,
                  unavailableReasonKey: workflowAction.unavailableReasonKey,
                }
              : undefined,
        });
  // Which step is being LOOKED at. A key the deal does not have, or the live
  // step's own, is no choice at all: the live step is shown, as always.
  const viewedStage = resolveViewedStage(requestedStageKey, stages);
  const viewedMode = viewedStage ? stageViewMode(viewedStage.state) : "live";
  const otherStage = viewedStage && viewedMode !== "live" ? viewedStage : undefined;
  // Whether the close is being refused for want of the settlement route — the
  // one case where the route control belongs on the live step itself.
  const routeBlocksClose =
    live?.key === "SETTLEMENT" &&
    workflowAction?.stageKey === "SETTLEMENT" &&
    (workflowAction.unavailableReasonKey === "FinalizeNeedsSettlementRoute" ||
      workflowAction.unavailableReasonKey === "FinalizeNeedsRouteAndPermission");
  const handleSupplierReceipt = async (receipt: {
    amount: number;
    receiptMethod?: PaymentMethod;
    receiptReference?: string;
    receivedAt?: number;
  }) => {
    // Fail closed on the authority as it stands NOW, not as it stood when the
    // form was opened. The server would refuse anyway; this stops the screen
    // from issuing a command it already knows will be refused.
    if (!canSettleSupplier || !supplierRow?.receivableId) {
      setSettlingSupplier(false);
      return;
    }
    setSubmitting(true);
    try {
      // Keyed to THIS claim, whose id the server resolved. The screen never
      // lets a client name a receivable of its own choosing.
      receiptKeyRef.current ??= crypto.randomUUID();
      const receiptKey = receiptKeyRef.current;
      await trackStep(
        () =>
          onRecordSupplierReceipt(supplierRow.receivableId as Id<"vehicleSupplierReceivables">, {
            ...receipt,
            idempotencyKey: receiptKey,
          }),
        "ReceiptRecorded"
      );
      // Only now: a failed attempt keeps its key so retrying is the same
      // receipt rather than a second one.
      receiptKeyRef.current = null;
      setSettlingSupplier(false);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Both recorders share one shape: submit, and on refusal keep the dialog open
   * with the server's own words in it.
   *
   * The refusals here are the whole point — "record the quotation before
   * recording what it approved", "you cannot approve your own application", "the
   * calculator produced 12,500, not 13,000". Replacing them with a generic
   * message would leave an operator holding a document they cannot enter, which
   * is the dead end this screen was built to end.
   */
  const handleRecordQuotation = async (values: {
    submittedQuotationMinor: number;
    source: "SYSTEM_CALCULATED" | "MANUAL_ENTRY" | "CALCULATED_WITH_OVERRIDE";
    overrideReason?: string;
    ltvPercent?: number;
  }) => {
    if (!financeDecision) return;
    setQuotationSubmitting(true);
    setQuotationError(null);
    try {
      await trackStep(() => financeDecision.onRecordQuotation(values), "QuotationRecorded", {
        reflectedWhen: quotationReflected(values.submittedQuotationMinor, values.source),
      });
      setRecordingQuotation(false);
    } catch (error) {
      const message = getErrorMessage(error);
      setQuotationError(message);
      toast.error(message);
    } finally {
      setQuotationSubmitting(false);
    }
  };

  const handleRecordAppraisal = async (values: {
    appraisalAmountMinor: number;
    providerType: AppraisalProviderType;
    providerName?: string;
    appraisedAt: number;
    reappraisalReason?: string;
  }) => {
    if (!financeDecision) return;
    setAppraisalSubmitting(true);
    setAppraisalError(null);
    try {
      await trackStep(() => financeDecision.onRecordAppraisal(values), "AppraisalRecorded");
      setRecordingAppraisal(false);
    } catch (error) {
      const message = getErrorMessage(error);
      setAppraisalError(message);
      toast.error(message);
    } finally {
      setAppraisalSubmitting(false);
    }
  };

  const handleRecordApproved = async (values: {
    approvedAmountMinor: number;
    basis: ApprovalBasis;
    appraisalId?: string;
    notes?: string;
    outlierAcknowledged?: boolean;
  }) => {
    if (!financeDecision) return;
    setApprovalSubmitting(true);
    setApprovalError(null);
    try {
      await trackStep(() => financeDecision.onRecordApproved(values), "ApprovedPurchaseRecorded", {
        reflectedWhen: approvedPurchaseReflected(values.approvedAmountMinor, values.basis),
      });
      setRecordingApproval(false);
    } catch (error) {
      const message = getErrorMessage(error);
      setApprovalError(message);
      toast.error(message);
    } finally {
      setApprovalSubmitting(false);
    }
  };

  const handleApplyQuoteFirstPayment = async (values: { reason: string; economicsStamp: string }) => {
    if (!financeDecision?.onApplyQuoteFirstPayment) return;
    setFirstPaymentSubmitting(true);
    setFirstPaymentError(null);
    try {
      await trackStep(
        () => financeDecision.onApplyQuoteFirstPayment!(values),
        "ApplyQuoteFirstPaymentApplied"
      );
      setApplyingFirstPayment(false);
    } catch (error) {
      const message = getErrorMessage(error);
      setFirstPaymentError(message);
      toast.error(message);
    } finally {
      setFirstPaymentSubmitting(false);
    }
  };

  const handleReopenApproved = async (values: { reason: string }) => {
    if (!financeDecision) return;
    setReopenSubmitting(true);
    setReopenError(null);
    try {
      await trackStep(() => financeDecision.onReopenApproved(values), "ApprovedPurchaseReopened", {
        reflectedWhen: approvalReopenedReflected,
      });
      setReopeningApproval(false);
      // Straight into recording the correct figure. Reopening leaves the deal
      // with no approved amount and handover blocked — a state nobody wants to
      // stop in — so the correction reads as one action even though it is two
      // writes. The operator can still close this dialog and come back: the
      // card offers the record action again, because the amount is now gone.
      setRecordingApproval(true);
    } catch (error) {
      const message = getErrorMessage(error);
      setReopenError(message);
      toast.error(message);
    } finally {
      setReopenSubmitting(false);
    }
  };

  const handleCorrectAdvice = async (correction: {
    amountMajor: number;
    reference?: string;
    disbursedAt?: number;
    reason: string;
  }) => {
    if (!onCorrectSettlementAdvice) return;
    setCorrectionSubmitting(true);
    try {
      await onCorrectSettlementAdvice(correction);
      // Deliberately not "corrected" or "resolved". The server re-derives the
      // reconciliation state from the evidence, so a correction that still
      // disagrees leaves the deal flagged — and a toast claiming otherwise
      // would be the screen telling the operator a discrepancy is closed when
      // the strip above it still says it is open. The strip is the answer.
      toast.success(t("SettlementAdviceCorrectionSaved"));
      setCorrectingAdvice(false);
    } catch (error) {
      // The server's refusals here name the thing to change: a reason too
      // short, an advice that was never recorded, a future date. Replacing them
      // with "an unexpected error occurred" turns the one recovery path this
      // state has into a dead end.
      toast.error(getErrorMessage(error));
    } finally {
      setCorrectionSubmitting(false);
    }
  };

  /**
   * The live step's action with any VIEW-owned target resolved to the view's
   * own handler (SCRUM-417) — the same setter the decision card, the
   * documents tab and the money panel use, so the focus row opens THE dialog,
   * not a copy of it. A target the view cannot honour becomes a reason, never
   * a button that does nothing.
   */
  const resolveFocusAction = (action: WorkflowAction): WorkflowAction => {
    if (action.unavailableReasonKey || !action.opens) return action;
    switch (action.opens) {
      case "RECORD_QUOTATION":
      case "RECORD_APPRAISAL":
      case "RECORD_APPROVAL":
        return { ...action, onStart: openFinanceDecisionDialog[action.opens] };
      case "DOCUMENTS":
        return hasDocumentsPane
          ? // Wired in the row to its own `onGoToDocuments`: a handler that
            // reads the tab ref must not be bound while rendering
            // (react-hooks/refs refuses binding it in this render-time call).
            action
          : { ...action, unavailableReasonKey: "DocumentsNeedUploader" };
      case "SETTLE_SUPPLIER": {
        if (canSettleSupplier) return { ...action, onStart: () => setSettlingSupplier(true) };
        // Told apart, in the order the operator can act on: a disputed claim
        // (the money panel's own guidance), a claim this caller may not settle,
        // and a balance that is not settled from this screen at all.
        let reason = "CashSettlementNotRecordedHere";
        if (supplierGuidance) reason = "SupplierClaimDisputedGuidance";
        else if (supplierClaimSettleable || deal?.money == null) reason = "SupplierSettlementNeedsPermission";
        // S4: on the through-dealership route the supplier's share is a payable
        // the dealership owes, paid from the supplier payables page. Only that
        // position is a payable someone can pay; every other sub-case (an
        // UNKNOWN obligation, a route not known) keeps its own reason and a note.
        if (
          reason === "CashSettlementNotRecordedHere" &&
          deal?.money?.settlesDirectToSupplier === false &&
          supplierRow?.position === "DEALERSHIP_OWES"
        ) {
          return {
            ...action,
            unavailableReasonKey: "SupplierPayableRecordedOnPayables",
            ...(supplierSettlementHref
              ? { unavailableLink: { href: supplierSettlementHref, labelKey: "OpenSourcingPayablesAction" } }
              : { unavailableNoteKey: "SupplierPayablesNeedFinanceRole" }),
          };
        }
        return {
          ...action,
          unavailableReasonKey: reason,
          ...(reason === "CashSettlementNotRecordedHere"
            ? { unavailableNoteKey: "SupplierSettlementNeedsPermission" }
            : {}),
        };
      }
    }
  };

  const overviewProfit = financialOverview?.data?.financialSummary?.profit;
  const handoverManagementProfit = {
    managementProfitMinor: overviewProfit?.available ? overviewProfit.amountMinor : null,
    managementProfitClassification:
      overviewProfit?.available && overviewProfit.basis === "MANAGEMENT_ESTIMATE"
        ? overviewProfit.classification
        : null,
  };

  // SCRUM-417 UX3 (O1): every panel of the working surface, built ONCE. Which of
  // them the live step works from (the workbench) and which are kept in the
  // collapsed Deal details record is decided below; none is built twice.
  const moneyNode = (
    <div data-testid="deal-money" className="space-y-6">
          {/* --- money ---------------------------------------------------- */}
          {/* Withheld before anything is spelled, because a figure in an
              unverifiable denomination is worse than no figure: the operator
              cannot tell it is wrong. Placed ahead of the permission case so a
              caller who CAN see the money is told why it is absent, rather than
              being shown amounts scaled by a guess. */}
          {denominationUnusable ? (
            <Card className="border-destructive/40">
              <CardContent className="space-y-2 py-8 text-sm">
                <p className="font-medium text-destructive">{t("EconomicsCurrencyUnusable")}</p>
                <p className="text-muted-foreground">{t("EconomicsCurrencyUnusableHint")}</p>
              </CardContent>
            </Card>
          ) : deal.money === null ? (
            <Card>
              <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <Lock className="h-4 w-4" />
                {t("MoneyPanelHidden")}
              </CardContent>
            </Card>
          ) : (
            <>
              {!deal.money.routeKnown && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-300"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{t("RouteUnknownWarning")}</span>
                </div>
              )}

              {/* The six facts and, under them, the parties — ABSENT when
                  there is nobody to list. An OWNED cash sale has no third
                  party at all, so the row would be a heading over nothing.
                  The appraisal gap is gated on the DATA rather than on
                  `dealKind`, because a financed SALE opened on the sale-keyed
                  route is `dealKind: "FINANCED"` and still has no appraisal
                  payload. */}
              <MoneyPanel
                money={money}
                profit={deal.money.profit}
                summary={{
                  applicationId: deal.applicationId,
                  evidence: handoverEvidence ?? undefined,
                  moneyIn: servedMoney,
                }}
                overview={
                  financialOverview && custodyMoney
                    ? {
                        ...financialOverview,
                        // The panel's own short-form spelling for figures in
                        // the deal's currency (the marker the headline uses),
                        // the explicit code for anything else.
                        moneyIn: (minor: number, currency: string) =>
                          currency === dealCurrency ? money(minor) : custodyMoney(minor, currency),
                        formatDate: (ms: number) => renderMoment(ms, "d MMM yyyy", locale),
                      }
                    : undefined
                }
                parties={
                  deal.money.parties.length > 0 || deal.applicationId !== null
                    ? {
                        items: deal.money.parties,
                        appraisalGap:
                          deal.applicationId !== null
                            ? { amountMinor: deal.money.appraisalGapMinor }
                            : null,
                        onSettleSupplier: canSettleSupplier ? () => setSettlingSupplier(true) : undefined,
                        supplierGuidance,
                      }
                    : null
                }
                t={t}
              />

              {/* --- actual expenses -------------------------------------- */}
              {/* ABSENT on a CASH deal with no fee records, rather than a card
                  reading "expenses: 0" on every cash deal forever. A cash sale's
                  costs are already inside the vehicle's capitalized cost and
                  therefore already inside the margin above — listing them again
                  here would show the owner a cost subtracted twice.

                  Gated on the deal KIND, not merely on emptiness. A financed
                  deal keeps the card unconditionally because that is how the
                  shipped screen behaves: its expenses are real pending actuals
                  an operator is waiting on, so "none recorded yet" is
                  information rather than noise. Hiding it on emptiness alone
                  silently changed a production screen from inside a PR whose
                  scope excludes touching it. */}
              {!handoverCosts && (deal.dealKind === "FINANCED" ||
                deal.money.expenses.lines.length > 0 ||
                deal.money.expenses.actualTotalMinor !== 0) && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
            <Receipt className="h-4 w-4 shrink-0 text-money-out" aria-hidden />
            {t("ActualExpensesHeading")}
          </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {deal.money.expenses.lines.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("NoExpensesRecorded")}</p>
                  ) : (
                    deal.money.expenses.lines.map((fee) => (
                      <div key={fee.id} className="flex items-center justify-between gap-4 text-sm">
                        <span className="text-muted-foreground">
                          <bdi>{fee.description || fee.feeType}</bdi>
                        </span>
                        <span>
                          {fee.actualAmountMinor === undefined ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <Money>{money(fee.actualAmountMinor)}</Money>
                          )}
                        </span>
                      </div>
                    ))
                  )}
                  <Separator />
                  <div className="flex items-center justify-between gap-4 font-medium">
                    <span>{t("ActualExpensesHeading")}</span>
                    <Money>{money(deal.money.expenses.actualTotalMinor)}</Money>
                  </div>
                  {deal.money.expenses.awaitingActuals > 0 && (
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      <bdi>{deal.money.expenses.awaitingActuals}</bdi> {t("ExpensesAwaitingActuals")}
                    </p>
                  )}
                </CardContent>
              </Card>
              )}
            </>
          )}
    </div>
  );
  const vehicleNode = deal.vehicle ? (
      <DealVehicleCard vehicle={deal.vehicle} t={t}>
        {settlementRoute && !routeBlocksClose && (
          <SettlementRouteControl
            route={settlementRoute.route}
            canSettleDirectToSupplier={settlementRoute.canSettleDirectToSupplier}
            directRouteRefusal={settlementRoute.directRouteRefusal}
            supplierName={settlementRoute.supplierName}
            t={t}
            onChoose={settlementRoute.onChoose}
          />
        )}
      </DealVehicleCard>
  ) : null;
  const planNode = financingPlan ? (
    <FinancingPlanPanel
      plan={financingPlan.facts}
      formatMajor={financingPlan.formatMajor}
      t={t}
    />
  ) : null;
  const financeDecisionNode = financeDecision ? (
    <>
        <FinanceCompanyDecisionCard
          facts={financeDecision.facts}
          canRecordQuotation={financeDecision.canRecordQuotation}
          canRecordApproval={financeDecision.canRecordApproval}
          canEstablishLtvPercent={financeDecision.canEstablishLtvPercent}
          canRecordAppraisal={financeDecision.canRecordAppraisal}
          isOwnDeal={financeDecision.isOwnDeal}
          money={decisionMoney}
          t={t}
          onRecordQuotation={openRecordQuotation}
          onRecordAppraisal={openRecordAppraisal}
          onRecordApproved={openRecordApproval}
          onCorrectApproved={() => {
            setReopenError(null);
            setReopeningApproval(true);
          }}
        />
      {/* SCRUM-373 D2 — only on the server's verdict that it would accept. */}
      {financeDecision?.firstPaymentCorrection && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40"
        >
          <p className="min-w-0 flex-1">
            {t("ApplyQuoteFirstPaymentNotice")}{" "}
            <bdi className="tabular-nums font-semibold">
              {decisionMoney(financeDecision.firstPaymentCorrection.quoteDownPaymentMinor)}
            </bdi>
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setFirstPaymentError(null);
              setApplyingFirstPayment(true);
            }}
          >
            {t("ApplyQuoteFirstPaymentAction")}
          </Button>
        </div>
      )}
    </>
  ) : null;
  const handoverCostsNode = handoverCosts ? <HandoverCostsPanel {...handoverCosts} t={t} /> : null;
  const closingNode = closingChecklist ? (
    <Card data-testid="deal-closing-checklist">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0 pb-3">
        <CardTitle className="flex min-w-0 items-center gap-2 text-base">
          <ClipboardCheck className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          {t("ClosingReadinessHeading")}
        </CardTitle>
        {closingChecklist.legalInvoice?.onRecord && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={closingChecklist.legalInvoice.onRecord}
          >
            <FileText className="h-4 w-4 me-1.5" />
            {t("RecordLegalInvoice")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <DealClosingReadinessList
          readiness={closingChecklist.readiness}
          serviceUnavailable={closingChecklist.serviceUnavailable}
          destinations={closingDestinations}
          t={t}
        />
        {closingChecklist.legalInvoice &&
          (closingChecklist.legalInvoice.amountMinor !== undefined ? (
            <dl
              className="grid grid-cols-2 gap-4 rounded-md bg-muted/40 p-3 text-xs sm:grid-cols-4"
              data-testid="deal-legal-invoice"
            >
              <div>
                <dt className="text-muted-foreground">{t("LegalInvoiceAmount")}</dt>
                <dd className="font-semibold tabular-nums">
                  <bdi dir="ltr">{money(closingChecklist.legalInvoice.amountMinor)}</bdi>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("LegalInvoiceNumber")}</dt>
                <dd className="font-medium">{closingChecklist.legalInvoice.number ?? "-"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("LegalInvoiceDate")}</dt>
                <dd className="font-medium">
                  {closingChecklist.legalInvoice.date
                    ? formatLocalized(closingChecklist.legalInvoice.date, "d MMM yyyy", locale)
                    : "-"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("LegalInvoiceIssuedTo")}</dt>
                <dd className="font-medium">
                  {closingChecklist.legalInvoice.issuedTo
                    ? t(LEGAL_INVOICE_ISSUED_TO_LABEL[closingChecklist.legalInvoice.issuedTo] ?? closingChecklist.legalInvoice.issuedTo)
                    : "-"}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">{t("LegalInvoiceNotRecorded")}</p>
          ))}
      </CardContent>
    </Card>
  ) : null;
  const custodyNode =
    custody && custodyMoney ? <DealCustodyPanel wiring={custody} money={custodyMoney} t={t} /> : null;
  const documentsNode = (() => {
    const documentsPane = documents ? (
      <DealDocumentsPanel
        documents={documents.items}
        history={documents.history}
        checklist={deal.documents}
        canUpload={documents.canUpload}
        canVerify={documents.canVerify}
        uploadingRuleIds={documents.uploadingRuleIds}
        t={t}
        onUpload={documents.onUpload}
        onVerify={documents.onVerify}
      />
    ) : deal.documents.length > 0 ? (
      <DealDocumentsPanel
        documents={undefined}
        checklist={deal.documents}
        canUpload={false}
        canVerify={false}
        uploadingRuleIds={NO_UPLOADS}
        t={t}
        onUpload={() => {}}
        onVerify={() => {}}
      />
    ) : null;
    const activityPane = (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
    <History className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
    {t("StatusLogHeading")}
  </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {deal.timeline.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("StatusLogEmpty")}</p>
          )}
          {deal.timeline.map((entry, index) => (
        <div key={`${entry.changedAt ?? "no-date"}-${index}`} className="flex gap-3 text-sm">
          <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p>{t(STATUS_LABEL[entry.toStatus] ?? entry.toStatus)}</p>
            <p className="text-xs text-muted-foreground">
              <bdi>{entry.actorName}</bdi>
              {/* The transition is stated whether or not its moment is
                  known. `changedAt` is optional precisely so a status is
                  never withheld for want of a timestamp — and `format`
                  throws `RangeError` on an unrenderable input, which
                  during render loses the whole screen, not one row. */}
              {isRenderableMoment(entry.changedAt) && (
                <>
                  {" · "}
                  <bdi>{formatLocalized(entry.changedAt, "d MMM yyyy HH:mm", locale)}</bdi>
                </>
              )}
            </p>
          </div>
        </div>
      ))}
        </CardContent>
      </Card>
    );
    if (!hasDocumentsPane) return activityPane;
    return (
      <Tabs
        ref={lowerTabsRef}
        value={lowerTab}
        onValueChange={(value) => setLowerTab(value === "activity" ? "activity" : "documents")}
        className="scroll-mt-32 space-y-3 sm:scroll-mt-20"
        data-testid="deal-lower-tabs"
      >
        <TabsList>
          <TabsTrigger ref={documentsTriggerRef} value="documents">
            {t("DealTabDocuments")}
          </TabsTrigger>
          <TabsTrigger value="activity">{t("DealTabActivity")}</TabsTrigger>
        </TabsList>
        <TabsContent value="documents" forceMount className="data-[state=inactive]:hidden">
          {documentsPane}
        </TabsContent>
        <TabsContent value="activity" forceMount className="data-[state=inactive]:hidden">
          {activityPane}
        </TabsContent>
      </Tabs>
    );
  })();
  const panelNodes: Record<WorkbenchPanel, ReactNode> = {
    documents: documentsNode,
    financeDecision: financeDecisionNode,
    handoverCosts: handoverCostsNode,
    custody: custodyNode,
    closing: closingNode,
    money: moneyNode,
  };
  // The live step's panels that this caller actually has. A panel that is not
  // wired (no permission, no data) is absent, exactly as before.
  const workbenchPanels = panelsForStage(live?.key).filter((panel) => panelNodes[panel] != null);
  // Nothing promoted: the record is the whole surface, so it starts open —
  // never a collapsed disclosure over an empty page.
  // ...but not while the wiring can still arrive (`workbenchPending`, told by
  // the container from the real query states), so it never flashes open and
  // then snaps shut. A caller who is never given the panel is not pending.
  // Pending only matters where the stage HAS a panel to wait for.
  const waitingForPanel = workbenchPending && panelsForStage(live?.key).length > 0;
  const detailsOpen = detailsChoice ?? (workbenchPanels.length === 0 && !waitingForPanel);
  const inWorkbench = (panel: WorkbenchPanel) => workbenchPanels.includes(panel);
  // The record keeps its original order: the car, the plan, what the finance
  // company told us, the handover costs, the closing checks, custody, then the
  // documents and activity. Only what the workbench took is missing.
  const recordWorkingNodes = (
    [
      ["vehicle", vehicleNode],
      ["plan", planNode],
      ["financeDecision", inWorkbench("financeDecision") ? null : financeDecisionNode],
      ["handoverCosts", inWorkbench("handoverCosts") ? null : handoverCostsNode],
      ["closing", inWorkbench("closing") ? null : closingNode],
      ["custody", inWorkbench("custody") ? null : custodyNode],
      ["documents", inWorkbench("documents") ? null : documentsNode],
    ] as Array<[string, ReactNode]>
  ).filter(([, node]) => node != null);
  const recordMoneyColumn = !inWorkbench("money");
  const recordWorkingColumn = recordWorkingNodes.length > 0;
  const recordItems: Array<[string, ReactNode]> = [
    ...(recordMoneyColumn ? ([["money", moneyNode]] as Array<[string, ReactNode]>) : []),
    ...recordWorkingNodes,
  ];
  const checklistItems = live ? checklistOf(live) : null;
  // S7: what comes next, read from the SAME facts the card below is built from
  // -- the current sub-step when the live step has one, else the live step.
  const recordedNextLabel = recordedStep
    ? (() => {
        const item =
          checklistItems?.find((entry) => entry.status === "current") ??
          checklistItems?.find((entry) => entry.status === "pending");
        if (item) return t(item.labelKey);
        return live ? t(STAGE_LABEL[live.key] ?? live.key) : null;
      })()
    : null;
  // "Nothing left to do" is a claim about a FINISHED deal only. A stopped deal has
  // no live step either, but work can remain on it (a held deposit still to be
  // released or forfeited), so there it says only that it was recorded.
  const recordedTail = recordedNextLabel
    ? `${t("RecordedNextPrefix")} ${recordedNextLabel}`
    : allComplete
      ? t("RecordedAllDone")
      : null;
  const recordedMessage = recordedStep ? [t("RecordedLead"), recordedTail].filter(Boolean).join(" ") : null;
  // Dismissing removes the very button that had focus, which would drop it on
  // <body>. It goes to the step's heading instead (the step being looked at, or
  // the live one) -- and nothing is announced for it: the announcer speaks
  // transitions of the view, not the removal of a line. With no step on screen (a
  // finished or stopped deal) it goes to what IS there: the stopped notice, else
  // the toggle that opens the completed stages, else the deal header.
  const dismissRecorded = () => {
    recordedFeedback?.onDismiss();
    const target =
      document.querySelector<HTMLElement>(
        '[data-testid="deal-stage-view"] h2, [data-testid="deal-next-step"] h2'
      ) ??
      document.querySelector<HTMLElement>('[data-testid="deal-stopped"]') ??
      document.querySelector<HTMLElement>('[data-testid="deal-stages-toggle"]') ??
      document.querySelector<HTMLElement>('[data-testid="deal-header"]');
    if (!target) return;
    // A button is already focusable; a heading, a paragraph or the header is not.
    if (target.tabIndex < 0 && !target.matches("button, a[href], input, select, textarea")) target.tabIndex = -1;
    target.focus();
  };
  // The step being looked at, when it is not the live one: a read-only card
  // ABOVE the live step. It is one more keyed sibling in the flow, so it comes
  // and goes without ever remounting a panel.
  const recordPanel = otherStage
    ? panelsForStage(otherStage.key).find((panel) => panelNodes[panel] != null)
    : undefined;
  const stageViewNode: ReactNode = otherStage ? (
    <DealStageView
      mode={viewedMode === "live" ? "future" : viewedMode}
      stageKey={otherStage.key}
      path={dealPath}
      closed={dealClosed}
      label={t(STAGE_LABEL[otherStage.key] ?? otherStage.key)}
      state={otherStage.state}
      owner={otherStage.state === "NOT_APPLICABLE" ? undefined : stageOwnerLabel(otherStage, activeAppraisalProvider, t)}
      position={stages.findIndex((stage) => stage.key === otherStage.key) + 1}
      total={stages.length}
      hasLiveStep={live !== undefined}
      onBack={() => {
        // The back control unmounts with the card, taking focus with it: put
        // it on the rail node first (the live step's, or -- on a finished
        // deal with no live step -- the one that was being viewed), so a
        // keyboard user is never dropped onto the page.
        // A finished deal keeps its rail collapsed behind the persistent
        // "show stages" toggle: with no node on screen, focus goes there.
        // On a phone the rail is folded behind its bar (O4): its nodes are not
        // on screen, so focus goes to the bar that opens them.
        const railHidden = !railOpen && window.matchMedia?.("(max-width: 767px)").matches === true;
        const target =
          (railHidden ? document.querySelector<HTMLElement>('[data-testid="deal-mobile-rail-toggle"]') : null) ??
          document.querySelector<HTMLElement>(
            `[data-testid="deal-stage-node-${live?.key ?? otherStage.key}"]`
          ) ??
          document.querySelector<HTMLElement>('[data-testid="deal-stages-toggle"]');
        target?.focus({ preventScroll: true });
        requestStage(null);
      }}
      // The documents live in the controlled lower tabs, which may be on
      // Activity: the existing documents transition switches them first.
      onShowRecord={
        recordPanel ? (recordPanel === "documents" ? goToDocuments : () => goToFlowPanel(recordPanel)) : undefined
      }
      t={t}
    />
  ) : null;
  // The next-step card (or, for a stopped deal, the muted fact that it stopped).
  const stepNode: ReactNode = live ? (
    <StageFocusRow
      state={live.state}
      label={t(STAGE_LABEL[live.key] ?? live.key)}
      position={liveIndex + 1}
      total={stages.length}
      owner={stageOwnerLabel(live, activeAppraisalProvider, t)}
      mirrorNote={stageShowsMirrorNote(live, activeAppraisalProvider)}
      blocker={live.blocker ? t(`Blocker${live.blocker}`) : undefined}
      action={workflowAction?.stageKey === live.key ? resolveFocusAction(workflowAction) : undefined}
      outstandingDocuments={
        live.blocker === "DocumentsIncomplete"
          ? deal.documents.filter(
              (doc) => doc.required && doc.status !== "VERIFIED" && doc.status !== "WAIVED"
            )
          : []
      }
      onGoToDocuments={hasDocumentsPane ? goToDocuments : undefined}
      documentsActionable={documentsActionable}
      checklist={
        checklistItems
          ? {
              items: checklistItems,
              // Only destinations the cockpit already has, and only for a
              // caller who can act there: the same gates as the blocker links.
              go: (destination) => {
                if (destination === "documents") {
                  return hasDocumentsPane && documentsActionable ? goToDocuments : undefined;
                }
                if (destination === "handoverCosts") return costsDestination?.onGo;
                // Recording the approved amount is the approver's act: a caller
                // without that authority is told who acts, not sent to a form.
                if (destination === "financeDecision") {
                  return financeDecision?.canRecordApproval && panelNodes.financeDecision != null
                    ? () => goToFlowPanel("financeDecision")
                    : undefined;
                }
                if (destination === "closing") {
                  return panelNodes.closing != null ? () => goToFlowPanel("closing") : undefined;
                }
                return undefined;
              },
            }
          : undefined
      }
      t={t}
    >
      {/* The route IS the blocker on this step, so the control is on the
          step — an operator told "record who the finance company pays"
          must not have to hunt for where. Rendered here INSTEAD of beside
          the vehicle, never in both places. */}
      {routeBlocksClose && settlementRoute && (
        <SettlementRouteControl
          route={settlementRoute.route}
          canSettleDirectToSupplier={settlementRoute.canSettleDirectToSupplier}
          directRouteRefusal={settlementRoute.directRouteRefusal}
          supplierName={settlementRoute.supplierName}
          t={t}
          onChoose={settlementRoute.onChoose}
        />
      )}
    </StageFocusRow>
  ) : !allComplete ? (
      /* No live stage and not finished: the deal stopped. Said in the
         muted register — a stopped deal is a fact, not an alarm; the
         held-deposit strip above carries the alarm when there is one. */
      <p className="text-sm text-muted-foreground" data-testid="deal-stopped">
        {t("DealStopped")}
      </p>
  ) : null;

  // ONE parent, one keyed list: the next-step card, every movable panel and the
  // Deal-details toggle are siblings, and the stage only changes their ORDER.
  // React moves a keyed sibling without remounting it, so a panel that changes
  // place when the live stage changes keeps its local state — the add-cost
  // form's intent, an open custody dialog and its identity, an UNKNOWN attempt.
  // Collapsing is the 'hidden' attribute, never an unmount, for the same reason.
  // DOM order equals visual order, so tab order follows what is on screen.
  const recordIds = recordItems.map(([panel]) => "deal-record-" + panel);
  const recordWorking = recordItems.filter(([panel]) => panel !== "money");
  const flow: Array<{ key: string; zone: "step" | "workbench" | "toggle" | "record"; className: string; style?: CSSProperties; node: ReactNode }> = [];
  if (stageViewNode != null) flow.push({ key: "stage-view", zone: "step", className: "xl:col-span-5", node: stageViewNode });
  if (stepNode != null) flow.push({ key: "next-step", zone: "step", className: "xl:col-span-5", node: stepNode });
  for (const panel of workbenchPanels) {
    flow.push({ key: panel, zone: "workbench", className: "xl:col-span-5", node: panelNodes[panel] });
  }
  if (recordItems.length > 0) flow.push({
    key: "details-toggle",
    zone: "toggle",
    className: "xl:col-span-5",
    node: (
      <button
        type="button"
        data-testid="deal-details-toggle"
        aria-expanded={detailsOpen}
        aria-controls={recordIds.join(" ")}
        onClick={() => setDetailsChoice(!detailsOpen)}
        className="group flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0">
          <span className="block text-base font-semibold">{t("DealDetailsHeading")}</span>
          <span className="block text-xs text-muted-foreground">{t("DealDetailsHint")}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 transition-transform group-aria-expanded:rotate-180" aria-hidden />
      </button>
    ),
  });
  // Split only at xl: at lg the money column is ~220px beside a 256px sidebar —
  // too narrow for its figures — so it stacks instead. Two of five tracks, not
  // a strict third: a third is ~300px at 1280. The money spans the rows of the
  // working panels beside it (the reading side first, SCRUM-372).
  for (const [panel, node] of recordItems) {
    const isMoney = panel === "money";
    flow.push({
      key: panel,
      zone: "record",
      className: !recordMoneyColumn || !recordWorkingColumn
        ? "xl:col-span-5"
        : isMoney
          ? "xl:col-span-2 xl:col-start-1 xl:[grid-row:span_var(--record-rows)]"
          : "xl:col-span-3 xl:col-start-3",
      style: isMoney && recordWorkingColumn ? ({ "--record-rows": recordWorking.length } as CSSProperties) : undefined,
      node,
    });
  }


  // The money column spans the rows of the working panels beside it. When the
  // money is TALLER than they are, a spanning item shares its extra height
  // equally across every row it spans, which pushes the working cards apart.
  // Every row but the last is sized to its content and the last takes the
  // slack, so the cards stay together and the spare height sits under them.
  // (One row per flow item except the money, which spans them.) The template
  // applies only while a record wrapper is shown (the has- variant on the
  // grid): collapsed, the grid has just the card and the toggle, and rows
  // sized for the hidden record would leave blank space under the toggle.
  const flowRows: CSSProperties | undefined =
    recordMoneyColumn && recordWorkingColumn
      ? ({ "--flow-rows": `repeat(${flow.length - 2}, auto) 1fr` } as CSSProperties)
      : undefined;

  // SCRUM-417 UX5 (O4). Below md the step comes first: the identity strip is
  // rendered as two copies (see `identityStrip` below), one per breakpoint and
  // never both visible, so the phone copy can sit after the step in DOM order
  // and the order Tab walks is the order it is drawn, and the stage rail folds
  // behind a "Step N of M" bar. From md up the desktop copy sits under the
  // header: nothing moves there. No CSS `order` is involved.
  const mobileStage = allComplete ? undefined : (otherStage ?? live);
  const mobileStageIndex = mobileStage ? stages.findIndex((stage) => stage.key === mobileStage.key) : -1;
  const railFolded = mobileStage !== undefined && !railOpen;

  // The identity strip (SCRUM-372): what kind of deal, which record, and the
  // people on it -- customer, finance company, salesperson. Each cell is absent
  // rather than empty: a cash deal has no finance company.
  // Drawn TWICE, one copy per breakpoint, and never both: `hidden` is display:none,
  // which removes a copy from the tab order and the accessibility tree. The desktop
  // copy sits in the DOM right under the header (where md and up paint it); the
  // phone copy is the last node of the document (where a phone paints it, after
  // the step). So Tab and a screen reader meet it in the order it is drawn, at
  // either width, with no CSS `order` to make the two disagree (SCRUM-417 UX5 R2-2).
  const identityStrip = (placement: "desktop" | "phone") => (
      <dl
        className={cn(
          "grid-cols-2 gap-x-4 gap-y-3 rounded-lg border bg-card p-4 text-sm shadow-sm sm:gap-x-6 lg:grid-cols-5",
          placement === "desktop" ? "hidden md:grid" : "grid md:hidden"
        )}
        aria-label={t("DealEssentialsHeading")}
        data-testid={placement === "desktop" ? "deal-identity" : "deal-identity-mobile"}
      >
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{t("DealTypeLabel")}</dt>
          <dd className="font-medium">
            {t(deal.dealKind === "CASH" ? "DealKindCash" : "DealKindFinanced")}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">
            {t(deal.applicationId === null ? "DealReferenceSale" : "DealReferenceApplication")}
          </dt>
          <dd className="flex min-w-0 items-center gap-1 font-medium">
            <CopyableReference value={String(deal.dealRef)} t={t} />
          </dd>
        </div>
        {deal.customer && (
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">{t("Customer")}</dt>
            <dd className="min-w-0 break-words font-medium">
              <bdi>{deal.customer.name}</bdi>
              {deal.customer.phone && (
                <>
                  {" "}
                  <bdi className="font-normal text-muted-foreground">{deal.customer.phone}</bdi>
                </>
              )}
            </dd>
          </div>
        )}
        {deal.financeCompanyName && (
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">{t("PartyFinancier")}</dt>
            <dd className="min-w-0 break-words font-medium">
              <bdi>{deal.financeCompanyName}</bdi>
            </dd>
          </div>
        )}
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{t("DealOwner")}</dt>
          <dd className="min-w-0 break-words font-medium">
            <bdi>{deal.salespersonName}</bdi>{" "}
            <bdi className="font-normal text-muted-foreground">{renderMoment(deal.createdAt, "d MMM yyyy", locale)}</bdi>
          </dd>
        </div>
        {/* The header's "last updated", in the flow on a phone only. */}
        <div className="min-w-0 sm:hidden" data-testid="deal-essentials-last-updated">
          <dt className="text-xs text-muted-foreground">{t("LastUpdated")}</dt>
          <dd className="font-medium">
            <bdi>{renderMoment(deal.updatedAt ?? deal.createdAt, "d MMM yyyy HH:mm", locale)}</bdi>
          </dd>
        </div>
      </dl>
  );

  return (
    <div className="flex flex-col gap-6">
      {/* --- header ------------------------------------------------------ */}
      {/* Sticky: the deal's identity, status and the exceptional action stay
          in view while the operator works down the rail and the money —
          the owner's workspace shell. Negative margins let the bar span the
          page padding; the backdrop keeps it legible over scrolled content. */}
      {/* The negative HORIZONTAL margins mirror the workspace `main` padding
          exactly (p-3 / sm:p-4 / md:p-6 / lg:p-8): one step wider than the
          padding and the bar is the page's only horizontal overflow.
          No negative TOP margin, deliberately. `main` is the scroll container
          and a sticky box is clamped inside its containing block, so Chromium
          shifts a `-mt-*` header straight back down by the same amount: the
          bar never moved up, only the essentials row under it did — and at
          `lg` the 32px shift ate the 24px gap and put the row's labels under
          the bar. `playwright/visual/deal-cockpit.visual.spec.ts` measures
          this in a real engine. */}
      <div
        className="sticky top-0 z-20 -mx-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-background/95 px-3 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-4 sm:px-4 md:-mx-6 md:px-6 lg:-mx-8 lg:px-8"
        data-testid="deal-header"
      >
        {backHref && (
          <Link
            href={backHref}
            className="inline-flex min-h-9 items-center gap-1 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
            {t("BackToDeals")}
          </Link>
        )}
        {/* Full-width on a phone, so the back link and the cancel share the
            first row and the identity gets a clean row of its own. */}
        <div className="order-last flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1 sm:order-none sm:flex-1 sm:basis-0">
          <h1 className="whitespace-nowrap text-xl font-semibold tracking-tight">
            {/* The TITLE names the RECORD, so it follows the server's own
                identity of the deal (`applicationId`), not `dealKind`: an
                applicationless FINANCED/LEASE sale is `dealKind: "FINANCED"`
                and still has no finance application to be titled after —
                headed `طلب تمويل` it named a record that does not exist for
                it. `dealRef` rather than the application id for the same
                reason. Both queries supply both. */}
            {t(deal.applicationId === null ? "DealCockpitTitleCash" : "DealCockpitTitle")}{" "}
            <bdi className="font-normal text-muted-foreground">#{String(deal.dealRef).slice(-4)}</bdi>
          </h1>
          <Badge variant={deal.status === "APPROVED" || deal.status === "CLOSED" ? "default" : "secondary"}>
            {t(dealStatusBadgeKey(deal.status, deal.stages))}
          </Badge>
          {/* Whose move the deal is on, from the same source the rail uses —
              one owner per screen, never two. */}
          {live && stageOwnerLabel(live, activeAppraisalProvider, t) && (
            <span className="text-sm text-muted-foreground">
              <bdi>{stageOwnerLabel(live, activeAppraisalProvider, t)}</bdi>
            </span>
          )}
          {/* Off the sticky bar on a phone, where every row it takes is a row
              of the deal hidden under it; the essentials carry it there. */}
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {t("LastUpdated")}: <bdi>{renderMoment(deal.updatedAt ?? deal.createdAt, "d MMM yyyy HH:mm", locale)}</bdi>
          </span>
        </div>
        {/* The exceptional action, in the header and quiet on purpose: it is
            never the recommended next step, so it must not compete with the
            one CTA the focus panel carries. Present only when the SERVER would
            accept it from this caller. Kept visible rather than folded into a
            menu: it would be the menu's only item, and a destructive action
            behind a one-item menu is hidden, not tidied. */}
        {forwardCorrection && (
          <div className="ms-auto flex flex-wrap items-center gap-1" data-testid="deal-forward-correction">
            {forwardCorrection.canVoid && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9"
                data-testid="deal-forward-void"
                onClick={() => forwardCorrection.onOpen("VOID")}
              >
                {t("ForwardVoidAction")}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-9"
              data-testid="deal-forward-returned"
              onClick={() => forwardCorrection.onOpen("RETURNED")}
            >
              {t("ForwardReturnedAction")}
            </Button>
          </div>
        )}
        {chequeReturn && (
          <Button
            variant="ghost"
            size="sm"
            className={forwardCorrection ? "h-9" : "ms-auto h-9"}
            data-testid="deal-cheque-returned-by-bank"
            onClick={chequeReturn.onOpen}
          >
            {t("ChequeReturnedByBankAction")}
          </Button>
        )}
        {cancel && (
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-9 text-destructive hover:text-destructive", !(forwardCorrection || chequeReturn) && "ms-auto")}
            data-testid="deal-cancel-application"
            onClick={() => cancel.onOpenChange(true)}
          >
            <Ban className="h-4 w-4" aria-hidden />
            {t("CancelApplication")}
          </Button>
        )}
        {unwind?.offered && (
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-9 text-destructive hover:text-destructive", !(forwardCorrection || chequeReturn) && "ms-auto")}
            data-testid="deal-unwind-deal"
            onClick={() => unwind.onOpenChange(true)}
          >
            <Ban className="h-4 w-4" aria-hidden />
            {t(unwind.status.status === "ACTIVE" ? "UnwindDealResume" : "UnwindDealAction")}
          </Button>
        )}
        {!cancel && cancelHint && (
          <span className="ms-auto text-xs text-muted-foreground" data-testid="deal-cancel-manager-hint">
            {t(cancelHint === "FORWARD" ? "CancelWaitsForForward" : "ManagerCancelsFinalizedDeal")}
          </span>
        )}
      </div>

      {unwind?.offered && (
        <p
          className="rounded-md border border-amber-500/40 border-s-4 border-s-amber-500 bg-amber-500/5 p-3 text-sm"
          role="status"
          data-testid="deal-unwind-banner"
        >
          {t(unwind.status.status === "ACTIVE" ? "UnwindInProgressBadge" : "UnwindPaidDealBanner")}
        </p>
      )}
      {unwind && !unwind.offered && unwind.status.status === "ACTIVE" && (
        // A viewer who may act on none of it still sees that the deal is being unwound.
        <p
          className="rounded-md border border-amber-500/40 border-s-4 border-s-amber-500 bg-amber-500/5 p-3 text-sm"
          role="status"
          data-testid="deal-unwind-banner"
        >
          {t("UnwindInProgressBadge")}
        </p>
      )}
      {unwind && !unwind.offered && unwind.hint && (
        <p className="text-sm text-muted-foreground" data-testid="deal-unwind-hint">
          {(() => {
            const key = `ServerError_${unwind.hint.code}`;
            const text = t(key);
            return text === key ? unwind.hint.message : text;
          })()}
        </p>
      )}

      {identityStrip("desktop")}

      {/* --- the two records that disagree -------------------------------- */}
      {/* Above the stage rail, not inside the money column. The rail tells the
          deal's normal story; this is the exception that has stopped it, so it
          has to be the first thing read.
          The WARNING is ungated — a deal stuck in reconciliation that only the
          accountant can see is not a warning. The FIGURES inside it are gated,
          and the SERVER decides: `settlementAdviceDiscrepancy` arrives `null`
          for a caller without `view:finance`, so this renders the alert and its
          explanation with no amounts under it. Nothing here re-derives the
          permission, which is why the two cannot drift apart. */}
      {deal.settlementAdviceRequiresReconciliation && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 border-s-4 border-s-destructive bg-destructive/5 p-4"
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <div className="min-w-0 space-y-1">
              <p className="font-medium text-destructive">
                {t("SettlementAdviceDiscrepancyTitle")}
              </p>
              <p className="max-w-prose text-sm text-muted-foreground">
                {t("SettlementAdviceDiscrepancyBody")}
              </p>
            </div>
          </div>

          {/* Figures and action on one row, in that order.
              The discrepancy IS the content, so it is set as the two records
              facing each other rather than described in a sentence. Each figure
              is its own `<bdi>` run: an Arabic label beside a Latin amount
              beside a currency marker is exactly the bidi case that reorders
              into nonsense when left as one run.
              The action comes AFTER them and not beside the heading, because on
              a phone the row wraps in source order — and the first rendered
              layout put "correct the advice" between the explanation and the
              evidence, offering the fix before showing what needs fixing.
              Indented to the text on desktop only; on a 390px screen that
              indent costs width the three figures need to stay on one line. */}
          {/* Only for a caller the SERVER sent the evidence to. The correction
              button lives in here with it, and that is the point: correcting a
              figure you were never shown is a guess, not a correction.
              `manage:finance` and `view:finance` are independent permissions and
              roles here are customizable, so one can be held without the other —
              this nesting is what stops the button appearing for such a role. */}
          {discrepancy && (
          <div className="mt-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 sm:ps-6">
            <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div className="space-y-0.5">
                <dt className="text-xs text-muted-foreground">{t("SettlementAdviceRecorded")}</dt>
                <dd className="font-semibold">
                  <Money>{adviceRecordedLabel}</Money>
                </dd>
              </div>
              <div className="space-y-0.5">
                <dt className="text-xs text-muted-foreground">{t("SettlementAdviceApproved")}</dt>
                <dd className="font-semibold">
                  <Money>{adviceApprovedLabel}</Money>
                </dd>
              </div>
              {adviceDifferenceLabel && (
                <div className="space-y-0.5">
                  <dt className="text-xs text-muted-foreground">
                    {t("SettlementAdviceDifference")}
                  </dt>
                  <dd className="font-semibold text-destructive">
                    <Money>{adviceDifferenceLabel}</Money>
                  </dd>
                </div>
              )}
            </dl>
            {canCorrectAdvice && (
              <Button
                variant="outline"
                size="sm"
                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setCorrectingAdvice(true)}
              >
                {t("CorrectSettlementAdvice")}
              </Button>
            )}
          </div>
          )}
        </div>
      )}

      {/* --- held customer deposit on a stopped deal ----------------------
          Above the rail on purpose. On a rejected or cancelled deal the rail
          has nothing left to say — every stage is STOPPED — while the one thing
          still outstanding is real customer cash sitting in a liability with
          nobody's name on it. A single bordered strip rather than a card: at
          this density an alert earns its weight from colour and position. */}
      {depositRequests && depositRequests.requests.length > 0 && (
        <DealPendingDepositRequests
          orgId={depositRequests.orgId}
          requests={depositRequests.requests}
        />
      )}

      {(depositAwaitingResolution || deposits) && (
        <div
          className={
            depositAwaitingResolution
              ? "space-y-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/30"
              : "space-y-3 rounded-md border bg-muted/30 px-3 py-2"
          }
          data-testid={depositAwaitingResolution ? "deal-deposit-awaiting-resolution" : "deal-deposits-resolved"}
        >
          {depositAwaitingResolution && (
            <div>
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                {t("DepositAwaitingResolutionTitle")}
              </p>
              <p className="text-sm text-amber-800 dark:text-amber-300">
                {t("DepositAwaitingResolutionBody")}
              </p>
            </div>
          )}
          {/* The deposits themselves, and the decision on each HELD one — the
              action the applications list has been pointing at Review for.
              The amounts are the org-currency majors `applications.get`
              lists, formatted the way that dialog formatted them. */}
          {deposits && (
            <StoppedDealDepositsPanel
              deposits={deposits.items}
              canResolve={deposits.canResolve}
              faceValueIsReleasable={deposits.faceValueIsReleasable}
              resolvingId={deposits.resolvingId}
              formatAmount={(amount) => currency.format(amount)}
              t={t}
              onResolve={deposits.onResolve}
              unconfirmed={deposits.unconfirmed}
              onDismissUnconfirmed={deposits.onDismissUnconfirmed}
            />
          )}
        </div>
      )}

      {/* --- finance-company cheque: face, correction, re-registration ------
          Workflow flags only (no amounts) from the server. Above the rail for
          the same reason the discrepancy alert is: it is the exception that
          stops the disbursement stage. */}
      {fcCheque && "chequePaymentRegistered" in deal && (
        <FcChequePanel
          canManage={canCorrectAdvice}
          canRegisterPayment={canRegisterPayment}
          needsCorrection={deal.chequeNeedsCorrection === true}
          needsAccountingReview={deal.chequeNeedsAccountingReview === true}
          chequeFaceAttested={deal.chequeFaceAttested === true}
          chequeFaceUnrecorded={deal.chequeFaceUnrecorded}
          unattestedChequeId={deal.unattestedChequeId ?? null}
          expectedPaymentCorrectable={deal.expectedPaymentCorrectable}
          chequePaymentRegistered={deal.chequePaymentRegistered}
          needsReRegistration={deal.expectedPaymentReRegistrable}
          t={t}
          onAttest={fcCheque.onAttest}
          onCorrect={fcCheque.onCorrect}
          onRegister={() => expectedPayment?.onOpenChange(true)}
        />
      )}

      {/* --- stage rail: the signature element ---------------------------- */}
      {/* Compact: one node per stage, the current one emphasised, the rest
          quiet. A finished deal gets a single completion line with the rail
          one click away. The rail is a PROGRESS readout only; the live stage
          is worked from the focus panel directly beneath it, and both read the
          same `live` so they cannot name different stages. */}
      {mobileStage && (
        <div className="md:hidden" data-testid="deal-mobile-stepbar">
          <button
            type="button"
            data-testid="deal-mobile-rail-toggle"
            aria-expanded={railOpen}
            aria-controls="deal-stage-rail-panel"
            onClick={() => setRailOpen((open) => !open)}
            className="group flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-lg border bg-card px-4 py-2.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0">
              <span className="block text-xs text-muted-foreground" data-testid="deal-mobile-step-position">
                <StagePosition
                  t={t}
                  labelKey="MobileStepLabel"
                  position={mobileStageIndex + 1}
                  total={stages.length}
                />
                {/* Looking at a step that is not the live one: the bar names
                    that stage, so it must not read like "you are here". */}
                {otherStage && (
                  <>
                    {" · "}
                    <span className="font-medium text-foreground" data-testid="deal-mobile-step-viewing">
                      {t("MobileStepViewing")}
                    </span>
                  </>
                )}
              </span>
              <span className="block break-words text-base font-semibold leading-snug">
                {t(STAGE_LABEL[mobileStage.key] ?? mobileStage.key)}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
              {t(railOpen ? "HideAllSteps" : "ShowAllSteps")}
              <ChevronDown className="h-4 w-4 transition-transform group-aria-expanded:rotate-180" aria-hidden />
            </span>
          </button>
        </div>
      )}
      {allComplete ? (
        <div className="space-y-3">
          <DealStagesComplete
            count={stages.filter((s) => s.state === "COMPLETE").length}
            notNeeded={stages.filter((s) => s.state === "NOT_APPLICABLE").length}
            expanded={showCompleted}
            onToggle={() => setShowCompleted((open) => !open)}
            t={t}
          />
          {showCompleted && (
            <DealStageRail stages={railStages} t={t} viewedKey={otherStage?.key ?? null} onSelect={requestStage} />
          )}
        </div>
      ) : (
        <div id="deal-stage-rail-panel" className={railFolded ? "hidden md:block" : undefined}>
          <DealStageRail stages={railStages} t={t} viewedKey={otherStage?.key ?? null} onSelect={requestStage} />
        </div>
      )}

      {/* --- the step, its panel, and the rest of the deal ---------------- */}
      {/* The card carries `deal-next-step`; the live step's own panel follows it
          directly; the rest of the deal sits behind the Deal-details toggle,
          whole. Nothing is removed and nothing is drawn twice. */}
      <StageViewAnnouncer
        recordedMessage={recordedMessage}
        viewKey={otherStage?.key ?? null}
        message={
          otherStage
            ? `${t("StageViewAnnounceShowing")}: ${t(STAGE_LABEL[otherStage.key] ?? otherStage.key)}, ${t(STAGE_STATE_KEY[otherStage.state])}`
            : null
        }
        restoreMessage={
          live
            ? `${t("StageViewAnnounceBack")}: ${t(STAGE_LABEL[live.key] ?? live.key)}`
            : t("StageViewAnnounceBackDone")
        }
      />
      {recordedMessage !== null && (
        <div
          data-testid="deal-recorded-feedback"
          className="flex items-start gap-3 rounded-lg border border-emerald-700/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-950 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-50"
        >
          <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1">
            <span className="font-semibold">{t("RecordedLead")}</span>{" "}
            {recordedNextLabel ? (
              <>
                {t("RecordedNextPrefix")} <bdi className="font-medium">{recordedNextLabel}</bdi>
              </>
            ) : allComplete ? (
              t("RecordedAllDone")
            ) : null}
          </p>
          <button
            type="button"
            data-testid="deal-recorded-feedback-dismiss"
            onClick={dismissRecorded}
            className="min-h-9 shrink-0 cursor-pointer rounded-md px-2 text-xs font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("DismissRecorded")}
          </button>
        </div>
      )}
      <div
        ref={flowRef}
        className="grid min-w-0 gap-6 xl:grid-cols-5 xl:has-[>[data-zone=record]:not([hidden])]:[grid-template-rows:var(--flow-rows)]"
        style={flowRows}
        onFocus={(event) => {
          flowFocusRef.current = event.target as HTMLElement;
        }}
        onBlur={(event) => {
          // A real blur leaves the element in the document; a node that is
          // being moved is not a decision to leave, so its memory is kept.
          if ((event.target as HTMLElement).isConnected) flowFocusRef.current = null;
        }}
      >
        {flow.map((item) => (
          <div
            key={item.key}
            data-zone={item.zone}
            id={
              item.zone === "record"
                ? "deal-record-" + item.key
                : item.zone === "workbench"
                  ? "deal-workbench-" + item.key
                  : undefined
            }
            hidden={item.zone === "record" && !detailsOpen}
            className={cn("min-w-0", item.className)}
            style={item.style}
          >
            {item.node}
          </div>
        ))}
      </div>

      {/* --- essentials, phone copy ---------------------------------------- */}
      {/* Last in the document: on a phone it is drawn after the step. The copy
          for md and up is right under the header (see `identityStrip`). */}
      {identityStrip("phone")}


      {/* Mounted only while the action is offered: losing authority or the
          settle-able state UNMOUNTS an open dialog rather than leaving a form
          whose submit the server will refuse. */}
      {supplierRow && canSettleSupplier && (
        <SupplierSettlementDialog
          open={settlingSupplier}
          submitting={submitting}
          supplierName={supplierRow.name}
          outstandingMajor={supplierRow.amountMinor / factor}
          outstandingLabel={money(supplierRow.amountMinor)}
          t={t}
          onOpenChange={setSettlingSupplier}
          onConfirm={handleSupplierReceipt}
        />
      )}

      {financeDecision && (
        <>
          <RecordSubmittedQuotationDialog
            open={recordingQuotation}
            submitting={quotationSubmitting}
            error={quotationError}
            calculation={financeDecision.calculation}
            requiresLtvPercent={financeDecision.facts.ltvMissing}
            // The permission the SERVER checks for the rate — deliberately not
            // `canRecordQuotation`, which the SALES template also holds.
            canSetLtvPercent={financeDecision.canEstablishLtvPercent}
            factor={decisionFactor}
            money={decisionMoney}
            t={t}
            onOpenChange={setRecordingQuotation}
            onSubmit={handleRecordQuotation}
          />
          <RecordAppraisalDialog
            open={recordingAppraisal}
            submitting={appraisalSubmitting}
            error={appraisalError}
            existingAppraisalMinor={financeDecision.facts.appraisalAmountMinor}
            approvalWouldBeReopened={financeDecision.facts.approvedPurchaseRecorded}
            factor={decisionFactor}
            money={decisionMoney}
            t={t}
            onOpenChange={setRecordingAppraisal}
            onSubmit={handleRecordAppraisal}
          />
          <RecordApprovedPurchaseDialog
            open={recordingApproval}
            submitting={approvalSubmitting}
            error={approvalError}
            appraisal={financeDecision.appraisal}
            submittedQuotationMinor={financeDecision.facts.submittedQuotationMinor}
            appliedLtvPercent={financeDecision.facts.appliedLtvPercent}
            factor={decisionFactor}
            money={decisionMoney}
            t={t}
            onOpenChange={setRecordingApproval}
            onSubmit={handleRecordApproved}
          />
          <ReopenApprovedPurchaseDialog
            open={reopeningApproval}
            submitting={reopenSubmitting}
            error={reopenError}
            currentAmountMinor={financeDecision.facts.approvedPurchaseAmountMinor}
            money={decisionMoney}
            t={t}
            onOpenChange={setReopeningApproval}
            onSubmit={handleReopenApproved}
          />
          {financeDecision.firstPaymentCorrection && (
            <ApplyQuoteFirstPaymentDialog
              open={applyingFirstPayment}
              submitting={firstPaymentSubmitting}
              error={firstPaymentError}
              quoteDownPaymentMinor={financeDecision.firstPaymentCorrection.quoteDownPaymentMinor}
              economicsStamp={financeDecision.firstPaymentCorrection.economicsStamp}
              money={decisionMoney}
              t={t}
              onOpenChange={setApplyingFirstPayment}
              onSubmit={handleApplyQuoteFirstPayment}
            />
          )}
        </>
      )}

      {/* Only for a deal that actually has a shortfall the caller can see. The
          gap comes from the server's own money block — this screen never
          derives it, because a locally computed gap could disagree with the one
          the mutation reconciles against and reject the operator's arithmetic
          for being right. */}
      {gapResolution && typeof deal?.money?.appraisalGapMinor === "number" && (
        <ResolveGapDialog
          open={gapResolution.resolving}
          submitting={gapResolution.submitting}
          rawAppraisalGapMinor={deal.money.appraisalGapMinor}
          submittedQuotationMinor={gapResolution.submittedQuotationMinor}
          approvedPurchaseAmountMinor={gapResolution.approvedPurchaseAmountMinor}
          economicsStamp={"economicsStamp" in deal ? deal.economicsStamp : undefined}
          factor={factor}
          money={money}
          t={t}
          onOpenChange={gapResolution.onOpenChange}
          onSubmit={gapResolution.onSubmit}
        />
      )}

      {handover && (
        <ConfirmHandoverDialog
          open={handover.confirming}
          submitting={handover.submitting}
          // Read from the SAME facts the decision card renders, so the figures
          // the dialog asks the operator to verify are the ones they have been
          // looking at — not a second derivation that could disagree.
          // The server's one answer, handed over whole. This screen forms no
          // opinion about the figures, the anomaly verdict, or how any of it is
          // denominated — the legacy Review screen consumes the same object.
          evidence={
            handoverEvidence
              ? { ...handoverEvidence, ...handoverManagementProfit }
              : {
                  approvedPurchaseAmountMinor: null,
                  financeCompanyFundedPortionMinor: null,
                  dealerContributionMinor: null,
                  approvedAmountIsFarFromEvidence: false,
                  currency: null,
                  ...handoverManagementProfit,
                }
          }
          // `deal` is a union — the cash variant comes from `sales.dealCockpit`
          // and carries no stamp, because nothing on that path seals financing
          // economics. Narrowed by presence rather than by `dealKind` so a
          // future payload that stops issuing one fails here, at the point that
          // needs it, instead of silently sending `undefined` to the mutation.
          economicsStamp={deal && "economicsStamp" in deal ? deal.economicsStamp : undefined}
          t={t}
          onOpenChange={handover.onOpenChange}
          onSubmit={handover.onSubmit}
        />
      )}

      {/* The form itself is the review dialog's, reused rather than rebuilt:
          one shape for the cheque fields, one schema, one set of rules about
          what a cheque needs. Only its opener differs — here the next-step
          block owns that, so the dialog renders without its own trigger. */}
      {expectedPayment && (
        <RegisterExpectedPaymentDialog
          open={expectedPayment.registering}
          withTrigger={false}
          disabled={expectedPayment.submitting}
          submitting={expectedPayment.submitting}
          error={expectedPayment.error}
          t={t}
          onOpenChange={expectedPayment.onOpenChange}
          onConfirm={expectedPayment.onSubmit}
        />
      )}

      {finalize && (
        <ConfirmFinalizeDialog
          open={finalize.confirming}
          submitting={finalize.submitting}
          error={finalize.error}
          t={t}
          onOpenChange={finalize.onOpenChange}
          onSubmit={finalize.onSubmit}
          profitApproval={finalize.profitApproval}
          readinessHold={finalize.readinessHold}
        />
      )}

      {creditDecision && (
        <CreditDecisionDialog
          open={creditDecision.deciding}
          submitting={creditDecision.submitting}
          error={creditDecision.error}
          canApprove={creditDecision.canApprove}
          canReject={creditDecision.canReject}
          isOwnDeal={creditDecision.isOwnDeal}
          documentsIncomplete={creditDecision.documentsIncomplete}
          t={t}
          onOpenChange={creditDecision.onOpenChange}
          onSubmit={creditDecision.onSubmit}
        />
      )}

      {forwardCorrection && (
        <ForwardCorrectionDialog
          open={forwardCorrection.open !== null}
          kind={forwardCorrection.open ?? "RETURNED"}
          submitting={forwardCorrection.submitting}
          t={t}
          onOpenChange={(next) => {
            if (!next) forwardCorrection.onClose();
          }}
          onConfirm={forwardCorrection.onConfirm}
        />
      )}
      {chequeReturn && (
        <ChequeReturnedByBankDialog
          open={chequeReturn.open}
          submitting={chequeReturn.submitting}
          t={t}
          onOpenChange={(next) => {
            if (!next) chequeReturn.onClose();
          }}
          onConfirm={chequeReturn.onConfirm}
        />
      )}
      {unwind?.offered && (
        <UnwindDealDialog
          open={unwind.open}
          status={unwind.status}
          submitting={unwind.submitting}
          error={unwind.error}
          formatMinor={unwind.formatMinor}
          notBefore={unwind.notBefore}
          t={t}
          onOpenChange={unwind.onOpenChange}
          onStart={unwind.onStart}
          onForwardReturn={unwind.onForwardReturn}
          onFinish={unwind.onFinish}
          onAbandon={unwind.onAbandon}
        />
      )}
      {cancel && (
        <CancelApplicationDialog
          open={cancel.confirming}
          submitting={cancel.submitting}
          error={cancel.error}
          isClosed={cancel.isClosed}
          t={t}
          onOpenChange={cancel.onOpenChange}
          onSubmit={cancel.onSubmit}
        />
      )}

      {/* Both mounted without their own trigger: the DISBURSEMENT focus row
          owns the action, and which of the two it opens follows the recorded
          route. Confirming the dealership's receipt posts DR Bank; recording
          the supplier's advice moves no dealership money. */}
      {disbursement && (
        <>
          {disbursement.forward && (
            <RecordForwardToFinanceCompanyDialog
              open={disbursement.forward.confirming}
              submitting={disbursement.forward.submitting}
              totalLabel={disbursement.forward.totalLabel}
              depositLabel={disbursement.forward.depositLabel}
              contributionLabel={disbursement.forward.contributionLabel}
              t={t}
              onOpenChange={disbursement.forward.onOpenChange}
              onConfirm={disbursement.forward.onConfirm}
            />
          )}
          <DisbursementConfirmationDialog
            open={disbursement.financeCompany.confirming}
            withTrigger={false}
            disabled={disbursement.financeCompany.submitting}
            submitting={disbursement.financeCompany.submitting}
            amountLabel={disbursement.financeCompany.amountLabel}
            t={t}
            onOpenChange={disbursement.financeCompany.onOpenChange}
            onConfirm={disbursement.financeCompany.onConfirm}
          />
          <DisbursementConfirmationDialog
            mode="SUPPLIER"
            open={disbursement.supplier.confirming}
            withTrigger={false}
            disabled={disbursement.supplier.submitting}
            submitting={disbursement.supplier.submitting}
            supplierName={disbursement.supplier.supplierName}
            amountLabel={disbursement.supplier.amountLabel}
            defaultAmountMajor={disbursement.supplier.defaultAmountMajor}
            t={t}
            onOpenChange={disbursement.supplier.onOpenChange}
            onConfirm={() => undefined}
            onConfirmSupplier={disbursement.supplier.onConfirm}
          />
        </>
      )}

      {discrepancy && canCorrectAdvice && (
        <SettlementAdviceCorrectionDialog
          open={correctingAdvice}
          submitting={correctionSubmitting}
          recordedMajor={
            discrepancy.recordedMinor != null
              ? discrepancy.recordedMinor / discrepancyFactor
              : null
          }
          recordedReference={discrepancy.recordedReference ?? null}
          recordedAt={discrepancy.recordedAt ?? null}
          recordedLabel={adviceRecordedLabel}
          approvedLabel={adviceApprovedLabel}
          t={t}
          onOpenChange={setCorrectingAdvice}
          onCorrect={handleCorrectAdvice}
        />
      )}
    </div>
  );
}

/**
 * The stage the deal is on — the primary surface of the screen.
 *
 * Everything the operator needs for the current step lives here: what it is,
 * whose move it is, the one thing being waited on, and the ONE action. The
 * compact rail above it is a progress readout, never a second working panel;
 * both are rendered from the same `live` stage, so the two cannot announce
 * different steps — the defect the previous "next step" card had.
 *
 * It keeps `data-testid="deal-next-step"` deliberately. The id names the block
 * that carries the action, which is exactly what this is; a spec scoped to this
 * block cannot pass against a stage name rendered somewhere else.
 */
/**
 * The sentence above a step with nothing blocking it. A cash sale still in
 * draft is not "nothing outstanding" — it is the thing outstanding (W3).
 */
function stageReadyKey(actionKey: string | undefined): string {
  if (actionKey === "RegisterHandoverAction" || actionKey === "ActionConfirmHandover") {
    return "StageReadyForHandoverAction";
  }
  if (actionKey === "CompleteCashSaleAction") return "StageCashSaleIsDraft";
  return "StageReadyToProceed";
}

export function StageFocusRow({
  state,
  label,
  position,
  total,
  owner,
  mirrorNote,
  blocker,
  action,
  outstandingDocuments,
  onGoToDocuments,
  documentsActionable = true,
  checklist,
  t,
  children,
}: Readonly<{
  state: DealStageState;
  label: string;
  /** 1-based place on the rail, for the "Step 3 of 8" kicker. */
  position: number;
  total: number;
  /** Whose move it is, resolved from server authority AND recorded provenance. */
  owner?: string;
  /** A control that belongs ON this step because it is what the step waits on. */
  children?: React.ReactNode;
  /** Whether the "AutoFlow only records their decision" sentence is TRUE here. */
  mirrorNote: boolean;
  blocker?: string;
  /** Already resolved by the view: a present `onStart` is a button that works. */
  action?: Omit<WorkflowAction, "stageKey">;
  outstandingDocuments: ReadonlyArray<{ ruleId: string; name: string }>;
  /** Absent when the screen has no documents tab to go to. */
  onGoToDocuments?: () => void;
  /**
   * False when the caller can neither upload nor verify (the container's own
   * verdict): the passive link is then withheld, since the checklist it leads
   * to has nothing this caller can press (SCRUM-417 UX1, S3).
   */
  documentsActionable?: boolean;
  /**
   * The sub-steps of this stage (SCRUM-417 UX4, O2) and where the current one
   * is acted on. `go` returns a handler only for a destination this caller has.
   */
  checklist?: {
    items: ReadonlyArray<ChecklistItem>;
    go: (destination: Exclude<ChecklistDestination, "primaryAction">) => (() => void) | undefined;
  };
  t: (key: string) => string;
}>) {
  const icon = STAGE_ICON[state];
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  const primary =
    action && action.unavailableReasonKey === undefined
      ? action.opens === "DOCUMENTS"
        ? onGoToDocuments
        : action.onStart
      : undefined;

  return (
    <Card
      className={state === "BLOCKED" ? "border-amber-500/50" : "border-primary/40"}
      data-testid="deal-next-step"
    >
      <CardContent className="space-y-3 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="mt-1 shrink-0">{icon}</span>
          <div className="min-w-0 flex-1 space-y-3">
            <div className="min-w-0 space-y-1">
              <p className="text-xs text-muted-foreground">
                <StagePosition t={t} position={position} total={total} />
              </p>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <h2 className="text-lg font-semibold leading-tight">{label}</h2>
                {/* Whose move it is, said before anything else on the step. An
                    operator who reads "finance company" stops looking for a
                    button that must never exist. `bdi` because the owner can
                    be an Arabic party name beside Latin text. */}
                {owner && (
                  <Badge variant="outline" className="font-normal">
                    <bdi>{owner}</bdi>
                  </Badge>
                )}
              </div>
            </div>

            {/* What is being waited on — the one genuine blocker on this
                step, with the documents it names under it. A stage with
                nothing outstanding says so rather than going silent, but in
                the MUTED colour: amber on "nothing is outstanding" painted a
                warning over the absence of a problem. */}
            {blocker ? (
              <div className="rounded-md border-s-2 border-amber-600 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:border-amber-500 dark:text-amber-200">
                <p>{blocker}</p>
                {outstandingDocuments.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {outstandingDocuments.map((doc) => (
                      <li key={doc.ruleId} className="flex items-center gap-2">
                        <Minus className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        <bdi className="min-w-0">{doc.name}</bdi>
                      </li>
                    ))}
                  </ul>
                )}
                {/* The documents are uploaded in the tab at the foot of the
                    page — far below this step on a phone. Offered only where
                    that tab exists, and only when the step has no button of
                    its own: the button already goes there, and a second
                    pointer to the same place would be two ways to do one
                    thing. The documents themselves do not move. */}
                {outstandingDocuments.length > 0 && onGoToDocuments && documentsActionable && !primary && (
                  <button
                    type="button"
                    className="mt-1.5 inline-flex min-h-9 items-center gap-1 rounded-sm font-medium underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid="deal-go-to-documents"
                    onClick={onGoToDocuments}
                  >
                    {t("GoToDocuments")}
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>
            ) : action?.unavailableReasonKey ? null : (
              // Not said above a refusal: "nothing is outstanding" over "this
              // sale is still a draft" contradicts itself (SCRUM-417 visual gate).
              <p className="text-sm text-muted-foreground">
                {t(stageReadyKey(action?.actionKey))}
              </p>
            )}

            {checklist && (
              <DealStepChecklist
                items={checklist.items}
                t={t}
                go={(destination) =>
                  destination === "primaryAction"
                    ? primary
                      ? () => {
                          const button = primaryButtonRef.current;
                          button?.scrollIntoView?.({ block: "center" });
                          button?.focus({ preventScroll: true });
                        }
                      : undefined
                    : checklist.go(destination)
                }
              />
            )}

            {/* The action for the step this block NAMES. A step worth naming
                is a step worth doing here — the one recommended action, and
                exactly one. */}
            {/* Why THIS is the next step, when that is not obvious from the
                stage — said once, right above the button it explains. */}
            {(primary || (action?.unavailableReasonKey && action.secondary)) && action?.noteKey && (
              <p className="text-sm text-muted-foreground" data-testid="deal-next-step-note">
                {t(action.noteKey)}
              </p>
            )}
            {primary && action && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
                <Button
                  ref={primaryButtonRef}
                  size="lg"
                  className="w-full sm:w-auto"
                  data-testid="deal-next-step-action"
                  onClick={primary}
                >
                  {t(action.actionKey)}
                </Button>
                {/* The quieter alternative the step must keep (a rejection
                    that needs no documents). Weighted as a link so the eye
                    lands on the one recommended action first. */}
                {action.secondary && (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-9 px-0 text-muted-foreground"
                    data-testid="deal-next-step-secondary"
                    onClick={action.secondary.onStart}
                  >
                    {t(action.secondary.actionKey)}
                  </Button>
                )}
              </div>
            )}

          {/* Why the named step is not actionable BY THIS CALLER. Silence here
              is the dead end this screen exists to remove. */}
          {action?.unavailableReasonKey && (
            <p className="text-sm text-muted-foreground">{t(action.unavailableReasonKey)}</p>
          )}
          {/* SCRUM-417 UX1 (S4): the blocker is resolved on another page. The
              container links it only for a caller who can act there; every
              other caller is told who does. Never both, never a bare refusal. */}
          {action?.unavailableReasonKey && action.unavailableLink && (
            <Link
              href={action.unavailableLink.href}
              className="inline-flex min-h-9 items-center gap-1 rounded-sm text-sm font-medium underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="deal-next-step-link"
            >
              {t(action.unavailableLink.labelKey)}
              <ArrowUpRight className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden />
            </Link>
          )}
          {action?.unavailableReasonKey && !action.unavailableLink && action.unavailableNoteKey && (
            <p className="text-sm text-muted-foreground" data-testid="deal-next-step-link-note">
              {t(action.unavailableNoteKey)}
            </p>
          )}
          {/* The quieter alternative survives a withheld main step: an
              approver who cannot touch the documents can still record the
              rejection, which needs none (SCRUM-417 W1). */}
          {action?.unavailableReasonKey && action.secondary && (
            <Button
              variant="link"
              size="sm"
              className="h-9 px-0"
              data-testid="deal-next-step-secondary"
              onClick={action.secondary.onStart}
            >
              {t(action.secondary.actionKey)}
            </Button>
          )}
          {/* The figure the refusal is about, in the currency it is recorded
              in. Each money run is its own LTR isolate, or under an RTL base
              the amount and its code swap places. */}
          {action?.unavailableReasonKey && action.unavailableDetail && (
            <SettlementDenominationLine detail={action.unavailableDetail} />
          )}

          {children}

          {/* Only where it is TRUE — gated by recorded provenance, the same
              source as the badge above, so the two can never name different
              parties for one step. On a DEALER stage the badge has already
              said whose move it is; a second line restating it would push the
              real content down. */}
          {mirrorNote && <p className="text-xs text-muted-foreground">{t("StageMirrorNote")}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
