"use client";

import { useState } from "react";
import { usePaginatedQuery, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { toast } from "@/components/ui/sonner";
import { format } from "date-fns";
import { Plus, History, TrendingDown, XCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Mirrors convex/utils/money.ts CURRENCY_SCALES — duplicated here because that
// module lives under convex/ and this is display-only decimal-place formatting,
// not a business rule (the backend independently re-derives and validates scale).
// Same convention as ManualJournalTab.tsx.
const CURRENCY_SCALES: Record<string, number> = {
  JOD: 3, KWD: 3, BHD: 3, OMR: 3,
  USD: 2, EUR: 2, GBP: 2, SAR: 2, AED: 2, QAR: 2, EGP: 2,
  JPY: 0,
};
function scaleForCurrency(currency: string): number {
  return CURRENCY_SCALES[currency.toUpperCase()] ?? 2;
}

const todayInput = new Date().toISOString().slice(0, 10);
function dateInputToMs(value: string): number {
  return new Date(`${value}T00:00:00`).getTime();
}

type FixedAsset = Doc<"fixedAssets">;
type PaymentMethod = "CASH" | "BANK_TRANSFER" | "CHEQUE" | "CARD";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function AssetStatusBadge({ t, asset }: { t: (key: any) => string; asset: FixedAsset }) {
  if (asset.costMinor == null) {
    return <Badge variant="outline" className="text-slate-500">{t("AssetStatusLegacy")}</Badge>;
  }
  if (asset.status === "IMPAIRED") {
    return <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/20">{t("AssetStatus_IMPAIRED")}</Badge>;
  }
  if (asset.status === "DISPOSED") {
    return <Badge variant="outline" className="bg-slate-500/10 text-slate-500 border-slate-500/20">{t("AssetStatus_DISPOSED")}</Badge>;
  }
  return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20">{t("AssetStatus_ACTIVE")}</Badge>;
}

export function FixedAssetsTab() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { code: currencyCode } = useCurrency();
  const formatCurrency = useCurrencyFormatter();
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(PERMISSIONS.MANAGE_FINANCE);
  const scale = scaleForCurrency(currencyCode);
  const factor = Math.pow(10, scale);

  const { results: assets } = usePaginatedQuery(
    api.fixedAssets.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );

  const [capitalizeOpen, setCapitalizeOpen] = useState(false);
  const [eventsAsset, setEventsAsset] = useState<FixedAsset | null>(null);
  const [impairAsset, setImpairAsset] = useState<FixedAsset | null>(null);
  const [disposeAsset, setDisposeAsset] = useState<FixedAsset | null>(null);

  if (!assets) {
    return <div className="p-8 text-center text-slate-500">{t("LoadingAssets" as any)}</div>;
  }

  return (
    <div className="p-6 space-y-6">
      <div className="mb-2 flex justify-between items-center gap-4 flex-wrap">
        <h2 className="text-lg font-semibold text-slate-900">{t("FixedAssets" as any)}</h2>
        {canManage && (
          <Button size="sm" className="gap-2" onClick={() => setCapitalizeOpen(true)}>
            <Plus className="w-4 h-4" />
            {t("CapitalizeNewAsset" as any)}
          </Button>
        )}
      </div>

      <div className="rounded-md border border-slate-200 overflow-x-auto">
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead>{t("AssetName" as any)}</TableHead>
              <TableHead>{t("PurchaseDateLabel" as any)}</TableHead>
              <TableHead className="text-right">{t("PurchaseValue" as any)}</TableHead>
              <TableHead className="text-right">{t("AccumulatedDepreciationLabel" as any)}</TableHead>
              <TableHead className="text-right">{t("NetBookValueLabel" as any)}</TableHead>
              <TableHead>{t("Status" as any)}</TableHead>
              <TableHead className="text-right">{t("Actions" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {assets.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-slate-500 py-8">
                  {t("NoAssetsFound" as any)}
                </TableCell>
              </TableRow>
            ) : (
              assets.map((asset) => {
                const isLegacy = asset.costMinor == null;
                const costMinor = asset.costMinor ?? Math.round((asset.purchaseValue ?? 0) * factor);
                const accumMinor = asset.accumulatedDepreciationMinor ?? 0;
                const netBookMinor = costMinor - accumMinor;
                const canOperate = canManage && !isLegacy && asset.status === "ACTIVE";
                return (
                  <TableRow key={asset._id}>
                    <TableCell className="font-medium">{asset.name}</TableCell>
                    <TableCell>{format(new Date(asset.purchaseDate), "MMM d, yyyy")}</TableCell>
                    <TableCell className="text-right font-semibold text-slate-900">
                      {formatCurrency(costMinor / factor, scale)}
                    </TableCell>
                    <TableCell className="text-right text-slate-500">
                      {isLegacy ? "—" : formatCurrency(accumMinor / factor, scale)}
                    </TableCell>
                    <TableCell className="text-right font-semibold text-slate-900">
                      {isLegacy ? "—" : formatCurrency(netBookMinor / factor, scale)}
                    </TableCell>
                    <TableCell>
                      <AssetStatusBadge t={t as any} asset={asset} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t("ViewEvents" as any)}
                          onClick={() => setEventsAsset(asset)}
                        >
                          <History className="w-4 h-4 text-slate-500" />
                        </Button>
                        {canOperate && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={t("ImpairAsset" as any)}
                              onClick={() => setImpairAsset(asset)}
                            >
                              <TrendingDown className="w-4 h-4 text-amber-600" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={t("DisposeAsset" as any)}
                              onClick={() => setDisposeAsset(asset)}
                            >
                              <XCircle className="w-4 h-4 text-rose-600" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {activeOrgId && canManage && (
        <CapitalizeAssetDialog
          open={capitalizeOpen}
          onOpenChange={setCapitalizeOpen}
          orgId={activeOrgId}
          factor={factor}
        />
      )}

      {activeOrgId && (
        <AssetEventsDialog
          asset={eventsAsset}
          onOpenChange={(open) => !open && setEventsAsset(null)}
          orgId={activeOrgId}
          factor={factor}
          scale={scale}
          formatCurrency={formatCurrency}
        />
      )}

      {activeOrgId && impairAsset && (
        <ImpairAssetDialog
          asset={impairAsset}
          onOpenChange={(open) => !open && setImpairAsset(null)}
          orgId={activeOrgId}
          factor={factor}
          scale={scale}
          formatCurrency={formatCurrency}
        />
      )}

      {activeOrgId && disposeAsset && (
        <DisposeAssetDialog
          asset={disposeAsset}
          onOpenChange={(open) => !open && setDisposeAsset(null)}
          orgId={activeOrgId}
          factor={factor}
          scale={scale}
          formatCurrency={formatCurrency}
        />
      )}
    </div>
  );
}

function CapitalizeAssetDialog({
  open,
  onOpenChange,
  orgId,
  factor,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
}) {
  const { t } = useLanguage();
  const capitalize = useMutation(api.fixedAssets.capitalize);

  const [name, setName] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(todayInput);
  const [cost, setCost] = useState("");
  const [salvageValue, setSalvageValue] = useState("0");
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("60");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setName("");
    setPurchaseDate(todayInput);
    setCost("");
    setSalvageValue("0");
    setUsefulLifeMonths("60");
    setPaymentMethod("CASH");
    setNotes("");
  }

  async function submit() {
    const costMinor = Math.round(Number(cost) * factor);
    const salvageValueMinor = Math.round(Number(salvageValue || "0") * factor);
    const usefulLife = Math.round(Number(usefulLifeMonths));

    if (!name.trim()) {
      toast.error(t("AssetName" as any));
      return;
    }
    if (!Number.isFinite(costMinor) || costMinor <= 0) {
      toast.error(t("PurchaseValue" as any));
      return;
    }
    if (!Number.isFinite(usefulLife) || usefulLife <= 0) {
      toast.error(t("UsefulLifeMonthsLabel" as any));
      return;
    }
    if (salvageValueMinor >= costMinor) {
      toast.error(t("SalvageValueLabel" as any));
      return;
    }

    setSubmitting(true);
    try {
      await capitalize({
        orgId,
        name: name.trim(),
        purchaseDate: dateInputToMs(purchaseDate),
        costMinor,
        salvageValueMinor,
        usefulLifeMonths: usefulLife,
        paymentMethod,
        notes: notes.trim() || undefined,
      });
      toast.success(t("AssetCapitalized" as any));
      onOpenChange(false);
      reset();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("CapitalizeNewAsset" as any)}</DialogTitle>
          <DialogDescription>{t("CapitalizeAssetDesc" as any)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("AssetName" as any)}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("PurchaseDateLabel" as any)}</Label>
              <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("PurchaseValue" as any)}</Label>
              <Input type="number" min={0} step={1 / factor} value={cost} onChange={(e) => setCost(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("SalvageValueLabel" as any)}</Label>
              <Input type="number" min={0} step={1 / factor} value={salvageValue} onChange={(e) => setSalvageValue(e.target.value)} />
              <p className="text-xs text-slate-500">{t("SalvageValueHint" as any)}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t("UsefulLifeMonthsLabel" as any)}</Label>
              <Input type="number" min={1} step={1} value={usefulLifeMonths} onChange={(e) => setUsefulLifeMonths(e.target.value)} />
              <p className="text-xs text-slate-500">{t("UsefulLifeMonthsHint" as any)}</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{t("PaymentMethodLabel" as any)}</Label>
            <Select value={paymentMethod} onValueChange={(v) => setPaymentMethod(v as PaymentMethod)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CASH">{t("PaymentMethod_CASH" as any)}</SelectItem>
                <SelectItem value="BANK_TRANSFER">{t("PaymentMethod_BANK_TRANSFER" as any)}</SelectItem>
                <SelectItem value="CHEQUE">{t("PaymentMethod_CHEQUE" as any)}</SelectItem>
                <SelectItem value="CARD">{t("PaymentMethod_CARD" as any)}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t("NotesLabel" as any)}</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button onClick={submit} disabled={submitting} className="gap-2">
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {t("CapitalizeNewAsset" as any)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssetEventsDialog({
  asset,
  onOpenChange,
  orgId,
  factor,
  scale,
  formatCurrency,
}: {
  asset: FixedAsset | null;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
  scale: number;
  formatCurrency: (amount: number, fractionDigits?: number) => string;
}) {
  const { t } = useLanguage();
  const events = useQuery(
    api.fixedAssets.listEvents,
    asset ? { orgId, assetId: asset._id } : "skip"
  );

  return (
    <Dialog open={!!asset} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("AssetEventHistory" as any)}</DialogTitle>
          <DialogDescription>{asset?.name}</DialogDescription>
        </DialogHeader>

        {events === undefined ? (
          <div className="flex justify-center p-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : events.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-8">{t("NoAssetEventsFound" as any)}</p>
        ) : (
          <Table>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event._id}>
                  <TableCell className="text-sm">{t(`AssetEventType_${event.type}` as any)}</TableCell>
                  <TableCell className="text-sm text-slate-500">{format(new Date(event.occurredAt), "MMM d, yyyy")}</TableCell>
                  <TableCell className="text-sm text-right font-medium">
                    {formatCurrency(event.amountMinor / factor, scale)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ImpairAssetDialog({
  asset,
  onOpenChange,
  orgId,
  factor,
  scale,
  formatCurrency,
}: {
  asset: FixedAsset;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
  scale: number;
  formatCurrency: (amount: number, fractionDigits?: number) => string;
}) {
  const { t } = useLanguage();
  const impair = useMutation(api.fixedAssets.impair);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const netBookMinor = (asset.costMinor ?? 0) - (asset.accumulatedDepreciationMinor ?? 0);

  async function submit() {
    const amountMinor = Math.round(Number(amount) * factor);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0 || amountMinor > netBookMinor) {
      toast.error(t("ImpairmentAmountLabel" as any));
      return;
    }
    setSubmitting(true);
    try {
      await impair({ orgId, assetId: asset._id, amountMinor });
      toast.success(t("AssetImpaired" as any));
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("ImpairAsset" as any)}</DialogTitle>
          <DialogDescription>{asset.name} — {t("ImpairAssetDesc" as any)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-slate-500">
            {t("CurrentNetBookValue" as any)}: <strong>{formatCurrency(netBookMinor / factor, scale)}</strong>
          </p>
          <div className="space-y-1.5">
            <Label>{t("ImpairmentAmountLabel" as any)}</Label>
            <Input type="number" min={0} step={1 / factor} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button
            onClick={submit}
            disabled={submitting}
            className="gap-2 bg-amber-600 hover:bg-amber-700 text-white"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {t("ConfirmImpair" as any)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DisposeAssetDialog({
  asset,
  onOpenChange,
  orgId,
  factor,
  scale,
  formatCurrency,
}: {
  asset: FixedAsset;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
  scale: number;
  formatCurrency: (amount: number, fractionDigits?: number) => string;
}) {
  const { t } = useLanguage();
  const dispose = useMutation(api.fixedAssets.dispose);
  const [proceeds, setProceeds] = useState("0");
  const [occurredAt, setOccurredAt] = useState(todayInput);
  const [submitting, setSubmitting] = useState(false);

  const netBookMinor = (asset.costMinor ?? 0) - (asset.accumulatedDepreciationMinor ?? 0);

  async function submit() {
    const proceedsMinor = Math.round(Number(proceeds || "0") * factor);
    if (!Number.isFinite(proceedsMinor) || proceedsMinor < 0) {
      toast.error(t("DisposalProceedsLabel" as any));
      return;
    }
    setSubmitting(true);
    try {
      await dispose({ orgId, assetId: asset._id, proceedsMinor, occurredAt: dateInputToMs(occurredAt) });
      toast.success(t("AssetDisposed" as any));
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("DisposeAsset" as any)}</DialogTitle>
          <DialogDescription>{asset.name} — {t("DisposeAssetDesc" as any)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-slate-500">
            {t("CurrentNetBookValue" as any)}: <strong>{formatCurrency(netBookMinor / factor, scale)}</strong>
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("DisposalProceedsLabel" as any)}</Label>
              <Input type="number" min={0} step={1 / factor} value={proceeds} onChange={(e) => setProceeds(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("PurchaseDateLabel" as any)}</Label>
              <Input type="date" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("Cancel" as any)}</Button>
          <Button
            onClick={submit}
            disabled={submitting}
            className="gap-2 bg-rose-600 hover:bg-rose-700 text-white"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {t("ConfirmDispose" as any)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
