/**
 * SCRUM-417 UX5 (S7): success feedback that waits for the server read model.
 *
 * The invariant: "Recorded. Next: ..." may be shown only when the read model
 * shows the fact written by THAT action on THAT deal. Any action with no such
 * observable fact gets an immediate outcome (the toast). The operator is never
 * left without an outcome -- including when the cockpit unmounts or the deal
 * changes underneath a held one.
 *
 * A step mutation resolving means the server committed it, not that the screen
 * already shows it: the cockpit is a set of reactive queries, and a "success"
 * announced before they catch up says "done" over a screen that still says
 * "waiting". So each caller says what it wrote (`reflectedWhen`, a predicate
 * over the read model) and its success line is held until that fact is on
 * screen. There is deliberately NO whole-deal fingerprint: an unrelated change
 * (another operator verifying a different document, the rule list reordering
 * when a row is materialized) is not evidence that THIS action landed.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** How long a committed mutation may go unreflected before the older notice takes over. */
export const RECORDED_REFLECT_TIMEOUT_MS = 10_000;

/** The part of the read model the predicates below are allowed to look at. */
export type RecordedModel = Readonly<{
  deal:
    | Readonly<{
        expectedPaymentRegistered?: boolean;
        stages: ReadonlyArray<Readonly<{ key: string; state: string }>>;
      }>
    | null
    | undefined;
  /** The documents list the panel reads (`documents.getForApplication`), when the caller may. */
  documents?: ReadonlyArray<
    Readonly<{
      _id?: string | null;
      ruleId: string;
      status: string;
      uploadedAt?: number | null;
      fileUrl?: string | null;
    }>
  >;
  /** The facts `applications.get` carries. */
  application?: Readonly<{
    status?: string;
    disbursedAt?: number | null;
    supplierDisbursementStatus?: string | null;
    needsFinancingReconciliation?: boolean;
    deposits?: ReadonlyArray<Readonly<{ _id: string; releaseCount?: number }>>;
  }> | null;
  /** `financingEconomics.getEconomics().application`. */
  economics?: Readonly<{
    submittedQuotationMinor?: number | null;
    approvedDealerPurchaseAmountMinor?: number | null;
  }> | null;
  /** `financeDealCosts.listDealCosts`. */
  costs?: Readonly<{
    legalInvoiceNumber?: string | null;
    legalInvoiceAmountMinor?: number | null;
  }> | null;
}>;

/** True once the read model `now` shows the fact the action wrote; `start` is what it read when the action began. */
export type ReflectedPredicate = (now: RecordedModel, start: RecordedModel | null) => boolean;

const rowFor = (model: RecordedModel | null, ruleId: string) =>
  model?.documents?.find((doc) => doc.ruleId === ruleId);

/** The rule's row carries a file this upload stored (a new `uploadedAt`, or a file where there was none). */
export const uploadReflected =
  (ruleId: string): ReflectedPredicate =>
  (now, start) => {
    const row = rowFor(now, ruleId);
    if (!row?.fileUrl) return false;
    const before = rowFor(start, ruleId);
    return !before?.fileUrl || before.uploadedAt !== row.uploadedAt;
  };

/** The rule's row is VERIFIED. */
export const verifyReflected =
  (ruleId: string | undefined): ReflectedPredicate =>
  (now) =>
    ruleId !== undefined && rowFor(now, ruleId)?.status === "VERIFIED";

export const creditStatusReflected =
  (status: string): ReflectedPredicate =>
  (now) =>
    now.application?.status === status;

/** The deposit's release counter moved past the one the operator's dialog observed. */
export const depositReleaseReflected =
  (depositId: string, observedReleaseCount: number): ReflectedPredicate =>
  (now) => {
    const deposit = now.application?.deposits?.find((entry) => entry._id === depositId);
    return deposit !== undefined && (deposit.releaseCount ?? 0) > observedReleaseCount;
  };

export const financeDisbursementReflected: ReflectedPredicate = (now) =>
  now.application?.disbursedAt != null;

export const supplierDisbursementReflected: ReflectedPredicate = (now) =>
  now.application?.supplierDisbursementStatus != null;

export const handoverReflected: ReflectedPredicate = (now) =>
  now.deal?.stages.find((stage) => stage.key === "HANDOVER")?.state === "COMPLETE";

export const expectedPaymentReflected: ReflectedPredicate = (now) =>
  now.deal?.expectedPaymentRegistered === true;

export const reconciliationReflected: ReflectedPredicate = (now) =>
  now.application != null && now.application.needsFinancingReconciliation !== true;

export const quotationReflected =
  (amountMinor: number): ReflectedPredicate =>
  (now) =>
    now.economics?.submittedQuotationMinor === amountMinor;

export const approvedPurchaseReflected =
  (amountMinor: number): ReflectedPredicate =>
  (now) =>
    now.economics?.approvedDealerPurchaseAmountMinor === amountMinor;

/**
 * Reopening removes the approved amount: it was on screen when the action
 * started and is gone now. (An amount the caller was never shown is `null` from
 * the start, so it can never be told apart from a reopened one -- that case
 * falls back to the timed notice rather than claiming a fact nobody can see.)
 */
export const approvalReopenedReflected: ReflectedPredicate = (now, start) =>
  start?.economics?.approvedDealerPurchaseAmountMinor != null &&
  now.economics != null &&
  now.economics.approvedDealerPurchaseAmountMinor == null;

export const legalInvoiceReflected =
  (number: string, amountMinor: number): ReflectedPredicate =>
  (now) =>
    now.costs?.legalInvoiceNumber === number && now.costs?.legalInvoiceAmountMinor === amountMinor;

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

export type RecordedTrackOptions = Partial<RecordedFeedback> &
  Readonly<{
    /**
     * What the action wrote, as a predicate over the read model. Without it the
     * action has no observable fact and its outcome is said at once.
     */
    reflectedWhen?: ReflectedPredicate;
  }>;

type Pending = Readonly<{
  startModel: RecordedModel | null;
  fallbackKey: string;
  reflectedWhen: ReflectedPredicate;
  /** The deal it was written on: never released against another deal's model. */
  scope: string;
}> &
  RecordedFeedback;

function isReflected(pending: Pending, model: RecordedModel): boolean {
  try {
    return pending.reflectedWhen(model, pending.startModel);
  } catch {
    return false;
  }
}

/**
 * Holds a step's success until the read model shows the fact it wrote.
 *
 * `track(run, fallbackKey, options)` runs the mutation. If it throws, nothing is
 * held and nothing is shown -- the caller's own error surface is untouched. If
 * it resolves with no `reflectedWhen`, `onUnreflected(fallbackKey)` (the toast)
 * says so at once. With one, `recorded` becomes set once `model` satisfies it
 * (including "already does", when the query beat the promise). A committed
 * change that never shows up within the timeout, an unmount, or a change of
 * `scopeKey` (another deal) falls back to `onUnreflected`: the operator is never
 * left without an outcome.
 */
export function useRecordedFeedback(
  model: RecordedModel | null,
  onUnreflected: (fallbackKey: string) => void,
  scopeKey: string = ""
) {
  const modelRef = useRef(model);
  const scopeRef = useRef(scopeKey);
  const onUnreflectedRef = useRef(onUnreflected);
  const mountedRef = useRef(false);
  const pendingRef = useRef<Pending | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [recorded, setRecorded] = useState<RecordedFeedback | null>(null);

  useEffect(() => {
    modelRef.current = model;
    onUnreflectedRef.current = onUnreflected;
    pendingRef.current = pending;
  });

  // Set during render, like the announcer's transitions: the moment the fact is
  // on screen the held success is released -- no frame in between.
  if (pending !== null && pending.scope === scopeKey && model !== null && isReflected(pending, model)) {
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

  // The cockpit leaving the screen (finalize navigates away) must not swallow a
  // held outcome: what was still unconfirmed is said now, as the older notice.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const held = pendingRef.current;
      if (held) onUnreflectedRef.current(held.fallbackKey);
    };
  }, []);

  // Another deal on the same mounted cockpit: a held line belongs to the deal
  // it was written on, so it is settled as a notice and the line is dropped.
  useEffect(() => {
    if (scopeRef.current === scopeKey) return;
    scopeRef.current = scopeKey;
    const held = pendingRef.current;
    if (held) onUnreflectedRef.current(held.fallbackKey);
    pendingRef.current = null;
    setPending(null);
    setRecorded(null);
  }, [scopeKey]);

  const clear = useCallback(() => {
    setPending(null);
    setRecorded(null);
  }, []);

  const track = useCallback(
    async <T>(run: () => Promise<T>, fallbackKey: string, options: RecordedTrackOptions = {}): Promise<T> => {
      // A new action is the end of the previous line (an unconfirmed one is
      // settled first, so it is not silently dropped).
      const held = pendingRef.current;
      if (held) onUnreflectedRef.current(held.fallbackKey);
      pendingRef.current = null;
      setPending(null);
      setRecorded(null);
      const startModel = modelRef.current;
      const startScope = scopeRef.current;
      const value = await run();
      const { reflectedWhen } = options;
      if (!reflectedWhen || !mountedRef.current || scopeRef.current !== startScope) {
        onUnreflectedRef.current(fallbackKey);
        return value;
      }
      setPending({
        startModel,
        fallbackKey,
        reflectedWhen,
        scope: startScope,
        isDocumentAction: options.isDocumentAction ?? false,
        documentRuleId: options.documentRuleId,
      });
      return value;
    },
    []
  );

  return { recorded, track, clear };
}
