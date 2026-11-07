"use client";

import { useCallback } from "react";
import { useNavigationGuard } from "nextjs-nav-guard";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTranslate } from "./shared";

export function useSupplierNavigationGuard({ dirty, busy }: Readonly<{ dirty: boolean; busy: boolean }>) {
  const translate = useTranslate();
  // A maintained App Router guard covers Back/Forward as well as full-page unloads. Busy writes never authorize departure.
  const confirm = useCallback(() => !busy && window.confirm(translate("SuppliersDiscardTitle")), [busy, translate]);
  useNavigationGuard({ enabled: dirty || busy, confirm });
}

export function SupplierDiscardDialog({ open, onKeep, onDiscard }: Readonly<{ open: boolean; onKeep: () => void; onDiscard: () => void }>) {
  const translate = useTranslate();
  return <Dialog open={open} onOpenChange={next => !next && onKeep()}>
    <DialogContent role="alertdialog" className="sm:max-w-md">
      <DialogHeader className="text-start"><DialogTitle>{translate("SuppliersDiscardTitle")}</DialogTitle><DialogDescription>{translate("SuppliersDiscardBody")}</DialogDescription></DialogHeader>
      <DialogFooter className="gap-2"><Button variant="outline" onClick={onKeep}>{translate("SuppliersKeepEditing")}</Button><Button variant="destructive" onClick={onDiscard}>{translate("SuppliersDiscard")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
