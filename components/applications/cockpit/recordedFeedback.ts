/**
 * SCRUM-417 UX5 (S7): success feedback that waits for the server read model.
 *
 * A step mutation resolving means the server committed it, not that the screen
 * already shows it: the cockpit is a set of reactive queries, and a "success"
 * announced before they catch up says "done" over a screen that still says
 * "waiting". So a step's success line is held until the read model has moved
 * away from what it read when the action STARTED, and only then shown.
 *
 * Nothing here decides what happened. The signature is a fingerprint of the
 * facts the step surface is built from; the hook compares two of them.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** How long a committed mutation may go unreflected before the older notice takes over. */
export const RECORDED_REFLECT_TIMEOUT_MS = 10_000;

type SignatureInput = Readonly<{
  deal: Readonly<{
    status?: string;
    updatedAt?: number;
    expectedPaymentRegistered?: boolean;
    stages: ReadonlyArray<Readonly<{ key: string; state: string; blocker?: string }>>;
    documents: ReadonlyArray<Readonly<{ ruleId: string; status: string }>>;
  }> | null | undefined;
  /** The documents list the panel reads (`documents.getForApplication`), when the caller may. */
  documents?: ReadonlyArray<Readonly<{ ruleId: string; status: string; fileUrl?: string | null }>>;
  /** The disbursement and route facts `applications.get` carries. */
  application?: Readonly<{
    status?: string;
    disbursedAt?: number;
    supplierDisbursementStatus?: string;
    supplierSettlementRoute?: string;
  }> | null;
}>;

/**
 * A fingerprint of the step-relevant read model, or `null` while the cockpit is
 * not loaded (nothing can be compared then). Two equal fingerprints mean the
 * screen has not moved; it deliberately covers only what a step's success can
 * change, so an unrelated re-render never counts as "reflected".
 */
export function readModelSignature({ deal, documents, application }: SignatureInput): string | null {
  if (!deal) return null;
  return JSON.stringify([
    deal.status ?? null,
    deal.updatedAt ?? null,
    deal.expectedPaymentRegistered ?? null,
    deal.stages.map((stage) => [stage.key, stage.state, stage.blocker ?? null]),
    deal.documents.map((doc) => [doc.ruleId, doc.status]),
    (documents ?? []).map((doc) => [doc.ruleId, doc.status, doc.fileUrl ? 1 : 0]),
    application
      ? [
          application.status ?? null,
          application.disbursedAt ?? null,
          application.supplierDisbursementStatus ?? null,
          application.supplierSettlementRoute ?? null,
        ]
      : null,
  ]);
}

type OutstandingDocument = Readonly<{ ruleId: string; required: boolean; status: string }>;

/**
 * The document row to hand focus to after one was uploaded or verified: the
 * next REQUIRED, unverified, un-waived one after it in list order (wrapping to
 * the start), never the one just acted on. `undefined` when nothing else is
 * outstanding, so focus is left where it is rather than moved for nothing.
 */
export function nextOutstandingDocument(
  documents: ReadonlyArray<OutstandingDocument>,
  handledRuleId: string | undefined
): string | undefined {
  const isOutstanding = (doc: OutstandingDocument) =>
    doc.required && doc.status !== "VERIFIED" && doc.status !== "WAIVED";
  const from = handledRuleId === undefined ? -1 : documents.findIndex((doc) => doc.ruleId === handledRuleId);
  const ordered = [...documents.slice(from + 1), ...documents.slice(0, from + 1)];
  return ordered.find((doc) => doc.ruleId !== handledRuleId && isOutstanding(doc))?.ruleId;
}

export type RecordedFeedback = Readonly<{
  /** Set for a document upload/verify: the rule the action was on. */
  documentRuleId?: string;
  isDocumentAction: boolean;
}>;

type Pending = Readonly<{ startSignature: string | null; fallbackKey: string } & RecordedFeedback>;

/**
 * Holds a step's success until the read model reflects it.
 *
 * `track(run, fallbackKey)` runs the mutation. If it throws, nothing is held
 * and nothing is shown -- the caller's own error surface is untouched. If it
 * resolves, `recorded` becomes set once `signature` differs from what it was
 * when the action started (including "already differs", when the query beat
 * the promise). A committed change that never shows up within the timeout falls
 * back to `onUnreflected(fallbackKey)`, the notice that used to be immediate:
 * the operator is never left without an outcome.
 */
export function useRecordedFeedback(
  signature: string | null,
  onUnreflected: (fallbackKey: string) => void
) {
  const signatureRef = useRef(signature);
  const onUnreflectedRef = useRef(onUnreflected);
  useEffect(() => {
    signatureRef.current = signature;
    onUnreflectedRef.current = onUnreflected;
  });
  const [pending, setPending] = useState<Pending | null>(null);
  const [recorded, setRecorded] = useState<RecordedFeedback | null>(null);

  // Set during render, like the announcer's `hasViewed`: the moment the
  // fingerprint moves, the held success is released -- no frame in between.
  if (pending !== null && signature !== null && signature !== pending.startSignature) {
    setPending(null);
    setRecorded({ isDocumentAction: pending.isDocumentAction, documentRuleId: pending.documentRuleId });
  }

  useEffect(() => {
    if (pending === null) return;
    const timer = setTimeout(() => {
      setPending(null);
      onUnreflectedRef.current(pending.fallbackKey);
    }, RECORDED_REFLECT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const clear = useCallback(() => {
    setPending(null);
    setRecorded(null);
  }, []);

  const track = useCallback(
    async <T>(run: () => Promise<T>, fallbackKey: string, options: Partial<RecordedFeedback> = {}): Promise<T> => {
      // A new action is the end of the previous line.
      setPending(null);
      setRecorded(null);
      const startSignature = signatureRef.current;
      const value = await run();
      setPending({
        startSignature,
        fallbackKey,
        isDocumentAction: options.isDocumentAction ?? false,
        documentRuleId: options.documentRuleId,
      });
      return value;
    },
    []
  );

  return { recorded, track, clear };
}
