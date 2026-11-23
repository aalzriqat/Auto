import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatLocalized } from "@/lib/dateLocale";

type Props = Readonly<{
  field: string;
  requiresLenderConfirmation: boolean;
  receipt?: { reference: string; amountMinor: number; paidAt: number };
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
              value={returnDate}
              onChange={(event) => onReturnDateChange(event.target.value)}
              required
            />
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
