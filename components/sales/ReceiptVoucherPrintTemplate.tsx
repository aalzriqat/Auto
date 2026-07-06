"use client";

import { useLanguage } from "@/components/providers/LanguageProvider";
import { DocumentLetterhead, type OrgBranding } from "@/components/print/DocumentLetterhead";

interface ReceiptVoucherPrintTemplateProps {
  voucherNumber: string;
  customerName: string;
  descriptionAr: string;
  amount: number;
  currency: string;
  issuedAtStr: string;
  orgBranding?: OrgBranding;
}

/** Receipt voucher (سند قبض) — proof-of-payment document auto-generated whenever a deposit is recorded. */
export function ReceiptVoucherPrintTemplate({
  voucherNumber,
  customerName,
  descriptionAr,
  amount,
  currency,
  issuedAtStr,
  orgBranding,
}: ReceiptVoucherPrintTemplateProps) {
  const { t, isRtl } = useLanguage();

  return (
    <div
      id="receipt-voucher-pdf-content"
      className="hidden print:block absolute inset-0 bg-white w-[210mm] h-[297mm] mx-auto text-black p-12 font-sans box-border"
      dir={isRtl ? "rtl" : "ltr"}
    >
      <DocumentLetterhead variant="legal" orgBranding={orgBranding} titleLabel={t("ReceiptVoucherTitle")} />

      <div className="flex justify-between items-center mt-6 mb-8 text-sm">
        <span className="font-mono font-semibold">{voucherNumber}</span>
        <span>{t("Date" as any)}: {issuedAtStr}</span>
      </div>

      <div className="space-y-6 border rounded-lg p-6">
        <div className="flex justify-between border-b pb-3">
          <span className="text-sm text-gray-600">{t("ReceivedFrom")}</span>
          <span className="font-semibold">{customerName}</span>
        </div>
        <div className="flex justify-between border-b pb-3">
          <span className="text-sm text-gray-600">{t("AmountLabel")}</span>
          <span className="font-bold text-lg">
            {amount.toLocaleString(undefined, { minimumFractionDigits: 2 })} {currency}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-sm text-gray-600">{t("VoucherDescriptionLabel")}</span>
          <span className="font-medium">{descriptionAr}</span>
        </div>
      </div>

      <div className="mt-24 flex justify-between px-8">
        <div className="text-center w-48">
          <div className="border-t border-dashed pt-2 text-xs text-gray-500">{t("ReceivedBySignature")}</div>
        </div>
        <div className="text-center w-48">
          <div className="border-t border-dashed pt-2 text-xs text-gray-500">{t("SealAndSignature" as any)}</div>
        </div>
      </div>
    </div>
  );
}
