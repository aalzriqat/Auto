import { useState } from "react";
import type { FunctionArgs } from "convex/server";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { api } from "@/convex/_generated/api";
import { formatLocalized, msToLocalDateTimeInput } from "@/lib/dateLocale";

export type LenderReturn = NonNullable<FunctionArgs<typeof api.financeIdentityBeforeHandover.applyCorrection>["lenderReturn"]>;
export type OriginalReceipt = Pick<LenderReturn, "paymentId" | "amountMinor" | "receiptStamp"> & { reference: string; paidAt: number };

function isRefundTimeInRange(refundedAt: number, paidAt: number, latest: number): boolean {
  return Number.isSafeInteger(refundedAt) && refundedAt >= paidAt && refundedAt <= latest;
}

export function readLenderReturn(fields: FormData, returnDate: string, receipt: OriginalReceipt): LenderReturn | undefined {
  const enteredReference = fields.get("refundReference");
  const reference = typeof enteredReference === "string" ? enteredReference.trim() : "";
  const refundedAt = Date.parse(returnDate);
  if (!reference || fields.get("verifiedSamePayer") !== "on" || !isRefundTimeInRange(refundedAt, receipt.paidAt, Date.now())) return;
  const { paymentId, amountMinor, receiptStamp } = receipt;
  return { paymentId, amountMinor, receiptStamp, reference, refundedAt, verifiedSamePayer: true };
}

type Props = Readonly<{
  field: string;
  requiresLenderConfirmation: boolean;
  receipt?: OriginalReceipt;
  money?: (minor: number) => string;
  locale: string;
  returnDate: string;
  onReturnDateChange: (value: string) => void;
  t: (key: string) => string;
}>;

export function BeforeHandoverLenderFields({
  field,
  requiresLenderConfirmation,
  receipt,
  money,
  locale,
  returnDate,
  onReturnDateChange,
  t,
}: Props) {
  const [now, setNow] = useState(() => Date.now());
  const refundedAt = Date.parse(returnDate);
  const invalidTime = !!receipt && returnDate !== "" && !isRefundTimeInRange(refundedAt, receipt.paidAt, now);
  return (
    <>
      {requiresLenderConfirmation && (
        <div className="space-y-1">
          <Label htmlFor={`${field}-lender`}>{t("IdentityBeforeHandoverLenderReference")}</Label>
          <Input id={`${field}-lender`} name="lenderConfirmationReference" required maxLength={160} />
        </div>
      )}
      {receipt && money && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">{t("IdentityBeforeHandoverRefundEvidence")}</legend>
          <p className="text-sm">
            <bdi>{receipt.reference}</bdi>{" · "}
            <bdi>{money(receipt.amountMinor)}</bdi>{" · "}
            <bdi>{formatLocalized(receipt.paidAt, "d MMM yyyy HH:mm", locale)}</bdi>
          </p>
          <div className="space-y-1">
            <Label htmlFor={`${field}-refund-reference`}>{t("IdentityBeforeHandoverRefundReference")}</Label>
            <Input id={`${field}-refund-reference`} name="refundReference" required maxLength={160} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${field}-refund-time`}>{t("IdentityBeforeHandoverRefundTime")}</Label>
            <Input
              id={`${field}-refund-time`}
              type="datetime-local"
              step="1"
              dir="ltr"
              min={msToLocalDateTimeInput(Math.ceil(receipt.paidAt / 1000) * 1000)}
              max={msToLocalDateTimeInput(now)}
              aria-invalid={invalidTime}
              aria-describedby={invalidTime ? `${field}-refund-time-error` : undefined}
              value={returnDate}
              onChange={(event) => {
                setNow(Date.now());
                onReturnDateChange(event.target.value);
              }}
              required
            />
            {invalidTime && <p id={`${field}-refund-time-error`} role="alert" className="text-sm text-destructive">
              {t("ServerError_LENDER_REFUND_TIME")}
            </p>}
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
