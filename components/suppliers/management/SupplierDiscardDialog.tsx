"use client";

import { useCallback } from "react";
import { flushSync } from "react-dom";
import { useNavigationGuard } from "nextjs-nav-guard";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTranslate } from "./shared";

export function useSupplierNavigationGuard({ dirty, busy }: Readonly<{ dirty: boolean; busy: boolean }>) {
  const translate = useTranslate();
  // Busy writes refuse guarded same-document navigation; full-page unload uses the browser's prompt.
  const confirm = useCallback(() => !busy && window.confirm(translate("SuppliersDiscardTitle")), [busy, translate]);
  useNavigationGuard({ enabled: dirty || busy, confirm });
}

/** Unregister the editor's dirty guard before an already-authorized route change. */
export function closeSupplierEditorBeforeNavigation(close: () => void, navigate: () => void) {
  flushSync(close);
  navigate();
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
