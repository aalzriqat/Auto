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
  /** The figure does not exist for this financing mode, so nothing is pending. */
  | "NotApplicableForFinancingMode"
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
  NotApplicableForFinancingMode: "ProfitNotApplicableForMode",
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
  const recordReceipt = useMutation(api.supplierReceivables.recordReceipt);
  const amendAdvice = useMutation(api.applications.amendSupplierDisbursementAdvice);
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  const router = useRouter();

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
  // One key per correction attempt, so a retry after a lost response is the same
  // amendment rather than a second audited one.
  const correctionKeyRef = useRef<string | null>(null);

  // Below every hook, deliberately. An early return placed above `useRef` changes
  // the hook order between renders — eslint's rules-of-hooks caught exactly that
  // here, and the redirect is a render-time courtesy that can wait three lines.
  if (finalizedSaleId) return <Skeleton className="h-64 w-full" />;

  return (
    <DealCockpitView
      deal={deal}
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
            {/* "Cannot be calculated YET" promises the figure is coming. On a
                mode that never produces one it is simply not part of the deal,
                and a headline that implies otherwise sends the operator looking
                for a screen that will never accept the number. */}
            <p className="text-2xl font-semibold text-muted-foreground">
              {t(
                profit.reason === "NotApplicableForFinancingMode"
                  ? "ProfitNotApplicable"
                  : "ProfitNotCalculable"
              )}
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
          <dl className="space-y-1.5 text-sm">
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

export function DealCockpitView({
  deal,
  canCorrectAdvice = false,
  onCorrectSettlementAdvice,
  onRecordSupplierReceipt,
}: Readonly<{
  /** `undefined` while loading, `null` when the deal is not readable. */
  deal: DealCockpitData | null | undefined;
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

  // Never a hardcoded ÷1000. JOD, KWD, BHD and OMR are three-decimal; most
  // currencies are two. Baking one scale in would be a 100x error everywhere
  // else — the same trap the accounting screens already solved with this helper.
  // CX-3. The scale comes from the currency the SERVER pinned on this deal, not
  // from whatever the org is configured with today. `economicsCurrency` is
  // snapshotted per application, so an in-flight JOD deal on an org that later
  // switches to USD would otherwise be rescaled at the wrong power of ten —
  // 5,000,000 minor units rendering as 50,000 USD instead of 5,000 JOD, and the
  // same wrong factor feeding the receipt dialog.
  const dealCurrency = deal?.money?.currency ?? currency.code;
  const factor = useMemo(() => Math.pow(10, scaleForCurrency(dealCurrency)), [dealCurrency]);
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

      {/* --- next step ---------------------------------------------------- */}
      {live && (
        <Card className="border-primary/40 bg-primary/[0.03]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("NextStepHeading")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="font-medium">{t(STAGE_LABEL[live.key] ?? live.key)}</p>
            {live.blocker && (
              <p className="text-sm text-muted-foreground">{t(`Blocker${live.blocker}`)}</p>
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

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* --- money ---------------------------------------------------- */}
          {deal.money === null ? (
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
