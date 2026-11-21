import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { formatLocalized } from "@/lib/dateLocale";
import { isRenderableMoment } from "./dealCockpitDate";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";
import type { useDealDocumentActions } from "./useDealDocumentActions";

/**
 * Whether the DELIVERY_ACTIONS stage still has a required document outstanding.
 * No stage (no payload yet) and a NOT_APPLICABLE stage (no required rule,
 * SCRUM-629 F-07) have none; any other state short of COMPLETE does.
 */
export function documentsOutstanding(
  deliveryStageState: string | undefined,
): boolean {
  return (
    deliveryStageState !== undefined &&
    deliveryStageState !== "COMPLETE" &&
    deliveryStageState !== "NOT_APPLICABLE"
  );
}

/**
 * Whether THIS caller can advance the documents step, and if not, why
 * (SCRUM-417 round 1: Sol W1 = Codex S417-2).
 *
 * Keyed on the outstanding REQUIRED documents' own statuses and the server's
 * own gates, never on the step existing:
 *  - MISSING / REJECTED — uploaded (or replaced) through `generateUploadUrl` +
 *    `saveDocumentFile`, which take `create:finance_application` OR
 *    `verify:finance_documents`;
 *  - UPLOADED — moved only by `updateDocumentStatus` (verify or reject), which
 *    takes `verify:finance_documents`.
 *
 * The step is a working button when at least one outstanding document can be
 * advanced by this caller. Otherwise the reason says which: everything is
 * uploaded and waiting for a verifier, or this caller can touch no document
 * at all. `outstanding` empty with the step still open means the rail and the
 * checklist disagree; the capability alone decides, as it did before.
 *
 * Round 2 (Codex S417-R2-1 = Sol R2-1): the controls live on the rows
 * `documents.getForApplication` serves, and that read takes
 * `view:finance_applications` — a separate permission a custom role can omit.
 * Without it the pane is the read-only checklist, so a caller who COULD
 * advance a document is told the read is what is missing (`canRead`), on both
 * stages. The write reasons outrank it: they would stand even with the read.
 */
export function documentsStepUnavailableReason({
  outstanding,
  canUpload,
  canVerify,
  canRead,
  settled,
}: Readonly<{
  outstanding: ReadonlyArray<{ status: string }>;
  canUpload: boolean;
  canVerify: boolean;
  canRead: boolean;
  /** SCRUM-422: CLOSED or CANCELLED — the server refuses every document write. */
  settled: boolean;
}>): string | undefined {
  if (settled) return "DocumentsSettled";
  const canAdvance = (status: string) =>
    status === "UPLOADED" ? canVerify : canUpload || canVerify;
  const readReason = canRead ? undefined : "DocumentsNeedReadAccess";
  if (outstanding.length === 0)
    return canUpload || canVerify ? readReason : "DocumentsNeedUploader";
  if (outstanding.some((doc) => canAdvance(doc.status))) return readReason;
  // Nothing this caller can move. Someone who may upload is only stopped when
  // every outstanding document is already uploaded: it waits on a verifier.
  return canUpload ? "DocumentsAwaitVerifier" : "DocumentsNeedUploader";
}

export function buildDealDocuments({
  deal,
  documents,
  documentHistory,
  documentActions,
  canCreateApplication,
  canViewApplications,
  canVerifyDocuments,
  documentsSettled,
  locale,
}: Readonly<{
  deal:
    | FunctionReturnType<typeof api.dealWorkspace.financedDealCockpit>
    | undefined;
  documents:
    | FunctionReturnType<typeof api.documents.getForApplication>
    | undefined;
  documentHistory:
    | FunctionReturnType<typeof api.documents.getHistoryForApplication>
    | undefined;
  documentActions: ReturnType<typeof useDealDocumentActions>;
  canCreateApplication: boolean;
  canViewApplications: boolean;
  canVerifyDocuments: boolean;
  documentsSettled: boolean;
  locale: string;
}>) {
  /**
   * Whether a required document is still neither verified nor waived — the
   * SERVER's answer, read off the rail's DELIVERY_ACTIONS stage (derived with
   * the same rule filter `assertRequiredApplicationDocumentsComplete` applies
   * before a credit approval). Never recomputed from the checklist here. A
   * NOT_APPLICABLE stage has no required document, so nothing is outstanding
   * (SCRUM-629 F-07) — reading it as incomplete would lock credit approval.
   */
  const deliveryStage = deal?.stages.find(
    (stage) => stage.key === "DELIVERY_ACTIONS",
  );
  const documentsIncomplete = documentsOutstanding(deliveryStage?.state);
  /**
   * Whether this caller can take the documents step — see
   * `documentsStepUnavailableReason`. Read off the cockpit payload's checklist,
   * which lists a rule with no row yet as MISSING, exactly as the approval
   * gate counts it.
   */
  const documentsStepReason = documentsStepUnavailableReason({
    outstanding: (deal?.documents ?? []).filter(
      (doc) =>
        doc.required && doc.status !== "VERIFIED" && doc.status !== "WAIVED",
    ),
    canUpload: canCreateApplication || canVerifyDocuments,
    canVerify: canVerifyDocuments,
    // The exact predicate the `getForApplication` subscription above is gated on.
    canRead: canViewApplications,
    // A closed deal still derives DELIVERY_ACTIONS from the live rules, so a
    // rule added after closing can re-open the stage (SCRUM-422 R1 follow-up).
    settled: documentsSettled,
  });

  const presentation: NonNullable<DealCockpitViewProps["documents"]> = {
    items: documents?.map((doc) => ({
      _id: doc._id,
      ruleId: doc.ruleId,
      ruleName: doc.ruleName,
      status: doc.status,
      fileUrl: doc.fileUrl,
    })),
    history: documentHistory?.flatMap((doc) => {
      const uploadedAt = doc.uploadedAt ?? undefined;
      return doc.fileUrl
        ? [
            {
              _id: doc._id,
              ruleName: doc.ruleName,
              status: doc.status,
              fileUrl: doc.fileUrl,
              uploadedLabel: isRenderableMoment(uploadedAt)
                ? formatLocalized(uploadedAt, "d MMM yyyy", locale)
                : null,
            },
          ]
        : [];
    }),
    // The server accepts an upload from either permission; verifying is
    // the narrower one. Same gates as Review, read from the same server.
    // A CLOSED or CANCELLED deal's documents are settled record (SCRUM-422):
    // the server refuses every write there, so none is offered.
    canUpload:
      !documentsSettled && (canCreateApplication || canVerifyDocuments),
    canVerify: !documentsSettled && canVerifyDocuments,
    ...documentActions,
  };
  return { documentsIncomplete, documentsStepReason, presentation };
}
