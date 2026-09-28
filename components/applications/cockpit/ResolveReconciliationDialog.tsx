"use client";

import { useEffect, useRef, useState } from "react";
import { ClipboardCheck, Loader2 } from "lucide-react";
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
 * Clears a deal's financing-reconciliation flag, with a note saying what was
 * checked (SCRUM-417, G7).
 *
 * `financingEconomics.resolveFinancingReconciliation` had no caller anywhere in
 * the product: the flag is set when a figure on the deal could not be trusted
 * (a missing LTV basis, a remittance nobody recorded), and nothing on screen
 * could say "somebody looked". The note is not decoration — the mutation
 * refuses an empty one, and it is written to the override log as the only
 * evidence that the review happened. So the text typed here IS the audit trail.
 *
 * The reason the server recorded is shown when this caller may read it (it is
 * finance-gated); a caller who cannot is still told a review is outstanding.
 * The mutation takes no idempotency key: a repeat is refused ("not flagged"),
 * never applied twice.
 */
export function ResolveReconciliationDialog({
  open,
  submitting,
  error,
  reason,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<{
  open: boolean;
  submitting: boolean;
  /** The server's refusal, kept in the form it belongs to. */
  error: string | null;
  /** Why the deal was flagged — null when withheld from this caller. */
  reason: string | null;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: { note: string }) => void | Promise<void>;
}>) {
  const [note, setNote] = useState("");

  // Reset on the closed -> open transition only, as the sibling dialogs do.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (justOpened) setNote("");
  }, [open]);

  const noteMissing = note.trim() === "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("ResolveReconciliationTitle")}</DialogTitle>
          <DialogDescription>{t("ResolveReconciliationDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {reason && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/[0.06] p-3 text-sm">
              <p className="text-xs text-muted-foreground">{t("ReconciliationReasonLabel")}</p>
              <p className="mt-0.5 break-words">
                <bdi>{reason}</bdi>
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="resolve-reconciliation-note">{t("ReconciliationNoteLabel")}</Label>
            <Textarea
              id="resolve-reconciliation-note"
              rows={3}
              value={note}
              placeholder={t("ReconciliationNotePlaceholder")}
              aria-invalid={noteMissing}
              onChange={(event) => setNote(event.target.value)}
            />
            {noteMissing && (
              <p className="text-xs text-muted-foreground">{t("ReconciliationNoteRequired")}</p>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={noteMissing || submitting}
            data-testid="resolve-reconciliation-confirm"
            onClick={() => void onSubmit({ note: note.trim() })}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ClipboardCheck className="h-4 w-4 me-2" />
            )}
            {t("ResolveReconciliationConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
