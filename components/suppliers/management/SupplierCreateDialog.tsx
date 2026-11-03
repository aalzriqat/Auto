"use client";

/**
 * Create a supplier without a vehicle (SCRUM-887). The server stays the authority: it checks
 * MANAGE_FINANCE, duplicates and the legal identity. This dialog only collects the fields and shows
 * the server's answers (see useSupplierCreateFlow for how they are read).
 *
 * Accessibility: a Radix dialog (modal, focus trapped and restored, Escape closes, labelled by its
 * title and described by its description), per the WAI-ARIA Authoring Practices dialog pattern.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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
import { toast } from "@/components/ui/sonner";
import { describeSupplierError, useSupplierCreateFlow } from "../useSupplierCreateFlow";
import {
  createFieldsFrom,
  DuplicateCandidatesPanel,
  EMPTY_FORM,
  LegalIdentityPanel,
  supplierHref,
  SupplierFields,
  useTranslate,
  type SupplierFormValues,
} from "./shared";

/** Mounted only while open, so closing the dialog discards the form, the key and the answers. */
export function SupplierCreateDialog({
  orgId,
  open,
  onOpenChange,
}: Readonly<{ orgId: Id<"organizations">; open: boolean; onOpenChange: (open: boolean) => void }>) {
  return open ? <SupplierCreateDialogBody orgId={orgId} onOpenChange={onOpenChange} /> : null;
}

function SupplierCreateDialogBody({
  orgId,
  onOpenChange,
}: Readonly<{ orgId: Id<"organizations">; onOpenChange: (open: boolean) => void }>) {
  const translate = useTranslate();
  const router = useRouter();
  const flow = useSupplierCreateFlow(orgId);
  const { reset } = flow;
  const [values, setValues] = useState<SupplierFormValues>(EMPTY_FORM);
  const [nameError, setNameError] = useState<string | null>(null);

  // Any edit is a new request: the previous key, candidates and conflict no longer describe it.
  const signature = useMemo(() => JSON.stringify(values), [values]);
  useEffect(() => {
    reset();
  }, [signature, reset]);

  async function submit(options: Parameters<typeof flow.submit>[1] = {}) {
    if (values.displayName.trim() === "") {
      setNameError(translate("SuppliersDisplayNameRequired"));
      return;
    }
    setNameError(null);
    const supplierId = await flow.submit(createFieldsFrom(values), options);
    if (supplierId) {
      toast.success(translate("SuppliersCreated"));
      onOpenChange(false);
      router.push(supplierHref(orgId, supplierId));
    }
  }

  const busy = flow.creating;
  return (
    <Dialog open onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader className="text-start">
          <DialogTitle>{translate("SuppliersCreateTitle")}</DialogTitle>
          <DialogDescription>{translate("SuppliersCreateDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <SupplierFields
            idPrefix="supplier-create"
            values={values}
            onChange={setValues}
            disabled={busy}
            displayNameError={nameError}
          />
          {flow.candidates && (
            <DuplicateCandidatesPanel
              orgId={orgId}
              candidates={flow.candidates}
              busy={busy}
              onConfirmDistinct={(ids: Id<"suppliers">[]) => void submit({ confirmDistinctFrom: ids })}
            />
          )}
          {flow.legalConflict && (
            <LegalIdentityPanel
              orgId={orgId}
              existingSupplierId={flow.legalConflict.existingSupplierId}
              busy={busy}
              onShare={(existing, reason) =>
                void submit({ sharedLegalIdentityOf: existing, sharedLegalIdentityReason: reason })
              }
            />
          )}
          {flow.error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {describeSupplierError(flow.error, translate)}
            </p>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              {translate("SuppliersCancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? translate("SuppliersCreating") : translate("SuppliersCreateSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
