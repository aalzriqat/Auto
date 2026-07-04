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
import {
  AccountingEmptyRow,
  AccountingHistoryTable,
  AccountingTableFrame,
  AmountSummary,
  CurrencyAmountInput,
  DialogFooterActions,
  LoadingAccountingState,
  PaymentMethodSelect,
  dateInputToMs,
  scaleForCurrency,
  todayInput,
  useAccountingSubmit,
  type CurrencyFormatter,
  type PaymentMethod,
} from "./AccountingTabShared";

type FixedAsset = Doc<"fixedAssets">;

function AssetStatusBadge({ t, asset }: Readonly<{ t: (key: any) => string; asset: FixedAsset }>) {
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

  const { results: assets, status: assetsStatus } = usePaginatedQuery(
    api.fixedAssets.list,
    activeOrgId ? { orgId: activeOrgId } : "skip",
    { initialNumItems: 100 }
  );

  const [capitalizeOpen, setCapitalizeOpen] = useState(false);
  const [eventsAsset, setEventsAsset] = useState<FixedAsset | null>(null);
  const [impairAsset, setImpairAsset] = useState<FixedAsset | null>(null);
  const [disposeAsset, setDisposeAsset] = useState<FixedAsset | null>(null);

  if (assetsStatus === "LoadingFirstPage") {
    return <LoadingAccountingState label={t("LoadingAssets" as any)} />;
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

      <AccountingTableFrame>
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
              <AccountingEmptyRow colSpan={7} label={t("NoAssetsFound" as any)} />
            ) : (
              assets.map((asset) => {
                const isLegacy = asset.costMinor == null;
                const costMinor = asset.costMinor ?? Math.round((asset.purchaseValue ?? 0) * factor);
                const accumMinor = asset.accumulatedDepreciationMinor ?? 0;
                const netBookMinor = costMinor - accumMinor;
                const canImpair = canManage && !isLegacy && asset.status === "ACTIVE";
                const canDispose = canManage && !isLegacy && asset.status !== "DISPOSED";
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
                        {canImpair && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t("ImpairAsset" as any)}
                            onClick={() => setImpairAsset(asset)}
                          >
                            <TrendingDown className="w-4 h-4 text-amber-600" />
                          </Button>
                        )}
                        {canDispose && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t("DisposeAsset" as any)}
                            onClick={() => setDisposeAsset(asset)}
                          >
                            <XCircle className="w-4 h-4 text-rose-600" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </AccountingTableFrame>

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
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
}>) {
  const { t } = useLanguage();
  const capitalize = useMutation(api.fixedAssets.capitalize);

  const [name, setName] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(todayInput);
  const [cost, setCost] = useState("");
  const [salvageValue, setSalvageValue] = useState("0");
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("60");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [notes, setNotes] = useState("");
  const { submitting, submitWithFeedback } = useAccountingSubmit();

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

    await submitWithFeedback(async () => {
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
    });
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
            <CurrencyAmountInput
              label={t("PurchaseValue" as any)}
              value={cost}
              onChange={setCost}
              factor={factor}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <CurrencyAmountInput
                label={t("SalvageValueLabel" as any)}
                value={salvageValue}
                onChange={setSalvageValue}
                factor={factor}
              />
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
            <PaymentMethodSelect t={t as any} value={paymentMethod} onValueChange={setPaymentMethod} />
          </div>

          <div className="space-y-1.5">
            <Label>{t("NotesLabel" as any)}</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <DialogFooterActions
            cancelLabel={t("Cancel" as any)}
            confirmLabel={t("CapitalizeNewAsset" as any)}
            onCancel={() => onOpenChange(false)}
            onConfirm={submit}
            submitting={submitting}
          />
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
}: Readonly<{
  asset: FixedAsset | null;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
  scale: number;
  formatCurrency: CurrencyFormatter;
}>) {
  const { t } = useLanguage();
  const events = useQuery(
    api.fixedAssets.listEvents,
    asset ? { orgId, assetId: asset._id } : "skip"
  );
  const body = events === undefined ? (
    <div className="flex justify-center p-8">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  ) : (
    <AccountingHistoryTable
      rows={events}
      emptyLabel={t("NoAssetEventsFound" as any)}
      getLabel={(event) => t(`AssetEventType_${event.type}` as any)}
      getDate={(event) => event.occurredAt}
      getAmountMinor={(event) => event.amountMinor}
      factor={factor}
      scale={scale}
      formatCurrency={formatCurrency}
    />
  );

  return (
    <Dialog open={!!asset} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("AssetEventHistory" as any)}</DialogTitle>
          <DialogDescription>{asset?.name}</DialogDescription>
        </DialogHeader>

        {body}
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
}: Readonly<{
  asset: FixedAsset;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
  scale: number;
  formatCurrency: CurrencyFormatter;
}>) {
  const { t } = useLanguage();
  const impair = useMutation(api.fixedAssets.impair);
  const [amount, setAmount] = useState("");
  const { submitting, submitWithFeedback } = useAccountingSubmit();

  const netBookMinor = (asset.costMinor ?? 0) - (asset.accumulatedDepreciationMinor ?? 0);

  async function submit() {
    const amountMinor = Math.round(Number(amount) * factor);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0 || amountMinor > netBookMinor) {
      toast.error(t("ImpairmentAmountLabel" as any));
      return;
    }
    await submitWithFeedback(async () => {
      await impair({ orgId, assetId: asset._id, amountMinor });
      toast.success(t("AssetImpaired" as any));
      onOpenChange(false);
    });
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("ImpairAsset" as any)}</DialogTitle>
          <DialogDescription>{asset.name} — {t("ImpairAssetDesc" as any)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <AmountSummary
            label={t("CurrentNetBookValue" as any)}
            value={formatCurrency(netBookMinor / factor, scale)}
          />
          <CurrencyAmountInput
            label={t("ImpairmentAmountLabel" as any)}
            value={amount}
            onChange={setAmount}
            factor={factor}
          />
        </div>

        <DialogFooter>
          <DialogFooterActions
            cancelLabel={t("Cancel" as any)}
            confirmLabel={t("ConfirmImpair" as any)}
            onCancel={() => onOpenChange(false)}
            onConfirm={submit}
            submitting={submitting}
            confirmClassName="bg-amber-600 hover:bg-amber-700 text-white"
          />
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
}: Readonly<{
  asset: FixedAsset;
  onOpenChange: (open: boolean) => void;
  orgId: Id<"organizations">;
  factor: number;
  scale: number;
  formatCurrency: CurrencyFormatter;
}>) {
  const { t } = useLanguage();
  const dispose = useMutation(api.fixedAssets.dispose);
  const [proceeds, setProceeds] = useState("0");
  const [occurredAt, setOccurredAt] = useState(todayInput);
  const { submitting, submitWithFeedback } = useAccountingSubmit();

  const netBookMinor = (asset.costMinor ?? 0) - (asset.accumulatedDepreciationMinor ?? 0);

  async function submit() {
    const proceedsMinor = Math.round(Number(proceeds || "0") * factor);
    if (!Number.isFinite(proceedsMinor) || proceedsMinor < 0) {
      toast.error(t("DisposalProceedsLabel" as any));
      return;
    }
    await submitWithFeedback(async () => {
      await dispose({ orgId, assetId: asset._id, proceedsMinor, occurredAt: dateInputToMs(occurredAt) });
      toast.success(t("AssetDisposed" as any));
      onOpenChange(false);
    });
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("DisposeAsset" as any)}</DialogTitle>
          <DialogDescription>{asset.name} — {t("DisposeAssetDesc" as any)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <AmountSummary
            label={t("CurrentNetBookValue" as any)}
            value={formatCurrency(netBookMinor / factor, scale)}
          />
          <div className="grid grid-cols-2 gap-3">
            <CurrencyAmountInput
              label={t("DisposalProceedsLabel" as any)}
              value={proceeds}
              onChange={setProceeds}
              factor={factor}
            />
            <div className="space-y-1.5">
              <Label>{t("DisposalDateLabel" as any)}</Label>
              <Input type="date" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <DialogFooterActions
            cancelLabel={t("Cancel" as any)}
            confirmLabel={t("ConfirmDispose" as any)}
            onCancel={() => onOpenChange(false)}
            onConfirm={submit}
            submitting={submitting}
            confirmClassName="bg-rose-600 hover:bg-rose-700 text-white"
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
