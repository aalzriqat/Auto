"use client";

/**
 * Deactivate (reason required) or reactivate a supplier, behind a confirmation dialog. The text
 * states what the server guarantees: an inactive supplier is not offered for new records, and
 * obligations that already exist stay settleable. Nothing is ever deleted.
 */
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { describeSupplierError } from "../useSupplierCreateFlow";
import { useTranslate } from "./shared";

/** Mounted only while open, so each opening starts with an empty reason and no error. */
export function SupplierStatusDialog(props: Readonly<StatusDialogProps>) {
  return props.open ? <StatusDialogBody {...props} /> : null;
}

interface StatusDialogProps {
  orgId: Id<"organizations">;
  supplierId: Id<"suppliers">;
  mode: "deactivate" | "reactivate";
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function StatusDialogBody({ orgId, supplierId, mode, onOpenChange }: Readonly<StatusDialogProps>) {
  const translate = useTranslate();
  const deactivate = useMutation(api.suppliers.deactivate);
  const reactivate = useMutation(api.suppliers.reactivate);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isDeactivate = mode === "deactivate";

  async function confirm() {
    if (busy) return;
    if (isDeactivate && reason.trim() === "") {
      setReasonError(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (isDeactivate) await deactivate({ orgId, supplierId, reason: reason.trim() });
      else await reactivate({ orgId, supplierId });
      toast.success(translate(isDeactivate ? "SuppliersDeactivated" : "SuppliersReactivated"));
      onOpenChange(false);
    } catch (caught) {
      setError(describeSupplierError(caught, translate));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader className="text-start">
          <DialogTitle>{translate(isDeactivate ? "SuppliersDeactivateTitle" : "SuppliersReactivateTitle")}</DialogTitle>
          <DialogDescription>
            {translate(isDeactivate ? "SuppliersDeactivateBody" : "SuppliersReactivateBody")}
          </DialogDescription>
        </DialogHeader>
        {isDeactivate && (
          <div className="space-y-1.5">
            <Label htmlFor="supplier-deactivate-reason">{translate("SuppliersDeactivateReason")}</Label>
            <Textarea
              id="supplier-deactivate-reason"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setReasonError(false);
              }}
              disabled={busy}
              aria-invalid={reasonError ? true : undefined}
              aria-describedby={reasonError ? "supplier-deactivate-reason-error" : undefined}
            />
            {reasonError && (
              <p id="supplier-deactivate-reason-error" role="alert" className="text-xs text-destructive">
                {translate("SuppliersDeactivateReasonRequired")}
              </p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {translate("SuppliersCancel")}
          </Button>
          <Button type="button" variant={isDeactivate ? "destructive" : "default"} disabled={busy} onClick={() => void confirm()}>
            {busy
              ? translate("SuppliersWorking")
              : translate(isDeactivate ? "SuppliersDeactivateConfirm" : "SuppliersReactivateConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
