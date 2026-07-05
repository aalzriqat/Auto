"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
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
  DialogFooterActions,
  LoadingAccountingState,
  PaymentMethodSelect,
  dateInputToMs,
  scaleForCurrency,
  todayInput,
  useAccountingSubmit,
  type CurrencyFormatter,
} from "./AccountingTabShared";
import {
  capitalizeAssetSchema,
  type CapitalizeAssetFormValues,
  impairAssetSchema,
  type ImpairAssetFormValues,
  disposeAssetSchema,
  type DisposeAssetFormValues,
} from "./fixedAsset.schema";

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
  const { submitting, submitWithFeedback } = useAccountingSubmit();

  const form = useForm<CapitalizeAssetFormValues>({
    resolver: zodResolver(capitalizeAssetSchema),
    defaultValues: {
      name: "",
      purchaseDate: todayInput,
      cost: 0,
      salvageValue: 0,
      usefulLifeMonths: 60,
      paymentMethod: "CASH",
      notes: "",
    },
  });

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) form.reset();
  }

  async function onSubmit(values: CapitalizeAssetFormValues) {
    await submitWithFeedback(async () => {
      await capitalize({
        orgId,
        name: values.name.trim(),
        purchaseDate: dateInputToMs(values.purchaseDate),
        costMinor: Math.round(values.cost * factor),
        salvageValueMinor: Math.round(values.salvageValue * factor),
        usefulLifeMonths: values.usefulLifeMonths,
        paymentMethod: values.paymentMethod,
        notes: values.notes?.trim() || undefined,
      });
      toast.success(t("AssetCapitalized" as any));
      handleOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("CapitalizeNewAsset" as any)}</DialogTitle>
          <DialogDescription>{t("CapitalizeAssetDesc" as any)}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("AssetName" as any)}</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="purchaseDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("PurchaseDateLabel" as any)}</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="cost"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("PurchaseValue" as any)}</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} step={1 / factor} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <FormField
                  control={form.control}
                  name="salvageValue"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("SalvageValueLabel" as any)}</FormLabel>
                      <FormControl>
                        <Input type="number" min={0} step={1 / factor} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <p className="text-xs text-slate-500">{t("SalvageValueHint" as any)}</p>
              </div>
              <div className="space-y-1.5">
                <FormField
                  control={form.control}
                  name="usefulLifeMonths"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("UsefulLifeMonthsLabel" as any)}</FormLabel>
                      <FormControl>
                        <Input type="number" min={1} step={1} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <p className="text-xs text-slate-500">{t("UsefulLifeMonthsHint" as any)}</p>
              </div>
            </div>

            <FormField
              control={form.control}
              name="paymentMethod"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("PaymentMethodLabel" as any)}</FormLabel>
                  <FormControl>
                    <PaymentMethodSelect t={t as any} value={field.value} onValueChange={field.onChange} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("NotesLabel" as any)}</FormLabel>
                  <FormControl>
                    <Textarea {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <DialogFooterActions
                cancelLabel={t("Cancel" as any)}
                confirmLabel={t("CapitalizeNewAsset" as any)}
                onCancel={() => handleOpenChange(false)}
                onConfirm={form.handleSubmit(onSubmit)}
                submitting={submitting}
              />
            </DialogFooter>
          </form>
        </Form>
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
  const { submitting, submitWithFeedback } = useAccountingSubmit();

  const netBookMinor = (asset.costMinor ?? 0) - (asset.accumulatedDepreciationMinor ?? 0);

  const form = useForm<ImpairAssetFormValues>({
    resolver: zodResolver(impairAssetSchema),
    defaultValues: { amount: 0 },
  });

  async function onSubmit(values: ImpairAssetFormValues) {
    const amountMinor = Math.round(values.amount * factor);
    if (amountMinor > netBookMinor) {
      form.setError("amount", { message: t("ImpairmentAmountLabel" as any) });
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

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
            <AmountSummary
              label={t("CurrentNetBookValue" as any)}
              value={formatCurrency(netBookMinor / factor, scale)}
            />
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("ImpairmentAmountLabel" as any)}</FormLabel>
                  <FormControl>
                    <Input type="number" min={0} step={1 / factor} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <DialogFooterActions
                cancelLabel={t("Cancel" as any)}
                confirmLabel={t("ConfirmImpair" as any)}
                onCancel={() => onOpenChange(false)}
                onConfirm={form.handleSubmit(onSubmit)}
                submitting={submitting}
                confirmClassName="bg-amber-600 hover:bg-amber-700 text-white"
              />
            </DialogFooter>
          </form>
        </Form>
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
  const { submitting, submitWithFeedback } = useAccountingSubmit();

  const netBookMinor = (asset.costMinor ?? 0) - (asset.accumulatedDepreciationMinor ?? 0);

  const form = useForm<DisposeAssetFormValues>({
    resolver: zodResolver(disposeAssetSchema),
    defaultValues: { proceeds: 0, occurredAt: todayInput },
  });

  async function onSubmit(values: DisposeAssetFormValues) {
    await submitWithFeedback(async () => {
      await dispose({
        orgId,
        assetId: asset._id,
        proceedsMinor: Math.round(values.proceeds * factor),
        occurredAt: dateInputToMs(values.occurredAt),
      });
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

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
            <AmountSummary
              label={t("CurrentNetBookValue" as any)}
              value={formatCurrency(netBookMinor / factor, scale)}
            />
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="proceeds"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("DisposalProceedsLabel" as any)}</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} step={1 / factor} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="occurredAt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("DisposalDateLabel" as any)}</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter>
              <DialogFooterActions
                cancelLabel={t("Cancel" as any)}
                confirmLabel={t("ConfirmDispose" as any)}
                onCancel={() => onOpenChange(false)}
                onConfirm={form.handleSubmit(onSubmit)}
                submitting={submitting}
                confirmClassName="bg-rose-600 hover:bg-rose-700 text-white"
              />
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
