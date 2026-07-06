"use client";

import { useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { format } from "date-fns";
import { toast } from "@/components/ui/sonner";
import { Separator } from "@/components/ui/separator";
import { Upload, CheckCircle, XCircle, Clock, Eye, X, Download, History, Ban } from "lucide-react";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { useCurrency } from "@/hooks/useCurrency";
import { scaleForCurrency } from "@/components/accounting/AccountingTabShared";
import { DisbursementConfirmationDialog } from "./DisbursementConfirmationDialog";
import { VehicleHandoverDialog } from "./VehicleHandoverDialog";
import { RegisterExpectedPaymentDialog, type ExpectedPaymentMethod } from "./RegisterExpectedPaymentDialog";

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
  const [previewFile, setPreviewFile] = useState<{ url: string; name: string } | null>(null);
  const [isCancelDialogOpen, setIsCancelDialogOpen] = useState(false);
  const [isDisbursementDialogOpen, setIsDisbursementDialogOpen] = useState(false);
  const [isConfirmingDisbursement, setIsConfirmingDisbursement] = useState(false);
  const [isHandoverDialogOpen, setIsHandoverDialogOpen] = useState(false);
  const [isRegisteringHandover, setIsRegisteringHandover] = useState(false);
  const [isPaymentDialogOpen, setIsPaymentDialogOpen] = useState(false);
  const [isRegisteringPayment, setIsRegisteringPayment] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const finalizeDealIdempotencyKeyRef = useRef<string | null>(null);
  const cancelApplicationIdempotencyKeyRef = useRef<string | null>(null);
  const confirmDisbursementIdempotencyKeyRef = useRef<string | null>(null);

  const app = useQuery(api.applications.get, activeOrgId ? { orgId: activeOrgId, applicationId } : "skip");
  const documents = useQuery(api.documents.getForApplication, activeOrgId ? { orgId: activeOrgId, applicationId } : "skip");
  const statusLog = useQuery(api.applications.getLog, activeOrgId ? { orgId: activeOrgId, applicationId } : "skip");

  const updateStatus = useMutation(api.applications.updateStatus);
  const cancelApplication = useMutation(api.applications.cancelApplication);
  const finalizeDeal = useMutation(api.applications.finalizeDeal);
  const confirmDisbursement = useMutation(api.applications.confirmDisbursement);
  const registerVehicleHandover = useMutation(api.applications.registerVehicleHandover);
  const registerExpectedPayment = useMutation(api.applications.registerExpectedPayment);
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
    } catch {
      toast.error(t("UnexpectedError" as any));
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
  const canConfirmDisbursement =
    canConfirmFinanceDisbursement &&
    app.status === "CLOSED" &&
    expectsFinanceCompanyDisbursement &&
    !app.disbursedAt;

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
  const appStatusLabel =
    app.status === "PENDING_DOCS" ? t("PendingDocs" as any) :
      app.status === "UNDER_REVIEW" ? t("UnderReview" as any) :
        app.status === "APPROVED" ? t("Approved" as any) :
          app.status === "REJECTED" ? t("Rejected" as any) :
            app.status === "CLOSED" ? t("Closed" as any) :
              app.status === "CANCELLED" ? t("Cancelled" as any) :
                app.status;
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
            <Badge className="text-sm px-3 py-1">
              {appStatusLabel}
            </Badge>          </div>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-6 my-4">
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
                {app.company ? (
                  <>
                    <p><strong>{t("Company" as any)}:</strong> {app.company.name}</p>
                    <p><strong>{t("DownPayment" as any)}:</strong> {app.quote?.downPayment?.toLocaleString()} {t("JOD" as any)}</p>
                    <p><strong>{t("TermMonths" as any)}:</strong> {app.quote?.termMonths} {t("Months" as any)}</p>
                    <p><strong>{t("MonthlyInstallment" as any)}:</strong> <span className="font-semibold text-primary">{app.quote?.monthlyInstallment?.toLocaleString(undefined, { minimumFractionDigits: 2 })} {t("JOD" as any)}</span></p>
                    {expectsFinanceCompanyDisbursement && (
                      <p>
                        <strong>{t("DisbursementStatus" as any)}:</strong>{" "}
                        {app.disbursedAt
                          ? `${t("DisbursementReceived" as any)} - ${confirmedDisbursementLabel}`
                          : t("AwaitingDisbursement" as any)}
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
