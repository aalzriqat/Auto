"use client";

/**
 * Pieces shared by the Suppliers screens (SCRUM-887): the field set, the duplicate and
 * legal-identity panels, the status badge and the query error boundary.
 *
 * RTL: only logical utilities (ms-, me-, ps-, text-start) are used, and values that are always
 * left-to-right (tax ids, phone numbers, emails) sit in `dir="ltr"` / `<bdi>` so they do not flip
 * inside an Arabic sentence (https://www.w3.org/International/questions/qa-html-dir).
 */
import { Component, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import type { Id } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { getCodedErrorMessage } from "@/lib/errors";
import type { SupplierCandidate } from "../useSupplierCreateFlow";

export type Translate = (key: string) => string;

export function useTranslate(): Translate {
  const { t } = useLanguage();
  return t as Translate;
}

export function supplierHref(orgId: string, supplierId: string): string {
  return `/${orgId}/suppliers/${supplierId}`;
}

export interface SupplierFormValues {
  displayName: string;
  legalName: string;
  phone: string;
  email: string;
  address: string;
  taxId: string;
  taxJurisdiction: string;
}

export const EMPTY_FORM: SupplierFormValues = {
  displayName: "",
  legalName: "",
  phone: "",
  email: "",
  address: "",
  taxId: "",
  taxJurisdiction: "",
};

const blankToUndefined = (value: string): string | undefined => {
  const text = value.trim();
  return text === "" ? undefined : text;
};

/** The create arguments from the form: blank fields are left out, not sent as empty text. */
export function createFieldsFrom(values: SupplierFormValues) {
  const phone = blankToUndefined(values.phone);
  const email = blankToUndefined(values.email);
  const address = blankToUndefined(values.address);
  const contact = phone || email || address ? { phone, email, address } : undefined;
  return {
    displayName: values.displayName.trim(),
    legalName: blankToUndefined(values.legalName),
    contact,
    taxId: blankToUndefined(values.taxId),
    taxJurisdiction: blankToUndefined(values.taxJurisdiction),
  };
}

export function SupplierFields({
  idPrefix,
  values,
  onChange,
  disabled,
  displayNameError,
}: Readonly<{
  idPrefix: string;
  values: SupplierFormValues;
  onChange: (next: SupplierFormValues) => void;
  disabled?: boolean;
  displayNameError?: string | null;
}>) {
  const translate = useTranslate();
  const set = (key: keyof SupplierFormValues) => (event: { target: { value: string } }) =>
    onChange({ ...values, [key]: event.target.value });
  const nameErrorId = `${idPrefix}-name-error`;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-name`}>{translate("SuppliersFieldDisplayName")}</Label>
        <Input
          id={`${idPrefix}-name`}
          value={values.displayName}
          onChange={set("displayName")}
          disabled={disabled}
          maxLength={200}
          required
          aria-invalid={displayNameError ? true : undefined}
          aria-describedby={displayNameError ? nameErrorId : undefined}
        />
        {displayNameError && (
          <p id={nameErrorId} role="alert" className="text-xs text-destructive">
            {displayNameError}
          </p>
        )}
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-legal`}>{translate("SuppliersFieldLegalName")}</Label>
        <Input id={`${idPrefix}-legal`} value={values.legalName} onChange={set("legalName")} disabled={disabled} maxLength={200} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-phone`}>{translate("SuppliersFieldPhone")}</Label>
        <Input
          id={`${idPrefix}-phone`}
          type="tel"
          dir="ltr"
          className="text-start"
          value={values.phone}
          onChange={set("phone")}
          disabled={disabled}
          maxLength={50}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-email`}>{translate("SuppliersFieldEmail")}</Label>
        <Input
          id={`${idPrefix}-email`}
          type="email"
          dir="ltr"
          className="text-start"
          value={values.email}
          onChange={set("email")}
          disabled={disabled}
          maxLength={200}
        />
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor={`${idPrefix}-address`}>{translate("SuppliersFieldAddress")}</Label>
        <Textarea id={`${idPrefix}-address`} rows={2} value={values.address} onChange={set("address")} disabled={disabled} maxLength={500} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-tax`}>{translate("SuppliersFieldTaxId")}</Label>
        <Input
          id={`${idPrefix}-tax`}
          dir="ltr"
          className="text-start"
          value={values.taxId}
          onChange={set("taxId")}
          disabled={disabled}
          maxLength={64}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-jur`}>{translate("SuppliersFieldTaxJurisdiction")}</Label>
        <Input
          id={`${idPrefix}-jur`}
          dir="ltr"
          className="text-start uppercase"
          value={values.taxJurisdiction}
          onChange={set("taxJurisdiction")}
          disabled={disabled}
          maxLength={16}
          aria-describedby={`${idPrefix}-jur-hint`}
        />
        <p id={`${idPrefix}-jur-hint`} className="text-xs text-muted-foreground">
          {translate("SuppliersTaxJurisdictionHint")}
        </p>
      </div>
    </div>
  );
}

export function SupplierStatusBadge({ status }: Readonly<{ status: "ACTIVE" | "INACTIVE" }>) {
  const translate = useTranslate();
  return status === "ACTIVE" ? (
    <Badge variant="outline">{translate("SuppliersStatusActive")}</Badge>
  ) : (
    <Badge variant="secondary">{translate("SuppliersStatusInactive")}</Badge>
  );
}

/**
 * Similar suppliers the server found. Opening one is the safe default; the explicit "different
 * supplier" button resubmits with exactly these ids as `confirmDistinctFrom`.
 */
export function DuplicateCandidatesPanel({
  orgId,
  candidates,
  busy,
  onConfirmDistinct,
}: Readonly<{
  orgId: string;
  candidates: SupplierCandidate[];
  busy: boolean;
  onConfirmDistinct: (ids: Id<"suppliers">[]) => void;
}>) {
  const translate = useTranslate();
  const title = translate("SuppliersDupTitle");
  return (
    <section
      role="group"
      aria-label={title}
      className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs">{translate("SuppliersDupHint")}</p>
        </div>
      </div>
      <ul className="space-y-2">
        {candidates.map((candidate) => (
          <li key={candidate.supplierId} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">
              <bdi>{candidate.displayName}</bdi>
              {candidate.status === "INACTIVE" && (
                <span className="ms-2 text-xs">{translate("SuppliersStatusInactive")}</span>
              )}
              {(candidate.reasons ?? []).map((reason) => (
                <Badge key={reason} variant="outline" className="ms-2">
                  {duplicateReasonLabel(reason, translate)}
                </Badge>
              ))}
            </span>
            <Button asChild type="button" size="sm" variant="outline">
              <Link href={supplierHref(orgId, candidate.supplierId)} target="_blank" rel="noreferrer">
                {translate("SuppliersDupOpenExisting")}
              </Link>
            </Button>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={() => onConfirmDistinct(candidates.map((c) => c.supplierId))}
      >
        {translate("SuppliersDupConfirmDistinct")}
      </Button>
    </section>
  );
}

/**
 * The tax id and jurisdiction already belong to a supplier. The default is to open that supplier;
 * the shared-legal-identity path (another branch of the same legal entity) needs a reason and is
 * validated again by the server.
 */
export function LegalIdentityPanel({
  orgId,
  existingSupplierId,
  busy,
  onShare,
}: Readonly<{
  orgId: string;
  existingSupplierId: Id<"suppliers">;
  busy: boolean;
  onShare: (existingSupplierId: Id<"suppliers">, reason: string) => void;
}>) {
  const translate = useTranslate();
  const [reason, setReason] = useState("");
  return (
    <section
      role="group"
      aria-label={translate("SuppliersLegalTitle")}
      className="space-y-3 rounded-md border border-destructive/50 bg-destructive/5 p-3"
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">{translate("SuppliersLegalTitle")}</p>
        <p className="text-xs text-muted-foreground">{translate("SuppliersLegalBody")}</p>
      </div>
      <Button asChild type="button" size="sm" variant="outline">
        <Link href={supplierHref(orgId, existingSupplierId)} target="_blank" rel="noreferrer">
          {translate("SuppliersLegalOpenExisting")}
        </Link>
      </Button>
      <div className="space-y-1.5 border-t pt-3">
        <p className="text-xs text-muted-foreground">{translate("SuppliersLegalShareIntro")}</p>
        <Label htmlFor="supplier-share-reason">{translate("SuppliersLegalShareReason")}</Label>
        <Input id="supplier-share-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || reason.trim() === ""}
          onClick={() => onShare(existingSupplierId, reason.trim())}
        >
          {translate("SuppliersLegalShareSubmit")}
        </Button>
      </div>
    </section>
  );
}

/** A failed Convex query throws during render; this keeps it inside the Suppliers screen. */
export class QueryErrorBoundary extends Component<
  { render: (error: unknown) => ReactNode; children: ReactNode },
  { failed: boolean; error: unknown }
> {
  state = { failed: false, error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }
  render() {
    return this.state.failed ? this.props.render(this.state.error) : this.props.children;
  }
}

/** The localized line for a failed read: a coded refusal, else the generic load error. */
/** A reason code this screen has no label for must not surface as a raw dictionary key. */
function duplicateReasonLabel(reason: string, translate: Translate): string {
  const key = `SuppliersDupReason_${reason}`;
  const label = translate(key);
  return label === key ? translate("SuppliersDupReason_UNKNOWN") : label;
}

export function loadErrorMessage(error: unknown, translate: Translate): string {
  return getCodedErrorMessage(error, translate) ?? translate("SuppliersLoadError");
}
