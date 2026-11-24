"use client";

import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { useCommandIdentity } from "@/hooks/useCommandIdentity";

type ReceiptStatus = FunctionReturnType<typeof api.collections.saleInvoiceReceiptStatus>;
export type PendingReceiptNotice = "DealReceiptActivated" | "DealReceiptReservationReleased";

export function DealPendingInvoiceReceipts({
  orgId, saleId, status, canManage, busy, doorsReason, money, command, runAction, cursor, moveToPage,
}: Readonly<{
  orgId: Id<"organizations">;
  saleId: Id<"sales">;
  status: ReceiptStatus;
  canManage: boolean;
  busy: boolean;
  doorsReason?: string;
  money: (minor: number, currency: string) => string;
  command: ReturnType<typeof useCommandIdentity>;
  runAction: (action: () => Promise<void>, notice: PendingReceiptNotice) => Promise<void>;
  cursor: string | null;
  moveToPage: (cursor: string | null) => void;
}>) {
  const { t } = useLanguage();
  const activate = useMutation(api.collections.activateSaleInvoiceReceipt);
  const release = useMutation(api.collections.releaseSaleInvoiceReceipt);
  const canActivate = status.saleInvoiceDoorsAvailable === true;
  const canRelease = status.pendingClaimReleaseAvailable === true;

  const activateApplication = (applicationId: Id<"invoiceReceiptApplications">, amountMinor: number) => {
    if (!canActivate) return;
    const intent = `sale-activate:${applicationId}`;
    void runAction(async () => {
      await activate({ orgId, applicationId, amountMinor, idempotencyKey: command.for(intent) });
      command.retire(intent);
    }, "DealReceiptActivated");
  };

  const releaseApplication = (applicationId: Id<"invoiceReceiptApplications">) => {
    if (!canRelease) return;
    void runAction(async () => {
      await release({ orgId, saleId, applicationId });
    }, "DealReceiptReservationReleased");
  };

  return (
    <section className="space-y-2" aria-label={t("DealReceiptPendingHeading")}>
      <h3 className="font-medium">{t("DealReceiptPendingHeading")}</h3>
      {status.page.length === 0 && <p className="text-sm text-muted-foreground">{t("DealReceiptNoPending")}</p>}
      {status.page.map((application) => (
        <div key={application.applicationId}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
          <bdi dir="ltr" className="tabular-nums">{money(application.amountMinor, application.currency)}</bdi>
          <span>{application.readiness === "ORIGINS_VERIFIED" ? t("DealReceiptOriginsVerified")
            : t(`DealReceiptReason_${application.reason ?? "PROOF_UNAVAILABLE"}`)}</span>
          {canManage && (
            <div className="flex flex-wrap gap-2">
              {application.readiness === "ORIGINS_VERIFIED" && status.saleStatus === "COMPLETED" && (
                <Button size="sm" disabled={busy || !canActivate} aria-describedby={doorsReason}
                  onClick={() => activateApplication(application.applicationId, application.amountMinor)}>
                  {t("DealReceiptTryActivateButton")}
                </Button>
              )}
              {canRelease && (
                <Button size="sm" variant="outline" disabled={busy}
                  onClick={() => releaseApplication(application.applicationId)}>
                  {t("DealReceiptReleaseReservation")}
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        {cursor !== null && (
          <Button variant="outline" size="sm" onClick={() => moveToPage(null)}>{t("DealReceiptFirstPage")}</Button>
        )}
        {!status.isDone && (
          <Button variant="outline" size="sm" onClick={() => moveToPage(status.continueCursor)}>
            {t("DealReceiptNextPage")}
          </Button>
        )}
      </div>
    </section>
  );
}
