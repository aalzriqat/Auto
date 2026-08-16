"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { scaleForCurrency } from "@/components/accounting/AccountingTabShared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { getErrorMessage } from "@/lib/errors";
import { format, isValid } from "date-fns";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDot,
  Clock,
  FileText,
  Lock,
  Minus,
  Ban,
} from "lucide-react";
import { SupplierSettlementDialog } from "./SupplierSettlementDialog";
import { SettlementAdviceCorrectionDialog } from "./SettlementAdviceCorrectionDialog";
import {
  FinanceCompanyDecisionCard,
  type FinanceDecisionFacts,
} from "./FinanceCompanyDecisionCard";
import {
  RecordSubmittedQuotationDialog,
  type QuotationCalculation,
} from "./RecordSubmittedQuotationDialog";
import {
  ReopenApprovedPurchaseDialog,
} from "./ReopenApprovedPurchaseDialog";
import { ConfirmHandoverDialog } from "./ConfirmHandoverDialog";
import { ResolveGapDialog } from "./ResolveGapDialog";
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

type StageState = "COMPLETE" | "CURRENT" | "BLOCKED" | "PENDING" | "STOPPED";

const STAGE_LABEL: Record<string, string> = {
  /** CASH only — the cash rail's anchor stage. */
  SALE_AGREED: "StageSaleAgreed",
  APPLICATION: "StageApplication",
  CREDIT_DECISION: "StageCreditDecision",
  APPRAISAL: "StageAppraisal",
  GAP_RESOLUTION: "StageGapResolution",
  APPROVED_PURCHASE: "StageApprovedPurchase",
  DELIVERY_ACTIONS: "StageDeliveryActions",
  HANDOVER: "StageHandover",
  SETTLEMENT: "StageSettlement",
};

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
  CUSTOMER_DIRECT_TO_DEALER: "LineCustomerDirectToDealer",
  SUPPLIER_SETTLEMENT: "LineSupplierSettlement",
  DEALER_CONTRIBUTION: "LineDealerContribution",
  ACTUAL_EXPENSES: "LineActualExpenses",
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
  CorruptInput: "ProfitInputCorrupt",
  DealCancelled: "ProfitDealCancelled",
  UnknownMargin: "ProfitUnknownMargin",
  SaleNotCompleted: "ProfitSaleNotCompleted",
  FinancedDirectUnverified: "ProfitFinancedDirectUnverified",
};

/**
 * Keyed by state rather than tested with a ternary chain. The chain drew three
 * SonarCloud findings, and its final `else` silently absorbed any state it did
 * not name — so a new one rendered as PENDING's dash instead of failing.
 */
const STAGE_ICON: Record<StageState, React.ReactNode> = {
  COMPLETE: <Check className="h-4 w-4 text-emerald-600" />,
  STOPPED: <Ban className="h-4 w-4 text-muted-foreground" />,
  BLOCKED: <AlertTriangle className="h-4 w-4 text-amber-600" />,
  CURRENT: <CircleDot className="h-4 w-4 text-primary" />,
  PENDING: <Minus className="h-4 w-4 text-muted-foreground/60" />,
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
export type DealCockpitData =
  | NonNullable<(typeof api.applications.dealCockpit)["_returnType"]>
  | NonNullable<(typeof api.sales.dealCockpit)["_returnType"]>;

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
  const deal = useQuery(api.applications.dealCockpit, { orgId, applicationId });
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
  const { hasPermission, isLoading: permissionsLoading, membership } = usePermissions();
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
  const ltvMissing =
    economicsApp !== null &&
    economicsApp.companyRuleSnapshot !== undefined &&
    economicsApp.appliedLtvPercent === undefined &&
    economicsApp.companyRuleSnapshot.defaultLtvPercent === undefined;
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
     * The stage nothing can clear — and the reason this screen must not simply
     * go quiet on it.
     *
     * A finance company approving BELOW the submitted quotation is the ordinary
     * case; it is the whole reason an appraisal gap exists.
     * `approveDealerPurchaseAmount` then writes `PENDING_NEGOTIATION`, which
     * `deriveDealStages` does not count as resolved — and **no code anywhere
     * writes the values that would resolve it**. `convex/utils/financingEconomics.ts`
     * says so itself: the recording workflow does not exist yet. So this stage
     * has no exit, and because the rail is strictly sequential it hides handover,
     * settlement and every action after it.
     *
     * No server mutation consults `gapResolution` — handover, expected payment
     * and finalize all ignore it — so the deal is completable and the rail is
     * merely refusing to name the step. Until SCRUM-78 that was survivable
     * because the tail lived in the review dialog, which ignores the rail.
     * Moving the tail here is what turns it into a dead end, so this change owes
     * it an explanation rather than silence.
     *
     * Deliberately NOT an action, and deliberately not a relaxation of the
     * blocked state. Who absorbs the shortfall — customer, dealership, or split
     * — is a money decision that feeds the profit derivation, and inventing a
     * way past it here would be answering that question by omission. SCRUM-83.
     */
    if (liveStage?.blocker === "GapUnresolved") {
      // Withheld from a caller whose money is withheld, even if they hold the
      // permission to act. The dialog's whole job is to show the shortfall and
      // have somebody allocate it; offering it against a figure the screen
      // cannot display would repeat the defect the handover confirmation spent
      // nine rounds removing — asking for agreement about a number the operator
      // is not being shown.
      const gapVisible = typeof deal.money?.appraisalGapMinor === "number";
      // The two states the server treats as sealed. `handoverStage` is the
      // rail's own view of whether the vehicle has gone out, and a status other
      // than APPROVED covers CLOSED and CANCELLED.
      const lifecycleSealed =
        deal.status !== "APPROVED" || handoverStage?.state === "COMPLETE";
      return {
        stageKey: liveStage.key,
        actionKey: "ResolveGapAction",
        onStart: () => {
          setResolvingGap(true);
        },
        // Two different reasons, told apart rather than merged. The authority
        // is the same one that set the approved amount, because agreeing who
        // absorbs the shortfall is the same negotiation. But a caller who HOLDS
        // that authority and still cannot see the deal's money is blocked by
        // visibility, not by permission — and telling them to find someone with
        // approval rights sends them after a problem they do not have.
        //
        // Lifecycle FIRST, because it outranks both. `resolveAppraisalGap`
        // refuses anything not APPROVED, anything already handed over, and
        // anything closed — handover seals these figures and finalization
        // writes the sale against them. The rail can still say GapUnresolved on
        // such a deal, since nothing ever wrote a resolution to it, so offering
        // the action here promised a step the server is GUARANTEED to reject.
        // That is a false affordance, not a permission problem, and it is the
        // same class of defect as the stage rail that named steps it could not
        // take.
        //
        // Deliberately mirrors the server guard rather than approximating it:
        // status must be APPROVED and handover must not have happened.
        unavailableReasonKey: lifecycleSealed
          ? "GapResolutionSealed"
          : !hasPermission(PERMISSIONS.APPROVE_FINANCE_APPLICATION)
            ? "GapResolutionNeedsPermission"
            : gapVisible
              ? undefined
              : "GapResolutionNeedsDealFigures",
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
    // A CLOSED deal still shows SETTLEMENT as its live stage until the money
    // actually arrives, and this returns no action for it. That stage's
    // confirmations — the financier's disbursement and the supplier's — are
    // still only in the review dialog, so the cockpit names a step it cannot
    // take there. That is the SAME defect one stage further along, it predates
    // this change, and it is filed rather than fixed here: it is a fourth
    // action, on a different surface, and this issue scopes to three.
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
      unavailableReasonKey: finalizeUnavailableReasonKey(
        settlementRouteRequired,
        hasPermission(PERMISSIONS.FINALIZE_FINANCED_DEAL)
      ),
    };
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

  return (
    <DealCockpitView
      deal={deal}
      financeDecision={financeDecision}
      workflowAction={workflowAction}
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
      gapResolution={{
        resolving: resolvingGap,
        submitting: gapSubmitting,
        onOpenChange: setResolvingGap,
        /**
         * RETHROWS, for the reason the handover submit documents: the refusal
         * belongs to the attempt that earned it. The server's messages name the
         * figure that did not reconcile, which is the only thing that tells the
         * operator which of five boxes to change.
         */
        onSubmit: async (values) => {
          setGapSubmitting(true);
          try {
            await resolveAppraisalGap({
              orgId,
              applicationId,
              // The stamp the SCREEN was rendered against. If the approval moved
              // while the operator was agreeing the split, the server refuses
              // rather than reconciling an allocation to a gap that is gone.
              // The stamp the DIALOG snapshotted when it opened, passed
              // straight through. Re-reading it from `deal` here would undo
              // that snapshot and hand the server a revision the operator
              // never saw — the fault the handover submit documents.
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
function MoneyPanel({
  money,
  profit,
  t,
}: Readonly<{
  money: (minor: number) => string;
  profit: NonNullable<DealCockpitData["money"]>["profit"];
  t: (key: string) => string;
}>) {
  // The ONE branch this screen is not allowed to get wrong.
  //
  // A financed deal's headline is a MANAGEMENT figure built on a spread that
  // appears on no invoice: it is `postable: false` and must never be shown
  // without its qualifier. A cash deal's is an ordinary accounting result that
  // reconciles to the GL, and stamping an "estimated / never postable" badge on
  // it would be just as false in the other direction.
  //
  // Read off `basis` rather than from the presence of a `classification` field,
  // so the distinction is one the type system enforces: `AccountingProfit` has
  // no `classification` to read, and TypeScript refuses the access outside this
  // branch. That is what makes the two impossible to confuse rather than merely
  // unlikely to be.
  const isManagementEstimate = profit.available && profit.basis === "MANAGEMENT_ESTIMATE";

  return (
  <Card>
    <CardContent className="space-y-4 pt-6">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">{t("NetDealershipProfit")}</p>
        {profit.available ? (
          <>
            <div className="flex flex-wrap items-baseline gap-3">
              <p className="text-3xl font-semibold">
                <Money>{money(profit.amountMinor)}</Money>
              </p>
              {/* The qualifier is not decoration. It renders from
                  the same object as the amount, so there is no code
                  path that shows one without the other.
                  A cash deal gets NO badge here — not a green one
                  saying "postable". The absence of a caveat is the
                  normal case, and labelling it would train the eye to
                  skip the badge that actually matters. */}
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
            <p className="text-2xl font-semibold text-muted-foreground">
              {t("ProfitNotCalculable")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(PROFIT_BLOCKED_REASON[profit.reason])}
            </p>
          </>
        )}
      </div>

      {profit.available && (
        <>
          <Separator />
          {/* Capped for the same reason as the decision card's rows: this is a
              working of one figure, and a term separated from its label by the
              full width of the panel has to be re-associated by eye on every
              line. Left as a single column — these lines are a SUM, and the
              order they are read in is part of the meaning. */}
          <dl className="max-w-xl space-y-1.5 text-sm">
            {profit.lines
              // A zero on an OPTIONAL line is noise, not information:
              // the customer-direct amount has no writer yet, so it
              // would read "0.000" on every deal forever, and the
              // dealer contribution is zero on any fully funded deal.
              // The lines the mockup always shows stay, so the
              // derivation never looks like it is hiding a term.
              // The cash lines are all always-shown: three terms, and
              // a zero cost on an agent sale is a fact worth stating.
              .filter(
                (line) =>
                  line.amountMinor !== 0 ||
                  line.key === "APPROVED_PURCHASE" ||
                  line.key === "SUPPLIER_SETTLEMENT" ||
                  line.key === "ACTUAL_EXPENSES" ||
                  line.key === "SALE_PRICE" ||
                  line.key === "VEHICLE_COST" ||
                  line.key === "SUPPLIER_ENTITLEMENT"
              )
              .map((line) => (
              <div key={line.key} className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">{t(PROFIT_LINE_LABEL[line.key] ?? line.key)}</dt>
                <dd>
                  <Money>
                    {line.sign < 0 ? "− " : ""}
                    {money(line.amountMinor)}
                  </Money>
                </dd>
              </div>
            ))}
          </dl>
        </>
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
  financeDecision,
  workflowAction,
  handover,
  gapResolution,
  expectedPayment,
  finalize,
  canCorrectAdvice = false,
  onCorrectSettlementAdvice,
  onRecordSupplierReceipt,
}: Readonly<{
  /** `undefined` while loading, `null` when the deal is not readable. */
  deal: DealCockpitData | null | undefined;
  /**
   * Absent on a cash deal, and while the economics query is still loading or
   * was skipped for want of `view:finance_applications`.
   */
  financeDecision?: FinanceDecisionWiring;
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
  /** Settling the shortfall left when the company approved below the quotation. */
  gapResolution?: {
    resolving: boolean;
    submitting: boolean;
    onOpenChange: (open: boolean) => void;
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
      idempotencyKey?: string;
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
  /**
   * The shortfall the server says this deal has, or null.
   *
   * Read from the MONEY block, not from the stage rail. The rail is deliberately
   * qualitative — stage names and blocker keys, no amounts — precisely so it can
   * be shown to a caller who cannot see the money, and taking a figure from it
   * would undo that. `appraisalGapMinor` travels with the other amounts, under
   * the same gate, and is a read of what was recorded rather than a fresh
   * computation: a locally derived gap could disagree with the one the mutation
   * reconciles against and would then reject an operator's arithmetic for being
   * correct.
   *
   * Null for a caller whose money is withheld, and that is load-bearing — the
   * action below is withheld with it. Asking somebody to agree a split of a
   * figure their screen cannot show them is the exact defect the handover
   * confirmation spent nine review rounds removing.
   */
  const rawAppraisalGapMinor =
    typeof deal?.money?.appraisalGapMinor === "number" ? deal.money.appraisalGapMinor : null;
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
  const completed = stages.filter((s) => s.state === "COMPLETE");
  const live = stages.find((s) => s.state === "CURRENT" || s.state === "BLOCKED");
  // Completed stages collapse behind a disclosure so the eye lands on the one
  // stage that needs a decision. On a dead deal there is no such stage, so the
  // rail opens rather than hiding everything behind a control nobody would
  // think to press.
  const remaining = stages.filter((s) => s.state !== "COMPLETE");
  const supplierRow = deal.money?.parties.find((p) => p.party === "SUPPLIER");
  const canSettleSupplier =
    deal.money?.settlesDirectToSupplier === true &&
    deal.money.routeKnown &&
    supplierRow?.position === "OWED_TO_DEALERSHIP";

  const handleSupplierReceipt = async (receipt: {
    amount: number;
    receiptMethod?: PaymentMethod;
    receiptReference?: string;
    receivedAt?: number;
  }) => {
    setSubmitting(true);
    try {
      // Keyed to THIS claim, whose id the server resolved. The screen never
      // lets a client name a receivable of its own choosing.
      receiptKeyRef.current ??= crypto.randomUUID();
      await onRecordSupplierReceipt(
        supplierRow!.receivableId as Id<"vehicleSupplierReceivables">,
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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {/* The TITLE is polymorphic too, and this was only visible by
                  rendering: a cash deal headed `طلب تمويل` ("finance
                  application") names a record that does not exist for it.
                  `dealRef` rather than the application id, for the same reason —
                  a cash deal has no application. Both queries supply it. */}
              {t(deal.dealKind === "CASH" ? "DealCockpitTitleCash" : "DealCockpitTitle")}{" "}
              <bdi className="text-muted-foreground">#{String(deal.dealRef).slice(-4)}</bdi>
            </h1>
            <Badge variant={deal.status === "APPROVED" || deal.status === "CLOSED" ? "default" : "secondary"}>
              {t(STATUS_LABEL[deal.status] ?? deal.status)}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            <bdi>{deal.financeCompanyName}</bdi>
            {deal.financeCompanyName && " · "}
            <bdi>{format(deal.createdAt, "d MMM yyyy")}</bdi>
            {" · "}
            {t("DealOwner")}: <bdi>{deal.salespersonName}</bdi>
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("LastUpdated")}: <bdi>{format(deal.updatedAt ?? deal.createdAt, "d MMM yyyy HH:mm")}</bdi>
        </p>
      </div>

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

      {/* --- stage rail: the signature element ---------------------------- */}
      <Card>
        <CardContent className="space-y-3 pt-6">
          {completed.length > 0 && (
            <button
              type="button"
              onClick={() => setShowCompleted((open) => !open)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted/60"
              aria-expanded={showCompleted}
            >
              <Check className="h-4 w-4 text-emerald-600" />
              <span>
                <bdi>{completed.length}</bdi>{" "}
                {t(completed.length === 1 ? "StageCompletedOne" : "StagesCompleted")}
              </span>
              <ChevronDown
                className={`h-4 w-4 ms-auto transition-transform ${showCompleted ? "rotate-180" : ""}`}
              />
            </button>
          )}

          {(showCompleted ? stages : remaining).map((stage) => (
            <StageRow
              key={stage.key}
              state={stage.state as StageState}
              label={t(STAGE_LABEL[stage.key] ?? stage.key)}
              blocker={stage.blocker ? t(`Blocker${stage.blocker}`) : undefined}
              isFocus={live?.key === stage.key}
            />
          ))}
        </CardContent>
      </Card>

      {/* --- next step ----------------------------------------------------
          The test id anchors the E2E to the BLOCK rather than to a button
          name. Every stage name appears twice on this screen — once on the
          rail, once here — so a spec selecting globally can pass against the
          rail while the block that is supposed to carry the action says
          nothing, which is the exact defect this issue is about. */}
      {live && (
        <Card className="border-primary/40 bg-primary/[0.03]" data-testid="deal-next-step">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("NextStepHeading")}</CardTitle>
          </CardHeader>
          <CardContent className="max-w-2xl space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <p className="font-medium">{t(STAGE_LABEL[live.key] ?? live.key)}</p>
              {/* The action for the step this block NAMES.
                  Until now the rail announced "vehicle handover" and offered
                  nothing that performs it, so the operator went looking for a
                  screen — Finance Applications -> Review — that the rail never
                  mentions. A step worth naming is a step worth doing here. */}
              {workflowAction?.stageKey === live.key &&
                workflowAction.unavailableReasonKey === undefined && (
                  <Button size="sm" onClick={workflowAction.onStart}>
                    {t(workflowAction.actionKey)}
                  </Button>
                )}
            </div>
            {live.blocker && (
              <p className="text-sm text-muted-foreground">{t(`Blocker${live.blocker}`)}</p>
            )}
            {/* Why the named step is not actionable BY THIS CALLER. Silence
                here is the defect this issue exists to remove. */}
            {workflowAction?.stageKey === live.key && workflowAction.unavailableReasonKey && (
              <p className="text-sm text-muted-foreground">
                {t(workflowAction.unavailableReasonKey)}
              </p>
            )}
            {live.blocker === "DocumentsIncomplete" && (
              <ul className="space-y-1 pt-1">
                {deal.documents
                  .filter((doc) => doc.required && doc.status !== "VERIFIED" && doc.status !== "WAIVED")
                  .map((doc) => (
                    <li key={doc.ruleId} className="flex items-center gap-2 text-sm">
                      <Minus className="h-3.5 w-3.5 text-muted-foreground" />
                      <bdi>{doc.name}</bdi>
                    </li>
                  ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* --- what the finance company told us ----------------------------- */}
      {/* Under the next step, not inside the money column: this is the ACTION
          on the stage the rail reports as blocked, and the money column is
          withheld entirely from the role that performs it. */}
      {financeDecision && (
        <FinanceCompanyDecisionCard
          facts={financeDecision.facts}
          canRecordQuotation={financeDecision.canRecordQuotation}
          canRecordApproval={financeDecision.canRecordApproval}
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

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
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

              <MoneyPanel
                money={money}
                profit={deal.money.profit}
                t={t}
              />

              {/* --- أطراف الصفقة ------------------------------------------ */}
              {/* ABSENT when there is nobody to list. An OWNED cash sale has no
                  third party at all — no supplier, no financier — so the card
                  would render a heading over nothing, which is the "empty
                  rather than absent" pattern this screen removes everywhere
                  else. The financed path always has rows, so it is unaffected. */}
              {(deal.money.parties.length > 0 || deal.applicationId !== null) && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t("DealPartiesHeading")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {deal.money.parties.map((party) => (
                    <div
                      key={party.party}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <p className="font-medium">
                          {t(PARTY_LABEL[party.party] ?? party.party)}
                          {party.name && (
                            <>
                              {" — "}
                              <bdi className="text-muted-foreground">{party.name}</bdi>
                            </>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t(POSITION_LABEL[party.position] ?? party.position)}
                          {party.reference && (
                            <>
                              {" · "}
                              <bdi>{party.reference}</bdi>
                            </>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        {party.position !== "NOT_INVOLVED" && party.position !== "UNKNOWN" && (
                          <p className="font-semibold">
                            <Money>{money(party.amountMinor)}</Money>
                          </p>
                        )}
                        {party.party === "SUPPLIER" && canSettleSupplier && (
                          <Button size="sm" onClick={() => setSettlingSupplier(true)}>
                            {t("SettleSupplierAction")}
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                  {/* Only where an APPLICATION exists. `فرق تخمين` is the
                      difference between the finance company's appraisal and the
                      price — a cash deal has no appraisal, so "no appraisal gap"
                      would not be reassuring, it would be answering a question
                      nobody asked.
                      Gated on the data rather than on `dealKind`, because a
                      financed SALE opened on the sale-keyed route is
                      `dealKind: "FINANCED"` and still has no appraisal payload. */}
                  {deal.applicationId !== null && (
                    <p className="text-xs text-muted-foreground">
                      {t("AppraisalGapLabel")}:{" "}
                      {deal.money.appraisalGapMinor ? (
                        <Money>{money(deal.money.appraisalGapMinor)}</Money>
                      ) : (
                        t("NoAppraisalGap")
                      )}
                    </p>
                  )}
                </CardContent>
              </Card>
              )}

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
              {(deal.dealKind === "FINANCED" ||
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
        </div>

        {/* --- side rail ------------------------------------------------- */}
        <div className="space-y-6">
          {deal.vehicle && (
            <Card>
              <CardContent className="space-y-2 pt-6 text-sm">
                <p className="font-medium">
                  <bdi>{deal.vehicle.label}</bdi>
                </p>
                <p className="text-muted-foreground">
                  <bdi>{deal.vehicle.vin}</bdi>
                </p>
                <Badge variant="outline">
                  {deal.vehicle.consigned ? t("OwnershipWithSupplier") : t("OwnershipWithDealership")}
                </Badge>
                {deal.customer && (
                  <p className="pt-2 text-muted-foreground">
                    <bdi>{deal.customer.name}</bdi>
                    {deal.customer.phone && (
                      <>
                        {" · "}
                        <bdi>{deal.customer.phone}</bdi>
                      </>
                    )}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* ABSENT, not empty. A cash deal has no document checklist at all —
              the rules are per finance company and their per-deal status lives
              on the application — so an empty card would invite an operator to
              look for an upload control that does not exist. */}
          {deal.documents.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t("DocumentsHeading")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {deal.documents.map((doc) => (
                <div key={doc.ruleId} className="flex items-center gap-2 text-sm">
                  {doc.status === "VERIFIED" || doc.status === "WAIVED" ? (
                    <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <bdi className="min-w-0 truncate">{doc.name}</bdi>
                  {doc.required && doc.status !== "VERIFIED" && doc.status !== "WAIVED" && (
                    <Badge variant="outline" className="ms-auto shrink-0 text-xs">
                      {t("DocumentRequired")}
                    </Badge>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
          )}

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
        </div>
      </div>

      {supplierRow && (
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
            canSetLtvPercent={financeDecision.canRecordApproval}
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

      {/* Only for a deal that actually has a shortfall. The gap comes from the
          server's own figure — this screen never derives it, because a locally
          computed gap could disagree with the one the mutation reconciles
          against and would reject the operator's arithmetic for being right. */}
      {gapResolution && rawAppraisalGapMinor !== null && (
        <ResolveGapDialog
          open={gapResolution.resolving}
          submitting={gapResolution.submitting}
          rawAppraisalGapMinor={rawAppraisalGapMinor}
          economicsStamp={deal && "economicsStamp" in deal ? deal.economicsStamp : undefined}
          factor={factor}
          money={money}
          t={t}
          onOpenChange={gapResolution.onOpenChange}
          onSubmit={gapResolution.onSubmit}
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

function StageRow({
  state,
  label,
  blocker,
  isFocus,
}: Readonly<{ state: StageState; label: string; blocker?: string; isFocus: boolean }>) {
  const icon = STAGE_ICON[state] ?? STAGE_ICON.PENDING;

  return (
    <div
      className={`flex items-start gap-3 rounded-md px-2 py-1.5 ${
        isFocus ? "bg-primary/[0.06]" : ""
      }`}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className={`text-sm ${isFocus ? "font-medium" : state === "COMPLETE" ? "text-muted-foreground" : ""}`}>
          {label}
        </p>
        {blocker && <p className="text-xs text-amber-700 dark:text-amber-400">{blocker}</p>}
      </div>
    </div>
  );
}
