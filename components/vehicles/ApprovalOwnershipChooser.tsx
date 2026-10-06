"use client";

// SCRUM-717 (D-45): a CREATE request that reached the approver without a coherent
// ownership shape (a WhatsApp intake request carries no sourceType) cannot be
// approved as-is. The approver decides here, and the decision travels to
// `vehicleEdits.resolve` as its `ownership` argument. Nothing is pre-selected.

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PaymentMethodSelect, type AcquisitionPaymentMethod } from "@/components/payments/PaymentMethodSelect";
import { cn } from "@/lib/utils";

export type OwnershipChoice = "SOURCED" | "STOCK";

export interface OwnershipDraft {
  sourceType?: OwnershipChoice;
  sourcedFromName: string;
  sourceCost: string;
  purchasePrice: string;
  purchasePaymentMethod?: AcquisitionPaymentMethod;
  purchaseSupplierName: string;
}

export interface OwnershipDecision {
  sourceType: OwnershipChoice;
  sourcedFromName?: string;
  sourceCost?: number;
  purchasePrice?: number;
  purchasePaymentMethod?: AcquisitionPaymentMethod;
  purchaseSupplierName?: string;
}

export const EMPTY_OWNERSHIP_DRAFT: OwnershipDraft = {
  sourcedFromName: "",
  sourceCost: "",
  purchasePrice: "",
  purchaseSupplierName: "",
};

const ACQUISITION_METHODS: readonly AcquisitionPaymentMethod[] = ["CASH", "BANK_TRANSFER", "CHEQUE", "CARD", "ON_ACCOUNT"];

/** A request payload needs the approver's decision unless it already names a real sourceType. */
export function needsOwnershipDecision(payload: { sourceType?: unknown } | null | undefined): boolean {
  const sourceType = payload?.sourceType;
  return sourceType !== "STOCK" && sourceType !== "SOURCED";
}

/**
 * The decision the draft amounts to, or null while it is incomplete. The server
 * is the authority and re-validates; this only keeps Approve disabled until the
 * approver has answered every question the shape asks.
 */
export function buildOwnershipDecision(draft: OwnershipDraft | undefined): OwnershipDecision | null {
  if (!draft?.sourceType) return null;
  if (draft.sourceType === "SOURCED") {
    const name = draft.sourcedFromName.trim();
    const cost = Number(draft.sourceCost);
    if (!name || !Number.isFinite(cost) || cost <= 0) return null;
    return { sourceType: "SOURCED", sourcedFromName: name, sourceCost: cost };
  }
  const price = Number(draft.purchasePrice);
  if (!Number.isFinite(price) || price <= 0 || !draft.purchasePaymentMethod) return null;
  if (draft.purchasePaymentMethod === "ON_ACCOUNT") {
    const supplier = draft.purchaseSupplierName.trim();
    if (!supplier) return null;
    return { sourceType: "STOCK", purchasePrice: price, purchasePaymentMethod: "ON_ACCOUNT", purchaseSupplierName: supplier };
  }
  return { sourceType: "STOCK", purchasePrice: price, purchasePaymentMethod: draft.purchasePaymentMethod };
}

interface Props {
  idPrefix: string;
  draft: OwnershipDraft;
  onChange: (next: OwnershipDraft) => void;
  t: (key: any) => string;
}

export function ApprovalOwnershipChooser({ idPrefix, draft, onChange, t }: Readonly<Props>) {
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
            <Input id={`${idPrefix}-supplier`} value={draft.sourcedFromName} placeholder={t("SourceDealerPlaceholder")} onChange={(e) => set({ sourcedFromName: e.target.value })} />
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
              onValueChange={(method) => set({ purchasePaymentMethod: method })}
              methods={ACQUISITION_METHODS}
              ariaLabel={t("PaymentMethodLabel")}
            />
          </div>
          {draft.purchasePaymentMethod === "ON_ACCOUNT" && (
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor={`${idPrefix}-creditor`} className="text-xs">{t("PurchaseSupplierName")} *</Label>
              <Input id={`${idPrefix}-creditor`} value={draft.purchaseSupplierName} placeholder={t("SourceDealerPlaceholder")} onChange={(e) => set({ purchaseSupplierName: e.target.value })} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
