"use client";

import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/components/providers/LanguageProvider";
import type { Doc } from "@/convex/_generated/dataModel";
import { useCurrency } from "@/hooks/useCurrency";
import { getCodedErrorMessage } from "@/lib/errors";
import { formatMoneyDisplay, parseTypedMajorAmount } from "@/lib/moneyDisplay";

type CashDraft = Pick<Doc<"sales">, "salePrice" | "saleDate" | "draftRevision">;

type CashDraftCorrection = {
  salePrice?: number;
  saleDate?: number;
  draftCorrection: { expectedRevision: number; reason: string };
};

export function CashDraftTermsDialog({ draft, onClose, onSave }: Readonly<{
  draft: CashDraft;
  onClose: () => void;
  onSave: (correction: CashDraftCorrection) => Promise<void>;
}>) {
  const { t, locale } = useLanguage();
  const { code } = useCurrency();
  const fields = useId();
  const recordedDate = new Date(draft.saleDate);
  const originalPrice = String(draft.salePrice);
  const originalDate = Number.isFinite(recordedDate.getTime()) ? recordedDate.toISOString().slice(0, 10) : "";
  const [price, setPrice] = useState(originalPrice);
  const [date, setDate] = useState(originalDate);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amount = price === originalPrice ? draft.salePrice : parseTypedMajorAmount(price, code);
  const saleDate = date === originalDate ? draft.saleDate : Date.parse(`${date}T00:00:00.000Z`);
  const canSave = amount !== null && amount >= 0 && Number.isSafeInteger(saleDate) && saleDate >= 0 &&
    (amount !== draft.salePrice || saleDate !== draft.saleDate) && reason.trim().length > 0;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || !canSave || amount === null) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        ...(amount !== draft.salePrice ? { salePrice: amount } : {}),
        ...(saleDate !== draft.saleDate ? { saleDate } : {}),
        draftCorrection: { expectedRevision: draft.draftRevision ?? 0, reason: reason.trim() },
      });
      onClose();
    } catch (problem) {
      setError(getCodedErrorMessage(problem, t) ?? t("CashDraftCorrectionFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("CorrectCashDraftTermsAction")}</DialogTitle>
          <DialogDescription>{t("CorrectCashDraftTermsImpact")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`${fields}-price`}>{t("SalePrice")}</Label>
            <Input id={`${fields}-price`} inputMode="decimal" dir="ltr" required disabled={saving} value={price} onChange={(event) => setPrice(event.target.value)} />
            <p className="text-xs text-muted-foreground">{t("CashDraftRecordedPrice")} <bdi>{formatMoneyDisplay(draft.salePrice, code, locale === "ar" ? "ar" : "en")}</bdi></p>
            {price !== originalPrice && price !== "" && (amount === null || amount < 0) && (
              <p role="alert" className="text-xs text-destructive">{t("OpeningBalanceInvalidAmount")}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${fields}-date`}>{t("SaleDate")}</Label>
            <Input id={`${fields}-date`} type="date" dir="ltr" required disabled={saving} value={date} onChange={(event) => setDate(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${fields}-reason`}>{t("ReopenApprovalReasonLabel")}</Label>
            <Textarea id={`${fields}-reason`} rows={3} required disabled={saving} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t("Cancel")}</Button>
            <Button type="submit" disabled={!canSave || saving}>{t("SaveChanges")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
