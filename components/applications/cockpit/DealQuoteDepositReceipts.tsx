"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { HandCoins } from "lucide-react";
import { DepositReceiptVouchers } from "@/components/deposits/DepositReceiptVouchers";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { RecordDepositDialog } from "@/components/sales/wizard/components/RecordDepositDialog";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

export type DealQuoteDepositReceiptsProps = Readonly<{
  orgId: Id<"organizations">;
  quoteId: Id<"quotes">;
  receiptQuoteId?: Id<"quotes">;
  canRecord: boolean;
  hasPendingRequest: boolean;
}>;

export function DealQuoteDepositReceipts({
  orgId, quoteId, receiptQuoteId, canRecord, hasPendingRequest,
}: DealQuoteDepositReceiptsProps) {
  const { t } = useLanguage();
  const [dialogQuoteId, setDialogQuoteId] = useState<Id<"quotes">>();
  const history = useQuery(api.paymentVouchers.listQuoteReceipts, { orgId, quoteId });
  const deposits = history?.receipts ?? [];
  const brandingArgs = deposits.length ? { orgId } : "skip";
  const settings = useQuery(api.orgSettings.get, brandingArgs);
  const logoUrl = useQuery(api.orgSettings.getLogoUrl, brandingArgs);
  if (!receiptQuoteId && deposits.length === 0) return null;

  return (
    <section aria-label={t("DepositReceiptHistory")} className="space-y-3 rounded-md border px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{t("DepositReceiptHistory")}</h3>
        {receiptQuoteId && (
          <Button type="button" variant="outline" disabled={hasPendingRequest} onClick={() => setDialogQuoteId(receiptQuoteId)}>
            <HandCoins className="size-4" aria-hidden />
            {t(canRecord
              ? deposits.length ? "RecordAdditionalDeposit" : "RecordDeposit"
              : deposits.length ? "RequestAdditionalDeposit" : "RequestDeposit")}
          </Button>
        )}
      </div>
      {deposits.length > 0 && (
        <DepositReceiptVouchers
          orgId={orgId}
          receipts={deposits}
          truncated={history?.truncated}
          branding={{
            name: settings?.dealershipName,
            legalName: settings?.legalCompanyName,
            address: settings?.dealershipAddress,
            phone: settings?.dealershipPhone,
            logoUrl,
          }}
        />
      )}
      {receiptQuoteId && (
        <RecordDepositDialog
          key={receiptQuoteId}
          quoteId={receiptQuoteId}
          open={dialogQuoteId === receiptQuoteId}
          onOpenChange={(open) => setDialogQuoteId(open ? receiptQuoteId : undefined)}
        />
      )}
    </section>
  );
}
