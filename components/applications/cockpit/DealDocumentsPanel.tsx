"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Check, Download, Eye, FileText, Upload, X } from "lucide-react";

/**
 * A document as `documents.getForApplication` serves it: the per-deal row with
 * its rule name, status and a signed file URL when a file is on it. The same
 * query the Finance Applications → Review dialog reads.
 */
export type DealDocument = {
  _id: string;
  ruleName: string;
  status: string;
  fileUrl: string | null;
};

/**
 * The document checklist that also DOES something.
 *
 * The cockpit used to list the required documents read-only and point the
 * operator at Review to upload or verify them. Upload, verify and preview now
 * live here, on the same `documents.*` mutations Review calls — the caller
 * moved, the authority did not.
 *
 * Three states are distinguished rather than collapsed:
 *  - `documents` undefined while loading, or when this caller lacks
 *    `view:finance_applications` (the query is skipped rather than thrown);
 *    then the read-only checklist from the cockpit payload is shown instead;
 *  - an empty list, which the server states as "no documents required";
 *  - a list, each row carrying exactly the controls this caller may use.
 */
export function DealDocumentsPanel({
  documents,
  checklist,
  canUpload,
  canVerify,
  uploadingId,
  t,
  onUpload,
  onVerify,
}: Readonly<{
  documents: ReadonlyArray<DealDocument> | undefined;
  /** The cockpit payload's read-only checklist, the fallback when `documents` is withheld. */
  checklist: ReadonlyArray<{ ruleId: string; name: string; required: boolean; status: string }>;
  canUpload: boolean;
  canVerify: boolean;
  uploadingId: string | null;
  t: (key: string) => string;
  onUpload: (documentId: string, file: File) => void | Promise<void>;
  onVerify: (documentId: string) => void | Promise<void>;
}>) {
  const [previewFile, setPreviewFile] = useState<{ url: string; name: string } | null>(null);

  const statusLabel = (status: string) =>
    status === "MISSING"
      ? t("DocMissing")
      : status === "UPLOADED"
        ? t("DocUploaded")
        : status === "VERIFIED"
          ? t("DocVerified")
          : status === "REJECTED"
            ? t("DocRejected")
            : status === "WAIVED"
              ? t("DocWaived")
              : status;

  if (documents === undefined) {
    // Withheld or loading: the checklist the rail already reads, with no
    // controls. ABSENT entirely when there is nothing to list — an empty card
    // would invite an operator to look for an upload control that is not
    // there for them.
    if (checklist.length === 0) return null;
    return (
      <Card data-testid="deal-documents">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("DocumentsHeading")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {checklist.map((doc) => (
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
    );
  }

  return (
    <>
      <Card data-testid="deal-documents">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("DocumentsHeading")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("NoDocsRequired")}</p>
          ) : (
            documents.map((doc) => {
              const verified = doc.status === "VERIFIED";
              return (
                <div
                  key={doc._id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border p-2 text-sm"
                  data-testid={`deal-document-${doc._id}`}
                >
                  {verified ? (
                    <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <bdi className="block truncate font-medium">{doc.ruleName}</bdi>
                    <span className="text-xs text-muted-foreground">{statusLabel(doc.status)}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {doc.fileUrl ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setPreviewFile({ url: doc.fileUrl!, name: doc.ruleName })}
                        >
                          <Eye className="h-4 w-4 me-1" />
                          {t("ViewFile")}
                        </Button>
                        {canVerify && (
                          <Button
                            size="sm"
                            disabled={verified}
                            onClick={() => void onVerify(doc._id)}
                          >
                            {t("Verify")}
                          </Button>
                        )}
                      </>
                    ) : (
                      canUpload && (
                        <>
                          <input
                            type="file"
                            id={`deal-doc-file-${doc._id}`}
                            className="hidden"
                            disabled={uploadingId === doc._id}
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) void onUpload(doc._id, file);
                              // Let the same file be chosen again after a
                              // failed upload; a stale value blocks `change`.
                              e.target.value = "";
                            }}
                          />
                          <Button size="sm" asChild disabled={uploadingId === doc._id}>
                            <label htmlFor={`deal-doc-file-${doc._id}`} className="cursor-pointer">
                              <Upload className="h-4 w-4 me-1" />
                              {t("Upload")}
                            </label>
                          </Button>
                        </>
                      )
                    )}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Dialog open={previewFile !== null} onOpenChange={(o) => { if (!o) setPreviewFile(null); }}>
        <DialogContent className="max-w-4xl max-h-[95vh] overflow-hidden p-0">
          <DialogHeader className="flex flex-row items-center justify-between border-b px-6 py-4">
            <DialogTitle className="truncate text-base">
              <bdi>{previewFile?.name}</bdi>
            </DialogTitle>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" asChild>
                <a href={previewFile?.url ?? "#"} download target="_blank" rel="noreferrer">
                  <Download className="h-4 w-4 me-1" />
                  {t("Download")}
                </a>
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPreviewFile(null)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </DialogHeader>
          <div className="flex min-h-[60vh] max-h-[80vh] items-center justify-center overflow-auto bg-[#0a0a0a] p-4">
            {previewFile?.url && /\.pdf/i.test(previewFile.url) ? (
              <iframe src={previewFile.url} className="h-[75vh] w-full rounded" title={previewFile.name} />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewFile?.url ?? ""}
                alt={previewFile?.name ?? ""}
                className="max-h-[75vh] max-w-full rounded object-contain shadow-lg"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
