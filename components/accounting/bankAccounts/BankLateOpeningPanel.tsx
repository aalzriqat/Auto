"use client";

import { useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";
import { useCommandIdentity } from "@/hooks/useCommandIdentity";
import { getLocalizedErrorMessage } from "@/lib/errors";
import { msToDateInput } from "@/lib/dateInput";
import { AccountingTableFrame } from "../AccountingTabShared";

type Offer = FunctionReturnType<typeof api.bankAccounts.lateOpeningOffers>[number];

type Props = {
  orgId: Id<"organizations">;
  /** Formats a minor-unit amount in the given currency. */
  formatMinor: (minor: number, currency: string) => string;
};

/**
 * SCRUM-1012 (owner ruling 2026-11-26): a bank added after the opening entry keeps its stated balance as a note, so its
 * book balance reads 0. The server offers each such bank to an owner only, with a server-computed
 * `canPostLateOpening`; confirming posts the bank's own stored balance and date once, against Opening suspense (1900).
 * The person types nothing that reaches the books: the request carries the bank, a retry identity and the two figures the screen showed (`expectedAmountMinor`, `expectedOpeningBalanceDate`), sent for comparison only. The posted amount, date and currency come from the stored bank, and the server refuses if they differ from what was shown.
 */
export function BankLateOpeningPanel({ orgId, formatMinor }: Readonly<Props>) {
  const { t, isRtl } = useLanguage();
  const offers = useQuery(api.bankAccounts.lateOpeningOffers, { orgId });
  const post = useMutation(api.bankAccounts.postLateOpeningBalance);
  const command = useCommandIdentity();
  const [confirming, setConfirming] = useState<Offer | null>(null);
  const [busy, setBusy] = useState(false);

  if (!offers || offers.length === 0) return null;

  // The server's own refusal reason in the user's language; the generic note when it names none.
  const blockedText = (offer: Offer) => {
    const reason = offer.blockedReason ? t(`ServerError_${offer.blockedReason}`) : "";
    return reason && reason !== `ServerError_${offer.blockedReason}` ? reason : t("BankLateOpeningCannotNow");
  };

  async function confirm() {
    if (!confirming || busy) return;
    const intent = JSON.stringify([orgId, confirming.bankAccountId]);
    const idempotencyKey = command.for(intent);
    if (typeof idempotencyKey !== "string") return;
    setBusy(true);
    try {
      // The figures shown in the dialog travel as a comparison only; the server posts what the bank stores.
      await post({
        orgId, bankAccountId: confirming.bankAccountId, idempotencyKey,
        expectedAmountMinor: confirming.amountMinor, expectedOpeningBalanceDate: confirming.openingBalanceDate,
      });
      command.retire(intent);
      setConfirming(null);
      toast.success(t("BankLateOpeningPosted"));
    } catch (error) {
      // A lost response keeps its identity so the retry cannot post twice; a coded refusal is shown in the user's language.
      toast.error(getLocalizedErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3" data-testid="bank-late-opening-panel">
      <div>
        <h3 className="text-base font-semibold text-foreground">{t("BankLateOpeningTitle")}</h3>
        <p className="text-sm text-muted-foreground">{t("BankLateOpeningHelp")}</p>
      </div>
      <AccountingTableFrame>
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>{t("BankLateOpeningBank")}</TableHead>
              <TableHead className="text-end">{t("BankLateOpeningAmount")}</TableHead>
              <TableHead>{t("BankLateOpeningDate")}</TableHead>
              <TableHead className="text-end">{t("Actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {offers.map((offer) => (
              <TableRow key={offer.bankAccountId}>
                <TableCell className="font-medium">{offer.name}</TableCell>
                <TableCell className="text-end tabular-nums">{formatMinor(offer.amountMinor, offer.currency)}</TableCell>
                <TableCell className="tabular-nums">{msToDateInput(offer.openingBalanceDate)}</TableCell>
                <TableCell className="text-end">
                  <Button type="button" size="sm" variant="outline" disabled={!offer.canPostLateOpening} onClick={() => setConfirming(offer)}>
                    {t("BankLateOpeningPost")}
                  </Button>
                  {!offer.canPostLateOpening && (
                    <p className="mt-1 text-xs text-muted-foreground">{blockedText(offer)}</p>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </AccountingTableFrame>
      <Dialog open={confirming !== null} onOpenChange={(open) => { if (!open && !busy) setConfirming(null); }}>
        <DialogContent dir={isRtl ? "rtl" : "ltr"}>
          <DialogHeader>
            <DialogTitle>{t("BankLateOpeningPost")}</DialogTitle>
            <DialogDescription>{t("BankLateOpeningAgainst")}</DialogDescription>
          </DialogHeader>
          {confirming && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("BankLateOpeningBank")}</dt>
              <dd className="font-medium"><bdi>{confirming.name}</bdi></dd>
              <dt className="text-muted-foreground">{t("BankLateOpeningAmount")}</dt>
              <dd className="font-medium tabular-nums"><bdi>{formatMinor(confirming.amountMinor, confirming.currency)}</bdi></dd>
              <dt className="text-muted-foreground">{t("BankLateOpeningDate")}</dt>
              <dd className="font-medium tabular-nums"><bdi>{msToDateInput(confirming.openingBalanceDate)}</bdi></dd>
            </dl>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirming(null)}>{t("Cancel")}</Button>
            <Button type="button" disabled={busy} onClick={() => void confirm()}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("BankLateOpeningPost")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
