"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { PaymentType, WizardData } from "../types";
import { Button } from "@/components/ui/button";
import { CheckCircle2, FileDown, LogOut, HandCoins, FileText, BadgeCheck, Receipt } from "lucide-react";
import { QuotePrintTemplate } from "../../QuotePrintTemplate";
import { ReceiptVoucherPrintTemplate } from "../../ReceiptVoucherPrintTemplate";
import { RecordDepositDialog } from "../components/RecordDepositDialog";
import { QuoteDepositManager } from "@/components/deposits/QuoteDepositManager";
import { ConsignedSettlementSection } from "../../ConsignedSettlementSection";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOrgSettings } from "@/hooks/useOrgSettings";
import { toast } from "@/components/ui/sonner";
import { downloadElementAsPdf } from "@/lib/htmlToPdf";
import { getErrorMessage } from "@/lib/errors";
import { decideDepositSubmission } from "@/lib/depositSettlementSubmission";

interface Step4QuoteSuccessProps {
  paymentType: PaymentType;
  wizardData: WizardData;
  selectedCustomer: Doc<"customers">;
  quoteId: Id<"quotes">;
  selectedVehicle?: Doc<"vehicles">;
  selectedVehicles?: Array<{ vehicle: Doc<"vehicles">; unitPrice: number }>;
  selectedCompany?: Doc<"financeCompanies">;
  selectedResult: any;
  onClose: () => void;
}

export function Step4QuoteSuccess({
  paymentType,
  wizardData,
  selectedCustomer,
  quoteId,
  selectedVehicle,
  selectedVehicles,
  selectedCompany,
  selectedResult,
  onClose,
}: Step4QuoteSuccessProps) {
  const { t } = useLanguage();
  const { activeOrgId } = useOrg();
  const orgSettings = useOrgSettings();
  const logoUrl = useQuery(
    api.orgSettings.getLogoUrl,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );

  const [depositDialogOpen, setDepositDialogOpen] = useState(false);
  const [depositRecorded, setDepositRecorded] = useState(false);
  const [depositId, setDepositId] = useState<Id<"deposits"> | null>(null);
  const voucher = useQuery(
    api.paymentVouchers.getByDeposit,
    activeOrgId && depositId ? { orgId: activeOrgId, depositId } : "skip"
  );
  const [applicationId, setApplicationId] = useState<Id<"financeApplications"> | null>(null);
  const [isStartingApplication, setIsStartingApplication] = useState(false);
  const createApplication = useMutation(api.applications.createFromQuote);

  /**
   * EVERY sale this quote produced, not just the first.
   *
   * A multi-vehicle quote completes one sale per car, so keeping only `ids[0]`
   * silently discarded the rest — and then linked as though that one id stood
   * for the whole quote. The deal screen is keyed on a single sale, so the honest
   * shape here is the list.
   */
  const [saleIds, setSaleIds] = useState<Id<"sales">[]>([]);
  const saleSubmitted = saleIds.length > 0;
  const [isCompletingSale, setIsCompletingSale] = useState(false);
  const completeSaleIdempotencyKeyRef = useRef<string | null>(null);
  const completeFromQuote = useMutation(api.sales.completeFromQuote);
  const markQuoteShared = useMutation(api.quotes.updateQuoteStatus);
  const quote = useQuery(
    api.quotes.get,
    activeOrgId ? { orgId: activeOrgId, quoteId } : "skip"
  );
  const me = useQuery(api.users.getMe);

  const handleStartApplication = async () => {
    if (!activeOrgId) return;
    setIsStartingApplication(true);
    try {
      const id = await createApplication({ orgId: activeOrgId, quoteId });
      setApplicationId(id);
      toast.success(t("ApplicationStartedSuccess" as any) ?? "Finance application started");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsStartingApplication(false);
    }
  };

  // The only place in the wizard that ever registers a sale — generating a
  // quote (Step3Review) never does. Loops every vehicle on the quote (one for
  // the common case, several for a multi-vehicle/fleet quote).
  // Applies to every consigned vehicle on the quote. `completeFromQuote` takes
  // one route for the call, so a quote mixing two consigned cars settled
  // different ways has to be split into separate deals — which is what it is.
  const [settlementRoute, setSettlementRoute] = useState<
    "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER"
  >("THROUGH_DEALERSHIP");

  // Whether the operator has confirmed the عربون forms part of this deal's
  // final settlement — held PER LINE.
  //
  // The treatment is quote-wide on the wire, but eligibility is per car: one
  // line's share can exceed its own margin while another's does not. A single
  // shared boolean meant the refusing line silently unticked a box the operator
  // had just clicked on a different, perfectly eligible car, with the
  // explanation attached to some other panel.
  const [depositInSettlement, setDepositInSettlement] = useState<Record<string, boolean>>({});
  const handleDepositConfirm = useCallback(
    (vehicleId: Id<"vehicles">, applied: boolean) =>
      setDepositInSettlement((prev) =>
        prev[vehicleId] === applied ? prev : { ...prev, [vehicleId]: applied }
      ),
    []
  );

  // What each line's server preview says about the treatment. Needed because
  // the mutation takes ONE treatment for the quote: if any line refuses it,
  // sending it fails the whole deal, so the deal must not send it — and the
  // operator has to be told which car is in the way.
  const [depositEligibility, setDepositEligibility] = useState<
    Record<string, { canApply: boolean; required: boolean; reason: string | null; label: string }>
  >({});
  const handleDepositEligibility = useCallback(
    (
      vehicleId: Id<"vehicles">,
      state: { canApply: boolean; required: boolean; reason: string | null; label: string } | null
    ) =>
      setDepositEligibility((prev) => {
        // `null` is a line withdrawing its answer — its deposit was resolved,
        // or it turned out not to be consigned. Without the DELETE the last
        // answer stayed forever, and a blocking one permanently disabled the
        // submit button on a deal the server would have accepted.
        if (state === null) {
          if (!(vehicleId in prev)) return prev;
          const { [vehicleId]: _removed, ...rest } = prev;
          return rest;
        }
        const existing = prev[vehicleId];
        if (
          existing &&
          existing.canApply === state.canApply &&
          existing.required === state.required &&
          existing.reason === state.reason &&
          existing.label === state.label
        ) {
          return prev;
        }
        return { ...prev, [vehicleId]: state };
      }),
    []
  );

  // Extracted so it can be tested at all — this wizard has no test file, and
  // this is the rule deciding whether a financial treatment is applied to every
  // car on the deal. See lib/depositSettlementSubmission.ts.
  const depositDecision = decideDepositSubmission(depositEligibility, depositInSettlement);
  const blockingLine = depositDecision.blockingLine;
  const sendDepositTreatment = depositDecision.sendTreatment;

  const handleSubmitSale = async () => {
    if (!activeOrgId || !quote || !me) return;
    setIsCompletingSale(true);
    try {
      completeSaleIdempotencyKeyRef.current ??= `submit-sale:${crypto.randomUUID()}`;
      const ids = await completeFromQuote({
        orgId: activeOrgId,
        quoteId,
        // Where the buyer's money went, for the consigned cars on this quote.
        // Omitted, the server reads THROUGH_DEALERSHIP, which posts the gross
        // through the dealership's own receivable — so a deal the supplier was
        // paid for directly was being booked as though it had not been.
        supplierSettlementRoute: settlementRoute,
        // Sent only when confirmed. Omitted, the server keeps its long-standing
        // behaviour: the deposit comes off what the customer owes whenever it
        // fits, and the sale is refused when it does not — which is the state
        // this control exists to give the operator a way out of.
        ...(sendDepositTreatment
          ? { depositResolution: { treatment: "APPLY_TO_TRANSACTION_SETTLEMENT" as const } }
          : {}),
        idempotencyKey: completeSaleIdempotencyKeyRef.current,
      });
      setSaleIds(ids);
      completeSaleIdempotencyKeyRef.current = null;
      toast.success(t("SaleCompletedSuccess" as any) ?? "Cash sale completed");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsCompletingSale(false);
    }
  };

  // The cars this quote will complete, in line order. A multi-vehicle quote
  // carries `vehicleItems`; the legacy single-line shape carries only
  // `vehicleId`, and reading the first from `vehicleItems` on one of those
  // returns nothing at all.
  const quoteVehicleIds = (
    quote?.vehicleItems ?? (quote ? [{ vehicleId: quote.vehicleId }] : [])
  ).map((item) => item.vehicleId);

  /**
   * Each completed sale paired with the car it was completed for.
   *
   * The pairing is POSITIONAL, and that is safe here for a specific reason
   * rather than by luck: `completeSalesForLineItems` pushes one sale id per
   * iteration of the quote's `vehicleItems` (`convex/utils/saleCompletion.ts`),
   * and the server builds that array with exactly the expression used for
   * `quoteVehicleIds` above — `quote.vehicleItems ?? [the single legacy line]`
   * (`convex/sales.ts`). Same source array, same order, so index i is the same
   * car on both sides.
   *
   * `saleCompletion.test.ts` pins that order contract, because a link that opens
   * a different car's deal than the one it names is worse than no label at all.
   *
   * `label` is null when the car is not among the props — the link still works
   * and falls back to the generic wording rather than inventing a name.
   */
  const completedDeals = saleIds.map((id, index) => {
    const vehicleId = quoteVehicleIds[index];
    const vehicle =
      selectedVehicles?.find((item) => item.vehicle._id === vehicleId)?.vehicle ??
      (selectedVehicle?._id === vehicleId ? selectedVehicle : undefined);
    return {
      saleId: id,
      label: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : null,
    };
  });

  /**
   * What replaces the submit button once the sale exists.
   *
   * Extracted as a statement rather than left inline. Inline it was a three-deep
   * ternary wrapping fifty lines of JSX — `paymentType === "CASH" ? (submitted ?
   * (one ? … : …) : …)` — and working out which condition produced which control
   * meant holding three open ternaries at once (Sonar S3358). Same markup, same
   * behaviour; only the reader's job changes.
   */
  let completedDealActions: ReactNode = null;
  if (completedDeals.length === 1) {
    completedDealActions = (
      <Button asChild size="lg" className="min-w-[200px] bg-emerald-600 hover:bg-emerald-700">
        <Link
          href={activeOrgId ? `/${activeOrgId}/sales/${completedDeals[0].saleId}/deal` : "#"}
        >
          <BadgeCheck className="w-4 h-4 me-2" />
          {t("OpenDeal" as any) ?? "Open Deal"}
        </Link>
      </Button>
    );
  } else if (completedDeals.length > 1) {
    /**
     * One row per car, each naming the car it belongs to.
     *
     * A quote for three cars completes three separate deals, and the deal screen
     * is keyed on ONE sale — so there is no single link that could be correct
     * here. Numbered links ("Deal 1, 2, 3") would make the operator open each one
     * to find out which car it is; the car's own name is the label that saves
     * that trip.
     *
     * Two nested elements, and the outer one carries NO max-width on purpose.
     * `w-full` alone does not win a row in a `flex-wrap` strip: `max-w-md` clamps
     * the item's hypothetical size, so the sibling buttons still fit beside it
     * and the list rendered shoulder-to-shoulder with them — caught by looking at
     * the render, not by any test. The outer div is genuinely full-width so it
     * takes its own line; the inner one does the measuring.
     */
    completedDealActions = (
      <div className="w-full">
        <div className="mx-auto w-full max-w-md space-y-2 text-start">
          <p className="text-sm text-muted-foreground">
            {t("DealsCreatedForEachVehicle" as any) ?? "A deal was created for each vehicle"}
          </p>
          {completedDeals.map((deal, index) => (
            <Button
              key={deal.saleId}
              asChild
              variant="outline"
              size="lg"
              className="w-full justify-between border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400"
            >
              <Link href={activeOrgId ? `/${activeOrgId}/sales/${deal.saleId}/deal` : "#"}>
                {/* Isolated: a "2020 Toyota Camry" beside Arabic UI text is a
                    mixed run, and bidi reordering will scramble the year into the
                    neighbouring Arabic without this. */}
                <bdi className="truncate">
                  {/* The position is a FALLBACK label, never a decoration beside
                      a real one. Unnamed rows are the case where the car is not
                      among the props, and without the number every one of them
                      read "Open Deal" — three identical buttons the operator has
                      to open one by one, which is exactly what naming the car
                      exists to avoid. */}
                  {deal.label ?? `${t("OpenDeal" as any) ?? "Open Deal"} ${index + 1}`}
                </bdi>
                <BadgeCheck className="w-4 h-4 ms-2 shrink-0" />
              </Link>
            </Button>
          ))}
        </div>
      </div>
    );
  }

  // Which lines turned out to be consigned. Only the preview can say, so the
  // sections report it up and the route selector goes on the first line that
  // actually has a supplier to settle with.
  const [consignedLines, setConsignedLines] = useState<Record<string, boolean>>({});
  const handleLineApplicable = useCallback(
    (vehicleId: Id<"vehicles">, applicable: boolean) =>
      setConsignedLines((prev) =>
        prev[vehicleId] === applicable ? prev : { ...prev, [vehicleId]: applicable }
      ),
    []
  );
  const firstConsignedVehicleId = quoteVehicleIds.find((id) => consignedLines[id]);

  // An INSTALLMENT quote on a consigned car may now settle direct-to-supplier:
  // the finance company's side of that settlement is recorded on the finance
  // application, and the postings that assumed the money arrived here are
  // skipped. The section still never rewrites the operator's choice.

  const orgBranding = {
    name: orgSettings?.dealershipName,
    legalName: orgSettings?.legalCompanyName,
    logoUrl,
    primaryColor: orgSettings?.primaryColor,
    address: orgSettings?.dealershipAddress,
    phone: orgSettings?.dealershipPhone,
    currencySymbol: orgSettings?.currencySymbol,
  };

  const handleDownload = async () => {
    const saved = await downloadElementAsPdf("pdf-quote-content", `Quote_${selectedCustomer.firstName}.pdf`);

    // Downloading the quote means it's being handed to the customer — mark it
    // SHARED so the originating lead (if any) advances to NEGOTIATION. The PDF
    // already saved successfully, so a failure here shouldn't surface as an error.
    if (saved && activeOrgId) {
      markQuoteShared({ orgId: activeOrgId, quoteId, status: "SHARED" }).catch(() => {});
    }
  };

  const handleDownloadVoucher = async () => {
    const saved = await downloadElementAsPdf(
      "receipt-voucher-pdf-content",
      `Receipt_${voucher?.voucherNumber ?? selectedCustomer.firstName}.pdf`
    );
    if (saved) {
      toast.success(t("ReceiptVoucherGenerated"));
    } else {
      toast.error(t("FailedGeneratePDF" as any));
    }
  };

  return (
    <>
      <div className="flex flex-col items-center justify-center py-12 space-y-6 text-center print:hidden">
        <div className="w-16 h-16 bg-emerald-500/10 text-emerald-500 rounded-full flex items-center justify-center mb-4">
          <CheckCircle2 className="w-8 h-8" />
        </div>

        <div className="space-y-2">
          <h2 className="text-2xl font-bold text-foreground">
            {t("QuoteGeneratedSuccess" as any)}
          </h2>
          <p className="text-muted-foreground max-w-md mx-auto">
            {t("QuoteSavedLinkedTo" as any)}{" "}
            <span className="font-semibold text-foreground">
              {selectedCustomer.firstName} {selectedCustomer.lastName}
            </span>
          </p>
        </div>

        <div className="pt-6 flex flex-wrap gap-4 justify-center items-center">
          <Button
            onClick={handleDownload}
            className="bg-indigo-600 hover:bg-indigo-700 min-w-[200px]"
            size="lg"
          >
            <FileDown className="w-4 h-4 me-2" />
            {t("DownloadPDFQuote" as any)}
          </Button>

          <Button
            onClick={() => setDepositDialogOpen(true)}
            disabled={depositRecorded || saleSubmitted}
            variant="outline"
            size="lg"
            className="min-w-[200px] border-amber-500/40 text-amber-600 hover:bg-amber-500/10"
          >
            <HandCoins className="w-4 h-4 me-2" />
            {depositRecorded
              ? (t("DepositRecorded" as any) ?? "Deposit Recorded ✓")
              : (t("RecordDeposit" as any) ?? "Record Deposit")}
          </Button>

          {depositRecorded && voucher && (
            <Button
              onClick={handleDownloadVoucher}
              variant="outline"
              size="lg"
              className="min-w-[200px] border-amber-500/40 text-amber-600 hover:bg-amber-500/10"
            >
              <Receipt className="w-4 h-4 me-2" />
              {t("DownloadReceiptVoucher")}
            </Button>
          )}

          {paymentType === "INSTALLMENT" && (
            applicationId ? (
              <Button asChild variant="outline" size="lg" className="min-w-[200px] border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10">
                <Link href={activeOrgId ? `/${activeOrgId}/applications` : "#"}>
                  <FileText className="w-4 h-4 me-2" />
                  {t("ViewApplication" as any) ?? "View Application →"}
                </Link>
              </Button>
            ) : (
              <Button
                onClick={handleStartApplication}
                disabled={isStartingApplication}
                variant="outline"
                size="lg"
                className="min-w-[200px]"
              >
                <FileText className="w-4 h-4 me-2" />
                {isStartingApplication
                  ? (t("Saving" as any) || "Saving...")
                  : (t("StartFinanceApplication" as any) ?? "Start Finance Application")}
              </Button>
            )
          )}

          {paymentType === "CASH" && (
            saleSubmitted ? (
              completedDealActions
            ) : (
              <Button
                onClick={handleSubmitSale}
                disabled={
                  isCompletingSale ||
                  !quote ||
                  !me ||
                  // A car on this quote refuses the deposit treatment, or only
                  // some of them are confirmed. Either way the deal cannot be
                  // submitted coherently — and letting it through produced a
                  // refusal naming no vehicle, on a multi-car quote.
                  !depositDecision.canSubmit
                }
                variant="outline"
                size="lg"
                className="min-w-[200px] border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10"
              >
                <BadgeCheck className="w-4 h-4 me-2" />
                {isCompletingSale
                  ? (t("Saving" as any) || "Saving...")
                  : (t("SubmitSale" as any) ?? "Submit Sale")}
              </Button>
            )
          )}

          <Button onClick={onClose} variant="outline" size="lg" className="min-w-[200px]">
            <LogOut className="w-4 h-4 me-2" />
            {t("DoneClose" as any)}
          </Button>
        </div>
      </div>

      {/* Which car is in the way, and why. This was computed and thrown away:
          the submit was simply withheld, and the server's refusal names no
          vehicle, so on a multi-car quote the operator was told a deposit was
          too large without being told whose. */}
      {activeOrgId && !depositDecision.canSubmit && !saleSubmitted ? (
        <p className="mx-auto flex max-w-2xl items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/[0.06] px-3 py-2.5 text-xs leading-relaxed text-amber-800 dark:text-amber-400">
          <span aria-hidden>⚠</span>
          <span>
            {blockingLine ? (
              <>
                <span className="font-medium">{blockingLine.label}</span>
                {" — "}
                {blockingLine.reason}
              </>
            ) : depositDecision.unconfirmedRequiredLine ? (
              // Ordered after `blockingLine` deliberately: that one cannot be
              // resolved from this screen and this one can, so showing both
              // would give two instructions for one deal.
              <>
                <span className="font-medium">
                  {depositDecision.unconfirmedRequiredLine.label}
                </span>
                {" — "}
                {t("DepositSettlementRequired" as any)}
              </>
            ) : (
              t("DepositSettlementConfirmAllLines" as any)
            )}
          </span>
        </p>
      ) : null}

      {activeOrgId ? (
        <div className="space-y-4">
          <QuoteDepositManager
            orgId={activeOrgId}
            quoteId={quoteId}
            settlement={
              // Only while the sale can still be completed. Once it has, the
              // decision is made and offering it again would be a control that
              // does nothing.
              paymentType === "CASH" && !saleSubmitted
                ? {
                    vehicleIds: quoteVehicleIds,
                    settlementRoute,
                    value: depositInSettlement,
                    onChange: handleDepositConfirm,
                    onEligibility: handleDepositEligibility,
                    disabled: isCompletingSale,
                  }
                : undefined
            }
          />
          {/* One per car on the quote, each priced off its own line. Feeding
              the quote total into a single preview showed the first car's
              supplier cost against every car's price. The route is a single
              decision for the deal, so it is asked for once, on the first. */}
          {quoteVehicleIds.map((vehicleId) => (
            <ConsignedSettlementSection
              key={vehicleId}
              orgId={activeOrgId}
              vehicleId={vehicleId}
              quoteId={quoteId}
              value={settlementRoute}
              onChange={setSettlementRoute}
              // On the first CONSIGNED line, not the first line. A quote whose
              // first car is dealer-owned renders nothing for it — so keying the
              // selector to index 0 hid the control on every mixed quote, and
              // the deal posted the THROUGH_DEALERSHIP default with the operator
              // never asked which way the money went.
              showRouteSelector={vehicleId === firstConsignedVehicleId}
              onApplicable={handleLineApplicable}
            />
          ))}
        </div>
      ) : null}

      <RecordDepositDialog
        open={depositDialogOpen}
        onOpenChange={setDepositDialogOpen}
        quoteId={quoteId}
        onRecorded={(id) => {
          setDepositRecorded(true);
          setDepositId(id);
        }}
      />

      <QuotePrintTemplate
        paymentType={paymentType}
        wizardData={wizardData}
        selectedVehicle={selectedVehicle}
        selectedVehicles={selectedVehicles}
        selectedCompany={selectedCompany}
        selectedCustomer={selectedCustomer}
        selectedResult={selectedResult}
        dateStr={new Date().toLocaleDateString("ar-JO")}
        orgBranding={orgBranding}
      />

      {voucher && (
        <ReceiptVoucherPrintTemplate
          voucherNumber={voucher.voucherNumber}
          customerName={`${selectedCustomer.firstName} ${selectedCustomer.lastName}`}
          descriptionAr={voucher.descriptionAr}
          amount={voucher.amount}
          currency={voucher.currency}
          issuedAtStr={new Date(voucher.issuedAt).toLocaleDateString("ar-JO")}
          orgBranding={orgBranding}
        />
      )}
    </>
  );
}
