"use client";

import { useRef, useState } from "react";
import { useQuery } from "convex/react";
import { Receipt } from "lucide-react";
import { useLanguage } from "@/components/providers/LanguageProvider";
import type { OrgBranding } from "@/components/print/DocumentLetterhead";
import { ReceiptVoucherPrintTemplate } from "@/components/sales/ReceiptVoucherPrintTemplate";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { downloadElementAsPdf } from "@/lib/htmlToPdf";
import { formatMoneyDisplay } from "@/lib/moneyDisplay";

type Receipt = Pick<Doc<"deposits">, "_id"> &
  Partial<Pick<Doc<"deposits">, "amount" | "currency" | "status">>;

const STATUS_LABEL = {
  HELD: "DepositStatusHeld",
  APPLIED: "DepositStatusApplied",
  REFUNDED: "DepositStatusRefunded",
  FORFEITED: "DepositStatusForfeited",
  VOIDED: "DepositReceiptVoided",
} as const;

export function DepositReceiptVouchers({
  orgId,
  receipts,
  branding,
  truncated = false,
}: Readonly<{
  orgId: Id<"organizations">;
  receipts: readonly Receipt[];
  branding?: OrgBranding;
  truncated?: boolean;
}>) {
  const { t, locale } = useLanguage();
  const [selectedId, selectReceipt] = useState("");
  const [downloading, setDownloading] = useState(false);
  const downloadInFlight = useRef(false);
  const depositId = receipts.find(({ _id }) => _id === selectedId)?._id ?? receipts.at(-1)?._id;
  const voucher = useQuery(api.paymentVouchers.getByDeposit, depositId ? { orgId, depositId } : "skip");

  const download = async () => {
    if (!voucher || !depositId || downloadInFlight.current) return;
    downloadInFlight.current = true;
    selectReceipt(depositId);
    setDownloading(true);
    try {
      const saved = await downloadElementAsPdf("receipt-voucher-pdf-content", `Receipt_${voucher.voucherNumber}.pdf`);
      if (saved) toast.success(t("ReceiptVoucherGenerated"));
      else toast.error(t("FailedGeneratePDF"));
    } finally {
      downloadInFlight.current = false;
      setDownloading(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {receipts.length > 1 && (
        <select
          aria-label={t("ReceiptVoucherTitle")}
          className="min-w-0 max-w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={depositId ?? ""}
          disabled={downloading}
          onChange={(event) => selectReceipt(event.target.value)}
        >
          {receipts.map(({ _id, currency, amount, status }, index) => {
            const amountLabel = currency && amount !== undefined
              ? ` · ${formatMoneyDisplay(amount, currency, locale === "ar" ? "ar" : "en")}`
              : "";
            const statusLabel = status ? ` · ${t(STATUS_LABEL[status])}` : "";
            return <option key={_id} value={_id}>{t("ReceiptVoucherTitle")} {index + 1}{amountLabel}{statusLabel}</option>;
          })}
        </select>
      )}
      {truncated && <span className="text-xs text-muted-foreground">{t("DepositReceiptHistoryTruncated")}</span>}
      {voucher ? (
        <>
          <Button type="button" variant="outline" disabled={downloading} onClick={() => void download()}>
            <Receipt className="size-4" aria-hidden />
            {t("DownloadReceiptVoucher")}
          </Button>
          <span className="text-xs text-muted-foreground"><bdi>{voucher.voucherNumber}</bdi></span>
          <ReceiptVoucherPrintTemplate
            key={voucher._id}
            voucherNumber={voucher.voucherNumber}
            customerName={voucher.customerNameSnapshot}
            descriptionAr={voucher.descriptionAr}
            amount={voucher.amount}
            currency={voucher.currency}
            issuedAtStr={new Date(voucher.issuedAt).toLocaleDateString(locale)}
            orgBranding={branding}
          />
        </>
      ) : depositId && voucher === null ? (
        <span className="text-sm text-muted-foreground">{t("DepositReceiptUnavailable")}</span>
      ) : null}
    </div>
  );
}
