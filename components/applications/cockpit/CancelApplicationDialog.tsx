"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

/**
 * Voiding the application — the same `applications.cancelApplication` the
 * Finance Applications → Review dialog calls, with the same two warnings.
 *
 * The CLOSED warning is the one that matters: cancelling a finalized deal
 * voids the sale, restores the vehicle and reverses the posted accounting.
 * The server refuses once disbursement funds are confirmed received; the copy
 * says so before the operator finds out by refusal.
 */
export function CancelApplicationDialog({
  open,
  submitting,
  error,
  isClosed,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<{
  open: boolean;
  submitting: boolean;
  error: string | null;
  /** A CLOSED deal: cancelling reverses a posted sale, not just a request. */
  isClosed: boolean;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (reason: string | undefined) => void | Promise<void>;
}>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {/* The reason lives in a child Radix UNMOUNTS on close, so an abandoned
            attempt's text never survives into the next one. */}
        <CancelApplicationBody
          submitting={submitting}
          error={error}
          isClosed={isClosed}
          t={t}
          onClose={() => onOpenChange(false)}
          onSubmit={onSubmit}
        />
      </DialogContent>
    </Dialog>
  );
}

function CancelApplicationBody({
  submitting,
  error,
  isClosed,
  t,
  onClose,
  onSubmit,
}: Readonly<{
  submitting: boolean;
  error: string | null;
  isClosed: boolean;
  t: (key: string) => string;
  onClose: () => void;
  onSubmit: (reason: string | undefined) => void | Promise<void>;
}>) {
  const [reason, setReason] = useState("");
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("ConfirmCancelApplication")}</DialogTitle>
        <DialogDescription>
          {isClosed
            ? t("CancelClosedApplicationWarning")
            : t("CancelApplicationWarning")}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <label
          htmlFor="cancel-application-reason"
          className="text-sm font-medium"
        >
          {t("CancellationReasonLabel")}
        </label>
        <Textarea
          id="cancel-application-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("CancellationReasonPlaceholder")}
          rows={3}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DialogFooter className="gap-2">
        <Button variant="outline" disabled={submitting} onClick={onClose}>
          {t("KeepApplication")}
        </Button>
        <Button
          variant="destructive"
          disabled={submitting}
          onClick={() => void onSubmit(reason.trim() || undefined)}
        >
          {t("CancelApplication")}
        </Button>
      </DialogFooter>
    </>
  );
}
