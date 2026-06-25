"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { toast } from "@/components/ui/sonner";
import { Separator } from "@/components/ui/separator";
import { Upload, CheckCircle, XCircle, Clock, Eye, X, Download } from "lucide-react";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";

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
  const isManager = hasPermission(PERMISSIONS.MANAGE_SETTINGS);
  const [previewFile, setPreviewFile] = useState<{ url: string; name: string } | null>(null);

  const app = useQuery(api.applications.get, activeOrgId ? { orgId: activeOrgId, applicationId } : "skip");
  const documents = useQuery(api.documents.getForApplication, activeOrgId ? { orgId: activeOrgId, applicationId } : "skip");

  const updateStatus = useMutation(api.applications.updateStatus);
  const finalizeDeal = useMutation(api.applications.finalizeDeal);
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
    } catch (err: any) {
      toast.error(err);
    }
  };

  const handleApproveApp = async () => {
    if (!activeOrgId) return;
    try {
      await updateStatus({ orgId: activeOrgId, applicationId, status: "APPROVED" });
      toast.success(t("AppApprovedSuccess" as any));
    } catch (err: any) {
      toast.error(err);
    }
  };

  const handleFinalizeDeal = async () => {
    if (!activeOrgId) return;
    try {
      await finalizeDeal({ orgId: activeOrgId, applicationId });
      toast.success(t("DealFinalizedSuccess" as any));
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err);
    }
  };

  if (!app) return null;
  const appStatusLabel =
    app.status === "PENDING_DOCS" ? t("PendingDocs" as any) :
      app.status === "UNDER_REVIEW" ? t("UnderReview" as any) :
        app.status === "APPROVED" ? t("Approved" as any) :
          app.status === "REJECTED" ? t("Rejected" as any) :
            app.status === "CLOSED" ? t("Closed" as any) :
              app.status;
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
                  onClick={() => updateStatus({ orgId: activeOrgId!, applicationId, status: "UNDER_REVIEW" })}
                  variant="outline"
                  disabled={app.status !== "PENDING_DOCS"}
                >
                  {t("MarkUnderReview" as any)}
                </Button>

                {isManager && (
                  <>
                    <Button
                      onClick={handleApproveApp}
                      className="bg-green-600 hover:bg-green-700 text-white"
                      disabled={app.status === "APPROVED" || app.status === "CLOSED"}
                    >
                      {t("ApproveApplication" as any)}
                    </Button>
                    <Button
                      onClick={() => updateStatus({ orgId: activeOrgId!, applicationId, status: "REJECTED" })}
                      variant="destructive"
                      disabled={app.status === "REJECTED" || app.status === "CLOSED"}
                    >
                      {t("RejectApplication" as any)}
                    </Button>
                  </>
                )}

                {app.status === "APPROVED" && (
                  <Button
                    onClick={handleFinalizeDeal}
                    className="bg-blue-600 hover:bg-blue-700 text-white mt-2"
                  >
                    {t("FinalizeDealClose" as any)}
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
                            {isManager && (
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
