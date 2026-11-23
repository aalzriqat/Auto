"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { type CommandIdentity, useCommandIdentity } from "@/hooks/useCommandIdentity";
import { economicDateInputToMs, msToDateInput } from "@/lib/dateInput";
import { msToLocalDateTimeInput } from "@/lib/dateLocale";
import { getCodedErrorMessage, getLocalizedErrorMessage, isConvexError } from "@/lib/errors";
import { parseMajorToMinor } from "@/lib/financeFeeTemplateForm";
import { DeliveredLenderCorrectionCard } from "./DeliveredLenderCorrectionCard";
import { DeliveredDealIdentityCorrectionCard } from "./DeliveredDealIdentityCorrectionCard";
import {
  CustomerFinanceCompanyPaymentCard,
  type CustomerFinanceCompanyPayment,
  type FirstPaymentConfirmation,
} from "./CustomerFinanceCompanyPaymentCard";

type FirstPaymentId = Id<"customerFinanceCompanyPayments">;
type CorrectionId = Id<"firstPaymentEvidenceCorrections">;
type Payment = CustomerFinanceCompanyPayment<FirstPaymentId>;
type EvidenceCorrection = { amountMinor: number; paidAt: number; reason: string };
type FirstPaymentEvidenceCardProps = Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  factor: number;
  money: (minor: number) => string;
  t: (key: string) => string;
}>;

export function FirstPaymentEvidenceCard(props: FirstPaymentEvidenceCardProps) {
  const commandId = useCommandIdentity();
  const dealKey = `${props.orgId}:${props.applicationId}`;
  return (
    <>
      <FirstPaymentEvidenceDetails key={dealKey} {...props} commandId={commandId} />
      <DeliveredLenderCorrectionCard key={`lender:${dealKey}`} orgId={props.orgId} applicationId={props.applicationId} t={props.t} />
      <DeliveredDealIdentityCorrectionCard key={`identity:${dealKey}`} orgId={props.orgId} applicationId={props.applicationId} money={props.money} t={props.t} />
    </>
  );
}

function FirstPaymentEvidenceDetails({
  orgId,
  applicationId,
  factor,
  money,
  t,
  commandId,
}: FirstPaymentEvidenceCardProps & { commandId: CommandIdentity }) {
  const detail = useQuery(api.customerFinanceCompanyPayments.firstPayment, { orgId, applicationId });
  const confirm = useMutation(api.customerFinanceCompanyPayments.confirmFirstPayment);
  const takeBack = useMutation(api.customerFinanceCompanyPayments.voidFirstPayment);
  const requestCorrection = useMutation(api.firstPaymentEvidenceCorrections.requestFirstPaymentEvidenceCorrection);
  const approveCorrection = useMutation(api.firstPaymentEvidenceCorrections.approveFirstPaymentEvidenceCorrection);
  const withdrawCorrection = useMutation(api.firstPaymentEvidenceCorrections.withdrawFirstPaymentEvidenceCorrection);
  const [selected, setSelected] = useState<Payment | null>(null);
  const [resolving, setResolving] = useState(false);

  if (detail === undefined) return null;
  const { proof, pendingCorrection, correctionHandoverAt, agreement, replacementAgreementStartsAt } = detail;
  const agreementAvailable = typeof agreement === "string";
  const records: readonly Payment[] = detail.records;
  const balances = "requiredMinor" in proof ? proof : undefined;
  const selectedRecord = records.find((record) => record._id === selected?._id && record.canCorrectEvidence);

  async function submitApproval(correctionId: CorrectionId, intent: string) {
    const idempotencyKey = commandId.for(intent);
    if (typeof idempotencyKey !== "string") return false;
    await approveCorrection({ orgId, correctionId, idempotencyKey });
    commandId.retire(intent);
    return true;
  }

  const resolve = async (correctionId: CorrectionId, decision: "approve" | "withdraw") => {
    if (pendingCorrection?._id !== correctionId || resolving ||
      (decision === "approve" ? !pendingCorrection.canApprove : !pendingCorrection.canWithdraw)) return;
    const intent = JSON.stringify(["first-payment-evidence-approval", correctionId]);
    setResolving(true);
    try {
      if (decision === "approve") {
        if (!(await submitApproval(correctionId, intent))) return;
      } else {
        await withdrawCorrection({ orgId, correctionId });
      }
      toast.success(t(decision === "approve" ? "FirstPaymentCorrectionApproved" : "FirstPaymentCorrectionWithdrawn"));
    } catch (error) {
      if (isConvexError(error)) commandId.retire(intent);
      toast.error(getCodedErrorMessage(error, t) ?? t("FirstPaymentCorrectionFailed"));
    } finally {
      setResolving(false);
    }
  };

  async function submitRequest({
    paymentId, expectedHandoverAt, amountMinor, paidAt, reason, kind, reference,
  }: EvidenceCorrection & {
    paymentId: FirstPaymentId;
    expectedHandoverAt: number;
    kind: NonNullable<Payment["kind"]>;
    reference: string;
  }) {
    const intent = JSON.stringify(["first-payment-evidence-request", paymentId, expectedHandoverAt, amountMinor, paidAt]);
    const idempotencyKey = commandId.for(intent);
    if (typeof idempotencyKey !== "string") return false;
    try {
      await requestCorrection({ orgId, applicationId, paymentId, expectedHandoverAt, amountMinor, paidAt, reason, kind, reference, idempotencyKey });
      commandId.retire(intent);
      toast.success(t("FirstPaymentCorrectionRequested"));
      return true;
    } catch (error) {
      if (isConvexError(error)) commandId.retire(intent);
      toast.error(getCodedErrorMessage(error, t) ?? t("FirstPaymentCorrectionFailed"));
      return false;
    }
  }

  return (
    <>
      {pendingCorrection && (
        <section className="space-y-2 rounded-md border p-3 text-sm" aria-label={t("FirstPaymentCorrectionReview")}>
          <p className="font-medium" role="status">{t("FirstPaymentCorrectionReview")}</p>
          <p>
            <bdi>{money(pendingCorrection.amountMinor)}</bdi>{" · "}
            <bdi>{msToDateInput(pendingCorrection.paidAt)}</bdi>{" · "}
            <bdi>{pendingCorrection.reference}</bdi>
          </p>
          <p className="break-words">{pendingCorrection.reason}</p>
          <div className="flex flex-wrap gap-2">
            {pendingCorrection.canApprove && (
              <Button size="sm" disabled={resolving} onClick={() => void resolve(pendingCorrection._id, "approve")}>
                {t("FirstPaymentCorrectionApprove")}
              </Button>
            )}
            {pendingCorrection.canWithdraw && (
              <Button size="sm" variant="outline" disabled={resolving} onClick={() => void resolve(pendingCorrection._id, "withdraw")}>
                {t("FirstPaymentCorrectionWithdraw")}
              </Button>
            )}
          </div>
        </section>
      )}
      {(proof.status === "UNAVAILABLE" || !agreementAvailable) && !pendingCorrection &&
        <p role="status" className="text-sm">{t("ClosingReason_FIRST_PAYMENT_PROOF_UNAVAILABLE")}</p>}
      <CustomerFinanceCompanyPaymentCard<FirstPaymentId>
        key={agreement}
        agreedMinor={balances?.requiredMinor ?? 0}
        confirmedMinor={balances?.directMinor ?? 0}
        awaitingMinor={balances ? Math.max(0, balances.requiredMinor - balances.heldMinor - balances.directMinor) : 0}
        payments={records}
        canRecord={detail.canVoid}
        closed={detail.closed}
        firstPayment={balances ? {
          heldMinor: balances.heldMinor, canConfirm: detail.canConfirm && agreementAvailable,
          replacementAgreementStartsAt,
        } : { canConfirm: false }}
        factor={factor}
        money={money}
        t={t}
        onCorrectEvidence={correctionHandoverAt === undefined ? undefined : setSelected}
        onConfirm={async ({ amountMinor, paidAt, reference, kind, verifiedReplacementAgreement }: FirstPaymentConfirmation) => {
          const expectedAgreement = agreement;
          if (typeof expectedAgreement !== "string") return false;
          const intent = JSON.stringify(["first-payment", applicationId, expectedAgreement, amountMinor, paidAt, reference, kind,
            ...(verifiedReplacementAgreement === undefined ? [] : [verifiedReplacementAgreement])]);
          const idempotencyKey = commandId.for(intent);
          if (typeof idempotencyKey !== "string") return false;
          try {
            await confirm({
              orgId, applicationId, expectedAgreement, amountMinor, paidAt, reference, kind, idempotencyKey,
              verifiedReplacementAgreement,
            });
            commandId.retire(intent);
            toast.success(t("CustFcPayConfirmedSuccess"));
            return true;
          } catch (error) {
            if (isConvexError(error)) commandId.retire(intent);
            toast.error(replacementAgreementStartsAt !== undefined
              ? getCodedErrorMessage(error, t) ?? t("FirstPaymentProofReplacementConfirmationFailed")
              : getLocalizedErrorMessage(error, t));
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
      {selectedRecord?.kind && correctionHandoverAt !== undefined && (
        <FirstPaymentCorrectionDialog
          key={`${selectedRecord._id}:${agreement ?? ""}`}
          record={selectedRecord}
          factor={factor}
          handoverAt={correctionHandoverAt}
          replacementAgreementStartsAt={replacementAgreementStartsAt}
          t={t}
          onClose={() => setSelected(null)}
          onSubmit={async (values) => {
            const { _id: paymentId, reference, kind } = selectedRecord;
            if (!kind) return false;
            return submitRequest({ ...values, paymentId, expectedHandoverAt: correctionHandoverAt, kind, reference });
          }}
        />
      )}
    </>
  );
}

function FirstPaymentCorrectionDialog({ record, factor, handoverAt, replacementAgreementStartsAt, t, onClose, onSubmit }: {
  record: Payment;
  factor: number;
  handoverAt: number;
  replacementAgreementStartsAt?: number;
  t: (key: string) => string;
  onClose: () => void;
  onSubmit: (values: EvidenceCorrection) => Promise<boolean>;
}) {
  const hasReplacementAgreement = replacementAgreementStartsAt !== undefined;
  const toInput = hasReplacementAgreement ? msToLocalDateTimeInput : msToDateInput;
  const originalDate = toInput(record.paidAt);
  const [amount, setAmount] = useState((record.amountMinor / factor).toString());
  const [date, setDate] = useState(originalDate);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const parsed = parseMajorToMinor(amount, Math.round(Math.log10(factor)));
  const paidAt = date === originalDate ? record.paidAt
    : hasReplacementAgreement ? Date.parse(date) : economicDateInputToMs(date);
  const invalidReplacementTime = hasReplacementAgreement && date !== "" &&
    (!Number.isSafeInteger(paidAt) || paidAt < replacementAgreementStartsAt || paidAt > handoverAt);
  const invalid = !parsed.ok || parsed.minor <= 0 || date === "" || !Number.isSafeInteger(paidAt) ||
    paidAt > handoverAt || invalidReplacementTime || reason.trim() === "";
  const submit = async () => {
    if (submitting || invalid || !parsed.ok) return;
    setSubmitting(true);
    try {
      if (await onSubmit({ amountMinor: parsed.minor, paidAt, reason: reason.trim() })) onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !submitting) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("FirstPaymentCorrectionRequest")}</DialogTitle>
          <DialogDescription>{t("FirstPaymentCorrectionDescription")}</DialogDescription>
        </DialogHeader>
        <p className="text-sm"><bdi>{record.reference}</bdi></p>
        <div className="space-y-2">
          <Label htmlFor="first-payment-correction-amount">{t("CustFcPayAmountLabel")}</Label>
          <Input id="first-payment-correction-amount" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="first-payment-correction-date">{t("CustFcPayDateLabel")}</Label>
          <Input id="first-payment-correction-date" type={hasReplacementAgreement ? "datetime-local" : "date"}
            step={hasReplacementAgreement ? "1" : undefined}
            min={hasReplacementAgreement ? toInput(Math.ceil(replacementAgreementStartsAt / 1000) * 1000) : undefined}
            max={toInput(handoverAt)} value={date} onChange={(event) => setDate(event.target.value)}
            aria-invalid={invalidReplacementTime}
            aria-describedby={invalidReplacementTime ? "first-payment-correction-date-error" : undefined} />
          {invalidReplacementTime && <p id="first-payment-correction-date-error" role="alert" className="text-sm text-destructive">
            {t("FirstPaymentCorrectionReplacementTimeInvalid")}
          </p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="first-payment-correction-reason">{t("FirstPaymentCorrectionReason")}</Label>
          <Textarea id="first-payment-correction-reason" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={onClose}>{t("Cancel")}</Button>
          <Button disabled={invalid || submitting} onClick={() => void submit()}>{t("FirstPaymentCorrectionRequest")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
