"use client";

import { useState } from "react";
import { Loader2, CheckCircle2 } from "lucide-react";
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

type ClassifyDealAccountingDialogProps = {
  open: boolean;
  submitting: boolean;
  error: string | null;
  t: (key: string) => string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (notes: string) => Promise<void>;
};

export function ClassifyDealAccountingDialog({
  open,
  submitting,
  error,
  t,
  onOpenChange,
  onSubmit,
}: Readonly<ClassifyDealAccountingDialogProps>) {
  const [notes, setNotes] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || !notes.trim()) return;

    setLocalError(null);
    try {
      await onSubmit(notes.trim());
      onOpenChange(false);
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : t("UnexpectedError"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            {t("ClassifyDealAccounting")}
          </DialogTitle>
          <DialogDescription>{t("ClassifyDealAccountingDesc")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="classification-notes">{t("ClassificationNotes")}</Label>
            <Textarea
              id="classification-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("ClassificationNotesPlaceholder")}
              required
            />
          </div>

          {(error || localError) && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error || localError}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={submitting || !notes.trim()}>
              {submitting && <Loader2 className="h-4 w-4 me-2 animate-spin" />}
              {t("ConfirmClassify")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
