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
import { isPilotSwitchOn } from "@/lib/pilotCapabilityManifest";
import { getCodedErrorMessage } from "@/lib/errors";

export function OpeningRefundReturnDialog({ orgId, line, onClose }: Readonly<{
  orgId: Id<"organizations">;
  line: { id: Id<"bankStatementLines">; description: string; amountLabel: string };
  onClose: () => void;
}>) {
  const { t } = useLanguage();
  const fieldId = useId();
  const bankRefundsDisabled = isPilotSwitchOn("OPENING_REFUND_BANK_PILOT_DISABLED");
  const record = useMutation(api.openingRefundReturns.recordBankReturn);
  const [original, setOriginal] = useState("");
  const [bankReturn, setBankReturn] = useState("");
  const [evidence, setEvidence] = useState("");
  const [verified, setVerified] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [codedError, setCodedError] = useState<string | null>(null);
  const command = useRef<{ pair: string; key: string } | null>(null);
  const pending = useRef(false);
  const canRecord = !bankRefundsDisabled && !!original.trim() && !!bankReturn.trim() && !!evidence.trim() && verified;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !canRecord) return;
    const originalRefundReference = original.trim();
    const bankReturnReference = bankReturn.trim();
    const bankEvidenceReference = evidence.trim();
    const pair = JSON.stringify([originalRefundReference, bankReturnReference, bankEvidenceReference]);
    if (command.current?.pair !== pair) command.current = { pair, key: crypto.randomUUID() };
    pending.current = true;
    setSaving(true);
    setFailed(false);
    setCodedError(null);
    try {
      await record({
        orgId, statementLineId: line.id, originalRefundReference, bankReturnReference,
        bankEvidenceReference, confirmedIndependentBankEvidence: true,
        idempotencyKey: command.current.key,
      });
      toast.success(t("OpeningRefundBankReturnRecorded"));
      onClose();
    } catch (error) {
      setCodedError(getCodedErrorMessage(error, t));
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
          {bankRefundsDisabled && <p role="alert" className="text-sm text-destructive">
            {t("ServerError_OPENING_REFUND_BANK_PILOT_DISABLED")}
          </p>}
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-original`}>{t("OpeningRefundOriginalTransferReference")}</Label>
            <Input id={`${fieldId}-original`} value={original} maxLength={120} required disabled={saving}
              onChange={(event) => { setOriginal(event.target.value); setVerified(false); setFailed(false); }} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-return`}>{t("OpeningRefundBankReturnReference")}</Label>
            <Input id={`${fieldId}-return`} value={bankReturn} maxLength={100} required disabled={saving}
              onChange={(event) => { setBankReturn(event.target.value); setVerified(false); setFailed(false); }} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-evidence`}>{t("OpeningRefundIndependentEvidenceReference")}</Label>
            <Input id={`${fieldId}-evidence`} value={evidence} maxLength={120} required disabled={saving}
              onChange={(event) => { setEvidence(event.target.value); setVerified(false); setFailed(false); }} />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input className="mt-1" type="checkbox" required checked={verified} disabled={saving}
              onChange={(event) => setVerified(event.target.checked)} />
            {t("OpeningRefundIndependentEvidenceConfirmed")}
          </label>
          {failed && <p role="alert" className="text-sm text-destructive">{codedError || t("OpeningRefundBankReturnFailed")}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t("Cancel")}</Button>
            <Button type="submit" disabled={saving || !canRecord}>{t(saving ? "Saving" : "OpeningRefundRecordBankReturn")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
