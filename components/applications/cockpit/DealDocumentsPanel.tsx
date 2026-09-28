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
import { Archive, Check, Download, Eye, FileText, Upload, X } from "lucide-react";

/**
 * A document as `documents.getForApplication` serves it: the per-deal row with
 * its rule name, status and a signed file URL when a file is on it. The same
 * query the Finance Applications → Review dialog reads.
 *
 * `_id` is null for a rule added after the application was created
 * (SCRUM-421): the rule applies, the row does not exist yet, and the upload
 * creates it first (`documents.ensureApplicationDocument`).
 */
export type DealDocument = {
  _id: string | null;
  ruleId: string;
  ruleName: string;
  status: string;
  fileUrl: string | null;
};

/**
 * A stored file whose requirement no longer applies to this deal, as
 * `documents.getHistoryForApplication` serves it (SCRUM-417 round 3,
 * S417-R3-1). View only: it is neither work nor counted toward approval.
 * `ruleName` is null when the rule itself was deleted; `uploadedLabel` is the
 * upload moment already formatted, or null when none was recorded.
 */
export type DealDocumentHistoryItem = {
  _id: string;
  ruleName: string | null;
  status: string;
  fileUrl: string;
  uploadedLabel: string | null;
};

/** One stable key per checklist line, whether or not its row exists yet. */
export function documentRowKey(doc: Pick<DealDocument, "_id" | "ruleId">): string {
  return doc._id ?? `rule-${doc.ruleId}`;
}

/**
 * The file picker behind an Upload (or, for a rejected file, a replacement)
 * button. A hidden input driven by its label, so the button stays a real,
 * focusable control and the same file can be picked again after a failure.
 */
function DocumentUploadControl({
  rowKey,
  label,
  busy,
  onPick,
}: Readonly<{ rowKey: string; label: string; busy: boolean; onPick: (file: File) => void }>) {
  const inputId = `deal-doc-file-${rowKey}`;
  return (
    <>
      <input
        type="file"
        id={inputId}
        className="hidden"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          // Let the same file be chosen again after a failed upload; a stale
          // value blocks `change`.
          e.target.value = "";
        }}
      />
      <Button size="sm" variant="outline" asChild disabled={busy}>
        <label htmlFor={inputId} className="cursor-pointer">
          <Upload className="h-4 w-4 me-1" />
          {label}
        </label>
      </Button>
    </>
  );
}

const DOCUMENT_STATUS_LABEL: Record<string, string> = {
  MISSING: "DocMissing",
  UPLOADED: "DocUploaded",
  VERIFIED: "DocVerified",
  REJECTED: "DocRejected",
  WAIVED: "DocWaived",
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
  history,
  checklist,
  canUpload,
  canVerify,
  uploadingRuleIds,
  t,
  onUpload,
  onVerify,
}: Readonly<{
  documents: ReadonlyArray<DealDocument> | undefined;
  /**
   * Files kept for requirements that no longer apply — shown below the
   * checklist, View only, for every role. Optional: absent (or still loading)
   * renders nothing.
   */
  history?: ReadonlyArray<DealDocumentHistoryItem>;
  /** The cockpit payload's read-only checklist, the fallback when `documents` is withheld. */
  checklist: ReadonlyArray<{ ruleId: string; name: string; required: boolean; status: string }>;
  canUpload: boolean;
  canVerify: boolean;
  /**
   * The RULE ids whose upload is in flight. By rule, not by row key: a late
   * rule's line changes key (`rule-<id>` → its new document id) mid-upload,
   * and it must stay busy across that (SCRUM-417 round 2, S421-R2-2).
   */
  uploadingRuleIds: ReadonlySet<string>;
  t: (key: string) => string;
  onUpload: (doc: DealDocument, file: File) => void | Promise<void>;
  onVerify: (documentId: string) => void | Promise<void>;
}>) {
  const [previewFile, setPreviewFile] = useState<{ url: string; name: string } | null>(null);

  const statusLabel = (status: string) => {
    const key = DOCUMENT_STATUS_LABEL[status];
    return key ? t(key) : status;
  };

  if (documents === undefined) {
    // Withheld or loading: the checklist the rail already reads, with no
    // controls. ABSENT entirely when there is nothing to list — an empty card
    // would invite an operator to look for an upload control that is not
    // there for them.
    if (checklist.length === 0) return null;
    return (
      <Card data-testid="deal-documents">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            {t("DocumentsHeading")}
          </CardTitle>
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
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4 shrink-0 text-primary" aria-hidden />
            {t("DocumentsHeading")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("NoDocsRequired")}</p>
          ) : (
            documents.map((doc) => {
              const verified = doc.status === "VERIFIED";
              const rowKey = documentRowKey(doc);
              const documentId = doc._id;
              const busy = uploadingRuleIds.has(doc.ruleId);
              /**
               * The upload follows the STATUS, not whether an older file is
               * attached (round 2, S417-R2-5): `updateDocumentStatus(MISSING)`
               * keeps the file, and the step counts MISSING as uploadable. A
               * row that still needs a file offers one — as a replacement when
               * an old one is there, which stays viewable until
               * `saveDocumentFile` swaps it. A row with no file offers the
               * upload, as before.
               */
              const needsFile = doc.status === "MISSING" || doc.status === "REJECTED";
              const offerUpload = canUpload && (doc.fileUrl ? needsFile : true);
              return (
                <div
                  key={rowKey}
                  className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border p-2 text-sm"
                  data-testid={`deal-document-${rowKey}`}
                >
                  {verified ? (
                    <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    {/* Wraps rather than truncates: a document name is what the
                        operator matches against a physical paper, and its tail
                        is often the distinguishing part. */}
                    <bdi className="block break-words font-medium">{doc.ruleName}</bdi>
                    <span className="text-xs text-muted-foreground">{statusLabel(doc.status)}</span>
                  </div>
                  {/* Shrinkable and wrapping: a reset row can carry View,
                      Verify and a replacement at once, wider than a phone. */}
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {doc.fileUrl && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setPreviewFile({ url: doc.fileUrl!, name: doc.ruleName })}
                      >
                        <Eye className="h-4 w-4 me-1" />
                        {t("ViewFile")}
                      </Button>
                    )}
                    {/* Outline, not primary: the documents panel is a
                        supporting surface. The one recommended action on
                        this screen lives on the stage rail, and a second
                        filled button here competed with it. */}
                    {doc.fileUrl && canVerify && documentId !== null && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={verified}
                        onClick={() => void onVerify(documentId)}
                      >
                        {t("Verify")}
                      </Button>
                    )}
                    {/* A rejected (or reset-to-missing) file is not the end of
                        the line: whoever may upload may replace it, and
                        `saveDocumentFile` swaps the file on the same row and
                        puts it back to UPLOADED. */}
                    {offerUpload && (
                      <DocumentUploadControl
                        rowKey={rowKey}
                        label={t(doc.fileUrl ? "ReplaceFile" : "Upload")}
                        busy={busy}
                        onPick={(file) => void onUpload(doc, file)}
                      />
                    )}
                  </div>
                </div>
              );
            })
          )}
          {history && history.length > 0 && (
            <section
              className="mt-4 space-y-2 border-t border-dashed pt-3"
              aria-labelledby="deal-documents-history-heading"
              data-testid="deal-documents-history"
            >
              <div>
                <h3
                  id="deal-documents-history-heading"
                  className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"
                >
                  <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {t("DocumentsNoLongerRequired")}
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">{t("DocumentsNoLongerRequiredNote")}</p>
              </div>
              {history.map((doc) => {
                const name = doc.ruleName ?? t("RemovedRequirement");
                return (
                  <div
                    key={doc._id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-dashed bg-muted/30 p-2 text-sm"
                    data-testid={`deal-document-history-${doc._id}`}
                  >
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0 flex-1">
                      {/* Muted, never italic: Arabic has no true italic, and a
                          synthetic slant breaks its joins. */}
                      <bdi className="block break-words text-muted-foreground">{name}</bdi>
                      <span className="text-xs text-muted-foreground">
                        {statusLabel(doc.status)}
                        {doc.uploadedLabel && (
                          <>
                            {" · "}
                            <bdi>{doc.uploadedLabel}</bdi>
                          </>
                        )}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPreviewFile({ url: doc.fileUrl, name })}
                    >
                      <Eye className="h-4 w-4 me-1" />
                      {t("ViewFile")}
                    </Button>
                  </div>
                );
              })}
            </section>
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
