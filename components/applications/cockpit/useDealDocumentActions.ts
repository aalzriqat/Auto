import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toast } from "@/components/ui/sonner";
import { getErrorMessage } from "@/lib/errors";
import type { DealDocument } from "./DealDocumentsPanel";
import {
  uploadReflected,
  verifyReflected,
  type useRecordedFeedback,
} from "./recordedFeedback";

export function useDealDocumentActions({
  orgId,
  applicationId,
  documents,
  trackRecorded,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  documents: ReadonlyArray<Pick<DealDocument, "_id" | "ruleId">> | undefined;
  trackRecorded: ReturnType<typeof useRecordedFeedback>["track"];
}>) {
  const updateDocStatus = useMutation(api.documents.updateDocumentStatus);
  const ensureApplicationDocument = useMutation(
    api.documents.ensureApplicationDocument,
  );
  const generateUploadUrl = useMutation(api.documents.generateUploadUrl);
  const saveDocumentFile = useMutation(api.documents.saveDocumentFile);

  /**
   * The RULES whose upload is in flight (Sol S421-R2-2). Keyed by rule, not by
   * row: a late rule's line is served as `_id: null` and re-served under its
   * new document id the moment `ensureApplicationDocument` commits — while the
   * file is still transferring. A row-keyed busy flag went false at that
   * moment and let a second pick race the first onto the same row. The state
   * paints the control; the ref is the guard, synchronous, so a second pick
   * cannot slip in before a re-render.
   */
  const [uploadingRuleIds, setUploadingRuleIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const uploadsInFlightRef = useRef(new Set<string>());

  async function onUpload(
    doc: Pick<DealDocument, "_id" | "ruleId">,
    file: File,
  ) {
    if (uploadsInFlightRef.current.has(doc.ruleId)) return;
    uploadsInFlightRef.current.add(doc.ruleId);
    setUploadingRuleIds(new Set(uploadsInFlightRef.current));
    // The stored file (`_storage` id) this upload produces: what identifies it
    // on the documents read model, unlike a timestamp two uploads can share.
    let storedFileId: string | undefined;
    try {
      // Tracked from the START, so a row the read model already moved
      // while the file was uploading still counts as reflected (S7).
      await trackRecorded(
        async () => {
          // A rule added after the application was created has no row yet
          // (SCRUM-421): create it first, under the same authority as the
          // upload. Idempotent, so a retry lands on the same row.
          const documentId =
            doc._id ??
            (await ensureApplicationDocument({
              orgId,
              applicationId,
              ruleId: doc.ruleId as Id<"companyDocumentRules">,
            }));
          // Named, so a deal that settled meanwhile gets no URL and no file
          // is stored for a row the server would refuse (SCRUM-422).
          const postUrl = await generateUploadUrl({
            orgId,
            documentId: documentId as Id<"applicationDocuments">,
            mimeType: file.type,
            sizeInBytes: file.size,
          });
          const result = await fetch(postUrl, {
            method: "POST",
            headers: { "Content-Type": file.type },
            body: file,
          });
          const { storageId } = await result.json();
          storedFileId = typeof storageId === "string" ? storageId : undefined;
          await saveDocumentFile({
            orgId,
            documentId: documentId as Id<"applicationDocuments">,
            fileId: storageId,
          });
        },
        "UploadSuccess",
        {
          isDocumentAction: true,
          documentRuleId: doc.ruleId,
          // This rule's row carries the new file -- not "the list changed":
          // another operator's verify, or the rule list reordering when a
          // row-less rule is materialized, must not release the line.
          reflectedWhen: uploadReflected(doc.ruleId, () => storedFileId),
        },
      );
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      uploadsInFlightRef.current.delete(doc.ruleId);
      setUploadingRuleIds(new Set(uploadsInFlightRef.current));
    }
  }

  async function onVerify(documentId: string) {
    const documentRuleId = documents?.find(
      (doc) => doc._id === documentId,
    )?.ruleId;
    try {
      await trackRecorded(
        () =>
          updateDocStatus({
            orgId,
            documentId: documentId as Id<"applicationDocuments">,
            status: "VERIFIED",
          }),
        "DocVerified",
        {
          isDocumentAction: true,
          documentRuleId: documentRuleId,
          reflectedWhen: verifyReflected(documentRuleId),
        },
      );
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  return { uploadingRuleIds, onUpload, onVerify };
}
