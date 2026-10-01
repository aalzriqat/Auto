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
 * SCRUM-435 - correct the dealership's payment to the finance company.
 *
 * Two kinds, one dialog, because both need only a reason:
 *  - VOID:     the payment was recorded by mistake, before the finance company's
 *              transfer was confirmed.
 *  - RETURNED: the finance company sent the payment back (before or after the
 *              transfer). This is what a manager does before cancelling a deal
 *              whose payment is already on the books.
 *
 * The server owns every rule (who may, when); this only collects the reason.
 * Mounted without a trigger: DealCockpit owns the buttons.
 */

export type ForwardCorrectionKind = "VOID" | "RETURNED";

const MAX_REASON_CHARS = 500;

type ForwardCorrectionDialogProps = {
  open: boolean;
  kind: ForwardCorrectionKind;
  submitting: boolean;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void | Promise<void>;
};

export function ForwardCorrectionDialog({
  open,
  kind,
  submitting,
  t,
  onOpenChange,
  onConfirm,
}: Readonly<ForwardCorrectionDialogProps>) {
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
  const isVoid = kind === "VOID";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t(isVoid ? "ForwardVoidTitle" : "ForwardReturnedTitle")}</DialogTitle>
          <DialogDescription>{t(isVoid ? "ForwardVoidDesc" : "ForwardReturnedDesc")}</DialogDescription>
        </DialogHeader>

        <form
          id="forward-correction-form"
          className="space-y-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed === "") return;
            void onConfirm(trimmed);
          }}
        >
          <Label htmlFor="forward-correction-reason">{t("ForwardReasonLabel")}</Label>
          <Textarea
            id="forward-correction-reason"
            rows={3}
            required
            maxLength={MAX_REASON_CHARS}
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
            form="forward-correction-form"
            variant="destructive"
            disabled={submitting || trimmed === ""}
          >
            {submitting && <Loader2 className="h-4 w-4 me-2 animate-spin" aria-hidden />}
            {t(isVoid ? "ForwardVoidAction" : "ForwardReturnedAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
