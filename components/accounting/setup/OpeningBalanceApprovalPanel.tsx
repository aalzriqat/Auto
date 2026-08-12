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
  preparedByName: string;
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

function formatMinor(amountMinor: number, currency: string): string {
  const scale = scaleForCurrency(currency);
  return (amountMinor / Math.pow(10, scale)).toLocaleString(undefined, {
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  });
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
  // An unbalanced draft is refused by validateManualJournalLines at approval
  // time. Disabling here turns a red toast after the fact into information
  // before the decision.
  const approveDisabled = isOwnDraft || busy || !balanced || !draft.denominationKnown;

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
            <p className="text-sm text-amber-900">
              {t("OpeningBalancePreparedBy")}{" "}
              <bdi className="font-medium">{draft.preparedByName}</bdi>
              {asOf ? (
                <>
                  {" · "}
                  {t("OpeningBalanceAsOf")} <bdi>{asOf}</bdi>
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

      <table className="w-full text-sm">
        <tbody>
          {draft.lines.map((line) => (
            <tr key={`${line.accountId}-${line.debitMinor}-${line.creditMinor}`} className="border-t border-amber-200/70">
              <td className="py-1.5 text-slate-800">{line.accountName}</td>
              <td className="py-1.5 text-end tabular-nums text-slate-800">
                {line.debitMinor > 0 ? formatMinor(line.debitMinor, draft.currency) : ""}
              </td>
              <td className="py-1.5 text-end tabular-nums text-slate-800">
                {line.creditMinor > 0 ? formatMinor(line.creditMinor, draft.currency) : ""}
              </td>
            </tr>
          ))}
          <tr className="border-t-2 border-amber-300 font-semibold">
            <td className="py-1.5 text-slate-900">{t("Total")}</td>
            <td className="py-1.5 text-end tabular-nums text-slate-900">
              {formatMinor(totalDebitMinor, draft.currency)}
            </td>
            <td className="py-1.5 text-end tabular-nums text-slate-900">
              {formatMinor(totalCreditMinor, draft.currency)}
            </td>
          </tr>
        </tbody>
      </table>

      {!balanced && (
        <p data-testid="opening-balance-unbalanced" className="text-sm font-medium text-red-700">
          {t("OpeningBalanceUnbalanced")}
        </p>
      )}

      {!draft.denominationKnown && (
        <p data-testid="opening-balance-unknown-currency" className="text-sm font-medium text-red-700">
          {t("OpeningBalanceCurrencyUnknown")}
        </p>
      )}

      {isOwnDraft && (
        <p className="text-sm text-amber-800">{t("OpeningBalanceSegregationOfDutiesNotice")}</p>
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
          disabled={approveDisabled}
          onClick={onApprove}
          className="bg-emerald-600 text-white hover:bg-emerald-700"
        >
          {busy ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="me-2 h-4 w-4" />}
          {t("Approve")}
        </Button>
        <Button
          data-testid="opening-balance-reject"
          variant="outline"
          disabled={isOwnDraft || busy}
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
