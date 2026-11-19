"use client";

import { useMutation, useQuery } from "convex/react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useCommandIdentity } from "@/hooks/useCommandIdentity";
import { getLocalizedErrorMessage, isConvexError } from "@/lib/errors";
import {
  CustomerFinanceCompanyPaymentCard,
  type CustomerFinanceCompanyPayment,
} from "./CustomerFinanceCompanyPaymentCard";

type FirstPaymentId = Id<"customerFinanceCompanyPayments">;

export function FirstPaymentEvidenceCard({
  orgId,
  applicationId,
  factor,
  money,
  t,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  factor: number;
  money: (minor: number) => string;
  t: (key: string) => string;
}>) {
  const detail = useQuery(api.customerFinanceCompanyPayments.firstPayment, { orgId, applicationId });
  const confirm = useMutation(api.customerFinanceCompanyPayments.confirmFirstPayment);
  const takeBack = useMutation(api.customerFinanceCompanyPayments.voidFirstPayment);
  const commandId = useCommandIdentity();

  if (detail === undefined) return null;
  const { proof } = detail;
  const records: readonly CustomerFinanceCompanyPayment<FirstPaymentId>[] = detail.records;
  if (proof.status === "UNAVAILABLE") {
    return <p role="status" className="text-sm">{t("ClosingReason_FIRST_PAYMENT_PROOF_UNAVAILABLE")}</p>;
  }
  if (!("requiredMinor" in proof)) return null;

  return (
    <CustomerFinanceCompanyPaymentCard<FirstPaymentId>
      agreedMinor={proof.requiredMinor}
      confirmedMinor={proof.directMinor}
      awaitingMinor={Math.max(0, proof.requiredMinor - proof.heldMinor - proof.directMinor)}
      payments={records}
      canRecord={detail.canVoid}
      closed={detail.closed}
      firstPayment={{ heldMinor: proof.heldMinor, canConfirm: detail.canConfirm }}
      factor={factor}
      money={money}
      t={t}
      onConfirm={async ({ amountMinor, paidAt, reference, kind }) => {
        if (kind === undefined) return false;
        const intent = JSON.stringify(["first-payment", applicationId, amountMinor, paidAt, reference, kind]);
        const idempotencyKey = commandId.for(intent);
        if (typeof idempotencyKey !== "string") return false;
        try {
          await confirm({ orgId, applicationId, amountMinor, paidAt, reference, kind, idempotencyKey });
          commandId.retire(intent);
          toast.success(t("CustFcPayConfirmedSuccess"));
          return true;
        } catch (error) {
          if (isConvexError(error)) commandId.retire(intent);
          toast.error(getLocalizedErrorMessage(error, t));
          return false;
        }
      }}
      onVoid={async ({ paymentId, reason }: { paymentId: FirstPaymentId; reason: string }) => {
        if (!records.some(({ _id }) => _id === paymentId)) return false;
        try {
          await takeBack({ orgId, applicationId, paymentId, reason });
          toast.success(t("CustFcPayVoidedSuccess"));
          return true;
        } catch (error) {
          toast.error(getLocalizedErrorMessage(error, t));
          return false;
        }
      }}
    />
  );
}

/** Render the correction only when the server offers it. */
export function QuoteFirstPaymentNotice({ amount: quoteDownPaymentMinor, money, t, onApply }: {
  amount: number;
  money: (minor: number) => string;
  t: (key: string) => string;
  onApply: () => void;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40"
    >
      <p className="min-w-0 flex-1">
        {t("ApplyQuoteFirstPaymentNotice")}{" "}
        <bdi className="tabular-nums font-semibold">
          {money(quoteDownPaymentMinor)}
        </bdi>
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={onApply}
      >
        {t("ApplyQuoteFirstPaymentAction")}
      </Button>
    </div>
  );
}
