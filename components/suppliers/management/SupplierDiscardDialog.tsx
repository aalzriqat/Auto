"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTranslate } from "./shared";

export function useSupplierBeforeUnload(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
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
