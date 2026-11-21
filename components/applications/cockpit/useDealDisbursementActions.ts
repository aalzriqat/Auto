import type { FunctionReturnType } from "convex/server";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toast } from "@/components/ui/sonner";
import {
  getErrorMessage,
  getLocalizedErrorMessage,
  isConvexError,
} from "@/lib/errors";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";
import {
  disbursementReturnReflected,
  financeDisbursementReflected,
  supplierDisbursementReflected,
  type useRecordedFeedback,
} from "./recordedFeedback";

type Disbursement = NonNullable<DealCockpitViewProps["disbursement"]>;
type SupplierAdvice = Parameters<Disbursement["supplier"]["onConfirm"]>[0];

export function useDealDisbursementActions({
  orgId,
  applicationId,
  version,
  canConfirmFinanceDisbursement,
  trackRecorded,
  t,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  version: number | undefined;
  canConfirmFinanceDisbursement: boolean;
  trackRecorded: ReturnType<typeof useRecordedFeedback>["track"];
  t: (key: string) => string;
}>) {
  const confirmDisbursement = useMutation(api.applications.confirmDisbursement);
  const confirmSupplierDisbursement = useMutation(
    api.applications.confirmSupplierDisbursement,
  );
  const returnFinanceDisbursementCheque = useMutation(
    api.applications.returnFinanceDisbursementCheque,
  );

  const [confirmingDisbursement, setConfirmingDisbursement] = useState(false);
  // SCRUM-239: the "cheque returned by bank" dialog. The idempotency key is made
  // once per dialog open (and again only if the reason changes, because the
  // server fingerprints the reason: a replay must be the same command).
  const [chequeReturnOpen, setChequeReturnOpen] = useState(false);
  const [chequeReturnSubmitting, setChequeReturnSubmitting] = useState(false);
  const chequeReturnKeyRef = useRef<{ key: string; reason: string } | null>(
    null,
  );
  const [confirmingSupplierDisbursement, setConfirmingSupplierDisbursement] =
    useState(false);
  const [disbursementSubmitting, setDisbursementSubmitting] = useState(false);
  const confirmDisbursementKeyRef = useRef<string | null>(null);
  // The disbursement version the kept confirm key was minted for. The server
  // binds a key to one version (SCRUM-239); if the observed version moved - a
  // colleague returned the cheque - the kept key is stale and a fresh one is
  // minted instead of being refused.
  const confirmDisbursementKeyVersionRef = useRef(1);
  // SCRUM-239 round 4: the disbursement version observed WHEN the confirm dialog
  // opened. The confirm binds to THIS, never to whatever the screen shows at
  // click time: a dialog opened at v1 must not be able to confirm v2 (the
  // replacement cheque) just because a colleague returned the v1 cheque while it
  // stood open.
  const [confirmObservedVersion, setConfirmObservedVersion] = useState(1);
  // A ref mirror of the state above: an async confirm closes over the render it
  // was clicked in, so a late answer must compare against THIS, not its closure.
  const confirmObservedVersionRef = useRef(1);
  // The version a confirm was SENT under whose outcome this screen does not know
  // (sent, no answer yet or a lost response). It belongs to the confirm KEY, not
  // the version: once any send of a key is lost, only a SUCCESS for that key
  // resolves it. A refusal of a LATER retry of the same key proves nothing about
  // the earlier send, so it must not clear the mark; a refusal of a send with no
  // earlier unknown send can. It decides whether "nothing was confirmed" is
  // still a true thing to say.
  const confirmUnknownOutcomeVersionRef = useRef<number | null>(null);
  // An unobserved version must not reconcile a kept version-one command.
  const appObserved = version !== undefined;
  const observedDisbursementVersion = version ?? 1;
  // SCRUM-54: the physical bank a BANK_TRANSFER / CHEQUE receipt reached, named
  // by the operator on every open - never preselected, never carried over. The
  // kept confirm key is bound to the bank it was minted for (like the version):
  // a different bank is a different command, and the server's already-confirmed
  // refusal keeps a changed bank from double-posting after a lost response.
  const [disbursementBankId, setDisbursementBankId] = useState("");
  const confirmDisbursementKeyBankRef = useRef("");
  const disbursementBankOptions = useQuery(
    api.applications.listDisbursementBankOptions,
    confirmingDisbursement && canConfirmFinanceDisbursement
      ? { orgId, applicationId }
      : "skip",
  );
  const setConfirmingDisbursementObserved = (open: boolean) => {
    if (open) {
      setConfirmObservedVersion(observedDisbursementVersion);
      setDisbursementBankId("");
    }
    setConfirmingDisbursement(open);
  };
  useEffect(() => {
    confirmObservedVersionRef.current = confirmObservedVersion;
  }, [confirmObservedVersion]);
  // SCRUM-522 L-C: this state belongs to ONE deal. The cockpit can be re-rendered
  // with another `applicationId` without a remount, and a key kept for deal A (or
  // the record that an outcome-unknown notice for A is still owed) must never be
  // sent for, or shown on, deal B. Declared BEFORE the reconcile effect below so
  // that, in the commit where the id changes, the owed mark is gone before that
  // effect can read it.
  const confirmStateApplicationIdRef = useRef(applicationId);
  const confirmSupplierDisbursementKeyRef = useRef<string | null>(null);
  // Bumped on every deal switch. A confirm captures it when it starts; an answer
  // that settles under a different generation belongs to a deal that is gone and
  // may change NOTHING (no key, no mark, no dialog, no notice, no in-flight flag).
  const confirmGenerationRef = useRef(0);
  useEffect(() => {
    if (confirmStateApplicationIdRef.current === applicationId) return;
    confirmStateApplicationIdRef.current = applicationId;
    confirmGenerationRef.current += 1;
    // B never inherits A's in-flight flag (A's late `finally` is fenced off below).
    setDisbursementSubmitting(false);
    confirmDisbursementKeyRef.current = null;
    confirmDisbursementKeyVersionRef.current = 1;
    confirmUnknownOutcomeVersionRef.current = null;
    confirmObservedVersionRef.current = 1;
    setConfirmObservedVersion(1);
    setConfirmingDisbursement(false);
    // The supplier-advice and cheque-return writers share the same invariant: no
    // key, dialog or flag of deal A survives on deal B.
    confirmSupplierDisbursementKeyRef.current = null;
    setConfirmingSupplierDisbursement(false);
    chequeReturnKeyRef.current = null;
    setChequeReturnOpen(false);
    setChequeReturnSubmitting(false);
  }, [applicationId]);
  // SCRUM-239 round 7: the ONE place a version move is reconciled, whether the
  // dialog is open or closed. `confirmUnknownOutcomeVersionRef` is the record that
  // an outcome-unknown notice is still OWED for the kept key; it is cleared only by
  // a success, a refusal with no earlier unknown send, this operator's own
  // successful return (the outcome is then known), or by the notice being shown
  // here or in the confirm's catch, whichever resolves it first, exactly once.
  // While this operator's own cheque return is in flight a version move may be
  // that very return (which proves the confirm committed), so the reconcile waits
  // for it to settle and re-runs then.
  // In the commit where the deal switches, this closure still holds deal A's
  // `confirmingDisbursement` / `confirmObservedVersion` (the switch effect's resets
  // only land on the NEXT render) and would compare them with B's observed
  // version. The switch effect runs first and has already cleared the refs, so
  // this commit is skipped once per deal; the reset state re-triggers the effect
  // (its deps change) and every later pass sees B's own state.
  const reconciledApplicationIdRef = useRef(applicationId);
  useEffect(() => {
    if (reconciledApplicationIdRef.current !== applicationId) {
      reconciledApplicationIdRef.current = applicationId;
      return;
    }
    if (!appObserved || chequeReturnSubmitting) return;
    const owedUnknown =
      confirmUnknownOutcomeVersionRef.current !== null &&
      confirmUnknownOutcomeVersionRef.current !== observedDisbursementVersion;
    const movedUnderDialog =
      confirmingDisbursement &&
      observedDisbursementVersion !== confirmObservedVersion;
    if (!owedUnknown && !movedUnderDialog) return;
    // "Nothing was confirmed" is true only if nothing was sent; a sent confirm
    // with a lost response may have committed, and the operator must be told to
    // check receipts and cheque history even if the dialog was already closed.
    confirmDisbursementKeyRef.current = null;
    confirmUnknownOutcomeVersionRef.current = null;
    if (movedUnderDialog) setConfirmingDisbursement(false);
    toast.error(
      t(
        owedUnknown
          ? "DisbursementChangedOutcomeUnknown"
          : "DisbursementChangedWhileConfirming",
      ),
    );
  }, [
    appObserved,
    applicationId,
    chequeReturnSubmitting,
    confirmingDisbursement,
    observedDisbursementVersion,
    confirmObservedVersion,
    t,
  ]);

  async function returnCheque(
    chequeId: Id<"postDatedCheques"> | null | undefined,
    reason: string,
  ) {
    if (!chequeId) return;
    const returnedVersion = version;
    setChequeReturnSubmitting(true);
    const chequeGeneration = confirmGenerationRef.current;
    const chequeSuperseded = () =>
      confirmGenerationRef.current !== chequeGeneration;
    // One key per dialog open: a retry after a lost response is the SAME command.
    if (chequeReturnKeyRef.current?.reason !== reason) {
      chequeReturnKeyRef.current = {
        key: `return-fc-cheque:${crypto.randomUUID()}`,
        reason,
      };
    }
    const { key } = chequeReturnKeyRef.current;
    try {
      await trackRecorded(
        () =>
          returnFinanceDisbursementCheque({
            orgId,
            applicationId,
            chequeId,
            returnReason: reason,
            idempotencyKey: key,
          }),
        "ChequeReturnedByBankSuccess",
        // The disbursement is gone from the application AND this cheque is the newest returned one.
        { reflectedWhen: disbursementReturnReflected(chequeId) },
      );
      // A late answer for deal A must not drop B's kept key or owed notice.
      if (chequeSuperseded()) return;
      chequeReturnKeyRef.current = null;
      // The return reopens the deal for the NEXT disbursement version.
      // A confirm key kept after a lost response belongs to the
      // disbursement just returned; reusing it would make the server
      // replay that old result and never record the next one.
      confirmDisbursementKeyRef.current = null;
      // Round 7: the outcome of a lost confirm at this version is now
      // KNOWN. The server returns a cheque only for a confirmed
      // disbursement. The backend checks that the cleared cheque belongs to
      // the disbursement at the same version and instant.
      // So no "result not known" notice is owed for that version. Cleared
      // here, before `chequeReturnSubmitting` resets and lets the
      // reconcile effect run.
      if (
        returnedVersion !== undefined &&
        confirmUnknownOutcomeVersionRef.current === returnedVersion
      ) {
        confirmUnknownOutcomeVersionRef.current = null;
      }
      setChequeReturnOpen(false);
    } catch (error) {
      if (chequeSuperseded()) return;
      // The server answered: the next attempt is a new command. A lost response keeps the key.
      if (isConvexError(error)) chequeReturnKeyRef.current = null;
      toast.error(getLocalizedErrorMessage(error, t));
    } finally {
      if (!chequeSuperseded()) setChequeReturnSubmitting(false);
    }
  }

  async function confirmFinanceReceipt(
    expectedDisbursementMinor: number | undefined,
  ) {
    if (!expectedDisbursementMinor) return;
    // The bank this request is for, fixed at click time. Absent
    // for CASH; a bank receipt cannot be sent without one.
    const bankAccountId =
      disbursementBankOptions?.needsBank === false ? "" : disbursementBankId;
    if (disbursementBankOptions?.needsBank !== false && bankAccountId === "")
      return;
    // The version captured when the dialog OPENED, not the one the
    // screen shows now (the dialog closes itself if that moves).
    // Held in the closure so this request's answer, however late,
    // is judged against ITS version.
    const observedVersion = confirmObservedVersion;
    // Round 7 defence: an owed notice for another version is never
    // dropped by minting a new key. The reconcile effect normally
    // shows it first; it can only still be owed here while an own
    // cheque return was in flight and holding the effect back. The
    // notice tells the operator to review receipts and cheque history
    // BEFORE confirming again, so this click sends nothing: the mark
    // and kept key are cleared, and the next click mints a fresh key
    // at the observed version. (Nothing is stuck by returning here:
    // `disbursementSubmitting` is only set below.)
    if (
      confirmUnknownOutcomeVersionRef.current !== null &&
      confirmUnknownOutcomeVersionRef.current !== observedVersion
    ) {
      confirmUnknownOutcomeVersionRef.current = null;
      confirmDisbursementKeyRef.current = null;
      toast.error(t("DisbursementChangedOutcomeUnknown"));
      return;
    }
    // Round 6: an EARLIER send of the kept key at this version whose
    // answer was lost. Read before this send re-marks the ref. A fresh
    // key (a version move or a retired stale key) never inherits it: a
    // version move clears the mark via the effect, and the stale path
    // below clears it explicitly.
    const priorUnknown =
      confirmDisbursementKeyRef.current !== null &&
      confirmDisbursementKeyVersionRef.current === observedVersion &&
      confirmUnknownOutcomeVersionRef.current === observedVersion;
    setDisbursementSubmitting(true);
    const generation = confirmGenerationRef.current;
    const superseded = () => confirmGenerationRef.current !== generation;
    try {
      if (
        confirmDisbursementKeyVersionRef.current !== observedVersion ||
        confirmDisbursementKeyBankRef.current !== bankAccountId
      ) {
        confirmDisbursementKeyRef.current = null;
      }
      confirmDisbursementKeyVersionRef.current = observedVersion;
      confirmDisbursementKeyBankRef.current = bankAccountId;
      confirmDisbursementKeyRef.current ??= `confirm-disbursement:${crypto.randomUUID()}`;
      const disbursementKey = confirmDisbursementKeyRef.current;
      // Sent: until the server answers, the outcome is unknown here.
      confirmUnknownOutcomeVersionRef.current = observedVersion;
      await trackRecorded(
        () =>
          confirmDisbursement({
            orgId,
            applicationId,
            disbursedAmountMinor: expectedDisbursementMinor,
            idempotencyKey: disbursementKey,
            // The version the dialog observed: the server refuses a
            // confirm whose version it has since moved past. Sent ONLY
            // above 1: the frontend deploys on merge but the Convex
            // backend deploys by hand, and Convex rejects an undeclared
            // argument, so a v1 confirm must look exactly like the old
            // call. The server already refuses an omitted value at v2+.
            ...(observedVersion > 1
              ? { expectedDisbursementVersion: observedVersion }
              : {}),
            ...(bankAccountId !== ""
              ? { bankAccountId: bankAccountId as Id<"bankAccounts"> }
              : {}),
          }),
        "DisbursementConfirmedSuccess",
        { reflectedWhen: financeDisbursementReflected },
      );
      // The deal was switched while this was in flight: its answer
      // belongs to deal A and must not touch deal B's state.
      if (superseded()) return;
      // The server answered: the outcome of THIS request is known.
      if (confirmUnknownOutcomeVersionRef.current === observedVersion) {
        confirmUnknownOutcomeVersionRef.current = null;
      }
      // A late answer to an OLD attempt must not touch a dialog
      // reopened at a newer version (its key, its open state).
      if (confirmObservedVersionRef.current === observedVersion) {
        confirmDisbursementKeyRef.current = null;
        setConfirmingDisbursement(false);
      }
    } catch (error) {
      if (superseded()) return;
      // A server answer (a ConvexError) means the request was
      // refused and nothing committed; anything else is a lost
      // response whose outcome stays unknown.
      const answeredByServer = isConvexError(error);
      // ...but only for a send with no earlier unknown send of this key.
      if (
        answeredByServer &&
        !priorUnknown &&
        confirmUnknownOutcomeVersionRef.current === observedVersion
      ) {
        confirmUnknownOutcomeVersionRef.current = null;
      }
      // A stale-version refusal is final for this key: the next click
      // (after the screen refreshes) mints a fresh one.
      const refusedCode = answeredByServer
        ? (error.data as { code?: unknown } | null)?.code
        : undefined;
      const isStale = refusedCode === "FINANCE_CONFIRM_STALE_REQUEST";
      const current = confirmObservedVersionRef.current === observedVersion;
      if (isStale && current) {
        confirmDisbursementKeyRef.current = null;
        // The dialog was prepared against a version that is gone:
        // reopening it observes the current one.
        setConfirmingDisbursement(false);
      }
      if (isStale && !current) {
        // A late answer to a superseded attempt: its dialog is gone
        // and a newer one is open; say nothing about it.
        return;
      }
      if (isStale && priorUnknown) {
        // An earlier send of this key may have committed, so "nothing
        // has been changed" would be untrue. The notice is owed only
        // while the mark still stands: if the version-move effect
        // already showed it and cleared the mark, say nothing more
        // (the stale text claims nothing changed). Otherwise show it
        // now and drop the mark so the effect cannot repeat it.
        if (confirmUnknownOutcomeVersionRef.current === observedVersion) {
          confirmUnknownOutcomeVersionRef.current = null;
          toast.error(t("DisbursementChangedOutcomeUnknown"));
        }
        return;
      }
      toast.error(getLocalizedErrorMessage(error, t));
    } finally {
      if (!superseded()) setDisbursementSubmitting(false);
    }
  }

  async function confirmSupplierAdvice(
    advice: SupplierAdvice,
    economicsFactor: number,
  ) {
    setDisbursementSubmitting(true);
    const generation = confirmGenerationRef.current;
    const superseded = () => confirmGenerationRef.current !== generation;
    try {
      confirmSupplierDisbursementKeyRef.current ??= `confirm-supplier-disbursement:${crypto.randomUUID()}`;
      const supplierDisbursementKey = confirmSupplierDisbursementKeyRef.current;
      await trackRecorded(
        () =>
          confirmSupplierDisbursement({
            orgId,
            applicationId,
            // Scaled by the APPLICATION's pinned economics currency —
            // this figure lives in that block.
            disbursedAmountMinor: Math.round(
              advice.amountMajor * economicsFactor,
            ),
            reference: advice.reference,
            disbursedAt: advice.disbursedAt,
            idempotencyKey: supplierDisbursementKey,
          }),
        "SupplierDisbursementConfirmedSuccess",
        { reflectedWhen: supplierDisbursementReflected },
      );
      // Answer for a deal that is gone: change nothing on this one.
      if (superseded()) return;
      confirmSupplierDisbursementKeyRef.current = null;
      setConfirmingSupplierDisbursement(false);
    } catch (error) {
      if (superseded()) return;
      toast.error(getErrorMessage(error));
    } finally {
      if (!superseded()) setDisbursementSubmitting(false);
    }
  }

  const bank: Disbursement["financeCompany"]["bank"] =
    disbursementBankOptions?.needsBank === false
      ? undefined
      : {
          options: disbursementBankOptions?.banks,
          value: disbursementBankId,
          onChange: setDisbursementBankId,
          truncated: disbursementBankOptions?.truncated === true,
          receivableMissing:
            disbursementBankOptions?.receivableMissing === true,
        };

  return {
    financeCompany: {
      confirming: confirmingDisbursement,
      submitting: disbursementSubmitting,
      bank,
      onOpenChange: setConfirmingDisbursementObserved,
    },
    supplier: {
      confirming: confirmingSupplierDisbursement,
      submitting: disbursementSubmitting,
      onOpenChange: setConfirmingSupplierDisbursement,
    },
    chequeReturn: {
      open: chequeReturnOpen,
      submitting: chequeReturnSubmitting,
      onOpen: () => {
        chequeReturnKeyRef.current = null;
        setChequeReturnOpen(true);
      },
      onClose: () => {
        chequeReturnKeyRef.current = null;
        setChequeReturnOpen(false);
      },
    },
    confirmFinanceReceipt,
    confirmSupplierAdvice,
    returnCheque,
  };
}

export function buildDealDisbursementPresentation({
  deal,
  app,
  disbursementActions,
  forward,
  economicsFactor,
  expectedDisbursementLabel,
  expectedDisbursementMinor,
  formatEconomics,
  supplierName,
  t,
}: Readonly<{
  deal:
    | FunctionReturnType<typeof api.dealWorkspace.financedDealCockpit>
    | undefined;
  app: FunctionReturnType<typeof api.applications.get> | undefined;
  disbursementActions: ReturnType<typeof useDealDisbursementActions>;
  forward: NonNullable<DealCockpitViewProps["disbursement"]>["forward"];
  economicsFactor: number;
  expectedDisbursementLabel: string;
  expectedDisbursementMinor: number;
  formatEconomics: (minor: number) => string;
  supplierName?: string;
  t: (key: string) => string;
}>) {
  const chequeReturn: DealCockpitViewProps["chequeReturn"] =
    deal?.disbursementReturn?.mayReturn === true &&
    deal.disbursementReturn.chequeId &&
    deal.forward?.transferConfirmed === true
      ? {
          ...disbursementActions.chequeReturn,
          onConfirm: (reason) =>
            disbursementActions.returnCheque(
              deal.disbursementReturn?.chequeId,
              reason,
            ),
        }
      : undefined;
  const disbursement: DealCockpitViewProps["disbursement"] = app
    ? {
        financeCompany: {
          ...disbursementActions.financeCompany,
          amountLabel: expectedDisbursementLabel,
          onConfirm: () =>
            disbursementActions.confirmFinanceReceipt(
              expectedDisbursementMinor,
            ),
        },
        forward: forward,
        supplier: {
          ...disbursementActions.supplier,
          supplierName,
          // The approved purchase amount — what the company approved to
          // pay for the CAR — labelled in the currency it is denominated
          // in, or "not recorded" rather than a confident zero.
          amountLabel:
            app.approvedDealerPurchaseAmountMinor !== undefined
              ? formatEconomics(app.approvedDealerPurchaseAmountMinor)
              : t("NotRecorded"),
          defaultAmountMajor:
            app.approvedDealerPurchaseAmountMinor !== undefined
              ? app.approvedDealerPurchaseAmountMinor / economicsFactor
              : undefined,
          onConfirm: (advice) =>
            disbursementActions.confirmSupplierAdvice(advice, economicsFactor),
        },
      }
    : undefined;
  return { chequeReturn, disbursement };
}
