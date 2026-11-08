"use client";

/**
 * One supplier: details, edit, aliases, deactivate / reactivate (SCRUM-887 slice A).
 *
 * Edits use optimistic concurrency: the form remembers the edit revision it was loaded at and sends
 * that as `expectedVersion`, not the live one. Every successful update raises the revision, contact
 * fields included, so another user's change to ANY field is reported (SUPPLIER_VERSION_CONFLICT)
 * instead of silently overwritten (RFC 9110 section 13: a validator must change when the
 * representation does). The snapshot `version` that money records copy is a different number and
 * is not used here. Only the fields that changed are sent. A name change needs a reason. The
 * answers to a similar-name or shared-legal-identity prompt are kept for as long as the name and
 * identity fields stay as they were, so the two prompts cannot alternate forever. Relationship navigation (payables, receivables, recoveries) is not here: it
 * needs supplier ids on those rows (SCRUM-868 P3) and is a later slice.
 */
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft, Building2, Pencil, Phone, Mail } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { usePermissions } from "@/hooks/use-permissions";
import { interpolate } from "@/lib/i18n/interpolate";
import {
  describeSupplierError,
  duplicateCandidates,
  legalIdentityConflict,
  mergeConfirmations,
  refusalCode,
  VERSION_CONFLICT_CODE,
  type ConfirmationMemory,
  type SupplierCandidate,
  type SupplierCreateOptions,
} from "../useSupplierCreateFlow";
import { SupplierAliasesSection, type AliasRow } from "./SupplierAliasesSection";
import { SupplierStatementSection } from "./SupplierStatementSection";
import { SupplierStatusDialog } from "./SupplierStatusDialog";
import { SupplierDiscardDialog, useSupplierNavigationGuard, closeSupplierEditorBeforeNavigation } from "./SupplierDiscardDialog";
import { SupplierSummaryTiles } from "./SupplierSummaryTiles";
import {
  DuplicateCandidatesPanel,
  LegalIdentityPanel,
  loadErrorMessage,
  QueryErrorBoundary,
  SupplierFields,
  SupplierStatusBadge,
  supplierHref,
  useTranslate,
  type SupplierFormValues,
} from "./shared";

export interface FullSupplier {
  _id: Id<"suppliers">;
  displayName: string;
  legalName?: string;
  status: "ACTIVE" | "INACTIVE";
  contact?: { phone?: string; email?: string; address?: string };
  taxId?: string;
  taxJurisdiction?: string;
  sharedLegalIdentityOf?: Id<"suppliers">;
  version: number;
  /** The edit token: what `expectedVersion` must carry. Raised by every update. */
  revision: number;
  deactivatedReason?: string;
  aliases: AliasRow[];
}

type UpdateArgs = {
  displayName?: string;
  legalName?: string | null;
  contact?: { phone?: string; email?: string; address?: string } | null;
  taxId?: string | null;
  taxJurisdiction?: string | null;
  reason?: string;
};

const trimmed = (value: string | undefined): string => (value ?? "").trim();

export function formFromSupplier(supplier: FullSupplier): SupplierFormValues {
  return {
    displayName: supplier.displayName,
    legalName: supplier.legalName ?? "",
    phone: supplier.contact?.phone ?? "",
    email: supplier.contact?.email ?? "",
    address: supplier.contact?.address ?? "",
    taxId: supplier.taxId ?? "",
    taxJurisdiction: supplier.taxJurisdiction ?? "",
  };
}

/** Only what differs from the loaded record. null clears a field, undefined leaves it. */
export function buildUpdate(base: FullSupplier, values: SupplierFormValues, reason: string): UpdateArgs {
  const was = formFromSupplier(base);
  return { ...nameChange(was, values, reason), ...legalNameChange(was, values), ...contactChange(was, values), ...taxChange(was, values) };
}

const clearable = (value: string): string | null => (value === "" ? null : value);

function nameChange(was: SupplierFormValues, values: SupplierFormValues, reason: string): UpdateArgs {
  const name = values.displayName.trim();
  return name === was.displayName ? {} : { displayName: name, reason: reason.trim() };
}

function legalNameChange(was: SupplierFormValues, values: SupplierFormValues): UpdateArgs {
  const legal = values.legalName.trim();
  return legal === was.legalName ? {} : { legalName: clearable(legal) };
}

function contactChange(was: SupplierFormValues, values: SupplierFormValues): UpdateArgs {
  const phone = trimmed(values.phone);
  const email = trimmed(values.email);
  const address = trimmed(values.address);
  if (phone === was.phone && email === was.email && address === was.address) return {};
  const any = phone || email || address;
  return {
    contact: any ? { ...(phone ? { phone } : {}), ...(email ? { email } : {}), ...(address ? { address } : {}) } : null,
  };
}

function taxChange(was: SupplierFormValues, values: SupplierFormValues): UpdateArgs {
  const taxId = values.taxId.trim();
  const jurisdiction = values.taxJurisdiction.trim().toUpperCase();
  return {
    ...(taxId === was.taxId ? {} : { taxId: clearable(taxId) }),
    ...(jurisdiction === was.taxJurisdiction.toUpperCase() ? {} : { taxJurisdiction: clearable(jurisdiction) }),
  };
}

function isFullSupplier(record: unknown): record is FullSupplier {
  return (
    typeof record === "object" && record !== null && "version" in record && "revision" in record && "aliases" in record
  );
}

function SupplierSummary({ supplier }: Readonly<{ supplier: FullSupplier }>) {
  const translate = useTranslate();
  const rows: Array<[string, string | undefined]> = [
    ["SuppliersFieldLegalName", supplier.legalName],
    ["SuppliersFieldAddress", supplier.contact?.address],
    ["SuppliersFieldTaxId", supplier.taxId],
    ["SuppliersFieldTaxJurisdiction", supplier.taxJurisdiction],
  ];
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-muted-foreground">{translate(label)}</dt>
          <dd className="text-sm">
            <bdi>{value || "—"}</bdi>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SupplierEditForm({
  orgId,
  supplier,
  onClose,
}: Readonly<{ orgId: Id<"organizations">; supplier: FullSupplier; onClose: () => void }>) {
  const translate = useTranslate();
  const update = useMutation(api.suppliers.update);
  const router = useRouter();
  // The record the form was loaded from. The live record may move on; this is what edits are
  // measured against and what expectedVersion refers to.
  const [base, setBase] = useState(supplier);
  const [values, setValues] = useState(() => formFromSupplier(supplier));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [candidates, setCandidates] = useState<SupplierCandidate[] | null>(null);
  const [conflictWith, setConflictWith] = useState<Id<"suppliers"> | null>(null);
  const [versionConflict, setVersionConflict] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [aliasState, setAliasState] = useState({ dirty: false, busy: false });

  const args = buildUpdate(base, values, reason);
  const changed = Object.keys(args).filter((key) => key !== "reason").length > 0;
  const nameChanged = args.displayName !== undefined;
  const dirty = changed || reason !== "" || aliasState.dirty;
  useSupplierNavigationGuard({ dirty, busy: busy || aliasState.busy });
  function requestClose() {
    if (busy || aliasState.busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  }

  // The user's explicit answers for the current name and identity fields (see mergeConfirmations).
  const memory = useRef<ConfirmationMemory | null>(null);

  function clearAnswers() {
    setError(null);
    setCandidates(null);
    setConflictWith(null);
    setVersionConflict(false);
  }

  function reload() {
    setBase(supplier);
    setValues(formFromSupplier(supplier));
    setReason("");
    memory.current = null;
    clearAnswers();
  }

  async function save(answer: SupplierCreateOptions = {}) {
    if (busy || !changed) return;
    setNameError(null);
    setReasonError(null);
    if (values.displayName.trim() === "") {
      setNameError(translate("SuppliersDisplayNameRequired"));
      return;
    }
    if (nameChanged && reason.trim() === "") {
      setReasonError(translate("SuppliersNameReasonRequired"));
      return;
    }
    clearAnswers();
    // Only the name and identity fields decide what the server asked about, so only they end the
    // memory; the reason and the contact fields do not.
    const asked = JSON.stringify({
      displayName: args.displayName,
      legalName: args.legalName,
      taxId: args.taxId,
      taxJurisdiction: args.taxJurisdiction,
    });
    memory.current = mergeConfirmations(memory.current, asked, answer);
    const extra = memory.current.options;
    setBusy(true);
    try {
      const result = await update({ orgId, supplierId: base._id, expectedVersion: base.revision, ...args, ...extra });
      toast.success(translate("SuppliersUpdated"));
      memory.current = null;
      setReason("");
      // The live record reflects the save; measure the next edit against what was just written.
      setBase(supplierAfterUpdate(base, args, result));
      if (aliasState.dirty) setConfirmDiscard(true);
      else onClose();
    } catch (caught) {
      const found = duplicateCandidates(caught);
      const conflict = legalIdentityConflict(caught);
      if (found) setCandidates(found);
      else if (conflict) setConflictWith(conflict.existingSupplierId);
      else if (refusalCode(caught) === VERSION_CONFLICT_CODE) setVersionConflict(true);
      else setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <Dialog open onOpenChange={next => !next && requestClose()}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" onCloseAutoFocus={event => { event.preventDefault(); document.getElementById("supplier-edit-trigger")?.focus(); }}
      onClickCapture={event => {
        const anchor = event.target instanceof Element ? event.target.closest("a") : null;
        if (anchor && (dirty || busy || aliasState.busy)) {
          event.preventDefault();
          if (!busy && !aliasState.busy) { setPendingHref(anchor.getAttribute("href")); setConfirmDiscard(true); }
        }
      }}>
    <DialogHeader className="text-start"><DialogTitle>{translate("SuppliersEdit")}</DialogTitle><DialogDescription>{translate("SuppliersDetailsTitle")}</DialogDescription></DialogHeader>
    <form
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <SupplierFields
        idPrefix="supplier-edit"
        values={values}
        onChange={(next) => {
          setValues(next);
          clearAnswers();
        }}
        disabled={busy}
        displayNameError={nameError}
      />
      {nameChanged && (
        <div className="space-y-1.5">
          <Label htmlFor="supplier-edit-reason">{translate("SuppliersNameReason")}</Label>
          <Input
            id="supplier-edit-reason"
            value={reason}
            maxLength={500}
            onChange={(event) => {
              setReason(event.target.value);
              setReasonError(null);
            }}
            disabled={busy}
            aria-invalid={reasonError ? true : undefined}
            aria-describedby="supplier-edit-reason-hint"
          />
          <p id="supplier-edit-reason-hint" className="text-xs text-muted-foreground">
            {translate("SuppliersNameReasonHint")}
          </p>
          {reasonError && (
            <p role="alert" className="text-xs text-destructive">
              {reasonError}
            </p>
          )}
        </div>
      )}
      {versionConflict && (
        <div role="alert" className="space-y-2 rounded-md border border-destructive/50 bg-destructive/5 p-3">
          <p className="text-sm font-medium">{translate("SuppliersVersionConflictTitle")}</p>
          <p className="text-xs text-muted-foreground">{translate("SuppliersVersionConflictBody")}</p>
          <Button type="button" size="sm" variant="outline" onClick={reload}>
            {translate("SuppliersVersionConflictReload")}
          </Button>
        </div>
      )}
      {candidates && (
        <DuplicateCandidatesPanel
          orgId={orgId}
          candidates={candidates}
          busy={busy}
          onConfirmDistinct={(ids) => void save({ confirmDistinctFrom: ids })}
        />
      )}
      {conflictWith && (
        <LegalIdentityPanel
          orgId={orgId}
          existingSupplierId={conflictWith}
          busy={busy}
          onShare={(existing, why) => void save({ sharedLegalIdentityOf: existing, sharedLegalIdentityReason: why })}
        />
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {describeSupplierError(error, translate)}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="outline" disabled={busy} onClick={requestClose}>{translate("SuppliersCancel")}</Button>
      <Button type="submit" disabled={busy || aliasState.busy || !changed}>
        {busy ? translate("SuppliersSaving") : translate("SuppliersEditSubmit")}
      </Button>
      </div>
    </form>
    <SupplierAliasesSection orgId={orgId} supplierId={supplier._id} aliases={supplier.aliases ?? []} canManage onEditStateChange={setAliasState} />
    </DialogContent>
    </Dialog>
    <SupplierDiscardDialog open={confirmDiscard} onKeep={() => { setConfirmDiscard(false); setPendingHref(null); }} onDiscard={() => closeSupplierEditorBeforeNavigation(onClose, () => { if (pendingHref) router.push(pendingHref); })} />
    </>
  );
}

function SupplierDetailBody({ orgId, supplierId }: Readonly<{ orgId: Id<"organizations">; supplierId: Id<"suppliers"> }>) {
  const translate = useTranslate();
  const { hasPermission, isLoading } = usePermissions();
  const canManage = !isLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE);
  const record = useQuery(api.suppliers.get, { orgId, supplierId });
  const [statusMode, setStatusMode] = useState<"deactivate" | "reactivate" | null>(null);
  const [editing, setEditing] = useState(false);

  if (record === undefined) {
    return (
      <output className="block space-y-3 py-8 text-center text-sm text-muted-foreground">
        {translate("SuppliersLoading")}
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-52 w-full rounded-xl" />
      </output>
    );
  }
  if (!isFullSupplier(record)) {
    return (
      <p role="alert" className="py-8 text-center text-sm text-destructive">
        {translate("SuppliersLoadError")}
      </p>
    );
  }
  const inactive = record.status === "INACTIVE";
  return (
    <div className="space-y-5">
      <Card className="overflow-hidden border-t-4 border-t-primary shadow-sm">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
        <span className="rounded-xl bg-primary/10 p-3 text-primary"><Building2 aria-hidden="true" /></span>
        <div className="min-w-0 space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            <bdi>{record.displayName}</bdi>
          </h1>
          <SupplierStatusBadge status={record.status} />
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {record.contact?.phone && <span className="inline-flex items-center gap-1"><Phone size={14} aria-hidden="true" /><bdi>{record.contact.phone}</bdi></span>}
            {record.contact?.email && <span className="inline-flex items-center gap-1 break-all"><Mail size={14} aria-hidden="true" /><bdi>{record.contact.email}</bdi></span>}
          </div>
        </div>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
          <Button id="supplier-edit-trigger" type="button" onClick={() => setEditing(true)}><Pencil size={16} aria-hidden="true" />{translate("SuppliersEdit")}</Button>
          <Button
            type="button"
            variant={inactive ? "default" : "outline"}
            onClick={() => setStatusMode(inactive ? "reactivate" : "deactivate")}
          >
            {translate(inactive ? "SuppliersReactivate" : "SuppliersDeactivate")}
          </Button>
          </div>
        )}
      </CardHeader>
      <CardContent><SupplierSummary supplier={record} /></CardContent>
      </Card>
      {!isLoading && !canManage && (
        <p role="note" className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">
          {translate("SuppliersReadOnlyNote")}
        </p>
      )}
      {inactive && (
        <output aria-live="polite" aria-atomic="true" className="block rounded-md border border-money-out/30 bg-money-out/5 p-3 text-sm text-money-out">
          <p className="font-medium">{translate("SuppliersDeactivatedBanner")}</p>
          {record.deactivatedReason && (
            <p className="text-xs">
              {interpolate(translate("SuppliersDeactivatedReason"), { reason: record.deactivatedReason })}
            </p>
          )}
        </output>
      )}
      {record.sharedLegalIdentityOf && (
        <p className="text-sm text-muted-foreground">
          {translate("SuppliersSharedOf")}{" "}
          <Link className="text-primary hover:underline" href={supplierHref(orgId, record.sharedLegalIdentityOf)}>
            {translate("SuppliersDupOpenExisting")}
          </Link>
        </p>
      )}
      <SupplierSummaryTiles orgId={orgId} supplierId={supplierId} />
      <SupplierStatementSection orgId={orgId} supplierId={supplierId} />
      <Card className="p-4 shadow-sm"><SupplierAliasesSection orgId={orgId} supplierId={supplierId} aliases={record.aliases ?? []} canManage={false} /></Card>
      {canManage && editing && <SupplierEditForm orgId={orgId} supplier={record} onClose={() => setEditing(false)} />}
      {canManage && statusMode && (
        <SupplierStatusDialog
          orgId={orgId}
          supplierId={supplierId}
          mode={statusMode}
          open
          onOpenChange={(open) => !open && setStatusMode(null)}
        />
      )}
    </div>
  );
}

export function SupplierDetailScreen({
  orgId,
  supplierId,
}: Readonly<{ orgId: Id<"organizations">; supplierId: Id<"suppliers"> }>) {
  const translate = useTranslate();
  return (
    <div className="space-y-4 p-4 md:p-6">
      <Button asChild variant="ghost" size="sm" className="-ms-2">
        <Link href={`/${orgId}/suppliers`}>
          <ArrowLeft className="rtl:rotate-180" aria-hidden="true" />
          {translate("SuppliersBack")}
        </Link>
      </Button>
      <QueryErrorBoundary
        key={`${orgId}:${supplierId}`}
        render={(error) => (
          <p role="alert" className="py-8 text-center text-sm text-destructive">
            {loadErrorMessage(error, translate)}
          </p>
        )}
      >
        <SupplierDetailBody orgId={orgId} supplierId={supplierId} />
      </QueryErrorBoundary>
    </div>
  );
}

/** The new edit baseline is the patch the server accepted, including explicit field clears. */
function supplierAfterUpdate(base: FullSupplier, args: UpdateArgs, result: Pick<FullSupplier, "version" | "revision">): FullSupplier {
  return {
    ...base,
    displayName: args.displayName ?? base.displayName,
    legalName: args.legalName === undefined ? base.legalName : (args.legalName ?? undefined),
    contact: args.contact === undefined ? base.contact : (args.contact ?? undefined),
    taxId: args.taxId === undefined ? base.taxId : (args.taxId ?? undefined),
    taxJurisdiction: args.taxJurisdiction === undefined ? base.taxJurisdiction : (args.taxJurisdiction ?? undefined),
    version: result.version,
    revision: result.revision,
  };
}
