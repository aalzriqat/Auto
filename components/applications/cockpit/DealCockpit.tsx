"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { scaleForCurrency } from "@/components/accounting/AccountingTabShared";
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
import { getErrorMessage, isConvexError } from "@/lib/errors";
import { format, isValid } from "date-fns";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  Clock,
  Lock,
  Minus,
  Ban,
} from "lucide-react";
import { DealStageRail, DealStagesComplete } from "./DealStageRail";
import {
  isLiveStageState,
  STAGE_ICON,
  type DealCockpitData,
  type DealStageState,
} from "./DealStagePresentation";
import { SupplierSettlementDialog } from "./SupplierSettlementDialog";
import { SettlementAdviceCorrectionDialog } from "./SettlementAdviceCorrectionDialog";
import {
  FinanceCompanyDecisionCard,
  type FinanceDecisionFacts,
} from "./FinanceCompanyDecisionCard";
import { ResolveGapDialog } from "./ResolveGapDialog";
import {
  RecordSubmittedQuotationDialog,
  type QuotationCalculation,
} from "./RecordSubmittedQuotationDialog";
import {
  ReopenApprovedPurchaseDialog,
} from "./ReopenApprovedPurchaseDialog";
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
import { PERMISSIONS } from "@/convex/utils/permissions";
import type { PaymentMethod } from "@/components/payments/PaymentMethodSelect";
// The actions the Finance Applications → Review dialog used to own, moved here
// on the SAME mutations. Each is its own file so the container stays a wiring
// layer and the view stays renderable against fixtures.
import { CreditDecisionDialog, type CreditDecision } from "./CreditDecisionDialog";
import { CancelApplicationDialog } from "./CancelApplicationDialog";
import {
  SettlementRouteControl,
  type DirectRouteRefusal,
  type SupplierSettlementRoute,
} from "./SettlementRouteControl";
import { DealDocumentsPanel, type DealDocument } from "./DealDocumentsPanel";
import {
  StoppedDealDepositsPanel,
  type DealDeposit,
  type DepositResolution,
} from "./StoppedDealDepositsPanel";
import { DisbursementConfirmationDialog } from "../DisbursementConfirmationDialog";
import { useCommandIdentity } from "@/hooks/useCommandIdentity";
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
  type HandoverCostsData,
  type NewHandoverCost,
} from "./HandoverCostsPanel";

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

function renderMoment(value: number | undefined, pattern: string): string {
  return isRenderableMoment(value) ? format(value, pattern) : MOMENT_UNAVAILABLE;
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

const PROFIT_LINE_LABEL: Record<string, string> = {
  APPROVED_PURCHASE: "LineApprovedPurchase",
  /** PLANNED — `resolveAppraisalGap`'s allocation, never a receipt. The label says so. */
  CUSTOMER_PLANNED_TO_DEALER: "LineCustomerPlannedToDealer",
  SUPPLIER_SETTLEMENT: "LineSupplierSettlement",
  DEALER_CONTRIBUTION: "LineDealerContribution",
  ACTUAL_EXPENSES: "LineActualExpenses",
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
  CorruptInput: "ProfitInputCorrupt",
  DealCancelled: "ProfitDealCancelled",
  UnknownMargin: "ProfitUnknownMargin",
  SaleNotCompleted: "ProfitSaleNotCompleted",
  FinancedDirectUnverified: "ProfitFinancedDirectUnverified",
};

/**
 * Why the close cannot be taken — and it takes BOTH conditions, because the
 * two interact rather than merely coexisting.
 *
 * `setSupplierSettlementRoute` requires `finalize:financed_deal`, the same
 * permission as the close itself, and the review dialog hides its selector
 * without it. So telling a caller who lacks that permission to "record the
 * route in Review" sends them to a screen with nothing on it — the dead end
 * this issue exists to remove, rebuilt out of two correct sentences.
 *
 * Extracted rather than left as a nested ternary so the four combinations are
 * enumerable, and testable, one line each.
 */
function finalizeUnavailableReasonKey(
  routeRequired: boolean,
  canFinalize: boolean
): string | undefined {
  if (routeRequired && !canFinalize) return "FinalizeNeedsRouteAndPermission";
  if (routeRequired) return "FinalizeNeedsSettlementRoute";
  if (!canFinalize) return "FinalizeNeedsPermission";
  return undefined;
}

/** The toast for each credit-stage transition this screen can record. */
const CREDIT_STATUS_SUCCESS: Record<"UNDER_REVIEW" | "APPROVED" | "REJECTED", string> = {
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
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
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
  const { t } = useLanguage();
  const recordReceipt = useMutation(api.supplierReceivables.recordReceipt);
  const amendAdvice = useMutation(api.applications.amendSupplierDisbursementAdvice);
  const recordSubmittedQuotation = useMutation(api.financingEconomics.recordSubmittedQuotation);
  const reopenApproval = useMutation(api.financingEconomics.reopenApproval);
  const registerVehicleHandover = useMutation(api.applications.registerVehicleHandover);
  const resolveAppraisalGap = useMutation(api.financingEconomics.resolveAppraisalGap);
  const registerExpectedPayment = useMutation(api.applications.registerExpectedPayment);
  const finalizeDeal = useMutation(api.applications.finalizeDeal);
  const approveDealerPurchaseAmount = useMutation(
    api.financingEconomics.approveDealerPurchaseAmount
  );
  const recordAppraisal = useMutation(api.financingEconomics.recordAppraisal);
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
  useEffect(() => {
    if (finalizedSaleId) {
      router.replace(`/${orgId}/sales/${finalizedSaleId}/deal`);
    }
  }, [finalizedSaleId, orgId, router]);

  // Hidden while the membership is still loading rather than shown optimistically:
  // an action that appears and then vanishes reads as a bug, and the server is
  // the authority either way.
  const canCorrectAdvice = !permissionsLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE);
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
  // The deal's cost lines, same permission as the document rows; skipped rather
  // than thrown for a caller without it.
  const dealCosts = useQuery(
    api.financeDealCosts.listDealCosts,
    canViewApplications && deal ? { orgId, applicationId } : "skip"
  );
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
  const adoptCompanyFeeTemplates = useMutation(api.financeDealCosts.adoptCompanyFeeTemplates);
  const recordTemplateFeeActual = useMutation(api.financeDealCosts.recordTemplateFeeActual);
  const recordActualFeeAmount = useMutation(api.financeDealCosts.recordActualFeeAmount);
  const voidDealFee = useMutation(api.financeDealCosts.voidDealFee);
  const planCustodyHandler = useMutation(api.financeDealCosts.planCustodyHandler);
  const openDealCustody = useMutation(api.financeDealCosts.openDealCustody);
  const recordCustodyMovement = useMutation(api.financeDealCosts.recordCustodyMovement);
  const setFeeCustody = useMutation(api.financeDealCosts.setFeeCustody);
  const reconcileDealCustody = useMutation(api.financeDealCosts.reconcileDealCustody);
  const reopenDealCustody = useMutation(api.financeDealCosts.reopenDealCustody);
  const updateStatus = useMutation(api.applications.updateStatus);
  const cancelApplication = useMutation(api.applications.cancelApplication);
  const confirmDisbursement = useMutation(api.applications.confirmDisbursement);
  const confirmSupplierDisbursement = useMutation(api.applications.confirmSupplierDisbursement);
  const setSupplierSettlementRoute = useMutation(api.applications.setSupplierSettlementRoute);
  const releaseDeposit = useMutation(api.deposits.release);
  const updateDocStatus = useMutation(api.documents.updateDocumentStatus);
  const generateUploadUrl = useMutation(api.documents.generateUploadUrl);
  const saveDocumentFile = useMutation(api.documents.saveDocumentFile);
  const orgCurrency = useCurrency();

  const canReviewApplication = !permissionsLoading && hasPermission(PERMISSIONS.REVIEW_FINANCE_APPLICATION);
  const canApproveApplication = !permissionsLoading && hasPermission(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
  const canCreateApplication = !permissionsLoading && hasPermission(PERMISSIONS.CREATE_FINANCE_APPLICATION);
  const canFinalizeApplication = !permissionsLoading && hasPermission(PERMISSIONS.FINALIZE_FINANCED_DEAL);
  const canVerifyDocuments = !permissionsLoading && hasPermission(PERMISSIONS.VERIFY_FINANCE_DOCUMENTS);
  const canConfirmFinanceDisbursement =
    !permissionsLoading && hasPermission(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
  const canResolveDeposits = !permissionsLoading && hasPermission(PERMISSIONS.APPROVE_REQUESTS);

  const [decidingCredit, setDecidingCredit] = useState(false);
  const [creditSubmitting, setCreditSubmitting] = useState(false);
  const [creditError, setCreditError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [confirmingDisbursement, setConfirmingDisbursement] = useState(false);
  const [confirmingSupplierDisbursement, setConfirmingSupplierDisbursement] = useState(false);
  const [disbursementSubmitting, setDisbursementSubmitting] = useState(false);
  const [uploadingDocId, setUploadingDocId] = useState<string | null>(null);
  const [resolvingDepositId, setResolvingDepositId] = useState<string | null>(null);
  // One key per attempt, held in a ref so a retry after a lost response is the
  // SAME command rather than a second one, and cleared only once the server
  // has confirmed. Cancelling a CLOSED deal reverses a posted sale; confirming
  // a disbursement posts DR Bank; releasing a deposit pays real cash out.
  // These are the exact keys the Review dialog minted, under the same names.
  const cancelKeyRef = useRef<string | null>(null);
  const confirmDisbursementKeyRef = useRef<string | null>(null);
  const confirmSupplierDisbursementKeyRef = useRef<string | null>(null);
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

  // ---- the same derivations the Review dialog made, from the same payload ----
  // The dealer-side economics are denominated in the application's OWN pinned
  // currency, not the org's current one; the customer's principal is read at
  // the org scale, as the dialog reads it. Absent means the row predates the
  // field, and the org's currency is then the only reading available.
  const orgFactor = Math.pow(10, scaleForCurrency(orgCurrency.code));
  const economicsCurrencyCode = app?.economicsCurrency ?? orgCurrency.code;
  const economicsFactor = Math.pow(10, scaleForCurrency(economicsCurrencyCode));
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
  const formatEconomics = (minor: number) =>
    `${(minor / economicsFactor).toLocaleString()} ${
      economicsCurrencyCode === orgCurrency.code ? orgCurrency.displayLabel : economicsCurrencyCode
    }`;
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
          vehiclePrice: app.quote.vehiclePrice,
          downPayment: app.quote.downPayment,
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
              } satisfies HandoverCostsData)
            : undefined,
          // The currency a new line is recorded in, as the SERVER resolves it
          // for its own writers (pin, else the org's verified currency, which
          // the first cost fixes — SCRUM-319). Not derived client-side.
          denomination: { code: dealCosts?.currency ?? economicsCurrencyCode },
          scaleOf: scaleForCurrency,
          money: (minor: number, currency: string) =>
            `${(minor / Math.pow(10, scaleForCurrency(currency))).toLocaleString()} ${
              currency === orgCurrency.code ? orgCurrency.displayLabel : currency
            }`,
          // Frozen once the sale is recognized (`economicsFrozen`): the server
          // refuses every posting-bearing edit, so none is offered, and the
          // panel says why at its head.
          canManage: canCreateApplication && !(dealCosts?.economicsFrozen?.frozen ?? app.status === "CLOSED"),
          dealClosed: dealCosts?.economicsFrozen?.frozen ?? app.status === "CLOSED",
          // Owner-only on the server (the authority that edits the company's
          // fees); the notice still renders for everyone, the action does not.
          onAdoptCompanyFees: isOwner
            ? async (reason: string) => {
                try {
                  await adoptCompanyFeeTemplates({ orgId, applicationId, reason });
                  toast.success(t("CompanyFeesAdopted"));
                } catch (error) {
                  throw new Error(getErrorMessage(error));
                }
              }
            : undefined,
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
                paidBy: "DEALER",
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
        }
      : undefined;
  const formatPlanMajor = (major: number, currency: string) =>
    `${major.toLocaleString(undefined, { maximumFractionDigits: scaleForCurrency(currency) })} ${
      currency === orgCurrency.code ? orgCurrency.displayLabel : currency
    }`;
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
  // Keyed on FINALIZE_FINANCED_DEAL, matching the server.
  const canChooseSettlementRoute =
    app != null &&
    canFinalizeApplication &&
    isConsignedDeal &&
    app.status !== "CLOSED" &&
    app.status !== "CANCELLED";
  // On the direct route the company pays the supplier, so there is no
  // dealership receipt to confirm — `confirmDisbursement` would invent cash.
  const canConfirmDisbursement =
    app != null &&
    canConfirmFinanceDisbursement &&
    app.status === "CLOSED" &&
    expectsFinanceCompanyDisbursement &&
    !settlesDirectToSupplier &&
    !app.disbursedAt &&
    disbursementDenominationBlock === undefined;
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
  const canCancel =
    app != null &&
    app.status !== "CANCELLED" &&
    canCreateApplication &&
    (app.status === "APPROVED" ? canApproveApplication : true) &&
    (app.status === "CLOSED" ? canFinalizeApplication : true);
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
   * `register:expected_payment`, `finalize:financed_deal` are three separate
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
   */
  const liveStage = deal?.stages.find(
    (stage) => stage.state === "CURRENT" || stage.state === "BLOCKED"
  );

  function buildWorkflowAction() {
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
    if (liveStage?.blocker === "GapUnresolved") {
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
        return {
          stageKey: "CREDIT_DECISION",
          actionKey: "RecordCreditDecisionAction",
          onStart: () => {
            setCreditError(null);
            setDecidingCredit(true);
          },
          unavailableReasonKey:
            canApproveApplication || canReviewApplication ? undefined : "CreditDecisionNeedsPermission",
        };
      }
      return undefined;
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
      // The currency boundary is named before permission or applicability:
      // it is a fact about the deal that no caller can act on from here.
      if (disbursementDenominationBlock && !app.disbursedAt) {
        return {
          stageKey: "DISBURSEMENT",
          actionKey: "ConfirmDisbursement",
          onStart: () => setConfirmingDisbursement(true),
          unavailableReasonKey: DISBURSEMENT_DENOMINATION_REASON[disbursementDenominationBlock],
          unavailableDetail: disbursementDenominationDetail,
        };
      }
      return {
        stageKey: "DISBURSEMENT",
        actionKey: "ConfirmDisbursement",
        onStart: () => setConfirmingDisbursement(true),
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
        unavailableReasonKey: hasPermission(PERMISSIONS.REGISTER_VEHICLE_HANDOVER)
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
      unavailableReasonKey: finalizeDenominationBlock
        ? FINALIZE_DENOMINATION_REASON[finalizeDenominationBlock]
        : finalizeUnavailableReasonKey(
            settlementRouteRequired,
            hasPermission(PERMISSIONS.FINALIZE_FINANCED_DEAL)
          ),
      unavailableDetail: finalizeDenominationDetail,
    };
  }

  /**
   * `updateStatus` for the two dealership moves on the credit stage. Not
   * idempotency-keyed, exactly as in Review: the server refuses an illegal
   * transition, so a repeat is a refusal rather than a second effect.
   */
  async function recordCreditStatus(status: "UNDER_REVIEW" | CreditDecision) {
    setCreditSubmitting(true);
    setCreditError(null);
    try {
      await updateStatus({ orgId, applicationId, status });
      toast.success(t(CREDIT_STATUS_SUCCESS[status]));
      setDecidingCredit(false);
    } catch (error) {
      // "You cannot approve your own application", an illegal transition —
      // each names what to change. Kept in the dialog so it belongs to the
      // attempt that earned it.
      const message = getErrorMessage(error);
      setCreditError(message);
      toast.error(message);
    } finally {
      setCreditSubmitting(false);
    }
  }

  const workflowAction = buildWorkflowAction();
  // One key per correction attempt, so a retry after a lost response is the same
  // amendment rather than a second audited one.
  const correctionKeyRef = useRef<string | null>(null);
  // The same discipline for finalization, and it matters more here: the
  // operation this key protects creates the sale and posts its journals.
  const finalizeKeyRef = useRef<string | null>(null);

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
          calculation: ((): QuotationCalculation => {
            if (!canOfferQuotation) return { state: "UNAVAILABLE" };
            if (suggestion === undefined) return { state: "LOADING" };
            return suggestion.available === true
              ? { state: "AVAILABLE", minor: suggestion.submittedQuotationMinor }
              : { state: "UNAVAILABLE" };
          })(),
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
   * Identity discipline, same as the handover costs: an issuance and a
   * movement each mint one command identity per dialog attempt and retire it
   * on success or on the server's own refusal; a lost response keeps it so
   * the operator's retry replays rather than pays twice.
   */
  const custodyMoney = (minor: number, currency: string) =>
    `${(minor / Math.pow(10, scaleForCurrency(currency))).toLocaleString()} ${
      currency === orgCurrency.code ? orgCurrency.displayLabel : currency
    }`;
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
          scaleOf: scaleForCurrency,
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
            custodyCommand(`open-custody:${applicationId}:${values.userId}`, (idempotencyKey) =>
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
            custodyCommand(`custody-move:${custodyId}:${kind}:${values.amountMinor}`, (idempotencyKey) =>
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
            custodyCommand(`custody-close:${custodyId}`, (idempotencyKey) =>
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
                formatDate={(ms: number) => renderMoment(ms, "d MMM yyyy")}
                t={t}
                onReverse={onReverse}
              />
            );
          },
        }
      : undefined;

  return (
    <DealCockpitView
      deal={deal}
      backHref={`/${orgId}/deals`}
      financeDecision={financeDecision}
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
      creditDecision={{
        deciding: decidingCredit,
        submitting: creditSubmitting,
        error: creditError,
        canApprove: canApproveApplication,
        canReject: canReviewApplication,
        isOwnDeal: membership?.userId != null && membership.userId === app?.salespersonId,
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
              onSubmit: async (reason) => {
                setCancelSubmitting(true);
                setCancelError(null);
                try {
                  cancelKeyRef.current ??= `cancel-application:${crypto.randomUUID()}`;
                  await cancelApplication({
                    orgId,
                    applicationId,
                    reason,
                    idempotencyKey: cancelKeyRef.current,
                  });
                  cancelKeyRef.current = null;
                  toast.success(t("AppCancelledSuccess"));
                  setCancelling(false);
                } catch (error) {
                  // "Disbursement funds already confirmed received" is the one
                  // refusal an operator can do nothing about here; it says so.
                  const message = getErrorMessage(error);
                  setCancelError(message);
                  toast.error(message);
                } finally {
                  setCancelSubmitting(false);
                }
              },
            }
          : undefined
      }
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
          ruleName: doc.ruleName,
          status: doc.status,
          fileUrl: doc.fileUrl,
        })),
        // The server accepts an upload from either permission; verifying is
        // the narrower one. Same gates as Review, read from the same server.
        canUpload: canCreateApplication || canVerifyDocuments,
        canVerify: canVerifyDocuments,
        uploadingId: uploadingDocId,
        onUpload: async (documentId, file) => {
          setUploadingDocId(documentId);
          try {
            const postUrl = await generateUploadUrl({
              orgId,
              mimeType: file.type,
              sizeInBytes: file.size,
            });
            const result = await fetch(postUrl, {
              method: "POST",
              headers: { "Content-Type": file.type },
              body: file,
            });
            const { storageId } = await result.json();
            await saveDocumentFile({
              orgId,
              documentId: documentId as Id<"applicationDocuments">,
              fileId: storageId,
            });
            toast.success(t("UploadSuccess"));
          } catch (error) {
            toast.error(getErrorMessage(error));
          } finally {
            setUploadingDocId(null);
          }
        },
        onVerify: async (documentId) => {
          try {
            await updateDocStatus({
              orgId,
              documentId: documentId as Id<"applicationDocuments">,
              status: "VERIFIED",
            });
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
              onResolve: async (depositId, resolution, refundMethod, observedReleaseCount) => {
                setResolvingDepositId(depositId);
                try {
                  const method = resolution === "REFUNDED" ? refundMethod : "NONE";
                  const releaseIntent = `release-deposit:${depositId}:${resolution}:${method}:gen${observedReleaseCount}`;
                  await releaseDeposit({
                    orgId,
                    depositId: depositId as Id<"deposits">,
                    resolution,
                    refundMethod: resolution === "REFUNDED" ? refundMethod : undefined,
                    idempotencyKey: commandId.for(releaseIntent),
                  });
                  commandId.retire(releaseIntent);
                  toast.success(
                    t(resolution === "REFUNDED" ? "DepositRefundedSuccess" : "DepositForfeitedSuccess")
                  );
                } catch (error) {
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
                onOpenChange: setConfirmingDisbursement,
                onConfirm: async () => {
                  if (!expectedDisbursementMinor) return;
                  setDisbursementSubmitting(true);
                  try {
                    confirmDisbursementKeyRef.current ??= `confirm-disbursement:${crypto.randomUUID()}`;
                    await confirmDisbursement({
                      orgId,
                      applicationId,
                      disbursedAmountMinor: expectedDisbursementMinor,
                      idempotencyKey: confirmDisbursementKeyRef.current,
                    });
                    confirmDisbursementKeyRef.current = null;
                    toast.success(t("DisbursementConfirmedSuccess"));
                    setConfirmingDisbursement(false);
                  } catch (error) {
                    toast.error(getErrorMessage(error));
                  } finally {
                    setDisbursementSubmitting(false);
                  }
                },
              },
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
                  try {
                    confirmSupplierDisbursementKeyRef.current ??= `confirm-supplier-disbursement:${crypto.randomUUID()}`;
                    await confirmSupplierDisbursement({
                      orgId,
                      applicationId,
                      // Scaled by the APPLICATION's pinned economics currency —
                      // this figure lives in that block.
                      disbursedAmountMinor: Math.round(advice.amountMajor * economicsFactor),
                      reference: advice.reference,
                      disbursedAt: advice.disbursedAt,
                      idempotencyKey: confirmSupplierDisbursementKeyRef.current,
                    });
                    confirmSupplierDisbursementKeyRef.current = null;
                    toast.success(t("SupplierDisbursementConfirmedSuccess"));
                    setConfirmingSupplierDisbursement(false);
                  } catch (error) {
                    toast.error(getErrorMessage(error));
                  } finally {
                    setDisbursementSubmitting(false);
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
            await resolveAppraisalGap({
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
            });
            toast.success(t("GapResolved"));
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
            await registerVehicleHandover({
              orgId,
              applicationId,
              notes: values.notes,
              // The stamp the dialog was OPENED against, passed straight
              // through. Not re-read from `deal` here — that would undo the
              // snapshot the dialog took and restore the race it closes.
              economicsStamp: values.economicsStamp,
            });
            toast.success(t("HandoverRegistered"));
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
        onOpenChange: setRegisteringPayment,
        onSubmit: async (values) => {
          setPaymentSubmitting(true);
          setPaymentError(null);
          try {
            await registerExpectedPayment({ orgId, applicationId, ...values });
            toast.success(t("ExpectedPaymentRegisteredSuccess"));
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
        onSubmit: async () => {
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
            await finalizeDeal({
              orgId,
              applicationId,
              idempotencyKey: finalizeKeyRef.current,
            });
            finalizeKeyRef.current = null;
            toast.success(t("DealFinalizedSuccess"));
            setConfirmingFinalize(false);
          } catch (error) {
            // Deliberately keeps the key: every refusal here is actionable and
            // names what to change — an unrecorded settlement route, missing
            // economics, an unresolved عربون — so the next attempt is the same
            // finalize with the same key, not a second one.
            const message = getErrorMessage(error);
            setFinalizeError(message);
            toast.error(message);
          } finally {
            setFinalizeSubmitting(false);
          }
        },
      }}
      canCorrectAdvice={canCorrectAdvice}
      canSettleSupplier={canSettleSupplier}
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
    />
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
}: Readonly<{ orgId: Id<"organizations">; saleId: Id<"sales"> }>) {
  const deal = useQuery(api.sales.dealCockpit, { orgId, saleId });
  const recordReceipt = useMutation(api.supplierReceivables.recordReceipt);
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  // The cash path settles a supplier through the SAME mutation, gated by the
  // SAME permission (MANAGE_FINANCE), so it carries the same caller capability
  // — closed while the membership loads, never inferred from a role name.
  const canSettleSupplier = !permissionsLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE);

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
      />
    );
  }

  return (
    <DealCockpitView
      deal={deal}
      backHref={`/${orgId}/deals`}
      canSettleSupplier={canSettleSupplier}
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
  return (
    <div className="space-y-1">
      <p className="text-sm text-muted-foreground">{t("NetDealershipProfit")}</p>
      {profit.available ? (
        <>
          <div className="flex flex-wrap items-baseline gap-3">
            <p className="text-3xl font-semibold">
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
        <CardTitle className="text-base">{t("FinancialSummaryHeading")}</CardTitle>
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
        {typeof canonicalProfit !== "string" && (
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
  backHref,
  financeDecision,
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
  canSettleSupplier: callerMaySettleSupplier = false,
  onCorrectSettlementAdvice,
  onRecordSupplierReceipt,
  activeAppraisalProvider = null,
  depositAwaitingResolution = false,
  creditDecision,
  cancel,
  settlementRoute,
  documents,
  deposits,
  disbursement,
}: Readonly<{
  /** `undefined` while loading, `null` when the deal is not readable. */
  deal: DealCockpitData | null | undefined;
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
    onSubmit: (reason: string | undefined) => void | Promise<void>;
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
    canUpload: boolean;
    canVerify: boolean;
    uploadingId: string | null;
    onUpload: (documentId: string, file: File) => void | Promise<void>;
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
  workflowAction?: {
    stageKey: string;
    /** i18n key for the button label — never a raw string. */
    actionKey: string;
    onStart: () => void;
    /** Set when the step cannot be taken; the button is withheld and this is shown. */
    unavailableReasonKey?: string;
    /** The withheld figure in its own currency, shown under the reason. */
    unavailableDetail?: SettlementDenominationDetail;
  };
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
    }) => void | Promise<void>;
  };
  /** The finalization confirmation's own state. */
  finalize?: {
    confirming: boolean;
    submitting: boolean;
    error: string | null;
    onOpenChange: (open: boolean) => void;
    onSubmit: () => void | Promise<void>;
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
  const canSettleSupplier =
    callerMaySettleSupplier &&
    deal?.money?.settlesDirectToSupplier === true &&
    deal.money.routeKnown &&
    supplierRow?.position === "OWED_TO_DEALERSHIP" &&
    supplierReceipt?.actionable === true;
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
    () => Math.pow(10, denomination?.scale ?? scaleForCurrency(dealCurrency)),
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
    () => Math.pow(10, scaleForCurrency(discrepancyCurrency)),
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
    () => Math.pow(10, scaleForCurrency(decisionCurrency)),
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

  const stages = deal.stages;
  const live = stages.find((s) => isLiveStageState(s.state));
  // A finished deal gets one calm completion line instead of a rail of ticks;
  // the rail itself stays one click away. Every other deal — live, or stopped
  // with nothing left to do — shows the rail as-is, because on a stopped deal
  // WHERE it stopped is the information.
  const allComplete = stages.length > 0 && stages.every((s) => s.state === "COMPLETE");
  const liveIndex = live ? stages.findIndex((s) => s.key === live.key) : -1;
  const railStages = stages.map((stage) => ({
    key: stage.key,
    state: stage.state,
    label: t(STAGE_LABEL[stage.key] ?? stage.key),
    // The same provenance-gated resolution the focus panel uses, so a node
    // and the panel can never name different parties for one step.
    owner: stageOwnerLabel(stage, activeAppraisalProvider, t),
    blocker: stage.blocker ? t(`Blocker${stage.blocker}`) : undefined,
  }));
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
      await onRecordSupplierReceipt(
        supplierRow.receivableId as Id<"vehicleSupplierReceivables">,
        { ...receipt, idempotencyKey: receiptKeyRef.current }
      );
      // Only now: a failed attempt keeps its key so retrying is the same
      // receipt rather than a second one.
      receiptKeyRef.current = null;
      toast.success(t("ReceiptRecorded"));
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
      await financeDecision.onRecordQuotation(values);
      toast.success(t("QuotationRecorded"));
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
      await financeDecision.onRecordAppraisal(values);
      toast.success(t("AppraisalRecorded"));
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
      await financeDecision.onRecordApproved(values);
      toast.success(t("ApprovedPurchaseRecorded"));
      setRecordingApproval(false);
    } catch (error) {
      const message = getErrorMessage(error);
      setApprovalError(message);
      toast.error(message);
    } finally {
      setApprovalSubmitting(false);
    }
  };

  const handleReopenApproved = async (values: { reason: string }) => {
    if (!financeDecision) return;
    setReopenSubmitting(true);
    setReopenError(null);
    try {
      await financeDecision.onReopenApproved(values);
      toast.success(t("ApprovedPurchaseReopened"));
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

  return (
    <div className="space-y-6">
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
            {t(STATUS_LABEL[deal.status] ?? deal.status)}
          </Badge>
          {/* Whose move the deal is on, from the same source the rail uses —
              one owner per screen, never two. */}
          {live && stageOwnerLabel(live, activeAppraisalProvider, t) && (
            <span className="text-sm text-muted-foreground">
              <bdi>{stageOwnerLabel(live, activeAppraisalProvider, t)}</bdi>
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {t("LastUpdated")}: <bdi>{renderMoment(deal.updatedAt ?? deal.createdAt, "d MMM yyyy HH:mm")}</bdi>
          </span>
        </div>
        {/* The exceptional action, in the header and quiet on purpose: it is
            never the recommended next step, so it must not compete with the
            one CTA the focus panel carries. Present only when the SERVER would
            accept it from this caller. Kept visible rather than folded into a
            menu: it would be the menu's only item, and a destructive action
            behind a one-item menu is hidden, not tidied. */}
        {cancel && (
          <Button
            variant="ghost"
            size="sm"
            className="ms-auto h-9 text-destructive hover:text-destructive"
            data-testid="deal-cancel-application"
            onClick={() => cancel.onOpenChange(true)}
          >
            <Ban className="h-4 w-4" aria-hidden />
            {t("CancelApplication")}
          </Button>
        )}
      </div>

      {/* --- essentials --------------------------------------------------- */}
      {/* Customer, vehicle, finance company, salesperson: the four facts that
          identify the deal, in one quiet row under the header. Each cell is
          absent rather than empty — a cash deal has no finance company. */}
      <dl
        className="grid grid-cols-1 gap-x-6 gap-y-2 border-b pb-4 text-sm sm:grid-cols-2 lg:grid-cols-4"
        aria-label={t("DealEssentialsHeading")}
      >
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
        {deal.vehicle && (
          <div className="min-w-0 space-y-1">
            <dt className="text-xs text-muted-foreground">{t("Vehicle")}</dt>
            <dd className="min-w-0 break-words font-medium">
              <bdi>{deal.vehicle.label}</bdi>{" "}
              <bdi className="font-normal text-muted-foreground">{deal.vehicle.vin}</bdi>
            </dd>
            <dd>
              <Badge variant="outline" className="font-normal">
                {deal.vehicle.consigned ? t("OwnershipWithSupplier") : t("OwnershipWithDealership")}
              </Badge>
            </dd>
            {/* Beside the ownership badge that makes it a question: the car
                is the supplier's, so who the finance company pays has to be
                recorded here before the deal can close. Rendered on the live
                step INSTEAD whenever it is what the close waits on. */}
            {settlementRoute && !routeBlocksClose && (
              <dd className="pt-1">
                <SettlementRouteControl
                  route={settlementRoute.route}
                  canSettleDirectToSupplier={settlementRoute.canSettleDirectToSupplier}
                  directRouteRefusal={settlementRoute.directRouteRefusal}
                  supplierName={settlementRoute.supplierName}
                  t={t}
                  onChoose={settlementRoute.onChoose}
                />
              </dd>
            )}
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
            <bdi className="font-normal text-muted-foreground">{renderMoment(deal.createdAt, "d MMM yyyy")}</bdi>
          </dd>
        </div>
      </dl>

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
            />
          )}
        </div>
      )}

      {/* --- stage rail: the signature element ---------------------------- */}
      {/* Compact: one node per stage, the current one emphasised, the rest
          quiet. A finished deal gets a single completion line with the rail
          one click away. The rail is a PROGRESS readout only; the live stage
          is worked from the focus panel directly beneath it, and both read the
          same `live` so they cannot name different stages. */}
      {allComplete ? (
        <div className="space-y-3">
          <DealStagesComplete
            count={stages.length}
            expanded={showCompleted}
            onToggle={() => setShowCompleted((open) => !open)}
            t={t}
          />
          {showCompleted && <DealStageRail stages={railStages} t={t} />}
        </div>
      ) : (
        <DealStageRail stages={railStages} t={t} />
      )}

      {/* --- the current stage: the primary surface ----------------------- */}
      {/* Everything the operator needs for the step the deal is on — what it
          is, whose move it is, what is being waited on, and the ONE action —
          in one place. It keeps `data-testid="deal-next-step"`: the id names
          the block that carries the action, and that is exactly this. */}
      {live ? (
        <StageFocusRow
          state={live.state}
          label={t(STAGE_LABEL[live.key] ?? live.key)}
          position={liveIndex + 1}
          total={stages.length}
          owner={stageOwnerLabel(live, activeAppraisalProvider, t)}
          mirrorNote={stageShowsMirrorNote(live, activeAppraisalProvider)}
          blocker={live.blocker ? t(`Blocker${live.blocker}`) : undefined}
          action={workflowAction?.stageKey === live.key ? workflowAction : undefined}
          outstandingDocuments={
            live.blocker === "DocumentsIncomplete"
              ? deal.documents.filter(
                  (doc) => doc.required && doc.status !== "VERIFIED" && doc.status !== "WAIVED"
                )
              : []
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
      ) : (
        !allComplete && (
          /* No live stage and not finished: the deal stopped. Said in the
             muted register — a stopped deal is a fact, not an alarm; the
             held-deposit strip above carries the alarm when there is one. */
          <p className="text-sm text-muted-foreground" data-testid="deal-stopped">
            {t("DealStopped")}
          </p>
        )
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* --- side column: the money ------------------------------------ */}
        {/* First in source so a phone reads the figures right after the
            step; last on a wide screen so the working column keeps the eye. */}
        <div className="min-w-0 space-y-6 lg:order-last">
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
                        formatDate: (ms: number) => renderMoment(ms, "d MMM yyyy"),
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
                  <CardTitle className="text-base">{t("ActualExpensesHeading")}</CardTitle>
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

          {/* What the CUSTOMER agreed to pay, beside the dealer's money and
              before the documents — the reading surface Review used to be for
              this, and the one fact set the money panel deliberately does not
              carry. */}
          {financingPlan && (
            <FinancingPlanPanel
              plan={financingPlan.facts}
              formatMajor={financingPlan.formatMajor}
              t={t}
            />
          )}
        </div>

        {/* --- working column ------------------------------------------- */}
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {/* --- what the finance company told us ----------------------------- */}
          {/* Under the next step, not inside the money column: this is the ACTION
              on the stage the rail reports as blocked, and the money column is
              withheld entirely from the role that performs it. */}
          {financeDecision && (
            <FinanceCompanyDecisionCard
              facts={financeDecision.facts}
              canRecordQuotation={financeDecision.canRecordQuotation}
              canRecordApproval={financeDecision.canRecordApproval}
              canEstablishLtvPercent={financeDecision.canEstablishLtvPercent}
              canRecordAppraisal={financeDecision.canRecordAppraisal}
              isOwnDeal={financeDecision.isOwnDeal}
              money={decisionMoney}
              t={t}
              onRecordQuotation={() => {
                setQuotationError(null);
                setRecordingQuotation(true);
              }}
              onRecordAppraisal={() => {
                setAppraisalError(null);
                setRecordingAppraisal(true);
              }}
              onRecordApproved={() => {
                setApprovalError(null);
                setRecordingApproval(true);
              }}
              onCorrectApproved={() => {
                setReopenError(null);
                setReopeningApproval(true);
              }}
            />
          )}

          {/* --- رسوم ومصاريف تسليم السيارة -------------------------------- */}
          {/* Outside the money branch on purpose: the cost RECORD is readable
              with view:finance_applications, which is not view:finance. A
              sales operator who cannot see the margin still records the
              transfer fee. The read-only expenses card above is withheld
              whenever this section is present so the same lines are not
              listed twice. */}
          {handoverCosts && <HandoverCostsPanel {...handoverCosts} t={t} />}

          {/* --- عهدة الموظف ------------------------------------------------ */}
          {/* Beside the costs it pays for, under the same permission to read.
              The balances are the server's; the money commands post through
              the custody clearing account and are offered to the
              disbursement tier only. */}
          {custody && custodyMoney && (
            <DealCustodyPanel wiring={custody} money={custodyMoney} t={t} />
          )}

          {/* --- documents · activity ------------------------------------- */}
          {/* One card, two tabs, below the money: the checklist that also DOES
              something (upload, verify, view) and the status history — the
              owner's workspace shell. Documents lead when the deal has a
              checklist because they are actionable; a cash deal has none and
              opens on its history. Both panes stay mounted so a search or a
              test finds either without a click. */}
          {(() => {
            const hasDocuments = documents !== undefined || deal.documents.length > 0;
            const documentsPane = documents ? (
              <DealDocumentsPanel
                documents={documents.items}
                checklist={deal.documents}
                canUpload={documents.canUpload}
                canVerify={documents.canVerify}
                uploadingId={documents.uploadingId}
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
                uploadingId={null}
                t={t}
                onUpload={() => {}}
                onVerify={() => {}}
              />
            ) : null;
            const activityPane = (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t("StatusLogHeading")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
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
                          <bdi>{format(entry.changedAt, "d MMM yyyy HH:mm")}</bdi>
                        </>
                      )}
                    </p>
                  </div>
                </div>
              ))}
                </CardContent>
              </Card>
            );
            if (!hasDocuments) return activityPane;
            return (
              <Tabs defaultValue="documents" className="space-y-3" data-testid="deal-lower-tabs">
                <TabsList>
                  <TabsTrigger value="documents">{t("DealTabDocuments")}</TabsTrigger>
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
          })()}
        </div>
      </div>

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
            handoverEvidence ?? {
              approvedPurchaseAmountMinor: null,
              financeCompanyFundedPortionMinor: null,
              dealerContributionMinor: null,
              approvedAmountIsFarFromEvidence: false,
              currency: null,
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
          t={t}
          onOpenChange={creditDecision.onOpenChange}
          onSubmit={creditDecision.onSubmit}
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
function StageFocusRow({
  state,
  label,
  position,
  total,
  owner,
  mirrorNote,
  blocker,
  action,
  outstandingDocuments,
  t,
  children,
}: Readonly<{
  state: DealStageState;
  label: string;
  /** 1-based place on the rail, for the "Stage 3 / 8" kicker. */
  position: number;
  total: number;
  /** Whose move it is, resolved from server authority AND recorded provenance. */
  owner?: string;
  /** A control that belongs ON this step because it is what the step waits on. */
  children?: React.ReactNode;
  /** Whether the "AutoFlow only records their decision" sentence is TRUE here. */
  mirrorNote: boolean;
  blocker?: string;
  action?: {
    actionKey: string;
    onStart: () => void;
    unavailableReasonKey?: string;
    unavailableDetail?: SettlementDenominationDetail;
  };
  outstandingDocuments: ReadonlyArray<{ ruleId: string; name: string }>;
  t: (key: string) => string;
}>) {
  const icon = STAGE_ICON[state];

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
                {t("StageOfLabel")}{" "}
                <bdi dir="ltr">
                  {position} / {total}
                </bdi>
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
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("StageReadyToProceed")}</p>
            )}

            {/* The action for the step this block NAMES. A step worth naming
                is a step worth doing here — the one recommended action, and
                exactly one. */}
            {action && action.unavailableReasonKey === undefined && (
              <div className="flex flex-wrap pt-1">
                <Button size="lg" className="w-full sm:w-auto" onClick={action.onStart}>
                  {t(action.actionKey)}
                </Button>
              </div>
            )}

          {/* Why the named step is not actionable BY THIS CALLER. Silence here
              is the dead end this screen exists to remove. */}
          {action?.unavailableReasonKey && (
            <p className="text-sm text-muted-foreground">{t(action.unavailableReasonKey)}</p>
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
