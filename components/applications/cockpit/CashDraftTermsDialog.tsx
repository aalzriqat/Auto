"use client";

import { useId, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { usePermissions } from "@/hooks/use-permissions";
import { useCurrency } from "@/hooks/useCurrency";
import { getCodedErrorMessage } from "@/lib/errors";
import { formatMoneyDisplay, parseTypedMajorAmount } from "@/lib/moneyDisplay";

type CashDraft = Pick<Doc<"sales">, "salePrice" | "saleDate" | "draftRevision"> &
  Partial<Pick<Doc<"sales">, "orgId" | "customerId" | "vehicleId">>;

type CashDraftCorrection = {
  salePrice?: number;
  saleDate?: number;
  draftCorrection: { expectedRevision: number; reason: string; customerId?: Id<"customers">; vehicleId?: Id<"vehicles"> };
};

export function useSaveDraft() {
  const updateSale = useMutation(api.sales.update);
  return async ({
    orgId, saleId, salePrice, saleDate,
    draftCorrection: { expectedRevision, reason, customerId, vehicleId },
  }: CashDraftCorrection & { orgId: Id<"organizations">; saleId: Id<"sales"> }) => {
    const request = { orgId, saleId, salePrice, saleDate };
    const terms = { expectedRevision, reason };
    // Keep the exact replacement keys visible to the release contract comparison.
    if (customerId && vehicleId) {
      await updateSale({ ...request, draftCorrection: { ...terms, customerId, vehicleId } });
    } else if (customerId) {
      await updateSale({ ...request, draftCorrection: { ...terms, customerId } });
    } else if (vehicleId) {
      await updateSale({ ...request, draftCorrection: { ...terms, vehicleId } });
    } else {
      await updateSale({ ...request, draftCorrection: terms });
    }
  };
}

export function CashDraftTermsDialog({ draft, onClose, onSave }: Readonly<{
  draft: CashDraft;
  onClose: () => void;
  onSave: (correction: CashDraftCorrection) => Promise<void>;
}>) {
  const { t, locale } = useLanguage();
  const { code } = useCurrency();
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  const fields = useId();
  const recordedDate = new Date(draft.saleDate);
  const originalPrice = String(draft.salePrice);
  const originalDate = Number.isFinite(recordedDate.getTime()) ? recordedDate.toISOString().slice(0, 10) : "";
  const [price, setPrice] = useState(originalPrice);
  const [date, setDate] = useState(originalDate);
  const [reason, setReason] = useState("");
  const [buyerSearch, setBuyerSearch] = useState("");
  const [vehicleSearch, setVehicleSearch] = useState("");
  const [buyer, setBuyer] = useState<{ id: Id<"customers">; label: string }>();
  const [vehicle, setVehicle] = useState<{ id: Id<"vehicles">; label: string }>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const maySelectBuyer = draft.orgId && draft.customerId && !permissionsLoading && hasPermission("view:customers");
  const maySelectVehicle = draft.orgId && draft.vehicleId && !permissionsLoading && hasPermission("view:vehicles");
  const buyers = useQuery(api.customers.selectorOptions,
    maySelectBuyer && draft.orgId ? { orgId: draft.orgId, search: buyerSearch } : "skip");
  const vehicles = useQuery(api.vehicles.selectorOptions,
    maySelectVehicle && draft.orgId ? { orgId: draft.orgId, search: vehicleSearch } : "skip");
  const buyerOptions = (buyers ?? []).filter(({ _id }) => _id !== draft.customerId).map((record) => ({
    value: record._id, label: [record.firstName, record.lastName].filter(Boolean).join(" "), subLabel: record.phone,
  }));
  const vehicleOptions = (vehicles ?? []).filter((record) => record._id !== draft.vehicleId && record.status === "AVAILABLE")
    .map((record) => ({ value: record._id, label: [record.make, record.model, record.year].join(" "), subLabel: record.vin }));
  const amount = price === originalPrice ? draft.salePrice : parseTypedMajorAmount(price, code);
  const saleDate = date === originalDate ? draft.saleDate : Date.parse(`${date}T00:00:00.000Z`);
  const canSave = amount !== null && amount >= 0 && Number.isSafeInteger(saleDate) && saleDate >= 0 &&
    (amount !== draft.salePrice || saleDate !== draft.saleDate || Boolean(buyer) || Boolean(vehicle)) && reason.trim().length > 0;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || !canSave || amount === null) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        ...(amount !== draft.salePrice ? { salePrice: amount } : {}),
        ...(saleDate !== draft.saleDate ? { saleDate } : {}),
        draftCorrection: {
          expectedRevision: draft.draftRevision ?? 0, reason: reason.trim(),
          ...(buyer ? { customerId: buyer.id } : {}), ...(vehicle ? { vehicleId: vehicle.id } : {}),
        },
      });
      onClose();
    } catch (problem) {
      setError(getCodedErrorMessage(problem, t) ?? t("CashDraftCorrectionFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("CorrectCashDraftTermsAction")}</DialogTitle>
          <DialogDescription>{t("CorrectCashDraftTermsImpact")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-4">
          {maySelectBuyer && <div className="space-y-2">
            <Label htmlFor={`${fields}-buyer`}>{t("CashDraftReplacementBuyer")}</Label>
            <SearchableSelect
              triggerId={`${fields}-buyer`} ariaLabel={t("CashDraftReplacementBuyer")} value={buyer?.id} selectedFallbackLabel={buyer?.label}
              onValueChange={(value) => {
                const option = buyerOptions.find((item) => item.value === value);
                setBuyer(option ? { id: option.value, label: option.label } : undefined);
              }}
              onSearchChange={setBuyerSearch} options={buyerOptions} disabled={saving} loading={buyers === undefined}
              placeholder={t("CashDraftKeepBuyer")} noneLabel={t("CashDraftKeepBuyer")}
              searchPlaceholder={t("Search")} loadingLabel={t("Loading")}
            />
          </div>}
          {maySelectVehicle && <div className="space-y-2">
            <Label htmlFor={`${fields}-vehicle`}>{t("CashDraftReplacementVehicle")}</Label>
            <SearchableSelect
              triggerId={`${fields}-vehicle`} ariaLabel={t("CashDraftReplacementVehicle")} value={vehicle?.id} selectedFallbackLabel={vehicle?.label}
              onValueChange={(value) => {
                const option = vehicleOptions.find((item) => item.value === value);
                setVehicle(option ? { id: option.value, label: option.label } : undefined);
              }}
              onSearchChange={setVehicleSearch} options={vehicleOptions} disabled={saving} loading={vehicles === undefined}
              placeholder={t("CashDraftKeepVehicle")} noneLabel={t("CashDraftKeepVehicle")}
              searchPlaceholder={t("Search")} loadingLabel={t("Loading")}
            />
          </div>}
          <div className="space-y-2">
            <Label htmlFor={`${fields}-price`}>{t("SalePrice")}</Label>
            <Input id={`${fields}-price`} inputMode="decimal" dir="ltr" required disabled={saving} value={price} onChange={(event) => setPrice(event.target.value)} />
            <p className="text-xs text-muted-foreground">{t("CashDraftRecordedPrice")} <bdi>{formatMoneyDisplay(draft.salePrice, code, locale === "ar" ? "ar" : "en")}</bdi></p>
            {price !== originalPrice && price !== "" && (amount === null || amount < 0) && (
              <p role="alert" className="text-xs text-destructive">{t("OpeningBalanceInvalidAmount")}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${fields}-date`}>{t("SaleDate")}</Label>
            <Input id={`${fields}-date`} type="date" dir="ltr" required disabled={saving} value={date} onChange={(event) => setDate(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${fields}-reason`}>{t("ReopenApprovalReasonLabel")}</Label>
            <Textarea id={`${fields}-reason`} rows={3} required disabled={saving} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>{t("Cancel")}</Button>
            <Button type="submit" disabled={!canSave || saving}>{t("SaveChanges")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
