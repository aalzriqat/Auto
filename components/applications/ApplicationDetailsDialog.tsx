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
import { toast } from "sonner";
import { Separator } from "@/components/ui/separator";
import { Upload, CheckCircle, XCircle, Clock } from "lucide-react";

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
      const postUrl = await generateUploadUrl({ orgId: activeOrgId });
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
      toast.success(t("UploadSuccess" as any) || "Document uploaded successfully");
    } catch (err: any) {
      toast.error(err.message || t("UploadFail" as any) || "Upload failed");
    }
  };

  const handleApproveApp = async () => {
    if (!activeOrgId) return;
    try {
      await updateStatus({ orgId: activeOrgId, applicationId, status: "APPROVED" });
      toast.success(t("AppApprovedSuccess" as any) || "Application Approved!");
    } catch (err: any) {
      toast.error(err.message || "Failed to approve application");
    }
  };

  const handleFinalizeDeal = async () => {
    if (!activeOrgId) return;
    try {
      await finalizeDeal({ orgId: activeOrgId, applicationId });
      toast.success(t("DealFinalizedSuccess" as any) || "Deal Finalized successfully! Sale record created.");
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message || "Failed to finalize deal");
    }
  };

  if (!app) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex justify-between items-start">
            <div>
              <DialogTitle className="text-xl">{t("ApplicationDetails" as any) || "Application Details"}</DialogTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {t("SubmittedOn" as any) || "Submitted on"} {format(app.createdAt, "PP")}
              </p>
            </div>
            <Badge className="text-sm px-3 py-1">{app.status}</Badge>
          </div>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-6 my-4">
          <div className="space-y-4">
            <div>
              <h4 className="font-semibold text-sm mb-2">{t("CustomerInfo" as any) || "Customer Info"}</h4>
              <div className="bg-muted/50 p-3 rounded-lg text-sm">
                <p><strong>{t("Name" as any) || "Name"}:</strong> {app.customer?.firstName} {app.customer?.lastName}</p>
                <p><strong>{t("NationalID" as any) || "National ID"}:</strong> {app.customer?.nationalId}</p>
                <p><strong>{t("Phone" as any) || "Phone"}:</strong> {app.customer?.phone}</p>
              </div>
            </div>

            <div>
              <h4 className="font-semibold text-sm mb-2">{t("VehicleInfo" as any) || "Vehicle Info"}</h4>
              <div className="bg-muted/50 p-3 rounded-lg text-sm">
                <p><strong>{t("Vehicle" as any) || "Vehicle"}:</strong> {app.vehicle?.year} {app.vehicle?.make} {app.vehicle?.model}</p>
                <p><strong>{t("VIN" as any) || "VIN"}:</strong> {app.vehicle?.vin}</p>
                <p><strong>{t("Price" as any) || "Price"}:</strong> {app.quote?.vehiclePrice?.toLocaleString()} {t("JOD" as any) || "JOD"}</p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <h4 className="font-semibold text-sm mb-2">{t("FinancingDetails" as any) || "Financing Details"}</h4>
              <div className="bg-muted/50 p-3 rounded-lg text-sm">
                <p><strong>{t("Company" as any) || "Company"}:</strong> {app.company?.name || "Direct"}</p>
                <p><strong>{t("DownPayment" as any) || "Down Payment"}:</strong> {app.quote?.downPayment?.toLocaleString()} {t("JOD" as any) || "JOD"}</p>
                <p><strong>{t("TermMonths" as any) || "Term"}:</strong> {app.quote?.termMonths} {t("Months" as any) || "Months"}</p>
                <p><strong>{t("MonthlyInstallment" as any) || "Monthly Installment"}:</strong> <span className="font-semibold text-primary">{app.quote?.monthlyInstallment?.toLocaleString(undefined, {minimumFractionDigits: 2})} {t("JOD" as any) || "JOD"}</span></p>
              </div>
            </div>

            <div>
              <h4 className="font-semibold text-sm mb-2">{t("AppActions" as any) || "Actions"}</h4>
              <div className="flex flex-col gap-2">
                  <Button 
                  onClick={() => updateStatus({ orgId: activeOrgId!, applicationId, status: "UNDER_REVIEW" })}
                  variant="outline"
                  disabled={app.status !== "PENDING_DOCS"}
                >
                  {t("MarkUnderReview" as any) || "Mark Under Review"}
                </Button>
                <Button 
                  onClick={handleApproveApp}
                  className="bg-green-600 hover:bg-green-700 text-white"
                  disabled={app.status === "APPROVED" || app.status === "CLOSED"}
                >
                  {t("ApproveApplication" as any) || "Approve Application"}
                </Button>
                {app.status === "APPROVED" && (
                  <Button 
                    onClick={handleFinalizeDeal}
                    className="bg-blue-600 hover:bg-blue-700 text-white mt-2"
                  >
                    {t("FinalizeDealClose" as any) || "Finalize Deal (Close)"}
                  </Button>
                )}
                <Button 
                  onClick={() => updateStatus({ orgId: activeOrgId!, applicationId, status: "REJECTED" })}
                  variant="destructive"
                  disabled={app.status === "REJECTED" || app.status === "CLOSED"}
                >
                  {t("RejectApplication" as any) || "Reject Application"}
                </Button>
              </div>
            </div>
          </div>
        </div>

        <Separator />

        <div className="my-4">
          <h4 className="font-semibold text-lg mb-4">{t("RequiredDocuments" as any) || "Required Documents"}</h4>
          <div className="space-y-3">
            {documents && documents.length > 0 ? (
              <div className="space-y-3">
                {documents.map((doc) => {
                  const status = doc.status;
                  const existingDoc = doc;
                  const rule = { _id: doc._id };
                  const handleSimulateUpload = (ruleId: any) => {};

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
                            {status === "MISSING" ? (t("DocMissing" as any) || "Missing") : 
                             status === "UPLOADED" ? (t("DocUploaded" as any) || "Uploaded") : 
                             status === "VERIFIED" ? (t("DocVerified" as any) || "Verified") : 
                             (t("DocRejected" as any) || "Rejected")}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {doc.fileUrl ? (
                          <div className="flex gap-2">
                            <Button size="sm" variant="outline" asChild>
                              <a href={doc.fileUrl || "#"} target="_blank" rel="noreferrer">{t("ViewFile" as any) || "View File"}</a>
                            </Button>
                            <Button 
                              size="sm" 
                              variant="default"
                              onClick={() => updateDocStatus({ orgId: activeOrgId!, documentId: doc._id, status: "VERIFIED" })}
                              disabled={status === "VERIFIED"}
                            >
                              {t("DocVerified" as any) || "Verify"}
                            </Button>
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
                                  <Upload className="h-4 w-4 mr-2" />
                                  {t("Upload" as any) || "Upload"}
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
              <p className="text-sm text-muted-foreground">{t("NoDocsRequired" as any) || "No documents required for this application."}</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
