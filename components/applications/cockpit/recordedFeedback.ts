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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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
      /** The stored file (`_storage` id): unique per upload, so it names WHICH upload is on screen. */
      fileId?: string | null;
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
    submittedQuotationSource?: string | null;
    approvedDealerPurchaseAmountMinor?: number | null;
    approvedPurchaseBasis?: string | null;
  }> | null;
  /** `financeDealCosts.listDealCosts`. */
  costs?: Readonly<{
    legalInvoiceNumber?: string | null;
    legalInvoiceAmountMinor?: number | null;
    legalInvoiceDate?: number | null;
    legalInvoiceIssuedTo?: string | null;
  }> | null;
}>;

/**
 * True once the read model `now` shows the fact the action wrote; `start` is what
 * it read when the action began.
 *
 * `provableFrom` is the other half of the contract: a predicate that compares
 * observable fields can only PROVE an action when the read model at the start
 * did not already show what was submitted (otherwise "the old row satisfies it"
 * and any competing writer of the same values would too). It answers, for the
 * start model, whether the write can be told apart from what was already there;
 * when it says no, the outcome is said at once (the toast) instead of held.
 * `null` (nothing was loaded yet) is provable: there is nothing to confuse it with.
 */
export type ReflectedPredicate = ((now: RecordedModel, start: RecordedModel | null) => boolean) & {
  provableFrom?: (start: RecordedModel | null) => boolean;
};

const provable = (
  predicate: (now: RecordedModel, start: RecordedModel | null) => boolean,
  provableFrom: (start: RecordedModel | null) => boolean
): ReflectedPredicate => Object.assign(predicate, { provableFrom });

const rowFor = (model: RecordedModel | null, ruleId: string) =>
  model?.documents?.find((doc) => doc.ruleId === ruleId);

/**
 * The rule's row carries THE file this upload stored. `storedFileId` is read when
 * the predicate is evaluated: the storage id is only known once the file has been
 * posted, which is inside the tracked action. A colleague's competing upload to the
 * same rule -- even in the same millisecond -- carries a different id, so it is
 * never mistaken for this one.
 */
export const uploadReflected =
  (ruleId: string, storedFileId: () => string | undefined): ReflectedPredicate =>
  (now) => {
    const fileId = storedFileId();
    return fileId !== undefined && rowFor(now, ruleId)?.fileId === fileId;
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

/**
 * The deposit's release counter moved past the one the operator's dialog observed.
 *
 * Accepted limitation: two operators releasing the SAME deposit at once both see
 * the counter pass what their dialogs observed, so either's line may be released by
 * the other's write. The read model exposes no per-release identity to tell them
 * apart; the outcome (a release landed on this deposit) is true either way.
 */
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

/**
 * The quotation as recorded: the amount AND its source. A same-amount edit that
 * changes only the source is a different fact from the row already on screen; an
 * edit that changes neither (say, only the override reason, which the read model
 * withholds from some callers) cannot be told apart, so it is said at once.
 */
export const quotationReflected = (
  amountMinor: number,
  source: string
): ReflectedPredicate =>
  provable(
    (now) =>
      now.economics?.submittedQuotationMinor === amountMinor && now.economics?.submittedQuotationSource === source,
    (start) =>
      !(
        start?.economics?.submittedQuotationMinor === amountMinor &&
        start.economics.submittedQuotationSource === source
      )
  );

/** The approval as recorded: the amount AND its basis (the appraisal it rests on is chosen by the server). */
export const approvedPurchaseReflected = (
  amountMinor: number,
  basis: string
): ReflectedPredicate =>
  provable(
    (now) =>
      now.economics?.approvedDealerPurchaseAmountMinor === amountMinor &&
      now.economics?.approvedPurchaseBasis === basis,
    (start) =>
      !(
        start?.economics?.approvedDealerPurchaseAmountMinor === amountMinor &&
        start.economics.approvedPurchaseBasis === basis
      )
  );

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

/**
 * Every submitted invoice field the read model exposes: number, amount, date and
 * who it was issued to. (`issuedToOther`, the free-text name, is not on
 * `listDealCosts`, so an edit that changes only it is not provable and is said at
 * once.) The row already on screen never satisfies it: at least one of the four
 * differs from what the action started with.
 */
export type LegalInvoiceSubmitted = Readonly<{
  number: string;
  amountMinor: number;
  date: number;
  issuedTo: string;
}>;

const invoiceMatches = (costs: RecordedModel["costs"], submitted: LegalInvoiceSubmitted) =>
  costs?.legalInvoiceNumber === submitted.number &&
  costs?.legalInvoiceAmountMinor === submitted.amountMinor &&
  costs?.legalInvoiceDate === submitted.date &&
  costs?.legalInvoiceIssuedTo === submitted.issuedTo;

export const legalInvoiceReflected = (submitted: LegalInvoiceSubmitted): ReflectedPredicate =>
  provable(
    (now) => invoiceMatches(now.costs, submitted),
    (start) => !invoiceMatches(start?.costs, submitted)
  );

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
 * it resolves with no `reflectedWhen`, or with one that cannot tell the write
 * from what the screen already showed (`provableFrom`), `onUnreflected(fallbackKey)`
 * (the toast) says so at once. Otherwise `recorded` becomes set once `model`
 * satisfies it (including "already does", when the query beat the promise). A
 * committed change that never shows up within the timeout, an unmount, or a change
 * of `scopeKey` (another deal) falls back to `onUnreflected`: the operator is
 * never left without an outcome.
 *
 * Settling happens exactly once. `pendingRef` is the single owner of "an outcome
 * is still owed": it is set synchronously when the action is held, and every path
 * that settles it (reflect, timeout, replace, scope change, unmount) takes it with
 * `settle` -- read and null in one step -- so two paths in one batch (the timer and
 * the unmount, a track resolving as the cockpit leaves) can never both say it, and
 * neither can drop it. State is only the render mirror of that ref.
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
  // `from` is the held action this line released: the effect below retires the
  // ref for exactly that one (never a newer action's).
  const [released, setReleased] = useState<Readonly<{ feedback: RecordedFeedback; from: Pending }> | null>(null);
  const recorded = released?.feedback ?? null;

  useEffect(() => {
    modelRef.current = model;
    onUnreflectedRef.current = onUnreflected;
  });

  /** Take the owed outcome: read and null in one step. `only` limits it to one specific held action. */
  const settle = useCallback((only?: Pending): Pending | null => {
    const held = pendingRef.current;
    if (held === null || (only !== undefined && held !== only)) return null;
    pendingRef.current = null;
    return held;
  }, []);

  // Set during render, like the announcer's transitions: the moment the fact is
  // on screen the held success is released -- no frame in between.
  if (pending !== null && pending.scope === scopeKey && model !== null && isReflected(pending, model)) {
    setPending(null);
    setReleased({
      feedback: { isDocumentAction: pending.isDocumentAction, documentRuleId: pending.documentRuleId },
      from: pending,
    });
  }

  // A released line is only as true as the fact it names. If, on the same deal,
  // the read model later stops showing that fact (another operator changed the
  // same value), the line is retracted. Retraction only removes the line: the
  // outcome was already delivered, so it says nothing else and never toasts, and
  // it is permanent (the value coming back does not revive it). It converges:
  // once `released` is null this condition is false.
  if (released !== null && model !== null && released.from.scope === scopeKey && !isReflected(released.from, model)) {
    setReleased(null);
  }

  // The line is on screen: the outcome is no longer owed. The ref is retired in a
  // layout effect (committed with the line, before any timer or overlapping track
  // can run) and not during render, so a discarded render cannot lose it.
  useLayoutEffect(() => {
    if (released !== null) settle(released.from);
  }, [released, settle]);

  useEffect(() => {
    if (pending === null) return;
    const timer = setTimeout(() => {
      setPending(null);
      const held = settle(pending);
      if (held) onUnreflectedRef.current(held.fallbackKey);
    }, RECORDED_REFLECT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending, settle]);

  // The cockpit leaving the screen (finalize navigates away) must not swallow a
  // held outcome: what was still unconfirmed is said now, as the older notice.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const held = settle();
      if (held) onUnreflectedRef.current(held.fallbackKey);
    };
  }, [settle]);

  // Another deal on the same mounted cockpit: a held line belongs to the deal
  // it was written on, so it is settled as a notice and the line is dropped.
  useEffect(() => {
    if (scopeRef.current === scopeKey) return;
    scopeRef.current = scopeKey;
    const held = settle();
    if (held) onUnreflectedRef.current(held.fallbackKey);
    setPending(null);
    setReleased(null);
  }, [scopeKey, settle]);

  // Dismissing the line: an outcome still owed (there normally is none -- a new
  // action already ended the previous line) is said rather than dropped.
  const clear = useCallback(() => {
    const held = settle();
    if (held) onUnreflectedRef.current(held.fallbackKey);
    setPending(null);
    setReleased(null);
  }, [settle]);

  const track = useCallback(
    async <T>(run: () => Promise<T>, fallbackKey: string, options: RecordedTrackOptions = {}): Promise<T> => {
      // A new action is the end of the previous line (an unconfirmed one is
      // settled first, so it is not silently dropped).
      const held = settle();
      if (held) onUnreflectedRef.current(held.fallbackKey);
      setPending(null);
      setReleased(null);
      const startModel = modelRef.current;
      const startScope = scopeRef.current;
      const value = await run();
      const { reflectedWhen } = options;
      if (
        !reflectedWhen ||
        !mountedRef.current ||
        scopeRef.current !== startScope ||
        // The screen already showed what was submitted: seeing it again proves nothing.
        reflectedWhen.provableFrom?.(startModel) === false
      ) {
        onUnreflectedRef.current(fallbackKey);
        return value;
      }
      const next: Pending = {
        startModel,
        fallbackKey,
        reflectedWhen,
        scope: startScope,
        isDocumentAction: options.isDocumentAction ?? false,
        documentRuleId: options.documentRuleId,
      };
      // Two actions can overlap (both awaiting their mutation): the earlier one
      // still owed an outcome is said now, not overwritten.
      const owed = settle();
      if (owed) onUnreflectedRef.current(owed.fallbackKey);
      pendingRef.current = next;
      setPending(next);
      return value;
    },
    [settle]
  );

  return { recorded, track, clear };
}