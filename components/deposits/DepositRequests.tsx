"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { PaymentMethodSelect, type PaymentMethod } from "@/components/payments/PaymentMethodSelect";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { useCommandIdentity } from "@/hooks/useCommandIdentity";
import { getLocalizedErrorMessage } from "@/lib/errors";

/**
 * SCRUM-444. A deposit REQUEST is a salesperson saying "the customer is handing
 * over X". It moves no money. These two components are where a manager or
 * accountant turns it into a held deposit (by saying how it was received) or
 * declines it (by saying why), and where the requester sees where it stands.
 *
 * Both share one row so the two places that show a request cannot drift.
 */

type Decision = "confirm" | "reject";

function useDecisionActions(orgId: Id<"organizations">) {
  const { t } = useLanguage();
  const confirmRequest = useMutation(api.depositRequests.confirm);
  const rejectRequest = useMutation(api.depositRequests.reject);
  const withdrawRequest = useMutation(api.depositRequests.withdraw);
  const commandId = useCommandIdentity();
  const [busyId, setBusyId] = useState<string | null>(null);

  const run = async (id: string, work: () => Promise<unknown>, success: string) => {
    setBusyId(id);
    try {
      await work();
      toast.success(success);
    } catch (error) {
      toast.error(getLocalizedErrorMessage(error, t as (key: string) => string));
    } finally {
      setBusyId(null);
    }
  };

  return {
    busyId,
    confirm: (requestId: Id<"depositRequests">, amount: number, method: PaymentMethod) => {
      const intent = `confirm-deposit-request:${requestId}:${amount}:${method}`;
      return run(
        requestId,
        async () => {
          await confirmRequest({
            orgId,
            requestId,
            amount,
            method,
            idempotencyKey: commandId.for(intent),
          });
          commandId.retire(intent);
        },
        t("DepositRequestConfirmedToast" as any)
      );
    },
    reject: (requestId: Id<"depositRequests">, reason: string) =>
      run(
        requestId,
        () => rejectRequest({ orgId, requestId, reason }),
        t("DepositRequestRejectedToast" as any)
      ),
    withdraw: (requestId: Id<"depositRequests">) =>
      run(
        requestId,
        () => withdrawRequest({ orgId, requestId }),
        t("DepositRequestWithdrawnToast" as any)
      ),
  };
}

/** The confirm / reject controls for ONE pending request. */
function DecisionControls({
  orgId,
  requestId,
  amount,
}: {
  orgId: Id<"organizations">;
  requestId: Id<"depositRequests">;
  amount: number;
}) {
  const { t } = useLanguage();
  const actions = useDecisionActions(orgId);
  const [mode, setMode] = useState<Decision | null>(null);
  const [method, setMethod] = useState<PaymentMethod | undefined>(undefined);
  const [reason, setReason] = useState("");
  const busy = actions.busyId === requestId;

  if (mode === null) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setMode("confirm")} data-testid="deposit-request-confirm-open">
          {t("DepositRequestConfirmAction" as any)}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setMode("reject")}
          data-testid="deposit-request-reject-open"
        >
          {t("DepositRequestRejectAction" as any)}
        </Button>
      </div>
    );
  }

  if (mode === "confirm") {
    return (
      <div className="flex flex-wrap items-center gap-2" data-testid="deposit-request-confirm-form">
        <div className="w-full sm:w-44">
          <PaymentMethodSelect
            t={t as any}
            value={method}
            onValueChange={setMethod}
            ariaLabel={t("PaymentMethodLabel" as any)}
            placeholder={t("DepositChooseMethod" as any)}
          />
        </div>
        <Button
          size="sm"
          disabled={busy || !method}
          onClick={() => method && void actions.confirm(requestId, amount, method)}
          data-testid="deposit-request-confirm-submit"
        >
          {t("DepositRequestReceivedConfirm" as any)}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
          {t("Cancel" as any)}
        </Button>
        {!method ? (
          <p className="w-full text-xs text-muted-foreground">{t("DepositMethodRequired" as any)}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="deposit-request-reject-form">
      <Input
        className="h-8 w-full text-xs sm:w-64"
        placeholder={t("DepositRequestRejectReason" as any)}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <Button
        size="sm"
        variant="destructive"
        disabled={busy || reason.trim().length === 0}
        onClick={() => void actions.reject(requestId, reason.trim())}
        data-testid="deposit-request-reject-submit"
      >
        {t("DepositRequestRejectAction" as any)}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
        {t("Cancel" as any)}
      </Button>
    </div>
  );
}

/**
 * Every request on one quote. Shown to the salesperson so "requested — awaiting
 * confirmation" is never mistaken for money received: a pending request counts
 * as zero paid everywhere.
 */
export function QuoteDepositRequests({
  orgId,
  quoteId,
}: {
  orgId: Id<"organizations">;
  quoteId: Id<"quotes">;
}) {
  const { t, isRtl } = useLanguage();
  const data = useQuery(api.depositRequests.listForQuote, { orgId, quoteId });
  const actions = useDecisionActions(orgId);

  const rows = data?.requests ?? [];
  if (!data || rows.length === 0) return null;

  const money = (amount: number) =>
    amount.toLocaleString(isRtl ? "ar-JO" : "en-JO", { maximumFractionDigits: 3 });

  return (
    <section className="space-y-2 rounded-lg border p-4" data-testid="quote-deposit-requests">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {t("DepositRequestsTitle" as any)}
      </h3>
      <ul className="divide-y">
        {rows.map((row) => (
          <li key={row._id} className="space-y-2 py-2.5 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-semibold tabular-nums">
                {money(row.amount)} {row.currency}
              </span>
              <span
                className="text-xs text-muted-foreground"
                data-testid={`deposit-request-status-${row.status}`}
              >
                {t(`DepositRequestStatus_${row.status}` as any)}
              </span>
              {row.note ? <span className="text-xs text-muted-foreground">{row.note}</span> : null}
            </div>
            {row.status === "REJECTED" && row.resolutionReason ? (
              <p className="text-xs text-muted-foreground">{row.resolutionReason}</p>
            ) : null}
            {row.status === "PENDING" ? (
              data.canConfirm ? (
                <DecisionControls orgId={orgId} requestId={row._id} amount={row.amount} />
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs text-muted-foreground">
                    {t("DepositRequestAwaitingManager" as any)}
                  </p>
                  {row.isMine ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={actions.busyId === row._id}
                      onClick={() => void actions.withdraw(row._id)}
                      data-testid="deposit-request-withdraw"
                    >
                      {t("DepositRequestWithdrawAction" as any)}
                    </Button>
                  ) : null}
                </div>
              )
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The organization-wide queue for whoever may confirm receipt. The server only
 * answers this to `confirm:finance_disbursement`, so a caller without it sees
 * nothing rather than a list they cannot act on.
 */
export function PendingDepositRequestsQueue({ orgId }: { orgId: Id<"organizations"> }) {
  const { t, isRtl } = useLanguage();
  const { hasPermission } = usePermissions();
  // The server refuses this query to anyone without the authority, and a refused
  // query throws into render, so it is not asked unless it will be answered.
  const pending = useQuery(
    api.depositRequests.listPending,
    hasPermission(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT) ? { orgId } : "skip"
  );

  const rows = pending ?? [];
  if (rows.length === 0) return null;

  const money = (amount: number) =>
    amount.toLocaleString(isRtl ? "ar-JO" : "en-JO", { maximumFractionDigits: 3 });

  return (
    <section className="space-y-2 rounded-lg border border-amber-500/40 p-4" data-testid="pending-deposit-requests">
      <h3 className="text-sm font-semibold">{t("DepositRequestsQueueTitle" as any)}</h3>
      <p className="text-xs text-muted-foreground">{t("DepositRequestsQueueDesc" as any)}</p>
      <ul className="divide-y">
        {rows.map((row) => (
          <li key={row._id} className="space-y-2 py-2.5 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-semibold tabular-nums">
                {money(row.amount)} {row.currency}
              </span>
              <span>{row.customerName}</span>
              <span className="text-xs text-muted-foreground">{row.vehicleLabel}</span>
              <span className="text-xs text-muted-foreground">{row.requestedByName}</span>
            </div>
            {row.note ? <p className="text-xs text-muted-foreground">{row.note}</p> : null}
            <DecisionControls orgId={orgId} requestId={row._id} amount={row.amount} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The same requests as the deal cockpit sees them (SCRUM-444). A deal being
 * finalized is where an accountant or manager actually is, so a waiting request
 * is shown THERE with the decision at hand — not only on the Approvals page.
 * Everyone else sees a read-only line that says who has to act, because the
 * server refuses to end a deal while a request waits and a refusal with no
 * explanation is a dead end.
 */
export function DealPendingDepositRequests({
  orgId,
  requests,
}: {
  orgId: Id<"organizations">;
  requests: ReadonlyArray<{
    _id: Id<"depositRequests">;
    amount: number;
    currency: string;
  }>;
}) {
  const { t, isRtl } = useLanguage();
  const { hasPermission } = usePermissions();
  const canDecide = hasPermission(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
  if (requests.length === 0) return null;

  const money = (amount: number) =>
    amount.toLocaleString(isRtl ? "ar-JO" : "en-JO", { maximumFractionDigits: 3 });

  return (
    <div
      className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/30"
      data-testid="deal-pending-deposit-requests"
    >
      <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
        {t("DealDepositRequestPendingTitle" as any)}
      </p>
      <ul className="space-y-2">
        {requests.map((request) => (
          <li key={request._id} className="space-y-1.5 text-sm">
            <span className="font-semibold tabular-nums">
              {money(request.amount)} {request.currency}
            </span>
            {canDecide ? (
              <DecisionControls orgId={orgId} requestId={request._id} amount={request.amount} />
            ) : (
              <p className="text-xs text-amber-800 dark:text-amber-300" data-testid="deal-pending-deposit-readonly">
                {t("DealDepositRequestPendingReadonly" as any)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}