"use client";

import { useState } from "react";
import { Loader2, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type VehicleHandoverDialogProps = {
  open: boolean;
  disabled: boolean;
  submitting: boolean;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (notes?: string) => void;
};

/** التنازل بالسيارة للعميل — confirms the vehicle has been handed over, before finalizeDeal. */
export function VehicleHandoverDialog({
  open,
  disabled,
  submitting,
  t,
  onOpenChange,
  onConfirm,
}: Readonly<VehicleHandoverDialogProps>) {
  const [notes, setNotes] = useState("");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className="border-orange-500/40 text-orange-600 hover:bg-orange-500/10" disabled={disabled}>
          <Truck className="h-4 w-4 me-2" />
          {t("RegisterVehicleHandover")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("RegisterVehicleHandover")}</DialogTitle>
          <DialogDescription>{t("RegisterVehicleHandoverDesc")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium">{t("Notes")}</label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder={t("Optional")} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            onClick={() => onConfirm(notes.trim() || undefined)}
            disabled={submitting}
            className="bg-orange-600 hover:bg-orange-700 text-white"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("ConfirmHandover")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
