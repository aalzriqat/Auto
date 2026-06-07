"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
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
      toast.success("Document uploaded successfully");
    } catch (err: any) {
      toast.error("Upload failed");
    }
  };

  const handleApproveApp = async () => {
    if (!activeOrgId) return;
    try {
      await updateStatus({ orgId: activeOrgId, applicationId, status: "APPROVED" });
      toast.success("Application Approved!");
    } catch (err: any) {
      toast.error(err.message || "Failed to approve application");
    }
  };

  const handleFinalizeDeal = async () => {
    if (!activeOrgId) return;
    try {
      await finalizeDeal({ orgId: activeOrgId, applicationId });
      toast.success("Deal Finalized successfully! Sale record created.");
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
              <DialogTitle className="text-xl">Application Details</DialogTitle>
              <p className="text-sm text-muted-foreground mt-1">
                Submitted on {format(app.createdAt, "PP")}
              </p>
            </div>
            <Badge className="text-sm px-3 py-1">{app.status}</Badge>
          </div>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-6 my-4">
          <div className="space-y-4">
            <div>
              <h4 className="font-semibold text-sm mb-2">Customer Info</h4>
              <div className="bg-muted/50 p-3 rounded-lg text-sm">
                <p><strong>Name:</strong> {app.customer?.firstName} {app.customer?.lastName}</p>
                <p><strong>National ID:</strong> {app.customer?.nationalId}</p>
                <p><strong>Phone:</strong> {app.customer?.phone}</p>
              </div>
            </div>

            <div>
              <h4 className="font-semibold text-sm mb-2">Vehicle Info</h4>
              <div className="bg-muted/50 p-3 rounded-lg text-sm">
                <p><strong>Vehicle:</strong> {app.vehicle?.year} {app.vehicle?.make} {app.vehicle?.model}</p>
                <p><strong>VIN:</strong> {app.vehicle?.vin}</p>
                <p><strong>Price:</strong> {app.quote?.vehiclePrice?.toLocaleString()} JOD</p>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <h4 className="font-semibold text-sm mb-2">Financing Details</h4>
              <div className="bg-muted/50 p-3 rounded-lg text-sm">
                <p><strong>Company:</strong> {app.company?.name || "Direct"}</p>
                <p><strong>Down Payment:</strong> {app.quote?.downPayment?.toLocaleString()} JOD</p>
                <p><strong>Term:</strong> {app.quote?.termMonths} Months</p>
                <p><strong>Monthly Installment:</strong> <span className="font-semibold text-primary">{app.quote?.monthlyInstallment?.toLocaleString(undefined, {minimumFractionDigits: 2})} JOD</span></p>
              </div>
            </div>

            <div>
              <h4 className="font-semibold text-sm mb-2">Actions</h4>
              <div className="flex flex-col gap-2">
                <Button 
                  onClick={() => updateStatus({ orgId: activeOrgId!, applicationId, status: "UNDER_REVIEW" })}
                  variant="outline"
                  disabled={app.status !== "PENDING_DOCS"}
                >
                  Mark Under Review
                </Button>
                <Button 
                  onClick={handleApproveApp}
                  className="bg-green-600 hover:bg-green-700 text-white"
                  disabled={app.status === "APPROVED" || app.status === "CLOSED"}
                >
                  Approve Application
                </Button>
                {app.status === "APPROVED" && (
                  <Button 
                    onClick={handleFinalizeDeal}
                    className="bg-blue-600 hover:bg-blue-700 text-white mt-2"
                  >
                    Finalize Deal (Close)
                  </Button>
                )}
                <Button 
                  onClick={() => updateStatus({ orgId: activeOrgId!, applicationId, status: "REJECTED" })}
                  variant="destructive"
                  disabled={app.status === "REJECTED" || app.status === "CLOSED"}
                >
                  Reject Application
                </Button>
              </div>
            </div>
          </div>
        </div>

        <Separator />

        <div className="mt-4">
          <h4 className="font-semibold text-lg mb-4">Required Documents</h4>
          <div className="space-y-3">
            {documents?.map((doc) => (
              <div key={doc._id} className="flex items-center justify-between p-3 border rounded-lg bg-card">
                <div className="flex flex-col">
                  <span className="font-medium flex items-center gap-2">
                    {doc.ruleName}
                    {doc.isRequired && <Badge variant="destructive" className="text-[10px] h-4">Required</Badge>}
                  </span>
                  <div className="flex items-center gap-2 mt-1">
                    {doc.status === "MISSING" && <Badge variant="outline" className="text-orange-600 border-orange-200 bg-orange-50"><Clock className="w-3 h-3 mr-1" /> Missing</Badge>}
                    {doc.status === "UPLOADED" && <Badge variant="outline" className="text-blue-600 border-blue-200 bg-blue-50">Uploaded</Badge>}
                    {doc.status === "VERIFIED" && <Badge variant="outline" className="text-green-600 border-green-200 bg-green-50"><CheckCircle className="w-3 h-3 mr-1" /> Verified</Badge>}
                    {doc.status === "REJECTED" && <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50"><XCircle className="w-3 h-3 mr-1" /> Rejected</Badge>}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {doc.fileUrl ? (
                    <Button variant="outline" size="sm" onClick={() => window.open(doc.fileUrl!, "_blank")}>
                      View File
                    </Button>
                  ) : (
                    <div>
                      <input
                        type="file"
                        id={`file-${doc._id}`}
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleUpload(doc._id, file);
                        }}
                      />
                      <label htmlFor={`file-${doc._id}`}>
                        <Button variant="outline" size="sm" asChild>
                          <span className="cursor-pointer">
                            <Upload className="w-4 h-4 mr-2" />
                            Upload
                          </span>
                        </Button>
                      </label>
                    </div>
                  )}

                  {doc.status === "UPLOADED" && (
                    <>
                      <Button 
                        variant="ghost" 
                        size="sm"
                        className="text-green-600"
                        onClick={() => updateDocStatus({ orgId: activeOrgId!, documentId: doc._id, status: "VERIFIED" })}
                      >
                        <CheckCircle className="w-4 h-4" />
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="sm"
                        className="text-red-600"
                        onClick={() => updateDocStatus({ orgId: activeOrgId!, documentId: doc._id, status: "REJECTED", rejectionReason: "Invalid document" })}
                      >
                        <XCircle className="w-4 h-4" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {documents?.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No documents required for this application.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
