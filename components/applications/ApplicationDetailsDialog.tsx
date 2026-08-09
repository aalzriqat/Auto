"use client";

import { useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { format } from "date-fns";
import { toast } from "@/components/ui/sonner";
import { Separator } from "@/components/ui/separator";
import { Upload, CheckCircle, XCircle, Clock, Eye, X, Download, History, Ban, HandCoins, Undo2 } from "lucide-react";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { useCurrency } from "@/hooks/useCurrency";
import { scaleForCurrency } from "@/components/accounting/AccountingTabShared";
import { DisbursementConfirmationDialog } from "./DisbursementConfirmationDialog";
import { getErrorMessage } from "@/lib/errors";
import { VehicleHandoverDialog } from "./VehicleHandoverDialog";
import { RegisterExpectedPaymentDialog, type ExpectedPaymentMethod } from "./RegisterExpectedPaymentDialog";
import { PaymentMethodSelect, type PaymentMethod } from "@/components/payments/PaymentMethodSelect";

type DepositResolution = "REFUNDED" | "FORFEITED";
type PendingDepositResolution = {
  depositId: Id<"deposits">;
  amount: number;
  resolution: DepositResolution;
} | null;

export function ApplicationDetailsDialog({
  applicationId,
  open,
  onOpenChange
}: {
  applicationId: Id<"financeApplications">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { hasPermission } = usePermissions();
  const currency = useCurrency();
  const canCreateApplication = hasPermission(PERMISSIONS.CREATE_FINANCE_APPLICATION);
  const canReviewApplication = hasPermission(PERMISSIONS.REVIEW_FINANCE_APPLICATION);
  const canApproveApplication = hasPermission(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
  const canFinalizeApplication = hasPermission(PERMISSIONS.FINALIZE_FINANCED_DEAL);
  const canVerifyDocuments = hasPermission(PERMISSIONS.VERIFY_FINANCE_DOCUMENTS);
  const canConfirmFinanceDisbursement = hasPermission(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
  const canRegisterHandover = hasPermission(PERMISSIONS.REGISTER_VEHICLE_HANDOVER);
  const canRegisterExpectedPayment = hasPermission(PERMISSIONS.REGISTER_EXPECTED_PAYMENT);
  const canResolveDeposits = hasPermission(PERMISSIONS.APPROVE_REQUESTS);
  const [previewFile, setPreviewFile] = useState<{ url: string; name: string } | null>(null);
  const [isCancelDialogOpen, setIsCancelDialogOpen] = useState(false);
  const [isDisbursementDialogOpen, setIsDisbursementDialogOpen] = useState(false);
  const [isConfirmingDisbursement, setIsConfirmingDisbursement] = useState(false);
  const [isHandoverDialogOpen, setIsHandoverDialogOpen] = useState(false);
  const [isRegisteringHandover, setIsRegisteringHandover] = useState(false);
  const [isPaymentDialogOpen, setIsPaymentDialogOpen] = useState(false);
  const [isRegisteringPayment, setIsRegisteringPayment] = useState(false);
  const [resolvingDepositId, setResolvingDepositId] = useState<Id<"deposits"> | null>(null);
  const [pendingDepositResolution, setPendingDepositResolution] = useState<PendingDepositResolution>(null);
  const [refundMethod, setRefundMethod] = useState<PaymentMethod>("CASH");
  const [cancelReason, setCancelReason] = useState("");
  const finalizeDealIdempotencyKeyRef = useRef<string | null>(null);
  const cancelApplicationIdempotencyKeyRef = useRef<string | null>(null);
  const confirmDisbursementIdempotencyKeyRef = useRef<string | null>(null);
  const confirmSupplierDisbursementIdempotencyKeyRef = useRef<string | null>(null);
  const [isSupplierDisbursementDialogOpen, setIsSupplierDisbursementDialogOpen] = useState(false);

  const app = useQuery(api.applications.get, activeOrgId ? { orgId: activeOrgId, applicationId } : "skip");
  const documents = useQuery(api.documents.getForApplication, activeOrgId ? { orgId: activeOrgId, applicationId } : "skip");
  const statusLog = useQuery(api.applications.getLog, activeOrgId ? { orgId: activeOrgId, applicationId } : "skip");

  const updateStatus = useMutation(api.applications.updateStatus);
  const cancelApplication = useMutation(api.applications.cancelApplication);
  const finalizeDeal = useMutation(api.applications.finalizeDeal);
  const confirmDisbursement = useMutation(api.applications.confirmDisbursement);
  const confirmSupplierDisbursement = useMutation(api.applications.confirmSupplierDisbursement);
  const setSupplierSettlementRoute = useMutation(api.applications.setSupplierSettlementRoute);
  const registerVehicleHandover = useMutation(api.applications.registerVehicleHandover);
  const registerExpectedPayment = useMutation(api.applications.registerExpectedPayment);
  const releaseDeposit = useMutation(api.deposits.release);
  const updateDocStatus = useMutation(api.documents.updateDocumentStatus);
  const generateUploadUrl = useMutation(api.documents.generateUploadUrl);
  const saveDocumentFile = useMutation(api.documents.saveDocumentFile);

  const handleUpload = async (docId: Id<"applicationDocuments">, file: File) => {
    if (!activeOrgId) return;
    try {
      const postUrl = await generateUploadUrl({
        orgId: activeOrgId,
        mimeType: file.type,
        sizeInBytes: file.size
      });
      const result = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      const { storageId } = await result.json();

      await saveDocumentFile({
        orgId: activeOrgId,
        documentId: docId,
        fileId: storageId,
      });
      toast.success(t("UploadSuccess" as any));
    } catch {
      toast.error(t("UnexpectedError" as any));
    }
  };

  const handleApproveApp = async () => {
    if (!activeOrgId) return;
    try {
      await updateStatus({ orgId: activeOrgId, applicationId, status: "APPROVED" });
      toast.success(t("AppApprovedSuccess" as any));
    } catch {
      toast.error(t("UnexpectedError" as any));
    }
  };

  const handleMarkUnderReview = async () => {
    if (!activeOrgId) return;
    try {
      await updateStatus({ orgId: activeOrgId, applicationId, status: "UNDER_REVIEW" });
      toast.success(t("AppUnderReviewSuccess" as any));
    } catch {
      toast.error(t("UnexpectedError" as any));
    }
  };

  const handleRejectApp = async () => {
    if (!activeOrgId) return;
    try {
      await updateStatus({ orgId: activeOrgId, applicationId, status: "REJECTED" });
      toast.success(t("AppRejectedSuccess" as any));
    } catch {
      toast.error(t("UnexpectedError" as any));
    }
  };

  const handleCancelApplication = async () => {
    if (!activeOrgId) return;
    try {
      cancelApplicationIdempotencyKeyRef.current ??= `cancel-application:${crypto.randomUUID()}`;
      await cancelApplication({
        orgId: activeOrgId,
        applicationId,
        reason: cancelReason.trim() || undefined,
        idempotencyKey: cancelApplicationIdempotencyKeyRef.current,
      });
      cancelApplicationIdempotencyKeyRef.current = null;
      toast.success(t("AppCancelledSuccess" as any));
      setIsCancelDialogOpen(false);
      setCancelReason("");
      onOpenChange(false);
    } catch {
      toast.error(t("UnexpectedError" as any));
    }
  };

  const handleResolveDeposit = async (
    depositId: Id<"deposits">,
    resolution: DepositResolution
  ) => {
    if (!activeOrgId) return;
    setResolvingDepositId(depositId);
    try {
      await releaseDeposit({
        orgId: activeOrgId,
        depositId,
        resolution,
        refundMethod: resolution === "REFUNDED" ? refundMethod : undefined,
      });
      toast.success(
        resolution === "REFUNDED"
          ? t("DepositRefundedSuccess")
          : t("DepositForfeitedSuccess")
      );
      setPendingDepositResolution(null);
      setRefundMethod("CASH");
    } catch {
      toast.error(t("UnexpectedError" as any));
    } finally {
      setResolvingDepositId(null);
    }
  };

  const handleFinalizeDeal = async () => {
    if (!activeOrgId) return;
    try {
      finalizeDealIdempotencyKeyRef.current ??= `finalize-deal:${crypto.randomUUID()}`;
      await finalizeDeal({
        orgId: activeOrgId,
        applicationId,
        idempotencyKey: finalizeDealIdempotencyKeyRef.current,
      });
      finalizeDealIdempotencyKeyRef.current = null;
      toast.success(t("DealFinalizedSuccess" as any));
      onOpenChange(false);
    } catch (error) {
      // Every refusal reachable from this button is actionable and names what
      // to change — an unrecorded settlement route, an unresolved عربون, a
      // missing approved purchase amount. Collapsing them all into "unexpected
      // error" left the operator with a deal they could neither complete nor
      // diagnose, and the only apparent way forward was to change the route and
      // post the deal the wrong way round.
      toast.error(getErrorMessage(error));
    }
  };

  const handleRegisterHandover = async (notes?: string) => {
    if (!activeOrgId) return;
    setIsRegisteringHandover(true);
    try {
      await registerVehicleHandover({ orgId: activeOrgId, applicationId, notes });
      toast.success(t("VehicleHandoverRegisteredSuccess" as any));
      setIsHandoverDialogOpen(false);
    } catch {
      toast.error(t("UnexpectedError" as any));
    } finally {
      setIsRegisteringHandover(false);
    }
  };

  const handleRegisterExpectedPayment = async (values: {
    method: ExpectedPaymentMethod;
    expectedDate: number;
    chequeDetails?: { bank: string; chequeNumber: string };
  }) => {
    if (!activeOrgId) return;
    setIsRegisteringPayment(true);
    try {
      await registerExpectedPayment({ orgId: activeOrgId, applicationId, ...values });
      toast.success(t("ExpectedPaymentRegisteredSuccess" as any));
      setIsPaymentDialogOpen(false);
    } catch {
      toast.error(t("UnexpectedError" as any));
    } finally {
      setIsRegisteringPayment(false);
    }
  };

  if (!app) return null;
  const currencyScale = scaleForCurrency(currency.code);
  const currencyFactor = Math.pow(10, currencyScale);
  const expectedDisbursementAmount = app.quote?.totalFinancedAmount ?? 0;
  const expectedDisbursementMinor = Math.round(expectedDisbursementAmount * currencyFactor);
  const expectsFinanceCompanyDisbursement = Boolean(app.companyId && expectedDisbursementMinor > 0);
  const confirmedDisbursementLabel = app.disbursedAmountMinor !== undefined
    ? currency.format(app.disbursedAmountMinor / currencyFactor)
    : null;
  const expectedDisbursementLabel = currency.format(expectedDisbursementMinor / currencyFactor);
  // What the finance company approved to pay for the CAR, which is what it
  // sends the supplier. Absent on deals whose approved amount was never
  // recorded, where showing a confident-looking zero would be worse than
  // saying nothing.
  const expectedSupplierDisbursementLabel =
    app.approvedDealerPurchaseAmountMinor !== undefined
      ? currency.format(app.approvedDealerPurchaseAmountMinor / currencyFactor)
      : t("NotRecorded" as any);
  // A consigned car is the supplier's, so this deal has a settlement route: the
  // finance company's cheque is made out to the dealership or to him, depending
  // on who owns the car. Absent reads as THROUGH_DEALERSHIP, matching the server.
  const isConsignedDeal = app.vehicle?.sourceType === "SOURCED";
  const settlesDirectToSupplier =
    isConsignedDeal && app.supplierSettlementRoute === "DIRECT_TO_SUPPLIER";
  const supplierName = app.vehicle?.sourcedFromName;
  // The route is a decision about a deal that has not posted yet. Once the
  // application closes, the sale has booked either a payable to the supplier or
  // a claim on him, and changing it is a correction rather than an edit — the
  // server refuses it there too.
  //
  // Keyed on FINALIZE_FINANCED_DEAL, matching the server. It was MANAGE_FINANCE,
  // which the default MANAGER and SALES templates do not hold — so the selector
  // was hidden from exactly the people who close these deals and know which way
  // the cheque was made out, and they would finalize with no route recorded.
  const canChooseSettlementRoute =
    canFinalizeApplication &&
    isConsignedDeal &&
    app.status !== "CLOSED" &&
    app.status !== "CANCELLED";

  // On the direct route the company pays the supplier, so there is no
  // dealership receipt to confirm — `confirmDisbursement` posts DR Bank and
  // would invent cash. Offering it would be offering an action the server
  // refuses; the supplier confirmation below is the one that applies.
  const canConfirmDisbursement =
    canConfirmFinanceDisbursement &&
    app.status === "CLOSED" &&
    expectsFinanceCompanyDisbursement &&
    !settlesDirectToSupplier &&
    !app.disbursedAt;

  // Gated on the same facts the server enforces. Without
  // `expectsFinanceCompanyDisbursement` the button appeared on a closed direct
  // deal with no finance company, where the handler returned silently and the
  // server would have refused anyway — a control that looks available and does
  // nothing.
  const canConfirmSupplierDisbursement =
    canConfirmFinanceDisbursement &&
    app.status === "CLOSED" &&
    settlesDirectToSupplier &&
    // The server's own answer, not `companyId`. That field is only ever set on
    // CONFIGURED_FINANCE_COMPANY deals, so gating on it hid this button on
    // every MANUAL_FINANCE_COMPANY deal — a supported external financier —
    // while the server would have accepted the confirmation.
    //
    // Not `expectsFinanceCompanyDisbursement` either: that flag also requires
    // `totalFinancedAmount > 0`, which the server never reads here. The
    // dealership button keeps that flag, because it does compare against it.
    app.canSettleDirectToSupplier &&
    !app.supplierDisbursementConfirmedAt;

  const handleConfirmDisbursement = async () => {
    if (!activeOrgId || !expectedDisbursementMinor) return;
    setIsConfirmingDisbursement(true);
    try {
      confirmDisbursementIdempotencyKeyRef.current ??= `confirm-disbursement:${crypto.randomUUID()}`;
      const idempotencyKey = confirmDisbursementIdempotencyKeyRef.current;
      await confirmDisbursement({
        orgId: activeOrgId,
        applicationId,
        disbursedAmountMinor: expectedDisbursementMinor,
        idempotencyKey,
      });
      confirmDisbursementIdempotencyKeyRef.current = null;
      toast.success(t("DisbursementConfirmedSuccess" as any));
      setIsDisbursementDialogOpen(false);
    } catch {
      toast.error(t("UnexpectedError" as any));
    } finally {
      setIsConfirmingDisbursement(false);
    }
  };
  const handleChooseSettlementRoute = async (route: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER") => {
    if (!activeOrgId) return;
    try {
      await setSupplierSettlementRoute({ orgId: activeOrgId, applicationId, route });
    } catch (error) {
      // MEDIUM-4's refusals live behind this button — no finance company, or a
      // held deposit that has to be settled first. Both name what to do next,
      // and both were being discarded into "an unexpected error occurred".
      toast.error(getErrorMessage(error));
    }
  };

  const handleConfirmSupplierDisbursement = async (advice: {
    amountMajor: number;
    reference?: string;
    disbursedAt?: number;
  }) => {
    if (!activeOrgId) return;
    setIsConfirmingDisbursement(true);
    try {
      confirmSupplierDisbursementIdempotencyKeyRef.current ??= `confirm-supplier-disbursement:${crypto.randomUUID()}`;
      await confirmSupplierDisbursement({
        orgId: activeOrgId,
        applicationId,
        // The advice's own figure, not the dealership's expectation.
        disbursedAmountMinor: Math.round(advice.amountMajor * currencyFactor),
        reference: advice.reference,
        disbursedAt: advice.disbursedAt,
        idempotencyKey: confirmSupplierDisbursementIdempotencyKeyRef.current,
      });
      confirmSupplierDisbursementIdempotencyKeyRef.current = null;
      toast.success(t("SupplierDisbursementConfirmedSuccess" as any));
      setIsSupplierDisbursementDialogOpen(false);
    } catch (error) {
      // The server's refusals here name the amount, the route or the date the
      // operator has to change. Replacing them with "unexpected error" turns a
      // decision point into a dead end.
      toast.error(getErrorMessage(error));
    } finally {
      setIsConfirmingDisbursement(false);
    }
  };

  const applicationDeposits = app.deposits ?? [];
  const pendingDeposits = applicationDeposits.filter((deposit) => deposit.status === "HELD");

  const supplierLabel = supplierName ?? t("TheSupplier" as any);
  const disbursementStatusLabel = (() => {
    if (settlesDirectToSupplier) {
      const key = app.supplierDisbursementConfirmedAt
        ? "SupplierPaidByFinanceCompany"
        : "AwaitingSupplierDisbursement";
      return t(key as any).replace("{supplier}", supplierLabel);
    }
    if (app.disbursedAt) return `${t("DisbursementReceived" as any)} - ${confirmedDisbursementLabel}`;
    return t("AwaitingDisbursement" as any);
  })();
  // A configured company has a row to name; a manual provider has only the name
  // snapshotted at submission; a lease has neither, and says so rather than
  // rendering an empty label beside "Company".
  // `|| undefined` on the trimmed name, not `??`: a whitespace-only provider
  // name is reachable (`saveQuote` applies no trim) and would otherwise render
  // as an empty label beside "Company", while the server's own resolver
  // correctly calls that payer unnamed.
  const financierLabel =
    app.company?.name ||
    app.manualFinanceSnapshot?.providerName?.trim() ||
    t("UnnamedFinanceProvider" as any);
  // The dealership-side disbursement compares against the customer's principal,
  // so it keeps `expectsFinanceCompanyDisbursement`. The supplier-side status is
  // about a payment that never touches that figure, so it must not.
  const showDisbursementStatus = settlesDirectToSupplier || expectsFinanceCompanyDisbursement;
  const showDepositResolution =
    (app.status === "REJECTED" || app.status === "CANCELLED") && pendingDeposits.length > 0;
  const showApplicationDeposits =
    (app.status === "REJECTED" || app.status === "CANCELLED") && applicationDeposits.length > 0;
  const depositStatusLabel = (status: string) => {
    switch (status) {
      case "HELD":
        return t("DepositStatusHeld");
      case "REFUNDED":
        return t("DepositStatusRefunded");
      case "FORFEITED":
        return t("DepositStatusForfeited");
      case "APPLIED":
        return t("DepositStatusApplied");
      default:
        return status;
    }
  };
  const depositStatusClassName = (status: string) => {
    switch (status) {
      case "HELD":
        return "bg-amber-100 text-amber-800";
      case "REFUNDED":
        return "bg-blue-100 text-blue-800";
      case "FORFEITED":
        return "bg-slate-100 text-slate-800";
      default:
        return "bg-emerald-100 text-emerald-800";
    }
  };
  const appStatusLabel = (() => {
    if (showDepositResolution) return t("DepositPending");
    switch (app.status) {
      case "PENDING_DOCS":
        return t("PendingDocs" as any);
      case "UNDER_REVIEW":
        return t("UnderReview" as any);
      case "APPROVED":
        return t("Approved" as any);
      case "REJECTED":
        return t("Rejected" as any);
      case "CLOSED":
        return t("Closed" as any);
      case "CANCELLED":
        return t("Cancelled" as any);
      default:
        return app.status;
    }
  })();
  const pendingResolutionLabel =
    pendingDepositResolution?.resolution === "REFUNDED" ? t("Refund") : t("Forfeit");
  const pendingResolutionConfirmLabel =
    pendingDepositResolution?.resolution === "REFUNDED" ? t("ConfirmRefund") : t("ConfirmForfeit");
  const isResolvingPendingDeposit =
    pendingDepositResolution !== null && resolvingDepositId === pendingDepositResolution.depositId;
  const isCancellable = app.status !== "CANCELLED";
  // Mirror the backend permission tiers exactly:
  // - DRAFT/PENDING_DOCS/UNDER_REVIEW/REJECTED: requires CREATE_FINANCE_APPLICATION
  // - APPROVED: additionally requires APPROVE_FINANCE_APPLICATION
  // - CLOSED: requires FINALIZE_FINANCED_DEAL (same authority as closing the deal)
  const canCancel =
    isCancellable &&
    canCreateApplication &&
    (app.status === "APPROVED" ? canApproveApplication : true) &&
    (app.status === "CLOSED" ? canFinalizeApplication : true);
  const isClosedCancel = app.status === "CLOSED";
  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex justify-between items-start">
            <div>
              <DialogTitle className="text-xl">{t("ApplicationDetails" as any)}</DialogTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {t("SubmittedOn" as any)} {format(app.createdAt, "PP")}
              </p>
            </div>
            <Badge
              variant={showDepositResolution ? "outline" : "default"}
              className={`text-sm px-3 py-1 ${showDepositResolution ? "border-amber-500/60 bg-amber-500/10 text-amber-700" : ""}`}
            >
              {appStatusLabel}
            </Badge>
          </div>
        </DialogHeader>

        {/* Single column below `sm`. This was a hard two-column grid, which on
            a 390px phone left each column around 180px — every label wrapping
            after two or three words. That was survivable while the right column
            only displayed figures; it stopped being survivable when the
            settlement-route control moved in, because the operator now has to
            READ two options and choose between them there. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 my-4">
          <div className="space-y-4">
            <div>
              <h4 className="font-semibold text-sm mb-2">{t("CustomerInfo" as any)}</h4>
              <div className="bg-muted/50 p-3 rounded-lg text-sm">
                <p><strong>{t("Name" as any)}:</strong> {app.customer?.firstName} {app.customer?.lastName}</p>
                <p><strong>{t("NationalID" as any)}:</strong> {app.customer?.nationalId}</p>
                <p><strong>{t("Phone" as any)}:</strong> {app.customer?.phone}</p>
              </div>
            </div>

            <div>
              <h4 className="font-semibold text-sm mb-2">{t("VehicleInfo" as any)}</h4>
              <div className="bg-muted/50 p-3 rounded-lg text-sm">
                <p><strong>{t("Vehicle" as any)}:</strong> {app.vehicle?.year} {app.vehicle?.make} {app.vehicle?.model}</p>
                <p><strong>{t("VIN" as any)}:</strong> {app.vehicle?.vin}</p>
                <p><strong>{t("Price" as any)}:</strong> {app.quote?.vehiclePrice?.toLocaleString()} {t("JOD" as any)}</p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <h4 className="font-semibold text-sm mb-2">{t("FinancingDetails" as any)}</h4>
              <div className="bg-muted/50 p-3 rounded-lg text-sm">
                {/* Branched on the server's own answer, not on `app.company`.
                    That row is null for every MANUAL_FINANCE_COMPANY deal by
                    construction — `quotes.saveQuote` refuses a `companyId` on
                    that mode — so an externally financed deal was labelled
                    "Cash Deal" directly above the control that decides which
                    balance sheet posts, and its disbursement status was hidden
                    entirely. Harmless while the route could not be chosen here;
                    actively misleading now that it can. */}
                {app.hasExternalFinancier ? (
                  <>
                    <p><strong>{t("Company" as any)}:</strong> {financierLabel}</p>
                    <p><strong>{t("DownPayment" as any)}:</strong> {app.quote?.downPayment?.toLocaleString()} {t("JOD" as any)}</p>
                    <p><strong>{t("TermMonths" as any)}:</strong> {app.quote?.termMonths} {t("Months" as any)}</p>
                    <p><strong>{t("MonthlyInstallment" as any)}:</strong> <span className="font-semibold text-primary">{app.quote?.monthlyInstallment?.toLocaleString(undefined, { minimumFractionDigits: 2 })} {t("JOD" as any)}</span></p>
                    {showDisbursementStatus && (
                      <p>
                        <strong>{t("DisbursementStatus" as any)}:</strong>{" "}
                        {disbursementStatusLabel}
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p><strong>{t("FinancingType" as any) || "Type"}:</strong> {t("CashDeal" as any) || "Cash Deal"}</p>
                    <p><strong>{t("TotalAmount" as any) || "Total Amount"}:</strong> <span className="font-semibold text-primary">{app.quote?.vehiclePrice?.toLocaleString(undefined, { minimumFractionDigits: 2 })} {t("JOD" as any)}</span></p>
                  </>
                )}
              </div>
            </div>

            {/* The car is the supplier's, so who the finance company pays is a
                decision this deal cannot infer — and it decides whether the
                dealership ends up owing him his entitlement or holding a claim
                on him for its margin. Asked before finalization, because
                afterwards the sale has already posted one of the two.

                Deliberately NOT the sale form's ConsignedSettlementSection,
                though it duplicates its labels. That component renders nothing
                unless `sales.consignedSalePreview` answers, and that query
                withholds its cost-bearing reply from any role without cost
                visibility — which the default SALES template lacks while
                holding FINALIZE_FINANCED_DEAL. Reusing it hid the control from
                exactly the role the server requires to set it. The duplication
                is the price of a control that does not depend on seeing cost. */}
            {canChooseSettlementRoute && (
              <fieldset className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.04] p-4">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                  {t("SupplierSettlementRoute" as any)}
                </legend>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t("ConsignedSaleSettlementDesc" as any).replace("{supplier}", supplierLabel)}
                </p>
                {/* `role="radio"` elements must be owned by a `radiogroup`;
                    fieldset/legend group them visually but establish no ARIA
                    ownership, so without this they announce as two unrelated
                    radios with no set name. */}
                <div
                  role="radiogroup"
                  aria-label={t("SupplierSettlementRoute" as any)}
                  className="grid gap-2 sm:grid-cols-2"
                >
                  {(
                    [
                      ["THROUGH_DEALERSHIP", "RouteThroughDealership", "RouteThroughDealershipHint"],
                      ["DIRECT_TO_SUPPLIER", "RouteDirectToSupplier", "RouteDirectToSupplierHint"],
                    ] as const
                  ).map(([route, labelKey, hintKey]) => {
                    // Nothing is preselected when no route has been recorded.
                    // Defaulting the control to THROUGH_DEALERSHIP showed it as
                    // already chosen while the server still considered the deal
                    // unanswered, so an operator who wanted it saw no reason to
                    // click and hit the refusal at finalization.
                    const selected = app.supplierSettlementRoute === route;
                    // The direct route needs somebody outside the dealership
                    // who pays the supplier AND who the settlement advice can
                    // name. Shown disabled with the reason rather than hidden:
                    // an operator looking for the option they were told to pick
                    // needs to know why it is not there, and a missing control
                    // answers nothing.
                    const unavailable =
                      route === "DIRECT_TO_SUPPLIER" && !app.canSettleDirectToSupplier;
                    const reasonKey =
                      app.directRouteRefusal === "LEASE"
                        ? "RouteDirectUnavailableLease"
                        : app.directRouteRefusal === "PAYER_UNNAMED"
                          ? "RouteDirectUnavailableUnnamedProvider"
                          : app.directRouteRefusal === "HeldDeposit"
                            ? "RouteDirectUnavailableHeldDeposit"
                            : "RouteDirectUnavailableNoExternalFinancier";
                    return (
                      <button
                        key={route}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={unavailable}
                        onClick={() => handleChooseSettlementRoute(route)}
                        className={`rounded-md border p-3 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60 ${
                          selected
                            ? "border-amber-500 bg-background shadow-sm"
                            : "border-border bg-background/40 enabled:hover:bg-background"
                        }`}
                      >
                        <span className="block text-sm font-medium">{t(labelKey as any)}</span>
                        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                          {t((unavailable ? reasonKey : hintKey) as any)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            )}

            <div>
              <h4 className="font-semibold text-sm mb-2">{t("AppActions" as any)}</h4>
              <div className="flex flex-col gap-2">
                <Button
                  onClick={handleMarkUnderReview}
                  variant="outline"
                  disabled={!canReviewApplication || app.status !== "PENDING_DOCS"}
                >
                  {t("MarkUnderReview" as any)}
                </Button>

                {canApproveApplication && (
                    <Button
                      onClick={handleApproveApp}
                      className="bg-green-600 hover:bg-green-700 text-white"
                      disabled={app.status === "APPROVED" || app.status === "CLOSED" || app.status === "CANCELLED"}
                    >
                      {t("ApproveApplication" as any)}
                    </Button>
                )}

                {canReviewApplication && (
                    <Button
                      onClick={handleRejectApp}
                      variant="destructive"
                      disabled={app.status === "REJECTED" || app.status === "CLOSED" || app.status === "CANCELLED"}
                    >
                      {t("RejectApplication" as any)}
                    </Button>
                )}

                {app.status === "APPROVED" && (
                  <>
                    {app.vehicleHandoverAt ? (
                      <Badge variant="outline" className="justify-center py-2 border-orange-500/40 text-orange-600">
                        {t("VehicleHandoverRegistered" as any)}
                      </Badge>
                    ) : (
                      canRegisterHandover && (
                        <VehicleHandoverDialog
                          open={isHandoverDialogOpen}
                          disabled={isRegisteringHandover}
                          submitting={isRegisteringHandover}
                          t={(key) => t(key as any)}
                          onOpenChange={setIsHandoverDialogOpen}
                          onConfirm={handleRegisterHandover}
                        />
                      )
                    )}

                    {app.expectedPaymentMethod ? (
                      <Badge variant="outline" className="justify-center py-2 border-indigo-500/40 text-indigo-600">
                        {t("ExpectedPaymentRegistered" as any)}
                      </Badge>
                    ) : (
                      canRegisterExpectedPayment && (
                        <RegisterExpectedPaymentDialog
                          open={isPaymentDialogOpen}
                          disabled={isRegisteringPayment || !app.vehicleHandoverAt}
                          submitting={isRegisteringPayment}
                          t={(key) => t(key as any)}
                          onOpenChange={setIsPaymentDialogOpen}
                          onConfirm={handleRegisterExpectedPayment}
                        />
                      )
                    )}
                  </>
                )}

                {app.status === "APPROVED" && canFinalizeApplication && (
                  <>
                    <Button
                      onClick={handleFinalizeDeal}
                      className="bg-blue-600 hover:bg-blue-700 text-white mt-2"
                      disabled={!app.vehicleHandoverAt || !app.expectedPaymentMethod}
                    >
                      {t("FinalizeDealClose" as any)}
                    </Button>
                    {!app.vehicleHandoverAt ? (
                      <p className="text-xs text-muted-foreground text-center">{t("FinalizeBlockedHandoverHint" as any)}</p>
                    ) : !app.expectedPaymentMethod ? (
                      <p className="text-xs text-muted-foreground text-center">{t("FinalizeBlockedPaymentHint" as any)}</p>
                    ) : null}
                  </>
                )}

                {expectsFinanceCompanyDisbursement && app.status === "CLOSED" && app.disbursedAt && (
                  <Badge variant="outline" className="justify-center py-2">
                    {t("DisbursementReceived" as any)}: {confirmedDisbursementLabel}
                  </Badge>
                )}

                {canConfirmDisbursement && (
                  <DisbursementConfirmationDialog
                    open={isDisbursementDialogOpen}
                    disabled={isConfirmingDisbursement}
                    submitting={isConfirmingDisbursement}
                    amountLabel={expectedDisbursementLabel}
                    t={(key) => t(key as any)}
                    onOpenChange={setIsDisbursementDialogOpen}
                    onConfirm={handleConfirmDisbursement}
                  />
                )}

                {/* The direct route's counterpart. Deliberately a separate
                    action rather than the same button behaving differently:
                    this one records that somebody ELSE was paid, moves no
                    dealership money, and posts no journal. Collapsing the two
                    would make "confirm the disbursement" mean two different
                    things depending on a field further up the screen. */}
                {settlesDirectToSupplier && app.status === "CLOSED" && app.supplierDisbursementConfirmedAt && (
                  <Badge variant="outline" className="justify-center py-2">
                    {t("SupplierPaidByFinanceCompany" as any).replace("{supplier}", supplierLabel)}
                  </Badge>
                )}

                {canConfirmSupplierDisbursement && (
                  <DisbursementConfirmationDialog
                    mode="SUPPLIER"
                    supplierName={supplierName}
                    open={isSupplierDisbursementDialogOpen}
                    disabled={isConfirmingDisbursement}
                    submitting={isConfirmingDisbursement}
                    // The same figure the field is prefilled with. This label
                    // was showing `totalFinancedAmount` — the customer's
                    // principal — beside a prefill deliberately taken from the
                    // approved purchase amount, so on any deal with a down
                    // payment the dialog stated one number and offered another,
                    // inviting the operator to "correct" the right one to the
                    // wrong one.
                    amountLabel={expectedSupplierDisbursementLabel}
                    // Prefilled from what the company APPROVED to pay for the
                    // car, which is the figure the advice should carry — not
                    // `totalFinancedAmount`, the customer's principal, which
                    // differs by the down payment on every deal that has one.
                    defaultAmountMajor={
                      app.approvedDealerPurchaseAmountMinor !== undefined
                        ? app.approvedDealerPurchaseAmountMinor / currencyFactor
                        : undefined
                    }
                    t={(key) => t(key as any)}
                    onOpenChange={setIsSupplierDisbursementDialogOpen}
                    onConfirm={() => undefined}
                    onConfirmSupplier={handleConfirmSupplierDisbursement}
                  />
                )}

                {canCancel && (
                  <Button
                    onClick={() => setIsCancelDialogOpen(true)}
                    variant="outline"
                    className="text-destructive hover:text-destructive mt-2"
                  >
                    <Ban className="h-4 w-4 me-2" />
                    {t("CancelApplication" as any)}
                  </Button>
                )}

                {showApplicationDeposits && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-amber-700">
                      <HandCoins className="h-4 w-4" />
                      {showDepositResolution ? t("DepositPending") : t("ApplicationDeposits")}
                    </div>

                    <div className="space-y-2">
                      {applicationDeposits.map((deposit) => {
                        const isHeld = deposit.status === "HELD";

                        return (
                          <div key={deposit._id} className="rounded-md border bg-background p-2 text-sm space-y-2">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="font-medium">{currency.format(deposit.amount)}</p>
                                {deposit.method && (
                                  <p className="text-xs text-muted-foreground">{deposit.method}</p>
                                )}
                              </div>
                              <span
                                className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${depositStatusClassName(deposit.status)}`}
                              >
                                {depositStatusLabel(deposit.status)}
                              </span>
                            </div>

                            {isHeld && canResolveDeposits && (
                              <div className="grid grid-cols-2 gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={resolvingDepositId === deposit._id}
                                  onClick={() =>
                                    setPendingDepositResolution({
                                      depositId: deposit._id,
                                      amount: deposit.amount,
                                      resolution: "REFUNDED",
                                    })
                                  }
                                >
                                  <Undo2 className="h-3.5 w-3.5 me-1.5" />
                                  {t("Refund")}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-destructive hover:text-destructive"
                                  disabled={resolvingDepositId === deposit._id}
                                  onClick={() =>
                                    setPendingDepositResolution({
                                      depositId: deposit._id,
                                      amount: deposit.amount,
                                      resolution: "FORFEITED",
                                    })
                                  }
                                >
                                  <XCircle className="h-3.5 w-3.5 me-1.5" />
                                  {t("Forfeit")}
                                </Button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <Separator />

        <div className="my-4">
          <h4 className="font-semibold text-lg mb-4">{t("RequiredDocuments" as any)}</h4>
          <div className="space-y-3">
            {documents && documents.length > 0 ? (
              <div className="space-y-3">
                {documents.map((doc) => {
                  const status = doc.status;
                  const existingDoc = doc;
                  const rule = { _id: doc._id };
                  const handleSimulateUpload = (ruleId: any) => { };

                  return (
                    <div key={doc._id} className="flex items-center justify-between p-3 border rounded-lg bg-card">
                      <div className="flex flex-col">
                        <span className="font-medium">{doc.ruleName}</span>
                        <div className="flex items-center gap-2">
                          {status === "MISSING" && <Clock className="h-4 w-4 text-orange-500" />}
                          {status === "UPLOADED" && <Upload className="h-4 w-4 text-blue-500" />}
                          {status === "VERIFIED" && <CheckCircle className="h-4 w-4 text-green-500" />}
                          {status === "REJECTED" && <XCircle className="h-4 w-4 text-red-500" />}
                          <span className="text-sm font-medium">
                            {status === "MISSING" ? (t("DocMissing" as any)) :
                              status === "UPLOADED" ? (t("DocUploaded" as any)) :
                                status === "VERIFIED" ? (t("DocVerified" as any)) :
                                  (t("DocRejected" as any))}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {doc.fileUrl ? (
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setPreviewFile({ url: doc.fileUrl!, name: doc.ruleName })}
                            >
                              <Eye className="h-4 w-4 me-1" />
                              {t("ViewFile" as any)}
                            </Button>
                            {canVerifyDocuments && (
                              <Button
                                size="sm"
                                variant="default"
                                onClick={() => updateDocStatus({ orgId: activeOrgId!, documentId: doc._id, status: "VERIFIED" })}
                                disabled={status === "VERIFIED"}
                              >
                                {t("Verify" as any)}
                              </Button>
                            )}
                          </div>
                        ) : (
                          <div>
                            <input
                              type="file"
                              id={`file-${doc._id}`}
                              className="hidden"
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleUpload(doc._id as any, file);
                              }}
                            />
                            <label htmlFor={`file-${doc._id}`}>
                              <Button
                                size="sm"
                                asChild
                              >
                                <span className="cursor-pointer">
                                  <Upload className="h-4 w-4 me-2" />
                                  {t("Upload" as any)}
                                </span>
                              </Button>
                            </label>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("NoDocsRequired" as any)}</p>
            )}
          </div>
        </div>

        <Separator />

        <div className="my-4">
          <h4 className="font-semibold text-lg mb-4 flex items-center gap-2">
            <History className="h-4 w-4" />
            {t("StatusHistory" as any)}
          </h4>
          {statusLog && statusLog.length > 0 ? (
            <div className="relative border-s-2 border-muted ps-4 space-y-4">
              {statusLog.map((entry) => (
                <div key={entry._id} className="relative">
                  <div className="absolute -start-[1.35rem] top-1 w-3 h-3 rounded-full bg-primary border-2 border-background" />
                  <div className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      {entry.fromStatus && (
                        <span className="text-xs text-muted-foreground">{entry.fromStatus}</span>
                      )}
                      {entry.fromStatus && <span className="text-xs text-muted-foreground">→</span>}
                      <span className="text-sm font-semibold">{entry.toStatus}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {entry.changedByName} · {format(entry.changedAt, "PP p")}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("NoStatusHistory" as any)}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>

      {/* Deposit Resolution Confirmation Dialog */}
      <Dialog
        open={pendingDepositResolution !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !isResolvingPendingDeposit) {
            setPendingDepositResolution(null);
            setRefundMethod("CASH");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("ConfirmDepositResolution")}</DialogTitle>
            <DialogDescription>{t("DepositResolutionConfirmDesc")}</DialogDescription>
          </DialogHeader>
          {pendingDepositResolution && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-2">
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">{t("DepositResolutionAmount")}</span>
                <span className="font-medium">{currency.format(pendingDepositResolution.amount)}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">{t("DepositResolutionOutcome")}</span>
                <span className="font-medium">{pendingResolutionLabel}</span>
              </div>
            </div>
          )}
          {pendingDepositResolution?.resolution === "REFUNDED" && (
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("PaymentMethodLabel" as any)}</label>
              <PaymentMethodSelect t={t as any} value={refundMethod} onValueChange={setRefundMethod} />
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              disabled={isResolvingPendingDeposit}
              onClick={() => {
                setPendingDepositResolution(null);
                setRefundMethod("CASH");
              }}
            >
              {t("Cancel")}
            </Button>
            {pendingDepositResolution && (
              <Button
                variant={pendingDepositResolution.resolution === "FORFEITED" ? "destructive" : "default"}
                disabled={isResolvingPendingDeposit}
                onClick={() =>
                  handleResolveDeposit(
                    pendingDepositResolution.depositId,
                    pendingDepositResolution.resolution
                  )
                }
              >
                {pendingResolutionConfirmLabel}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel Application Confirmation Dialog */}
      <Dialog open={isCancelDialogOpen} onOpenChange={setIsCancelDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("ConfirmCancelApplication" as any)}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {isClosedCancel ? t("CancelClosedApplicationWarning" as any) : t("CancelApplicationWarning" as any)}
          </p>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("CancellationReasonLabel" as any)}</label>
            <Textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder={t("CancellationReasonPlaceholder" as any)}
              rows={3}
            />
          </div>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="outline" onClick={() => setIsCancelDialogOpen(false)}>
              {t("KeepApplication" as any)}
            </Button>
            <Button variant="destructive" onClick={handleCancelApplication}>
              {t("CancelApplication" as any)}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Document Preview Dialog */}
      <Dialog open={!!previewFile} onOpenChange={(o) => { if (!o) setPreviewFile(null); }}>
        <DialogContent className="max-w-4xl max-h-[95vh] p-0 overflow-hidden">
          <DialogHeader className="flex flex-row items-center justify-between px-6 py-4 border-b">
            <DialogTitle className="text-base truncate">{previewFile?.name}</DialogTitle>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" asChild>
                <a href={previewFile?.url || "#"} download target="_blank" rel="noreferrer">
                  <Download className="h-4 w-4 me-1" />
                  {t("Download" as any) || "Download"}
                </a>
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPreviewFile(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </DialogHeader>
          <div className="flex items-center justify-center bg-[#0a0a0a] min-h-[60vh] max-h-[80vh] overflow-auto p-4">
            {previewFile?.url?.match(/\.pdf/i) ? (
              <iframe
                src={previewFile.url}
                className="w-full h-[75vh] rounded"
                title={previewFile.name}
              />
            ) : (
              <img
                src={previewFile?.url || ""}
                alt={previewFile?.name || "Preview"}
                className="max-w-full max-h-[75vh] object-contain rounded shadow-lg"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
