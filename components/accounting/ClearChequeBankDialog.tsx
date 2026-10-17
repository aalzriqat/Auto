"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCommandIdentity } from "@/hooks/useCommandIdentity";
import { getLocalizedErrorMessage, isConvexError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ReceiptBankSelect, useReceiptBankOptions } from "./ReceiptBankSelect";

/** One destination choice for both customer-cheque clearing screens. */
export function ClearChequeBankDialog({ orgId, chequeId, chequeLabel, onClose, onCleared }: Readonly<{
  orgId: Id<"organizations">;
  chequeId: Id<"postDatedCheques"> | null;
  chequeLabel: string;
  onClose: () => void;
  onCleared: () => void;
}>) {
  const { t } = useLanguage();
  const clearCheque = useMutation(api.collections.clearCheque);
  const command = useCommandIdentity();
  const [attempts, setAttempts] = useState(() => new Map<string, Id<"bankAccounts">>());
  const [selection, setSelection] = useState<{ chequeId: Id<"postDatedCheques">; bankId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ chequeId: Id<"postDatedCheques">; text: string } | null>(null);
  const selectedBank = selection?.chequeId === chequeId ? selection.bankId : "";
  const frozenBank = chequeId ? attempts.get(chequeId) ?? null : null;
  const error = failure?.chequeId === chequeId ? failure.text : "";
  const bankOptions = useReceiptBankOptions(orgId, chequeId !== null, frozenBank ?? selectedBank);

  async function submit() {
    if (!chequeId || busy) return;
    const priorBank = attempts.get(chequeId);
    if (!priorBank && !bankOptions.chosenOffered) return;
    const bankAccountId = priorBank ?? selectedBank as Id<"bankAccounts">;
    const intent = `clear-cheque:${chequeId}`;
    setAttempts((previous) => new Map(previous).set(chequeId, bankAccountId));
    setBusy(true);
    setFailure(null);
    try {
      await clearCheque({ orgId, chequeId, bankAccountId, idempotencyKey: command.for(intent) });
      setAttempts((previous) => {
        const next = new Map(previous);
        next.delete(chequeId);
        return next;
      });
      command.retire(intent);
      setSelection(null);
      onCleared();
      onClose();
    } catch (failure) {
      // A server refusal rolled back its transaction; a transport failure may
      // have completed, so keep the original bank and key for that retry.
      if (isConvexError(failure)) {
        setAttempts((previous) => {
          const next = new Map(previous);
          next.delete(chequeId);
          return next;
        });
        command.retire(intent);
      }
      setFailure({ chequeId, text: getLocalizedErrorMessage(failure, t as (key: string) => string) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={chequeId !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("ConfirmChequeClear" as any)}</DialogTitle>
          <DialogDescription><bdi dir="auto">{chequeLabel}</bdi></DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="cheque-clear-bank">{t("ReceiptBankAccount" as any)}</Label>
          <ReceiptBankSelect id="cheque-clear-bank" value={frozenBank ?? selectedBank}
            onChange={(bankId) => { if (chequeId) setSelection({ chequeId, bankId }); }}
            bankOptions={bankOptions} disabled={busy || frozenBank !== null} />
          {frozenBank && !bankOptions.chosenOffered &&
            <p role="status" className="text-xs text-muted-foreground">{t("ChequeClearRetryBank" as any)}</p>}
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>{t("Cancel" as any)}</Button>
          <Button disabled={busy || (!frozenBank && !bankOptions.chosenOffered)} onClick={submit}>
            {busy ? t("Saving" as any) : t("Clear" as any)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
