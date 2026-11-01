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
import { useMutation, useQuery } from "convex/react";
import { ArrowLeft } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { SupplierStatusDialog } from "./SupplierStatusDialog";
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
    ["SuppliersFieldPhone", supplier.contact?.phone],
    ["SuppliersFieldEmail", supplier.contact?.email],
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
}: Readonly<{ orgId: Id<"organizations">; supplier: FullSupplier }>) {
  const translate = useTranslate();
  const update = useMutation(api.suppliers.update);
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

  const args = buildUpdate(base, values, reason);
  const changed = Object.keys(args).filter((key) => key !== "reason").length > 0;
  const nameChanged = args.displayName !== undefined;

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
      setBase({
        ...base,
        displayName: args.displayName ?? base.displayName,
        legalName: args.legalName === undefined ? base.legalName : (args.legalName ?? undefined),
        contact: args.contact === undefined ? base.contact : (args.contact ?? undefined),
        taxId: args.taxId === undefined ? base.taxId : (args.taxId ?? undefined),
        taxJurisdiction: args.taxJurisdiction === undefined ? base.taxJurisdiction : (args.taxJurisdiction ?? undefined),
        // The server returns the snapshot version and the edit revision it wrote.
        version: result.version,
        revision: result.revision,
      });
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
      <Button type="submit" disabled={busy || !changed}>
        {busy ? translate("SuppliersSaving") : translate("SuppliersEditSubmit")}
      </Button>
    </form>
  );
}

function SupplierDetailBody({ orgId, supplierId }: Readonly<{ orgId: Id<"organizations">; supplierId: Id<"suppliers"> }>) {
  const translate = useTranslate();
  const { hasPermission, isLoading } = usePermissions();
  const canManage = !isLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE);
  const record = useQuery(api.suppliers.get, { orgId, supplierId });
  const [statusMode, setStatusMode] = useState<"deactivate" | "reactivate" | null>(null);

  if (record === undefined) {
    return (
      <p role="status" className="py-8 text-center text-sm text-muted-foreground">
        {translate("SuppliersLoading")}
      </p>
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
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            <bdi>{record.displayName}</bdi>
          </h1>
          <SupplierStatusBadge status={record.status} />
        </div>
        {canManage && (
          <Button
            type="button"
            variant={inactive ? "default" : "outline"}
            onClick={() => setStatusMode(inactive ? "reactivate" : "deactivate")}
          >
            {translate(inactive ? "SuppliersReactivate" : "SuppliersDeactivate")}
          </Button>
        )}
      </header>
      {!isLoading && !canManage && (
        <p role="note" className="rounded-md border bg-muted/50 p-3 text-sm text-muted-foreground">
          {translate("SuppliersReadOnlyNote")}
        </p>
      )}
      {inactive && (
        <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="font-medium">{translate("SuppliersDeactivatedBanner")}</p>
          {record.deactivatedReason && (
            <p className="text-xs">
              {interpolate(translate("SuppliersDeactivatedReason"), { reason: record.deactivatedReason })}
            </p>
          )}
        </div>
      )}
      {record.sharedLegalIdentityOf && (
        <p className="text-sm text-muted-foreground">
          {translate("SuppliersSharedOf")}{" "}
          <Link className="text-primary hover:underline" href={supplierHref(orgId, record.sharedLegalIdentityOf)}>
            {translate("SuppliersDupOpenExisting")}
          </Link>
        </p>
      )}
      <section aria-labelledby="supplier-details-title" className="space-y-3 rounded-lg border p-4">
        <h2 id="supplier-details-title" className="text-lg font-semibold">
          {translate("SuppliersDetailsTitle")}
        </h2>
        {canManage ? <SupplierEditForm orgId={orgId} supplier={record} /> : <SupplierSummary supplier={record} />}
      </section>
      <SupplierAliasesSection orgId={orgId} supplierId={supplierId} aliases={record.aliases ?? []} canManage={canManage} />
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
