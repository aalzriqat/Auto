"use client";

// SCRUM-717 (D-45): a CREATE request that reached the approver without a coherent
// ownership shape (a WhatsApp intake request carries no sourceType) cannot be
// approved as-is. The approver decides here, and the decision travels to
// `vehicleEdits.resolve` as its `ownership` argument. Nothing is pre-selected.

import { Input } from "@/components/ui/input";
import { SupplierSelect } from "@/components/suppliers/SupplierSelect";
import type { Id } from "@/convex/_generated/dataModel";
import { Label } from "@/components/ui/label";
import {
  ACQUISITION_PAYMENT_METHODS,
  PaymentMethodSelect,
  type AcquisitionPaymentMethod,
  type Translate,
} from "@/components/payments/PaymentMethodSelect";
import { parseVehicleSourceType } from "@/convex/utils/vehicleSourceShape";
import { ownershipGaps } from "@/lib/vehicles/ownershipGaps";
import { cn } from "@/lib/utils";

export type OwnershipChoice = "SOURCED" | "STOCK";

export interface OwnershipDraft {
  sourceType?: OwnershipChoice;
  sourcedFromName: string;
  sourceCost: string;
  purchasePrice: string;
  purchasePaymentMethod?: AcquisitionPaymentMethod;
  bankAccountId?: Id<"bankAccounts">;
  /** Display text the supplier picker sets with the id; never typed, never submitted. */
  purchaseSupplierName: string;
  /** SCRUM-868 P2: the supplier master ids the approver picked. These are what is submitted. */
  sourcedSupplierId?: Id<"suppliers">;
  purchaseSupplierId?: Id<"suppliers">;
}

export interface OwnershipDecision {
  sourceType: OwnershipChoice;
  sourcedSupplierId?: Id<"suppliers">;
  sourceCost?: number;
  purchasePrice?: number;
  purchasePaymentMethod?: AcquisitionPaymentMethod;
  bankAccountId?: Id<"bankAccounts">;
  purchaseSupplierId?: Id<"suppliers">;
}

export const EMPTY_OWNERSHIP_DRAFT: OwnershipDraft = {
  sourcedFromName: "",
  sourceCost: "",
  purchasePrice: "",
  purchaseSupplierName: "",
};

/** A request payload needs the approver's decision unless it already names a real sourceType. */
export function needsOwnershipDecision(payload: { sourceType?: unknown } | null | undefined): boolean {
  const sourceType = payload?.sourceType;
  return parseVehicleSourceType(typeof sourceType === "string" ? sourceType : null) === null;
}

/**
 * The decision the draft amounts to, or null while it is incomplete. The server
 * is the authority and re-validates; this only keeps Approve disabled until the
 * approver has answered every question the shape asks.
 */
export function buildOwnershipDecision(draft: OwnershipDraft | undefined): OwnershipDecision | null {
  if (!draft?.sourceType) return null;
  if (ownershipGaps(draft, { typeRequired: true, costRequired: true, purchaseTerms: "required" })) return null;
  if (draft.sourceType === "SOURCED") {
    if (!draft.sourcedSupplierId) return null;
    return { sourceType: "SOURCED", sourcedSupplierId: draft.sourcedSupplierId, sourceCost: Number(draft.sourceCost) };
  }
  const price = Number(draft.purchasePrice);
  const bankMethod = draft.purchasePaymentMethod === "BANK_TRANSFER" || draft.purchasePaymentMethod === "CARD" || draft.purchasePaymentMethod === "CHEQUE";
  if (bankMethod && !draft.bankAccountId) return null;
  if (draft.purchasePaymentMethod === "ON_ACCOUNT") {
    if (!draft.purchaseSupplierId) return null;
    return { sourceType: "STOCK", purchasePrice: price, purchasePaymentMethod: "ON_ACCOUNT", purchaseSupplierId: draft.purchaseSupplierId };
  }
  return { sourceType: "STOCK", purchasePrice: price, purchasePaymentMethod: draft.purchasePaymentMethod,
    ...(bankMethod ? { bankAccountId: draft.bankAccountId } : {}) };
}

interface Props {
  orgId?: Id<"organizations"> | null;
  bankOptions?: { banks: Array<{ _id: Id<"bankAccounts">; name: string; currency: string }>; truncated: boolean };
  idPrefix: string;
  draft: OwnershipDraft;
  onChange: (next: OwnershipDraft) => void;
  t: Translate;
}

export function ApprovalOwnershipChooser({ orgId, bankOptions, idPrefix, draft, onChange, t }: Readonly<Props>) {
  const bankMethod = draft.purchasePaymentMethod === "BANK_TRANSFER" || draft.purchasePaymentMethod === "CARD" || draft.purchasePaymentMethod === "CHEQUE";
  const selectedBank = bankOptions?.banks?.find((bank) => bank._id === draft.bankAccountId);
  const set = (patch: Partial<OwnershipDraft>) => onChange({ ...draft, ...patch });
  const choices: { value: OwnershipChoice; label: string }[] = [
    { value: "SOURCED", label: t("VehicleOwnershipConsignment") },
    { value: "STOCK", label: t("VehicleOwnershipOwned") },
  ];

  return (
    <div className="mt-3 space-y-3 rounded-md border border-dashed border-amber-400 bg-amber-50/60 p-3 dark:bg-amber-950/20">
      <p className="text-xs font-medium" role="status">
        {draft.sourceType ? t("VehicleApprovalChooseOwnership") : t("VehicleOwnershipChoiceRequired")}
      </p>
      <div role="group" aria-label={t("VehicleApprovalChooseOwnership")} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            aria-pressed={draft.sourceType === choice.value}
            onClick={() => set({ sourceType: choice.value })}
            className={cn(
              "rounded-md border px-3 py-2 text-start text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              draft.sourceType === choice.value ? "border-primary bg-primary/10 font-semibold" : "bg-background hover:bg-muted",
            )}
          >
            {choice.label}
          </button>
        ))}
      </div>

      {draft.sourceType === "SOURCED" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-supplier`} className="text-xs">{t("SourceDealerName")} *</Label>
            <SupplierSelect
              orgId={orgId}
              value={draft.sourcedSupplierId}
              valueLabel={draft.sourcedFromName}
              ariaLabel={t("SourceDealerName")}
              dataTestId={`${idPrefix}-supplier`}
              onChange={(supplier) => set({ sourcedSupplierId: supplier.id, sourcedFromName: supplier.displayName })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-cost`} className="text-xs">{t("SupplierCost")} *</Label>
            <Input id={`${idPrefix}-cost`} type="number" min="0" step="0.01" value={draft.sourceCost} onChange={(e) => set({ sourceCost: e.target.value })} />
          </div>
        </div>
      )}

      {draft.sourceType === "STOCK" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-price`} className="text-xs">{t("PurchasePrice")} *</Label>
            <Input id={`${idPrefix}-price`} type="number" min="0" step="0.01" value={draft.purchasePrice} onChange={(e) => set({ purchasePrice: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t("PaymentMethodLabel")} *</Label>
            <PaymentMethodSelect<AcquisitionPaymentMethod>
              t={t}
              value={draft.purchasePaymentMethod}
              onValueChange={(method) => set({ purchasePaymentMethod: method, bankAccountId: undefined })}
              methods={ACQUISITION_PAYMENT_METHODS}
              ariaLabel={t("PaymentMethodLabel")}
            />
          </div>
          {draft.purchasePaymentMethod === "ON_ACCOUNT" && (
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor={`${idPrefix}-creditor`} className="text-xs">{t("PurchaseSupplierName")} *</Label>
              <SupplierSelect
                orgId={orgId}
                value={draft.purchaseSupplierId}
                valueLabel={draft.purchaseSupplierName}
                ariaLabel={t("PurchaseSupplierName")}
                dataTestId={`${idPrefix}-creditor`}
                onChange={(supplier) => set({ purchaseSupplierId: supplier.id, purchaseSupplierName: supplier.displayName })}
              />
            </div>
          )}
          {bankMethod && (
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor={`${idPrefix}-bank`} className="text-xs">{t("DirectPaymentBankLabel")} *</Label>
              <select
                id={`${idPrefix}-bank`}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={selectedBank?._id ?? ""}
                onChange={(event) => set({ bankAccountId: event.target.value ? event.target.value as Id<"bankAccounts"> : undefined })}
                disabled={!bankOptions || bankOptions.truncated || !bankOptions.banks?.length}
                required
              >
                <option value="">{t(bankOptions ? "DirectPaymentBankChoose" : "CashDrawerLoadingBanks")}</option>
                {(bankOptions?.banks ?? []).map((bank) => <option key={bank._id} value={bank._id}>{bank.name} · {bank.currency}</option>)}
              </select>
              {bankOptions?.truncated && <p role="status" className="text-xs text-muted-foreground">{t("DirectPaymentTooManyBanks")}</p>}
              {bankOptions && !bankOptions.truncated && !bankOptions.banks?.length && <p role="status" className="text-xs text-muted-foreground">{t("DirectPaymentNoBank")}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
