"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * SCRUM-239 - the bank returned the finance company's cheque AFTER it cleared.
 *
 * A sibling of ForwardCorrectionDialog rather than a third "kind" of it: that
 * dialog corrects a payment the DEALERSHIP made, this undoes the finance
 * company's RECEIPT, and the two say different things about what will happen.
 * Same shape, same rules: the server owns every rule (who may, when, what is
 * reversed); this collects the reason and states the consequence.
 * Mounted without a trigger: DealCockpit owns the button.
 */

export const CHEQUE_RETURN_REASON_MAX_CHARS = 500;

type ChequeReturnedByBankDialogProps = {
  open: boolean;
  submitting: boolean;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void | Promise<void>;
};

export function ChequeReturnedByBankDialog({
  open,
  submitting,
  t,
  onOpenChange,
  onConfirm,
}: Readonly<ChequeReturnedByBankDialogProps>) {
  const [reason, setReason] = useState("");

  // Reset on the closed -> open transition only, so a live re-render of the deal
  // never wipes what the operator is typing.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (justOpened) setReason("");
  }, [open]);

  const trimmed = reason.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("ChequeReturnedByBankTitle")}</DialogTitle>
          <DialogDescription>{t("ChequeReturnedByBankDesc")}</DialogDescription>
        </DialogHeader>

        <form
          id="cheque-returned-by-bank-form"
          className="space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed === "") return;
            void onConfirm(trimmed);
          }}
        >
          <Label htmlFor="cheque-returned-by-bank-reason">{t("ChequeReturnedByBankReasonLabel")}</Label>
          <Textarea
            id="cheque-returned-by-bank-reason"
            rows={3}
            required
            maxLength={CHEQUE_RETURN_REASON_MAX_CHARS}
            value={reason}
            disabled={submitting}
            onChange={(event) => setReason(event.target.value)}
          />
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            type="submit"
            form="cheque-returned-by-bank-form"
            variant="destructive"
            disabled={submitting || trimmed === ""}
          >
            {submitting && <Loader2 className="h-4 w-4 me-2 animate-spin" aria-hidden />}
            {t("ChequeReturnedByBankConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
