"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/sonner";

export function OpeningRefundReturnDialog({ orgId, line, onClose }: Readonly<{
  orgId: Id<"organizations">;
  line: { id: Id<"bankStatementLines">; description: string; amountLabel: string };
  onClose: () => void;
}>) {
  const { t } = useLanguage();
  const fieldId = useId();
  const record = useMutation(api.openingRefundReturns.recordBankReturn);
  const [original, setOriginal] = useState("");
  const [bankReturn, setBankReturn] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const command = useRef<{ pair: string; key: string } | null>(null);
  const pending = useRef(false);
  const hasReferences = !!original.trim() && !!bankReturn.trim();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !hasReferences) return;
    const originalRefundReference = original.trim();
    const bankReturnReference = bankReturn.trim();
    const pair = JSON.stringify([originalRefundReference, bankReturnReference]);
    if (command.current?.pair !== pair) command.current = { pair, key: crypto.randomUUID() };
    pending.current = true;
    setSaving(true);
    setFailed(false);
    try {
      await record({
        orgId, statementLineId: line.id, originalRefundReference, bankReturnReference,
        idempotencyKey: command.current.key,
      });
      toast.success(t("OpeningRefundBankReturnRecorded"));
      onClose();
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("OpeningRefundRecordBankReturn")}</DialogTitle>
          <DialogDescription>{t("OpeningRefundBankReturnDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <p className="break-words text-sm">{line.description} · <bdi>{line.amountLabel}</bdi></p>
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-original`}>{t("OpeningRefundOriginalTransferReference")}</Label>
            <Input id={`${fieldId}-original`} value={original} maxLength={120} required disabled={saving}
              onChange={(event) => { setOriginal(event.target.value); setFailed(false); }} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-return`}>{t("OpeningRefundBankReturnReference")}</Label>
            <Input id={`${fieldId}-return`} value={bankReturn} maxLength={100} required disabled={saving}
              onChange={(event) => { setBankReturn(event.target.value); setFailed(false); }} />
          </div>
          {failed && <p role="alert" className="text-sm text-destructive">{t("OpeningRefundBankReturnFailed")}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t("Cancel")}</Button>
            <Button type="submit" disabled={saving || !hasReferences}>{t(saving ? "Saving" : "OpeningRefundRecordBankReturn")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
