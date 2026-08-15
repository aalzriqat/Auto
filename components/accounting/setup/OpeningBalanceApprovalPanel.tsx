"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { format, isValid } from "date-fns";
import { CheckCircle2, Loader2, ShieldAlert, XCircle } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { errorMessage, scaleForCurrency } from "../AccountingTabShared";

export type PendingOpeningBalanceLine = {
  accountId: string;
  accountName: string;
  debitMinor: number;
  creditMinor: number;
};

export type PendingOpeningBalanceDraft = {
  _id: string;
  asOfDate: number;
  memo?: string;
  createdBy: string;
  preparedByName: string | null;
  currency: string;
  /**
   * Whether the draft recorded the currency its amounts were entered in.
   *
   * False for any draft created before that snapshot existed — which is NOT
   * hypothetical: `draftOpeningBalance` was already reachable from
   * OpeningBalanceCard, so every org whose accountant hit the approval
   * dead-end has a stranded draft in exactly this state. Those are the orgs
   * this panel is built for, so they are the ones most likely to meet it.
   *
   * `approveOpeningBalance` refuses such a draft rather than guessing its
   * denomination. Mirroring that refusal here is the difference between an
   * explained disabled button and a raw error toast after the click.
   */
  denominationKnown: boolean;
  lines: PendingOpeningBalanceLine[];
};

/**
 * `date-fns` `format()` throws on a non-finite or out-of-range timestamp, and a
 * throw here would take out the whole Setup tab — the one screen that can
 * resolve the draft. `Number.isFinite` alone is not enough: JS `Date` tops out
 * at ±8.64e15, so `1e300` is finite and still unrenderable. Same guard the
 * SCRUM-45/46 class of defect calls for.
 */
function safeDateLabel(ms: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return isValid(date) ? format(date, "d MMM yyyy") : null;
}

/**
 * Formats an amount ONLY when the draft's denomination is known.
 *
 * `listPendingOpeningBalanceDrafts` falls back to the org's current currency
 * for a draft that never recorded one. Formatting at that fallback would render
 * a historic JOD amount at USD scale — the same minor units shown 10x wrong —
 * directly beside a line saying the denomination is unknown. Approval is
 * already fail-closed, so this cannot corrupt the ledger; it can absolutely
 * mislead the human deciding whether to reject. So the raw stored minor units
 * are shown instead, explicitly labelled.
 */
function formatMinor(amountMinor: number, currency: string, denominationKnown: boolean): string {
  if (!denominationKnown) return String(amountMinor);
  const scale = scaleForCurrency(currency);
  return (amountMinor / Math.pow(10, scale)).toLocaleString(undefined, {
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  });
}

/**
 * What this viewer may do with this draft, and why not.
 *
 * Round 3 halted iterative patching on this component. The view had grown four
 * independent boolean disable-reasons, each rendering its own advisory line,
 * with no model of WHICH viewer was blocked or what they should do instead —
 * and the combination nobody checked (the preparer looking at their own
 * undenominated draft) produced a screen that said "reject it and submit it
 * again" directly above "you cannot reject it yourself", with Reject disabled.
 *
 * The fix is structural rather than another condition: blocking FACTS about
 * the draft and the RECOVERY INSTRUCTION for this viewer are computed
 * separately and composed. Facts are properties of the draft and do not vary
 * by viewer; the instruction depends only on whether this viewer may reject.
 * Contradictory guidance stops being something to remember not to write and
 * becomes unrepresentable.
 */
export type ApprovalGate = {
  canApprove: boolean;
  canReject: boolean;
  /** Why approval is blocked — properties of the draft, viewer-independent. */
  blockingFacts: Array<{ key: string; testId: string }>;
  /** What THIS viewer should do about it, or null when nothing blocks. */
  recoveryKey: string | null;
};

export function computeApprovalGate(args: {
  isOwnDraft: boolean;
  busy: boolean;
  balanced: boolean;
  denominationKnown: boolean;
}): ApprovalGate {
  const { isOwnDraft, busy, balanced, denominationKnown } = args;

  const blockingFacts: ApprovalGate["blockingFacts"] = [];
  if (!balanced) {
    blockingFacts.push({ key: "OpeningBalanceUnbalanced", testId: "opening-balance-unbalanced" });
  }
  if (!denominationKnown) {
    blockingFacts.push({
      key: "OpeningBalanceCurrencyUnknown",
      testId: "opening-balance-unknown-currency",
    });
  }

  // Segregation of duties is the server's rule (approveOpeningBalance and
  // rejectOpeningBalanceDraft both refuse preparer === approver), so it gates
  // BOTH actions — which is precisely why the recovery instruction has to
  // change for the preparer instead of telling them to do something they
  // cannot.
  const canReject = !isOwnDraft && !busy;
  const canApprove = canReject && balanced && denominationKnown;

  let recoveryKey: string | null = null;
  if (isOwnDraft) {
    recoveryKey =
      blockingFacts.length > 0
        ? "OpeningBalanceOwnDraftNeedsAnotherReviewer"
        : "OpeningBalanceSegregationOfDutiesNotice";
  } else if (blockingFacts.length > 0) {
    recoveryKey = "OpeningBalanceRejectAndResubmit";
  }

  return { canApprove, canReject, blockingFacts, recoveryKey };
}

type OpeningBalanceApprovalViewProps = {
  draft: PendingOpeningBalanceDraft | null;
  isOwnDraft: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: (reason: string) => void;
};

/**
 * Presentational half, kept free of Convex so it can be rendered in a test.
 * Every defect this panel exists to prevent is a *rendering* question — can the
 * reviewer see who prepared it, what it says, and whether they are allowed to
 * act — so the seam is deliberately where it can be asserted.
 */
export function OpeningBalanceApprovalView({
  draft,
  isOwnDraft,
  busy,
  onApprove,
  onReject,
}: Readonly<OpeningBalanceApprovalViewProps>) {
  const { t } = useLanguage();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonMissing, setReasonMissing] = useState(false);

  // Nothing pending is the overwhelmingly common case, and Setup is the tab
  // every accounting user lands on. An empty-state box here would be permanent
  // noise on the busiest screen in the section.
  if (!draft) return null;

  const totalDebitMinor = draft.lines.reduce((sum, line) => sum + line.debitMinor, 0);
  const totalCreditMinor = draft.lines.reduce((sum, line) => sum + line.creditMinor, 0);
  const balanced = totalDebitMinor === totalCreditMinor;
  const asOf = safeDateLabel(draft.asOfDate);
  const gate = computeApprovalGate({
    isOwnDraft,
    busy,
    balanced,
    denominationKnown: draft.denominationKnown,
  });

  return (
    <section
      data-testid="opening-balance-approval"
      className="rounded-md border border-amber-200 bg-amber-50/60 p-4 space-y-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              {t("OpeningBalanceAwaitingApproval")}
            </h3>
            {/* The preparer's name and the date are each wrapped in their own
                `<bdi>` rather than interpolated into the translated sentence.
                In Arabic the surrounding run is RTL while a Latin name is LTR,
                and an un-isolated bidi run reorders visually — the reviewer
                would read a mangled name on exactly the screen where knowing
                who prepared it is the whole control. */}
            <p data-testid="opening-balance-meta" className="text-sm text-amber-900">
              {t("OpeningBalancePreparedBy")}{" "}
              <bdi className="font-medium">
                {draft.preparedByName ?? t("OpeningBalancePreparerUnknown")}
              </bdi>
              {asOf ? (
                <>
                  {" · "}
                  {t("OpeningBalanceAsOf")} <bdi>{asOf}</bdi>
                </>
              ) : null}
              {/* The DRAFT's own currency, deliberately not `useCurrency()`.
                  Every sibling accounting tab reads the org's current currency,
                  and doing that here would state the one thing SCRUM-62 exists
                  to stop assuming: a draft prepared in JOD is still a JOD draft
                  after the org switches to USD. Omitted entirely when the
                  denomination is unknown — the query falls back to the org
                  currency there, and naming that fallback would assert exactly
                  the fact the red line below says is missing. */}
              {draft.denominationKnown ? (
                <>
                  {" · "}
                  {t("Currency")} <bdi className="font-medium">{draft.currency}</bdi>
                </>
              ) : null}
            </p>
            {draft.memo ? (
              <p className="mt-1 text-sm text-slate-600">{draft.memo}</p>
            ) : null}
          </div>
        </div>
        <span className="shrink-0 rounded-full border border-amber-300 bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
          {t("Pending")}
        </span>
      </div>

      {/* Headers are not decoration on this table. Without them the reviewer is
          shown two unlabelled number columns and asked to approve the whole
          organization's starting GL position — and which side is which flips
          visually between LTR and RTL, so there is no stable convention to fall
          back on. Same reasoning as the account-name fallback below: approving
          what you cannot read is the rubber-stamp this panel exists to prevent. */}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-amber-300 text-xs uppercase tracking-wide text-amber-900">
            <th scope="col" className="py-1 text-start font-medium">
              {t("Account")}
            </th>
            <th scope="col" className="py-1 ps-3 text-end font-medium">
              {t("Debit")}
            </th>
            <th scope="col" className="py-1 ps-3 text-end font-medium">
              {t("Credit")}
            </th>
          </tr>
        </thead>
        <tbody>
          {draft.lines.map((line, index) => (
            <tr key={`${index}-${line.accountId}`} className="border-t border-amber-200/70">
              <td className="py-1.5 text-slate-800">{line.accountName}</td>
              <td className="py-1.5 ps-3 text-end tabular-nums whitespace-nowrap text-slate-800">
                {line.debitMinor > 0 ? formatMinor(line.debitMinor, draft.currency, draft.denominationKnown) : ""}
              </td>
              <td className="py-1.5 ps-3 text-end tabular-nums whitespace-nowrap text-slate-800">
                {line.creditMinor > 0 ? formatMinor(line.creditMinor, draft.currency, draft.denominationKnown) : ""}
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-amber-300 font-semibold">
            <td className="py-1.5 text-slate-900">{t("Total")}</td>
            {/* ps-3 + nowrap: the debit and credit totals rendered with a
                MEASURED 0px gap at 390px, so the one pair of figures a reviewer
                uses to check that the draft balances read as a single
                22-character run. The columns are sized by content and sit flush
                otherwise, so the padding is what guarantees the separation. */}
            <td className="py-1.5 ps-3 text-end tabular-nums whitespace-nowrap text-slate-900">
              {formatMinor(totalDebitMinor, draft.currency, draft.denominationKnown)}
            </td>
            <td className="py-1.5 ps-3 text-end tabular-nums whitespace-nowrap text-slate-900">
              {formatMinor(totalCreditMinor, draft.currency, draft.denominationKnown)}
            </td>
          </tr>
        </tbody>
      </table>

      {/* Facts first, then the one instruction for this viewer. Never both a
          "reject it" and a "you cannot reject it" line — see computeApprovalGate. */}
      {gate.blockingFacts.map((fact) => (
        <p key={fact.key} data-testid={fact.testId} className="text-sm font-medium text-red-700">
          {t(fact.key)}
        </p>
      ))}

      {!draft.denominationKnown && (
        <p className="text-xs text-slate-600">{t("OpeningBalanceRawMinorUnitsNote")}</p>
      )}

      {gate.recoveryKey && (
        <p data-testid="opening-balance-recovery" className="text-sm text-amber-800">
          {t(gate.recoveryKey)}
        </p>
      )}

      {rejecting && (
        <div className="space-y-1">
          <Textarea
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              if (reasonMissing) setReasonMissing(false);
            }}
            placeholder={t("OpeningBalanceRejectionReasonPlaceholder")}
            className="bg-white"
            data-testid="opening-balance-reject-reason"
          />
          {reasonMissing && (
            <p data-testid="opening-balance-reason-missing" className="text-sm font-medium text-red-700">
              {t("OpeningBalanceRejectionReasonRequired")}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="opening-balance-approve"
          disabled={!gate.canApprove}
          onClick={onApprove}
          className="bg-emerald-600 text-white hover:bg-emerald-700"
        >
          {busy ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="me-2 h-4 w-4" />}
          {t("Approve")}
        </Button>
        <Button
          data-testid="opening-balance-reject"
          variant="outline"
          disabled={!gate.canReject}
          className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
          onClick={() => {
            if (!rejecting) {
              setRejecting(true);
              return;
            }
            // The backend requires a non-empty trimmed reason. Checking here
            // too means an empty submission shows the field's own validation
            // rather than bouncing a raw ConvexError back through a toast —
            // the same thing ManualJournalTab does for its reject flow.
            if (!reason.trim()) {
              setReasonMissing(true);
              return;
            }
            onReject(reason.trim());
          }}
        >
          <XCircle className="me-2 h-4 w-4" />
          {rejecting ? t("ConfirmReject") : t("Reject")}
        </Button>
      </div>
    </section>
  );
}

type OpeningBalanceApprovalPanelProps = {
  orgId: Id<"organizations">;
  /**
   * Passed down rather than derived here, and used to SKIP the query entirely.
   *
   * `listPendingOpeningBalanceDrafts` requires MANAGE_FINANCE, but the whole
   * Accounting route is gated only on `view:finance`
   * (app/(dashboard)/[orgId]/accounting/page.tsx) and roles are customizable
   * per-org — so a read-only bookkeeper role is a supported configuration.
   * Convex `useQuery` re-throws a server error during render, which would take
   * the entire Setup tab down to the dashboard error boundary for that user,
   * every visit. Every sibling on this tab either scopes its query to
   * VIEW_FINANCE or self-gates; this one skips.
   */
  canManageFinance: boolean;
};

/**
 * Data half. Resolves the single PENDING_APPROVAL opening-balance draft and
 * wires the two mutations that, until SCRUM-52, had no caller anywhere in the
 * product — leaving an organization whose accountant (rather than owner)
 * entered the opening balance permanently unable to start its GL.
 */
export function OpeningBalanceApprovalPanel({
  orgId,
  canManageFinance,
}: Readonly<OpeningBalanceApprovalPanelProps>) {
  const { t } = useLanguage();
  const drafts = useQuery(
    api.accountingCutover.listPendingOpeningBalanceDrafts,
    canManageFinance ? { orgId } : "skip"
  );
  const me = useQuery(api.users.getMe, canManageFinance ? {} : "skip");
  const accounts = useQuery(api.chartOfAccounts.list, canManageFinance ? { orgId } : "skip");
  const approve = useMutation(api.accountingCutover.approveOpeningBalance);
  const reject = useMutation(api.accountingCutover.rejectOpeningBalanceDraft);
  const [busy, setBusy] = useState(false);

  const raw = drafts?.[0];
  if (!raw) return null;

  // Both must resolve before any decision is offered. While `accounts` is
  // undefined every line renders its raw account id, and approving ids the
  // reviewer cannot read is exactly the rubber-stamp this panel exists to
  // prevent. While `me` is undefined `isOwnDraft` computes false, briefly
  // offering the preparer an action the backend will refuse.
  const reviewDataLoaded = accounts !== undefined && me !== undefined;

  const accountNameById = new Map((accounts ?? []).map((account) => [account._id as string, account.name]));

  const draft: PendingOpeningBalanceDraft = {
    _id: raw._id,
    asOfDate: raw.asOfDate,
    memo: raw.memo,
    createdBy: raw.createdBy,
    preparedByName: raw.preparedByName,
    currency: raw.currency,
    denominationKnown: raw.denominationKnown,
    lines: raw.lines.map((line) => ({
      accountId: line.accountId as string,
      // Falling back to the id keeps an unresolved account visible rather than
      // rendering a blank row the reviewer would approve without reading.
      accountName: accountNameById.get(line.accountId as string) ?? (line.accountId as string),
      debitMinor: line.debitMinor,
      creditMinor: line.creditMinor,
    })),
  };

  async function run(action: () => Promise<unknown>, successKey: string) {
    setBusy(true);
    try {
      await action();
      toast.success(t(successKey));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <OpeningBalanceApprovalView
      draft={draft}
      isOwnDraft={me?._id === raw.createdBy}
      busy={busy || !reviewDataLoaded}
      onApprove={() =>
        void run(
          () => approve({ orgId, draftId: raw._id as Id<"openingBalanceDrafts"> }),
          "OpeningBalanceApprovedToast"
        )
      }
      onReject={(reason) =>
        void run(
          () =>
            reject({
              orgId,
              draftId: raw._id as Id<"openingBalanceDrafts">,
              rejectionReason: reason,
            }),
          "OpeningBalanceRejectedToast"
        )
      }
    />
  );
}
