"use client";

import { useMemo, useRef, useState } from "react";
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
import { format } from "date-fns";
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

type StageState = "COMPLETE" | "CURRENT" | "BLOCKED" | "PENDING" | "STOPPED";

const STAGE_LABEL: Record<string, string> = {
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
  | "DealCancelled",
  string
> = {
  NoApprovedPurchaseAmount: "ProfitNeedsApprovedPurchase",
  NoSupplierSettlement: "ProfitNeedsSupplierSettlement",
  NoDealerContribution: "ProfitNeedsDealerContribution",
  CorruptInput: "ProfitInputCorrupt",
  DealCancelled: "ProfitDealCancelled",
};

/** A money run is Latin digits inside Arabic prose; `<bdi>` keeps it whole. */
function Money({ children }: Readonly<{ children: React.ReactNode }>) {
  return <bdi className="tabular-nums">{children}</bdi>;
}

export type DealCockpitData = NonNullable<
  (typeof api.applications.dealCockpit)["_returnType"]
>;

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
}: Readonly<{ orgId: Id<"organizations">; applicationId: Id<"financeApplications"> }>) {
  const deal = useQuery(api.applications.dealCockpit, { orgId, applicationId });
  const recordReceipt = useMutation(api.supplierReceivables.recordReceipt);

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

export function DealCockpitView({
  deal,
  onRecordSupplierReceipt,
}: Readonly<{
  /** `undefined` while loading, `null` when the deal is not readable. */
  deal: DealCockpitData | null | undefined;
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
      toast.success(t("RecordReceipt"));
      setSettlingSupplier(false);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* --- header ------------------------------------------------------ */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("DealCockpitTitle")} <bdi className="text-muted-foreground">#{String(deal.applicationId).slice(-4)}</bdi>
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

              <Card>
                <CardContent className="space-y-4 pt-6">
                  <div className="space-y-1">
                    <p className="text-sm text-muted-foreground">{t("NetDealershipProfit")}</p>
                    {deal.money.managementProfit.available ? (
                      <>
                        <div className="flex flex-wrap items-baseline gap-3">
                          <p className="text-3xl font-semibold">
                            <Money>{money(deal.money.managementProfit.amountMinor)}</Money>
                          </p>
                          {/* The qualifier is not decoration. It renders from
                              the same object as the amount, so there is no code
                              path that shows one without the other. */}
                          <Badge variant="outline" className="border-amber-500/60 text-amber-700 dark:text-amber-400">
                            {deal.money.managementProfit.classification === "ACTUAL_UNPOSTABLE"
                              ? t("ProfitActualUnpostable")
                              : t("ProfitEstimatedAwaitingSettlement")}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">{t("ManagementFigureNote")}</p>
                      </>
                    ) : (
                      <>
                        <p className="text-2xl font-semibold text-muted-foreground">
                          {t("ProfitNotCalculable")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t(PROFIT_BLOCKED_REASON[deal.money.managementProfit.reason])}
                        </p>
                      </>
                    )}
                  </div>

                  {deal.money.managementProfit.available && (
                    <>
                      <Separator />
                      <dl className="space-y-1.5 text-sm">
                        {deal.money.managementProfit.lines
                          // A zero on an OPTIONAL line is noise, not information:
                          // the customer-direct amount has no writer yet, so it
                          // would read "0.000" on every deal forever, and the
                          // dealer contribution is zero on any fully funded deal.
                          // The three lines the mockup always shows stay, so the
                          // derivation never looks like it is hiding a term.
                          .filter(
                            (line) =>
                              line.amountMinor !== 0 ||
                              line.key === "APPROVED_PURCHASE" ||
                              line.key === "SUPPLIER_SETTLEMENT" ||
                              line.key === "ACTUAL_EXPENSES"
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

              {/* --- أطراف الصفقة ------------------------------------------ */}
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
                  <p className="text-xs text-muted-foreground">
                    {t("AppraisalGapLabel")}:{" "}
                    {deal.money.appraisalGapMinor ? (
                      <Money>{money(deal.money.appraisalGapMinor)}</Money>
                    ) : (
                      t("NoAppraisalGap")
                    )}
                  </p>
                </CardContent>
              </Card>

              {/* --- actual expenses -------------------------------------- */}
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

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">{t("StatusLogHeading")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {deal.timeline.map((entry, index) => (
                <div key={`${entry.changedAt}-${index}`} className="flex gap-3 text-sm">
                  <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p>{t(STATUS_LABEL[entry.toStatus] ?? entry.toStatus)}</p>
                    <p className="text-xs text-muted-foreground">
                      <bdi>{entry.actorName}</bdi>
                      {" · "}
                      <bdi>{format(entry.changedAt, "d MMM yyyy HH:mm")}</bdi>
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
    </div>
  );
}

function StageRow({
  state,
  label,
  blocker,
  isFocus,
}: Readonly<{ state: StageState; label: string; blocker?: string; isFocus: boolean }>) {
  const icon =
    state === "COMPLETE" ? (
      <Check className="h-4 w-4 text-emerald-600" />
    ) : state === "STOPPED" ? (
      <Ban className="h-4 w-4 text-muted-foreground" />
    ) : state === "BLOCKED" ? (
      <AlertTriangle className="h-4 w-4 text-amber-600" />
    ) : state === "CURRENT" ? (
      <CircleDot className="h-4 w-4 text-primary" />
    ) : (
      <Minus className="h-4 w-4 text-muted-foreground/60" />
    );

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
