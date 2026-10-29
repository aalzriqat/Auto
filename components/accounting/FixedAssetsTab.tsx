"use client";

import { useState, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type * as z from "zod";
import { usePaginatedQuery, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Doc, Id } from "@/convex/_generated/dataModel";
import { useOrg } from "@/components/providers/OrgProvider";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { requireStoredCurrencyCode } from "@/lib/storedCurrency";
import { RequireOrgCurrency } from "@/components/layout/RequireOrgCurrency";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { toast } from "@/components/ui/sonner";
import { format } from "date-fns";
import { economicTodayDateInput } from "@/lib/dateInput";
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
type AssetBankOptions = {
  banks: Array<{ _id: Id<"bankAccounts">; name: string; currency: string }>;
  truncated: boolean;
} | undefined;

function AssetBankChoice({
  inputId, value, onChange, options, incoming, t,
}: Readonly<{
  inputId: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: AssetBankOptions;
  incoming: boolean;
  t: ReturnType<typeof useLanguage>["t"];
}>) {
  const eligible = options?.banks.find((bank) => bank._id === value);
  const unavailable = options?.truncated === true;
  const empty = options !== undefined && !unavailable && options.banks.length === 0;
  const message = unavailable
    ? incoming ? "ReceiptTooManyBanks" : "DirectPaymentTooManyBanks"
    : empty ? incoming ? "ReceiptNoBank" : "DirectPaymentNoBank" : null;
  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="text-sm font-medium">
        {t(incoming ? "ReceiptBankAccount" : "DirectPaymentBankLabel")}
      </label>
      <select
        id={inputId}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
        value={eligible?._id ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
        disabled={options === undefined || unavailable || empty}
        required
        aria-describedby={message ? `${inputId}-status` : undefined}
      >
        <option value="">{t(options === undefined ? "CashDrawerLoadingBanks" : incoming ? "ReceiptSelectBank" : "DirectPaymentBankChoose")}</option>
        {(options?.banks ?? []).map((bank) => (
          <option key={bank._id} value={bank._id}>{bank.name} · {bank.currency}</option>
        ))}
      </select>
      {message && <p id={`${inputId}-status`} role="status" className="text-sm text-muted-foreground">{t(message)}</p>}
    </div>
  );
}

function AssetStatusBadge({ t, asset }: Readonly<{ t: (key: any) => string; asset: FixedAsset }>) {
  if (asset.costMinor == null) {
    return <Badge variant="outline" className="text-muted-foreground">{t("AssetStatusLegacy")}</Badge>;
  }
  if (asset.status === "IMPAIRED") {
    return <Badge variant="outline" className="border-amber-500/20 bg-amber-500/10 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">{t("AssetStatus_IMPAIRED")}</Badge>;
  }
  if (asset.status === "DISPOSED") {
    return <Badge variant="outline" className="border-border bg-muted text-muted-foreground">{t("AssetStatus_DISPOSED")}</Badge>;
  }
  return <Badge variant="outline" className="border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">{t("AssetStatus_ACTIVE")}</Badge>;
}

export function FixedAssetsTab() {
  return (
    <RequireOrgCurrency>
      <FixedAssetsTabContent />
    </RequireOrgCurrency>
  );
}

function FixedAssetsTabContent() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const currencyCode = requireStoredCurrencyCode(useCurrency().code);
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
        <h2 className="text-lg font-semibold text-foreground">{t("FixedAssets" as any)}</h2>
        {canManage && (
          <Button size="sm" className="gap-2" onClick={() => setCapitalizeOpen(true)}>
            <Plus className="w-4 h-4" />
            {t("CapitalizeNewAsset" as any)}
          </Button>
        )}
      </div>

      <AccountingTableFrame>
        <Table>
          <TableHeader className="bg-muted/50">
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
                    <TableCell className="text-right font-semibold text-foreground">
                      {formatCurrency(costMinor / factor, scale)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {isLegacy ? "—" : formatCurrency(accumMinor / factor, scale)}
                    </TableCell>
                    <TableCell className="text-right font-semibold text-foreground">
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
                          aria-label={t("ViewEvents" as any)}
                          onClick={() => setEventsAsset(asset)}
                        >
                          <History className="w-4 h-4 text-muted-foreground" />
                        </Button>
                        {canImpair && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t("ImpairAsset" as any)}
                            aria-label={t("ImpairAsset" as any)}
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
                            aria-label={t("DisposeAsset" as any)}
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
  // Identity is minted at the USER-INTENT boundary and held across attempts.
  // Minting it per attempt would defeat the guard entirely: a lost response
  // would retry under a new identity and capitalize the asset twice. Same
  // pattern as the collections dialogs.
  const idempotencyKeyRef = useRef<string | null>(null);
  const bankOptions = useQuery(api.fixedAssets.listBankOptions, open ? { orgId } : "skip");

  const form = useForm<z.input<typeof capitalizeAssetSchema>, unknown, CapitalizeAssetFormValues>({
    resolver: zodResolver(capitalizeAssetSchema),
    defaultValues: {
      name: "",
      purchaseDate: economicTodayDateInput(),
      cost: 0,
      salvageValue: 0,
      usefulLifeMonths: 60,
      paymentMethod: "CASH",
      bankAccountId: undefined,
      notes: "",
    },
  });

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) form.reset();
  }

  const paymentMethod = form.watch("paymentMethod");
  const bankSelection = form.watch("bankAccountId");
  const needsBank = paymentMethod !== "CASH";

  async function onSubmit(values: CapitalizeAssetFormValues) {
    const bank = needsBank ? bankOptions?.banks.find((candidate) => candidate._id === values.bankAccountId) : undefined;
    if (needsBank && !bank) {
      form.setError("bankAccountId", { message: t("DirectPaymentBankRequired") });
      return;
    }
    await submitWithFeedback(async () => {
      idempotencyKeyRef.current ??= `asset-capitalize:${crypto.randomUUID()}`;
      await capitalize({
        idempotencyKey: idempotencyKeyRef.current,
        orgId,
        name: values.name.trim(),
        purchaseDate: dateInputToMs(values.purchaseDate),
        costMinor: Math.round(values.cost * factor),
        salvageValueMinor: Math.round(values.salvageValue * factor),
        usefulLifeMonths: values.usefulLifeMonths,
        paymentMethod: values.paymentMethod,
        bankAccountId: bank?._id,
        notes: values.notes?.trim() || undefined,
      });
      // Only a SUCCESS retires the identity. A failure keeps it so the
      // operator's retry is recognised as the same intent, not a second asset.
      idempotencyKeyRef.current = null;
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
          <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-4">
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
                      <Input type="date" max={economicTodayDateInput()} {...field} />
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
                <p className="text-xs text-muted-foreground">{t("SalvageValueHint" as any)}</p>
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
                <p className="text-xs text-muted-foreground">{t("UsefulLifeMonthsHint" as any)}</p>
              </div>
            </div>

            <FormField
              control={form.control}
              name="paymentMethod"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("PaymentMethodLabel" as any)}</FormLabel>
                  <FormControl>
                    <PaymentMethodSelect t={t as any} value={field.value} onValueChange={(value) => {
                      field.onChange(value);
                      form.setValue("bankAccountId", undefined);
                      form.clearErrors("bankAccountId");
                    }} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {needsBank && (
              <>
                <AssetBankChoice
                  inputId="asset-capitalization-bank"
                  value={bankSelection}
                  onChange={(value) => {
                    form.setValue("bankAccountId", value);
                    form.clearErrors("bankAccountId");
                  }}
                  options={bankOptions}
                  incoming={false}
                  t={t}
                />
                {form.formState.errors.bankAccountId?.message && (
                  <p role="alert" className="text-sm text-destructive">{form.formState.errors.bankAccountId.message}</p>
                )}
              </>
            )}

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
                onConfirm={() => void form.handleSubmit(onSubmit)()}
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

  const form = useForm<z.input<typeof impairAssetSchema>, unknown, ImpairAssetFormValues>({
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
  const bankOptions = useQuery(api.fixedAssets.listBankOptions, { orgId, assetId: asset._id });
  const { submitting, submitWithFeedback } = useAccountingSubmit();

  const netBookMinor = (asset.costMinor ?? 0) - (asset.accumulatedDepreciationMinor ?? 0);

  const form = useForm<z.input<typeof disposeAssetSchema>, unknown, DisposeAssetFormValues>({
    resolver: zodResolver(disposeAssetSchema),
    // The ledger's calendar is UTC: the server refuses a UTC day that has not begun, so the
    // default is the UTC day (a user ahead of UTC would otherwise default to a refused date).
    defaultValues: { proceeds: 0, bankAccountId: undefined, occurredAt: economicTodayDateInput() },
  });
  const proceeds = Number(form.watch("proceeds"));
  const bankSelection = form.watch("bankAccountId");

  async function onSubmit(values: DisposeAssetFormValues) {
    const proceedsMinor = Math.round(values.proceeds * factor);
    if (values.proceeds > 0 && proceedsMinor === 0) {
      form.setError("proceeds", { message: t("DisposalProceedsLabel" as any) });
      return;
    }
    const bank = proceedsMinor > 0 ? bankOptions?.banks.find((candidate) => candidate._id === values.bankAccountId) : undefined;
    if (proceedsMinor > 0 && !bank) {
      form.setError("bankAccountId", { message: t("ReceiptSelectBank") });
      return;
    }
    await submitWithFeedback(async () => {
      await dispose({
        orgId,
        assetId: asset._id,
        proceedsMinor,
        bankAccountId: bank?._id,
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
                    <FormLabel>{t("DisposalAccountingDateLabel" as any)}</FormLabel>
                    <FormControl>
                      <Input type="date" max={economicTodayDateInput()} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {proceeds > 0 && (
              <>
                <AssetBankChoice
                  inputId="asset-disposal-bank"
                  value={bankSelection}
                  onChange={(value) => {
                    form.setValue("bankAccountId", value);
                    form.clearErrors("bankAccountId");
                  }}
                  options={bankOptions}
                  incoming
                  t={t}
                />
                {form.formState.errors.bankAccountId?.message && (
                  <p role="alert" className="text-sm text-destructive">{form.formState.errors.bankAccountId.message}</p>
                )}
              </>
            )}

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
