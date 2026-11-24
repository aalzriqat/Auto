import { useState } from "react";
import type { FunctionArgs } from "convex/server";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { api } from "@/convex/_generated/api";
import { formatLocalized } from "@/lib/dateLocale";
import { evidenceTimeInMs, PaymentEvidenceTimeInput, usePaymentEvidenceClock, type EvidenceTime } from "./PaymentEvidenceTimeInput";

export type LenderReturn = NonNullable<FunctionArgs<typeof api.financeIdentityBeforeHandover.applyCorrection>["lenderReturn"]>;
export type OriginalReceipt = Pick<LenderReturn, "paymentId" | "amountMinor" | "receiptStamp"> & { reference: string; paidAt: number };
export type ShowroomRefund = { amountMinor: number; refundedAt: number };

function isRefundTimeInRange(refundedAt: number, paidAt: number, latest: number): boolean {
  return Number.isSafeInteger(refundedAt) && refundedAt >= paidAt && refundedAt <= latest;
}

export function readLenderReturn(fields: FormData, returnDate: EvidenceTime, receipt: OriginalReceipt): LenderReturn | undefined {
  const enteredReference = fields.get("refundReference");
  const reference = typeof enteredReference === "string" ? enteredReference.trim() : "";
  const refundedAt = evidenceTimeInMs(returnDate);
  if (!reference || fields.get("verifiedSamePayer") !== "on" || !isRefundTimeInRange(refundedAt, receipt.paidAt, Date.now())) return;
  const { paymentId, amountMinor, receiptStamp } = receipt;
  return { paymentId, amountMinor, receiptStamp, reference, refundedAt, verifiedSamePayer: true };
}

type Props = Readonly<{
  field: string;
  requiresLenderConfirmation: boolean;
  receipt?: OriginalReceipt;
  showroomRefund?: ShowroomRefund;
  money?: (minor: number) => string;
  locale: string;
  returnDate: EvidenceTime;
  onReturnDateChange: (value: EvidenceTime) => void;
  t: (key: string) => string;
}>;

export function BeforeHandoverLenderFields({
  field,
  requiresLenderConfirmation,
  receipt,
  showroomRefund,
  money,
  locale,
  returnDate,
  onReturnDateChange,
  t,
}: Props) {
  const now = usePaymentEvidenceClock(receipt !== undefined);
  const [reference, setReference] = useState("");
  const invalidReference = reference.length > 0 && !reference.trim();
  const invalidTime = !!receipt && returnDate.local !== "" && !isRefundTimeInRange(evidenceTimeInMs(returnDate), receipt.paidAt, now);
  const recordedShowroomRefund = showroomRefund && money && (
    <dl className="rounded-md border p-2 text-sm">
      <dt>{t("IdentityBeforeHandoverShowroomRefundRecorded")}</dt>
      <dd>
        <bdi>{money(showroomRefund.amountMinor)}</bdi>{" · "}
        <bdi>{formatLocalized(showroomRefund.refundedAt, "d MMM yyyy HH:mm:ss xxx", locale)}</bdi>
      </dd>
    </dl>
  );
  return (
    <>
      {requiresLenderConfirmation && (
        <div className="space-y-1">
          <Label htmlFor={`${field}-lender`}>{t("IdentityBeforeHandoverLenderReference")}</Label>
          <Input id={`${field}-lender`} name="lenderConfirmationReference" required maxLength={160} />
        </div>
      )}
      {!receipt && recordedShowroomRefund}
      {receipt && money && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t("IdentityBeforeHandoverRefundEvidence")}</legend>
          {recordedShowroomRefund}
          <p className="text-sm">
            <bdi>{receipt.reference}</bdi>{" · "}
            <bdi>{money(receipt.amountMinor)}</bdi>{" · "}
            <bdi>{formatLocalized(receipt.paidAt, "d MMM yyyy HH:mm:ss xxx", locale)}</bdi>
          </p>
          <div className="space-y-1">
            <Label htmlFor={`${field}-refund-reference`}>{t("IdentityBeforeHandoverRefundReference")}</Label>
            <Input id={`${field}-refund-reference`} name="refundReference" required maxLength={160} pattern={".*\\S.*"}
              value={reference} onChange={(event) => setReference(event.target.value)} aria-invalid={invalidReference}
              aria-describedby={invalidReference ? `${field}-refund-reference-error` : undefined} />
            {invalidReference && <p id={`${field}-refund-reference-error`} role="alert" className="text-sm text-destructive">
              {t("IdentityBeforeHandoverRefundReferenceRequired")}
            </p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${field}-refund-time`}>{t("IdentityBeforeHandoverRefundTime")}</Label>
            <PaymentEvidenceTimeInput id={`${field}-refund-time`} value={returnDate} onChange={onReturnDateChange}
              invalid={invalidTime} errorText={t("ServerError_LENDER_REFUND_TIME")} t={t} />
          </div>
          <Label className="flex items-start gap-2">
            <input type="checkbox" name="verifiedSamePayer" required />
            {t("IdentityBeforeHandoverRefundVerify")}
          </Label>
        </fieldset>
      )}
    </>
  );
}
